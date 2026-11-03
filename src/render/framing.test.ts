import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import type { Vec3 } from '../grow/grow';
import { FOV, frameTree, type Box } from './framing';

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
