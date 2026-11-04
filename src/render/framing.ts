import type { Vec3 } from '../grow/grow';
import { ISLAND } from '../grow/ground';
import { TALLEST } from '../grow/size';

export const FOV = 30;
const TAN_HALF_FOV = Math.tan(((FOV / 2) * Math.PI) / 180);
/** The approved three-quarter view: a little right of and above the crown. */
export const VIEW_DIRECTION: Vec3 = [0.3, 0.12, 0.95];

export type Box = { min: Vec3; max: Vec3 };
/**
 * The whole view looks this share of the stage's height higher (`frameTree`'s `lift`), so the
 * island sits a little lower in the room the panels leave and the sky over the crown has room
 * for the weather's clouds and sun. The island's round, tapering underside keeps it in frame.
 */
export const SKY_LIFT = 0.08;
export type Framing = { target: Vec3; position: Vec3; minDistance: number; maxDistance: number };

/** The height of the top edge of the view where it passes over the target, for a framing. */
export function skyTop({ target, position }: Framing): number {
  return target[1] + distanceOf(position, target) * TAN_HALF_FOV;
}

/**
 * What the whole view frames: the tallest tree any repo grows, on the island while it shows.
 * It is the same for every repo, so a bigger repo shows as a bigger tree.
 */
export function stage(ground: boolean): Box {
  if (!ground) return TALLEST;
  return {
    min: [0, 1, 2].map((i) => Math.min(TALLEST.min[i]!, ISLAND.min[i]!)) as Vec3,
    max: [0, 1, 2].map((i) => Math.max(TALLEST.max[i]!, ISLAND.max[i]!)) as Vec3,
  };
}

/**
 * The approved mock's framing, made aspect-aware: fit the crown's bounding sphere vertically
 * and its widest horizontal extent across the narrower of the two fields of view, so the
 * crown stays in frame at any spin angle and on a portrait phone. `lift` raises where it looks
 * by that share of the box's height (SKY_LIFT for the whole view).
 */
export function frameTree({ min, max }: Box, aspect: number, lift = 0): Framing {
  const center = mid(min, max);
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const radius = Math.max(...size) * 0.62;
  const across = Math.hypot(size[0], size[2]) * 0.5;
  const a = Math.max(0.3, aspect);
  const distance =
    Math.max(radius / TAN_HALF_FOV, (across * 1.05) / (TAN_HALF_FOV * a)) * (a < 1 ? 1 : 1.05);
  const target: Vec3 = [center[0], center[1] * 0.92 + size[1] * lift, center[2]];
  return {
    target,
    position: along(target, VIEW_DIRECTION, distance),
    minDistance: distance * 0.35,
    maxDistance: distance * 2.2,
  };
}

/** A pinned folder's bounding sphere, padded by this much, fills the view. */
const FOLDER_PADDING = 1.7;
/**
 * A pinned folder never brings the camera closer than this share of the distance that frames
 * the tree on show, so a small folder is seen on its branch, with the faded rest of the crown
 * around it.
 */
export const FOLDER_MIN_SHARE = 0.5;

/**
 * Where the camera looks and how far it stands to frame a folder's bounding sphere. The zoom
 * floor follows the tree on show, so a sapling's folder comes as close as a big tree's; the
 * camera never stands further back than the whole `room` (the stage) or nearer than its orbit
 * limit.
 */
export function frameFolder(
  folder: { center: Vec3; radius: number },
  tree: Box,
  aspect: number,
  room: Box = tree,
): { target: Vec3; distance: number } {
  const whole = frameTree(room, aspect);
  const wholeDistance = distanceOf(whole.position, whole.target);
  const own = frameTree(tree, aspect);
  const floor = Math.max(
    Math.min(distanceOf(own.position, own.target), wholeDistance) * FOLDER_MIN_SHARE,
    whole.minDistance,
  );
  const fit = (folder.radius * FOLDER_PADDING) / (TAN_HALF_FOV * Math.min(1, aspect));
  return {
    target: folder.center,
    distance: Math.min(wholeDistance, Math.max(fit, floor)),
  };
}

export const distanceOf = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function along(from: Vec3, direction: Vec3, distance: number): Vec3 {
  const k = distance / Math.hypot(...direction);
  return [from[0] + direction[0] * k, from[1] + direction[1] * k, from[2] + direction[2] * k];
}

const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
