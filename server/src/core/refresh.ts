/**
 * Bringing a stored history up to date instead of computing it again (engine.ts, `base`).
 *
 * The stored history already holds what every snapshot up to its head says about each path.
 * A refresh keeps those snapshots, picks new ones only for the schedule's targets after the old
 * head, and reads the trees of the new snapshots and the old head (the junction) in one git
 * fetch: the new commits' trees and one copy of the head tree, not every snapshot's again. The
 * new snapshots are folded as a full run would fold them, down to the junction, and the stored
 * totals carry on from there (summarize.ts, `Folded.base`).
 *
 * The schedule is relative to the head, so as the head moves, old weeks age into months and
 * old months into years: a stored snapshot that no target can take any more is dropped, which
 * merges the two intervals beside it. Dates that named it move to the newer snapshot beside it,
 * and churn is corrected from the trees of the snapshots around it (read in the same fetch), so
 * churn still counts intervals of the history's own snapshots. Author weights ("a rough share")
 * are not corrected.
 */

import type { History } from '../shape';
import type { Sample } from './commits';
import { MODE, type TreeStore } from './trees';

/** A stored history a refresh can build on, checked against GitHub. */
export type Base = {
  history: History;
  /** Every stored snapshot, newest first, with its root tree as GitHub has it. */
  samples: Sample[];
};

/** Whether `history` can be refreshed at all (else the engine computes from scratch). */
export function refreshable(history: History, repo: string, branch: string): boolean {
  return (
    history.repo.toLowerCase() === repo.toLowerCase() &&
    history.branch === branch &&
    history.snapshots.length >= 2 &&
    history.snapshots[history.snapshots.length - 1]!.sha === history.head &&
    !history.gaps.includes('root-unknown')
  );
}

/** One GraphQL query for every stored snapshot's commit time and root tree. */
export function snapshotQuery(repo: string, shas: readonly string[]): string {
  const [owner, name] = repo.split('/');
  const objects = shas
    .map((sha, i) => `s${i}:object(oid:"${sha}"){... on Commit{committedDate tree{oid}}}`)
    .join(' ');
  return `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${objects}}}`;
}

/**
 * The stored snapshots as samples, newest first, when GitHub has every one of them as a commit
 * at the stored time; else null (the stored history does not describe this repo any more).
 */
export function readSnapshots(history: History, data: Record<string, unknown>): Sample[] | null {
  const repo = data.repository as Record<string, unknown> | null | undefined;
  if (!repo) return null;
  const out: Sample[] = [];
  for (let i = 0; i < history.snapshots.length; i++) {
    const { sha, at } = history.snapshots[i]!;
    const o = repo[`s${i}`] as { committedDate?: unknown; tree?: { oid?: unknown } } | null;
    const tree = o?.tree?.oid;
    if (typeof tree !== 'string' || typeof o?.committedDate !== 'string') return null;
    if (Date.parse(o.committedDate) !== at) return null;
    out.push({ sha, at, tree });
  }
  return out.reverse();
}

/**
 * Which stored snapshots stay. `picked` are the new snapshots, newest first (the head first);
 * `old` the stored ones, newest first (the junction first, the root last). Walking the targets
 * from the first one the picks left free, each takes the newest stored snapshot at or before it
 * that is older than the last one kept, as the engine's probes do; the root always stays. The
 * n-th snapshot below the head is then at or before the n-th target, which is what the history
 * Worker checks (upload.ts followsSchedule).
 */
export function keepOld(
  targets: readonly number[],
  picked: readonly Sample[],
  old: readonly Sample[],
): boolean[] {
  const keep = old.map(() => false);
  const root = old.length - 1;
  let last = picked[picked.length - 1]!.at;
  let c = 0;
  for (let k = picked.length - 1; k < targets.length; k++) {
    while (c < root && (old[c]!.at > targets[k]! || old[c]!.at >= last)) c++;
    if (c >= root) break;
    keep[c] = true;
    last = old[c]!.at;
    c++;
  }
  keep[root] = old[root]!.at < last;
  return keep;
}

/** A dropped stretch: the kept snapshot newer than it, the dropped ones, the kept one older. */
export type Dropped = { newer: Sample; dropped: Sample[]; older: Sample };

/** The dropped stretches of `all` (newest first), where `kept` says which stay. */
export function droppedRuns(all: readonly Sample[], kept: readonly boolean[]): Dropped[] {
  const runs: Dropped[] = [];
  let run: Sample[] = [];
  let newer: Sample | null = null;
  all.forEach((s, i) => {
    if (!kept[i]) return void run.push(s);
    if (run.length > 0 && newer) runs.push({ newer, dropped: run, older: s });
    run = [];
    newer = s;
  });
  return runs;
}

/**
 * Churn to add per path (files by path, folders by `path/`, the root as `/`) when the trees
 * `chain` (newest first: the kept newer snapshot, the dropped ones, the kept older one) become
 * one interval: 1 if the path differs end to end, less 1 for each step where it differed. Only
 * paths present in every tree of the chain, which the history counted in each step.
 */
export function churnDelta(store: TreeStore, chain: readonly number[]): Map<string, number> {
  const out = new Map<string, number>();
  const note = (key: string, refs: readonly number[]) => {
    let steps = 0;
    for (let i = 1; i < refs.length; i++) if (refs[i] !== refs[i - 1]) steps++;
    const whole = refs[0] !== refs[refs.length - 1] ? 1 : 0;
    if (whole !== steps) out.set(key, whole - steps);
  };
  const walk = (trees: readonly number[], path: string) => {
    note(path ? `${path}/` : '/', trees);
    if (trees.every((t) => t === trees[0])) return;
    const names = new Map<string, { refs: number[]; tree: boolean }>();
    trees.forEach((t, i) => {
      for (let e = 0, n = store.length(t); e < n; e++) {
        const mode = store.mode(t, e);
        if (mode === MODE.module) continue;
        const tree = mode === MODE.tree;
        const key = `${tree ? 'd' : 'f'}${store.name(t, e)}`;
        let entry = names.get(key);
        if (!entry) names.set(key, (entry = { refs: [], tree }));
        if (entry.refs.length === i) entry.refs.push(store.ref(t, e));
      }
    });
    for (const [key, { refs, tree }] of names) {
      if (refs.length !== trees.length) continue;
      const kid = path ? `${path}/${key.slice(1)}` : key.slice(1);
      if (tree) walk(refs, kid);
      else note(kid, refs);
    }
  };
  walk(chain, '');
  return out;
}

/** The new snapshots plus the kept stored ones, newest first. */
export function keptSamples(
  picked: readonly Sample[],
  old: readonly Sample[],
  kept: readonly boolean[],
): Sample[] {
  return [...picked, ...old.filter((_, i) => kept[i])];
}
