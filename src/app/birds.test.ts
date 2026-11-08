import { describe, expect, test } from 'vitest';
import { birdsFrom, FLEDGLING, PLUMAGE, plumageOf, pullFiles } from './birds';
import type { OpenPull } from '../repo/pulls';

const pull = (number: number, files: string[], over: Partial<OpenPull> = {}): OpenPull => ({
  number,
  title: `PR ${number}`,
  author: 'octo',
  url: `https://github.com/o/r/pull/${number}`,
  draft: false,
  updatedAt: 0,
  files,
  ...over,
});
const folderIds = new Map([
  ['', 0],
  ['src', 1],
  ['src/app', 2],
  ['docs', 3],
]);

describe('birdsFrom', () => {
  test('each PR perches on its folder, in order, and a PR with no files stays off', () => {
    const birds = birdsFrom(
      {
        pulls: [
          pull(1, ['src/app/a.ts']),
          pull(2, []),
          pull(3, ['docs/a.md', 'docs/b.md', 'README.md']),
        ],
        total: 3,
      },
      folderIds,
    );
    expect(birds.map((b) => [b.pull.number, b.folder])).toEqual([
      [1, 2],
      [3, 3],
    ]);
  });

  test('one author keeps one plumage; a draft is a pale fledgling', () => {
    const birds = birdsFrom(
      { pulls: [pull(1, ['a']), pull(2, ['b']), pull(3, ['c'], { draft: true })], total: 3 },
      folderIds,
    );
    expect(birds[0]!.color).toBe(birds[1]!.color);
    expect(PLUMAGE).toContain(birds[0]!.color);
    expect(birds[2]!.color).toBe(FLEDGLING);
  });

  test('plumage spreads across authors and ignores case', () => {
    const names = Array.from({ length: 40 }, (_, i) => `dev${i}`);
    expect(new Set(names.map(plumageOf)).size).toBeGreaterThan(PLUMAGE.length / 2);
    expect(plumageOf('Octo')).toBe(plumageOf('octo'));
  });
});

describe('pullFiles', () => {
  test('marks each changed file the tree has, and counts the ones it lacks', () => {
    const paths = ['README.md', 'src/a.ts', 'src/b.ts', 'docs/x.md'];
    const { lit, shown, missing } = pullFiles(
      ['src/b.ts', 'README.md', 'src/new.ts', 'src/b.ts', 'node_modules/x/index.js'],
      paths,
    );
    expect([...lit]).toEqual([1, 0, 1, 0]);
    expect(shown).toBe(2);
    expect(missing).toBe(2);
  });
});
