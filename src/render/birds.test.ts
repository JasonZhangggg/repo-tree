import { describe, expect, test } from 'vitest';
import { BIRD_SIZE, perchOnCrown } from './birds';

/** Leaves as a flat field of vertices: each `[x, y, z, node]`. */
const leavesOf = (points: [number, number, number, number][]) => ({
  position: new Float32Array(points.flatMap(([x, y, z]) => [x, y, z])),
  nodeId: new Float32Array(points.map((p) => p[3])),
});

describe('perchOnCrown', () => {
  test('stands a bird on the highest leaf under it, never above empty air', () => {
    const leaves = leavesOf([
      [0.01, 1, 0.01, 3],
      [0.02, 2, 0.02, 3],
      [0.03, 1.5, 0.03, 3],
    ]);
    const [spot] = perchOnCrown([{ anchor: [0, 1.2, 0], range: [3, 3] }], leaves);
    expect(spot!.at[1]).toBeCloseTo(2);
    expect(spot!.at[0]).toBeCloseTo(0.02);
  });

  test("prefers a leaf of the bird's own folder over a nearer one of another", () => {
    const leaves = leavesOf([
      [0, 2, 0, 1],
      [1, 2, 0, 5],
    ]);
    const [spot] = perchOnCrown([{ anchor: [0, 2, 0], range: [4, 6] }], leaves);
    expect(spot!.at[0]).toBeCloseTo(1);
  });

  test('keeps birds on one folder apart, so none overlap', () => {
    const step = BIRD_SIZE * 0.3;
    const points: [number, number, number, number][] = [];
    for (let i = 0; i < 20; i++)
      for (let j = 0; j < 20; j++) points.push([i * step, 2, j * step, 1]);
    const birds = Array.from({ length: 4 }, () => ({
      anchor: [1, 2, 1] as [number, number, number],
      range: [1, 1] as const,
    }));
    const spots = perchOnCrown(birds, leavesOf(points));
    for (let a = 0; a < spots.length; a++) {
      for (let b = a + 1; b < spots.length; b++) {
        const [p, q] = [spots[a]!.at, spots[b]!.at];
        expect(Math.hypot(p[0] - q[0], p[2] - q[2])).toBeGreaterThan(BIRD_SIZE * 0.8);
      }
    }
  });
});
