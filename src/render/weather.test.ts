import { describe, expect, test } from 'vitest';
import { ISLAND_RADIUS, roundBox, treeHeight } from '../grow/size';
import { SKIES } from '../repo/ci';
import { frameTree, SKY_LIFT, skyTop, stage, type Box } from './framing';
import { InstancedBufferGeometry, Mesh, PerspectiveCamera, ShaderMaterial, Vector4 } from 'three';
import { PALETTES } from './palette';
import { cloudCount, cloudDeck, createWeather, DECK } from './weather';

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

describe('rain', () => {
  /**
   * Where each drop's head is, as FALL_VERTEX places it (wind and snow aside): `k` how far down
   * its fall, `y` its height, or null where it never falls.
   */
  const heads = (fall: Mesh, count: number) => {
    const u = (fall.material as ShaderMaterial).uniforms;
    const clouds = u.uClouds!.value as Vector4[];
    const [g0, g1] = u.uGround!.value as [number, number];
    const drop = fall.geometry.getAttribute('aDrop');
    const which = fall.geometry.getAttribute('aWhich');
    const n = u.uCount!.value as number;
    return Array.from({ length: count }, (_, i) => {
      const cloud = clouds[Math.min(Math.floor(which.getX(i) * n), n - 1)]!;
      const x = cloud.x + drop.getX(i) * u.uFootprint!.value * cloud.w;
      const z = cloud.z + drop.getY(i) * u.uFootprint!.value * cloud.w;
      const r = Math.hypot(x, z);
      if (r > u.uRim!.value || cloud.w < 0.001) return null;
      const top = cloud.y + 0.05 * cloud.w;
      const ground = g0 - g1 * Math.min(1, r / u.uRadius!.value) ** 2;
      const k = (drop.getZ(i) + u.uFallen!.value * (0.8 + 0.4 * drop.getW(i))) % 1;
      return { k, y: top - k * (top - ground) };
    });
  };

  test('a drop only ever falls, however long the page is open and the view changes', () => {
    const camera = new PerspectiveCamera();
    const weather = createWeather(camera);
    const fall = weather.objects[3] as Mesh;
    const tree = treeOf(TREES.vite);
    const views = [
      { eye: 2, top: 9 },
      { eye: 3.5, top: 12 },
    ];
    weather.set({
      sky: 'storm',
      palette: PALETTES.spring,
      quality: 'high',
      still: false,
      night: false,
    });
    weather.setStage(tree, views[0]!, true);
    const count = (fall.geometry as InstancedBufferGeometry).instanceCount;
    expect(count).toBeGreaterThan(0);
    let before = heads(fall, count);
    let rises = 0;
    // Ten minutes at 20 frames a second, the view changing every half minute.
    for (let frame = 1; frame <= 20 * 60 * 10; frame++) {
      if (frame % 600 === 0) weather.setStage(tree, views[(frame / 600) % 2]!, true);
      weather.tick(1 / 20);
      const now = heads(fall, count);
      now.forEach((head, i) => {
        const was = before[i];
        // A drop that starts over at its cloud is a new drop.
        if (head && was && head.k > was.k && head.y > was.y) rises++;
      });
      before = now;
    }
    expect(rises).toBe(0);
  }, 30_000);
});
