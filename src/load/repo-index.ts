import type { Dir } from '../repo/hierarchy';
import type { Lang } from '../repo/languages';

export const TOP_LANGS = 4;

/**
 * What the panels and search need to know about a grown repo, as flat arrays so it crosses
 * from the worker without cloning a hundred thousand objects. Folders follow
 * TreeModel.folders (preorder, root first); files are grouped by folder in the same order.
 */
export type RepoIndex = {
  /** Languages, most files first; `folders.langs` points into it. */
  langs: Lang[];
  folders: {
    parent: Int32Array;
    /** Files at any depth. */
    files: Uint32Array;
    bytes: Float64Array;
    /** Per folder, TOP_LANGS [lang, files] pairs, most files first, padded with -1. */
    langs: Int32Array;
    /** Per folder, [first, count] of its own files in `files`. */
    own: Uint32Array;
  };
  files: { paths: string[]; size: Float64Array; folder: Uint32Array };
};

export function indexRepo(root: Dir): RepoIndex {
  const dirs: Dir[] = [];
  const parents: number[] = [];
  const visit = (dir: Dir, parent: number) => {
    const id = dirs.length;
    dirs.push(dir);
    parents.push(parent);
    for (const child of dir.dirs) visit(child, id);
  };
  visit(root, -1);

  const langs = [...root.langs].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
  const langId = new Map(langs.map((lang, i) => [lang, i]));

  const files = new Uint32Array(dirs.length);
  const bytes = new Float64Array(dirs.length);
  const top = new Int32Array(dirs.length * TOP_LANGS * 2).fill(-1);
  const own = new Uint32Array(dirs.length * 2);
  const paths: string[] = [];
  const size: number[] = [];
  const folder: number[] = [];

  dirs.forEach((dir, id) => {
    files[id] = dir.fileCount;
    bytes[id] = dir.bytes;
    [...dir.langs]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_LANGS)
      .forEach(([lang, n], k) => {
        top[(id * TOP_LANGS + k) * 2] = langId.get(lang)!;
        top[(id * TOP_LANGS + k) * 2 + 1] = n;
      });
    own[id * 2] = paths.length;
    own[id * 2 + 1] = dir.files.length;
    for (const file of dir.files) {
      paths.push(file.path);
      size.push(file.size);
      folder.push(id);
    }
  });

  return {
    langs,
    folders: { parent: Int32Array.from(parents), files, bytes, langs: top, own },
    files: { paths, size: Float64Array.from(size), folder: Uint32Array.from(folder) },
  };
}
