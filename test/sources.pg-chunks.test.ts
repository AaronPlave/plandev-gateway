import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { queryPgChunks, type CatalogResource, type ResourceQuery } from '../src/packages/sources/pg-chunks';

/**
 * Runs against a database holding the edge-case fixture
 * (plandev source-ingest/src/test/resources/edge-cases.tol.xml) ingested as a revision:
 *
 *   SOURCES_IT_DB=postgres://user:pass@localhost:5432/plandev SOURCES_IT_REVISION=3 npm test
 *
 * Skipped otherwise. Fixture times are seconds after 2030-001T00:00:00Z.
 */
const { SOURCES_IT_DB, SOURCES_IT_REVISION } = process.env;
const T0 = Date.UTC(2030, 0, 1) * 1000;
const s = (seconds: number) => T0 + seconds * 1_000_000;

describe.skipIf(!SOURCES_IT_DB || !SOURCES_IT_REVISION)('pg_chunks_v1 provider', () => {
  const revisionId = Number(SOURCES_IT_REVISION);
  let pool: pg.Pool;
  let catalog: Map<string, CatalogResource>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: SOURCES_IT_DB });
    const { rows } = await pool.query(
      'select id, key, numeric, interpolation, storage from merlin.source_resource where revision_id = $1',
      [revisionId],
    );
    catalog = new Map(rows.map(r => [r.key, { ...r, levels: r.storage.levels ?? [] }]));
  });
  afterAll(() => pool.end());

  async function query(key: string, q: Partial<ResourceQuery> & Pick<ResourceQuery, 'start' | 'end'>) {
    const [result] = await queryPgChunks(pool, revisionId, [catalog.get(key)!], {
      fidelity: 'display',
      maxSamples: 100_000,
      pointBudget: 2000,
      reduction: 'm4',
      ...q,
    });
    return result;
  }

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
