import { describe, expect, test } from 'vitest';
import type { Loaded } from '../load/load-in-worker';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { treeHeight } from '../grow/size';
import {
  languageRows,
  partnerChoices,
  sharedRank,
  sizeLine,
  sizeScales,
  treeStats,
} from './compare';

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

  test('ranks languages by their share of each tree, and lists each tree’s count', () => {
    const a = stats([
      ['TypeScript', 50],
      ['CSS', 5],
    ]);
    const b = stats([
      ['C', 40],
      ['TypeScript', 20],
      ['Markdown', 1],
    ]);
    // Shares of each tree: TypeScript 50/55 + 20/61, C 40/61, CSS 5/55, Markdown 1/61.
    const rank = sharedRank(a, b);
    expect(rank.get('TypeScript')).toBeCloseTo(50 / 55 + 20 / 61);
    expect(rank.get('C')).toBeCloseTo(40 / 61);
    expect(rank.get('CSS')).toBeCloseTo(5 / 55);
    expect(languageRows([a, b], 3)).toEqual([
      { lang: 'TypeScript', files: [50, 20] },
      { lang: 'C', files: [0, 40] },
      { lang: 'CSS', files: [5, 0] },
    ]);
  });

  test('says how the sizes compare', () => {
    expect(
      sizeLine([
        { name: 'vite', files: 2916 },
        { name: 'dotfiles', files: 36 },
      ]),
    ).toBe('vite has 81× the files of dotfiles');
    expect(
      sizeLine([
        { name: 'a', files: 30 },
        { name: 'b', files: 100 },
      ]),
    ).toBe('b has 3.3× the files of a');
    expect(
      sizeLine([
        { name: 'a', files: 100 },
        { name: 'b', files: 102 },
      ]),
    ).toBe('a and b have about as many files');
    // With more trees, the biggest against the smallest.
    const three = [
      { name: 'vite', files: 2916 },
      { name: 'dotfiles', files: 36 },
      { name: 'react', files: 2410 },
    ];
    expect(sizeLine(three)).toBe("vite has the most files, 81× dotfiles's");
  });

  test('offers recent repos, then samples, leaving out those already compared', () => {
    const choices = partnerChoices(
      [ref('vitejs/vite'), ref('acme/web')],
      ['vitejs/vite', 'facebook/react', 'ACME/web', 'facebook/react'],
    );
    expect(choices.recent).toEqual([ref('facebook/react')]);
    expect(choices.samples).toEqual([ref('mathiasbynens/dotfiles'), ref('torvalds/linux')]);
  });
});

describe('sizeScales', () => {
  test('keeps the biggest tree and shrinks the others by the cube root of their files', () => {
    const [a, b, c] = sizeScales([2898, 900, 2898]);
    expect(a).toBe(1);
    expect(c).toBe(1);
    // vite is 3.2× the files: a tree beside it stands about 1/1.48 of its height.
    expect((treeHeight(900) * b!) / treeHeight(2898)).toBeCloseTo(Math.cbrt(900 / 2898), 5);
    expect(sizeScales([900, 2898])).toEqual([b, 1]);
  });

  test('never grows a tree, and keeps a tiny one big enough to see', () => {
    expect(sizeScales([500, 500])).toEqual([1, 1]);
    const [, b] = sizeScales([80_000, 1]);
    expect(treeHeight(1) * b!).toBeCloseTo(0.35, 5);
  });
});
