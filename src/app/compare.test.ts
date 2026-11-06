import { describe, expect, test } from 'vitest';
import type { Loaded } from '../load/load-in-worker';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { defaultPartner, languageRows, sharedRank, sizeLine, treeStats } from './compare';

const ref = (input: string) => parseRepoRef(input) as RepoRef;
const stats = (langs: [string, number][]) => ({
  files: langs.reduce((sum, [, n]) => sum + n, 0),
  folders: 1,
  depth: 1,
  bytes: 0,
  langs: langs.map(([lang, files]) => ({ lang, files })),
});

describe('compare', () => {
  test('counts files, folders and the deepest folder from the index', () => {
    const loaded = {
      // root, src, src/app, src/app/ui, docs
      index: {
        folders: {
          parent: Int32Array.from([-1, 0, 1, 2, 0]),
          files: Uint32Array.from([12, 9, 5, 2, 3]),
          bytes: Float64Array.from([4000, 3000, 2000, 500, 1000]),
        },
      },
      tree: { langs: [{ lang: 'TypeScript', files: 9 }] },
    } as unknown as Loaded;
    expect(treeStats(loaded)).toEqual({
      files: 12,
      folders: 4,
      depth: 3,
      bytes: 4000,
      langs: [{ lang: 'TypeScript', files: 9 }],
    });
  });

  test('ranks languages across both trees, and lists each tree’s count', () => {
    const a = stats([
      ['TypeScript', 50],
      ['CSS', 5],
    ]);
    const b = stats([
      ['C', 40],
      ['TypeScript', 20],
      ['Markdown', 1],
    ]);
    expect([...sharedRank(a, b)]).toEqual([
      ['TypeScript', 70],
      ['CSS', 5],
      ['C', 40],
      ['Markdown', 1],
    ]);
    expect(languageRows(a, b, 3)).toEqual([
      { lang: 'TypeScript', a: 50, b: 20 },
      { lang: 'C', a: 0, b: 40 },
      { lang: 'CSS', a: 5, b: 0 },
    ]);
  });

  test('says how the sizes compare', () => {
    expect(sizeLine({ name: 'vite', files: 2916 }, { name: 'dotfiles', files: 36 })).toBe(
      'vite has 81× the files of dotfiles',
    );
    expect(sizeLine({ name: 'a', files: 30 }, { name: 'b', files: 100 })).toBe(
      'b has 3.3× the files of a',
    );
    expect(sizeLine({ name: 'a', files: 100 }, { name: 'b', files: 102 })).toBe(
      'a and b have about as many files',
    );
  });

  test('opens beside the most recent other repo, else a quick sample that is not on show', () => {
    expect(defaultPartner(ref('vitejs/vite'), ['vitejs/vite', 'facebook/react'])).toEqual(
      ref('facebook/react'),
    );
    expect(defaultPartner(ref('acme/web'), [])).toEqual(ref('vitejs/vite'));
    expect(defaultPartner(ref('ViteJS/vite'), [])).toEqual(ref('mathiasbynens/dotfiles'));
  });
});
