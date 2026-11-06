/**
 * Where trees compared side by side stand: not all in a line, but in a small grove. Two stand
 * side by side; three make a triangle, four a square and five two rows (three behind, two in
 * front, in the gaps). The back row floats a little higher, so the trees in front hide less of
 * it, and the tallest trees take the back, so no short tree stands behind a tall one. Within a
 * row the trees keep the card's order, left to right.
 */

/** A spot in the grove, in island pitches: `across` to screen right, `toward` the camera. */
export type GroveSpot = { across: number; toward: number; lift: number };

/** How much higher the back row floats, in island pitches. */
export const BACK_LIFT = 0.5;

/** Each shape's spots, back row first, each row left to right. */
const SHAPES: Record<number, { back: number[]; front: number[] }> = {
  1: { back: [], front: [0] },
  2: { back: [], front: [-0.5, 0.5] },
  3: { back: [0], front: [-0.55, 0.55] },
  4: { back: [-0.5, 0.5], front: [-0.5, 0.5] },
  5: { back: [-1, 0, 1], front: [-0.5, 0.5] },
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
    return heights.map((_, i) => ({ across: i, toward: 0, lift: 0 }));
  }
  const depth = shape.back.length ? 0.6 : 0;
  // The tallest go to the back row; ties keep the card's order.
  const byHeight = heights
    .map((h, i) => ({ h, i }))
    .sort((x, y) => y.h - x.h || x.i - y.i)
    .map(({ i }) => i);
  const back = byHeight.slice(0, shape.back.length).sort((x, y) => x - y);
  const front = byHeight.slice(shape.back.length).sort((x, y) => x - y);
  const spots: GroveSpot[] = new Array(n);
  back.forEach((tree, k) => {
    spots[tree] = { across: shape.back[k]!, toward: -depth, lift: BACK_LIFT };
  });
  front.forEach((tree, k) => {
    spots[tree] = { across: shape.front[k]!, toward: depth, lift: 0 };
  });
  const first = spots[0]!;
  return spots.map((s) => ({
    across: s.across - first.across,
    toward: s.toward - first.toward,
    lift: s.lift - first.lift,
  }));
}
