import { treeHeight } from '../grow/size';
import type { Loaded } from '../load/load-in-worker';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { FIRST_VISIT, SAMPLES } from './samples';
import { companionsOf, sameRef, type AppState } from './state';

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
 * Each language's share of each tree, summed, so the trees give a language the same leaf color.
 * Shares rather than files: a small repo's main languages still rank beside a large one's,
 * instead of all falling into the shared last color.
 */
export function sharedRank(...trees: TreeStats[]): Map<string, number> {
  const rank = new Map<string, number>();
  for (const { langs } of trees) {
    const total = langs.reduce((sum, l) => sum + l.files, 0);
    for (const { lang, files } of langs) {
      rank.set(lang, (rank.get(lang) ?? 0) + files / Math.max(1, total));
    }
  }
  return rank;
}

/** The languages with the most files across the trees, and how many each tree has, in order. */
export function languageRows(
  trees: TreeStats[],
  limit: number,
): { lang: string; files: number[] }[] {
  const counts = trees.map((s) => new Map(s.langs.map((l) => [l.lang, l.files])));
  return [...sharedRank(...trees)]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, limit)
    .map(([lang]) => ({ lang, files: counts.map((c) => c.get(lang) ?? 0) }));
}

/** How the file counts compare, as a short sentence: the biggest against the smallest. */
export function sizeLine(trees: { name: string; files: number }[]) {
  const sorted = [...trees].sort((x, y) => y.files - x.files);
  const big = sorted[0]!;
  const small = sorted.at(-1)!;
  const most = trees.length > 2 ? ' the most' : '';
  if (small.files === 0) return `${big.name} has files and ${small.name} has none`;
  const times = big.files / small.files;
  if (times < 1.05) {
    return trees.length > 2
      ? 'They have about as many files'
      : `${trees[0]!.name} and ${trees[1]!.name} have about as many files`;
  }
  const shown = times < 10 ? times.toFixed(1).replace(/\.0$/, '') : Math.round(times).toString();
  return trees.length > 2
    ? `${big.name} has${most} files, ${shown}× ${small.name}'s`
    : `${big.name} has ${shown}× the files of ${small.name}`;
}

/**
 * Repos to offer when adding one to compare: recent ones, then the bundled samples (which grow
 * with no network), leaving out those already on show or compared.
 */
export function partnerChoices(
  taken: readonly RepoRef[],
  recent: readonly string[],
): { recent: RepoRef[]; samples: RepoRef[] } {
  const seen = [...taken];
  const fresh = (ref: RepoRef) => {
    if (seen.some((t) => sameRef(plain(t), plain(ref)))) return false;
    seen.push(ref);
    return true;
  };
  const recentRefs = recent
    .map((name) => parseRepoRef(name))
    .flatMap((r) => ('kind' in r ? [] : [plain(r)]))
    .filter(fresh);
  // The mid-size sample first, then the small one: the large one takes a while to grow.
  const order = [FIRST_VISIT, ...SAMPLES.filter((s) => s !== FIRST_VISIT)];
  return { recent: recentRefs, samples: order.map(plain).filter(fresh) };
}

const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;

/**
 * The shared language ranking while companions grow beside the repo on show, else null: the
 * same Map for the same trees, so the view is told only when it changes.
 */
export function rankOf(state: Pick<AppState, 'repo' | 'compare' | 'companions'>) {
  const trees = state.repo ? [state.repo, ...companionsOf(state)] : [];
  if (trees.length < 2) return null;
  const same =
    ranked?.trees.length === trees.length && ranked.trees.every((t, i) => t === trees[i]);
  if (!same) ranked = { trees, rank: sharedRank(...trees.map(treeStats)) };
  return ranked!.rank;
}
let ranked: { trees: Loaded[]; rank: Map<string, number> } | null = null;

/** The least height a tree shrinks to beside a bigger one, so it can still be seen and pointed at. */
const LEAST_HEIGHT = 0.35;

/**
 * How much to shrink each of the trees grown side by side so their heights show their sizes:
 * the biggest keeps its own height, and each other stands at the cube root of its file ratio to
 * the biggest of that height, as a crown's volume would hold its files. On its own a tree's
 * height follows the files gently (grow/size.ts), so a few times the files looks alike; beside
 * each other the gap shows.
 */
export function sizeScales(files: readonly number[]): number[] {
  const big = Math.max(1, ...files);
  const tall = treeHeight(big);
  return files.map((n) => {
    const goal = Math.max(LEAST_HEIGHT, tall * Math.cbrt(Math.max(1, n) / big));
    return Math.min(1, goal / treeHeight(n));
  });
}
