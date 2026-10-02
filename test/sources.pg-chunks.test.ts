import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  decodeChunk,
  queryPgChunks,
  type CatalogResource,
  type ResourceQuery,
} from '../src/packages/sources/pg-chunks';
import { GAP, NULL, slice, type Series } from '../src/packages/sources/reduce';

/**
 * Runs against a database holding two fixtures, and is skipped without one:
 *
 *  - the edge-case TOL (plandev source-ingest/src/test/resources/edge-cases.tol.xml) ingested as revision
 *    SOURCES_IT_REVISION;
 *  - the summary fixture, written by plandev's SummaryFixtureIT (source "it: summary fixture"), which is large
 *    enough to have stored summary levels and multi-chunk resources.
 *
 *   SOURCES_IT_DB=postgres://user:pass@localhost:5432/plandev SOURCES_IT_REVISION=2 npm test
 *
 * Fixture times are seconds after 2030-001T00:00:00Z.
 */
const { SOURCES_IT_DB, SOURCES_IT_REVISION } = process.env;
const T0 = Date.UTC(2030, 0, 1) * 1000;
const s = (seconds: number) => T0 + seconds * 1_000_000;

async function loadCatalog(pool: pg.Pool, revisionId: number): Promise<Map<string, CatalogResource>> {
  const { rows } = await pool.query(
    'select id, key, numeric, interpolation, storage from merlin.source_resource where revision_id = $1',
    [revisionId],
  );
  return new Map(rows.map(r => [r.key, { ...r, levels: r.storage.levels ?? [] }]));
}

function queryOne(
  pool: pg.Pool,
  revisionId: number,
  resource: CatalogResource,
  q: Partial<ResourceQuery> & Pick<ResourceQuery, 'start' | 'end'>,
) {
  return queryPgChunks(pool, revisionId, [resource], {
    fidelity: 'display',
    maxSamples: 100_000,
    pointBudget: 2000,
    reduction: 'm4',
    ...q,
  }).then(([result]) => result);
}

describe.skipIf(!SOURCES_IT_DB || !SOURCES_IT_REVISION)('pg_chunks_v1 provider', () => {
  const revisionId = Number(SOURCES_IT_REVISION);
  let pool: pg.Pool;
  let catalog: Map<string, CatalogResource>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: SOURCES_IT_DB });
    catalog = await loadCatalog(pool, revisionId);
  });
  afterAll(() => pool.end());

  const query = (key: string, q: Partial<ResourceQuery> & Pick<ResourceQuery, 'start' | 'end'>) =>
    queryOne(pool, revisionId, catalog.get(key)!, q);

  test('a window beginning and ending between samples carries the samples on both sides', async () => {
    // Step and Line have samples every 10 s
    for (const key of ['Step', 'Line']) {
      const r = await query(key, { end: s(45), start: s(25) });
      expect(r.series.t).toEqual([s(30), s(40)]);
      expect(r.before?.t).toEqual([s(20)]);
      expect(r.after?.t).toEqual([s(50)]);
    }
  });

  test('a window on a sample includes it; the sample at the end is outside', async () => {
    const r = await query('Step', { end: s(40), start: s(30) });
    expect(r.series.t).toEqual([s(30)]);
    expect(r.before?.t).toEqual([s(20)]);
    expect(r.after?.t).toEqual([s(40)]);
  });

  test('a window containing no values still has the value in effect and the next change', async () => {
    const r = await query('Step', { end: s(29), start: s(21) });
    expect(r.series.t).toEqual([]);
    expect(r.before?.v).toEqual([2]);
    expect(r.after?.v).toEqual([3]);
  });

  test('a resource covers only its own samples', async () => {
    const r = await query('Sparse', { end: s(50), start: s(0) });
    expect(r.series.t).toEqual([]);
    expect(r.before).toBeNull();
    expect(r.after?.t).toEqual([s(80)]);
  });

  test('out-of-order records are stored in time order', async () => {
    const r = await query('Late', { end: s(100), fidelity: 'exact', start: s(0) });
    expect(r.series.t).toEqual([s(5), s(10), s(20), s(30), s(40)]);
    expect(r.series.v).toEqual([0.5, 1, 2, 3, 4]);
  });

  test('duplicate timestamps are all kept, in file order, and pages never split them', async () => {
    const all = await query('Dup', { end: s(100), fidelity: 'exact', start: s(0) });
    expect(all.series.t).toEqual([s(10), s(20), s(20), s(30)]);
    expect(all.series.v).toEqual([1, 2, 3, 4]);
    const page = await query('Dup', { end: s(100), fidelity: 'exact', maxSamples: 2, start: s(0) });
    expect(page.series.t).toEqual([s(10)]);
    expect(page.next).toBe(s(20));
  });

  test('a valid discrete null is a null sample, not a gap', async () => {
    const r = await query('Mode', { end: s(100), fidelity: 'exact', start: s(0) });
    expect(r.series.s).toEqual(['OFF', 'ON', 'ON', null, 'SAFE', 'OFF']);
    expect(r.series.k).toEqual([0, 0, 0, 1, 0, 0]);
  });

  test('display keeps discrete transitions and drops repeats', async () => {
    const r = await query('Mode', { end: s(100), pointBudget: 10, start: s(0) });
    expect(r.series.t).toEqual([s(0), s(15), s(35), s(45), s(55)]);
  });

  test('display respects the point budget; exact bypasses it', async () => {
    const display = await query('Step', { end: s(101), pointBudget: 4, start: s(0) });
    expect(display.series.t.length).toBeLessThanOrEqual(4);
    expect(display.approximate).toBe(true);
    const exact = await query('Step', { end: s(101), fidelity: 'exact', pointBudget: 4, start: s(0) });
    expect(exact.series.t).toHaveLength(11);
    expect(exact.approximate).toBe(false);
  });

  test('arrayed resources are separate resources', async () => {
    const a = await query('Arr[A]', { end: s(100), fidelity: 'exact', start: s(0) });
    const b = await query('Arr[B]', { end: s(100), fidelity: 'exact', start: s(0) });
    expect(a.series.v).toEqual([1, 11]);
    expect(b.series.v).toEqual([2]);
  });
});

describe.skipIf(!SOURCES_IT_DB)('pg_chunks_v1 provider, summary fixture', () => {
  const SPAN = 16_384;
  const EVENT = 5000;
  let pool: pg.Pool;
  let revisionId: number;
  let catalog: Map<string, CatalogResource>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: SOURCES_IT_DB });
    const { rows } = await pool.query(
      `select r.id from merlin.source s join merlin.source_revision r on r.source_id = s.id
        where s.name = 'it: summary fixture' and r.status = 'success' order by r.id desc limit 1`,
    );
    if (rows.length === 0) {
      throw new Error('No summary fixture: run plandev SummaryFixtureIT against this database first');
    }
    revisionId = rows[0].id;
    catalog = await loadCatalog(pool, revisionId);
  });
  afterAll(() => pool.end());

  // The whole span at a budget that selects 256 s summary buckets, each one many output pixels wide of data.
  async function wide(key: string, pointBudget = 100) {
    const result = await queryOne(pool, revisionId, catalog.get(key)!, { end: s(SPAN), pointBudget, start: s(0) });
    expect(result.representation).toBe('summary');
    expect(result.bucketWidth).toBe(256_000_000);
    expect(result.series.t.length).toBeLessThanOrEqual(pointBudget);
    return result.series;
  }

  const kindAt = (series: Series, t: number) => series.k?.[series.t.indexOf(t)];

  test('a numeric gap inside one summary bucket still breaks the line', async () => {
    const series = await wide('NumGap');
    expect(kindAt(series, s(EVENT))).toBe(GAP);
    expect(series.v![series.t.indexOf(s(EVENT))]).toBeNull();
    // the line resumes after it
    expect(series.t.some(t => t > s(EVENT) && kindAt(series, t) === 0)).toBe(true);
  });

  test('a numeric null inside one summary bucket survives', async () => {
    expect(kindAt(await wide('NumNull'), s(EVENT))).toBe(NULL);
  });

  test('A, B, A inside one summary bucket still shows B', async () => {
    const series = await wide('DiscABA');
    expect(series.s![series.t.indexOf(s(EVENT))]).toBe('B');
    expect(series.s).toEqual(['A', 'B', 'A']);
  });

  test('A, null, A and A, gap, A inside one summary bucket survive', async () => {
    expect(kindAt(await wide('DiscNull'), s(EVENT))).toBe(NULL);
    expect(kindAt(await wide('DiscGap'), s(EVENT))).toBe(GAP);
  });

  test('A, B, gap, A inside one summary bucket keeps both B and the gap', async () => {
    const series = await wide('DiscMixed');
    expect(series.s![series.t.indexOf(s(EVENT))]).toBe('B');
    expect(kindAt(series, s(EVENT + 1))).toBe(GAP);
  });

  test('the point budget holds when every bucket is reduced again', async () => {
    for (const key of ['NumGap', 'DiscMixed']) {
      for (const pointBudget of [8, 20, 60]) {
        const result = await queryOne(pool, revisionId, catalog.get(key)!, { end: s(SPAN), pointBudget, start: s(0) });
        expect(result.representation).toBe('summary');
        expect(result.series.t.length).toBeLessThanOrEqual(pointBudget);
      }
    }
  });

  test('following next pages through every sample exactly once, across chunk boundaries and equal timestamps', async () => {
    const resource = catalog.get('Paged')!;
    const { rows } = await pool.query(
      `select n, times, nums, texts, kinds from merlin.source_chunk
        where revision_id = $1 and resource_id = $2 order by t1`,
      [revisionId, resource.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const all = rows.map(decodeChunk);
    // Start 4 samples before the end of the second chunk; end in the fourth.
    const start = all[1].t[all[1].t.length - 4];
    const end = s(4500);
    const expected = slice({ t: all.flatMap(c => c.t), v: all.flatMap(c => c.v!) }, start, end);

    for (const maxSamples of [1, 7, 100, 1500]) {
      const t: number[] = [];
      const v: (number | null)[] = [];
      let from: number | null = start;
      let pages = 0;
      while (from !== null) {
        const page = await queryOne(pool, revisionId, resource, { end, fidelity: 'exact', maxSamples, start: from });
        const n = page.series.t.length;
        expect(n).toBeGreaterThan(0);
        // a page holds at most maxSamples, unless it is one instant with more samples than that
        expect(n <= maxSamples || page.series.t.every(time => time === page.series.t[0])).toBe(true);
        // no instant is split between pages
        expect(t.length === 0 || page.series.t[0] > t[t.length - 1]).toBe(true);
        if (page.next !== null) {
          expect(page.next).toBeGreaterThan(page.series.t[n - 1]);
        }
        t.push(...page.series.t);
        v.push(...page.series.v!);
        from = page.next;
        pages++;
      }
      expect({ t, v }).toEqual(expected);
      expect(pages).toBeGreaterThanOrEqual(Math.ceil(expected.t.length / Math.max(maxSamples, 20)));
    }
  });
});
