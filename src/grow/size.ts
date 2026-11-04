import type { Vec3 } from './grow';

/**
 * World size, the same for every repo, so a bigger repo reads as a bigger tree. The island
 * keeps one radius, and a tree's height climbs linearly with log10 of its files, from a
 * sapling at one file to the tallest tree at FILES_AT_TALLEST and beyond.
 */
export const ISLAND_RADIUS = 2;
const HEIGHT = { least: 1, most: 3.8 };
const FILES_AT_TALLEST = 100_000;
/** How far the widest crown reaches from the trunk, and its leaves above its highest twig, by height. */
const CROWN = { reach: 0.66, leaves: 0.08 };

/** Height of the highest twig tip of a tree that holds this many files. */
export function treeHeight(files: number): number {
  const t = Math.min(1, Math.log10(Math.max(1, files)) / Math.log10(FILES_AT_TALLEST));
  return HEIGHT.least + (HEIGHT.most - HEIGHT.least) * t;
}

/**
 * A round stage of radius `radius` as the box whose half diagonal is that radius: the box the
 * framing fits at every spin angle holds exactly the cylinder.
 */
export function roundBox(radius: number, bottom: number, top: number): { min: Vec3; max: Vec3 } {
  const half = radius / Math.SQRT2;
  return { min: [-half, bottom, -half], max: [half, top, half] };
}

/** The room the tallest tree any repo grows can fill; the camera frames it, not the tree on show. */
export const TALLEST = roundBox(HEIGHT.most * CROWN.reach, -0.06, HEIGHT.most * (1 + CROWN.leaves));
