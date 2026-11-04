import { describe, expect, test } from 'vitest';
import { ISLAND_RADIUS, roundBox, treeHeight } from '../grow/size';
import { SKIES } from '../repo/ci';
import { frameTree, SKY_LIFT, skyTop, stage, type Box } from './framing';
import { cloudCount, cloudDeck, DECK } from './weather';

/** A tree of this many files: its crown about two thirds of its height wide. */
const treeOf = (files: number): Box => {
  const height = treeHeight(files);
  return roundBox(height * 0.66, -0.06, height * 1.08);
};
const TREES = { sapling: 1, dotfiles: 36, vite: 2_898, linux: 97_141, biggest: 1_000_000 };
const ASPECTS = { 'phone portrait': 390 / 844, square: 1, laptop: 16 / 10 };

describe('cloudDeck', () => {
  for (const [name, files] of Object.entries(TREES)) {
    for (const [view, aspect] of Object.entries(ASPECTS)) {
      test(`keeps clouds out of the way of a ${name} tree on a ${view}`, () => {
        const tree = treeOf(files);
        const whole = frameTree(stage(true), aspect, SKY_LIFT);
        const view = { eye: whole.position[1], top: skyTop(whole) };
        const { base, reach } = cloudDeck(tree, view);
        // Every cloud lies at or above `base`. Any sight line from the camera (at `eye`, at any
        // spin angle) to a point of the crown stays at or below the higher of the two, so no
        // cloud can come between the camera and the crown or its labels.
        expect(base).toBeGreaterThanOrEqual(Math.max(view.eye, tree.max[1]) + DECK.least);
        // Up to the room the view leaves, the clouds float well over the crown.
        expect(base).toBeGreaterThanOrEqual(
          Math.min(tree.max[1] + DECK.gap, view.top - DECK.room) - 1e-9,
        );
        // Clouds drift over the island, so the rain under them lands on it.
        expect(reach).toBeLessThan(ISLAND_RADIUS);
      });
    }
  }

  test('rises with the tree, so a bigger repo lifts its clouds', () => {
    const whole = frameTree(stage(true), 1.2, SKY_LIFT);
    const view = { eye: whole.position[1], top: skyTop(whole) };
    const bases = Object.values(TREES).map((files) => cloudDeck(treeOf(files), view).base);
    for (let i = 1; i < bases.length; i++) expect(bases[i]).toBeGreaterThanOrEqual(bases[i - 1]!);
  });

  test('leaves a medium tree a clear gap of sky on a laptop', () => {
    const whole = frameTree(stage(true), 1.2, SKY_LIFT);
    const view = { eye: whole.position[1], top: skyTop(whole) };
    const tree = treeOf(TREES.vite);
    expect(cloudDeck(tree, view).base - tree.max[1]).toBeGreaterThanOrEqual(0.9);
  });
});

test('more clouds gather as CI breaks, and a clear sky has none', () => {
  const counts = SKIES.map(cloudCount);
  expect(counts[0]).toBe(0);
  for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]!);
});
