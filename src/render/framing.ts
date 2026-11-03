import type { Vec3 } from '../grow/grow';

export const FOV = 30;
const TAN_HALF_FOV = Math.tan(((FOV / 2) * Math.PI) / 180);
/** The approved three-quarter view: a little right of and above the crown. */
const VIEW_DIRECTION: Vec3 = [0.3, 0.12, 0.95];

export type Box = { min: Vec3; max: Vec3 };
export type Framing = { target: Vec3; position: Vec3; minDistance: number; maxDistance: number };

/**
 * The approved mock's framing, made aspect-aware: fit the crown's bounding sphere vertically
 * and its widest horizontal extent across the narrower of the two fields of view, so the
 * crown stays in frame at any spin angle and on a portrait phone.
 */
export function frameTree({ min, max }: Box, aspect: number): Framing {
  const center = mid(min, max);
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const radius = Math.max(...size) * 0.62;
  const across = Math.hypot(size[0], size[2]) * 0.5;
  const a = Math.max(0.3, aspect);
  const distance =
    Math.max(radius / TAN_HALF_FOV, (across * 1.05) / (TAN_HALF_FOV * a)) * (a < 1 ? 1 : 1.05);
  const target: Vec3 = [center[0], center[1] * 0.92, center[2]];
  return {
    target,
    position: along(target, VIEW_DIRECTION, distance),
    minDistance: distance * 0.35,
    maxDistance: distance * 2.2,
  };
}

/** Camera distance that fits a sphere of `radius` inside both fields of view. */
export function fitDistance(radius: number, aspect: number): number {
  return (radius * 1.15) / (TAN_HALF_FOV * Math.min(1, aspect));
}

export function along(from: Vec3, direction: Vec3, distance: number): Vec3 {
  const k = distance / Math.hypot(...direction);
  return [from[0] + direction[0] * k, from[1] + direction[1] * k, from[2] + direction[2] * k];
}

const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
