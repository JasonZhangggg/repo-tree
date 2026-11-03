import { describe, expect, test } from 'vitest';
import { createSearch } from './search';

const FOLDERS = [
  '',
  'docs',
  'packages',
  'packages/vite',
  'packages/vite/src/node/server',
  'src',
  'src/app',
  'src/render',
];
const FILES = [
  'README.md',
  'docs/search-guide.md',
  'packages/vite/src/node/server/index.ts',
  'packages/vite/src/node/server/hmr.ts',
  'scripts/release.mjs',
  'src/app/search.ts',
  'src/app/state.ts',
  'src/render/tree-view.ts',
];
const search = createSearch(FOLDERS, FILES);
const paths = (query: string, limit?: number) => search(query, limit).map((hit) => hit.path);

describe('search', () => {
  test('ranks a name that starts with the query above one that only contains it', () => {
    expect(paths('search')).toEqual(['src/app/search.ts', 'docs/search-guide.md']);
  });

  test('puts the folder named exactly the query before the files inside it', () => {
    expect(paths('server')).toEqual([
      'packages/vite/src/node/server',
      'packages/vite/src/node/server/hmr.ts',
      'packages/vite/src/node/server/index.ts',
    ]);
  });

  test('matches letters in order across words, preferring word starts', () => {
    expect(paths('trv')[0]).toBe('src/render/tree-view.ts');
    expect(paths('srvidx')).toEqual(['packages/vite/src/node/server/index.ts']);
  });

  test('ignores case, matches across slashes and never returns the root', () => {
    expect(paths('STATE')).toEqual(['src/app/state.ts']);
    expect(paths('app/st')[0]).toBe('src/app/state.ts');
    expect(paths('')).toEqual([]);
    expect(paths('   ')).toEqual([]);
  });

  test('caps the results and tells folders from files', () => {
    expect(paths('s', 3)).toHaveLength(3);
    const [folder] = search('render');
    expect(folder).toMatchObject({ kind: 'folder', id: 7, path: 'src/render' });
    const [file] = search('hmr');
    expect(file).toMatchObject({ kind: 'file', id: 3 });
  });

  test('marks the matched characters', () => {
    expect(search('tv')[0]).toMatchObject({ path: 'src/render/tree-view.ts', marks: [11, 16] });
  });
});
