import type { Express, Request, Response } from 'express';
import fetch from 'node-fetch';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { getEnv } from '../../env.js';
import getLogger from '../../logger.js';
import { auth } from '../auth/middleware.js';
import { DbMerlin } from '../db/db.js';
import { queryPgChunks, type CatalogResource, type ResourceQuery } from './pg-chunks.js';
import type { Reduction } from './reduce.js';

const logger = getLogger('packages/sources/sources');
const { HASURA_API_URL } = getEnv();
const GQL_API_URL = `${HASURA_API_URL}/v1/graphql`;
const gzipAsync = promisify(gzip);

/**
 * Bounded viewport queries over imported source revisions.
 *
 *   POST /sources/query
 *   { planSourceId | revisionId, resources: [key...], start, end, pointBudget?, fidelity?, reduction?, maxSamples? }
 *
 * Times are integer microseconds since the Unix epoch; the window is [start, end). A display query returns at
 * most `pointBudget` points per resource; an exact query returns every sample in the window, paged by
 * `maxSamples`. Either way each result also carries the samples just outside the window, so a step or line
 * can be drawn continuously across it.
 *
 * Who may read what is decided by Hasura: the revision is resolved with the caller's own token, so a caller
 * can query exactly the revisions they can see. Today that is every revision, for every role, as with plans,
 * simulation datasets and external sources: PlanDev's data is readable by all of its users.
 */

type Body = {
  end?: unknown;
  fidelity?: unknown;
  maxSamples?: unknown;
  planSourceId?: unknown;
  pointBudget?: unknown;
  reduction?: unknown;
  resources?: unknown;
  revisionId?: unknown;
  start?: unknown;
};

type Revision = { id: number; status: string; storage_kind: string };

const MAX_RESOURCES = 200;
const MAX_POINT_BUDGET = 20_000;
const MAX_EXACT_SAMPLES = 1_000_000;
const AUTH_TTL_MS = 60_000;

const PROVIDERS: Record<
  string,
  (revisionId: number, resources: CatalogResource[], query: ResourceQuery) => ReturnType<typeof queryPgChunks>
> = {
  pg_chunks_v1: (revisionId, resources, query) => queryPgChunks(DbMerlin.getDb(), revisionId, resources, query),
};

// ponytail: per-process caches. A catalog is a few hundred KB; add an LRU if a gateway ever serves many thousands
// of revisions. Auth entries hold a token, so expired ones are swept rather than left to accumulate.
const AUTH_CACHE_SWEEP_SIZE = 1000;
const authCache = new Map<string, { expires: number; revision: Revision | null }>();
const catalogCache = new Map<number, Map<string, CatalogResource>>();

async function resolveRevision(req: Request, planSourceId: number | null, revisionId: number | null) {
  const authorization = req.get('authorization') ?? '';
  const role = req.get('x-hasura-role') ?? '';
  const cacheKey = `${authorization}|${role}|${planSourceId}|${revisionId}`;
  const cached = authCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.revision;
  }
  const query =
    planSourceId !== null
      ? 'query ($id: Int!) { plan_source_by_pk(id: $id) { source_revision { id status storage_kind } } }'
      : 'query ($id: Int!) { source_revision_by_pk(id: $id) { id status storage_kind } }';
  const response = await fetch(GQL_API_URL, {
    body: JSON.stringify({ query, variables: { id: planSourceId ?? revisionId } }),
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      ...(role ? { 'x-hasura-role': role } : {}),
    },
    method: 'POST',
  });
  const json = (await response.json()) as {
    data?: { plan_source_by_pk?: { source_revision: Revision } | null; source_revision_by_pk?: Revision | null };
    errors?: { message: string }[];
  };
  if (json.errors) {
    throw new Error(json.errors.map(e => e.message).join('; '));
  }
  const revision =
    planSourceId !== null
      ? json.data?.plan_source_by_pk?.source_revision ?? null
      : json.data?.source_revision_by_pk ?? null;
  if (authCache.size >= AUTH_CACHE_SWEEP_SIZE) {
    const now = Date.now();
    authCache.forEach((entry, key) => entry.expires <= now && authCache.delete(key));
  }
  authCache.set(cacheKey, { expires: Date.now() + AUTH_TTL_MS, revision });
  return revision;
}

/** A published revision never changes, so its catalog is cached for the life of the process. */
async function getCatalog(revisionId: number): Promise<Map<string, CatalogResource>> {
  const cached = catalogCache.get(revisionId);
  if (cached) {
    return cached;
  }
  const { rows } = await DbMerlin.getDb().query<{
    id: number;
    interpolation: 'linear' | 'constant';
    key: string;
    numeric: boolean;
    storage: { levels?: number[] };
  }>('select id, key, numeric, interpolation, storage from merlin.source_resource where revision_id = $1', [
    revisionId,
  ]);
  const catalog = new Map(
    rows.map(row => [
      row.key,
      {
        id: row.id,
        interpolation: row.interpolation,
        key: row.key,
        levels: row.storage.levels ?? [],
        numeric: row.numeric,
      },
    ]),
  );
  catalogCache.set(revisionId, catalog);
  return catalog;
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function parseBody(
  body: Body,
):
  | { error: string }
  | { planSourceId: number | null; query: ResourceQuery; keys: string[]; revisionId: number | null } {
  const planSourceId = intOrNull(body.planSourceId);
  const revisionId = intOrNull(body.revisionId);
  if ((planSourceId === null) === (revisionId === null)) {
    return { error: 'Exactly one of planSourceId or revisionId is required' };
  }
  const start = intOrNull(body.start);
  const end = intOrNull(body.end);
  if (start === null || end === null || end <= start) {
    return { error: 'start and end must be integer microseconds with end > start' };
  }
  const keys = body.resources;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > MAX_RESOURCES ||
    keys.some(k => typeof k !== 'string')
  ) {
    return { error: `resources must be 1 to ${MAX_RESOURCES} resource keys` };
  }
  const fidelity = body.fidelity ?? 'display';
  if (fidelity !== 'display' && fidelity !== 'exact') {
    return { error: 'fidelity must be "display" or "exact"' };
  }
  const reduction = body.reduction ?? 'm4';
  if (reduction !== 'm4' && reduction !== 'minmax' && reduction !== 'nth') {
    return { error: 'reduction must be "m4", "minmax" or "nth"' };
  }
  const pointBudget = body.pointBudget === undefined ? 2000 : intOrNull(body.pointBudget);
  if (pointBudget === null || pointBudget < 2 || pointBudget > MAX_POINT_BUDGET) {
    return { error: `pointBudget must be an integer from 2 to ${MAX_POINT_BUDGET}` };
  }
  const maxSamples = body.maxSamples === undefined ? 100_000 : intOrNull(body.maxSamples);
  if (maxSamples === null || maxSamples < 1 || maxSamples > MAX_EXACT_SAMPLES) {
    return { error: `maxSamples must be an integer from 1 to ${MAX_EXACT_SAMPLES}` };
  }
  return {
    keys: keys as string[],
    planSourceId,
    query: { end, fidelity, maxSamples, pointBudget, reduction: reduction as Reduction, start },
    revisionId,
  };
}

async function query(req: Request, res: Response) {
  const began = performance.now();
  const parsed = parseBody(req.body as Body);
  if ('error' in parsed) {
    res.status(400).send({ message: parsed.error });
    return;
  }
  let revision: Revision | null;
  try {
    revision = await resolveRevision(req, parsed.planSourceId, parsed.revisionId);
  } catch (e) {
    res.status(403).send({ message: (e as Error).message });
    return;
  }
  if (!revision) {
    res.status(404).send({ message: 'Source not found' });
    return;
  }
  if (revision.status !== 'success') {
    res.status(409).send({ message: `Revision ${revision.id} is not available yet (status ${revision.status})` });
    return;
  }
  const provider = PROVIDERS[revision.storage_kind];
  if (!provider) {
    res.status(501).send({ message: `No provider for storage kind ${revision.storage_kind}` });
    return;
  }

  try {
    const catalog = await getCatalog(revision.id);
    const known = parsed.keys.filter(key => catalog.has(key));
    const dbBegan = performance.now();
    const results = await provider(
      revision.id,
      known.map(key => catalog.get(key)!),
      parsed.query,
    );
    const dbMs = performance.now() - dbBegan;
    const byKey = new Map(known.map((key, i) => [key, results[i]]));
    const body = JSON.stringify({
      end: parsed.query.end,
      fidelity: parsed.query.fidelity,
      results: parsed.keys.map(key => {
        const result = byKey.get(key);
        if (!result) {
          return { error: 'Resource not found in this revision', resource: key };
        }
        const { interpolation, numeric } = catalog.get(key)!;
        return { interpolation, numeric, resource: key, ...result };
      }),
      revisionId: revision.id,
      start: parsed.query.start,
      timing: { queryMs: Math.round(dbMs), totalMs: Math.round(performance.now() - began) },
    });
    res.set('Content-Type', 'application/json');
    res.set('Server-Timing', `query;dur=${dbMs.toFixed(1)}`);
    if ((req.get('accept-encoding') ?? '').includes('gzip') && body.length > 2048) {
      res.set('Content-Encoding', 'gzip');
      res.send(await gzipAsync(body, { level: 4 }));
    } else {
      res.send(body);
    }
  } catch (e) {
    logger.error(e);
    res.status(500).send({ message: (e as Error).message });
  }
}

export default (app: Express) => {
  /**
   * @swagger
   * /sources/query:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - application/json
   *     produces:
   *       - application/json
   *     summary: Bounded samples of imported source resources over a time window
   *     tags:
   *       - Sources
   */
  app.post('/sources/query', auth, query);
};
