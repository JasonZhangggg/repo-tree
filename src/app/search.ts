export type SearchHit = {
  kind: 'folder' | 'file';
  /** Index into the folder or file list the search was built from. */
  id: number;
  path: string;
  /** Positions in `path` that matched the query, for highlighting. */
  marks: number[];
};

const TIER = 10_000;
const isWordStart = (path: string, i: number) => i === 0 || '/-_. '.includes(path[i - 1]!);

/**
 * Builds a search over folder and file paths. A name equal to the query ranks first, then a
 * name starting with it, a name containing it, a path containing it, and last the query's
 * letters in order anywhere in the path. Shorter paths win ties. The root folder ('') is
 * never a result.
 */
export function createSearch(folders: readonly string[], files: readonly string[]) {
  const lower = [...folders, ...files].map((path) => path.toLowerCase());
  const folderCount = folders.length;

  return (query: string, limit = 20): SearchHit[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const best: { at: number; score: number }[] = [];
    for (let at = 0; at < lower.length; at++) {
      const path = lower[at]!;
      if (!path) continue;
      const score = scoreOf(path, q);
      if (score === null) continue;
      if (best.length === limit && score <= best[limit - 1]!.score) continue;
      let i = best.length;
      while (i > 0 && best[i - 1]!.score < score) i--;
      best.splice(i, 0, { at, score });
      if (best.length > limit) best.pop();
    }
    return best.map(({ at }) => {
      const isFolder = at < folderCount;
      const path = isFolder ? folders[at]! : files[at - folderCount]!;
      return {
        kind: isFolder ? 'folder' : 'file',
        id: isFolder ? at : at - folderCount,
        path,
        marks: marksOf(lower[at]!, q),
      };
    });
  };
}

function scoreOf(path: string, q: string): number | null {
  const name = path.lastIndexOf('/') + 1;
  const inName = path.indexOf(q, name);
  if (inName === name) return (path.length - name === q.length ? 5 : 4) * TIER - path.length;
  if (inName > 0) return 3 * TIER - path.length;
  const inPath = path.indexOf(q);
  if (inPath >= 0) return 2 * TIER + (isWordStart(path, inPath) ? 500 : 0) - path.length;
  const marks = fuzzy(path, q);
  if (!marks) return null;
  let bonus = 0;
  marks.forEach((at, k) => {
    if (isWordStart(path, at)) bonus += 200;
    if (k > 0 && marks[k - 1] === at - 1) bonus += 100;
  });
  const spread = marks[marks.length - 1]! - marks[0]!;
  return TIER + bonus - 10 * spread - path.length;
}

function fuzzy(path: string, q: string): number[] | null {
  const marks: number[] = [];
  let from = 0;
  for (const ch of q) {
    const at = path.indexOf(ch, from);
    if (at < 0) return null;
    marks.push(at);
    from = at + 1;
  }
  return marks;
}

function marksOf(path: string, q: string): number[] {
  const name = path.lastIndexOf('/') + 1;
  const inName = path.indexOf(q, name);
  const at = inName >= 0 ? inName : path.indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, k) => at + k);
  return fuzzy(path, q) ?? [];
}
