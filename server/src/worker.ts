/**
 * Cloudflare Worker adapter: routing, CORS, sign-in, the per-IP limits and a KV-backed Store.
 * The request flow and the OAuth exchange live in core/ and know nothing of Cloudflare.
 */

import { parseRepoRef } from '../../src/repo/ref';
import { callbackPage, finishLogin, startLogin, type OAuthConfig } from './core/oauth';
import { serveHistory, type Deps, type Store } from './core/service';
import type { HistoryReply } from './shape';

export type Env = {
  HISTORY: KVNamespace;
  /** OAuth App client id (public) and secret. Without both, sign-in is off. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The callback URL registered on the OAuth App; defaults to this Worker's /v1/auth/callback. */
  OAUTH_CALLBACK_URL?: string;
  /** Optional secret, used only by the prewarm cron. Visitors' work runs on their own tokens. */
  GITHUB_TOKEN?: string;
  /** Comma-separated origins allowed besides localhost. */
  ALLOWED_ORIGINS?: string;
  /** Overrides https://api.github.com and https://github.com, for local runs against a fake. */
  GITHUB_API?: string;
  GITHUB_WEB?: string;
  /** Optional numeric overrides of the job limits (see core/job.ts). */
  STEP_REQUESTS?: string;
  STEP_ENTRIES?: string;
  RECENT_COMMITS?: string;
  SPLIT_REQUESTS?: string;
  /** GitHub requests a token keeps in hand: no new job starts below this. */
  RESERVE?: string;
  /** New (uncached) repos one IP may start computing per hour. Cached repos are unlimited. */
  NEW_REPOS_PER_HOUR?: string;
  LIMITER?: RateLimit;
};

/** Popular repos the cron keeps warm in KV with GITHUB_TOKEN, so their first visitor gets history at once. */
export const PREWARM = [
  'facebook/react',
  'microsoft/vscode',
  'vitejs/vite',
  'torvalds/linux',
  'mathiasbynens/dotfiles',
] as const;

const HISTORY_ROUTE = /^\/v1\/history\/([^/]+)\/([^/]+)\/?$/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/** Git's ref name rules, roughly: printable, no `..`, `//`, `@{`, leading or trailing `/`, or `.lock` end. */
const BRANCH = /^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$))[!-~]{1,255}$/;
const BRANCH_CHARS = /^[^~^:?*[\\]*$/;
/** GitHub token shapes (gho_, ghp_, github_pat_ and older hex tokens). Anything else is refused unseen. */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const STATUS = { ready: 200, pending: 202, 'needs-auth': 401 } as const;
const ERROR_STATUS = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  private: 403,
  'not-found': 404,
  empty: 404,
  'rate-limited': 429,
  upstream: 502,
  busy: 503,
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/auth/login') return login(url, env);
    if (url.pathname === '/v1/auth/callback') return callback(url, env);

    const origin = request.headers.get('Origin');
    const allowed = origin !== null && isAllowed(origin, env);
    const cors: Record<string, string> = allowed
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : { Vary: 'Origin' };
    const send = (reply: HistoryReply) => respond(reply, cors);

    if (origin !== null && !allowed) return send({ status: 'error', error: 'forbidden' });
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (url.pathname === '/health') return new Response('ok', { headers: cors });
    const match = request.method === 'GET' ? HISTORY_ROUTE.exec(url.pathname) : null;
    if (!match) return new Response('not found', { status: 404, headers: cors });

    const ref = parseRepoRef(`${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`);
    const branch = url.searchParams.get('branch') ?? undefined;
    if (
      'kind' in ref ||
      (branch !== undefined && !(BRANCH.test(branch) && BRANCH_CHARS.test(branch)))
    ) {
      return send({ status: 'error', error: 'invalid' });
    }
    const auth = request.headers.get('Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    if (auth !== null && (token === undefined || !TOKEN.test(token))) {
      return send({ status: 'error', error: 'unauthorized' });
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) {
      return send({ status: 'error', error: 'rate-limited', retryAfter: 60 });
    }

    const { reply, after } = await serveHistory(
      { owner: ref.owner, repo: ref.repo, branch },
      { ...deps(env, token), mayStart: (repo) => takeQuota(env, ip, repo) },
    );
    if (after) ctx.waitUntil(after);
    return send(reply);
  },

  /** Cron: one step for one PREWARM repo per tick, round robin, so each tick stays inside one request's limits. */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (!env.GITHUB_TOKEN) return;
    const tick = Math.floor(controller.scheduledTime / (10 * 60 * 1000));
    const [owner = '', repo = ''] = PREWARM[tick % PREWARM.length]!.split('/');
    const { after } = await serveHistory({ owner, repo }, deps(env, env.GITHUB_TOKEN));
    await after;
  },
} satisfies ExportedHandler<Env>;

function deps(env: Env, token: string | undefined): Deps {
  return {
    store: kvStore(env.HISTORY),
    fetch: (input, init) => fetch(input, init),
    api: env.GITHUB_API ?? 'https://api.github.com',
    token,
    now: Date.now,
    limits: {
      ...num('stepRequests', env.STEP_REQUESTS),
      ...num('stepEntries', env.STEP_ENTRIES),
      ...num('recentCommits', env.RECENT_COMMITS),
      ...num('splitRequests', env.SPLIT_REQUESTS),
    },
    reserve: Number(env.RESERVE ?? 200),
  };
}

function oauth(url: URL, env: Env): OAuthConfig | null {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;
  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    callbackUrl: env.OAUTH_CALLBACK_URL ?? `${url.origin}/v1/auth/callback`,
    web: env.GITHUB_WEB ?? 'https://github.com',
    store: kvStore(env.HISTORY),
    fetch: (input, init) => fetch(input, init),
  };
}

/** /v1/auth/login?origin=<the app's origin>: off to GitHub with a fresh state. */
async function login(url: URL, env: Env): Promise<Response> {
  const config = oauth(url, env);
  const origin = url.searchParams.get('origin') ?? '';
  if (!config) return new Response('sign-in is not configured', { status: 503 });
  if (!isAllowed(origin, env)) return new Response('origin not allowed', { status: 403 });
  return Response.redirect(await startLogin(origin, config), 302);
}

async function callback(url: URL, env: Env): Promise<Response> {
  const config = oauth(url, env);
  if (!config) return new Response('sign-in is not configured', { status: 503 });
  const { origin, message } = await finishLogin(
    url.searchParams.get('code'),
    url.searchParams.get('state'),
    config,
  );
  return new Response(callbackPage(origin, message), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'",
    },
  });
}

/**
 * Lets an IP start computing at most NEW_REPOS_PER_HOUR distinct repos in the current hour.
 * KV is eventually consistent, so this is an abuse guard, not an exact count.
 */
async function takeQuota(env: Env, ip: string, repo: string): Promise<boolean> {
  const cap = Number(env.NEW_REPOS_PER_HOUR ?? 10);
  const key = `quota:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const started = (await env.HISTORY.get<string[]>(key, 'json')) ?? [];
  if (started.includes(repo)) return true;
  if (started.length >= cap) return false;
  await env.HISTORY.put(key, JSON.stringify([...started, repo]), { expirationTtl: 3600 });
  return true;
}

function isAllowed(origin: string, env: Env): boolean {
  if (LOCAL.test(origin)) return true;
  const list = (env.ALLOWED_ORIGINS ?? 'https://jasonzhangggg.github.io').split(',');
  return list.some((o) => o.trim() === origin);
}

function respond(reply: HistoryReply, cors: Record<string, string>): Response {
  const status = reply.status === 'error' ? ERROR_STATUS[reply.error] : STATUS[reply.status];
  const headers: Record<string, string> = { ...cors, 'Content-Type': 'application/json' };
  headers['Cache-Control'] =
    reply.status === 'ready' && !reply.stale ? 'public, max-age=300' : 'no-store';
  const retry = 'retryAfter' in reply ? reply.retryAfter : undefined;
  if (retry) headers['Retry-After'] = String(retry);
  return new Response(JSON.stringify(reply), { status, headers });
}

function num<K extends string>(key: K, value: string | undefined): Partial<Record<K, number>> {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 0
    ? ({ [key]: n } as Record<K, number>)
    : {};
}

function kvStore(kv: KVNamespace): Store & { delete(key: string): Promise<void> } {
  return {
    get: (key) => kv.get(key, 'json'),
    put: (key, value, ttl) =>
      kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) }),
    delete: (key) => kv.delete(key),
  };
}
