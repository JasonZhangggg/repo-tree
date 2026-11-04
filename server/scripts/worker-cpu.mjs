#!/usr/bin/env node
// Measures the CPU time the history Worker spends per request, in Node (workerd runs the same V8),
// for a stored history of a given size: GET, an accepted PUT (GitHub and the Ledger answered from
// memory, so only the Worker's own work counts), one ledger call on node:sqlite (the Durable
// Object's own CPU, billed to it, not the Worker), and, for comparison, what reading the body
// would cost. Also a git-upload-pack fetch of 65 wants: the checks up to the streamed answer,
// whose body (here 50 MB) the Worker hands on without reading it.
//
//   node scripts/worker-cpu.mjs <history.json>
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';

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

const file = process.argv[2];
if (!file) throw new Error('usage: worker-cpu.mjs <history.json>');
const json = readFileSync(file, 'utf8');
const history = JSON.parse(json);
const gz = gzipSync(json, { level: 9 });
const { default: worker } = await import('../src/worker.ts');
const { ledgerNamespace } = await import('./ledger-sqlite.mjs');

const tree = 'b'.repeat(40);
const snapshots = history.snapshots.map((/** @type {{sha: string, at: number}} */ s) => ({
  ...s,
  tree,
}));
const [owner, name] = history.repo.split('/');
/** GitHub, answered from memory. */
const github = async (/** @type {string} */ input) => {
  const url = new URL(input);
  const json = (/** @type {unknown} */ body) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/user') return json({ login: 'visitor' });
  if (url.pathname.endsWith('.git/git-upload-pack')) {
    let left = 50e6;
    return new Response(
      new ReadableStream({
        pull(c) {
          if (left <= 0) return c.close();
          c.enqueue(new Uint8Array(65536));
          left -= 65536;
        },
      }),
      { headers: { 'content-type': 'application/x-git-upload-pack-result' } },
    );
  }
  if (url.pathname.endsWith('/commits/' + history.branch)) return new Response(history.head);
  const commit = /\/git\/commits\/([0-9a-f]{40})$/.exec(url.pathname);
  if (commit) {
    const s = snapshots.find((/** @type {{sha: string}} */ x) => x.sha === commit[1]);
    return json({
      tree: { sha: tree },
      committer: { date: new Date(s.at).toISOString() },
      parents: s === snapshots[0] ? [] : [{ sha: 'c'.repeat(40) }],
    });
  }
  return json({ private: false, full_name: history.repo, default_branch: history.branch });
};
globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (github));

const store = new Map();
const kv = {
  getWithMetadata: async (/** @type {string} */ key) => {
    const hit = store.get(key);
    return hit
      ? { value: new Response(hit.value).body, metadata: hit.metadata }
      : { value: null, metadata: null };
  },
  put: async (/** @type {string} */ key, /** @type {ArrayBuffer} */ value, /** @type {any} */ o) =>
    void store.set(key, { value, metadata: o.metadata }),
};
/** The Ledger, always saying yes: its own CPU is measured apart. */
const yes = {
  idFromName: () => 'global',
  get: () => ({ fetch: async () => Response.json({ ok: true }) }),
};
const env = { HISTORY: kv, LEDGER: yes };
const ledger = ledgerNamespace();
let reservations = 0;
const reserveOnce = async () => {
  const stub = ledger.get();
  const res = await stub.fetch('https://ledger/', {
    method: 'POST',
    body: JSON.stringify({
      op: 'reserve',
      key: `h1:k${reservations++ % 150}`,
      head: String(reservations),
      bytes: 1000,
      login: 'visitor',
      now: Date.now(),
    }),
  });
  await res.json();
};
const path = `https://history.test/v1/history/${owner}/${name}?branch=${history.branch}`;

/** CPU ms (user + system) of `fn`, median of `n` runs after a warm-up. */
async function cpu(/** @type {() => Promise<unknown>} */ fn, n = 30) {
  for (let i = 0; i < 3; i++) await fn();
  const runs = [];
  for (let i = 0; i < n; i++) {
    const before = process.cpuUsage();
    await fn();
    const d = process.cpuUsage(before);
    runs.push((d.user + d.system) / 1000);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(n / 2)].toFixed(2);
}

const manifest = JSON.stringify({
  v: 1,
  repo: history.repo,
  branch: history.branch,
  head: history.head,
  computedAt: history.computedAt,
  snapshots,
  bytes: gz.byteLength,
});
const putOnce = async () => {
  store.clear();
  const res = await worker.fetch(
    new Request(path, {
      method: 'PUT',
      body: gz,
      headers: {
        Authorization: 'Bearer gho_' + 'x'.repeat(36),
        'Content-Length': String(gz.byteLength),
        'X-History-Manifest': manifest,
      },
    }),
    env,
  );
  if (res.status !== 201) throw new Error(`PUT ${res.status} ${await res.text()}`);
};
const { fetchRequest } = await import('../src/core/pack.ts');
const wants = Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(40, '0'));
const packOnce = async () => {
  const res = await worker.fetch(
    new Request(`https://history.test/v1/git/${owner}/${name}/git-upload-pack`, {
      method: 'POST',
      body: fetchRequest(wants),
      headers: {
        Authorization: 'Bearer gho_' + 'x'.repeat(36),
        'Content-Type': 'application/x-git-upload-pack-request',
      },
    }),
    env,
  );
  if (res.status !== 200) throw new Error(`pack ${res.status} ${await res.text()}`);
  await res.body?.cancel();
};
const getOnce = async () => {
  const res = await worker.fetch(new Request(path), env);
  if (res.status !== 200) throw new Error(`GET ${res.status}`);
  await res.arrayBuffer();
};

console.log(
  JSON.stringify({
    repo: history.repo,
    snapshots: snapshots.length,
    jsonMB: +(json.length / 1e6).toFixed(2),
    gzipMB: +(gz.byteLength / 1e6).toFixed(2),
    manifestKB: +(manifest.length / 1024).toFixed(1),
    putCpuMs: await cpu(putOnce),
    getCpuMs: await cpu(getOnce),
    packCpuMs: await cpu(packOnce),
    ledgerReserveCpuMs: await cpu(reserveOnce),
    gunzipCpuMs: await cpu(async () => gunzipSync(gz), 10),
    gunzipAndParseCpuMs: await cpu(async () => JSON.parse(gunzipSync(gz).toString()), 10),
  }),
);
