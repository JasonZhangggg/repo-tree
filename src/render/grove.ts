/**
 * Where trees compared side by side stand: not all in a line, but in a small grove. Two stand
 * side by side; three make a triangle, four a square and five two rows (three behind, two in
 * front, in the gaps), each a regular shape one island pitch to a side, so the grove is as even
 * from above as from the front. All stand on one level; the tallest take the back, so no short tree
 * stands behind a tall one, and the view looks down on a grove with rows (`GROVE_LEVEL` in
 * tree-view.ts) so the back row shows over the front one. Within a row the trees keep the card's
 * order, left to right.
 */

/** A spot in the grove, in island pitches: `across` to screen right, `toward` the camera. */
export type GroveSpot = { across: number; toward: number };

/** The rows of a shape made of equilateral triangles stand this far apart, in island pitches. */
export const TRIANGLE_ROWS = Math.sqrt(3) / 2;

/** Each shape's spots, back row first, each row left to right, and how far apart its rows stand. */
const SHAPES: Record<number, { back: number[]; front: number[]; rows: number }> = {
  1: { back: [], front: [0], rows: 0 },
  2: { back: [], front: [-0.5, 0.5], rows: 0 },
  3: { back: [0], front: [-0.5, 0.5], rows: TRIANGLE_ROWS },
  4: { back: [-0.5, 0.5], front: [-0.5, 0.5], rows: 1 },
  5: { back: [-1, 0, 1], front: [-0.5, 0.5], rows: TRIANGLE_ROWS },
};

/**
 * The spot of each tree, in the order given (the tree on show first), moved so the first stands
 * at the origin. `heights` are the trees' heights as they will show.
 */
export function groveSpots(heights: readonly number[]): GroveSpot[] {
  const n = heights.length;
  const shape = SHAPES[n];
  if (!shape) {
    // Past the shapes, a line, as before.
    return heights.map((_, i) => ({ across: i, toward: 0 }));
  }
  const depth = shape.rows / 2;
  // The tallest go to the back row; ties keep the card's order.
  const byHeight = heights
    .map((h, i) => ({ h, i }))
    .sort((x, y) => y.h - x.h || x.i - y.i)
    .map(({ i }) => i);
  const back = byHeight.slice(0, shape.back.length).sort((x, y) => x - y);
  const front = byHeight.slice(shape.back.length).sort((x, y) => x - y);
  const spots: GroveSpot[] = new Array(n);
  back.forEach((tree, k) => {
    spots[tree] = { across: shape.back[k]!, toward: -depth };
  });
  front.forEach((tree, k) => {
    spots[tree] = { across: shape.front[k]!, toward: depth };
  });
  const first = spots[0]!;
  return spots.map((s) => ({
    across: s.across - first.across,
    toward: s.toward - first.toward,
  }));
}
