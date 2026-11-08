import type { TreeModel } from '../grow/grow';

/** How a compared branch marks a file (by RepoIndex.files id) and a leaf: 0 is untouched. */
export const DIFF = { changed: 1, added: 2, removed: 3 } as const;

/**
 * Each leaf's mark, as one per leaf of each sprig (`perLeaf` vertices a leaf). A sprig stands for
 * a run of files, so its leaves split by them: the share of its files a branch deletes falls
 * (at least one leaf when any is), the share it adds shines new (at least one), and the rest
 * light as changed when any of its files changed, else stay untouched. Deleted leaves come
 * first in the sprig, then new ones.
 */
export function diffLeaves(
  { sprigs }: Pick<TreeModel, 'sprigs'>,
  files: Uint8Array,
  perLeaf: number,
): Uint8Array {
  const count = Math.max(0, sprigs.vertex.length - 1);
  const leaves = Math.floor((sprigs.vertex[count] ?? 0) / perLeaf);
  const marks = new Uint8Array(leaves);
  for (let s = 0; s < count; s++) {
    let added = 0;
    let removed = 0;
    let changed = 0;
    const n = sprigs.file[s + 1]! - sprigs.file[s]!;
    for (let k = sprigs.file[s]!; k < sprigs.file[s + 1]!; k++) {
      const mark = files[sprigs.files[k]!] ?? 0;
      if (mark === DIFF.added) added++;
      else if (mark === DIFF.removed) removed++;
      else if (mark === DIFF.changed) changed++;
    }
    if (!added && !removed && !changed) continue;
    const first = Math.floor(sprigs.vertex[s]! / perLeaf);
    const total = Math.floor(sprigs.vertex[s + 1]! / perLeaf) - first;
    const share = (k: number) =>
      k ? Math.min(total, Math.max(1, Math.round((total * k) / n))) : 0;
    const fall = share(removed);
    const fresh = Math.min(total - fall, share(added));
    const rest = changed ? DIFF.changed : 0;
    for (let i = 0; i < total; i++) {
      marks[first + i] = i < fall ? DIFF.removed : i < fall + fresh ? DIFF.added : rest;
    }
  }
  return marks;
}
