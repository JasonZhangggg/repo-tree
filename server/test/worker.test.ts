import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gitHubFetch } from '../scripts/fake-github.mjs';
import { computeHistory } from '../src/core/engine';
import { SPOT_CHECKS } from '../src/core/upload';
import {
  MAX_UPLOAD_BYTES,
  snapshotDigest,
  type History,
  type StoredManifest,
  type UploadManifest,
} from '../src/shape';
import worker, { type Env } from '../src/worker';
import { DAY, makeRepo } from './repo';

const PAGES = 'https://jasonzhangggg.github.io';
const TOKEN = 'gho_fakefakefakefakefake';
const API = 'https://api.github.test';
let repo: ReturnType<typeof makeRepo>;
let fake: ReturnType<typeof gitHubFetch>;
let history: History;
let trees: { sha: string; at: number; tree: string }[];

beforeAll(async () => {
  const now = Date.now();
  repo = makeRepo([
    { at: now - 300 * DAY, files: { 'a.txt': '1' } },
    { at: now - 100 * DAY, files: { 'b/c.txt': '2' } },
    { at: now - 30 * DAY, files: { 'b/d.txt': '3' } },
    { at: now - 10 * DAY, files: { 'e.txt': '4' } },
    { at: now - DAY, files: { 'b/c.txt': '5' } },
  ]);
  fake = gitHubFetch(
    { 'acme/app': { dir: repo.dir }, 'acme/secret': { dir: repo.dir, private: true } },
    { tokens: [TOKEN], login: 'ada' },
  );
  vi.stubGlobal('fetch', fake);
  history = await computeHistory({
    fetch: fake as unknown as typeof fetch,
    api: API,
    token: TOKEN,
    repo: 'acme/app',
    branch: 'main',
    onSamples: (s) => (trees = s),
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  repo.remove();
});

/** KV in memory, counting writes, with metadata as Workers KV keeps it. */
function kv() {
  const data = new Map<string, { value: Uint8Array; metadata: unknown }>();
  const writes: string[] = [];
  const store = {
    data,
    writes,
    getWithMetadata: async (key: string) => {
      const hit = data.get(key);
      if (!hit) return { value: null, metadata: null };
      return { value: new Response(hit.value).body, metadata: hit.metadata };
    },
    put: async (key: string, value: ArrayBuffer, options?: { metadata?: unknown }) => {
      writes.push(key);
      data.set(key, { value: new Uint8Array(value), metadata: options?.metadata });
    },
  };
  return store;
}

function env(extra: Partial<Env> = {}) {
  const store = kv();
  const e: Env = {
    HISTORY: store as unknown as KVNamespace,
    GITHUB_API: API,
    GITHUB_WEB: 'https://github.test',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    ...extra,
  };
  return { e, store };
}

const call = (e: Env, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://history.test${path}`, init), e);

function manifestOf(h: History, body: Uint8Array): UploadManifest {
  return {
    v: 1,
    repo: h.repo,
    branch: h.branch,
    head: h.head,
    computedAt: h.computedAt,
    snapshots: trees.map(({ sha, at, tree }) => ({ sha, at, tree })),
    bytes: body.byteLength,
  };
}

/** A PUT of `h` (or `body`), its manifest edited by `edit`. */
function put(
  e: Env,
  options: {
    h?: History;
    body?: Uint8Array;
    edit?: (m: UploadManifest) => void;
    token?: string | null;
    path?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const h = options.h ?? history;
  const body = options.body ?? gzipSync(JSON.stringify(h));
  const m = manifestOf(h, body);
  options.edit?.(m);
  const token = options.token === undefined ? TOKEN : options.token;
  return call(e, options.path ?? '/v1/history/acme/app?branch=main', {
    method: 'PUT',
    body,
    headers: {
      Origin: PAGES,
      'Content-Type': 'application/gzip',
      'Content-Length': String(body.byteLength),
      'X-History-Manifest': JSON.stringify(m),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

describe('history routes', () => {
  it('answers allowed origins with CORS, refuses others, and lists PUT in a preflight', async () => {
    const { e } = env();
    const ok = await call(e, '/v1/history/acme/app?branch=main', { headers: { Origin: PAGES } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(PAGES);
    expect(ok.headers.get('Access-Control-Expose-Headers')).toBe('X-History-Manifest');
    const local = await call(e, '/v1/history/acme/app?branch=main', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    const evil = await call(e, '/v1/history/acme/app?branch=main', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    const pre = await call(e, '/v1/history/acme/app', {
      method: 'OPTIONS',
      headers: { Origin: PAGES },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('GET, PUT');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('X-History-Manifest');
  });

  it('says missing for a branch nobody uploaded, and refuses malformed requests', async () => {
    const { e } = env();
    const missing = await call(e, '/v1/history/acme/app?branch=main');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ status: 'missing' });
    expect(missing.headers.get('Cache-Control')).toBe('no-store');
    for (const path of [
      '/v1/history/acme/app',
      '/v1/history/acme/app?branch=a..b',
      '/v1/history/-bad/app?branch=main',
    ]) {
      expect((await call(e, path)).status, path).toBe(400);
    }
    expect((await call(e, '/v1/history/acme/app?branch=main', { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('stores a checked upload with one KV write and serves it to anyone, untouched', async () => {
    const { e, store } = env();
    const body = gzipSync(JSON.stringify(history));
    const res = await put(e, { body });
    expect(res.status).toBe(201);
    const reply = (await res.json()) as { status: string; manifest: StoredManifest };
    expect(reply.status).toBe('stored');
    expect(store.writes).toEqual(['h1:acme/app@main']);
    expect(reply.manifest).toMatchObject({
      repo: 'acme/app',
      branch: 'main',
      head: history.head,
      snapshots: history.snapshots.length,
      digest: await snapshotDigest(history.snapshots),
      bytes: body.byteLength,
      by: 'ada',
    });

    const got = await call(e, '/v1/history/ACME/App?branch=main', { headers: { Origin: PAGES } });
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('application/gzip');
    expect(JSON.parse(got.headers.get('X-History-Manifest')!)).toEqual(reply.manifest);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array(body));
  });

  it('checks the token, the head and a few snapshots with GitHub: seven requests', async () => {
    const { e } = env();
    const before = fake.state.requests;
    expect((await put(e)).status).toBe(201);
    expect(fake.state.requests - before).toBe(3 + 1 + SPOT_CHECKS);
  });

  it('writes nothing for a head already stored', async () => {
    const { e, store } = env();
    expect((await put(e)).status).toBe(201);
    const again = await put(e);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ status: 'error', error: 'exists' });
    expect(store.writes).toHaveLength(1);
  });

  it.each<[string, NonNullable<Parameters<typeof put>[1]>, number, string]>([
    ['no token', { token: null }, 401, 'unauthorized'],
    ['a token GitHub refuses', { token: 'gho_revokedrevokedrevoked' }, 401, 'unauthorized'],
    [
      'a private repo',
      {
        path: '/v1/history/acme/secret?branch=main',
        edit: (m: UploadManifest) => void (m.repo = 'acme/secret'),
      },
      403,
      'private',
    ],
    [
      'a head that is not the branch head',
      {
        edit: (m: UploadManifest) => {
          m.snapshots.pop();
          m.head = m.snapshots[m.snapshots.length - 1]!.sha;
        },
      },
      409,
      'stale',
    ],
    [
      'a snapshot with another tree',
      {
        edit: (m: UploadManifest) => {
          for (const s of m.snapshots) s.tree = m.snapshots[0]!.tree;
        },
      },
      422,
      'mismatch',
    ],
    [
      'a snapshot at another time',
      { edit: (m: UploadManifest) => m.snapshots.forEach((s, i) => (s.at -= i < 4 ? 1000 : 0)) },
      422,
      'mismatch',
    ],
    [
      'a snapshot GitHub does not know',
      {
        edit: (m: UploadManifest) => {
          for (const s of m.snapshots.slice(0, -1)) s.sha = 'f'.repeat(40);
        },
      },
      422,
      'mismatch',
    ],
    [
      'a manifest for another repo',
      { edit: (m: UploadManifest) => void (m.repo = 'acme/other') },
      400,
      'invalid',
    ],
    [
      'a manifest whose size is not the body',
      { edit: (m: UploadManifest) => void (m.bytes += 1) },
      400,
      'invalid',
    ],
    ['a body that is not gzip', { body: new TextEncoder().encode('{"v":1}') }, 400, 'invalid'],
  ])('refuses %s', async (_, options, status, error) => {
    const { e, store } = env();
    const res = await put(e, options);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ status: 'error', error });
    expect(store.writes).toHaveLength(0);
  });

  it('refuses a body over the cap before reading it', async () => {
    const { e, store } = env();
    const res = await put(e, {
      headers: { 'Content-Length': String(MAX_UPLOAD_BYTES + 1) },
      body: new Uint8Array(16),
      edit: (m) => void (m.bytes = MAX_UPLOAD_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(store.writes).toHaveLength(0);
  });

  it('rate-limits uploads per IP, before asking GitHub', async () => {
    const { e, store } = env({ UPLOAD_LIMITER: { limit: async () => ({ success: false }) } });
    const before = fake.state.requests;
    const res = await put(e, { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(fake.state.requests).toBe(before);
    expect(store.writes).toHaveLength(0);
  });

  it('caps uploads per IP an hour in the data center cache', async () => {
    const cached = new Map<string, string>();
    vi.stubGlobal('caches', {
      default: {
        match: async (r: Request) =>
          cached.has(r.url) ? new Response(cached.get(r.url)) : undefined,
        put: async (r: Request, res: Response) => void cached.set(r.url, await res.text()),
      },
    });
    try {
      const { e } = env({ UPLOADS_PER_IP_HOUR: '1' });
      expect((await put(e)).status).toBe(201);
      const second = await put(e, {
        path: '/v1/history/acme/app?branch=other',
        edit: (m) => void (m.branch = 'other'),
      });
      expect(second.status).toBe(429);
    } finally {
      vi.stubGlobal('caches', undefined);
    }
  });
});

describe('sign-in', () => {
  async function loginState(e: Env) {
    const start = await call(e, `/v1/auth/login?origin=${encodeURIComponent(PAGES)}`);
    expect(start.status).toBe(302);
    return new URL(start.headers.get('location')!);
  }

  it('signs in through a popup: signed state, code exchange, token posted to the opener origin', async () => {
    const { e, store } = env();
    const authorize = await loginState(e);
    expect(authorize.origin + authorize.pathname).toBe('https://github.test/login/oauth/authorize');
    expect(authorize.searchParams.get('scope')).toBeNull();
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://history.test/v1/auth/callback',
    );
    const back = (await fetch(authorize.href, { redirect: 'manual' })).headers.get('location')!;
    const page = await worker.fetch(new Request(back), e);
    const html = await page.text();
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain(`postMessage({"type":"repo-tree-auth","token":"${TOKEN}"}, "${PAGES}")`);
    expect(store.writes).toHaveLength(0);
  });

  it('refuses a forged or expired state', async () => {
    const { e } = env();
    const state = (await loginState(e)).searchParams.get('state')!;
    const [payload, mac] = state.split('.');
    const forged = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/')));
    forged.o = 'https://evil.example';
    const evil = btoa(JSON.stringify(forged)).replace(/=+$/, '');
    for (const s of [`${evil}.${mac}`, 'nonsense', `${payload}.${'0'.repeat(64)}`]) {
      const html = await (await call(e, `/v1/auth/callback?code=c&state=${s}`)).text();
      expect(html).toContain('expired');
      expect(html).not.toContain(TOKEN);
    }
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    try {
      const html = await (await call(e, `/v1/auth/callback?code=fake-code&state=${state}`)).text();
      expect(html).not.toContain(TOKEN);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses to sign in for an origin it does not serve', async () => {
    const { e } = env();
    const res = await call(e, '/v1/auth/login?origin=https://evil.example');
    expect(res.status).toBe(403);
  });
});
