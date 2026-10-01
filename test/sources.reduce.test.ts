import { describe, expect, test } from 'vitest';
import {
  capExact,
  GAP,
  reduceDiscrete,
  reduceNumeric,
  summaryComponents,
  type Series,
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

  test('with too many transitions, stays within budget and keeps changes narrower than a bucket', () => {
    const n = 10_000;
    const series: Series = { s: Array.from({ length: n }, (_, i) => (i % 2 ? 'ON' : 'OFF')), t: [...Array(n).keys()] };
    const out = reduceDiscrete(series, 0, n, 100);
    expect(out.t.length).toBeLessThanOrEqual(100);
    expect(new Set(out.s)).toEqual(new Set(['ON', 'OFF']));
  });
});

describe('summaryComponents', () => {
  test('emits first, min, max, last of each bucket in time order', () => {
    const out = summaryComponents(
      [
        {
          changes: 4,
          firstKind: 0,
          firstS: null,
          firstT: 0,
          firstV: 1,
          lastKind: 0,
          lastS: null,
          lastT: 9,
          lastV: 2,
          maxT: 2,
          maxV: 8,
          minT: 7,
          minV: -3,
          n: 10,
        },
      ],
      true,
    );
    expect(out.t).toEqual([0, 2, 7, 9]);
    expect(out.v).toEqual([1, 8, -3, 2]);
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
