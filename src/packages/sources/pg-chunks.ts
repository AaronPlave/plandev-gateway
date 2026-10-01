import type { Pool } from 'pg';
import {
  bucketCount,
  capExact,
  emptySeries,
  pick,
  reduceDiscrete,
  reduceNumeric,
  slice,
  summaryComponents,
  type Reduction,
  type Series,
  type SummaryRow,
} from './reduce.js';

/**
 * Storage provider "pg_chunks_v1" (see merlin.source_chunk / merlin.source_summary): reads the samples or
 * summaries a viewport query needs, never a whole resource unless the resource is small.
 */

export type CatalogResource = {
  id: number;
  interpolation: 'linear' | 'constant';
  key: string;
  /** Summary levels stored for this resource; level L has buckets of 1 s * 4^L. */
  levels: number[];
  numeric: boolean;
};

export type ResourceQuery = {
  end: number;
  fidelity: 'display' | 'exact';
  maxSamples: number;
  pointBudget: number;
  reduction: Reduction;
  start: number;
};

export type ResourceResult = {
  /** The first sample at or after `end`, so a step or line can be drawn up to the window's edge. */
  after: Series | null;
  /** True when samples were dropped to meet the point budget. Never true for an exact query. */
  approximate: boolean;
  /** The last sample before `start`: the value in effect when the window opens. */
  before: Series | null;
  /** When summaries were read: their bucket width, in microseconds. */
  bucketWidth: number | null;
  /** Exact queries only: where the next page starts, when `maxSamples` cut this one short. */
  next: number | null;
  representation: 'raw' | 'summary';
  series: Series;
};

/** Above this many samples in a window, a display query reads summaries even if coarser than asked. */
const RAW_DISPLAY_LIMIT = 250_000;

export function levelWidth(level: number): number {
  return 1_000_000 * 4 ** level;
}

type ChunkRow = {
  kinds: Buffer | null;
  n: number;
  nums: Buffer | null;
  resource_id: number;
  texts: Buffer | null;
  times: Buffer;
};

/** Decodes one chunk (layout documented on merlin.source_chunk). */
export function decodeChunk(row: Omit<ChunkRow, 'resource_id'>): Series {
  const { n } = row;
  const t = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    t[i] = row.times.readDoubleLE(i * 8);
  }
  const out: Series = { t };
  const kinds = row.kinds ? Array.from(row.kinds.subarray(0, n)) : undefined;
  if (row.nums) {
    const v = new Array<number | null>(n);
    for (let i = 0; i < n; i++) {
      const value = row.nums.readDoubleLE(i * 8);
      v[i] = kinds && kinds[i] !== 0 ? null : value;
    }
    out.v = v;
  } else {
    const s = new Array<string | null>(n);
    let at = 0;
    for (let i = 0; i < n; i++) {
      const len = row.texts!.readInt32LE(at);
      at += 4;
      if (len < 0) {
        s[i] = null;
      } else {
        s[i] = row.texts!.toString('utf8', at, at + len);
        at += len;
      }
    }
    out.s = s;
  }
  if (kinds) {
    out.k = kinds;
  }
  return out;
}

function concat(parts: Series[], numeric: boolean): Series {
  const out = emptySeries(numeric);
  const anyKinds = parts.some(p => p.k);
  if (anyKinds) {
    out.k = [];
  }
  for (const p of parts) {
    out.t.push(...p.t);
    if (numeric) {
      out.v!.push(...p.v!);
    } else {
      out.s!.push(...p.s!);
    }
    if (anyKinds) {
      out.k!.push(...(p.k ?? p.t.map(() => 0)));
    }
  }
  return out;
}

function lastBefore(series: Series, start: number): Series | null {
  let i = series.t.length - 1;
  while (i >= 0 && series.t[i] >= start) {
    i--;
  }
  return i >= 0 ? pick(series, [i]) : null;
}

function firstAtOrAfter(series: Series, end: number): Series | null {
  const i = series.t.findIndex(t => t >= end);
  return i >= 0 ? pick(series, [i]) : null;
}

const CHUNK_COLUMNS = 'c.t1, c.n, c.times, c.nums, c.texts, c.kinds';

/**
 * For each resource: the chunk before the window, the chunks ending inside it, and the chunk holding its end
 * (or the first one after it). Chunks of a resource never overlap, so this is every sample in the window plus
 * its neighbors. With `edgesOnly`, the chunks inside are replaced by the one holding the window's start.
 */
async function readChunks(
  pool: Pool,
  revisionId: number,
  ids: number[],
  start: number,
  end: number,
  edgesOnly: boolean,
  maxSamples: number | null = null,
): Promise<Map<number, ChunkRow[]>> {
  // With maxSamples, only the leading chunks that hold the first maxSamples + 1 samples: enough for a page and
  // its `next`, without reading (or detoasting) the rest of a years-wide exact window.
  const inside = edgesOnly
    ? `(select ${CHUNK_COLUMNS} from merlin.source_chunk c
         where c.revision_id = $1 and c.resource_id = r.id and c.t1 >= $3 order by c.t1 limit 1)`
    : maxSamples !== null
    ? `(select ${CHUNK_COLUMNS} from (
           select c.*, sum(c.n) over (order by c.t1) - c.n as preceding from merlin.source_chunk c
            where c.revision_id = $1 and c.resource_id = r.id and c.t1 >= $3 and c.t1 < $4) c
          where c.preceding <= $5)`
    : `(select ${CHUNK_COLUMNS} from merlin.source_chunk c
           where c.revision_id = $1 and c.resource_id = r.id and c.t1 >= $3 and c.t1 < $4)`;
  const { rows } = await pool.query<ChunkRow & { t1: string }>(
    `select r.id as resource_id, c.t1, c.n, c.times, c.nums, c.texts, c.kinds
       from unnest($2::int[]) as r(id)
       cross join lateral (
         (select ${CHUNK_COLUMNS} from merlin.source_chunk c
           where c.revision_id = $1 and c.resource_id = r.id and c.t1 < $3 order by c.t1 desc limit 1)
         union all
         ${inside}
         union all
         (select ${CHUNK_COLUMNS} from merlin.source_chunk c
           where c.revision_id = $1 and c.resource_id = r.id and c.t1 >= $4 order by c.t1 limit 1)
       ) c
      order by r.id, c.t1`,
    maxSamples !== null ? [revisionId, ids, start, end, maxSamples] : [revisionId, ids, start, end],
  );
  const byResource = new Map<number, ChunkRow[]>();
  let lastKey = '';
  for (const row of rows) {
    // the chunk holding the start can also hold the end
    const key = `${row.resource_id}:${row.t1}`;
    if (key === lastKey) {
      continue;
    }
    lastKey = key;
    const list = byResource.get(row.resource_id) ?? [];
    list.push(row);
    byResource.set(row.resource_id, list);
  }
  return byResource;
}

async function countSamples(pool: Pool, revisionId: number, ids: number[], start: number, end: number) {
  const { rows } = await pool.query<{ id: number; n: string }>(
    `select r.id, coalesce(sum(c.n), 0) as n
       from unnest($2::int[]) as r(id)
       left join merlin.source_chunk c
         on c.revision_id = $1 and c.resource_id = r.id and c.t1 >= $3 and c.t1 < $4
      group by r.id`,
    [revisionId, ids, start, end],
  );
  return new Map(rows.map(row => [row.id, Number(row.n)]));
}

type SummaryDbRow = {
  changes: number;
  first_kind: number;
  first_s: string | null;
  first_t: string;
  first_v: number | null;
  last_kind: number;
  last_s: string | null;
  last_t: string;
  last_v: number | null;
  max_t: string | null;
  max_v: number | null;
  min_t: string | null;
  min_v: number | null;
  n: number;
  resource_id: number;
};

async function readSummaries(
  pool: Pool,
  revisionId: number,
  requests: { id: number; level: number }[],
  start: number,
  end: number,
): Promise<Map<number, SummaryRow[]>> {
  const { rows } = await pool.query<SummaryDbRow>(
    `select q.id as resource_id, s.n, s.first_t, s.last_t, s.first_kind, s.last_kind, s.min_t, s.max_t,
            s.first_v, s.last_v, s.min_v, s.max_v, s.first_s, s.last_s, s.changes
       from unnest($2::int[], $3::smallint[], $4::bigint[], $5::bigint[]) as q(id, level, b0, b1)
       cross join lateral (
         select * from merlin.source_summary s
          where s.revision_id = $1 and s.resource_id = q.id and s.level = q.level and s.bucket between q.b0 and q.b1
          order by s.bucket
       ) s
      order by q.id, s.bucket`,
    [
      revisionId,
      requests.map(r => r.id),
      requests.map(r => r.level),
      requests.map(r => Math.floor(start / levelWidth(r.level))),
      requests.map(r => Math.floor((end - 1) / levelWidth(r.level))),
    ],
  );
  const byResource = new Map<number, SummaryRow[]>();
  for (const row of rows) {
    const list = byResource.get(row.resource_id) ?? [];
    list.push({
      changes: row.changes,
      firstKind: row.first_kind,
      firstS: row.first_s,
      firstT: Number(row.first_t),
      firstV: row.first_v,
      lastKind: row.last_kind,
      lastS: row.last_s,
      lastT: Number(row.last_t),
      lastV: row.last_v,
      maxT: row.max_t === null ? null : Number(row.max_t),
      maxV: row.max_v,
      minT: row.min_t === null ? null : Number(row.min_t),
      minV: row.min_v,
      n: row.n,
    });
    byResource.set(row.resource_id, list);
  }
  return byResource;
}

function reduce(series: Series, resource: CatalogResource, query: ResourceQuery): Series {
  return resource.numeric
    ? reduceNumeric(series, query.start, query.end, query.pointBudget, query.reduction)
    : reduceDiscrete(series, query.start, query.end, query.pointBudget);
}

export async function queryPgChunks(
  pool: Pool,
  revisionId: number,
  resources: CatalogResource[],
  query: ResourceQuery,
): Promise<ResourceResult[]> {
  const { start, end } = query;
  const summaryLevel = new Map<number, number>();
  const raw: CatalogResource[] = [];

  // Display: the coarsest stored level whose buckets are no wider than one output bucket.
  const fallbacks: CatalogResource[] = [];
  for (const resource of resources) {
    if (query.fidelity === 'exact' || resource.levels.length === 0) {
      raw.push(resource);
      continue;
    }
    const target = (end - start) / bucketCount(query.reduction, resource.numeric, query.pointBudget);
    const fitting = resource.levels.filter(level => levelWidth(level) <= target);
    if (fitting.length > 0) {
      summaryLevel.set(resource.id, Math.max(...fitting));
    } else {
      fallbacks.push(resource);
    }
  }
  // Finer than every level: read raw, unless the window is too dense, then use the finest level anyway.
  if (fallbacks.length > 0) {
    const counts = await countSamples(
      pool,
      revisionId,
      fallbacks.map(r => r.id),
      start,
      end,
    );
    for (const resource of fallbacks) {
      if ((counts.get(resource.id) ?? 0) > RAW_DISPLAY_LIMIT) {
        summaryLevel.set(resource.id, Math.min(...resource.levels));
      } else {
        raw.push(resource);
      }
    }
  }
  const summarized = resources.filter(r => summaryLevel.has(r.id));

  const [rawChunks, edgeChunks, summaries] = await Promise.all([
    raw.length > 0
      ? readChunks(
          pool,
          revisionId,
          raw.map(r => r.id),
          start,
          end,
          false,
          query.fidelity === 'exact' ? query.maxSamples : null,
        )
      : new Map<number, ChunkRow[]>(),
    summarized.length > 0
      ? readChunks(
          pool,
          revisionId,
          summarized.map(r => r.id),
          start,
          end,
          true,
        )
      : new Map<number, ChunkRow[]>(),
    summarized.length > 0
      ? readSummaries(
          pool,
          revisionId,
          summarized.map(r => ({ id: r.id, level: summaryLevel.get(r.id)! })),
          start,
          end,
        )
      : new Map<number, SummaryRow[]>(),
  ]);

  return resources.map(resource => {
    const level = summaryLevel.get(resource.id);
    const chunks = (level === undefined ? rawChunks : edgeChunks).get(resource.id) ?? [];
    const decoded = concat(chunks.map(decodeChunk), resource.numeric);
    const before = lastBefore(decoded, start);
    const after = firstAtOrAfter(decoded, end);

    if (level === undefined) {
      const inWindow = slice(decoded, start, end);
      if (query.fidelity === 'exact') {
        const { next, series } = capExact(inWindow, query.maxSamples);
        return { after, approximate: false, before, bucketWidth: null, next, representation: 'raw', series };
      }
      const series = reduce(inWindow, resource, query);
      return {
        after,
        approximate: series !== inWindow && series.t.length < inWindow.t.length,
        before,
        bucketWidth: null,
        next: null,
        representation: 'raw',
        series,
      };
    }

    const components = slice(summaryComponents(summaries.get(resource.id) ?? [], resource.numeric), start, end);
    return {
      after,
      approximate: true,
      before,
      bucketWidth: levelWidth(level),
      next: null,
      representation: 'summary',
      series: reduce(components, resource, query),
    };
  });
}
