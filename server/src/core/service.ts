/**
 * The host-agnostic request flow: head lookup, cache, stale-while-revalidate and job steps.
 * A host adapter supplies a Store and fetch, routes the request and sends the reply.
 *
 * GitHub work runs on the caller's token (a signed-in visitor's, or the host's own for prewarm).
 * The token is used for this call only and never stored. Without one, only cached history is
 * served. Everything stored is computed from public data, so it is shared with every visitor;
 * private repos are never stored.
 *
 * Keys (owner/repo lower-cased, branch '' for the default branch):
 *   ref:<repo>@<branch>            Pointer: the head last seen, when, and the newest ready head
 *   hist:<repo>@<branch>:<sha>     History for that head
 *   job:<repo>@<branch>:<sha>      Job in progress for that head
 */

import type { History, HistoryReply } from '../shape';
import { gitHub, UpstreamError, isRecord, type GitHub } from './github';
import { createJob, progress, step, DEFAULT_LIMITS, type Job, type Limits } from './job';
import { summarize } from './summarize';

export type Store = {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
};

export type Deps = {
  store: Store;
  fetch: typeof fetch;
  api: string;
  /** The caller's GitHub token. Without it nothing new is computed. */
  token?: string;
  now: () => number;
  limits?: Partial<Limits>;
  /** Start no new job while the token has fewer GitHub requests left than this. */
  reserve?: number;
  /**
   * Asked once before a job starts for a repo with no history in the cache. False turns the
   * request away (the host's per-client cap). Cached repos never ask.
   */
  mayStart?: (repo: string) => Promise<boolean>;
};

export type Query = { owner: string; repo: string; branch?: string };

/** A reply, plus work the host should finish after sending it (Workers: ctx.waitUntil). */
export type Served = { reply: HistoryReply; after?: Promise<void> };

type Pointer = {
  repo: string;
  branch: string;
  head: string;
  checkedAt: number;
  ready: string | null;
};

/** How long a head lookup is trusted before a signed-in request checks GitHub again. */
export const HEAD_TTL_S = 6 * 60 * 60;
const HISTORY_TTL_S = 30 * 24 * 60 * 60;
const POINTER_TTL_S = 30 * 24 * 60 * 60;
const JOB_TTL_S = 24 * 60 * 60;
/** A job that failed this many steps in a row gives up until it expires. */
const MAX_FAILURES = 5;
const RETRY_S = 2;

export async function serveHistory(query: Query, deps: Deps): Promise<Served> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const base = `${query.owner}/${query.repo}`.toLowerCase();
  const pointerKey = `ref:${base}@${query.branch ?? ''}`;
  const now = deps.now();
  const { token } = deps;
  const gh = (t: string) =>
    gitHub({ fetch: deps.fetch, api: deps.api, token: t, limit: limits.stepRequests });

  const pointer = await deps.store.get<Pointer>(pointerKey);
  const fresh = pointer !== null && now - pointer.checkedAt < HEAD_TTL_S * 1000;
  const ready = pointer?.ready
    ? await deps.store.get<History>(histKey(base, pointer.branch, pointer.ready))
    : null;

  if (pointer && ready) {
    const current = pointer.ready === pointer.head;
    if (current && (fresh || !token)) {
      return { reply: { status: 'ready', history: ready, stale: false } };
    }
    if (!token) return { reply: { status: 'ready', history: ready, stale: true } };
    const after = (async () => {
      const client = gh(token);
      const latest = fresh ? pointer : await lookUp(query, pointerKey, pointer, client, deps, now);
      if (latest && latest.head !== latest.ready) {
        await advance(base, latest, pointerKey, client, deps, limits, now);
      }
    })().catch(() => undefined);
    return { reply: { status: 'ready', history: ready, stale: true }, after };
  }

  if (!token) return { reply: { status: 'needs-auth' } };
  const client = gh(token);
  try {
    const current =
      pointer && fresh ? pointer : await lookUp(query, pointerKey, pointer, client, deps, now);
    if (!current) return { reply: { status: 'error', error: 'private' } };
    return { reply: await advance(base, current, pointerKey, client, deps, limits, now) };
  } catch (error) {
    return { reply: errorReply(error, now) };
  }
}

const histKey = (base: string, branch: string, sha: string) => `hist:${base}@${branch}:${sha}`;
const jobKey = (base: string, branch: string, sha: string) => `job:${base}@${branch}:${sha}`;

/**
 * Resolves the branch and its head commit and records them: two requests. Null for a private
 * repo, which is never recorded. The first request also proves the token (a 401 throws).
 */
async function lookUp(
  query: Query,
  pointerKey: string,
  previous: Pointer | null,
  gh: GitHub,
  deps: Deps,
  now: number,
): Promise<Pointer | null> {
  const { body } = await gh.json(`/repos/${query.owner}/${query.repo}`);
  if (!isRecord(body) || typeof body.default_branch !== 'string') {
    throw new UpstreamError('upstream');
  }
  if (body.private !== false) return null;
  const repo = typeof body.full_name === 'string' ? body.full_name : `${query.owner}/${query.repo}`;
  const branch = query.branch ?? body.default_branch;
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  const head = (
    await gh.text(`/repos/${repo}/commits/${ref}`, 'application/vnd.github.sha')
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new UpstreamError('upstream');
  const pointer: Pointer = { repo, branch, head, checkedAt: now, ready: previous?.ready ?? null };
  await deps.store.put(pointerKey, pointer, POINTER_TTL_S);
  return pointer;
}

/** Runs one step of the head's job, or reads its finished history. */
async function advance(
  base: string,
  pointer: Pointer,
  pointerKey: string,
  gh: GitHub,
  deps: Deps,
  limits: Limits,
  now: number,
): Promise<HistoryReply> {
  const done = await deps.store.get<History>(histKey(base, pointer.branch, pointer.head));
  if (done) {
    await deps.store.put(pointerKey, { ...pointer, ready: pointer.head }, POINTER_TTL_S);
    return { status: 'ready', history: done, stale: false };
  }
  const key = jobKey(base, pointer.branch, pointer.head);
  let job = await deps.store.get<Job>(key);
  if (!job) {
    if (gh.remaining !== null && gh.remaining < (deps.reserve ?? 0)) {
      return { status: 'pending', progress: 0, retryAfter: retryAt(gh.resetAt, now) };
    }
    if (!pointer.ready && deps.mayStart && !(await deps.mayStart(base))) {
      return { status: 'error', error: 'busy', retryAfter: 60 * 60 };
    }
    job = createJob(pointer.repo, pointer.branch, pointer.head);
  }
  if (job.failures >= MAX_FAILURES) return { status: 'error', error: 'upstream' };
  try {
    await step(job, gh, limits);
    job.failures = 0;
  } catch (error) {
    const kind = error instanceof UpstreamError ? error.kind : 'upstream';
    if (kind === 'upstream' || kind === 'rate-limited') {
      if (kind === 'upstream') job.failures++;
      await deps.store.put(key, job, JOB_TTL_S);
    }
    const reply = errorReply(error, now);
    return reply.status === 'pending' ? { ...reply, progress: round(progress(job)) } : reply;
  }
  if (job.phase === 'done') {
    const history = summarize(job, now);
    await deps.store.put(histKey(base, pointer.branch, pointer.head), history, HISTORY_TTL_S);
    await deps.store.put(pointerKey, { ...pointer, ready: pointer.head }, POINTER_TTL_S);
    return { status: 'ready', history, stale: false };
  }
  await deps.store.put(key, job, JOB_TTL_S);
  return { status: 'pending', progress: round(progress(job)), retryAfter: RETRY_S };
}

/** A spent GitHub budget is a wait, not a failure: the job resumes once the token's budget resets. */
function errorReply(error: unknown, now: number): HistoryReply {
  if (!(error instanceof UpstreamError)) {
    return { status: 'error', error: 'upstream', retryAfter: 30 };
  }
  switch (error.kind) {
    case 'not-found':
      return { status: 'error', error: 'not-found' };
    case 'empty':
      return { status: 'error', error: 'empty' };
    case 'unauthorized':
      return { status: 'error', error: 'unauthorized' };
    case 'rate-limited':
      return { status: 'pending', progress: 0, retryAfter: retryAt(error.resetAt, now) };
    case 'upstream':
      return { status: 'error', error: 'upstream', retryAfter: 30 };
  }
}

const retryAt = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));
const round = (n: number) => Math.round(n * 1000) / 1000;
