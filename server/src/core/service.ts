/**
 * The host-agnostic request flow: head lookup, cache, stale-while-revalidate and job steps.
 * A host adapter supplies a Store and fetch, routes the request and sends the reply.
 *
 * Keys (owner/repo lower-cased, branch '' for the default branch):
 *   ref:<repo>@<branch>            Pointer: the head last seen, when, and the newest ready head
 *   hist:<repo>@<branch>:<sha>     History for that head
 *   job:<repo>@<branch>:<sha>      Job in progress for that head
 *   github:resetAt                 Set while GitHub's hourly budget is spent: work waits for it
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
  token?: string;
  now: () => number;
  limits?: Partial<Limits>;
  /** Start no new job while GitHub reports fewer requests left than this. */
  reserve?: number;
  /**
   * Asked once before a job starts for a repo with no history in the cache. False turns the
   * request away (the host's per-client fairness cap). Cached repos never ask.
   */
  mayStart?: (repo: string) => Promise<boolean>;
};

export type Query = { owner: string; repo: string; branch?: string };

/** A reply, plus work the host should finish after sending it (Workers: ctx.waitUntil). */
export type Served = { reply: HistoryReply; after?: Promise<void> };

type Pointer =
  | { missing: true; checkedAt: number }
  | {
      missing?: false;
      repo: string;
      branch: string;
      head: string;
      checkedAt: number;
      ready: string | null;
    };

/** How long a head lookup is trusted before the next request checks GitHub again. */
export const HEAD_TTL_S = 6 * 60 * 60;
const MISSING_TTL_S = 10 * 60;
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
  const gh = () =>
    gitHub({ fetch: deps.fetch, api: deps.api, token: deps.token, limit: limits.stepRequests });

  const pointer = await deps.store.get<Pointer>(pointerKey);
  const fresh =
    pointer !== null &&
    now - pointer.checkedAt < (pointer.missing ? MISSING_TTL_S : HEAD_TTL_S) * 1000;
  if (pointer?.missing && fresh) return { reply: { status: 'error', error: 'not-found' } };

  if (pointer && !pointer.missing) {
    const ready = pointer.ready
      ? await deps.store.get<History>(histKey(base, pointer.branch, pointer.ready))
      : null;
    if (fresh && ready && pointer.ready === pointer.head)
      return { reply: { status: 'ready', history: ready, stale: false } };
    if (ready) {
      const after = (async () => {
        if ((await spentFor(deps.store, now)) > 0) return;
        const client = gh();
        const current = fresh
          ? pointer
          : await lookUp(query, base, pointerKey, pointer, client, deps, now);
        if (current && !current.missing && current.head !== current.ready) {
          await advance(base, current, pointerKey, client, deps, limits, now);
        }
      })().catch(() => undefined);
      return { reply: { status: 'ready', history: ready, stale: true }, after };
    }
  }

  const waitS = await spentFor(deps.store, now);
  if (waitS > 0) return { reply: { status: 'pending', progress: 0, retryAfter: waitS } };
  const client = gh();
  let current: Pointer;
  try {
    current =
      pointer && !pointer.missing && fresh
        ? pointer
        : await lookUp(query, base, pointerKey, pointer, client, deps, now);
  } catch (error) {
    return { reply: await errorReply(error, deps.store, now) };
  }
  if (current.missing) return { reply: { status: 'error', error: 'not-found' } };
  return { reply: await advance(base, current, pointerKey, client, deps, limits, now) };
}

const BUDGET_KEY = 'github:resetAt';

/** Seconds until GitHub's budget resets, or 0 when it is not known to be spent. */
async function spentFor(store: Store, now: number): Promise<number> {
  const resetAt = await store.get<number>(BUDGET_KEY);
  return resetAt && resetAt > now ? retryAt(resetAt, now) : 0;
}

const histKey = (base: string, branch: string, sha: string) => `hist:${base}@${branch}:${sha}`;
const jobKey = (base: string, branch: string, sha: string) => `job:${base}@${branch}:${sha}`;

/** Resolves the branch and its head commit, and records them. Two requests for the default branch, else one. */
async function lookUp(
  query: Query,
  base: string,
  pointerKey: string,
  previous: Pointer | null,
  gh: GitHub,
  deps: Deps,
  now: number,
): Promise<Pointer> {
  try {
    let repo = `${query.owner}/${query.repo}`;
    let branch = query.branch;
    if (branch === undefined) {
      const { body } = await gh.json(`/repos/${repo}`);
      if (!isRecord(body) || typeof body.default_branch !== 'string')
        throw new UpstreamError('upstream');
      branch = body.default_branch;
      if (typeof body.full_name === 'string') repo = body.full_name;
    }
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    const head = (
      await gh.text(`/repos/${repo}/commits/${ref}`, 'application/vnd.github.sha')
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new UpstreamError('upstream');
    const ready = previous && !previous.missing ? previous.ready : null;
    const pointer: Pointer = { repo, branch, head, checkedAt: now, ready };
    await deps.store.put(pointerKey, pointer, POINTER_TTL_S);
    return pointer;
  } catch (error) {
    if (error instanceof UpstreamError && error.kind === 'not-found') {
      const missing: Pointer = { missing: true, checkedAt: now };
      await deps.store.put(pointerKey, missing, MISSING_TTL_S);
      return missing;
    }
    throw error;
  }
}

/** Runs one step of the head's job, or reads its finished history. */
async function advance(
  base: string,
  pointer: Extract<Pointer, { repo: string }>,
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
    const transient = !(error instanceof UpstreamError) || error.kind === 'upstream';
    if (transient) job.failures++;
    await deps.store.put(key, job, JOB_TTL_S);
    const reply = await errorReply(error, deps.store, now);
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

/** A spent GitHub budget is a wait, not a failure: the job resumes once it resets. */
async function errorReply(error: unknown, store: Store, now: number): Promise<HistoryReply> {
  if (!(error instanceof UpstreamError))
    return { status: 'error', error: 'upstream', retryAfter: 30 };
  switch (error.kind) {
    case 'not-found':
      return { status: 'error', error: 'not-found' };
    case 'empty':
      return { status: 'error', error: 'empty' };
    case 'rate-limited': {
      const resetAt = Math.max(error.resetAt, now + 60_000);
      await store.put(BUDGET_KEY, resetAt, Math.ceil((resetAt - now) / 1000));
      return { status: 'pending', progress: 0, retryAfter: retryAt(resetAt, now) };
    }
    case 'upstream':
      return { status: 'error', error: 'upstream', retryAfter: 30 };
  }
}

const retryAt = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));
const round = (n: number) => Math.round(n * 1000) / 1000;
