import { treeHeight } from '../grow/size';
import type { Loaded } from '../load/load-in-worker';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { FIRST_VISIT, SAMPLES } from './samples';
import { sameRef, type AppState } from './state';

/** What the compare view sets side by side for each tree. */
export type TreeStats = {
  files: number;
  folders: number;
  /** How many folders deep the deepest one sits; 0 when every file is at the root. */
  depth: number;
  bytes: number;
  /** Languages, most files first. */
  langs: { lang: string; files: number }[];
};

export function treeStats({ index, tree }: Pick<Loaded, 'index' | 'tree'>): TreeStats {
  const { parent, files, bytes } = index.folders;
  const depths = new Uint16Array(parent.length);
  let depth = 0;
  // Folders are in preorder, so a parent comes before its children.
  for (let i = 1; i < parent.length; i++) {
    depths[i] = depths[parent[i]!]! + 1;
    if (depths[i]! > depth) depth = depths[i]!;
  }
  return {
    files: files[0] ?? 0,
    folders: parent.length - 1,
    depth,
    bytes: bytes[0] ?? 0,
    langs: tree.langs.map((l) => ({ lang: l.lang, files: l.files })),
  };
}

/**
 * Each language's share of each tree, summed, so the two give a language the same leaf color.
 * Shares rather than files: a small repo's main languages still rank beside a large one's,
 * instead of all falling into the shared last color.
 */
export function sharedRank(a: TreeStats, b: TreeStats): Map<string, number> {
  const rank = new Map<string, number>();
  for (const { langs } of [a, b]) {
    const total = langs.reduce((sum, l) => sum + l.files, 0);
    for (const { lang, files } of langs) {
      rank.set(lang, (rank.get(lang) ?? 0) + files / Math.max(1, total));
    }
  }
  return rank;
}

/** The languages with the most files across both trees, and how many each tree has. */
export function languageRows(
  a: TreeStats,
  b: TreeStats,
  limit: number,
): { lang: string; a: number; b: number }[] {
  const of = (s: TreeStats) => new Map(s.langs.map((l) => [l.lang, l.files]));
  const [left, right] = [of(a), of(b)];
  return [...sharedRank(a, b)]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, limit)
    .map(([lang]) => ({ lang, a: left.get(lang) ?? 0, b: right.get(lang) ?? 0 }));
}

/** How the file counts compare, as a short sentence. */
export function sizeLine(a: { name: string; files: number }, b: { name: string; files: number }) {
  const [big, small] = a.files >= b.files ? [a, b] : [b, a];
  if (small.files === 0) return `${big.name} has files and ${small.name} has none`;
  const times = big.files / small.files;
  if (times < 1.05) return `${a.name} and ${b.name} have about as many files`;
  const shown = times < 10 ? times.toFixed(1).replace(/\.0$/, '') : Math.round(times).toString();
  return `${big.name} has ${shown}× the files of ${small.name}`;
}

/**
 * What to grow beside a repo when the compare view opens: the most recent other repo, else a
 * bundled sample that is not the one on show, so it grows with no network.
 */
export function defaultPartner(current: RepoRef, recent: readonly string[]): RepoRef {
  for (const name of recent) {
    const ref = parseRepoRef(name);
    if (!('kind' in ref) && !sameRef(plain(ref), plain(current))) return plain(ref);
  }
  // The mid-size sample first, then the small one: the large one takes a while to grow.
  const order = [FIRST_VISIT, ...SAMPLES.filter((s) => s !== FIRST_VISIT && s.files < 10_000)];
  return plain(order.find((s) => !sameRef(plain(s), plain(current)))!);
}

const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;

/**
 * The shared language ranking while a companion grows beside the repo on show, else null: the
 * same Map for the same pair, so the view is told only when it changes.
 */
export function rankOf({ repo, companion }: Pick<AppState, 'repo' | 'companion'>) {
  if (!repo || !companion) return null;
  if (ranked?.repo !== repo || ranked.companion !== companion) {
    ranked = { repo, companion, rank: sharedRank(treeStats(repo), treeStats(companion)) };
  }
  return ranked.rank;
}
let ranked: { repo: Loaded; companion: Loaded; rank: Map<string, number> } | null = null;

/** The least height a tree shrinks to beside a bigger one, so it can still be seen and pointed at. */
const LEAST_HEIGHT = 0.35;

/**
 * How much to shrink each of two trees grown side by side so their heights show their sizes:
 * the bigger keeps its own height, and the smaller stands at the cube root of their file ratio
 * of it, as a crown's volume would hold its files. On its own a tree's height follows the files
 * gently (grow/size.ts), so a few times the files looks alike; beside each other the gap shows.
 */
export function pairScale(a: number, b: number): { a: number; b: number } {
  const [big, small] = a >= b ? [a, b] : [b, a];
  const tall = treeHeight(big);
  const goal = Math.max(LEAST_HEIGHT, tall * Math.cbrt(Math.max(1, small) / Math.max(1, big)));
  const shrink = Math.min(1, goal / treeHeight(small));
  return a >= b ? { a: 1, b: shrink } : { a: shrink, b: 1 };
}
