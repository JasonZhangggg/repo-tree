#!/usr/bin/env node
// Measures what computing a repo's history costs on GitHub: requests, bytes on the wire (gzipped,
// as GitHub serves them) and wall time, against scripts/fake-github.mjs over local clones.
//
//   node scripts/measure.mjs [--reader graphql|rest]
//     [--clones <dir>] [--rtt <ms>] [--mbps <megabits>] [--concurrency <n>] [--out <dir>]
//     [--remote <fake server url>] [--per-snapshot] [--json] [repo ...]
//
// repo: linux, vite, dotfiles (default: all three), or owner/name=<git dir>. --clones holds
// <name>.git for the short names. It runs the in-browser engine (src/core/engine.ts) in Node.
// --rtt / --mbps model a network (default 60 ms, 40 Mbit/s on one shared link) so concurrency
// shows in wall time; --rtt 0 turns the model off. --latency github adds GitHub's own time to
// answer each request (fake-github.mjs GITHUB_LATENCY), which is what a real run waits on most.
// --pack reads the trees in one git fetch through the history Worker's git-upload-pack route
// (src/worker.ts, run in this process against the fake); --reader is then the fallback.
// --out writes each history as JSON for diffing.
// Set FAKE_GIT_CACHE=<dir> to keep the fake's history walks on disk: a second run then times the
// engine and the modelled network, not git walking Linux's history for each probe.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GITHUB_LATENCY, gitHubFetch } from './fake-github.mjs';

// Lets plain Node load the core's TypeScript (erasable syntax only, extensionless imports).
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if (s.startsWith('.') && !/\\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
    throw e;
  }
}`),
);
process.removeAllListeners('warning');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    clones: {
      type: 'string',
      default: '/tmp/claude-0/-home-claude/5ac5cb95-dc76-5c12-add7-5b8ab67deeec/scratchpad/pr14',
    },
    rtt: { type: 'string', default: '60' },
    mbps: { type: 'string', default: '40' },
    concurrency: { type: 'string' },
    out: { type: 'string' },
    plan: { type: 'string' },
    recent: { type: 'string' },
    snapshots: { type: 'string' },
    remote: { type: 'string' },
    budget: { type: 'string' },
    reader: { type: 'string' },
    latency: { type: 'string' },
    graphql: { type: 'string' },
    tag: { type: 'string' },
    sparse: { type: 'boolean', default: false },
    pack: { type: 'boolean', default: false },
    'per-snapshot': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const KNOWN = {
  linux: 'torvalds/linux',
  vite: 'vitejs/vite',
  dotfiles: 'mathiasbynens/dotfiles',
};
const targets = (positionals.length ? positionals : Object.keys(KNOWN)).map((spec) => {
  const [name = '', dir] = spec.split('=');
  const full = KNOWN[/** @type {keyof typeof KNOWN} */ (name)] ?? name;
  return {
    short: name.split('/').pop() ?? name,
    full,
    dir: dir ?? join(values.clones, `${name}.git`),
  };
});
const rtt = Number(values.rtt);
const network =
  rtt > 0 ? { rttMs: rtt, bytesPerMs: (Number(values.mbps) * 1e6) / 8 / 1000 } : undefined;

const engine = await import('../src/core/engine.ts');
const { default: worker } = await import('../src/worker.ts');
const TOKEN = `gho_${'x'.repeat(36)}`;
const { tracer, formatTrace } = await import('../src/core/trace.ts');

const rows = [];
for (const t of targets) {
  const branch = execFileSync('git', ['-C', t.dir, 'symbolic-ref', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  {
    const which = 'browser';
    // --remote: a fake-github.mjs server in its own process, so this process holds only the
    // engine (for memory), reached over real HTTP with gzip.
    const remote = values.remote;
    const fake = remote
      ? await remoteFake(remote)
      : gitHubFetch(
          { [t.full]: { dir: t.dir, branch } },
          {
            ...(network ? { network } : {}),
            ...(values.latency === 'github' ? { latency: GITHUB_LATENCY } : {}),
            remaining: 1e9,
          },
        );
    const github = /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fake));
    const api = remote ?? 'https://api.github.test';
    // --pack: the Worker runs here, its own requests going to the fake as GitHub's would.
    const realFetch = globalThis.fetch;
    if (values.pack && !remote) globalThis.fetch = github;
    const env = { GITHUB_API: api, GITHUB_WEB: remote ?? 'https://github.test' };
    const fetch = /** @type {typeof globalThis.fetch} */ (
      async (/** @type {any} */ input, /** @type {any} */ init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith('https://history.test/')) {
          // As the page would send it: the route refuses a request with no Origin.
          const headers = new Headers(init?.headers);
          headers.set('Origin', 'https://jasonzhangggg.github.io');
          return worker.fetch(new Request(url, { ...init, headers }), /** @type {any} */ (env));
        }
        return github(input, init);
      }
    );
    if (global.gc) global.gc();
    const base = process.memoryUsage();
    let peakHeap = base.heapUsed;
    let peakRss = base.rss;
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      peakHeap = Math.max(peakHeap, m.heapUsed);
      peakRss = Math.max(peakRss, m.rss);
    }, 50);
    const started = performance.now();
    /** @type {any} */
    let history;
    /** @type {any} */
    let stats = null;
    const trace = tracer();
    {
      history = await engine.computeHistory({
        fetch,
        api,
        token: values.pack ? TOKEN : 'x',
        ...(values.pack
          ? { packUrl: `https://history.test/v1/git/${t.full}/git-upload-pack` }
          : {}),
        repo: t.full,
        branch,
        ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
        ...(values.plan ? { plan: JSON.parse(values.plan) } : {}),
        ...(values.recent ? { recentCommits: Number(values.recent) } : {}),
        ...(values.snapshots ? { maxSnapshots: Number(values.snapshots) } : {}),
        ...(values.budget ? { treeBudget: Number(values.budget) } : {}),
        ...(values.reader ? { reader: values.reader } : {}),
        ...(values.graphql ? { graphql: JSON.parse(values.graphql) } : {}),
        ...(values.sparse ? { sparse: true } : {}),
        onStats: (/** @type {any} */ s) => (stats = s),
        trace,
      });
    }
    const ms = performance.now() - started;
    globalThis.fetch = realFetch;
    clearInterval(sampler);
    fake.close();
    const s = remote ? await /** @type {any} */ (fake).delta() : fake.state;
    const summary = trace.summary();
    const row = {
      repo: t.short,
      engine: which,
      requests: s.requests,
      bytes: s.bytes,
      raw: s.raw,
      up: s.up ?? 0,
      ms: Math.round(ms),
      peakInFlight: s.peakInFlight,
      peakHeapMB: Math.round((peakHeap - base.heapUsed) / 1e6),
      peakRssMB: Math.round(peakRss / 1e6),
      snapshots: history.snapshots.length,
      files: history.files.path.length,
      gaps: history.gaps.join(',') || '-',
      trace: summary,
      kinds: Object.fromEntries(
        Object.entries(s.kinds).map(([k, v]) => [k, `${v.requests} req ${mb(v.bytes)} MB`]),
      ),
    };
    rows.push({
      ...row,
      ...(stats
        ? {
            split: stats.requests,
            rest: stats.rest,
            graphql: stats.graphql,
            pack: stats.pack,
            store: stats.store,
            retried: stats.retried,
            mainline: stats.mainline,
            mainlineProbes: stats.mainlineProbes,
            picks: stats.picks,
            perSnapshot: stats.perSnapshot,
            shas: history.snapshots.map((/** @type {{ sha: string }} */ x) => x.sha),
          }
        : {}),
    });
    if (stats && values['per-snapshot'] && !values.json) {
      const per = stats.perSnapshot.map(
        (
          /** @type {{ requests: number, entries: number, fresh: number }} */ p,
          /** @type {number} */ j,
        ) => `${j}:${p.requests}/${p.entries}/${p.fresh}`,
      );
      console.error(`per snapshot (REST requests/REST entries/fresh entries): ${per.join(' ')}`);
    }
    if (values.out) {
      mkdirSync(values.out, { recursive: true });
      writeFileSync(
        join(values.out, `${t.short}.${values.tag ?? which}.json`),
        JSON.stringify(history),
      );
    }
    if (!values.json) {
      console.log(
        `${row.repo.padEnd(9)} ${row.engine.padEnd(8)} ${String(row.requests).padStart(6)} req ` +
          `${mb(row.bytes).padStart(8)} MB gz (${mb(row.raw)} MB raw, ${mb(row.up)} MB up) ${(row.ms / 1000).toFixed(1).padStart(6)} s  ` +
          `heap +${row.peakHeapMB} MB rss ${row.peakRssMB} MB  in flight ${row.peakInFlight}  ` +
          `${row.snapshots} snapshots ${row.files} files gaps ${row.gaps}`,
      );
      console.log(
        `          ${Object.entries(row.kinds)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' | ')}`,
      );
      console.log(`          ${formatTrace(t.full, summary)}`);
      if (stats)
        console.log(
          `          requests: ${JSON.stringify(stats.requests)} retried ${stats.retried} rest: ${JSON.stringify(stats.rest)}\n` +
            `          graphql: ${JSON.stringify(stats.graphql)} store: ${JSON.stringify(stats.store)}\n` +
            `          pack: ${JSON.stringify(stats.pack)}\n` +
            `          mainline: ${stats.mainline} (${stats.mainlineProbes} filtered probes) probes ahead: ${stats.aheadProbes} rows: ${stats.rows}`,
        );
    }
  }
}
if (values.json) console.log(JSON.stringify(rows, null, 2));

/** @param {string} base */
async function remoteFake(base) {
  const read = async () => await (await globalThis.fetch(`${base}/__stats`)).json();
  const before = await read();
  const fetchFn = (/** @type {any} */ input, /** @type {any} */ init) =>
    globalThis.fetch(input, init);
  return Object.assign(fetchFn, {
    state: before,
    close() {},
    async delta() {
      const after = await read();
      /** @type {Record<string, any>} */
      const kinds = {};
      for (const [k, v] of Object.entries(after.kinds)) {
        const b = before.kinds[k] ?? { requests: 0, bytes: 0, raw: 0 };
        if (v.requests > b.requests)
          kinds[k] = {
            requests: v.requests - b.requests,
            bytes: v.bytes - b.bytes,
            raw: v.raw - b.raw,
          };
      }
      return {
        requests: after.requests - before.requests,
        bytes: after.bytes - before.bytes,
        raw: after.raw - before.raw,
        up: (after.up ?? 0) - (before.up ?? 0),
        peakInFlight: after.peakInFlight,
        kinds,
      };
    },
  });
}

/** @param {number} bytes */
function mb(bytes) {
  return (bytes / 1e6).toFixed(2);
}
