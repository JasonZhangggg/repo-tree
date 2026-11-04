import type { Vec3 } from './grow';

/**
 * World size, the same for every repo, so a bigger repo reads as a bigger tree. The island
 * keeps one radius, and a tree's height grows as a power of its files, reaching the tallest
 * tree at FILES_AT_TALLEST: ten times the files makes a tree about 1.5 times as tall, so two
 * repos side by side differ plainly. A floor keeps the smallest repos big enough to point at.
 */
export const ISLAND_RADIUS = 2;
const HEIGHT = { least: 0.9, most: 3.8, power: 0.18 };
const FILES_AT_TALLEST = 100_000;
/** How far the widest crown reaches from the trunk, and its leaves above its highest twig, by height. */
const CROWN = { reach: 0.66, leaves: 0.08 };

/** Height of the highest twig tip of a tree that holds this many files. */
export function treeHeight(files: number): number {
  const t = Math.min(1, Math.max(1, files) / FILES_AT_TALLEST) ** HEIGHT.power;
  return Math.max(HEIGHT.least, HEIGHT.most * t);
}

/**
 * How many twigs a crown may open: TWIGS.least up to TWIGS.from files, climbing with log10 of the
 * files to TWIGS.most at FILES_AT_TALLEST, so a bigger repo shows more detail as well as size.
 */
const TWIGS = { least: 200, most: 260, from: 3000 };
export function twigBudget(files: number): number {
  const t = Math.log10(Math.max(1, files) / TWIGS.from) / Math.log10(FILES_AT_TALLEST / TWIGS.from);
  return Math.round(TWIGS.least + (TWIGS.most - TWIGS.least) * Math.min(1, Math.max(0, t)));
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
