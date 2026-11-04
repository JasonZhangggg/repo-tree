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
  /** Who to ask about each top-level folder (timeline/owners.ts). */
  owners: Owners;
};

/** Lays a history's per-file columns over a grown tree. */
export function historyFacts(history: History, tree: TreeModel, index: RepoIndex): Facts {
  const asOf = history.computedAt;
  const changedOf = new Map<string, number>();
  history.files.path.forEach((path, i) => changedOf.set(path, history.files.changed[i]!));
  const fileChanged = Float64Array.from(index.files.paths, (path) => changedOf.get(path) ?? asOf);
  const fileBand = Uint8Array.from(fileChanged, (ms) => ageBand(asOf, ms));
  const bands = AGES.length;

  const { sprigs, nodes, leaves } = tree;
  const sprigCount = sprigs.vertex.length - 1;
  const sprigBand = new Uint8Array(sprigCount);
  const nodeChanged = new Float64Array(nodes.parent.length).fill(-Infinity);
  const tally = new Uint32Array(bands);
  for (let s = 0; s < sprigCount; s++) {
    tally.fill(0);
    let newest = -Infinity;
    for (let k = sprigs.file[s]!; k < sprigs.file[s + 1]!; k++) {
      const file = sprigs.files[k]!;
      tally[fileBand[file]!]! += 1;
      newest = Math.max(newest, fileChanged[file]!);
    }
    sprigBand[s] = most(tally, 0);
    const twig = leaves.nodeId[sprigs.vertex[s]!]!;
    nodeChanged[twig] = Math.max(nodeChanged[twig]!, newest);
  }
  // Children follow their parents in preorder, so one backward pass carries each up.
  for (let n = nodeChanged.length - 1; n > 0; n--) {
    const parent = nodes.parent[n]!;
    nodeChanged[parent] = Math.max(nodeChanged[parent]!, nodeChanged[n]!);
  }

  const { parent, own } = index.folders;
  const folderTally = new Uint32Array(parent.length * bands);
  for (let f = 0; f < parent.length; f++) {
    for (let i = own[2 * f]!; i < own[2 * f]! + own[2 * f + 1]!; i++) {
      folderTally[f * bands + fileBand[i]!]! += 1;
    }
  }
  for (let f = parent.length - 1; f > 0; f--) {
    for (let b = 0; b < bands; b++) {
      folderTally[parent[f]! * bands + b]! += folderTally[f * bands + b]!;
    }
  }
  const folderBand = Uint8Array.from(parent, (_, f) => most(folderTally, f * bands));
  return {
    asOf,
    fileChanged,
    sprigBand,
    folderBand,
    nodeChanged,
    owners: historyOwners(history),
  };
}

/** The band with the most files among `AGES.length` counts from `at`, the fresher on a tie. */
function most(counts: Uint32Array, at: number): number {
  let best = 0;
  for (let b = 1; b < AGES.length; b++) if (counts[at + b]! > counts[at + best]!) best = b;
  return best;
}
