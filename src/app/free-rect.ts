export type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * The region of a `width` by `height` view that no panel covers, keeping `gap` clear of each,
 * where `fit(w, h)`, the size the tree takes in a w by h region, is largest. Every edge of
 * the best region lies on a view edge or a panel edge, so trying each combination finds it.
 */
export function freeRect(
  width: number,
  height: number,
  panels: Rect[],
  gap: number,
  fit: (w: number, h: number) => number,
): Rect {
  const blocks = panels.map((p) => ({
    left: p.left - gap,
    top: p.top - gap,
    right: p.right + gap,
    bottom: p.bottom + gap,
  }));
  const lefts = [0, ...blocks.map((b) => b.right)];
  const rights = [width, ...blocks.map((b) => b.left)];
  const tops = [0, ...blocks.map((b) => b.bottom)];
  const bottoms = [height, ...blocks.map((b) => b.top)];
  let best: Rect = { left: 0, top: 0, right: width, bottom: height };
  let bestScore = -1;
  for (const left of lefts)
    for (const right of rights)
      for (const top of tops)
        for (const bottom of bottoms) {
          if (left < 0 || top < 0 || right > width || bottom > height) continue;
          const w = right - left;
          const h = bottom - top;
          if (w <= 0 || h <= 0) continue;
          const covered = blocks.some(
            (b) => b.left < right && b.right > left && b.top < bottom && b.bottom > top,
          );
          if (covered) continue;
          const score = fit(w, h) + (w * h) / (width * height) / 1000;
          if (score > bestScore) {
            bestScore = score;
            best = { left, top, right, bottom };
          }
        }
  return best;
}
