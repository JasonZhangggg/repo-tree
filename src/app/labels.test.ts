import { describe, expect, test } from 'vitest';
import { pickLabels, relaxLabels, type LabelAnchor } from './labels';

const pill = (x: number, y: number, front = true): LabelAnchor => ({
  x,
  y,
  width: 90,
  height: 28,
  front,
});

type Point = { x: number; y: number };

const overlaps = (placed: { x: number; y: number }[], sizes: LabelAnchor[]) => {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const dx = Math.abs(placed[i]!.x - placed[j]!.x) - (sizes[i]!.width + sizes[j]!.width) / 2;
      const dy = Math.abs(placed[i]!.y - placed[j]!.y) - (sizes[i]!.height + sizes[j]!.height) / 2;
      if (dx < 0 && dy < 0) return true;
    }
  }
  return false;
};

describe('relaxLabels', () => {
  test('moves labels out from the crown middle, and up', () => {
    const center = { x: 400, y: 300 };
    const [left, right] = relaxLabels([pill(300, 300), pill(500, 300)], center);
    expect(left!.x).toBeLessThan(300);
    expect(right!.x).toBeGreaterThan(500);
    expect(left!.y).toBeLessThan(300);
  });

  test('pulls apart labels whose anchors pile up', () => {
    const anchors = [pill(400, 200), pill(405, 210), pill(398, 220), pill(402, 230)];
    expect(overlaps(relaxLabels(anchors, { x: 400, y: 300 }), anchors)).toBe(false);
  });

  test('labels a narrow screen holds at its side stack apart there, inside it', () => {
    // A crown nearly as wide as the screen pushes these past its left edge.
    const anchors = [pill(60, 200), pill(70, 215), pill(65, 230)];
    const placed = relaxLabels(anchors, { x: 200, y: 260, rx: 160, ry: 120 }, [], 400, 6);
    expect(overlaps(placed, anchors)).toBe(false);
    for (const p of placed) expect(p.x - 45).toBeGreaterThanOrEqual(6 - 0.01);
  });

  test('keeps stems from crossing', () => {
    // Left alone, pushing these two apart puts the farther anchor's label below the nearer one's.
    const anchors = [pill(300, 220), pill(360, 270)];
    const [p, q] = relaxLabels(anchors, { x: 400, y: 300, rx: 80, ry: 80 });
    const side = (a: Point, b: Point, c: Point) =>
      Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const [a, b] = [anchors[0]!, anchors[1]!];
    const cross = side(a, p!, b) * side(a, p!, q!) < 0 && side(b, q!, a) * side(b, q!, p!) < 0;
    expect(cross).toBe(false);
  });

  test('moves a label behind the crown more than one in front', () => {
    const anchors = [pill(400, 200, true), pill(400, 205, false)];
    const placed = relaxLabels(anchors, { x: 400, y: 400 });
    const start = relaxLabels([anchors[0]!], { x: 400, y: 400 })[0]!;
    const back = relaxLabels([anchors[1]!], { x: 400, y: 400 })[0]!;
    expect(Math.abs(placed[1]!.y - back.y)).toBeGreaterThan(Math.abs(placed[0]!.y - start.y));
  });
});

test('moves labels off the panels', () => {
  const panel = { x: 0, y: 0, width: 540, height: 260 };
  const [label] = relaxLabels([pill(520, 240)], { x: 700, y: 300 }, [panel]);
  const clear = label!.x - 45 >= 540 || label!.y - 14 >= 260;
  expect(clear).toBe(true);
});

describe('pickLabels', () => {
  const tops = [
    { folder: 1, files: 600 },
    { folder: 2, files: 300 },
    { folder: 3, files: 60 },
    { folder: 4, files: 25 },
    { folder: 5, files: 10 },
    { folder: 6, files: 5 },
  ];

  test('labels top-level folders over 2% of the files, the biggest as major', () => {
    expect(pickLabels(tops, [], 0)).toEqual([
      { folder: 1, files: 600, tier: 'major' },
      { folder: 2, files: 300, tier: 'major' },
      { folder: 3, files: 60, tier: 'top' },
      { folder: 4, files: 25, tier: 'top' },
    ]);
  });

  test('labels at least three top-level folders, however small', () => {
    const few = [
      { folder: 1, files: 1000 },
      { folder: 2, files: 1 },
      { folder: 3, files: 1 },
      { folder: 4, files: 1 },
    ];
    expect(pickLabels(few, [], 0).map((p) => p.folder)).toEqual([1, 2, 3]);
  });

  test('labels at most seven top-level folders', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ folder: i + 1, files: 100 }));
    expect(pickLabels(many, [], 0)).toHaveLength(7);
  });

  test("adds the pinned folder's biggest subfolders as sub labels", () => {
    const children = [
      { folder: 7, files: 200 },
      { folder: 8, files: 90 },
      { folder: 9, files: 2 },
    ];
    const subs = pickLabels(tops, children, 300).filter((p) => p.tier === 'sub');
    expect(subs.map((p) => p.folder)).toEqual([7, 8]);
  });

  test('labels a pinned folder deep in the crown, but not one already labeled', () => {
    const deep = pickLabels(tops, [], 4, 42).filter((p) => p.tier === 'pin');
    expect(deep).toEqual([{ folder: 42, files: 4, tier: 'pin' }]);
    expect(pickLabels(tops, [], 600, 1).filter((p) => p.tier === 'pin')).toEqual([]);
    expect(pickLabels(tops, [], 0, 0).filter((p) => p.tier === 'pin')).toEqual([]);
  });
});
