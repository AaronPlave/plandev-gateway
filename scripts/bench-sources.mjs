// Benchmarks POST /sources/query against one imported revision: latency, response size and points returned
// across window widths, resource counts and fidelities, plus concurrent clients.
//
//   PLANDEV_TOKEN=... node scripts/bench-sources.mjs --revision 2 [--gateway http://localhost:9000]
//     [--hasura http://localhost:8080] [--repeat 5] [--budget 2000] [--out results.json]
//
// Windows are placed at random inside the revision's coverage, so repeats do not hit the same rows.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    budget: { default: '2000', type: 'string' },
    gateway: { default: 'http://localhost:9000', type: 'string' },
    hasura: { default: 'http://localhost:8080', type: 'string' },
    out: { type: 'string' },
    repeat: { default: '5', type: 'string' },
    revision: { type: 'string' },
  },
});
const token = process.env.PLANDEV_TOKEN;
if (!args.revision || !token) {
  console.error('usage: PLANDEV_TOKEN=... node scripts/bench-sources.mjs --revision <id> [...]');
  process.exit(2);
}
const revisionId = Number(args.revision);
const repeat = Number(args.repeat);
const pointBudget = Number(args.budget);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const SECOND = 1e6;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;

async function catalog() {
  const response = await fetch(`${args.hasura}/v1/graphql`, {
    body: JSON.stringify({
      query: `query ($id: Int!) { source_revision_by_pk(id: $id) { coverage_start coverage_end
        resources(order_by: { sample_count: desc }, limit: 100) { key numeric sample_count } } }`,
      variables: { id: revisionId },
    }),
    headers,
    method: 'POST',
  });
  const { data, errors } = await response.json();
  if (errors) throw new Error(JSON.stringify(errors));
  const r = data.source_revision_by_pk;
  return {
    end: Date.parse(r.coverage_end) * 1000,
    resources: r.resources,
    start: Date.parse(r.coverage_start) * 1000,
  };
}

async function query(body) {
  const began = performance.now();
  const response = await fetch(`${args.gateway}/sources/query`, {
    body: JSON.stringify({ revisionId, ...body }),
    headers: { ...headers, 'accept-encoding': 'gzip' },
    method: 'POST',
  });
  const text = await response.text();
  const ms = performance.now() - began;
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  const json = JSON.parse(text);
  let points = 0;
  let maxPoints = 0;
  for (const r of json.results) {
    const n = r.series?.t.length ?? 0;
    points += n;
    maxPoints = Math.max(maxPoints, n);
  }
  return {
    jsonBytes: text.length,
    maxPoints,
    ms,
    points,
    queryMs: json.timing.queryMs,
    representations: [...new Set(json.results.map(r => r.representation))].join('+'),
    wireBytes: Number(response.headers.get('content-length') ?? text.length),
  };
}

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = xs => percentile(xs, 50);

function randomWindow(coverage, width) {
  const span = coverage.end - coverage.start;
  if (width >= span) return { end: coverage.end + 1, start: coverage.start };
  const start = coverage.start + Math.floor(Math.random() * (span - width));
  return { end: start + width, start };
}

const fmtWidth = w =>
  w >= 365 * DAY
    ? `${(w / (365 * DAY)).toFixed(1)} y`
    : w >= DAY
    ? `${w / DAY} d`
    : w >= HOUR
    ? `${w / HOUR} h`
    : w >= 60 * SECOND
    ? `${w / (60 * SECOND)} min`
    : `${w / SECOND} s`;

async function scenario(coverage, { fidelity, resourceCount, width }) {
  const keys = coverage.resources.slice(0, resourceCount).map(r => r.key);
  const runs = [];
  for (let i = 0; i < repeat; i++) {
    runs.push(await query({ ...randomWindow(coverage, width), fidelity, pointBudget, resources: keys }));
  }
  return {
    fidelity,
    jsonKB: Math.round(median(runs.map(r => r.jsonBytes)) / 1024),
    maxPointsPerResource: Math.max(...runs.map(r => r.maxPoints)),
    p50ms: Math.round(median(runs.map(r => r.ms))),
    p95ms: Math.round(
      percentile(
        runs.map(r => r.ms),
        95,
      ),
    ),
    points: Math.round(median(runs.map(r => r.points))),
    representation: [...new Set(runs.map(r => r.representations))].join(','),
    resourceCount,
    serverQueryMs: Math.round(median(runs.map(r => r.queryMs))),
    width: fmtWidth(width),
    wireKB: Math.round(median(runs.map(r => r.wireBytes)) / 1024),
  };
}

async function concurrent(coverage, { clients, perClient, resourceCount, width }) {
  const keys = coverage.resources.slice(0, resourceCount).map(r => r.key);
  const latencies = [];
  const began = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async () => {
      for (let i = 0; i < perClient; i++) {
        const r = await query({ ...randomWindow(coverage, width), pointBudget, resources: keys });
        latencies.push(r.ms);
      }
    }),
  );
  const seconds = (performance.now() - began) / 1000;
  return {
    clients,
    p50ms: Math.round(median(latencies)),
    p95ms: Math.round(percentile(latencies, 95)),
    queriesPerSecond: Number((latencies.length / seconds).toFixed(1)),
    resourceCount,
    width: fmtWidth(width),
  };
}

const coverage = await catalog();
console.error(
  `revision ${revisionId}: ${coverage.resources.length} largest resources, ` +
    `${fmtWidth(coverage.end - coverage.start)} coverage, budget ${pointBudget}`,
);

// warm the gateway's per-revision catalog and auth caches
await query({ end: coverage.start + DAY, resources: [coverage.resources[0].key], start: coverage.start });

const widths = [
  coverage.end - coverage.start + 1,
  365 * DAY,
  30 * DAY,
  7 * DAY,
  DAY,
  HOUR,
  10 * 60 * SECOND,
  60 * SECOND,
  SECOND,
];
const results = { concurrent: [], display: [], exact: [] };
for (const resourceCount of [1, 10, 50, 100]) {
  for (const width of widths) {
    const r = await scenario(coverage, { fidelity: 'display', resourceCount, width });
    results.display.push(r);
    console.error(JSON.stringify(r));
  }
}
for (const resourceCount of [1, 10]) {
  for (const width of [DAY, HOUR, 10 * 60 * SECOND, 60 * SECOND, SECOND]) {
    const r = await scenario(coverage, { fidelity: 'exact', resourceCount, width });
    results.exact.push(r);
    console.error(JSON.stringify(r));
  }
}
for (const clients of [1, 4, 8, 16]) {
  const r = await concurrent(coverage, { clients, perClient: 10, resourceCount: 10, width: 30 * DAY });
  results.concurrent.push(r);
  console.error(JSON.stringify(r));
}

const table = rows => {
  const cols = Object.keys(rows[0]);
  return [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${cols.map(c => r[c]).join(' | ')} |`),
  ].join('\n');
};
console.log(`## Display (pointBudget ${pointBudget})\n\n${table(results.display)}\n`);
console.log(`## Exact\n\n${table(results.exact)}\n`);
console.log(`## Concurrent clients (10 resources, 30-day windows)\n\n${table(results.concurrent)}\n`);
if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
