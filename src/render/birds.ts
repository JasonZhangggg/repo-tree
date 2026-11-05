import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { Vec3 } from '../grow/grow';

/** A bird on the crown: where its feet are, which way is out from the trunk there, its plumage. */
export type Perched = { at: Vec3; out: Vec3; color: string };

/** A bird's length, beak to tail, in world units: under two leaves. */
export const BIRD_SIZE = 0.27;
/** The crown's top is read on a grid of cells this many bird lengths wide; a bird takes one. */
const CELL = 0.9;
/** Birds grow in over the last part of the tree's growth, out of their perch. */
export const BIRD_T: [number, number] = [0.82, 1];

type Part = 'body' | 'wing' | 'breast' | 'beak' | 'eye';
/**
 * One low-poly bird in its own frame: +x is where it looks, +y up, +z its right; its feet are at
 * the origin and it is one unit long. Its head sits on a short neck. Each triangle names the part its color comes from.
 */
const BIRD: [Part, Vec3, Vec3, Vec3][] = (() => {
  const F: Vec3 = [0.26, 0.2, 0]; // chest front
  const B: Vec3 = [-0.24, 0.24, 0]; // rump
  const U: Vec3 = [0, 0.38, 0]; // back
  const D: Vec3 = [0.02, 0.04, 0]; // belly, over the feet
  const L: Vec3 = [0, 0.22, -0.15];
  const R: Vec3 = [0, 0.22, 0.15];
  const H: Vec3 = [0.3, 0.42, 0]; // head
  const hr = 0.11;
  const head = (dx: number, dy: number, dz: number): Vec3 => [H[0] + dx, H[1] + dy, H[2] + dz];
  const hF = head(hr, 0, 0);
  const hB = head(-hr, -0.02, 0);
  const hU = head(0, hr, 0);
  const hD = head(0.02, -hr, 0);
  const hL = head(0, 0, -hr * 0.9);
  const hR = head(0, 0, hr * 0.9);
  const tip: Vec3 = [0.56, 0.4, 0];
  const tail = (z: number): Vec3 => [-0.5, 0.36, z];
  const wing = (s: number): [Vec3, Vec3, Vec3] => [
    [0.14, 0.32, 0.13 * s],
    [-0.38, 0.33, 0.16 * s],
    [0.02, 0.17, 0.17 * s],
  ];
  // The neck: a short tapered sleeve from the top of the chest up into the head.
  const ring = (c: Vec3, up: Vec3, side: number): [Vec3, Vec3, Vec3, Vec3] => [
    [c[0] + up[0], c[1] + up[1], c[2]],
    [c[0], c[1], c[2] + side],
    [c[0] - up[0], c[1] - up[1], c[2]],
    [c[0], c[1], c[2] - side],
  ];
  const low = ring([0.16, 0.28, 0], [-0.05, 0.07, 0], 0.1);
  const high = ring([H[0] - 0.02, H[1] - 0.04, 0], [-0.04, 0.05, 0], 0.08);
  const neck: [Part, Vec3, Vec3, Vec3][] = [0, 1, 2, 3].flatMap((i) => {
    const j = (i + 1) % 4;
    return [
      ['body', low[i]!, low[j]!, high[j]!],
      ['body', low[i]!, high[j]!, high[i]!],
    ] as [Part, Vec3, Vec3, Vec3][];
  });
  const [w1, w2, w3] = wing(1);
  const [v1, v2, v3] = wing(-1);
  return [
    // Body: an elongated octahedron, its front half the breast.
    ['breast', F, R, U],
    ['breast', F, D, R],
    ['breast', F, L, D],
    ['breast', F, U, L],
    ['body', B, U, R],
    ['body', B, R, D],
    ['body', B, D, L],
    ['body', B, L, U],
    ...neck,
    // Head.
    ['body', hF, hU, hR],
    ['body', hF, hR, hD],
    ['body', hF, hD, hL],
    ['body', hF, hL, hU],
    ['body', hB, hR, hU],
    ['body', hB, hD, hR],
    ['body', hB, hL, hD],
    ['body', hB, hU, hL],
    // Beak.
    ['beak', head(hr * 0.8, 0.03, 0), tip, head(hr * 0.7, -0.04, 0.04)],
    ['beak', head(hr * 0.8, 0.03, 0), head(hr * 0.7, -0.04, -0.04), tip],
    ['beak', head(hr * 0.7, -0.04, 0.04), tip, head(hr * 0.7, -0.04, -0.04)],
    // Eyes.
    ['eye', head(0.05, 0.04, hr * 0.92), head(0.09, 0.02, hr * 0.8), head(0.05, 0, hr * 0.95)],
    ['eye', head(0.05, 0.04, -hr * 0.92), head(0.05, 0, -hr * 0.95), head(0.09, 0.02, -hr * 0.8)],
    // Tail, both faces.
    ['wing', B, tail(0.08), tail(-0.08)],
    ['wing', B, tail(-0.08), tail(0.08)],
    // Wings folded along the sides, both faces.
    ['wing', w1, w2, w3],
    ['wing', w1, w3, w2],
    ['wing', v1, v3, v2],
    ['wing', v1, v2, v3],
  ];
})();
export const BIRD_VERTICES = BIRD.length * 3;

const BEAK = new Color('#c9a062');
const EYE = new Color('#1b1a18');
const HEAD: Vec3 = [0.3, 0.42, 0];

/**
 * How each vertex moves (birdShader): 0 with the body, 1 with the head (it pecks and glances),
 * 2 and 3 with the right and left wing (they flutter, and flap in flight), 4 with the tail.
 */
const MOVES: number[] = BIRD.flatMap(([part, ...corners]) =>
  corners.map(([x, y, z]) => {
    if (part === 'beak' || part === 'eye') return 1;
    if (part === 'wing') {
      if (x <= -0.45 || (z === 0 && x < -0.2)) return 4;
      return z > 0 ? 2 : 3;
    }
    return Math.hypot(x - HEAD[0], y - HEAD[1], z - HEAD[2]) < 0.15 ? 1 : 0;
  }),
);

type Leaves = { position: Float32Array; nodeId: Float32Array };

/**
 * Where each bird stands: on top of the crown, on a leaf with nothing above it. The crown's top
 * is read on a grid (CELL); a bird takes the free cell nearest its folder's anchor whose top
 * leaf is one of that folder's (node ids `range`), or failing that the free cell nearest the
 * anchor. A taken cell and the cells around it are left to no other bird, so none overlap.
 */
export function perchOnCrown(
  birds: readonly { anchor: Vec3; range: readonly [number, number] }[],
  leaves: Leaves,
): { at: Vec3; out: Vec3 }[] {
  const cell = CELL * BIRD_SIZE;
  const tops = new Map<string, { i: number; j: number; at: Vec3; node: number }>();
  const { position, nodeId } = leaves;
  for (let v = 0; v < nodeId.length; v++) {
    const x = position[3 * v]!;
    const y = position[3 * v + 1]!;
    const z = position[3 * v + 2]!;
    const i = Math.floor(x / cell);
    const j = Math.floor(z / cell);
    const key = `${i},${j}`;
    const top = tops.get(key);
    if (!top || y > top.at[1]) tops.set(key, { i, j, at: [x, y, z], node: nodeId[v]! });
  }
  const taken = new Set<string>();
  const cells = [...tops.values()];
  return birds.map(({ anchor, range: [lo, hi] }) => {
    const free = cells.filter((c) => !taken.has(`${c.i},${c.j}`));
    const near = (c: (typeof cells)[number]) =>
      (c.at[0] - anchor[0]) ** 2 + (c.at[2] - anchor[2]) ** 2;
    const own = free.filter((c) => c.node >= lo && c.node <= hi);
    const pool = own.length ? own : free.length ? free : cells;
    let best = pool[0];
    for (const c of pool) if (best && near(c) < near(best)) best = c;
    if (!best) return { at: anchor, out: [anchor[0], 0, anchor[2]] };
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) taken.add(`${best.i + di},${best.j + dj}`);
    }
    return { at: best.at, out: [best.at[0], 0, best.at[2]] };
  });
}

/** Which way each bird looks: in profile along the crown's surface, turned a little outward. */
export function looks(perches: readonly Perched[]): Vec3[] {
  return perches.map((p, i) => {
    const len = Math.hypot(p.out[0], p.out[2]);
    const out: Vec3 = len > 1e-6 ? [p.out[0] / len, 0, p.out[2] / len] : [1, 0, 0];
    const side = i % 2 === 0 ? 1 : -1;
    const look: Vec3 = [-out[2] * side * 0.8 + out[0] * 0.6, 0, out[0] * side * 0.8 + out[2] * 0.6];
    const l = Math.hypot(look[0], look[2]);
    return [look[0] / l, 0, look[2] / l];
  });
}

/**
 * One mesh for every bird, with the attributes the tree's materials and id pass read: each grows
 * out of its feet at the end of the tree's growth (BIRD_T), and bird `i` writes id `idBase + i`.
 * `position` is each bird at rest, for picking; birdShader moves it from `aLocal` (its own frame,
 * one unit long), `aBase` (its feet), `aLook`, `aOut`, `aMove` and `aPhase` (its own clock).
 */
export function birdGeometry(perches: readonly Perched[], idBase: number): BufferGeometry {
  const looking = looks(perches);
  const count = perches.length * BIRD_VERTICES;
  const position = new Float32Array(count * 3);
  const local = new Float32Array(count * 3);
  const base = new Float32Array(count * 3);
  const look = new Float32Array(count * 2);
  const outward = new Float32Array(count * 2);
  const move = new Float32Array(count);
  const phase = new Float32Array(count);
  const color = new Float32Array(count * 3);
  const timing = new Float32Array(count * 2);
  const id = new Float32Array(count);
  const plumage = new Color();
  const wing = new Color();
  const breast = new Color();
  const cream = new Color('#efe4d2');
  let v = 0;
  perches.forEach((p, b) => {
    const at = p.at;
    const f = looking[b]!;
    const right: Vec3 = [-f[2], 0, f[0]];
    const len = Math.hypot(p.out[0], p.out[2]) || 1;
    // A fixed spread of clocks, so birds never peck or fly in step.
    const clock = (b * 0.618034) % 1;
    plumage.set(p.color);
    wing.copy(plumage).multiplyScalar(0.45);
    breast.copy(plumage).lerp(cream, 0.3);
    const colors: Record<Part, Color> = { body: plumage, wing, breast, beak: BEAK, eye: EYE };
    let k = 0;
    for (const [part, ...corners] of BIRD) {
      const c = colors[part];
      for (const [x, y, z] of corners) {
        const s = BIRD_SIZE;
        position[3 * v] = at[0] + (f[0] * x + right[0] * z) * s;
        position[3 * v + 1] = at[1] + y * s;
        position[3 * v + 2] = at[2] + (f[2] * x + right[2] * z) * s;
        local.set([x, y, z], 3 * v);
        base.set(at, 3 * v);
        look.set([f[0], f[2]], 2 * v);
        outward.set([p.out[0] / len, p.out[2] / len], 2 * v);
        move[v] = MOVES[k++]!;
        phase[v] = clock;
        c.toArray(color, 3 * v);
        timing.set(BIRD_T, 2 * v);
        id[v] = idBase + b;
        v++;
      }
    }
  });
  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(position, 3))
    .setAttribute('aLocal', new BufferAttribute(local, 3))
    .setAttribute('aBase', new BufferAttribute(base, 3))
    .setAttribute('aLook', new BufferAttribute(look, 2))
    .setAttribute('aOut', new BufferAttribute(outward, 2))
    .setAttribute('aMove', new BufferAttribute(move, 1))
    .setAttribute('aPhase', new BufferAttribute(phase, 1))
    .setAttribute('color', new BufferAttribute(color, 3))
    .setAttribute('aT', new BufferAttribute(timing, 2))
    .setAttribute('aId', new BufferAttribute(id, 1))
    .setAttribute('aBorn', new BufferAttribute(new Float32Array(count), 1));
}
