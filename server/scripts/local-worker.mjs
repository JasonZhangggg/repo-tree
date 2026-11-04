#!/usr/bin/env node
// Runs the history Worker (src/worker.ts) in Node with KV in memory, for e2e runs and trying
// the app locally without Cloudflare. GitHub defaults to a fake-github.mjs on FAKE_URL.
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
const env = {
  HISTORY: kv,
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
  res.end(Buffer.from(await reply.arrayBuffer()));
}).listen(port, () => console.error(`history worker on :${port}, GitHub at ${env.GITHUB_API}`));
