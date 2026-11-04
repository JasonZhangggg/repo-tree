/**
 * Cloudflare Worker adapter: routing, CORS, the per-IP limit and a KV-backed Store.
 * The request flow itself lives in core/service.ts and knows nothing of Cloudflare.
 */

import { parseRepoRef } from '../../src/repo/ref';
import { serveHistory, type Store } from './core/service';
import type { HistoryReply } from './shape';

export type Env = {
  HISTORY: KVNamespace;
  /** Secret. Without it GitHub allows 60 requests an hour per Worker IP, so set it. */
  GITHUB_TOKEN?: string;
  /** Comma-separated origins allowed besides localhost. */
  ALLOWED_ORIGINS?: string;
  /** Overrides https://api.github.com, for local runs against a fake GitHub. */
  GITHUB_API?: string;
  /** Optional numeric overrides of the job limits (see core/job.ts). */
  STEP_REQUESTS?: string;
  STEP_ENTRIES?: string;
  RECENT_COMMITS?: string;
  SPLIT_REQUESTS?: string;
  /** GitHub requests to keep in hand: no new job starts below this. */
  RESERVE?: string;
  /** New (uncached) repos one IP may start computing per hour. Cached repos are unlimited. */
  NEW_REPOS_PER_HOUR?: string;
  LIMITER?: RateLimit;
};

/** Popular repos the cron keeps warm in KV, so their first visitor gets history at once. */
export const PREWARM = [
  'facebook/react',
  'microsoft/vscode',
  'vitejs/vite',
  'torvalds/linux',
  'mathiasbynens/dotfiles',
] as const;

const ROUTE = /^\/v1\/history\/([^/]+)\/([^/]+)\/?$/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/** Git's ref name rules, roughly: printable, no `..`, `//`, `@{`, leading or trailing `/`, or `.lock` end. */
const BRANCH = /^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$))[!-~]{1,255}$/;
const BRANCH_CHARS = /^[^~^:?*[\\]*$/;
const STATUS: Record<HistoryReply['status'], number> = { ready: 200, pending: 202, error: 0 };
const ERROR_STATUS = {
  invalid: 400,
  forbidden: 403,
  'not-found': 404,
  empty: 404,
  'rate-limited': 429,
  busy: 503,
  upstream: 502,
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { headers: cors });
    const match = request.method === 'GET' ? ROUTE.exec(url.pathname) : null;
    if (!match) return new Response('not found', { status: 404, headers: cors });

    const ref = parseRepoRef(`${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`);
    const branch = url.searchParams.get('branch') ?? undefined;
    if (
      'kind' in ref ||
      (branch !== undefined && !(BRANCH.test(branch) && BRANCH_CHARS.test(branch)))
    ) {
      return send({ status: 'error', error: 'invalid' });
    }
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({
        key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      });
      if (!success) return send({ status: 'error', error: 'rate-limited', retryAfter: 60 });
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { reply, after } = await serveHistory(
      { owner: ref.owner, repo: ref.repo, branch },
      { ...deps(env), mayStart: (repo) => takeQuota(env, ip, repo) },
    );
    if (after) ctx.waitUntil(after);
    return send(reply);
  },

  /** Cron: one step for one PREWARM repo per tick, round robin, so each tick stays inside one request's limits. */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const tick = Math.floor(controller.scheduledTime / (10 * 60 * 1000));
    const [owner = '', repo = ''] = PREWARM[tick % PREWARM.length]!.split('/');
    const { after } = await serveHistory({ owner, repo }, deps(env));
    await after;
  },
} satisfies ExportedHandler<Env>;

function deps(env: Env) {
  return {
    store: kvStore(env.HISTORY),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    api: env.GITHUB_API ?? 'https://api.github.com',
    token: env.GITHUB_TOKEN,
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

/**
 * Lets an IP start computing at most NEW_REPOS_PER_HOUR distinct repos in the current hour.
 * KV is eventually consistent, so this is a fairness guard, not an exact count.
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
  if (reply.status !== 'ready' && reply.retryAfter)
    headers['Retry-After'] = String(reply.retryAfter);
  return new Response(JSON.stringify(reply), { status, headers });
}

function num<K extends string>(key: K, value: string | undefined): Partial<Record<K, number>> {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 0
    ? ({ [key]: n } as Record<K, number>)
    : {};
}

function kvStore(kv: KVNamespace): Store {
  return {
    get: (key) => kv.get(key, 'json'),
    put: (key, value, ttl) =>
      kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) }),
  };
}
