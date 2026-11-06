import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import type { Vec3 } from '../grow/grow';
import {
  distanceOf,
  FOLDER_MIN_SHARE,
  FOV,
  frameFolder,
  frameGrove,
  frameTree,
  type Box,
} from './framing';

const TREES: Record<string, Box> = {
  'wide crown': { min: [-1.4, -0.06, -1.1], max: [1.3, 2.2, 1.2] },
  'tall sapling': { min: [-0.5, -0.06, -0.4], max: [0.6, 2.4, 0.5] },
};
const ASPECTS = {
  'phone portrait': 390 / 844,
  tablet: 0.75,
  square: 1,
  laptop: 16 / 10,
  wide: 21 / 9,
};

/** The bounding box corners in normalized device coordinates, seen from `angle` around the target. */
function cornersOnScreen(box: Box, aspect: number, angle: number): Vector3[] {
  const framing = frameTree(box, aspect);
  const target = new Vector3(...framing.target);
  const camera = new PerspectiveCamera(FOV, aspect, 0.05, 200);
  camera.position
    .set(...framing.position)
    .sub(target)
    .applyAxisAngle(new Vector3(0, 1, 0), angle)
    .add(target);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  const corners: Vector3[] = [];
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) corners.push(new Vector3(x, y, z).project(camera));
  return corners;
}

describe.each(Object.entries(TREES))('frameTree on a %s', (_, box) => {
  test.each(Object.entries(ASPECTS))(
    'keeps the whole tree in frame at every spin angle on a %s',
    (_, aspect) => {
      for (let step = 0; step < 12; step++) {
        for (const corner of cornersOnScreen(box, aspect, (step / 12) * Math.PI * 2)) {
          expect(Math.abs(corner.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(corner.y)).toBeLessThanOrEqual(1);
        }
      }
    },
  );

  test('fills at least half the height of a landscape view', () => {
    const ys = cornersOnScreen(box, 16 / 10, 0).map((c) => c.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1);
  });

  test('looks at the crown from a little right of and above it', () => {
    const { target, position } = frameTree(box, 1);
    const offset: Vec3 = [
      position[0] - target[0],
      position[1] - target[1],
      position[2] - target[2],
    ];
    expect(offset[0]).toBeGreaterThan(0);
    expect(offset[1]).toBeGreaterThan(0);
    expect(offset[2]).toBeGreaterThan(Math.abs(offset[0]));
  });
});

describe('frameFolder', () => {
  const tree = TREES['wide crown']!;
  const whole = (aspect: number) => {
    const { position, target } = frameTree(tree, aspect);
    return distanceOf(position, target);
  };

  test.each(Object.entries(ASPECTS))('keeps a small folder in context on a %s', (_, aspect) => {
    const twig = frameFolder({ center: [0.9, 1.8, 0.4], radius: 0.05 }, tree, aspect);
    expect(twig.target).toEqual([0.9, 1.8, 0.4]);
    expect(twig.distance).toBeGreaterThanOrEqual(whole(aspect) * FOLDER_MIN_SHARE);
  });

  test('stands back further for a bigger folder', () => {
    const limb = frameFolder({ center: [0.5, 1.4, 0], radius: 0.9 }, tree, 1.6);
    const twig = frameFolder({ center: [0.5, 1.4, 0], radius: 0.4 }, tree, 1.6);
    expect(limb.distance).toBeGreaterThan(twig.distance);
  });

  test("zooms a small tree's folder in by its own size, not the stage's", () => {
    const sapling = TREES['tall sapling']!;
    const own = (() => {
      const { position, target } = frameTree(sapling, 1.6);
      return distanceOf(position, target);
    })();
    const room = { min: [-2, -1, -2], max: [2, 4, 2] } as Box;
    const roomDistance = (() => {
      const { position, target } = frameTree(room, 1.6);
      return distanceOf(position, target);
    })();
    const twig = frameFolder({ center: [0.3, 1.8, 0.2], radius: 0.05 }, sapling, 1.6, room);
    expect(twig.distance).toBeLessThan(roomDistance * FOLDER_MIN_SHARE);
    expect(twig.distance).toBeGreaterThanOrEqual(
      Math.max(Math.min(own, roomDistance) * FOLDER_MIN_SHARE, frameTree(room, 1.6).minDistance) -
        1e-9,
    );
    const crown = frameFolder({ center: [0, 1.1, 0], radius: 3 }, sapling, 1.6, room);
    expect(crown.distance).toBeCloseTo(roomDistance);
  });

  test('never stands further back than the whole tree', () => {
    const crown = frameFolder({ center: [0, 1.1, 0], radius: 3 }, tree, 1.6);
    expect(crown.distance).toBeCloseTo(whole(1.6));
  });
});

describe('frameGrove', () => {
  const grove = { center: [0, 2, 0] as [number, number, number], across: 12, deep: 6, tall: 4 };

  test('a wide grove in a wide region is fitted by its width, snugly', () => {
    const { position, target } = frameGrove(grove, 1.6, 0, 0.45);
    const distance = distanceOf(position, target);
    // The width it shows is no more than the view's, and not much less.
    const view =
      2 *
      (distance - (grove.deep / 2) * Math.cos(0.45)) *
      Math.tan((FOV / 2) * (Math.PI / 180)) *
      1.6;
    expect(grove.across / view).toBeGreaterThan(0.8);
    expect(grove.across / view).toBeLessThanOrEqual(1);
  });

  test('stands nearer than a sphere round the same grove would put it', () => {
    const box = {
      min: [-6, 0, -3] as [number, number, number],
      max: [6, 4, 3] as [number, number, number],
    };
    const sphere = frameTree(box, 1.6);
    const snug = frameGrove(grove, 1.6, 0, 0.45);
    expect(distanceOf(snug.position, snug.target)).toBeLessThan(
      distanceOf(sphere.position, sphere.target),
    );
  });

  test('a narrow region stands further back for the same grove', () => {
    const wide = frameGrove(grove, 1.6, 0, 0.45);
    const narrow = frameGrove(grove, 0.6, 0, 0.45);
    expect(distanceOf(narrow.position, narrow.target)).toBeGreaterThan(
      distanceOf(wide.position, wide.target),
    );
  });
});
