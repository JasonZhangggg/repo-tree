import {
  AUTHORS_PER_FOLDER,
  GONE_CAP,
  HISTORY_VERSION,
  type History,
  type PathTable,
} from '../shape';
import { ownersOf } from './codeowners';
import type { Job } from './job';

/** Bots (dependabot[bot], renovate[bot]) touch everything and own nothing. */
const BOT = /\[bot\]$/;

/** Turns a finished job into the history the app reads. Pure. */
export function summarize(job: Job, now: number): History {
  const at = (j: number) => job.samples[j]!.at;
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
  /** The next newer folded snapshot after j: the first one known not to hold a path last seen at j. */
  const newerThan = (j: number) => {
    const i = job.applied.indexOf(j);
    return i > 0 ? job.applied[i - 1]! : j - 1;
  };

  const files = table();
  const folders = table();
  const gone: History['gone'] = [];
  const headTruncated = job.gaps.includes('tree-truncated') && job.applied[0] === 0;

  for (const [path, [newest, oldest, version, churn, , folder]] of Object.entries(job.acc)) {
    const touch = job.touched[folder ? `${path}/` : path];
    if (newest !== 0) {
      if (folder || headTruncated) continue;
      const removed = touch?.[3] ?? 0;
      gone.push({ path, born: clamp(at(oldest)), gone: removed || clamp(at(newerThan(newest))) });
      continue;
    }
    const target = folder ? folders : files;
    target.path.push(path);
    target.changed.push(touch ? touch[0] : clamp(at(version)));
    target.born.push(touch?.[2] || clamp(at(oldest)));
    target.churn.push(churn);
    target.commits.push(touch?.[1] ?? 0);
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
    gaps: [...job.gaps],
    recent: { since: Math.min(since, job.head.at), commits: recentDone.length },
    snapshots: job.samples.map(({ sha, at }) => ({ sha, at })).reverse(),
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
