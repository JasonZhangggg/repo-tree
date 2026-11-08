import { describe, expect, test } from 'vitest';
import { addedPaths, diffMarks, parseCompare, parseRefNames } from './branch-diff';

describe('parseCompare', () => {
  test('reads statuses, splits a rename, and drops unchanged files', () => {
    const diff = parseCompare(
      {
        ahead_by: 3,
        behind_by: 1,
        files: [
          { filename: 'a.ts', status: 'modified' },
          { filename: 'b.ts', status: 'added' },
          { filename: 'c.ts', status: 'removed' },
          { filename: 'd/new.ts', status: 'renamed', previous_filename: 'd/old.ts' },
          { filename: 'e.ts', status: 'copied' },
          { filename: 'f.ts', status: 'unchanged' },
          { filename: 'g.ts', status: 'changed' },
          { status: 'added' },
        ],
      },
      'main',
      'feat',
    );
    expect(diff).toEqual({
      base: 'main',
      head: 'feat',
      ahead: 3,
      behind: 1,
      capped: false,
      files: [
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'added' },
        { path: 'c.ts', status: 'removed' },
        { path: 'd/old.ts', status: 'removed' },
        { path: 'd/new.ts', status: 'added' },
        { path: 'e.ts', status: 'added' },
        { path: 'g.ts', status: 'modified' },
      ],
    });
    expect(addedPaths(diff!)).toEqual(['b.ts', 'd/new.ts', 'e.ts']);
  });

  test('marks a 300-file list as capped, and is null for anything but a comparison', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: 'added' }));
    expect(parseCompare({ ahead_by: 1, behind_by: 0, files }, 'm', 'h')!.capped).toBe(true);
    expect(parseCompare({ message: 'Not Found' }, 'm', 'h')).toBeNull();
    expect(parseCompare(null, 'm', 'h')).toBeNull();
  });
});

describe('diffMarks', () => {
  test('marks each file by its status and counts those the tree lacks', () => {
    const { marks, counts, off } = diffMarks(
      {
        base: 'main',
        head: 'feat',
        ahead: 1,
        behind: 0,
        capped: false,
        files: [
          { path: 'a', status: 'modified' },
          { path: 'b', status: 'added' },
          { path: 'c', status: 'removed' },
          { path: 'vendor/x', status: 'modified' },
        ],
      },
      ['c', 'a', 'b', 'd'],
    );
    expect([...marks]).toEqual([3, 1, 2, 0]);
    expect(counts).toEqual({ added: 1, modified: 2, removed: 1 });
    expect(off).toBe(1);
  });
});

test('parseRefNames reads names from a branches or tags body', () => {
  expect(parseRefNames([{ name: 'main' }, { name: '' }, {}, { name: 'v1' }])).toEqual([
    'main',
    'v1',
  ]);
  expect(parseRefNames({})).toBeNull();
});
