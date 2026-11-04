import {
  AUTHORS_PER_FOLDER,
  GONE_CAP,
  HISTORY_VERSION,
  type History,
  type Gap,
  type PathTable,
} from '../shape';
import { ownersOf } from './codeowners';
import type { OwnerRule } from './codeowners';
import type { AccRow, Counts, Listed, Sample, TouchRow } from './commits';

/** Bots (dependabot[bot], renovate[bot]) touch everything and own nothing. */
const BOT = /\[bot\]$/;

/** What summarize reads: the engine's folded snapshots and recent commits. */
export type Folded = {
  repo: string;
  branch: string;
  head: Sample;
  gaps: Gap[];
  /** Newest first; samples[0] is the head. */
  samples: Sample[];
  /** Snapshots folded, by j, newest first. */
  applied: number[];
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
  codeowners: OwnerRule[];
  /** The head's own listing is incomplete, so absence from it proves nothing. */
  headTruncated: boolean;
  /**
   * A refresh (refresh.ts): the stored history the new snapshots fold onto. `samples` then runs
   * from the new head down to the stored snapshots, the fold having stopped at `junction` (the
   * stored head); paths whose run reaches it carry on with the stored dates and churn.
   */
  base?: BaseTotals;
};

export type BaseRow = { born: number; changed: number; churn: number };

export type BaseTotals = {
  junction: number;
  /** The stored history's `recent.since`: its times older than this are snapshot resolution. */
  since: number;
  files: Map<string, BaseRow>;
  folders: Map<string, BaseRow>;
  gone: History['gone'];
  gaps: Gap[];
  /** Each dropped snapshot's time, to the time of the kept one just newer. */
  moved: Map<number, number>;
  /**
   * Churn corrections for merged intervals (refresh.ts churnDelta), each for the paths whose
   * run reaches back to `older`, the kept snapshot below the merge.
   */
  deltas: { older: number; churn: Map<string, number> }[];
  /** The History's snapshots, newest first. */
  kept: Sample[];
};

/** A stored history's path tables, by path, for BaseTotals. */
export function baseRows(t: PathTable): Map<string, BaseRow> {
  const out = new Map<string, BaseRow>();
  t.path.forEach((path, i) =>
    out.set(path, { born: t.born[i]!, changed: t.changed[i]!, churn: t.churn[i]! }),
  );
  return out;
}

/** Turns folded snapshots into the history the app reads. Pure. */
export function summarize(job: Folded, now: number): History {
  const { base } = job;
  /** A snapshot's time; a dropped one's stands for the kept one just newer. */
  const moved = (t: number) => base?.moved.get(t) ?? t;
  const at = (j: number) => moved(job.samples[j]!.at);
  const recentDone = job.recent.slice(0, job.recentNext);
  const reachesRoot =
    job.recentIsAll && recentDone.length === job.recent.length && job.recent.length > 0;
  const since =
    recentDone.length === 0
      ? job.head.at + 1
      : reachesRoot
        ? 0
        : recentDone[recentDone.length - 1]!.at;
  const clamp = (t: number) => (since > 0 ? Math.min(t, since) : t);
  /** A stored time: exact from the stored history's recent commits, else a snapshot's. */
  const stored = (t: number) => (base && t < base.since ? moved(t) : t);
  const churnFix = (key: string, born: number) => {
    let d = 0;
    for (const fix of base?.deltas ?? []) if (born <= fix.older) d += fix.churn.get(key) ?? 0;
    return d;
  };
  /** The next newer folded snapshot after j: the first one known not to hold a path last seen at j. */
  const newerThan = (j: number) => {
    const i = job.applied.indexOf(j);
    return i > 0 ? job.applied[i - 1]! : j - 1;
  };

  const files = table();
  const folders = table();
  const gone: History['gone'] = [];
  const { headTruncated } = job;

  for (const [path, [newest, oldest, version, churn, , folder]] of Object.entries(job.acc)) {
    const touch = job.touched[folder ? `${path}/` : path];
    const was =
      base && oldest === base.junction ? (folder ? base.folders : base.files).get(path) : undefined;
    const bornAt = touch?.[2] || clamp(was ? stored(was.born) : at(oldest));
    if (newest !== 0) {
      if (folder || headTruncated) continue;
      const removed = touch?.[3] ?? 0;
      gone.push({ path, born: bornAt, gone: removed || clamp(at(newerThan(newest))) });
      continue;
    }
    const target = folder ? folders : files;
    target.path.push(path);
    target.changed.push(
      touch
        ? touch[0]
        : clamp(was && version === base!.junction ? stored(was.changed) : at(version)),
    );
    target.born.push(bornAt);
    const key = folder ? (path ? `${path}/` : '/') : path;
    target.churn.push(Math.max(0, churn + (was?.churn ?? 0) + churnFix(key, bornAt)));
    target.commits.push(touch?.[1] ?? 0);
  }
  if (base && !headTruncated) {
    // Files deleted before the stored head, unless a path of the head holds them again.
    const held = new Set([...files.path, ...folders.path, ...gone.map((g) => g.path)]);
    for (const g of base.gone) {
      if (held.has(g.path)) continue;
      const born = stored(g.born);
      const at = stored(g.gone);
      // Seen only in dropped snapshots: no kept one shows it.
      if (at > born) gone.push({ path: g.path, born, gone: at });
    }
  }
  gone.sort((a, b) => b.gone - a.gone || (a.path < b.path ? -1 : 1));

  const tops = folders.path.filter((p) => p !== '' && !p.includes('/'));
  if (files.path.some((p) => !p.includes('/'))) tops.push('');
  const owners = tops.sort().map((folder) => {
    const exact = job.commitsBy[folder] ?? {};
    const rough = job.weights[folder] ?? {};
    const authors = [...new Set([...Object.keys(exact), ...Object.keys(rough)])]
      .filter((name) => !BOT.test(name))
      .map((name) => ({ name, commits: exact[name] ?? 0, weight: rough[name] ?? 0 }))
      .sort((a, b) => b.commits - a.commits || b.weight - a.weight || (a.name < b.name ? -1 : 1))
      .slice(0, AUTHORS_PER_FOLDER);
    return { folder, authors, codeowners: ownersOf(folder, job.codeowners) };
  });

  return {
    v: HISTORY_VERSION,
    repo: job.repo,
    branch: job.branch,
    head: job.head.sha,
    computedAt: now,
    gaps: [...new Set([...(base?.gaps ?? []), ...job.gaps])],
    recent: { since: Math.min(since, job.head.at), commits: recentDone.length },
    snapshots: (base?.kept ?? job.samples).map(({ sha, at }) => ({ sha, at })).reverse(),
    files: sorted(files),
    folders: sorted(folders),
    gone: gone.slice(0, GONE_CAP),
    owners,
  };
}

function table(): PathTable {
  return { path: [], changed: [], born: [], churn: [], commits: [] };
}

function sorted(t: PathTable): PathTable {
  const order = t.path.map((_, i) => i).sort((a, b) => (t.path[a]! < t.path[b]! ? -1 : 1));
  const pick = <T>(col: T[]) => order.map((i) => col[i]!);
  return {
    path: pick(t.path),
    changed: pick(t.changed),
    born: pick(t.born),
    churn: pick(t.churn),
    commits: pick(t.commits),
  };
}
