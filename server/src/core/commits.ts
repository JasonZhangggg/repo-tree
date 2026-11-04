/**
 * The pieces of a history computation that are about commits, not trees: when to take
 * snapshots, who committed between them, and what the recent commits touched. The engine
 * (engine.ts) runs them; summarize.ts turns their results into a History.
 */

import type { CommitSummary, FileChange } from './github';

export type Limits = {
  /** Newest non-merge commits read one by one. 0 turns the refinement off. */
  recentCommits: number;
  /** Snapshots compared, the head and the root included. */
  maxSnapshots: number;
};

export const DEFAULT_LIMITS: Limits = { recentCommits: 100, maxSnapshots: 80 };

const DAY = 24 * 60 * 60 * 1000;

export type Sample = { sha: string; at: number; tree: string };
export type Listed = Pick<CommitSummary, 'sha' | 'at' | 'tree' | 'author'>;
export type Counts = Record<string, number>;

/**
 * Per path, over the snapshots folded so far (j counts snapshots from the head, 0, to older):
 * [newest j of its newest unbroken run, oldest j of that run, oldest j still holding the newest
 * version, intervals in which its sha changed, sha at the oldest j, 1 for a folder].
 */
export type AccRow = [number, number, number, number, string, 0 | 1];
/** Per path touched by the recent commits: [last at, commits, newest add at, newest removal at]. */
export type TouchRow = [number, number, number, number];

export const listed = ({ sha, at, tree, author }: CommitSummary): Listed => ({
  sha,
  at,
  tree,
  author,
});

/**
 * Target times, newest first: weekly for 26 weeks, every 30 days to two years, then yearly back
 * to the root (or 30 years when the root is unknown; probing stops at the first empty answer).
 * Leaves room for the head and the root inside `max`.
 */
export function schedule(
  headAt: number,
  rootAt: number | null,
  max: number,
  sparse = false,
): number[] {
  const out: number[] = [];
  const floor = rootAt ?? headAt - 30 * 365 * DAY;
  const push = (t: number) => {
    if (t > floor && out.length < max - 2) out.push(t);
  };
  // `sparse` keeps every other week past 12 and every other month past 12: a subset of the
  // full schedule, so a history Worker that checks uploads against the full one takes it.
  const keep = (n: number, from: number) => !sparse || n <= from || n % 2 === 0;
  for (let w = 1; w <= 26; w++) if (keep(w, 12)) push(headAt - w * 7 * DAY);
  for (let m = 7; m <= 24; m++) if (keep(m, 12)) push(headAt - m * 30 * DAY);
  for (let y = 3; y <= 30; y++) push(headAt - y * 365 * DAY);
  return out;
}

/** Authors of the listed commits after `after` up to `upTo`. */
export function countAuthors(list: readonly Listed[], after: number, upTo: number): Counts {
  const counts: Counts = {};
  for (const c of list)
    if (c.at > after && c.at <= upTo) counts[c.author] = (counts[c.author] ?? 0) + 1;
  return counts;
}

/**
 * Folds one recent commit's changed files into `touched` (files by path, folders by `path/`)
 * and `commitsBy` (its author, per top-level folder it touched). Commits go newest first.
 */
export function touchCommit(
  into: { touched: Record<string, TouchRow>; commitsBy: Record<string, Counts> },
  commit: Pick<Listed, 'at' | 'author'>,
  changes: readonly FileChange[],
): void {
  const folders = new Set<string>(['']);
  const tops = new Set<string>();
  const touch = (path: string, kind: 'add' | 'remove' | 'change') => {
    const row = (into.touched[path] ??= [commit.at, 0, 0, 0]);
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
    const row = (into.touched[`${folder}/`] ??= [commit.at, 0, 0, 0]);
    row[1]++;
  }
  for (const top of tops) {
    const counts = (into.commitsBy[top] ??= {});
    counts[commit.author] = (counts[commit.author] ?? 0) + 1;
  }
}
