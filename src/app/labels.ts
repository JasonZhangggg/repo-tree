const GAP = 6;
/** How far a label sits out past the crown's outline (or its anchor, if that is farther), and lifted. */
const PUSH = 18;
const LIFT = 8;
const ROUNDS = 40;
/** A label on the far side of the crown gives way this much more than one in front. */
const BACK_YIELD = 4;
/** Steps a label turns through on its way up past a crown that fills the screen's width. */
const TURN_STEPS = 12;
/** How deep into the crown's outline (1 is its rim) a label held at the screen's side may reach. */
const COVER = 0.75;

export type Box = { x: number; y: number; width: number; height: number };

export type LabelAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** On the near side of the crown. */
  front: boolean;
};

/** The crown's outline on screen. */
export type Crown = { x: number; y: number; rx?: number; ry?: number };

/**
 * Places each label just outside the crown's outline, on the line from the crown's middle
 * through its anchor, so labels ring the crown like callouts with a stem in to their section
 * instead of covering its leaves. Overlapping pairs are then pushed apart along the axis they
 * overlap least on, labels behind the crown giving way first, and moved off any of `panels`
 * the short way. With `width`, every label stays `edge` inside 0..width throughout, so labels
 * that a narrow screen pins to its side stack apart there instead of piling up after the fact.
 * Returns each label's center.
 */
export function relaxLabels(
  anchors: ReadonlyArray<LabelAnchor>,
  crown: Crown,
  panels: ReadonlyArray<Box> = [],
  width = Infinity,
  edge = 0,
): { x: number; y: number }[] {
  const { rx = 0, ry = 0 } = crown;
  const placed = anchors.map((a) => {
    const dx = a.x - crown.x;
    const dy = a.y - crown.y;
    const d = Math.hypot(dx, dy);
    const start = d > 1 ? Math.atan2(dy, dx) : -Math.PI / 2;
    // Out along the line from the crown's middle through the anchor, just past the outline (or
    // the anchor, if farther) and the label's own half-size that way.
    const at = (angle: number) => {
      const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
      const rim = rx > 0 && ry > 0 ? 1 / Math.hypot(ux / rx, uy / ry) : 0;
      const half = Math.abs(ux) * (a.width / 2) + Math.abs(uy) * (a.height / 2);
      const out = Math.max(d, rim) + PUSH + half;
      return { x: crown.x + ux * out, y: crown.y + uy * out - LIFT };
    };
    // A crown about as wide as the screen leaves no room beside it, and the screen's side would
    // hold such a label over the leaves: turn it up into the sky, a step at a time, until where
    // the side holds it no longer covers the crown's body.
    let spot = at(start);
    const covers = ({ x, y }: { x: number; y: number }) => {
      if (!(width < Infinity && rx > 0 && ry > 0)) return false;
      const half = a.width / 2 + edge;
      if (width > 2 * half) x = Math.min(Math.max(x, half), width - half);
      // The box's nearest point to the crown's middle, measured in the outline's own units.
      const nx = Math.max(Math.abs(x - crown.x) - a.width / 2, 0) / rx;
      const ny = Math.max(Math.abs(y - crown.y) - a.height / 2, 0) / ry;
      return Math.hypot(nx, ny) < COVER;
    };
    if (covers(spot)) {
      const up = -Math.PI / 2;
      const turn = start > Math.PI / 2 ? start - 2 * Math.PI : start;
      for (let step = 1; step <= TURN_STEPS && covers(spot); step++) {
        spot = at(turn + ((up - turn) * step) / TURN_STEPS);
      }
    }
    return { ...spot, w: a.width, h: a.height, give: a.front ? 1 : BACK_YIELD };
  });
  const keepIn = () => {
    for (const p of placed) {
      const half = p.w / 2 + edge;
      if (width > 2 * half) p.x = Math.min(Math.max(p.x, half), width - half);
    }
  };
  const atSide = (p: { x: number; w: number }) =>
    width < Infinity && (p.x - p.w / 2 - edge < 0.5 || p.x + p.w / 2 + edge > width - 0.5);
  const relax = () => {
    keepIn();
    for (let round = 0; round < ROUNDS; round++) {
      let moved = false;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i]!;
          const b = placed[j]!;
          const overlapX = (a.w + b.w) / 2 + GAP - Math.abs(a.x - b.x);
          const overlapY = (a.h + b.h) / 2 + GAP - Math.abs(a.y - b.y);
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          const shareA = a.give / (a.give + b.give);
          // Labels are much wider than tall, so moving apart vertically is usually the short way,
          // and the only way for a label the screen's side holds in place.
          if (overlapY < overlapX * 1.6 || atSide(a) || atSide(b)) {
            const away = a.y < b.y || (a.y === b.y && i < j) ? -1 : 1;
            a.y += away * overlapY * shareA;
            b.y -= away * overlapY * (1 - shareA);
          } else {
            const away = a.x < b.x ? -1 : 1;
            a.x += away * overlapX * shareA;
            b.x -= away * overlapX * (1 - shareA);
          }
        }
      }
      keepIn();
      if (!moved) break;
    }
  };
  relax();
  // Stems that cross read as pointing at each other's sections: swap those labels' places.
  for (let pass = 0; pass < 3; pass++) {
    let swapped = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        if (!crosses(anchors[i]!, a, anchors[j]!, b)) continue;
        [a.x, b.x, a.y, b.y] = [b.x, a.x, b.y, a.y];
        swapped = true;
      }
    }
    if (!swapped) break;
    relax();
  }
  // Then off any panel, the short way out, and apart again from what that moved them into.
  for (let pass = 0; pass < 2 && panels.length > 0; pass++) {
    for (const p of placed) {
      for (const panel of panels) {
        const left = p.x + p.w / 2 + GAP - panel.x;
        const right = panel.x + panel.width + GAP - (p.x - p.w / 2);
        const up = p.y + p.h / 2 + GAP - panel.y;
        const down = panel.y + panel.height + GAP - (p.y - p.h / 2);
        if (left <= 0 || right <= 0 || up <= 0 || down <= 0) continue;
        const least = Math.min(left, right, up, down);
        if (least === left) p.x -= left;
        else if (least === right) p.x += right;
        else if (least === up) p.y -= up;
        else p.y += down;
      }
    }
    if (pass === 0) relax();
  }
  return placed.map(({ x, y }) => ({ x, y }));
}

type Point = { x: number; y: number };

/** Whether segment p1-p2 crosses segment q1-q2. */
function crosses(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const side = (a: Point, b: Point, c: Point) =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  return side(p1, p2, q1) * side(p1, p2, q2) < 0 && side(q1, q2, p1) * side(q1, q2, p2) < 0;
}

/** Which folders to label, and how prominently. */
export type LabelPick = {
  folder: number;
  files: number;
  tier: 'major' | 'top' | 'sub' | 'pin';
};

const TOP = { max: 7, least: 3, share: 0.02, major: 0.15 };
const SUB = { max: 6, least: 2, share: 0.04 };

/**
 * Top-level folders holding at least 2% of the tree's files get labels, at most 7 and at least
 * 3; those over 15% are major. With a folder pinned, its biggest subfolders get labels too, and
 * the pinned folder its own, so a small folder deep in the crown can be found.
 */
export function pickLabels(
  tops: ReadonlyArray<{ folder: number; files: number }>,
  children: ReadonlyArray<{ folder: number; files: number }>,
  pinnedFiles: number,
  pinned?: number,
): LabelPick[] {
  const total = tops.reduce((sum, t) => sum + t.files, 0) || 1;
  const keep = <T extends { files: number }>(
    list: ReadonlyArray<T>,
    whole: number,
    { max, least, share }: { max: number; least: number; share: number },
  ) =>
    [...list]
      .sort((a, b) => b.files - a.files)
      .filter((t, i) => i < max && (i < least || t.files >= whole * share));
  const picked: LabelPick[] = keep(tops, total, TOP).map(({ folder, files }) => ({
    folder,
    files,
    tier: files >= total * TOP.major ? 'major' : 'top',
  }));
  for (const { folder, files } of keep(children, pinnedFiles || 1, SUB)) {
    if (!picked.some((p) => p.folder === folder)) picked.push({ folder, files, tier: 'sub' });
  }
  if (pinned !== undefined && pinned !== 0 && !picked.some((p) => p.folder === pinned)) {
    picked.push({ folder: pinned, files: pinnedFiles, tier: 'pin' });
  }
  return picked;
}
