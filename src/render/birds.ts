import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { Vec3 } from '../grow/grow';

/** A bird to perch: where it sits, which way is out from the trunk there, and its plumage. */
export type Perched = { at: Vec3; out: Vec3; color: string };

/** A bird's length, beak to tail, in world units: about two leaves. */
export const BIRD_SIZE = 0.5;
/** Birds sharing a twig sit this many bird lengths apart along it. */
const SPACING = 1;
/** How far past the crown's surface a bird sits, in bird lengths: its feet among the tips. */
const LIFT_OUT = 0;
/** Birds grow in over the last part of the tree's growth, out of their perch. */
export const BIRD_T: [number, number] = [0.82, 1];

type Part = 'body' | 'wing' | 'breast' | 'beak' | 'eye';
/**
 * One low-poly bird in its own frame: +x is where it looks, +y up, +z its right; its feet are at
 * the origin and it is one unit long. Each triangle names the part its color comes from.
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

const BEAK = new Color('#e8a33a');
const EYE = new Color('#1b1a18');

/** How far around a bird's line out of the crown, in bird lengths, leaves count as in its way. */
const BAND = 0.5;
/** A bird leaves the crown this steeply: up and out, so it sits on the crown's shoulder. */
const CLIMB = 1.1;
/** A bird settles onto the highest leaf within this many bird lengths under it. */
const SETTLE = 0.6;

/**
 * Moves each perch out of the crown to its surface, along a line rising up and out from it:
 * past every leaf (xyz in `leaves`) within BAND of that line. A bird then sits on the outermost
 * leaves, where the sky shows behind it, instead of buried among them.
 */
export function onCrown(perches: readonly Perched[], leaves: Float32Array): Perched[] {
  const rays = perches.map((p) => {
    const len = Math.hypot(p.out[0], p.out[2]);
    const out: Vec3 = len > 1e-6 ? [p.out[0] / len, 0, p.out[2] / len] : [1, 0, 0];
    const n = Math.hypot(1, CLIMB);
    const dir: Vec3 = [out[0] / n, CLIMB / n, out[2] / n];
    return { p, out, dir, reach: 0, hit: p.at };
  });
  const band = (BAND * BIRD_SIZE) ** 2;
  for (let v = 0; v < leaves.length; v += 3) {
    const x = leaves[v]!;
    const y = leaves[v + 1]!;
    const z = leaves[v + 2]!;
    for (const ray of rays) {
      const dx = x - ray.p.at[0];
      const dy = y - ray.p.at[1];
      const dz = z - ray.p.at[2];
      const along = dx * ray.dir[0] + dy * ray.dir[1] + dz * ray.dir[2];
      if (along <= ray.reach) continue;
      const off = dx * dx + dy * dy + dz * dz - along * along;
      if (off > band) continue;
      ray.reach = along;
      ray.hit = [x, y, z];
    }
  }
  // Then down onto the highest leaf under each, so none hovers over a gap in the crown.
  const spots = rays.map(({ p, dir, reach }) => ({
    at: [p.at[0] + dir[0] * reach, p.at[1] + dir[1] * reach, p.at[2] + dir[2] * reach] as Vec3,
    floor: -Infinity,
  }));
  const under = (SETTLE * BIRD_SIZE) ** 2;
  for (let v = 0; v < leaves.length; v += 3) {
    const y = leaves[v + 1]!;
    for (const spot of spots) {
      if (y > spot.at[1] || y <= spot.floor) continue;
      const dx = leaves[v]! - spot.at[0];
      const dz = leaves[v + 2]! - spot.at[2];
      if (dx * dx + dz * dz <= under) spot.floor = y;
    }
  }
  // With no leaf under it, the bird sits on the leaf that stopped it, which lay off to one side.
  return rays.map(({ p, out, hit }, i) => {
    const { at, floor } = spots[i]!;
    return { ...p, at: Number.isFinite(floor) ? [at[0], floor, at[2]] : hit, out };
  });
}

/**
 * Birds sharing a perch, spread along it: each bird's place and which way it looks. A lone bird
 * sits on the perch; a pair or more sit in a row across the out direction, turned alternately.
 */
export function placeBirds(perches: readonly Perched[]): { at: Vec3; look: Vec3 }[] {
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  const keyOf = (p: Perched) => p.at.map((v) => v.toFixed(4)).join(',');
  for (const p of perches) counts.set(keyOf(p), (counts.get(keyOf(p)) ?? 0) + 1);
  return perches.map((p) => {
    const key = keyOf(p);
    const i = seen.get(key) ?? 0;
    seen.set(key, i + 1);
    const n = counts.get(key)!;
    const flat = Math.hypot(p.out[0], p.out[2]) > 1e-6 ? p.out : ([1, 0, 0] as Vec3);
    const len = Math.hypot(flat[0], flat[2]);
    const out: Vec3 = [flat[0] / len, 0, flat[2] / len];
    // Along the crown's surface, at right angles to out: birds there show their profile.
    const along: Vec3 = [-out[2], 0, out[0]];
    const shift = (i - (n - 1) / 2) * SPACING * BIRD_SIZE;
    const at: Vec3 = [
      p.at[0] + out[0] * LIFT_OUT * BIRD_SIZE + along[0] * shift,
      p.at[1],
      p.at[2] + out[2] * LIFT_OUT * BIRD_SIZE + along[2] * shift,
    ];
    // Mostly in profile, turned a little toward the outside so its face shows.
    const side = i % 2 === 0 ? 1 : -1;
    const look: Vec3 = [
      along[0] * side * 0.8 + out[0] * 0.6,
      0,
      along[2] * side * 0.8 + out[2] * 0.6,
    ];
    const l = Math.hypot(look[0], look[2]);
    return { at, look: [look[0] / l, 0, look[2] / l] };
  });
}

/**
 * One mesh for every bird, with the attributes the tree's materials and id pass read: each grows
 * out of its perch at the end of the tree's growth (BIRD_T), and bird `i` writes id `idBase + i`.
 */
export function birdGeometry(perches: readonly Perched[], idBase: number): BufferGeometry {
  const placed = placeBirds(perches);
  const count = perches.length * BIRD_VERTICES;
  const position = new Float32Array(count * 3);
  const base = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const timing = new Float32Array(count * 2);
  const id = new Float32Array(count);
  const plumage = new Color();
  const wing = new Color();
  const breast = new Color();
  const white = new Color('#ffffff');
  let v = 0;
  perches.forEach((p, b) => {
    const { at, look } = placed[b]!;
    const right: Vec3 = [-look[2], 0, look[0]];
    plumage.set(p.color);
    wing.copy(plumage).multiplyScalar(0.45);
    breast.copy(plumage).lerp(white, 0.12);
    const colors: Record<Part, Color> = { body: plumage, wing, breast, beak: BEAK, eye: EYE };
    for (const [part, ...corners] of BIRD) {
      const c = colors[part];
      for (const [x, y, z] of corners) {
        const s = BIRD_SIZE;
        position[3 * v] = at[0] + (look[0] * x + right[0] * z) * s;
        position[3 * v + 1] = at[1] + y * s;
        position[3 * v + 2] = at[2] + (look[2] * x + right[2] * z) * s;
        base.set(at, 3 * v);
        c.toArray(color, 3 * v);
        timing.set(BIRD_T, 2 * v);
        id[v] = idBase + b;
        v++;
      }
    }
  });
  const geometry = new BufferGeometry()
    .setAttribute('position', new BufferAttribute(position, 3))
    .setAttribute('aBase', new BufferAttribute(base, 3))
    .setAttribute('color', new BufferAttribute(color, 3))
    .setAttribute('aT', new BufferAttribute(timing, 2))
    .setAttribute('aId', new BufferAttribute(id, 1))
    .setAttribute('aBorn', new BufferAttribute(new Float32Array(count), 1));
  geometry.computeVertexNormals();
  return geometry;
}
