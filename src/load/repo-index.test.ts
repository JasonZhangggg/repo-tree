import { beforeAll, describe, expect, test } from 'vitest';
import { growTree } from '../grow/grow';
import { buildHierarchy, DEFAULT_FILTERS } from '../repo/hierarchy';
import { sample } from '../test/samples';
import { indexRepo, TOP_LANGS, type RepoIndex } from './repo-index';

const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

describe('indexRepo on vitejs/vite', () => {
  let index: RepoIndex;
  let folderPaths: string[];
  beforeAll(async () => {
    const dir = buildHierarchy(await sample('vitejs-vite'), DEFAULT_FILTERS);
    index = indexRepo(dir);
    folderPaths = growTree(dir, { seed: 42, quality: 'low' }).folders.path;
  });

  test('numbers folders like the grown tree', () => {
    expect(index.folders.files.length).toBe(folderPaths.length);
    folderPaths.forEach((path, id) => {
      const parent = index.folders.parent[id]!;
      expect(parent === -1 ? '' : folderPaths[parent]).toBe(id === 0 ? '' : parentPath(path));
    });
  });

  test('counts every file under each folder', () => {
    const { paths } = index.files;
    for (const id of [0, 1, 5, folderPaths.length - 1]) {
      const prefix = folderPaths[id] ? `${folderPaths[id]}/` : '';
      const under = paths.filter((p) => p.startsWith(prefix)).length;
      expect(index.folders.files[id], folderPaths[id]).toBe(under);
    }
  });

  test('files sit in their own folder range', () => {
    const { own } = index.folders;
    folderPaths.forEach((path, id) => {
      for (let f = own[id * 2]!; f < own[id * 2]! + own[id * 2 + 1]!; f++) {
        expect(parentPath(index.files.paths[f]!)).toBe(path);
        expect(index.files.folder[f]).toBe(id);
      }
    });
  });

  test('ranks the root languages by files', () => {
    const counts = Array.from({ length: TOP_LANGS }, (_, k) => index.folders.langs[k * 2 + 1]!);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(index.langs[index.folders.langs[0]!]).toBe('JavaScript');
  });
});
