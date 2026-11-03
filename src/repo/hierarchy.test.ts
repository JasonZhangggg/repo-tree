import { describe, expect, test } from 'vitest';
import { sample } from '../test/samples';
import type { Snapshot } from './github';
import { buildHierarchy, DEFAULT_FILTERS, type Dir } from './hierarchy';
import { parseRepoRef, type RepoRef } from './ref';

const names = (dir: Dir) => dir.dirs.map((d) => d.name);
const find = (dir: Dir, path: string): Dir | undefined =>
  dir.path === path ? dir : dir.dirs.map((d) => find(d, path)).find(Boolean);

describe('buildHierarchy on mathiasbynens/dotfiles', () => {
  test('rolls file counts, bytes and languages up to the root', async () => {
    const root = buildHierarchy(await sample('mathiasbynens-dotfiles'), DEFAULT_FILTERS);

    expect(root).toMatchObject({ path: '', name: 'dotfiles', fileCount: 36, bytes: 142961 });
    expect(root.files).toHaveLength(26);
    expect(names(root)).toEqual(['.vim', 'bin', 'init']);
    expect(Object.fromEntries(root.langs)).toEqual({
      Other: 25,
      Shell: 4,
      'Vim Script': 4,
      Markdown: 1,
      Text: 1,
      JSON: 1,
    });
  });

  test('builds nested folders with their own totals', async () => {
    const root = buildHierarchy(await sample('mathiasbynens-dotfiles'), DEFAULT_FILTERS);

    const vim = find(root, '.vim');
    expect(vim).toMatchObject({ name: '.vim', fileCount: 5, bytes: 44768 + 2087 });
    expect(vim && names(vim)).toEqual(['backups', 'colors', 'swaps', 'syntax', 'undo']);
    expect(find(root, '.vim/colors')).toMatchObject({
      name: 'colors',
      fileCount: 1,
      files: [{ path: '.vim/colors/solarized.vim', size: 44768 }],
    });
    expect(find(root, 'init')).toMatchObject({ fileCount: 4, bytes: 838 + 5494 + 5706 + 1409 });
    expect(find(root, 'bin')).toMatchObject({ fileCount: 1, bytes: 62 });
  });

  test('hides folders by exact name at any depth', async () => {
    const snapshot = await sample('mathiasbynens-dotfiles');

    const top = buildHierarchy(snapshot, { hidden: ['.vim'] });
    expect(top.fileCount).toBe(31);
    expect(names(top)).toEqual(['bin', 'init']);
    expect(top.langs.get('Vim Script' as never)).toBe(2);

    const nested = buildHierarchy(snapshot, { hidden: ['colors', 'vi'] });
    expect(nested.fileCount).toBe(35);
    expect(find(nested, '.vim')).toMatchObject({ fileCount: 4 });
    expect(find(nested, '.vim/colors')).toBeUndefined();
  });

  test('drops folders that filters leave without files', async () => {
    const root = buildHierarchy(await sample('mathiasbynens-dotfiles'), {
      hidden: ['backups', 'colors', 'swaps', 'syntax', 'undo'],
    });

    expect(root.fileCount).toBe(31);
    expect(names(root)).toEqual(['bin', 'init']);
  });
});

test('default filters hide dependency and build output folders', () => {
  const snapshot: Snapshot = {
    ref: parseRepoRef('o/r') as RepoRef,
    branch: 'main',
    sha: 'f00d',
    truncated: false,
    fetchedAt: 0,
    files: [
      'src/a.ts',
      'node_modules/x/index.js',
      'packages/web/node_modules/y/index.js',
      'packages/web/dist/app.js',
      'target/debug/app',
      'lib/__pycache__/m.pyc',
      'lib/m.py',
    ].map((path) => ({ path, size: 1 })),
  };

  const root = buildHierarchy(snapshot, DEFAULT_FILTERS);

  expect(root.fileCount).toBe(2);
  expect(names(root)).toEqual(['src', 'lib']);
});

test('builds the linux tree in well under 200 ms', async () => {
  const snapshot = await sample('torvalds-linux');
  buildHierarchy(snapshot, DEFAULT_FILTERS);

  const start = performance.now();
  const root = buildHierarchy(snapshot, DEFAULT_FILTERS);
  const elapsed = performance.now() - start;

  expect(root.fileCount).toBe(97359 - 218);
  expect(find(root, 'drivers/target')).toBeUndefined();
  expect(elapsed).toBeLessThan(200);
});
