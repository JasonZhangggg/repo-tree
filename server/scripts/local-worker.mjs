#!/usr/bin/env node
// Runs the history Worker (src/worker.ts) in Node with KV and the Ledger Durable Object in
// memory (node:sqlite), for e2e runs and trying the app locally without Cloudflare. GitHub
// defaults to a fake-github.mjs on FAKE_URL. Localhost origins are allowed (ALLOW_LOCALHOST).
//
//   FAKE_URL=http://localhost:8791 node scripts/local-worker.mjs <port>
import { createServer } from 'node:http';
import { register } from 'node:module';

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

const port = Number(process.argv[2] ?? 8790);
const fake = process.env.FAKE_URL ?? 'http://localhost:8791';
const { default: worker } = await import('../src/worker.ts');
const { ledgerNamespace } = await import('./ledger-sqlite.mjs');

/** @type {Map<string, { value: ArrayBuffer, metadata: unknown }>} */
const data = new Map();
const kv = {
  getWithMetadata: async (/** @type {string} */ key) => {
    const hit = data.get(key);
    return hit
      ? { value: new Response(hit.value).body, metadata: hit.metadata }
      : { value: null, metadata: null };
  },
  put: async (
    /** @type {string} */ key,
    /** @type {ArrayBuffer} */ value,
    /** @type {{ metadata?: unknown }} */ options = {},
  ) => void data.set(key, { value, metadata: options.metadata }),
};
/** Ledger caps: the production defaults unless set (UPLOADS_PER_LOGIN, ...). */
const vars = Object.fromEntries(
  ['UPLOADS_PER_LOGIN', 'UPLOADS_PER_DAY', 'STORED_BYTES', 'KV_WRITES_PER_DAY'].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]]] : [],
  ),
);
const env = {
  HISTORY: kv,
  LEDGER: ledgerNamespace(vars),
  ALLOW_LOCALHOST: '1',
  ...vars,
  GITHUB_API: process.env.GITHUB_API ?? fake,
  GITHUB_WEB: process.env.GITHUB_WEB ?? fake,
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? 'local-client',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? 'local-secret',
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const reply = await worker.fetch(
    new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
    }),
    /** @type {any} */ (env),
  );
  res.writeHead(reply.status, Object.fromEntries(reply.headers));
  if (reply.ok && reply.headers.get('content-type') === 'application/x-git-upload-pack-result') {
    // A pack streams through as it comes, as it does on Cloudflare.
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (reply.body ?? [])) {
      res.write(chunk);
    }
    res.end();
    console.error(`worker ${reply.status} ${req.method} ${req.url}`);
    return;
  }
  const out = Buffer.from(await reply.arrayBuffer());
  // Logged like the fake's lines; refusals with their reason.
  const why = reply.status >= 400 && out.length < 300 ? ` ${out.toString()}` : '';
  console.error(`worker ${reply.status} ${req.method} ${req.url}${why}`);
  res.end(out);
}).listen(port, () => console.error(`history worker on :${port}, GitHub at ${env.GITHUB_API}`));
