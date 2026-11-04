import type { History } from '../repo/history';

export type Author = History['owners'][number]['authors'][number];

/** Who to ask about one top-level folder ('' for the files at the root). */
export type FolderOwner = {
  /**
   * CODEOWNERS' first owner when it names one, else the author with the most recent commits
   * (exact, per folder), then the most weight; null when neither.
   */
  owner: string | null;
  from: 'codeowners' | 'authors' | null;
  /** Up to 5, no bots, most recent commits first, then most weight. */
  authors: Author[];
  codeowners: string[];
};

/** The history's owners, by top-level folder path. */
export type Owners = {
  folders: Map<string, FolderOwner>;
  /** `History.recent.since`: authors' `commits` count from here (0: from the first commit). */
  since: number;
  /** Where the owners came from: CODEOWNERS for all, commit authors for all, both, or nowhere. */
  from: 'codeowners' | 'authors' | 'mixed' | null;
  /** CODEOWNERS could not be read, so every owner is a commit author. */
  codeownersUnread: boolean;
};

/** The label of the leaves whose folder has no owner the history knows. */
export const NO_OWNER = 'No known owner';

const byCommits = (a: Author, b: Author) =>
  b.commits - a.commits || b.weight - a.weight || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** One owners row as the view uses it: CODEOWNERS wins, else the busiest recent author. */
export function folderOwner(row: History['owners'][number]): FolderOwner {
  const authors = [...row.authors].sort(byCommits);
  const codeowners = row.codeowners;
  if (codeowners.length > 0)
    return { owner: codeowners[0]!, from: 'codeowners', authors, codeowners };
  const top = authors[0];
  return { owner: top?.name ?? null, from: top ? 'authors' : null, authors, codeowners };
}

export function historyOwners(history: History): Owners {
  const folders = new Map(history.owners.map((row) => [row.folder, folderOwner(row)]));
  const sources = new Set([...folders.values()].map((o) => o.from).filter((f) => f !== null));
  return {
    folders,
    from: sources.size > 1 ? 'mixed' : (sources.values().next().value ?? null),
    since: history.recent.since,
    codeownersUnread: history.gaps.includes('codeowners-unread'),
  };
}

/**
 * Leaf categories by owner over the tree's top-level folders (`folder` '' for the root's own
 * files): one per distinct owner, with the files of every folder it owns, so owners shared
 * across folders share a color. `categoryOf[i]` is folder `i`'s category.
 */
export function ownerCategories(
  tops: ReadonlyArray<{ folder: string; files: number }>,
  owners: Owners,
): {
  categories: { label: string; files: number }[];
  categoryOf: number[];
} {
  const at = new Map<string, number>();
  const categories: { label: string; files: number }[] = [];
  const categoryOf = tops.map(({ folder, files }) => {
    const row = owners.folders.get(folder);
    const label = row?.owner ?? NO_OWNER;
    let i = at.get(label);
    if (i === undefined) {
      at.set(label, (i = categories.length));
      categories.push({ label, files: 0 });
    }
    categories[i]!.files += files;
    return i;
  });
  return { categories, categoryOf };
}
