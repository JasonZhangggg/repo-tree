import type { TreeModel } from '../grow/grow';
import type { RepoIndex } from '../load/repo-index';
import type { History } from '../repo/history';
import { historyOwners, type Owners } from './owners';

const DAY = 24 * 60 * 60 * 1000;

/**
 * How long ago a file last changed, in bands from fresh to dead wood. A sprig of leaves, or a
 * folder, takes the band most of its files are in (the fresher on a tie), so a big twig of old
 * files with one recent edit still reads as old. A branch is dead wood only when every file on
 * it is: its leaves drop and its bark goes grey.
 */
export const AGES: readonly { label: string; within: number }[] = [
  { label: 'This month', within: 31 * DAY },
  { label: 'This year', within: 365 * DAY },
  { label: '1 to 3 years', within: 3 * 365 * DAY },
  { label: 'Dead wood', within: Infinity },
];
export const DEAD = AGES.length - 1;

/**
 * How often a file changed (`Facts.fileChurn`), in bands from the busiest down. A sprig or a
 * folder takes the band most of its files are in, the busier on a tie, as for AGES.
 */
export const CHANGES: readonly { label: string; atLeast: number }[] = [
  { label: 'Constantly', atLeast: 20 },
  { label: 'Often', atLeast: 10 },
  { label: 'Sometimes', atLeast: 3 },
  { label: 'Rarely', atLeast: 0 },
];

/** The CHANGES band of a file `churn` busy. */
export const changeBand = (churn: number): number => CHANGES.findIndex((c) => churn >= c.atLeast);

/**
 * Where a file `churn` busy sits on the Changes gradient: 0 for a file that never changed up to
 * CHANGES.length - 1 for the busiest, on a log scale. Each band's own stop is its color, and its
 * edges (the `atLeast` counts) fall halfway between stops, so `CHANGES.length - 1 - level`
 * rounds to the file's band. Past LEVEL_TOP changes a file is as busy as it gets.
 */
export const LEVEL_TOP = 100;
const LEVEL_AT: readonly [number, number][] = [
  [0, 0],
  ...CHANGES.slice(0, -1)
    .map((c, i): [number, number] => [c.atLeast, CHANGES.length - 1.5 - i])
    .reverse(),
  [LEVEL_TOP, CHANGES.length - 1],
];
export function changeLevel(churn: number): number {
  const x = Math.log1p(churn);
  for (let i = 1; i < LEVEL_AT.length; i++) {
    const [c, l] = LEVEL_AT[i]!;
    const [c0, l0] = LEVEL_AT[i - 1]!;
    const x0 = Math.log1p(c0);
    const x1 = Math.log1p(c);
    if (x <= x1) return l0 + ((l - l0) * (x - x0)) / (x1 - x0);
  }
  return CHANGES.length - 1;
}

/** The band of a change at `changed` seen from `asOf`. */
export const ageBand = (asOf: number, changed: number): number => {
  const age = asOf - changed;
  const band = AGES.findIndex((a) => age < a.within);
  return band < 0 ? DEAD : band;
};

/**
 * What the history says about the tree on show, per element the view draws. Files the history
 * does not list (added after the commit it describes) count as changed at `asOf`.
 */
export type Facts = {
  /** The time ages are measured from: when the history was computed. */
  asOf: number;
  /** Per RepoIndex file, its last change, ms. */
  fileChanged: Float64Array;
  /** Per sprig, the AGES band most of its files are in. */
  sprigBand: Uint8Array;
  /** Per TreeModel folder, the AGES band most of the files under it are in. */
  folderBand: Uint8Array;
  /** Per node, the newest last change of any sprig on it or on a branch out of it, ms. */
  nodeChanged: Float64Array;
  /** Per RepoIndex file, how busy it is: `History.files.churn` plus its recent `commits`. */
  fileChurn: Uint32Array;
  /** Per sprig, the CHANGES band most of its files are in. */
  sprigChangeBand: Uint8Array;
  /**
   * Per sprig, where its leaves sit on the Changes gradient: the upper quartile of its files'
   * `changeLevel`, or, for a sprig holding a busiest file (Facts.hot), its hottest file's level
   * when that is higher. A sprig stands for many files on a big tree, so a mean would bury the
   * busy ones in quiet neighbours: the tree would read one color and nothing would reach the
   * darkest stop. The upper quartile spreads twigs along the gradient, and glowing leaves take it.
   */
  sprigChangeLevel: Float32Array;
  /** Per TreeModel folder, the CHANGES band most of the files under it are in. */
  folderChangeBand: Uint8Array;
  /** Per RepoIndex file, its hotspot heat: 0 for most, from HOT_FLOOR to 1 for the busiest. */
  fileHeat: Float32Array;
  /** Per sprig, the heat of its hottest file. */
  sprigHeat: Float32Array;
  /** The hotspots: RepoIndex files with heat, hottest first (then in path order), all on leaves. */
  hot: Uint32Array;
  /** Who to ask about each top-level folder (timeline/owners.ts). */
  owners: Owners;
};

/**
 * Hotspots are the busiest files on the leaves: by churn (snapshot intervals in which a file
 * changed, and recent intervals are shorter, so recent churn weighs more) plus its exact recent
 * commits. The busiest are taken, a whole tie at a time, until one more would pass HOT_SHARE of
 * all files or light more than HOT_SPRIGS of the sprigs: a sprig stands for many files on a big
 * tree, so a share of files alone would light most of a big crown. A file needs HOT_MIN, so a
 * young repo, where nothing has changed much yet, does not glow at all. The root's own files
 * lie as rocks, not leaves, so they are never hotspots.
 */
export const HOT_SHARE = 0.04;
export const HOT_SPRIGS = 0.05;
export const HOT_MIN = 6;
/** The heat of the coolest hotspot; the busiest file is 1. */
export const HOT_FLOOR = 0.35;

/**
 * Each file's heat and the hotspots, hottest first, from how busy each file is and the sprig it
 * hangs on (-1 for none) out of `sprigCount`.
 */
export function hotspots(
  churn: Uint32Array,
  sprigOf: Int32Array,
  sprigCount: number,
): { heat: Float32Array; hot: Uint32Array } {
  const heat = new Float32Array(churn.length);
  const order = Array.from(churn.keys())
    .filter((i) => churn[i]! >= HOT_MIN && sprigOf[i]! >= 0)
    .sort((a, b) => churn[b]! - churn[a]! || a - b);
  const maxFiles = Math.max(1, Math.round(churn.length * HOT_SHARE));
  const maxSprigs = Math.max(1, Math.round(sprigCount * HOT_SPRIGS));
  const lit = new Set<number>();
  let taken = 0;
  while (taken < order.length) {
    let next = taken;
    const more = new Set(lit);
    while (next < order.length && churn[order[next]!] === churn[order[taken]!]) {
      more.add(sprigOf[order[next++]!]!);
    }
    if (taken > 0 && (next > maxFiles || more.size > maxSprigs)) break;
    for (const sprig of more) lit.add(sprig);
    taken = next;
  }
  const hot = order.slice(0, taken);
  if (hot.length === 0) return { heat, hot: new Uint32Array() };
  const top = churn[hot[0]!]!;
  const cut = churn[hot.at(-1)!]!;
  for (const i of hot) {
    heat[i] = top === cut ? 1 : HOT_FLOOR + ((1 - HOT_FLOOR) * (churn[i]! - cut)) / (top - cut);
  }
  return { heat, hot: Uint32Array.from(hot) };
}

/** Lays a history's per-file columns over a grown tree. */
export function historyFacts(history: History, tree: TreeModel, index: RepoIndex): Facts {
  const asOf = history.computedAt;
  const rowOf = new Map<string, number>();
  history.files.path.forEach((path, i) => rowOf.set(path, i));
  const { changed, churn, commits } = history.files;
  const rows = index.files.paths.map((path) => rowOf.get(path));
  const fileChanged = Float64Array.from(rows, (row) => (row === undefined ? asOf : changed[row]!));
  const fileChurn = Uint32Array.from(rows, (row) =>
    row === undefined ? 0 : churn[row]! + commits[row]!,
  );
  const fileBand = Uint8Array.from(fileChanged, (ms) => ageBand(asOf, ms));
  const fileChangeBand = Uint8Array.from(fileChurn, changeBand);
  const bands = AGES.length;

  const { sprigs, nodes, leaves } = tree;
  const sprigCount = sprigs.vertex.length - 1;
  const sprigOf = new Int32Array(fileChurn.length).fill(-1);
  for (let s = 0; s < sprigCount; s++) {
    for (let k = sprigs.file[s]!; k < sprigs.file[s + 1]!; k++) sprigOf[sprigs.files[k]!] = s;
  }
  const { heat: fileHeat, hot } = hotspots(fileChurn, sprigOf, sprigCount);
  const sprigBand = new Uint8Array(sprigCount);
  const sprigChangeBand = new Uint8Array(sprigCount);
  const changeTally = new Uint32Array(CHANGES.length);
  const sprigHeat = new Float32Array(sprigCount);
  const sprigChangeLevel = new Float32Array(sprigCount);
  const levels: number[] = [];
  const nodeChanged = new Float64Array(nodes.parent.length).fill(-Infinity);
  const tally = new Uint32Array(bands);
  for (let s = 0; s < sprigCount; s++) {
    tally.fill(0);
    changeTally.fill(0);
    let newest = -Infinity;
    let hottest = 0;
    for (let k = sprigs.file[s]!; k < sprigs.file[s + 1]!; k++) {
      const file = sprigs.files[k]!;
      tally[fileBand[file]!]! += 1;
      changeTally[fileChangeBand[file]!]! += 1;
      newest = Math.max(newest, fileChanged[file]!);
      sprigHeat[s] = Math.max(sprigHeat[s]!, fileHeat[file]!);
      const level = changeLevel(fileChurn[file]!);
      levels.push(level);
      if (fileHeat[file]! > 0) hottest = Math.max(hottest, level);
    }
    sprigChangeLevel[s] = Math.max(upperQuartile(levels), hottest);
    levels.length = 0;
    sprigBand[s] = most(tally, 0);
    sprigChangeBand[s] = most(changeTally, 0);
    const twig = leaves.nodeId[sprigs.vertex[s]!]!;
    nodeChanged[twig] = Math.max(nodeChanged[twig]!, newest);
  }
  // Children follow their parents in preorder, so one backward pass carries each up.
  for (let n = nodeChanged.length - 1; n > 0; n--) {
    const parent = nodes.parent[n]!;
    nodeChanged[parent] = Math.max(nodeChanged[parent]!, nodeChanged[n]!);
  }

  const folderBand = folderMajority(index, fileBand);
  const folderChangeBand = folderMajority(index, fileChangeBand);
  return {
    asOf,
    fileChanged,
    sprigBand,
    folderBand,
    sprigChangeBand,
    sprigChangeLevel,
    folderChangeBand,
    nodeChanged,
    fileChurn,
    fileHeat,
    sprigHeat,
    hot,
    owners: historyOwners(history),
  };
}

/** The value a quarter of `values` are at or above (0 for none); sorts `values`. */
function upperQuartile(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.75)]!;
}

/** Per folder, the band (of four, AGES or CHANGES) most of the files under it are in. */
function folderMajority(index: RepoIndex, fileBand: Uint8Array): Uint8Array {
  const { parent, own } = index.folders;
  const bands = AGES.length;
  const tally = new Uint32Array(parent.length * bands);
  for (let f = 0; f < parent.length; f++) {
    for (let i = own[2 * f]!; i < own[2 * f]! + own[2 * f + 1]!; i++) {
      tally[f * bands + fileBand[i]!]! += 1;
    }
  }
  for (let f = parent.length - 1; f > 0; f--) {
    for (let b = 0; b < bands; b++) tally[parent[f]! * bands + b]! += tally[f * bands + b]!;
  }
  return Uint8Array.from(parent, (_, f) => most(tally, f * bands));
}

/**
 * The band with the most files among four counts from `at` (AGES and CHANGES both have four),
 * the first (fresher, or busier) on a tie.
 */
function most(counts: Uint32Array, at: number): number {
  let best = 0;
  for (let b = 1; b < AGES.length; b++) if (counts[at + b]! > counts[at + best]!) best = b;
  return best;
}
