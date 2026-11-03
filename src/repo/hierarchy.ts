import type { FileEntry, Snapshot } from './github';
import { langOf, type Lang } from './languages';

export type Dir = {
  path: string;
  name: string;
  dirs: Dir[];
  files: FileEntry[];
  fileCount: number;
  bytes: number;
  langs: Map<Lang, number>;
};
/** Folder names hidden at any depth, matched exactly. */
export type Filters = { hidden: ReadonlyArray<string> };

export const DEFAULT_FILTERS: Filters = {
  hidden: [
    'node_modules',
    'vendor',
    'third_party',
    'dist',
    'build',
    '.git',
    'bower_components',
    '__pycache__',
    '.next',
    'target',
    'coverage',
  ],
};

export function buildHierarchy(snapshot: Snapshot, filters: Filters): Dir {
  const hidden = new Set(filters.hidden);
  const root = dir('', snapshot.ref.repo);
  const byPath = new Map<string, Dir | null>([['', root]]);
  const created: Dir[] = [root];

  const dirAt = (path: string): Dir | null => {
    const known = byPath.get(path);
    if (known !== undefined) return known;
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    const parent = hidden.has(name) ? null : dirAt(slash < 0 ? '' : path.slice(0, slash));
    let made: Dir | null = null;
    if (parent) {
      made = dir(path, name);
      parent.dirs.push(made);
      created.push(made);
    }
    byPath.set(path, made);
    return made;
  };

  for (const file of snapshot.files) {
    const slash = file.path.lastIndexOf('/');
    const owner = dirAt(slash < 0 ? '' : file.path.slice(0, slash));
    if (!owner) continue;
    owner.files.push(file);
    owner.fileCount++;
    owner.bytes += file.size;
    const lang = langOf(file.path);
    owner.langs.set(lang, (owner.langs.get(lang) ?? 0) + 1);
  }

  for (let i = created.length - 1; i >= 0; i--) {
    const d = created[i]!;
    d.dirs = d.dirs.filter((child) => child.fileCount > 0);
    for (const child of d.dirs) {
      d.fileCount += child.fileCount;
      d.bytes += child.bytes;
      for (const [lang, n] of child.langs) d.langs.set(lang, (d.langs.get(lang) ?? 0) + n);
    }
  }
  return root;
}

function dir(path: string, name: string): Dir {
  return { path, name, dirs: [], files: [], fileCount: 0, bytes: 0, langs: new Map() };
}
