import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gitHubFetch } from '../scripts/fake-github.mjs';
import worker, { type Env } from '../src/worker';
import { DAY, makeRepo } from './repo';

const PAGES = 'https://jasonzhangggg.github.io';
const TOKEN = 'gho_fakefakefakefakefake';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
let repo: ReturnType<typeof makeRepo>;

beforeAll(() => {
  const now = Date.now();
  repo = makeRepo([
    { at: now - 30 * DAY, files: { 'a.txt': '1' } },
    { at: now - DAY, files: { 'b/c.txt': '2' } },
  ]);
  const repos = Object.fromEntries(
    ['app', 'r1', 'r2', 'r3'].map((r) => [`acme/${r}`, { dir: repo.dir }]),
  );
  vi.stubGlobal('fetch', gitHubFetch(repos, { tokens: [TOKEN] }));
});
afterAll(() => {
  vi.unstubAllGlobals();
  repo.remove();
});

function kv() {
  const data = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const value = data.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
  } as unknown as KVNamespace;
}

function env(extra: Partial<Env> = {}): Env {
  return {
    HISTORY: kv(),
    GITHUB_API: 'https://api.github.test',
    GITHUB_WEB: 'https://github.test',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    STEP_REQUESTS: '45',
    ...extra,
  };
}

const ctx = () =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext;

function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Request(`https://history.test${path}`, { method, headers });
}

describe('worker', () => {
  it('answers the Pages origin and localhost with CORS headers and computes a history', async () => {
    const e = env();
    let res = await worker.fetch(get('/v1/history/acme/app', { Origin: PAGES, ...AUTH }), e, ctx());
    for (let i = 0; i < 10 && res.status === 202; i++) {
      res = await worker.fetch(get('/v1/history/acme/app', { Origin: PAGES, ...AUTH }), e, ctx());
    }
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(PAGES);
    const local = await worker.fetch(
      get('/v1/history/acme/app', { Origin: 'http://localhost:5173' }),
      e,
      ctx(),
    );
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    const body = (await res.json()) as { status: string; history: { files: { path: string[] } } };
    expect(body.history.files.path).toEqual(['a.txt', 'b/c.txt']);
  });

  it('refuses other origins and malformed repos', async () => {
    const e = env();
    const other = await worker.fetch(
      get('/v1/history/acme/app', { Origin: 'https://evil.example' }),
      e,
      ctx(),
    );
    expect(other.status).toBe(403);
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await worker.fetch(get('/v1/history/-bad/app'), e, ctx())).status).toBe(400);
    expect((await worker.fetch(get('/v1/history/acme/app?branch=a..b'), e, ctx())).status).toBe(
      400,
    );
    expect((await worker.fetch(get('/v1/history/acme'), e, ctx())).status).toBe(404);
  });

  it('answers a preflight', async () => {
    const res = await worker.fetch(
      get('/v1/history/acme/app', { Origin: PAGES }, 'OPTIONS'),
      env(),
      ctx(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization');
  });

  it('caps new repos per IP per hour', async () => {
    const e = env({ NEW_REPOS_PER_HOUR: '2' });
    const ask = (r: string) =>
      worker.fetch(
        get(`/v1/history/acme/${r}`, { 'CF-Connecting-IP': '1.2.3.4', ...AUTH }),
        e,
        ctx(),
      );
    expect((await ask('r1')).status).not.toBe(503);
    expect((await ask('r2')).status).not.toBe(503);
    expect((await ask('r1')).status).not.toBe(503);
    const third = await ask('r3');
    expect(third.status).toBe(503);
    expect(await third.json()).toMatchObject({ status: 'error', error: 'busy' });
  });

  it('answers a signed-out visitor with needs-auth, and a malformed token with 401', async () => {
    const e = env();
    const out = await worker.fetch(get('/v1/history/acme/app'), e, ctx());
    expect(out.status).toBe(401);
    expect(await out.json()).toEqual({ status: 'needs-auth' });
    const bad = await worker.fetch(
      get('/v1/history/acme/app', { Authorization: 'Bearer x y' }),
      e,
      ctx(),
    );
    expect(await bad.json()).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('signs in through a popup: state, code exchange, token posted to the opener origin', async () => {
    const e = env();
    const start = await worker.fetch(
      get(`/v1/auth/login?origin=${encodeURIComponent(PAGES)}`),
      e,
      ctx(),
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.origin + authorize.pathname).toBe('https://github.test/login/oauth/authorize');
    expect(authorize.searchParams.get('scope')).toBeNull();
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://history.test/v1/auth/callback',
    );
    const back = (await fetch(authorize.href, { redirect: 'manual' })).headers.get('location')!;
    const page = await worker.fetch(new Request(back), e, ctx());
    const html = await page.text();
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain(`postMessage({"type":"repo-tree-auth","token":"${TOKEN}"}, "${PAGES}")`);
    const replay = await (await worker.fetch(new Request(back), e, ctx())).text();
    expect(replay).not.toContain(TOKEN);
  });

  it('refuses to sign in for an origin it does not serve', async () => {
    const res = await worker.fetch(get('/v1/auth/login?origin=https://evil.example'), env(), ctx());
    expect(res.status).toBe(403);
  });
});
