/**
 * The history Worker, small enough for Cloudflare's free plan (10 ms of CPU and 50 subrequests a
 * request, 1,000 KV writes a day). It computes nothing: visitors' browsers compute a repo's
 * history with their own GitHub token (src/core/engine.ts) and upload it here, and everyone
 * after them reads it from KV.
 *
 *   GET  /v1/auth/login?origin=<app>   sign in with GitHub (popup), no KV
 *   GET  /v1/auth/callback             OAuth callback: posts the token to the opener
 *   GET  /v1/history/<owner>/<repo>?branch=<b>
 *        200 the gzipped History, its StoredManifest in X-History-Manifest; 404 {status:'missing'}
 *        One KV read; the body streams through untouched.
 *   PUT  /v1/history/<owner>/<repo>?branch=<b>   (signed in; body gzipped History JSON,
 *        X-History-Manifest an UploadManifest) checked by core/upload.ts against GitHub with the
 *        uploader's token, then stored: one KV read, seven GitHub requests, one KV write.
 */

import { parseRepoRef } from '../../src/repo/ref';
import { callbackPage, finishLogin, startLogin, type OAuthConfig } from './core/oauth';
import { historyKey, parseManifest, verifyUpload } from './core/upload';
import {
  MAX_UPLOAD_BYTES,
  type HistoryError,
  type HistoryReply,
  type StoredManifest,
} from './shape';

export type Env = {
  HISTORY: KVNamespace;
  /** OAuth App client id (public) and secret. Without both, sign-in is off. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The callback URL registered on the OAuth App; defaults to this Worker's /v1/auth/callback. */
  OAUTH_CALLBACK_URL?: string;
  /** Comma-separated origins allowed besides localhost. */
  ALLOWED_ORIGINS?: string;
  /** Overrides https://api.github.com and https://github.com, for local runs against a fake. */
  GITHUB_API?: string;
  GITHUB_WEB?: string;
  /** Uploads one IP may send an hour, and the uploads (KV writes) taken a day. Per data center. */
  UPLOADS_PER_IP_HOUR?: string;
  UPLOADS_PER_DAY?: string;
  /** Requests a minute per IP, and uploads a minute per IP (Workers rate limiting). */
  LIMITER?: RateLimit;
  UPLOAD_LIMITER?: RateLimit;
};

const HISTORY_ROUTE = /^\/v1\/history\/([^/]+)\/([^/]+)\/?$/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/** Git's ref name rules, roughly: printable, no `..`, `//`, `@{`, leading or trailing `/`, or `.lock` end. */
const BRANCH = /^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$))[!-~]{1,255}$/;
const BRANCH_CHARS = /^[^~^:?*[\\]*$/;
/** GitHub token shapes (gho_, ghp_, github_pat_ and older hex tokens). Anything else is refused unseen. */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const MANIFEST_HEADER = 'X-History-Manifest';
const HISTORY_TTL_S = 90 * 24 * 60 * 60;
const ERROR_STATUS: Record<HistoryError, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  private: 403,
  'not-found': 404,
  exists: 409,
  stale: 409,
  'too-large': 413,
  mismatch: 422,
  'rate-limited': 429,
  upstream: 502,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/v1/auth/login') return login(url, env);
    if (url.pathname === '/v1/auth/callback') return callback(url, env);

    const origin = request.headers.get('Origin');
    const allowed = origin !== null && isAllowed(origin, env);
    const cors: Record<string, string> = allowed
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Expose-Headers': MANIFEST_HEADER,
          Vary: 'Origin',
        }
      : { Vary: 'Origin' };
    const send = (reply: HistoryReply, extra: Record<string, string> = {}) =>
      respond(reply, { ...cors, ...extra });

    if (origin !== null && !allowed) return send({ status: 'error', error: 'forbidden' });
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, PUT',
          'Access-Control-Allow-Headers': `Authorization, Content-Type, ${MANIFEST_HEADER}`,
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (url.pathname === '/health') return new Response('ok', { headers: cors });
    const match = HISTORY_ROUTE.exec(url.pathname);
    if (!match || (request.method !== 'GET' && request.method !== 'PUT')) {
      return new Response('not found', { status: 404, headers: cors });
    }

    const ref = parseRepoRef(`${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`);
    const branch = url.searchParams.get('branch');
    if ('kind' in ref || branch === null || !BRANCH.test(branch) || !BRANCH_CHARS.test(branch)) {
      return send({ status: 'error', error: 'invalid' });
    }
    const repo = `${ref.owner}/${ref.repo}`;
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) {
      return send({ status: 'error', error: 'rate-limited', retryAfter: 60 });
    }
    const key = historyKey(repo, branch);
    if (request.method === 'GET') {
      const { value, metadata } = await env.HISTORY.getWithMetadata<StoredManifest>(key, {
        type: 'stream',
      });
      if (!value || !metadata) {
        await value?.cancel();
        return send({ status: 'missing' });
      }
      return new Response(value, {
        headers: {
          ...cors,
          'Content-Type': 'application/gzip',
          [MANIFEST_HEADER]: JSON.stringify(metadata),
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
    return send(await upload(request, env, { repo, branch, key, ip, url }));
  },
} satisfies ExportedHandler<Env>;

/** PUT: the cheap checks, then GitHub's, then one KV write. */
async function upload(
  request: Request,
  env: Env,
  {
    repo,
    branch,
    key,
    ip,
    url,
  }: { repo: string; branch: string; key: string; ip: string; url: URL },
): Promise<HistoryReply> {
  const error = (e: HistoryError, retryAfter?: number): HistoryReply =>
    retryAfter ? { status: 'error', error: e, retryAfter } : { status: 'error', error: e };
  const auth = request.headers.get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!TOKEN.test(token)) return error('unauthorized');
  const length = Number(request.headers.get('Content-Length') ?? NaN);
  if (!Number.isInteger(length) || length <= 0) return error('invalid');
  if (length > MAX_UPLOAD_BYTES) return error('too-large');
  const manifest = parseManifest(request.headers.get(MANIFEST_HEADER), repo, branch);
  if (!manifest || manifest.bytes !== length) return error('invalid');

  if (env.UPLOAD_LIMITER && !(await env.UPLOAD_LIMITER.limit({ key: ip })).success) {
    return error('rate-limited', 60);
  }
  if (!(await countUp(`ip/${ip}`, 3600, Number(env.UPLOADS_PER_IP_HOUR ?? 6)))) {
    return error('rate-limited', 3600);
  }
  // Same head stored already: nothing to write. (The body is never read.)
  const held = await env.HISTORY.getWithMetadata<StoredManifest>(key, { type: 'stream' });
  await held.value?.cancel();
  if (held.metadata?.head === manifest.head) return error('exists');

  const verdict = await verifyUpload(manifest, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    api: env.GITHUB_API ?? 'https://api.github.com',
    token,
    now: Date.now,
  });
  if (!verdict.ok) return error(verdict.error, verdict.retryAfter);

  const body = await request.arrayBuffer();
  const bytes = new Uint8Array(body, 0, Math.min(2, body.byteLength));
  if (body.byteLength !== length || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return error('invalid');
  if (!(await countUp(`day/${url.host}`, 86_400, Number(env.UPLOADS_PER_DAY ?? 300)))) {
    return error('rate-limited', 3600);
  }
  await env.HISTORY.put(key, body, { metadata: verdict.manifest, expirationTtl: HISTORY_TTL_S });
  return { status: 'stored', manifest: verdict.manifest };
}

/**
 * Counts one more in a window in this data center's cache (no KV write), and says whether the
 * count is still within `limit`. Not exact: an abuse guard. Without a cache (tests), allows.
 */
async function countUp(name: string, windowS: number, limit: number): Promise<boolean> {
  if (typeof caches === 'undefined') return true;
  const window = Math.floor(Date.now() / (windowS * 1000));
  const req = new Request(`https://counter.invalid/${encodeURIComponent(name)}/${window}`);
  const cache = caches.default;
  const seen = Number((await (await cache.match(req))?.text()) ?? 0);
  if (seen >= limit) return false;
  await cache.put(
    req,
    new Response(String(seen + 1), { headers: { 'Cache-Control': `max-age=${windowS}` } }),
  );
  return true;
}

function oauth(url: URL, env: Env): OAuthConfig | null {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;
  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    callbackUrl: env.OAUTH_CALLBACK_URL ?? `${url.origin}/v1/auth/callback`,
    web: env.GITHUB_WEB ?? 'https://github.com',
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  };
}

/** /v1/auth/login?origin=<the app's origin>: off to GitHub with a signed state. */
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

function isAllowed(origin: string, env: Env): boolean {
  if (LOCAL.test(origin)) return true;
  const list = (env.ALLOWED_ORIGINS ?? 'https://jasonzhangggg.github.io').split(',');
  return list.some((o) => o.trim() === origin);
}

function respond(reply: HistoryReply, headers: Record<string, string>): Response {
  const status =
    reply.status === 'error' ? ERROR_STATUS[reply.error] : reply.status === 'stored' ? 201 : 404;
  const out: Record<string, string> = {
    ...headers,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const retry = 'retryAfter' in reply ? reply.retryAfter : undefined;
  if (retry) out['Retry-After'] = String(retry);
  return new Response(JSON.stringify(reply), { status, headers: out });
}
