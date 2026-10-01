/**
 * Bounded representations of resource samples for display. Pure functions over columnar samples, shared
 * by every storage provider: a provider supplies raw samples or bucket summaries, these reduce them.
 *
 * Times are integer microseconds since the Unix epoch, which a JS number holds exactly.
 */

export const VALUE = 0;
export const NULL = 1;
export const GAP = 2;

export type Reduction = 'm4' | 'minmax' | 'nth';

/** Samples of one resource in time order. Exactly one of `v` (numeric) or `s` (discrete) is set. */
export type Series = {
  /** Kind of each sample (VALUE, NULL, GAP). Omitted when every sample is a value. */
  k?: number[];
  s?: (string | null)[];
  t: number[];
  v?: (number | null)[];
};

/** One stored summary bucket (see merlin.source_summary). */
export type SummaryRow = {
  changes: number;
  firstKind: number;
  firstS: string | null;
  firstT: number;
  firstV: number | null;
  lastKind: number;
  lastS: string | null;
  lastT: number;
  lastV: number | null;
  maxT: number | null;
  maxV: number | null;
  minT: number | null;
  minV: number | null;
  n: number;
};

export function emptySeries(numeric: boolean): Series {
  return numeric ? { t: [], v: [] } : { s: [], t: [] };
}

export function seriesLength(series: Series): number {
  return series.t.length;
}

function kindAt(series: Series, i: number): number {
  return series.k ? series.k[i] : VALUE;
}

/** The samples at `indices` (ascending), as a new series. */
export function pick(series: Series, indices: number[]): Series {
  const out: Series = { t: indices.map(i => series.t[i]) };
  if (series.v) {
    out.v = indices.map(i => series.v![i]);
  }
  if (series.s) {
    out.s = indices.map(i => series.s![i]);
  }
  if (series.k && indices.some(i => series.k![i] !== VALUE)) {
    out.k = indices.map(i => series.k![i]);
  }
  return out;
}

/** The samples with start <= t < end. */
export function slice(series: Series, start: number, end: number): Series {
  const indices: number[] = [];
  for (let i = 0; i < series.t.length; i++) {
    if (series.t[i] >= start && series.t[i] < end) {
      indices.push(i);
    }
  }
  return pick(series, indices);
}

/** How many output buckets a reduction can use and still emit at most `pointBudget` points. */
export function bucketCount(reduction: Reduction, numeric: boolean, pointBudget: number): number {
  if (!numeric) {
    return Math.max(1, Math.floor(pointBudget / 2));
  }
  switch (reduction) {
    case 'm4':
      // first, min, max, last, and the first null/gap so lines still break there
      return Math.max(1, Math.floor(pointBudget / 5));
    case 'minmax':
      return Math.max(1, Math.floor(pointBudget / 3));
    case 'nth':
      return Math.max(1, pointBudget);
  }
}

function bucketOf(t: number, start: number, end: number, buckets: number): number {
  const b = Math.floor(((t - start) * buckets) / (end - start));
  return Math.min(buckets - 1, Math.max(0, b));
}

/**
 * Reduces numeric samples in [start, end) to at most `pointBudget` points. Returns the series unchanged when
 * it already fits. Every point returned is a real sample.
 *  - m4: per bucket the first, minimum, maximum and last sample (a line through them draws the same pixels as
 *    a line through every sample), plus the first null/gap;
 *  - minmax: per bucket the minimum and maximum, plus the first null/gap;
 *  - nth: every k-th sample.
 */
export function reduceNumeric(
  series: Series,
  start: number,
  end: number,
  pointBudget: number,
  reduction: Reduction,
): Series {
  const n = series.t.length;
  if (n <= pointBudget) {
    return series;
  }
  if (reduction === 'nth') {
    const step = Math.ceil(n / pointBudget);
    const indices: number[] = [];
    for (let i = 0; i < n; i += step) {
      indices.push(i);
    }
    return pick(series, indices);
  }

  const buckets = bucketCount(reduction, true, pointBudget);
  const first = new Int32Array(buckets).fill(-1);
  const last = new Int32Array(buckets).fill(-1);
  const min = new Int32Array(buckets).fill(-1);
  const max = new Int32Array(buckets).fill(-1);
  const nonValue = new Int32Array(buckets).fill(-1);
  const v = series.v!;
  for (let i = 0; i < n; i++) {
    const b = bucketOf(series.t[i], start, end, buckets);
    if (first[b] < 0) {
      first[b] = i;
    }
    last[b] = i;
    if (kindAt(series, i) !== VALUE) {
      if (nonValue[b] < 0) {
        nonValue[b] = i;
      }
      continue;
    }
    const value = v[i] as number;
    if (min[b] < 0 || value < (v[min[b]] as number)) {
      min[b] = i;
    }
    if (max[b] < 0 || value > (v[max[b]] as number)) {
      max[b] = i;
    }
  }

  const indices: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const chosen =
      reduction === 'm4' ? [first[b], min[b], max[b], last[b], nonValue[b]] : [min[b], max[b], nonValue[b]];
    chosen
      .filter(i => i >= 0)
      .sort((a, c) => a - c)
      .forEach(i => {
        if (indices[indices.length - 1] !== i) {
          indices.push(i);
        }
      });
  }
  return pick(series, indices);
}

/** Indices of the samples that start a new state: the first sample, and each that differs from the one before. */
function transitionIndices(series: Series, indices: number[]): number[] {
  const out: number[] = [];
  let prev = -1;
  for (const i of indices) {
    if (prev < 0 || kindAt(series, i) !== kindAt(series, prev) || series.s![i] !== series.s![prev]) {
      out.push(i);
    }
    prev = i;
  }
  return out;
}

/**
 * Reduces discrete samples in [start, end) to at most `pointBudget` points, preserving state transitions.
 * Repeated samples of an unchanged state are dropped first; that alone is lossless for drawing. If there are
 * still too many transitions, each bucket keeps its first transition and the state it ends in, so a change
 * narrower than a bucket still shows.
 */
export function reduceDiscrete(series: Series, start: number, end: number, pointBudget: number): Series {
  const all = series.t.map((_, i) => i);
  const transitions = transitionIndices(series, all);
  if (transitions.length <= pointBudget) {
    return transitions.length === series.t.length ? series : pick(series, transitions);
  }
  const buckets = bucketCount('m4', false, pointBudget);
  const first = new Int32Array(buckets).fill(-1);
  const last = new Int32Array(buckets).fill(-1);
  for (const i of transitions) {
    const b = bucketOf(series.t[i], start, end, buckets);
    if (first[b] < 0) {
      first[b] = i;
    }
    last[b] = i;
  }
  const kept: number[] = [];
  for (let b = 0; b < buckets; b++) {
    if (first[b] >= 0) {
      kept.push(first[b]);
    }
    if (last[b] >= 0 && last[b] !== first[b]) {
      kept.push(last[b]);
    }
  }
  return pick(series, transitionIndices(series, kept));
}

/**
 * The real samples a run of summary buckets records: for each bucket its first, minimum, maximum and last
 * sample (numeric) or its first and last sample (discrete), in time order. Reducing these reduces the data
 * they summarize, to within one summary bucket at each output bucket boundary.
 */
export function summaryComponents(rows: SummaryRow[], numeric: boolean): Series {
  const t: number[] = [];
  const k: number[] = [];
  const v: (number | null)[] = [];
  const s: (string | null)[] = [];
  // Buckets are disjoint and in time order, so sorting each bucket's parts keeps the whole series in order.
  const push = (time: number, kind: number, value: number | null, text: string | null) => {
    t.push(time);
    k.push(kind);
    v.push(value);
    s.push(text);
  };
  for (const row of rows) {
    if (numeric) {
      const parts: [number, number, number | null][] = [[row.firstT, row.firstKind, row.firstV]];
      if (row.minT !== null) {
        parts.push([row.minT, VALUE, row.minV]);
      }
      if (row.maxT !== null) {
        parts.push([row.maxT, VALUE, row.maxV]);
      }
      if (row.n > 1) {
        parts.push([row.lastT, row.lastKind, row.lastV]);
      }
      parts.sort((a, b) => a[0] - b[0]);
      let prevTime = Number.NaN;
      for (const [time, kind, value] of parts) {
        if (time !== prevTime) {
          push(time, kind, kind === VALUE ? value : null, null);
        }
        prevTime = time;
      }
    } else {
      push(row.firstT, row.firstKind, null, row.firstKind === VALUE ? row.firstS : null);
      if (row.n > 1 && row.lastT !== row.firstT) {
        push(row.lastT, row.lastKind, null, row.lastKind === VALUE ? row.lastS : null);
      }
    }
  }
  const out: Series = numeric ? { t, v } : { s, t };
  if (k.some(kind => kind !== VALUE)) {
    out.k = k;
  }
  return out;
}

/**
 * Exact samples, capped at `maxSamples`. A cut never splits samples that share a timestamp, so `next` (the
 * first time not returned) is a valid start for the following page.
 */
export function capExact(series: Series, maxSamples: number): { next: number | null; series: Series } {
  if (series.t.length <= maxSamples) {
    return { next: null, series };
  }
  let cut = maxSamples;
  while (cut > 0 && series.t[cut] === series.t[cut - 1]) {
    cut--;
  }
  if (cut === 0) {
    // more samples at one instant than the cap: return them all rather than none
    cut = maxSamples;
    while (cut < series.t.length && series.t[cut] === series.t[cut - 1]) {
      cut++;
    }
  }
  const indices = Array.from({ length: cut }, (_, i) => i);
  return { next: cut < series.t.length ? series.t[cut] : null, series: pick(series, indices) };
}
