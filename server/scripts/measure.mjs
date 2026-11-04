#!/usr/bin/env node
// Measures what computing a repo's history costs on GitHub: requests, bytes on the wire (gzipped,
// as GitHub serves them) and wall time, against scripts/fake-github.mjs over local clones.
//
//   node scripts/measure.mjs [--engine worker|browser|both] [--clones <dir>] [--rtt <ms>]
//     [--mbps <megabits>] [--concurrency <n>] [--out <dir>] [repo ...]
//
// repo: linux, vite, dotfiles (default: all three), or owner/name=<git dir>. --clones holds
// <name>.git for the short names. `worker` runs the server's step job (src/core/job.ts) as the
// Worker would, step after step; `browser` runs the in-browser engine (src/core/engine.ts).
// --rtt / --mbps model a network (default 60 ms, 40 Mbit/s on one shared link) so concurrency
// shows in wall time; --rtt 0 turns the model off. --out writes each history as JSON for diffing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gitHubFetch } from './fake-github.mjs';

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
    engine: { type: 'string', default: 'both' },
    clones: {
      type: 'string',
      default: '/tmp/claude-0/-home-claude/5ac5cb95-dc76-5c12-add7-5b8ab67deeec/scratchpad/pr14',
    },
    rtt: { type: 'string', default: '60' },
    mbps: { type: 'string', default: '40' },
    concurrency: { type: 'string', default: '6' },
    out: { type: 'string' },
    plan: { type: 'string' },
    recent: { type: 'string' },
    snapshots: { type: 'string' },
    remote: { type: 'string' },
    budget: { type: 'string' },
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
const engines = values.engine === 'both' ? ['worker', 'browser'] : [values.engine ?? 'browser'];
const rtt = Number(values.rtt);
const network =
  rtt > 0 ? { rttMs: rtt, bytesPerMs: (Number(values.mbps) * 1e6) / 8 / 1000 } : undefined;

const { createJob, step, DEFAULT_LIMITS } = await import('../src/core/job.ts');
const { summarize } = await import('../src/core/summarize.ts');
const { gitHub } = await import('../src/core/github.ts');
/** @type {any} */
let engine = null;
try {
  engine = await import('../src/core/engine.ts');
} catch (error) {
  if (engines.includes('browser')) throw error;
}

const rows = [];
for (const t of targets) {
  const branch = execFileSync('git', ['-C', t.dir, 'symbolic-ref', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const head = execFileSync('git', ['-C', t.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const which of engines) {
    // --remote: a fake-github.mjs server in its own process, so this process holds only the
    // engine (for memory), reached over real HTTP with gzip.
    const remote = values.remote;
    const fake = remote
      ? await remoteFake(remote)
      : gitHubFetch({ [t.full]: { dir: t.dir, branch } }, { network, remaining: 1e9 });
    const fetch = /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fake));
    const api = remote ?? 'https://api.github.test';
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
    if (which === 'worker') {
      const job = createJob(t.full, branch, head);
      while (job.phase !== 'done') {
        const gh = gitHub({ fetch, api, token: 'x', limit: DEFAULT_LIMITS.stepRequests });
        await step(job, gh, DEFAULT_LIMITS);
      }
      history = summarize(job, Date.now());
    } else {
      history = await engine.computeHistory({
        fetch,
        api,
        token: 'x',
        repo: t.full,
        branch,
        concurrency: Number(values.concurrency),
        ...(values.plan ? { plan: JSON.parse(values.plan) } : {}),
        ...(values.recent ? { recentCommits: Number(values.recent) } : {}),
        ...(values.snapshots ? { maxSnapshots: Number(values.snapshots) } : {}),
        ...(values.budget ? { treeBudget: Number(values.budget) } : {}),
        onStats: (/** @type {any} */ s) => (stats = s),
      });
    }
    const ms = performance.now() - started;
    clearInterval(sampler);
    fake.close();
    const s = remote ? await /** @type {any} */ (fake).delta() : fake.state;
    const row = {
      repo: t.short,
      engine: which,
      requests: s.requests,
      bytes: s.bytes,
      raw: s.raw,
      ms: Math.round(ms),
      peakInFlight: s.peakInFlight,
      peakHeapMB: Math.round((peakHeap - base.heapUsed) / 1e6),
      peakRssMB: Math.round(peakRss / 1e6),
      snapshots: history.snapshots.length,
      files: history.files.path.length,
      gaps: history.gaps.join(',') || '-',
      kinds: Object.fromEntries(
        Object.entries(s.kinds).map(([k, v]) => [k, `${v.requests} req ${mb(v.bytes)} MB`]),
      ),
    };
    rows.push({ ...row, reader: stats?.trees });
    if (stats && values['per-snapshot'] && !values.json) {
      const per = stats.perSnapshot.map(
        (/** @type {{ requests: number, entries: number }} */ p, /** @type {number} */ j) =>
          `${j}:${p.requests}/${p.entries}`,
      );
      console.error(`per snapshot (requests/entries): ${per.join(' ')}`);
    }
    if (values.out) {
      mkdirSync(values.out, { recursive: true });
      writeFileSync(join(values.out, `${t.short}.${which}.json`), JSON.stringify(history));
    }
    if (!values.json) {
      console.log(
        `${row.repo.padEnd(9)} ${row.engine.padEnd(8)} ${String(row.requests).padStart(6)} req ` +
          `${mb(row.bytes).padStart(8)} MB gz (${mb(row.raw)} MB raw) ${(row.ms / 1000).toFixed(1).padStart(6)} s  ` +
          `heap +${row.peakHeapMB} MB rss ${row.peakRssMB} MB  in flight ${row.peakInFlight}  ` +
          `${row.snapshots} snapshots ${row.files} files gaps ${row.gaps}`,
      );
      console.log(
        `          ${Object.entries(row.kinds)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' | ')}`,
      );
      if (stats)
        console.log(
          `          reader: ${JSON.stringify(stats.trees)} probes in parallel: ${stats.parallelProbes} rows: ${stats.rows}`,
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
