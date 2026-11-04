/**
 * The history Worker, small enough for Cloudflare's free plan (10 ms of CPU and 50 subrequests a
 * request, 1,000 KV writes and 1 GB of KV a day). It computes nothing: visitors' browsers compute
 * a repo's history with their own GitHub token (src/core/engine.ts) and upload it here, and
 * everyone after them reads it from KV. Every write is counted first by one global Durable Object
 * (core/ledger.ts), which caps uploads per login and per day and the bytes stored.
 *
 *   GET  /v1/auth/login?origin=<app>   sign in with GitHub (popup), no KV
 *   GET  /v1/auth/callback             OAuth callback: posts the token to the opener
 *   GET  /v1/history/<owner>/<repo>?branch=<b>
 *        200 the gzipped History, its StoredManifest in X-History-Manifest; 404 {status:'missing'}
 *        One KV read; the body streams through untouched.
 *   PUT  /v1/history/<owner>/<repo>?branch=<b>   (signed in; body gzipped History JSON,
 *        X-History-Manifest an UploadManifest) checked by core/upload.ts against GitHub with the
 *        uploader's token, then stored: two ledger calls, eight GitHub requests, one KV write.
 *   POST /v1/history/<owner>/<repo>/bad?branch=<b>&head=<sha>   a reader could not use the stored
 *        body: the next good upload may replace it. One ledger call.
 *   POST /v1/git/<owner>/<repo>/git-upload-pack   (signed in; body a git protocol v2 fetch
 *        request) the snapshot trees in one pack (core/pack.ts). The request must want commits
 *        or trees at depth 1 with `filter blob:none` (checkFetchRequest); the repo must be
 *        public. Two GitHub API requests check the token and the repo, then github.com's answer
 *        streams back untouched, under the visitor's own token (git's limits are per user).
 */

import { parseRepoRef } from '../../src/repo/ref';
import {
  DEFAULT_LEDGER_LIMITS,
  ledger,
  parseLedgerRequest,
  type LedgerLimits,
  type LedgerReply,
  type LedgerRequest,
} from './core/ledger';
import { callbackPage, finishLogin, startLogin, type OAuthConfig } from './core/oauth';
import { UpstreamError, gitHub, isRecord } from './core/github';
import {
  MAX_REQUEST_BYTES,
  UPLOAD_PACK_REQUEST,
  UPLOAD_PACK_RESULT,
  checkFetchRequest,
} from './core/pack';
import { historyKey, parseManifest, verifyUpload } from './core/upload';
import {
  MAX_INFLATED_BYTES,
  MAX_UPLOAD_BYTES,
  type HistoryError,
  type HistoryReply,
} from './shape';

export type Env = {
  HISTORY: KVNamespace;
  /** The Ledger Durable Object: one global instance. */
  LEDGER: DurableObjectNamespace;
  /** OAuth App client id (public) and secret. Without both, sign-in is off. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The callback URL registered on the OAuth App; defaults to this Worker's /v1/auth/callback. */
  OAUTH_CALLBACK_URL?: string;
  /** Comma-separated origins allowed. */
  ALLOWED_ORIGINS?: string;
  /** "1" also allows any localhost origin: local runs and e2e only, never in production. */
  ALLOW_LOCALHOST?: string;
  /** Overrides https://api.github.com and https://github.com, for local runs against a fake. */
  GITHUB_API?: string;
  GITHUB_WEB?: string;
  /** Uploads (KV writes) one GitHub login may make a day, and all of them together (the ledger). */
  UPLOADS_PER_LOGIN?: string;
  UPLOADS_PER_DAY?: string;
  /** Bytes all stored histories may take together (the ledger). */
  STORED_BYTES?: string;
  /** KV writes and deletes a day (puts and evictions). */
  KV_WRITES_PER_DAY?: string;
  /** Requests a minute per IP, and uploads a minute per IP (Workers rate limiting). */
  LIMITER?: RateLimit;
  UPLOAD_LIMITER?: RateLimit;
  /** Pack fetches a minute, per IP and per GitHub login (keys `ip:` and `login:`). */
  PACK_LIMITER?: RateLimit;
};

const HISTORY_ROUTE = /^\/v1\/history\/([^/]+)\/([^/]+?)(\/bad)?\/?$/;
const GIT_ROUTE = /^\/v1\/git\/([^/]+)\/([^/]+?)\/git-upload-pack$/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/** Git's ref name rules, roughly: printable, no `..`, `//`, `@{`, leading or trailing `/`, or `.lock` end. */
const BRANCH = /^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$))[!-~]{1,255}$/;
const BRANCH_CHARS = /^[^~^:?*[\\]*$/;
/** GitHub token shapes (gho_, ghp_, github_pat_ and older hex tokens). Anything else is refused unseen. */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const MANIFEST_HEADER = 'X-History-Manifest';
const HISTORY_TTL_S = DEFAULT_LEDGER_LIMITS.ttlMs / 1000;
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
  'not-default-branch': 422,
  full: 507,
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
          'Access-Control-Allow-Methods': 'GET, PUT, POST',
          'Access-Control-Allow-Headers': `Authorization, Content-Type, ${MANIFEST_HEADER}`,
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    if (url.pathname === '/health') return new Response('ok', { headers: cors });
    const git = GIT_ROUTE.exec(url.pathname);
    if (git) {
      if (request.method !== 'POST')
        return new Response('not found', { status: 404, headers: cors });
      const ref = parseRepoRef(`${decodeURIComponent(git[1]!)}/${decodeURIComponent(git[2]!)}`);
      if ('kind' in ref) return send({ status: 'error', error: 'invalid' });
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) {
        return send({ status: 'error', error: 'rate-limited', retryAfter: 60 });
      }
      const out = await uploadPack(request, env, `${ref.owner}/${ref.repo}`, ip);
      return out instanceof Response ? withHeaders(out, cors) : send(out);
    }
    const match = HISTORY_ROUTE.exec(url.pathname);
    const bad = match?.[3] !== undefined;
    if (
      !match ||
      (bad ? request.method !== 'POST' : request.method !== 'GET' && request.method !== 'PUT')
    ) {
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
    if (bad) {
      const head = url.searchParams.get('head') ?? '';
      if (!/^[0-9a-f]{40}$/.test(head)) return send({ status: 'error', error: 'invalid' });
      await askLedger(env, { op: 'bad', key, head, now: Date.now() });
      return send({ status: 'noted' });
    }
    if (request.method === 'GET') {
      const { value, metadata } = await env.HISTORY.getWithMetadata(key, { type: 'stream' });
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
    return send(await upload(request, env, { repo, branch, key, ip }));
  },
} satisfies ExportedHandler<Env>;

/**
 * The ledger (core/ledger.ts) as a SQLite-backed Durable Object. One instance, named 'global',
 * takes every request: each runs alone, so a check and its count cannot interleave.
 */
export class Ledger {
  private readonly book: ReturnType<typeof ledger>;
  constructor(state: DurableObjectState, env: Env) {
    this.book = ledger(state.storage.sql, ledgerLimits(env));
  }
  async fetch(request: Request): Promise<Response> {
    const op = parseLedgerRequest(await request.json().catch(() => null));
    if (!op) return new Response('bad request', { status: 400 });
    return Response.json(this.book.run(op));
  }
}

export function ledgerLimits(env: Env): LedgerLimits {
  const n = (value: string | undefined, fallback: number) =>
    value && Number(value) > 0 ? Number(value) : fallback;
  return {
    ...DEFAULT_LEDGER_LIMITS,
    perLogin: n(env.UPLOADS_PER_LOGIN, DEFAULT_LEDGER_LIMITS.perLogin),
    perDay: n(env.UPLOADS_PER_DAY, DEFAULT_LEDGER_LIMITS.perDay),
    maxBytes: n(env.STORED_BYTES, DEFAULT_LEDGER_LIMITS.maxBytes),
    writesPerDay: n(env.KV_WRITES_PER_DAY, DEFAULT_LEDGER_LIMITS.writesPerDay),
  };
}

/** One request to the global ledger. */
async function askLedger(env: Env, op: LedgerRequest): Promise<LedgerReply> {
  const stub = env.LEDGER.get(env.LEDGER.idFromName('global'));
  const res = await stub.fetch('https://ledger/', { method: 'POST', body: JSON.stringify(op) });
  return (await res.json()) as LedgerReply;
}

/** PUT: the cheap checks, the ledger, GitHub's checks, the ledger again, then one KV write. */
async function upload(
  request: Request,
  env: Env,
  { repo, branch, key, ip }: { repo: string; branch: string; key: string; ip: string },
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
  // Same head stored and good, or the day's writes taken: refuse before asking GitHub anything.
  const checked = await askLedger(env, {
    op: 'check',
    key,
    head: manifest.head,
    now: Date.now(),
  });
  if (!checked.ok) return error(checked.error, checked.retryAfter);

  const verdict = await verifyUpload(manifest, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    api: env.GITHUB_API ?? 'https://api.github.com',
    token,
    now: Date.now,
  });
  if (!verdict.ok) return error(verdict.error, verdict.retryAfter);

  const body = await request.arrayBuffer();
  if (body.byteLength !== length) return error('invalid');
  const inflated = gzipSize(body);
  if (inflated === null) return error('invalid');
  if (inflated > MAX_INFLATED_BYTES) return error('too-large');

  const reserved = await askLedger(env, {
    op: 'reserve',
    key,
    head: manifest.head,
    bytes: length,
    login: verdict.manifest.by,
    now: Date.now(),
  });
  if (!reserved.ok) return error(reserved.error, reserved.retryAfter);
  // Room was made by evicting the oldest histories (the ledger already forgot them). A delete
  // that fails leaves a body KV drops at its TTL, so the put goes ahead either way.
  await Promise.all(
    (reserved.evict ?? []).map((k) => env.HISTORY.delete(k).catch(() => undefined)),
  );
  try {
    await env.HISTORY.put(key, body, {
      metadata: verdict.manifest,
      expirationTtl: HISTORY_TTL_S,
    });
  } catch {
    await askLedger(env, { op: 'release', key, head: manifest.head, now: Date.now() });
    return error('upstream');
  }
  return { status: 'stored', manifest: verdict.manifest };
}

/**
 * POST /v1/git/<repo>/git-upload-pack: checks, then github.com's answer as a stream, or the
 * reason it was refused. The Worker never reads the answer: its CPU is the checks (well under a
 * millisecond, scripts/worker-cpu.mjs) however big the pack.
 */
async function uploadPack(
  request: Request,
  env: Env,
  repo: string,
  ip: string,
): Promise<Response | HistoryReply> {
  const error = (e: HistoryError, retryAfter?: number): HistoryReply =>
    retryAfter ? { status: 'error', error: e, retryAfter } : { status: 'error', error: e };
  const auth = request.headers.get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!TOKEN.test(token)) return error('unauthorized');
  if (request.headers.get('Content-Type') !== UPLOAD_PACK_REQUEST) return error('invalid');
  const length = Number(request.headers.get('Content-Length') ?? NaN);
  if (Number.isInteger(length) && length > MAX_REQUEST_BYTES) return error('too-large');
  if (env.PACK_LIMITER && !(await env.PACK_LIMITER.limit({ key: `ip:${ip}` })).success) {
    return error('rate-limited', 60);
  }
  const body = await readCapped(request, MAX_REQUEST_BYTES);
  if (!body) return error('too-large');
  if (!checkFetchRequest(body).ok) return error('invalid');

  const gh = gitHub({
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    api: env.GITHUB_API ?? 'https://api.github.com',
    token,
    limit: 2,
  });
  let login: string;
  try {
    const [{ body: user }, { body: meta }] = await Promise.all([
      gh.json('/user'),
      gh.json(`/repos/${repo}`),
    ]);
    if (!isRecord(user) || typeof user.login !== 'string') return error('unauthorized');
    if (!isRecord(meta)) return error('upstream');
    if (meta.private !== false) return error('private');
    login = user.login.toLowerCase();
  } catch (e) {
    if (!(e instanceof UpstreamError)) return error('upstream');
    if (e.kind === 'rate-limited') {
      return error('rate-limited', Math.max(1, Math.ceil((e.resetAt - Date.now()) / 1000)));
    }
    return error(e.kind === 'not-found' || e.kind === 'empty' ? 'not-found' : e.kind);
  }
  if (env.PACK_LIMITER && !(await env.PACK_LIMITER.limit({ key: `login:${login}` })).success) {
    return error('rate-limited', 60);
  }

  const upstream = await fetch(
    `${env.GITHUB_WEB ?? 'https://github.com'}/${repo}.git/git-upload-pack`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
        'Content-Type': UPLOAD_PACK_REQUEST,
        Accept: UPLOAD_PACK_RESULT,
        'Git-Protocol': 'version=2',
        'User-Agent': 'git/repo-tree',
      },
      body,
    },
  ).catch(() => null);
  if (!upstream) return error('upstream');
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    if (upstream.status === 401 || upstream.status === 403) return error('unauthorized');
    if (upstream.status === 404) return error('not-found');
    if (upstream.status === 429) return error('rate-limited', 60);
    return error('upstream');
  }
  return new Response(upstream.body, {
    headers: { 'Content-Type': UPLOAD_PACK_RESULT, 'Cache-Control': 'no-store' },
  });
}

/** The request body, or null past `max` bytes (read no further than that). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A response with these headers added (CORS). */
function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

/**
 * The unpacked size a gzip body declares in its last four bytes (ISIZE, little-endian), or null
 * when it does not start like gzip. A liar can understate it; readers stop unpacking at
 * MAX_INFLATED_BYTES anyway. This turns away an honest bomb without unpacking a byte.
 */
export function gzipSize(body: ArrayBuffer): number | null {
  if (body.byteLength < 18) return null;
  const view = new DataView(body);
  if (view.getUint8(0) !== 0x1f || view.getUint8(1) !== 0x8b) return null;
  return view.getUint32(body.byteLength - 4, true);
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
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

function isAllowed(origin: string, env: Env): boolean {
  if (env.ALLOW_LOCALHOST === '1' && LOCAL.test(origin)) return true;
  const list = (env.ALLOWED_ORIGINS ?? 'https://jasonzhangggg.github.io').split(',');
  return list.some((o) => o.trim() === origin);
}

function respond(reply: HistoryReply, headers: Record<string, string>): Response {
  const status =
    reply.status === 'error'
      ? ERROR_STATUS[reply.error]
      : reply.status === 'stored'
        ? 201
        : reply.status === 'noted'
          ? 202
          : 404;
  const out: Record<string, string> = {
    ...headers,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const retry = 'retryAfter' in reply ? reply.retryAfter : undefined;
  if (retry) out['Retry-After'] = String(retry);
  return new Response(JSON.stringify(reply), { status, headers: out });
}
