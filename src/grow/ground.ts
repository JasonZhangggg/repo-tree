import type { Quality, Vec3 } from './grow';

/**
 * What each ground face is, so a palette colors it without regrowing. `cap` is a rock face
 * turned to the sky, where winter lays its snow.
 */
export const KIND = {
  grass: 0,
  dirt: 1,
  soil: 2,
  stone: 3,
  rock: 4,
  cap: 5,
  blade: 6,
  flower: 7,
  litter: 8,
} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

/**
 * Unindexed flat-shaded triangles. Per vertex: `kind` says what it is, `tone` in -1..1 shifts
 * its lightness, and `pick` in 0..1 chooses among a palette's flower or leaf colors.
 */
export type GroundMesh = {
  position: Float32Array;
  normal: Float32Array;
  kind: Uint8Array;
  tone: Float32Array;
  pick: Float32Array;
  /** Index into TreeModel.rocks of the rock a vertex belongs to, or -1. */
  rock: Float32Array;
};

/**
 * `land` is the mound, its soil and its rocks. `cover` is grass blades, then flowers, then
 * fallen leaves, each as a run of vertices, so a palette shows a prefix of it in one draw.
 */
export type GroundModel = {
  land: GroundMesh;
  cover: GroundMesh & { blades: number; flowers: number; litter: number };
  bounds: { min: Vec3; max: Vec3 };
};

export type GroundSite = {
  /** Radius of the trunk's flare where it meets the ground. */
  trunk: number;
  /** The tree's bounds; the ground sizes itself to the crown. */
  bounds: { min: Vec3; max: Vec3 };
  /** Direction of the default view in the ground plane, in radians from +x toward +z. */
  front: number;
  /** Bytes on each rock, largest first; an empty list leaves a few bare pebbles. */
  rocks: readonly number[];
};

const DETAIL: Record<
  Quality,
  { rings: number; sectors: number; blades: number; flowers: number; litter: number }
> = {
  low: { rings: 7, sectors: 28, blades: 70, flowers: 50, litter: 40 },
  medium: { rings: 9, sectors: 36, blades: 110, flowers: 80, litter: 64 },
  high: { rings: 11, sectors: 44, blades: 150, flowers: 110, litter: 90 },
};

/** The island's radius as a share of the crown's span, and its rim drop and depth by radius. */
const SHAPE = { radius: 0.44, drop: 0.12, depth: 0.34 };

export function growGround(
  site: GroundSite,
  params: { seed: number; quality: Quality },
): GroundModel {
  const random = mulberry32(params.seed);
  const detail = DETAIL[params.quality];
  const { min, max } = site.bounds;
  const span = Math.max(max[0] - min[0], max[2] - min[2]);
  const R = Math.max(site.trunk * 6, span * SHAPE.radius);
  const H = R * SHAPE.drop;
  const D = R * SHAPE.depth;
  const phase = Array.from({ length: 6 }, () => random() * Math.PI * 2);

  const warp = (a: number) =>
    1 + 0.07 * Math.sin(3 * a + phase[0]!) + 0.04 * Math.sin(5 * a + phase[1]!);
  const height = (r: number, a: number) => {
    const t = Math.min(1, r / R);
    const lumps =
      0.5 * Math.sin(2 * a + phase[2]!) +
      0.35 * Math.sin(3 * a + phase[3]!) +
      0.15 * Math.sin(7 * a + phase[4]!);
    return -H * t * t + H * 0.3 * t ** 1.5 * lumps;
  };
  const dirtEdge = (a: number) =>
    site.trunk * (1.9 + 0.35 * Math.sin(4 * a + phase[5]!) + 0.2 * Math.sin(7 * a + phase[0]!));

  const land = new Writer();
  const { rings, sectors } = detail;
  const grid: Vec3[][] = [];
  for (let i = 0; i <= rings; i++) {
    const row: Vec3[] = [];
    const t = (i / rings) ** 1.3;
    for (let j = 0; j < sectors; j++) {
      const inner = i > 0 && i < rings;
      const a =
        ((j + (inner ? (random() - 0.5) * 0.5 : 0) + (i % 2) * 0.5) / sectors) * Math.PI * 2;
      const gap = (((i + 1) / rings) ** 1.3 - t) * R;
      const r = i === 0 ? 0 : (t * R + (inner ? (random() - 0.5) * 0.45 * gap : 0)) * warp(a) ** t;
      row.push([Math.cos(a) * r, height(r, a), Math.sin(a) * r]);
    }
    grid.push(row);
  }
  const topKind = (p: Vec3) => {
    const r = Math.hypot(p[0], p[2]);
    return r < dirtEdge(Math.atan2(p[2], p[0])) ? KIND.dirt : KIND.grass;
  };
  const top: number[] = [];
  const face = (a: Vec3, b: Vec3, c: Vec3, kind: Kind, tone = random() * 2 - 1) => {
    land.triangle(a, b, c, kind, tone, random());
  };
  const topFace = (a: Vec3, b: Vec3, c: Vec3) => {
    top.push(land.count);
    face(a, b, c, topKind(centroid(a, b, c)));
  };
  for (let i = 0; i < rings; i++) {
    const inner = grid[i]!;
    const outer = grid[i + 1]!;
    for (let j = 0; j < sectors; j++) {
      const k = (j + 1) % sectors;
      if (i === 0) {
        topFace(inner[0]!, outer[k]!, outer[j]!);
        continue;
      }
      const shift = i % 2 === 1;
      const a = inner[j]!;
      const b = inner[shift ? k : j]!;
      const c = outer[j]!;
      const d = outer[k]!;
      if (shift) {
        topFace(a, b, d);
        topFace(a, d, c);
      } else {
        topFace(inner[j]!, inner[k]!, outer[k]!);
        topFace(inner[j]!, outer[k]!, c);
      }
    }
  }

  const rim = grid[rings]!;
  const bands = [
    { drop: 0.1, shrink: 0.02, kind: KIND.grass },
    { drop: 0.28, shrink: 0.08, kind: KIND.dirt },
    { drop: 0.55, shrink: 0.26, kind: KIND.soil },
    { drop: 0.8, shrink: 0.55, kind: KIND.soil },
    { drop: 1, shrink: 0.86, kind: KIND.stone },
  ];
  let upper = rim;
  for (const band of bands) {
    const lower = upper.map((_, j): Vec3 => {
      const [x, , z] = rim[j]!;
      const k = 1 - band.shrink * (0.9 + 0.2 * random());
      return [x * k, -H - D * band.drop * (0.92 + 0.16 * random()), z * k];
    });
    for (let j = 0; j < sectors; j++) {
      const k = (j + 1) % sectors;
      const tone = random() * 2 - 1;
      face(upper[j]!, upper[k]!, lower[k]!, band.kind, tone);
      face(upper[j]!, lower[k]!, lower[j]!, band.kind, tone);
    }
    upper = lower;
  }
  const tip: Vec3 = [0, -H - D * 1.15, 0];
  for (let j = 0; j < sectors; j++) face(upper[j]!, upper[(j + 1) % sectors]!, tip, KIND.stone);

  const rocks: { x: number; z: number; r: number }[] = [];
  const rock = (x: number, z: number, size: number, flat: number, id: number) => {
    const y = height(Math.hypot(x, z), Math.atan2(z, x)) - size * flat * 0.35;
    emitRock(land, [x, y, z], [size, size * flat, size * (0.8 + 0.3 * random())], id, random);
    rocks.push({ x, z, r: size * 1.2 });
  };
  const largest = Math.min(site.trunk * 1.5, R * 0.18);
  const sizeOf = (bytes: number) =>
    largest * (0.45 + 0.55 * Math.min(1, Math.max(0, (Math.log10(bytes + 1) - 2) / 4)));
  const roots = Math.min(3, site.rocks.length);
  for (let id = 0; id < roots; id++) {
    const size = sizeOf(site.rocks[id]!);
    const a = site.front + Math.PI + [0, 1.1, -1.15][id]! + (random() - 0.5) * 0.35;
    const d = site.trunk * 1.08 + size * 1.25;
    rock(Math.cos(a) * d, Math.sin(a) * d, size, 0.95, id);
  }
  for (let id = roots; id < site.rocks.length; id++) {
    const size = sizeOf(site.rocks[id]!);
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 60; tries++) {
      const a = random() * Math.PI * 2;
      const d = R * (0.36 + 0.4 * random());
      x = Math.cos(a) * d;
      z = Math.sin(a) * d;
      if (rocks.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + size * 1.4)) break;
    }
    rock(x, z, size, 0.75 + 0.2 * random(), id);
  }
  if (site.rocks.length === 0) {
    for (let n = 0; n < 3; n++) {
      const a = site.front + Math.PI + (n - 1) * 1.3;
      const size = site.trunk * 0.32;
      const d = site.trunk * 1.08 + size * 1.25;
      rock(Math.cos(a) * d, Math.sin(a) * d, size, 0.7, -1);
    }
  }

  const area = top.map((v) => triangleArea(land.positions, v));
  const total = area.reduce((s, x) => s + x, 0);
  const sample = (): { p: Vec3; n: Vec3; kind: number } => {
    let pick = random() * total;
    let f = 0;
    while (f < top.length - 1 && pick > area[f]!) pick -= area[f++]!;
    const v = top[f]!;
    let u = random();
    let w = random();
    if (u + w > 1) [u, w] = [1 - u, 1 - w];
    const p: Vec3 = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const a = land.positions[v * 3 + axis]!;
      const b = land.positions[(v + 1) * 3 + axis]!;
      const c = land.positions[(v + 2) * 3 + axis]!;
      p[axis] = a + (b - a) * u + (c - a) * w;
    }
    const n: Vec3 = [land.normals[v * 3]!, land.normals[v * 3 + 1]!, land.normals[v * 3 + 2]!];
    return { p, n, kind: land.kinds[v]! };
  };
  const clear = (p: Vec3, margin: number) =>
    Math.hypot(p[0], p[2]) > site.trunk * 1.3 &&
    rocks.every((o) => Math.hypot(o.x - p[0], o.z - p[2]) > o.r + margin);

  const cover = new Writer();
  const unit = R * 0.036;
  const place = (count: number, onDirt: boolean, emit: (p: Vec3, n: Vec3) => void) => {
    for (let n = 0, tries = 0; n < count && tries < count * 20; tries++) {
      const s = sample();
      if ((!onDirt && s.kind !== KIND.grass) || !clear(s.p, unit)) continue;
      emit(s.p, s.n);
      n++;
    }
  };
  place(detail.blades, false, (p) => emitTuft(cover, p, unit, random));
  const blades = cover.count;
  place(detail.flowers, false, (p) => emitFlower(cover, p, unit, random));
  const flowers = cover.count - blades;
  place(detail.litter, true, (p, n) => emitLeaf(cover, p, n, unit, random));
  const litter = cover.count - blades - flowers;

  const landMesh = land.mesh();
  const coverMesh = cover.mesh();
  return {
    land: landMesh,
    cover: { ...coverMesh, blades, flowers, litter },
    bounds: boundsOf([landMesh.position, coverMesh.position]),
  };
}

const ICO_FACES = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
] as const;
const ICO_VERTS: Vec3[] = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  return raw.map(normalize);
})();

function emitRock(out: Writer, at: Vec3, size: Vec3, id: number, random: () => number) {
  const turn = random() * Math.PI * 2;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const verts = ICO_VERTS.map(([x, y, z]): Vec3 => {
    const k = 0.78 + 0.34 * random();
    const px = x * size[0] * k;
    const pz = z * size[2] * k;
    return [at[0] + px * c - pz * s, at[1] + y * size[1] * k, at[2] + px * s + pz * c];
  });
  const tone = random() * 2 - 1;
  for (const [a, b, d] of ICO_FACES) {
    const pa = verts[a]!;
    const pb = verts[b]!;
    const pd = verts[d]!;
    const up = faceNormal(pa, pb, pd)[1];
    const kind = up > 0.55 ? KIND.cap : KIND.rock;
    out.triangle(pa, pb, pd, kind, tone * 0.5 + (random() - 0.5) * 0.9, random(), id);
  }
}

function emitTuft(out: Writer, at: Vec3, unit: number, random: () => number) {
  const turn = random() * Math.PI * 2;
  const tall = unit * (0.9 + 0.7 * random());
  const tone = random() * 2 - 1;
  for (let b = 0; b < 3; b++) {
    const a = turn + (b * Math.PI * 2) / 3 + (random() - 0.5) * 0.6;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const w = unit * 0.16;
    const lean = tall * (0.25 + 0.3 * random());
    const h = tall * (0.75 + 0.4 * random());
    out.triangle(
      [at[0] - dz * w, at[1] - unit * 0.1, at[2] + dx * w],
      [at[0] + dz * w, at[1] - unit * 0.1, at[2] - dx * w],
      [at[0] + dx * lean, at[1] + h, at[2] + dz * lean],
      KIND.blade,
      tone,
      0,
    );
  }
}

function emitFlower(out: Writer, at: Vec3, unit: number, random: () => number) {
  const h = unit * (0.9 + 0.6 * random());
  const lean: Vec3 = [(random() - 0.5) * unit * 0.4, 0, (random() - 0.5) * unit * 0.4];
  const head: Vec3 = [at[0] + lean[0], at[1] + h, at[2] + lean[2]];
  const a = random() * Math.PI;
  const w = unit * 0.07;
  out.triangle(
    [at[0] - Math.sin(a) * w, at[1] - unit * 0.1, at[2] + Math.cos(a) * w],
    [at[0] + Math.sin(a) * w, at[1] - unit * 0.1, at[2] - Math.cos(a) * w],
    head,
    KIND.blade,
    0.3,
    0,
  );
  const r = unit * (0.38 + 0.14 * random());
  const pick = random();
  const tone = random() * 2 - 1;
  const ring: Vec3[] = [0, 1, 2, 3].map((i) => {
    const t = a + (i * Math.PI) / 2;
    return [head[0] + Math.cos(t) * r, head[1], head[2] + Math.sin(t) * r];
  });
  const crown: Vec3 = [head[0], head[1] + r * 0.6, head[2]];
  const heel: Vec3 = [head[0], head[1] - r * 0.5, head[2]];
  for (let i = 0; i < 4; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % 4]!;
    out.triangle(crown, q, p, KIND.flower, tone, pick);
    out.triangle(heel, p, q, KIND.flower, tone - 0.6, pick);
  }
}

function emitLeaf(out: Writer, at: Vec3, n: Vec3, unit: number, random: () => number) {
  const a = random() * Math.PI * 2;
  const len = unit * (0.35 + 0.2 * random());
  const along: Vec3 = normalize(cross(n, [Math.cos(a), 0, Math.sin(a)]));
  const side = normalize(cross(n, along));
  const lift = addScaled(at, n, unit * 0.04);
  const tip = addScaled(lift, along, len);
  const tail = addScaled(lift, along, -len);
  const l = addScaled(lift, side, len * 0.45);
  const r = addScaled(lift, side, -len * 0.45);
  const pick = random();
  const tone = random() * 2 - 1;
  out.triangle(tail, l, tip, KIND.litter, tone, pick);
  out.triangle(tail, tip, r, KIND.litter, tone, pick);
}

class Writer {
  positions: number[] = [];
  normals: number[] = [];
  kinds: number[] = [];
  tones: number[] = [];
  picks: number[] = [];
  rocks: number[] = [];

  get count() {
    return this.kinds.length;
  }

  triangle(a: Vec3, b: Vec3, c: Vec3, kind: Kind, tone: number, pick: number, rock = -1) {
    const n = faceNormal(a, b, c);
    for (const p of [a, b, c]) {
      this.positions.push(...p);
      this.normals.push(...n);
      this.kinds.push(kind);
      this.tones.push(Math.max(-1, Math.min(1, tone)));
      this.picks.push(pick);
      this.rocks.push(rock);
    }
  }

  mesh(): GroundMesh {
    return {
      position: Float32Array.from(this.positions),
      normal: Float32Array.from(this.normals),
      kind: Uint8Array.from(this.kinds),
      tone: Float32Array.from(this.tones),
      pick: Float32Array.from(this.picks),
      rock: Float32Array.from(this.rocks),
    };
  }
}

function triangleArea(p: number[], v: number): number {
  const a: Vec3 = [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
  const b: Vec3 = [p[v * 3 + 3]!, p[v * 3 + 4]!, p[v * 3 + 5]!];
  const c: Vec3 = [p[v * 3 + 6]!, p[v * 3 + 7]!, p[v * 3 + 8]!];
  return length(cross(sub(b, a), sub(c, a))) / 2;
}

function boundsOf(buffers: Float32Array[]): GroundModel['bounds'] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const position of buffers) {
    for (let i = 0; i < position.length; i++) {
      const axis = i % 3;
      min[axis] = Math.min(min[axis]!, position[i]!);
      max[axis] = Math.max(max[axis]!, position[i]!);
    }
  }
  return { min, max };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const centroid = (a: Vec3, b: Vec3, c: Vec3): Vec3 => [
  (a[0] + b[0] + c[0]) / 3,
  (a[1] + b[1] + c[1]) / 3,
  (a[2] + b[2] + c[2]) / 3,
];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addScaled = (a: Vec3, b: Vec3, k: number): Vec3 => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function length(a: Vec3) {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
const faceNormal = (a: Vec3, b: Vec3, c: Vec3): Vec3 => normalize(cross(sub(b, a), sub(c, a)));
