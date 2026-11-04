import type { TreeModel } from '../grow/grow';
import type { RepoIndex } from '../load/repo-index';
import type { History } from '../repo/history';
import { GONE_CAP } from '../../server/src/shape';

/**
 * A repo's life on one axis, `progress`, from 0 at the first commit to 1 at head. Progress
 * follows time partly linearly and mostly by activity, so a quiet year passes quickly and a busy
 * one gets room. The scrubber's position `s` (0 to 1) runs a little past head so the last
 * sprouts finish growing: the cursor is `s * (1 + SPAN)`.
 */
export type Timeline = {
  /** First commit and head, ms. */
  start: number;
  end: number;
  ease: Ease;
  /** Progress at which each TreeModel node, and each sprig of leaves, starts to appear. */
  nodes: Float32Array;
  sprigs: Float32Array;
  /** Per TreeModel folder, the progress its branch appears at. */
  folders: Float32Array;
  /** Progress of every file's birth, and of each deleted file's birth and deletion, ascending. */
  born: Float64Array;
  goneBorn: Float64Array;
  goneGone: Float64Array;
  /** Progress before which the deleted-file list is cut off (the server keeps GONE_CAP); 0 when complete. */
  partialBefore: number;
};

/** Knots of a piecewise linear, increasing map from time (ms) to progress. */
export type Ease = { at: Float64Array; p: Float64Array };

/**
 * How far behind its birth an element finishes growing in, in progress. A branch grows in
 * along its length, its children after it, within this span.
 */
export const SPAN = 0.04;
/** Share of the axis spread evenly over time; the rest follows births and deletions. */
export const LINEAR = 0.3;

/** Whether a file born at `born` and deleted at `gone` (if ever) exists at `t`. */
export const aliveAt = (t: number, born: number, gone?: number): boolean =>
  born <= t && (gone === undefined || t < gone);

/** The cursor in progress for a scrubber position: past 1 only to let the last sprouts finish. */
export const cursorOf = (s: number): number => Math.max(0, Math.min(1, s)) * (1 + SPAN);

/** The scrubber position that shows the repo as it was at a date; head and later show it whole. */
export function positionAt(timeline: Timeline, ms: number): number {
  return ms >= timeline.end ? 1 : progressOf(timeline.ease, ms) / (1 + SPAN);
}

/** The date a scrubber position shows. */
export const dateAt = (timeline: Timeline, s: number): number =>
  dateOf(timeline.ease, Math.min(1, cursorOf(s)));

/**
 * Files that exist at a scrubber position, counting deleted ones while they lived. Position 0 is
 * the empty island just before the first commit. `atLeast`:
 * deletions this far back were cut from the history, so some files are missing from the count.
 */
export function filesAt(timeline: Timeline, s: number): { files: number; atLeast: boolean } {
  const p = Math.min(1, cursorOf(s));
  if (p <= 0) return { files: 0, atLeast: false };
  const files = upTo(timeline.born, p) + upTo(timeline.goneBorn, p) - upTo(timeline.goneGone, p);
  return { files, atLeast: p < timeline.partialBefore };
}

export function progressOf({ at, p }: Ease, ms: number): number {
  if (ms <= at[0]!) return 0;
  const last = at.length - 1;
  if (ms >= at[last]!) return 1;
  const i = upTo(at, ms);
  const a = at[i - 1]!;
  const b = at[i]!;
  return p[i - 1]! + ((p[i]! - p[i - 1]!) * (ms - a)) / (b - a);
}

export function dateOf({ at, p }: Ease, progress: number): number {
  if (progress <= 0) return at[0]!;
  const last = at.length - 1;
  if (progress >= 1) return at[last]!;
  const i = Math.max(1, upTo(p, progress));
  const a = p[i - 1]!;
  const b = p[i]!;
  return b === a ? at[i]! : at[i - 1]! + ((at[i]! - at[i - 1]!) * (progress - a)) / (b - a);
}

/**
 * Lays the history over a grown tree. A time older than `recent.since` is the snapshot that
 * first showed it, so it is spread over the interval before that snapshot, by a hash of the
 * element: a folder's files then sprout across the months they arrived in, not in one pop.
 * Files deleted before head have no leaves; they count while they lived, and a folder that
 * held them appears from the folder table's birth, so its branch shows before today's files.
 */
export function buildTimeline(
  history: History,
  tree: TreeModel,
  index: RepoIndex,
  hidden: readonly string[] = [],
): Timeline {
  const at = knotTimes(history);
  const start = at[0]!;
  const end = at[at.length - 1]!;
  const exactFrom = history.recent.since === 0 ? -Infinity : history.recent.since;
  const knot = (ms: number) => {
    if (ms >= exactFrom) return -1;
    const i = upTo(at, ms) - 1;
    return i > 0 && at[i] === ms ? i : -1;
  };

  const skip = new Set(hidden);
  const shown = (path: string) => !path.split('/').some((part) => skip.has(part));
  const gone = history.gone.filter((g) => shown(g.path));
  const weights = new Float64Array(at.length);
  const tally = (ms: number) => {
    if (ms <= start) return;
    weights[Math.min(at.length - 1, upTo(at, ms - 1))]! += 1;
  };
  const bornOf = new Map<string, number>();
  history.files.path.forEach((path, i) => bornOf.set(path, history.files.born[i]!));
  const fileMs = index.files.paths.map((path) => bornOf.get(path) ?? end);
  for (const ms of fileMs) tally(ms);
  for (const g of gone) {
    tally(g.born);
    tally(g.gone);
  }
  const ease = easeOf(at, weights);

  /** Progress of a time, spread over its snapshot interval by `key` when it is a snapshot time. */
  const spread = (ms: number, key: number) => {
    const i = knot(ms);
    if (i < 0) return progressOf(ease, ms);
    const a = ease.p[i - 1]!;
    return a + (ease.p[i]! - a) * hash01(key);
  };

  const filesP = Float64Array.from(fileMs, (ms, id) => spread(ms, id));
  const { sprigs: sprig, nodes: node, folders } = tree;
  const sprigCount = sprig.vertex.length - 1;
  const sprigs = new Float32Array(sprigCount);
  const nodeCount = node.parent.length;
  const nodes = new Float32Array(nodeCount).fill(Infinity);
  for (let s = 0; s < sprigCount; s++) {
    let first = Infinity;
    for (let k = sprig.file[s]!; k < sprig.file[s + 1]!; k++) {
      first = Math.min(first, filesP[sprig.files[k]!]!);
    }
    sprigs[s] = first;
    const twig = tree.leaves.nodeId[sprig.vertex[s]!]!;
    nodes[twig] = Math.min(nodes[twig]!, first);
  }
  const folderMs = new Map<string, number>();
  history.folders.path.forEach((path, i) => folderMs.set(path, history.folders.born[i]!));
  const folderKey = filesP.length;
  folders.path.forEach((path, f) => {
    const ms = folderMs.get(path);
    if (ms === undefined) return;
    const top = folders.range[2 * f]!;
    nodes[top] = Math.min(nodes[top]!, spread(ms, folderKey + f));
  });
  for (let n = nodeCount - 1; n > 0; n--) {
    const parent = node.parent[n]!;
    nodes[parent] = Math.min(nodes[parent]!, nodes[n]!);
  }
  nodes[0] = 0;
  for (let n = 0; n < nodeCount; n++) if (nodes[n] === Infinity) nodes[n] = 1;

  const goneKey = folderKey + folders.path.length;
  const capped = history.gone.length >= GONE_CAP;
  const oldestGone = history.gone.reduce((min, g) => Math.min(min, g.gone), Infinity);
  return {
    start,
    end,
    ease,
    nodes,
    sprigs,
    folders: Float32Array.from(folders.path, (_, f) => nodes[folders.range[2 * f]!]!),
    born: filesP.sort(),
    goneBorn: Float64Array.from(gone, (g, i) => spread(g.born, goneKey + 2 * i)).sort(),
    goneGone: Float64Array.from(gone, (g, i) => spread(g.gone, goneKey + 2 * i + 1)).sort(),
    partialBefore: capped ? progressOf(ease, oldestGone) : 0,
  };
}

/** Snapshot times, ascending and distinct; the first is the first commit, the last head. */
function knotTimes(history: History): Float64Array {
  const times = [...new Set(history.snapshots.map((s) => s.at))].sort((a, b) => a - b);
  if (times.length === 1) times.unshift(times[0]! - 1);
  return Float64Array.from(times);
}

/** Progress at each knot: LINEAR of it by elapsed time, the rest by the activity up to it. */
export function easeOf(at: Float64Array, weights: Float64Array): Ease {
  const span = at[at.length - 1]! - at[0]!;
  const total = weights.reduce((sum, w) => sum + w, 0);
  const linear = total > 0 ? LINEAR : 1;
  const p = new Float64Array(at.length);
  let cumulative = 0;
  for (let i = 0; i < at.length; i++) {
    cumulative += weights[i]!;
    p[i] =
      linear * ((at[i]! - at[0]!) / span) + (total > 0 ? (1 - linear) * (cumulative / total) : 0);
  }
  p[at.length - 1] = 1;
  return { at, p };
}

/** How many of the ascending values are at most `x`. */
export function upTo(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A fixed fraction in [0, 1) for an integer, so the same repo spreads the same way every time. */
function hash01(key: number): number {
  let h = Math.imul(key ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
