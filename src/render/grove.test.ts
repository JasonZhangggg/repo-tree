import { describe, expect, test } from 'vitest';
import { BACK_LIFT, groveSpots } from './grove';

const absolute = (heights: number[]) => {
  // Back to the shape's own frame: the lowest row at lift 0, centered across.
  const spots = groveSpots(heights);
  const low = Math.min(...spots.map((s) => s.lift));
  const mid =
    (Math.min(...spots.map((s) => s.across)) + Math.max(...spots.map((s) => s.across))) / 2;
  return spots.map((s) => ({ across: +(s.across - mid).toFixed(3), back: s.lift - low > 0 }));
};

describe('groveSpots', () => {
  test('the tree on show stands at the origin', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const first = groveSpots(Array.from({ length: n }, (_, i) => n - i))[0]!;
      expect(first).toEqual({ across: 0, toward: 0, lift: 0 });
    }
  });

  test('two stand side by side in the card order', () => {
    expect(groveSpots([1, 2])).toEqual([
      { across: 0, toward: 0, lift: 0 },
      { across: 1, toward: 0, lift: 0 },
    ]);
  });

  test('three make a triangle with the tallest at the back', () => {
    expect(absolute([1, 3, 2])).toEqual([
      { across: -0.55, back: false },
      { across: 0, back: true },
      { across: 0.55, back: false },
    ]);
  });

  test('four make a square, the two tallest behind, each row in card order', () => {
    expect(absolute([4, 1, 3, 2])).toEqual([
      { across: -0.5, back: true },
      { across: -0.5, back: false },
      { across: 0.5, back: true },
      { across: 0.5, back: false },
    ]);
  });

  test('five stand three behind and two in front, in the gaps', () => {
    const spots = absolute([1, 5, 2, 4, 3]);
    expect(spots.filter((s) => s.back).map((s) => s.across)).toEqual([-1, 0, 1]);
    expect(spots.filter((s) => !s.back).map((s) => s.across)).toEqual([-0.5, 0.5]);
    expect(spots[0]!.back).toBe(false);
  });

  test('the back row floats higher and further from the camera', () => {
    const spots = groveSpots([1, 3, 2]);
    expect(spots[1]!.lift).toBeCloseTo(BACK_LIFT);
    expect(spots[1]!.toward).toBeLessThan(0);
  });
});
