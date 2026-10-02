import { describe, expect, test } from 'vitest';
import {
  capExact,
  GAP,
  NULL,
  reduceDiscrete,
  reduceNumeric,
  summaryComponents,
  type Series,
  type SummaryRow,
} from '../src/packages/sources/reduce';

function wave(n: number): Series {
  const t = Array.from({ length: n }, (_, i) => i * 1000);
  return { t, v: t.map((_, i) => Math.sin(i / 50) + (i === 1234 ? 10 : 0)) };
}

describe('reduceNumeric', () => {
  for (const reduction of ['m4', 'minmax', 'nth'] as const) {
    test(`${reduction} stays within the point budget and returns real samples`, () => {
      const series = wave(100_000);
      const out = reduceNumeric(series, 0, 100_000 * 1000, 500, reduction);
      expect(out.t.length).toBeLessThanOrEqual(500);
      out.t.forEach((t, i) => expect(out.v![i]).toBe(series.v![t / 1000]));
      expect([...out.t].sort((a, b) => a - b)).toEqual(out.t);
    });
  }

  test('envelope reductions keep a one-sample spike; nth sampling can lose it', () => {
    const series = wave(100_000);
    for (const reduction of ['m4', 'minmax'] as const) {
      expect(Math.max(...(reduceNumeric(series, 0, 1e8, 500, reduction).v as number[]))).toBeGreaterThan(9);
    }
    expect(Math.max(...(reduceNumeric(series, 0, 1e8, 500, 'nth').v as number[]))).toBeLessThan(2);
  });

  test('a series already within budget is returned unchanged', () => {
    const series = wave(100);
    expect(reduceNumeric(series, 0, 1e5, 500, 'm4')).toBe(series);
  });

  test('a gap survives reduction so the line still breaks', () => {
    const series = wave(10_000);
    series.k = series.t.map((_, i) => (i === 5000 ? GAP : 0));
    const out = reduceNumeric(series, 0, 1e7, 100, 'm4');
    expect(out.k).toBeDefined();
    expect(out.k!.filter(k => k === GAP)).toHaveLength(1);
  });
});

describe('reduceDiscrete', () => {
  test('drops repeats first, which keeps every transition', () => {
    const series: Series = { s: ['A', 'A', 'B', 'B', 'A', 'C', 'C'], t: [0, 1, 2, 3, 4, 5, 6] };
    expect(reduceDiscrete(series, 0, 7, 10)).toEqual({ s: ['A', 'B', 'A', 'C'], t: [0, 2, 4, 5] });
  });

  test('a state, null or gap narrower than a bucket still shows', () => {
    // 100 buckets of 100 samples, every one busy except one that holds A, then briefly B and a gap, then A.
    const n = 10_000;
    const s: (string | null)[] = Array.from({ length: n }, (_, i) =>
      i >= 5000 && i < 5100 ? 'A' : i % 2 ? 'ON' : 'OFF',
    );
    const k = s.map(() => 0);
    s[5010] = 'B';
    s[5011] = null;
    k[5011] = GAP;
    const out = reduceDiscrete({ k, s, t: [...Array(n).keys()] }, 0, n, 400);
    expect(out.t.length).toBeLessThanOrEqual(400);
    expect(out.s).toContain('B');
    expect(out.k?.filter(kind => kind === GAP)).toHaveLength(1);
  });

  test('with too many transitions, stays within budget and keeps changes narrower than a bucket', () => {
    const n = 10_000;
    const series: Series = { s: Array.from({ length: n }, (_, i) => (i % 2 ? 'ON' : 'OFF')), t: [...Array(n).keys()] };
    const out = reduceDiscrete(series, 0, n, 100);
    expect(out.t.length).toBeLessThanOrEqual(100);
    expect(new Set(out.s)).toEqual(new Set(['ON', 'OFF']));
  });
});

describe('summaryComponents', () => {
  const row = (r: Partial<SummaryRow>): SummaryRow => ({
    changeKind: null,
    changeS: null,
    changeT: null,
    firstKind: 0,
    firstS: null,
    firstT: 0,
    firstV: null,
    lastKind: 0,
    lastS: null,
    lastT: 9,
    lastV: null,
    maxT: null,
    maxV: null,
    minT: null,
    minV: null,
    n: 10,
    nonValueKind: null,
    nonValueT: null,
    ...r,
  });

  test('emits first, min, max, last of each bucket in time order', () => {
    const out = summaryComponents([row({ firstV: 1, lastV: 2, maxT: 2, maxV: 8, minT: 7, minV: -3 })], true);
    expect(out.t).toEqual([0, 2, 7, 9]);
    expect(out.v).toEqual([1, 8, -3, 2]);
  });

  test('a gap or null inside a bucket whose value never changes still breaks the line', () => {
    for (const kind of [GAP, NULL]) {
      const out = summaryComponents(
        [row({ firstV: 10, lastV: 10, maxT: 0, maxV: 10, minT: 0, minV: 10, nonValueKind: kind, nonValueT: 5 })],
        true,
      );
      expect(out.t).toEqual([0, 5, 9]);
      expect(out.v).toEqual([10, null, 10]);
      expect(out.k).toEqual([0, kind, 0]);
    }
  });

  test('a state held briefly inside a bucket that starts and ends in the same state still shows', () => {
    const out = summaryComponents([row({ changeKind: 0, changeS: 'B', changeT: 4, firstS: 'A', lastS: 'A' })], false);
    expect(out.s).toEqual(['A', 'B', 'A']);
    expect(out.t).toEqual([0, 4, 9]);
    const gap = summaryComponents(
      [row({ changeKind: 0, changeS: 'B', changeT: 4, firstS: 'A', lastS: 'A', nonValueKind: GAP, nonValueT: 5 })],
      false,
    );
    expect(gap.s).toEqual(['A', 'B', null, 'A']);
    expect(gap.k).toEqual([0, 0, GAP, 0]);
  });
});

describe('capExact', () => {
  test('never splits samples that share a timestamp, so the next page starts cleanly', () => {
    const series: Series = { t: [10, 20, 20, 30], v: [1, 2, 3, 4] };
    expect(capExact(series, 2)).toEqual({ next: 20, series: { t: [10], v: [1] } });
    expect(capExact(series, 3)).toEqual({ next: 30, series: { t: [10, 20, 20], v: [1, 2, 3] } });
    expect(capExact(series, 4)).toEqual({ next: null, series });
  });
});
