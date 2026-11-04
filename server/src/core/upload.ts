/**
 * Checking a history a visitor's browser computed, before it is shared with everyone.
 *
 * The Worker gets 10 ms of CPU a request, too little to unpack and read a big history (Linux:
 * 0.86 MB gzipped, 8 MB of JSON, about 60 ms to unpack and parse; scripts/worker-cpu.mjs).
 * So it never opens the body. It checks the small manifest sent
 * with it against GitHub, with the uploader's own token:
 *
 * - the snapshots follow the engine's schedule (no request): oldest first, the head last, at most
 *   one per target time of `schedule(head, root)`, each at or before its target;
 * - the token is good (GET /user, whose login is recorded with the upload);
 * - the repo is public, and the branch is its default branch (GET /repos/<repo>);
 * - the claimed head is the branch's head now (GET /repos/<repo>/commits/<branch>);
 * - the head, the oldest snapshot (which must be a root commit, with no parents) and SPOT_CHECKS
 *   others, picked at random here, have the claimed root tree and commit time
 *   (GET /repos/<repo>/git/commits/<sha> each).
 *
 * Nothing here can put a floor under the number of snapshots: a repo with three commits has
 * three, whatever its age, and telling that from a sparse claim would take listing the commits.
 * The ledger's caps (ledger.ts) bound what a plausible but thin upload can cost.
 *
 * It stores the body as sent, with a StoredManifest that names the head and a digest of every
 * snapshot's sha and time. A reader unpacks the body anyway, and drops it unless it agrees with
 * that manifest (src/repo/history.ts), so a body cannot claim other snapshots than the ones
 * checked here. What it says about each path (dates, churn, authors) is the uploader's word.
 */

import {
  HISTORY_VERSION,
  MAX_UPLOAD_BYTES,
  snapshotDigest,
  type HistoryError,
  type StoredManifest,
  type UploadManifest,
} from '../shape';
import { DEFAULT_LIMITS, schedule } from './commits';
import { UpstreamError, gitHub, isRecord, type GitHub } from './github';

/** Snapshots besides the head and the root checked against GitHub per upload. */
export const SPOT_CHECKS = 3;
/** The engine takes at most this many, the head and the root included. */
const MAX_SNAPSHOTS = DEFAULT_LIMITS.maxSnapshots;
const SHA = /^[0-9a-f]{40}$/;

export type Verdict =
  { ok: true; manifest: StoredManifest } | { ok: false; error: HistoryError; retryAfter?: number };

/** The KV key of a branch's history (owner/repo lower-cased: GitHub ignores case there). */
export const historyKey = (repo: string, branch: string) => `h1:${repo.toLowerCase()}@${branch}`;

/** The manifest from its header, if it is well formed and names this repo and branch. */
export function parseManifest(
  raw: string | null,
  repo: string,
  branch: string,
): UploadManifest | null {
  if (!raw || raw.length > 32 * 1024) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(m) || m.v !== HISTORY_VERSION) return null;
  const { snapshots } = m;
  if (
    typeof m.repo !== 'string' ||
    m.repo.toLowerCase() !== repo.toLowerCase() ||
    m.branch !== branch ||
    typeof m.head !== 'string' ||
    !SHA.test(m.head) ||
    typeof m.computedAt !== 'number' ||
    typeof m.bytes !== 'number' ||
    !Number.isInteger(m.bytes) ||
    m.bytes <= 0 ||
    m.bytes > MAX_UPLOAD_BYTES ||
    !Array.isArray(snapshots) ||
    snapshots.length < 1 ||
    snapshots.length > MAX_SNAPSHOTS
  ) {
    return null;
  }
  let previous = -Infinity;
  for (const s of snapshots as unknown[]) {
    if (
      !isRecord(s) ||
      typeof s.sha !== 'string' ||
      !SHA.test(s.sha) ||
      typeof s.tree !== 'string' ||
      !SHA.test(s.tree) ||
      typeof s.at !== 'number' ||
      !Number.isFinite(s.at) ||
      s.at < previous
    ) {
      return null;
    }
    previous = s.at;
  }
  const list = snapshots as UploadManifest['snapshots'];
  if (list[list.length - 1]!.sha !== m.head) return null;
  if (new Set(list.map((s) => s.sha)).size !== list.length) return null;
  if (!followsSchedule(list)) return null;
  return m as UploadManifest;
}

/**
 * Whether snapshots (oldest first, the head last) could be the engine's picks: walking the
 * schedule's targets from the newest, each snapshot below the head is the pick of a later target
 * than the one before it, at or before that target. The oldest may instead be the root, which
 * the engine adds after the targets (GitHub then confirms it has no parents).
 */
export function followsSchedule(list: readonly { at: number }[]): boolean {
  if (list.length === 1) return true;
  const head = list[list.length - 1]!;
  const root = list[0]!;
  const targets = schedule(head.at, root.at, MAX_SNAPSHOTS);
  let k = 0;
  for (let i = list.length - 2; i >= 1; i--) {
    const at = list[i]!.at;
    while (k < targets.length && targets[k]! < at) k++;
    if (k === targets.length) return false;
    k++;
  }
  return true;
}

export type VerifyDeps = {
  fetch: typeof fetch;
  api: string;
  token: string;
  now: () => number;
  /** Picks `n` distinct indices below `count`; random by default. */
  pick?: (count: number, n: number) => number[];
};

/**
 * Checks a parsed manifest against GitHub with the uploader's token: 3 requests, then one per
 * checked snapshot (the head, the root and SPOT_CHECKS others): 8 at most.
 */
export async function verifyUpload(m: UploadManifest, deps: VerifyDeps): Promise<Verdict> {
  const gh = gitHub({ fetch: deps.fetch, api: deps.api, token: deps.token, limit: 8 });
  try {
    const { body: user } = await gh.json('/user');
    if (!isRecord(user) || typeof user.login !== 'string') return fail('unauthorized');
    const { body: repo } = await gh.json(`/repos/${m.repo}`);
    if (!isRecord(repo)) return fail('upstream');
    if (repo.private !== false) return fail('private');
    if (repo.default_branch !== m.branch) return fail('not-default-branch');
    const ref = m.branch.split('/').map(encodeURIComponent).join('/');
    const head = (
      await gh.text(`/repos/${m.repo}/commits/${ref}`, 'application/vnd.github.sha')
    ).trim();
    if (head !== m.head) return fail('stale');
    const last = m.snapshots.length - 1;
    // Between the root (0) and the head (last): indices 1 to last - 1.
    const middle = Math.max(0, last - 1);
    const others = (deps.pick ?? pickRandom)(middle, Math.min(SPOT_CHECKS, middle)).map(
      (i) => i + 1,
    );
    for (const i of new Set([last, 0, ...others])) {
      const parents = await sameCommit(gh, m.repo, m.snapshots[i]!);
      if (parents === null || (i === 0 && parents > 0)) return fail('mismatch');
    }
    return {
      ok: true,
      manifest: {
        v: HISTORY_VERSION,
        repo: m.repo,
        branch: m.branch,
        head: m.head,
        computedAt: m.computedAt,
        snapshots: m.snapshots.length,
        digest: await snapshotDigest(m.snapshots),
        bytes: m.bytes,
        by: user.login,
        storedAt: deps.now(),
      },
    };
  } catch (error) {
    if (!(error instanceof UpstreamError)) return fail('upstream');
    switch (error.kind) {
      case 'unauthorized':
        return fail('unauthorized');
      case 'not-found':
      case 'empty':
        // A snapshot GitHub does not know is a false claim; a repo it does not know, not found.
        return fail('not-found');
      case 'rate-limited':
        return {
          ok: false,
          error: 'rate-limited',
          retryAfter: Math.max(1, Math.ceil((error.resetAt - deps.now()) / 1000)),
        };
      case 'upstream':
        return fail('upstream');
    }
  }
}

/**
 * The number of parents of GitHub's commit `sha` when it has the claimed root tree and committer
 * time; null when it does not, or GitHub does not know it.
 */
async function sameCommit(
  gh: GitHub,
  repo: string,
  claim: { sha: string; at: number; tree: string },
): Promise<number | null> {
  let body: unknown;
  try {
    body = (await gh.json(`/repos/${repo}/git/commits/${claim.sha}`)).body;
  } catch (error) {
    if (error instanceof UpstreamError && error.kind === 'not-found') return null;
    throw error;
  }
  if (!isRecord(body) || !isRecord(body.tree) || !isRecord(body.committer)) return null;
  const at = typeof body.committer.date === 'string' ? Date.parse(body.committer.date) : NaN;
  if (body.tree.sha !== claim.tree || at !== claim.at) return null;
  return Array.isArray(body.parents) ? body.parents.length : null;
}

function pickRandom(count: number, n: number): number[] {
  const picked = new Set<number>();
  const draw = new Uint32Array(1);
  while (picked.size < n) {
    crypto.getRandomValues(draw);
    picked.add(draw[0]! % count);
  }
  return [...picked];
}

const fail = (error: HistoryError): Verdict => ({ ok: false, error });
