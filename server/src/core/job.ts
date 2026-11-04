/**
 * The history job: a resumable state machine that each request advances by one bounded step.
 * The job is plain JSON, so any host can keep it between requests (KV, a file, memory).
 *
 * start    the newest 100 commits (head time and tree, the recent list) and the root commit
 * probe    one commit per target time (weekly, then monthly, then yearly), via /commits?until=
 * trees    each snapshot's recursive tree, newest first, folded into a per-path accumulator
 * recent   /commits/{sha} for the newest non-merge commits: exact dates, counts and authors
 * owners   the CODEOWNERS blob, when the head tree has one
 */

import type { Gap } from '../shape';
import { CODEOWNERS_PATHS, parseCodeowners, type OwnerRule } from './codeowners';
import {
  OutOfRequests,
  UpstreamError,
  isRecord,
  lastPage,
  toChanges,
  toCommits,
  toTree,
  type CommitSummary,
  type GitHub,
  type TreeEntry,
} from './github';

export type Limits = {
  /** GitHub requests one step may make (a free Worker allows 50 subrequests in all). */
  stepRequests: number;
  /** Tree entries one step may fold in, a stand-in for CPU time. */
  stepEntries: number;
  /** Newest non-merge commits read one by one. 0 turns the refinement off. */
  recentCommits: number;
  /** Extra requests a job may spend re-reading truncated trees folder by folder. */
  splitRequests: number;
  /** Snapshots compared, the head and the root included. */
  maxSnapshots: number;
};

export const DEFAULT_LIMITS: Limits = {
  stepRequests: 40,
  stepEntries: 250_000,
  recentCommits: 100,
  splitRequests: 150,
  maxSnapshots: 80,
};

const DAY = 24 * 60 * 60 * 1000;
const PER_PAGE = 100;

export type Sample = { sha: string; at: number; tree: string };
type Listed = Pick<CommitSummary, 'sha' | 'at' | 'tree' | 'author'>;
type Counts = Record<string, number>;

/**
 * Per path, over the snapshots folded so far (j counts snapshots from the head, 0, to older):
 * [newest j of its newest unbroken run, oldest j of that run, oldest j still holding the newest
 * version, intervals in which its sha changed, sha at the oldest j, 1 for a folder].
 */
export type AccRow = [number, number, number, number, string, 0 | 1];
/** Per path touched by the recent commits: [last at, commits, newest add at, newest removal at]. */
export type TouchRow = [number, number, number, number];

export type Phase = 'start' | 'probe' | 'trees' | 'recent' | 'owners' | 'done';

export type Job = {
  v: 1;
  repo: string;
  branch: string;
  head: Sample;
  phase: Phase;
  gaps: Gap[];
  root: Sample | null;
  /** Target times still to probe, newest first. */
  targets: number[];
  targetCount: number;
  /** Newest first; samples[0] is the head. */
  samples: Sample[];
  /** The latest /commits page, kept so later targets inside it cost no request. */
  listing: Listed[];
  listingComplete: boolean;
  /** between[j]: authors of the listed commits after samples[j + 1] up to samples[j]. */
  between: Counts[];
  /** Snapshots folded, by j, newest first. */
  applied: number[];
  next: number;
  /** Top-level folder tree shas (and '' for the root files) at the last folded snapshot. */
  prevTop: Record<string, string>;
  splitUsed: number;
  acc: Record<string, AccRow>;
  /** Per top-level folder, authors of commits in intervals where it changed. */
  weights: Record<string, Counts>;
  recent: Listed[];
  /** The recent list holds every commit back to the root. */
  recentIsAll: boolean;
  recentNext: number;
  touched: Record<string, TouchRow>;
  /** Per top-level folder, authors of recent commits that touched it. */
  commitsBy: Record<string, Counts>;
  codeownersSha: string | null;
  codeowners: OwnerRule[];
  failures: number;
};

export function createJob(repo: string, branch: string, headSha: string): Job {
  return {
    v: 1,
    repo,
    branch,
    head: { sha: headSha, at: 0, tree: '' },
    phase: 'start',
    gaps: [],
    root: null,
    targets: [],
    targetCount: 0,
    samples: [],
    listing: [],
    listingComplete: false,
    between: [],
    applied: [],
    next: 0,
    prevTop: {},
    splitUsed: 0,
    acc: {},
    weights: {},
    recent: [],
    recentIsAll: false,
    recentNext: 0,
    touched: {},
    commitsBy: {},
    codeownersSha: null,
    codeowners: [],
    failures: 0,
  };
}

/** 0 to 1, for the pending reply. */
export function progress(job: Job): number {
  const part = (done: number, total: number) => (total > 0 ? Math.min(1, done / total) : 1);
  switch (job.phase) {
    case 'start':
      return 0;
    case 'probe':
      return 0.02 + 0.13 * part(job.targetCount - job.targets.length, job.targetCount);
    case 'trees':
      return 0.15 + 0.7 * part(job.next, job.samples.length);
    case 'recent':
      return 0.85 + 0.13 * part(job.recentNext, job.recent.length);
    case 'owners':
      return 0.98;
    case 'done':
      return 1;
  }
}

/**
 * Advances the job as far as one step's budget allows and returns it (mutated in place).
 * Upstream errors propagate; OutOfRequests never does.
 */
export async function step(job: Job, gh: GitHub, limits: Limits): Promise<Job> {
  const ctx = { job, gh, limits, entries: 0 };
  try {
    while (job.phase !== 'done' && gh.left > 0 && ctx.entries < limits.stepEntries) {
      const before = { phase: job.phase, used: gh.used, entries: ctx.entries };
      await PHASES[job.phase](ctx);
      if (job.phase === before.phase && gh.used === before.used && ctx.entries === before.entries) {
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof OutOfRequests)) throw error;
  }
  return job;
}

type Ctx = { job: Job; gh: GitHub; limits: Limits; entries: number };

const PHASES: Record<Exclude<Phase, 'done'>, (ctx: Ctx) => Promise<void>> = {
  start,
  probe,
  trees,
  recent,
  owners,
};

const repoPath = (job: Job) => `/repos/${job.repo}`;
const iso = (ms: number) => new Date(ms).toISOString();

async function listCommits(
  ctx: Ctx,
  query: string,
): Promise<{ commits: CommitSummary[]; link: string | null }> {
  const { body, link } = await ctx.gh.json(`${repoPath(ctx.job)}/commits?${query}`);
  return { commits: toCommits(body), link };
}

const listed = ({ sha, at, tree, author }: CommitSummary): Listed => ({ sha, at, tree, author });

async function start(ctx: Ctx): Promise<void> {
  const { job, limits } = ctx;
  if (job.samples.length === 0) {
    const { commits } = await listCommits(ctx, `sha=${job.head.sha}&per_page=${PER_PAGE}`);
    const head = commits[0];
    if (!head) throw new UpstreamError('empty');
    job.head = { sha: head.sha, at: head.at, tree: head.tree };
    job.samples = [job.head];
    job.listing = commits.map(listed);
    job.listingComplete = commits.length < PER_PAGE;
    job.recent = commits
      .filter((c) => !c.merge)
      .slice(0, limits.recentCommits)
      .map(listed);
    job.recentIsAll =
      job.listingComplete && job.recent.length === commits.filter((c) => !c.merge).length;
    if (job.listingComplete) {
      const last = commits[commits.length - 1]!;
      job.root = { sha: last.sha, at: last.at, tree: last.tree };
    }
  }
  if (!job.root && !job.gaps.includes('root-unknown')) {
    const { link } = await listCommits(ctx, `sha=${job.head.sha}&per_page=1`);
    const pages = lastPage(link);
    const { commits } = pages
      ? await listCommits(ctx, `sha=${job.head.sha}&per_page=1&page=${pages}`)
      : { commits: [] };
    const root = commits[0];
    if (root) job.root = { sha: root.sha, at: root.at, tree: root.tree };
    else job.gaps.push('root-unknown');
  }
  job.targets = schedule(job.head.at, job.root?.at ?? null, limits.maxSnapshots);
  job.targetCount = job.targets.length;
  job.phase = 'probe';
}

/**
 * Target times, newest first: weekly for 26 weeks, every 30 days to two years, then yearly back
 * to the root (or 30 years when the root is unknown; probing stops at the first empty answer).
 * Leaves room for the head and the root inside `max`.
 */
export function schedule(headAt: number, rootAt: number | null, max: number): number[] {
  const out: number[] = [];
  const floor = rootAt ?? headAt - 30 * 365 * DAY;
  const push = (t: number) => {
    if (t > floor && out.length < max - 2) out.push(t);
  };
  for (let w = 1; w <= 26; w++) push(headAt - w * 7 * DAY);
  for (let m = 7; m <= 24; m++) push(headAt - m * 30 * DAY);
  for (let y = 3; y <= 30; y++) push(headAt - y * 365 * DAY);
  return out;
}

function countAuthors(list: readonly Listed[], after: number, upTo: number): Counts {
  const counts: Counts = {};
  for (const c of list)
    if (c.at > after && c.at <= upTo) counts[c.author] = (counts[c.author] ?? 0) + 1;
  return counts;
}

async function probe(ctx: Ctx): Promise<void> {
  const { job } = ctx;
  const target = job.targets[0];
  if (target === undefined) {
    const oldest = job.samples[job.samples.length - 1]!;
    if (job.root && job.root.sha !== oldest.sha && job.root.at < oldest.at) {
      job.between.push(countAuthors(job.listing, job.root.at, oldest.at));
      job.samples.push(job.root);
    }
    job.listing = [];
    job.phase = 'trees';
    return;
  }
  const newer = job.samples[job.samples.length - 1]!;
  const oldestListed = job.listing[job.listing.length - 1];
  const covers = oldestListed !== undefined && (oldestListed.at <= target || job.listingComplete);
  let found = covers ? job.listing.find((c) => c.at <= target) : undefined;
  let between: Counts;
  if (covers) {
    between = found ? countAuthors(job.listing, found.at, newer.at) : {};
  } else {
    between = countAuthors(job.listing, target, newer.at);
    const { commits } = await listCommits(
      ctx,
      `sha=${job.head.sha}&until=${iso(target)}&per_page=${PER_PAGE}`,
    );
    job.listing = commits.map(listed);
    job.listingComplete = commits.length < PER_PAGE;
    found = job.listing[0];
  }
  job.targets.shift();
  if (!found) {
    job.targets = [];
    return;
  }
  if (found.sha === newer.sha) return;
  job.between.push(between);
  job.samples.push({ sha: found.sha, at: found.at, tree: found.tree });
}

async function readTree(ctx: Ctx, sha: string, recursive: boolean) {
  const { body } = await ctx.gh.json(
    `${repoPath(ctx.job)}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`,
  );
  return toTree(body);
}

/** Entries of one snapshot, and the top-level folders taken unchanged from the newer one. */
type Read = { entries: TreeEntry[]; carried: string[]; truncated: boolean };

async function readSnapshot(ctx: Ctx, sample: Sample, first: boolean): Promise<Read | 'skip'> {
  const { job, limits } = ctx;
  const whole = await readTree(ctx, sample.tree, true);
  if (!whole.truncated) return { entries: whole.entries, carried: [], truncated: false };
  if (job.splitUsed >= limits.splitRequests && job.applied.length > 0) return 'skip';
  const top = await readTree(ctx, sample.tree, false);
  job.splitUsed++;
  const read: Read = { entries: [], carried: [], truncated: false };
  for (const entry of top.entries) {
    read.entries.push(entry);
    if (entry.type !== 'tree') continue;
    if (job.applied.length > 0 && job.prevTop[entry.path] === entry.sha) {
      read.carried.push(entry.path);
      continue;
    }
    try {
      const sub = await readTree(ctx, entry.sha, true);
      job.splitUsed++;
      read.truncated ||= sub.truncated;
      for (const e of sub.entries) read.entries.push({ ...e, path: `${entry.path}/${e.path}` });
    } catch (error) {
      // A snapshot too wide for one step is folded as far as it was read, unless a later step can retry it.
      if (!(error instanceof OutOfRequests) || !first) throw error;
      read.truncated = true;
      break;
    }
  }
  return read;
}

async function trees(ctx: Ctx): Promise<void> {
  const { job } = ctx;
  const j = job.next;
  const sample = job.samples[j];
  if (!sample) {
    job.phase = job.recent.length > 0 ? 'recent' : 'owners';
    return;
  }
  const first = ctx.gh.used === 0;
  const read = await readSnapshot(ctx, sample, first);
  job.next++;
  if (read === 'skip') {
    if (!job.gaps.includes('snapshots-skipped')) job.gaps.push('snapshots-skipped');
    return;
  }
  if (read.truncated && !job.gaps.includes('tree-truncated')) job.gaps.push('tree-truncated');
  fold(job, j, read);
  ctx.entries += read.entries.length;
}

/** Folds snapshot j into the accumulator. Exported for tests of the accumulator rules. */
export function fold(job: Job, j: number, read: Read): void {
  const prevJ = job.applied[job.applied.length - 1] ?? -1;
  const visit = (path: string, sha: string, folder: 0 | 1) => {
    const row = job.acc[path];
    if (!row) {
      job.acc[path] = [j, j, j, 0, sha, folder];
    } else if (row[1] === prevJ) {
      row[1] = j;
      if (row[4] === sha) {
        if (row[2] === prevJ) row[2] = j;
      } else {
        row[3]++;
        row[4] = sha;
      }
    }
  };
  visit('', job.samples[j]!.tree, 1);
  const top: Record<string, string> = {};
  const rootFiles: string[] = [];
  for (const e of read.entries) {
    visit(e.path, e.sha, e.type === 'tree' ? 1 : 0);
    if (!e.path.includes('/')) {
      if (e.type === 'tree') top[e.path] = e.sha;
      else rootFiles.push(e.sha);
    }
    if (j === 0 && e.type === 'blob' && CODEOWNERS_PATHS.includes(e.path)) {
      const rank = CODEOWNERS_PATHS.indexOf(e.path);
      const held = job.codeownersSha ? Number(job.codeownersSha.split(':')[0]) : Infinity;
      if (rank < held) job.codeownersSha = `${rank}:${e.sha}`;
    }
  }
  for (const folder of read.carried) {
    const prefix = `${folder}/`;
    for (const [path, row] of Object.entries(job.acc)) {
      if (!path.startsWith(prefix) || row[1] !== prevJ) continue;
      row[1] = j;
      if (row[2] === prevJ) row[2] = j;
    }
  }
  top[''] = rootFiles.join(',');
  if (prevJ >= 0) {
    const authors: Counts = {};
    for (let k = prevJ; k < j; k++) {
      for (const [name, n] of Object.entries(job.between[k] ?? {}))
        authors[name] = (authors[name] ?? 0) + n;
    }
    for (const folder of new Set([...Object.keys(top), ...Object.keys(job.prevTop)])) {
      if (top[folder] === job.prevTop[folder]) continue;
      const w = (job.weights[folder] ??= {});
      for (const [name, n] of Object.entries(authors)) w[name] = (w[name] ?? 0) + n;
    }
  }
  job.prevTop = top;
  job.applied.push(j);
}

async function recent(ctx: Ctx): Promise<void> {
  const { job } = ctx;
  const commit = job.recent[job.recentNext];
  if (!commit) {
    job.phase = 'owners';
    return;
  }
  const { body } = await ctx.gh.json(`${repoPath(job)}/commits/${commit.sha}`);
  const changes = toChanges(body);
  job.recentNext++;
  const folders = new Set<string>(['']);
  const tops = new Set<string>();
  const touch = (path: string, kind: 'add' | 'remove' | 'change') => {
    const row = (job.touched[path] ??= [commit.at, 0, 0, 0]);
    row[1]++;
    if (kind === 'add' && !row[2]) row[2] = commit.at;
    if (kind === 'remove' && !row[3]) row[3] = commit.at;
    const parts = path.split('/');
    tops.add(parts.length > 1 ? parts[0]! : '');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  };
  for (const c of changes) {
    if (c.status === 'added' || c.status === 'copied') touch(c.path, 'add');
    else if (c.status === 'removed') touch(c.path, 'remove');
    else if (c.status === 'renamed') {
      touch(c.path, 'add');
      if (c.from) touch(c.from, 'remove');
    } else touch(c.path, 'change');
  }
  for (const folder of folders) {
    const row = (job.touched[`${folder}/`] ??= [commit.at, 0, 0, 0]);
    row[1]++;
  }
  for (const top of tops) {
    const counts = (job.commitsBy[top] ??= {});
    counts[commit.author] = (counts[commit.author] ?? 0) + 1;
  }
}

async function owners(ctx: Ctx): Promise<void> {
  const { job } = ctx;
  job.phase = 'done';
  if (!job.codeownersSha) return;
  const sha = job.codeownersSha.split(':')[1]!;
  try {
    const { body } = await ctx.gh.json(`${repoPath(job)}/git/blobs/${sha}`);
    if (!isRecord(body) || typeof body.content !== 'string') throw new UpstreamError('upstream');
    const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
    job.codeowners = parseCodeowners(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof OutOfRequests) {
      job.phase = 'owners';
      throw error;
    }
    job.gaps.push('codeowners-unread');
  }
}
