#!/usr/bin/env node
// Measures the CPU time the history Worker spends per request, in Node (workerd runs the same V8),
// for a stored history of a given size: GET, an accepted PUT (GitHub and the Ledger answered from
// memory, so only the Worker's own work counts), one ledger call on node:sqlite (the Durable
// Object's own CPU, billed to it, not the Worker), and, for comparison, what reading the body
// would cost. Also a git-upload-pack fetch of 65 wants: the checks up to the streamed answer
// (packCpuMs); with PACK_MAX_BYTES set, the checks plus the whole 50 MB answer (a Linux-sized
// pack) passed through the byte cap in `chunk`-byte chunks (packStreamCpuMs), and the cap alone
// less a bare read of the same stream (packCapCpuMs). Node's streams are not workerd's: there,
// an untouched body is piped natively and costs the Worker nothing, and any JavaScript per chunk
// costs far more than here (scripts/stream-cpu.mjs).
//
//   node scripts/worker-cpu.mjs <history.json> [chunk bytes, default 65536]
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
if (!file) throw new Error('usage: worker-cpu.mjs <history.json> [chunk bytes]');
const CHUNK = Number(process.argv[3] ?? 65536);
const PACK_BYTES = 50e6;
const json = readFileSync(file, 'utf8');
const history = JSON.parse(json);
const gz = gzipSync(json, { level: 9 });
const { default: worker, capped } = await import('../src/worker.ts');
const { ledgerNamespace } = await import('./ledger-sqlite.mjs');

const tree = 'b'.repeat(40);
const snapshots = history.snapshots.map((/** @type {{sha: string, at: number}} */ s) => ({
  ...s,
  tree,
}));
const [owner, name] = history.repo.split('/');
/** GitHub, answered from memory. */
/** A pack-sized answer in CHUNK-byte chunks (one buffer, enqueued again and again). */
const packStream = () => {
  let left = PACK_BYTES;
  const chunk = new Uint8Array(CHUNK);
  return new ReadableStream({
    pull(c) {
      if (left <= 0) return c.close();
      c.enqueue(chunk);
      left -= CHUNK;
    },
  });
};
const github = async (/** @type {string} */ input, /** @type {RequestInit} */ init) => {
  const url = new URL(input);
  const json = (/** @type {unknown} */ body) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/user') return json({ login: 'visitor' });
  if (url.pathname === '/graphql') {
    // Public, and every alias (one per want) a commit.
    const { query } = JSON.parse(String(init.body));
    /** @type {Record<string, unknown>} */
    const repository = { isPrivate: false };
    for (const [, alias] of query.matchAll(/(w\d+):object/g)) {
      repository[alias] = { __typename: 'Commit' };
    }
    return json({ data: { repository } });
  }
  if (url.pathname.endsWith('.git/git-upload-pack')) {
    return new Response(packStream(), {
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    });
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
const { MAX_PACK_BYTES, fetchRequest } = await import('../src/core/pack.ts');
const wants = Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(40, '0'));
const packRequest = (/** @type {Record<string, string>} */ extra = {}) =>
  worker
    .fetch(
      new Request(`https://history.test/v1/git/${owner}/${name}/git-upload-pack`, {
        method: 'POST',
        body: fetchRequest(wants),
        headers: {
          Origin: 'https://jasonzhangggg.github.io',
          Authorization: 'Bearer gho_' + 'x'.repeat(36),
          'Content-Type': 'application/x-git-upload-pack-request',
        },
      }),
      { ...env, ...extra },
    )
    .then(async (res) => {
      if (res.status !== 200) throw new Error(`pack ${res.status} ${await res.text()}`);
      return res;
    });
/** Every chunk of `body` read and dropped; the bytes read. */
const drain = async (/** @type {ReadableStream<Uint8Array>} */ body) => {
  const reader = body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.byteLength;
  }
};
const packOnce = async () => {
  const res = await packRequest();
  await res.body?.cancel();
};
const packStreamOnce = async () => {
  const res = await packRequest({ PACK_MAX_BYTES: String(MAX_PACK_BYTES) });
  if ((await drain(/** @type {ReadableStream<Uint8Array>} */ (res.body))) < PACK_BYTES) {
    throw new Error('pack cut short');
  }
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
    packStreamCpuMs: await cpu(packStreamOnce, 10),
    packCapCpuMs: (
      (await cpu(async () => drain(capped(packStream(), MAX_PACK_BYTES)), 10)) -
      (await cpu(async () => drain(packStream()), 10))
    ).toFixed(2),
    packChunks: Math.ceil(PACK_BYTES / CHUNK),
    ledgerReserveCpuMs: await cpu(reserveOnce),
    gunzipCpuMs: await cpu(async () => gunzipSync(gz), 10),
    gunzipAndParseCpuMs: await cpu(async () => JSON.parse(gunzipSync(gz).toString()), 10),
  }),
);
