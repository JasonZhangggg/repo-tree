import { describe, expect, test } from 'vitest';
import { DIFF, diffLeaves } from './diff';

describe('diffLeaves', () => {
  // Three sprigs of 4, 2 and 2 leaves (one vertex a leaf) over files [0..3], [4], [5, 6].
  const sprigs = {
    vertex: new Uint32Array([0, 4, 6, 8]),
    file: new Uint32Array([0, 4, 5, 7]),
    files: new Uint32Array([0, 1, 2, 3, 4, 5, 6]),
  };
  const model = { sprigs } as never;

  test('a sprig splits its leaves by its files: deleted fall, new shine, the rest light', () => {
    const files = new Uint8Array(7);
    files[0] = DIFF.removed;
    files[1] = DIFF.added;
    files[2] = DIFF.changed;
    files[4] = DIFF.removed;
    expect([...diffLeaves(model, files, 1)]).toEqual([
      DIFF.removed,
      DIFF.added,
      DIFF.changed,
      DIFF.changed,
      DIFF.removed,
      DIFF.removed,
      0,
      0,
    ]);
  });

  test('a deleted file among many still drops a leaf, and nothing lights without a change', () => {
    const files = new Uint8Array(7);
    files[3] = DIFF.removed;
    expect([...diffLeaves(model, files, 1)]).toEqual([DIFF.removed, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('leaves span several vertices each', () => {
    const files = new Uint8Array(7);
    files[5] = DIFF.added;
    expect([...diffLeaves(model, files, 2)]).toEqual([0, 0, 0, DIFF.added]);
  });
});
