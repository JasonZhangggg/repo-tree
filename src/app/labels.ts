const HEIGHT = 28;
const GAP = 6;
const LIFT = 30;
const ROUNDS = 30;

/**
 * Places labels just above their anchors, then nudges overlapping pairs apart vertically
 * until none overlap (the mock's relaxation). Returns each label's center.
 */
export function relaxLabels(
  anchors: ReadonlyArray<{ x: number; y: number; width: number }>,
): { x: number; y: number }[] {
  const placed = anchors.map((a) => ({ x: a.x, y: a.y - LIFT, width: a.width }));
  for (let round = 0; round < ROUNDS; round++) {
    for (const a of placed) {
      for (const b of placed) {
        if (a === b) continue;
        const overlapX = (a.width + b.width) / 2 + GAP - Math.abs(a.x - b.x);
        const overlapY = HEIGHT + GAP - Math.abs(a.y - b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const away = a.y <= b.y ? -1 : 1;
        a.y += away * overlapY * 0.5;
        b.y -= away * overlapY * 0.5;
      }
    }
  }
  return placed.map(({ x, y }) => ({ x, y }));
}
