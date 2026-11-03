import type { FileEntry } from '../repo/github';
import type { Dir } from '../repo/hierarchy';
import { langOf, type Lang } from '../repo/languages';

/**
 * Sets leaves per sprig, sprigs per twig and tube facets (see QUALITY). The branch skeleton,
 * node ids and labels are the same at every quality.
 */
export type Quality = 'low' | 'medium' | 'high';
export type GrowParams = { seed: number; quality: Quality };
export type Vec3 = [number, number, number];

/**
 * Per vertex: position, normal and base (the point it grows out of) are xyz, timing is the
 * [start, end] of its growth in 0..1, nodeId is the node it belongs to.
 */
export type MeshData = {
  position: Float32Array;
  normal: Float32Array;
  base: Float32Array;
  timing: Float32Array;
  nodeId: Float32Array;
  index: Uint32Array;
};
/**
 * Leaves carry a color recipe instead of a color, so palettes and color-by switch without
 * regrowing: `lang` indexes TreeModel.langs, `shade` is a [hue, lightness] offset for offsetHSL.
 */
export type LeafMeshData = MeshData & { lang: Float32Array; shade: Float32Array };

export type TreeModel = {
  bark: MeshData;
  leaves: LeafMeshData;
  langs: Lang[];
  /** Node ids are preorder, so every folder's nodes form one contiguous id range. */
  nodes: {
    folder: Uint32Array;
    parent: Int32Array;
    /** [start, end] radius per node. */
    radius: Float32Array;
    /** Files a twig stands for, 0 on every other node. */
    files: Uint32Array;
  };
  /** Folders in preorder, root first. `range` holds [lo, hi] node ids per folder. */
  folders: { path: string[]; range: Uint32Array };
  labels: { folder: number; anchor: Vec3 }[];
  bounds: { min: Vec3; max: Vec3 };
};

const QUALITY: Record<
  Quality,
  { leavesPerSprig: number; maxSprigs: number; radialThick: number; radialThin: number }
> = {
  low: { leavesPerSprig: 2, maxSprigs: 3, radialThick: 5, radialThin: 3 },
  medium: { leavesPerSprig: 3, maxSprigs: 4, radialThick: 6, radialThin: 4 },
  high: { leavesPerSprig: 3, maxSprigs: 5, radialThick: 7, radialThin: 5 },
};

const SHAPE = { trunkLen: 1, spread: 1.25, lenExp: 0.3, lenK: 0.7, tropism: 0.08, pipe: 2.4 };
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const UP: Vec3 = [0, 1, 0];
const GROW_END = 0.86;
const LEAF_UNFOLD = 0.12;

type Node = {
  w: number;
  kids: Node[];
  files: FileEntry[] | null;
  folder: number;
  ownsFolder: boolean;
  id: number;
};

export function growTree(root: Dir, params: GrowParams): TreeModel {
  const fileCount = root.fileCount;
  if (fileCount === 0) throw new RangeError('growTree needs a folder with at least one file');
  const quality = QUALITY[params.quality];
  const twigSize = Math.max(4, Math.ceil(fileCount / 150));
  const trunkR = Math.min(0.24, Math.max(0.09, 0.2 * (fileCount / 527) ** 0.2));
  const leafL = 0.16 * Math.min(2, Math.max(0.85, (527 / fileCount) ** 0.3));

  const folderPaths: string[] = [];
  const folderParent: number[] = [];
  const folderOf = new Map<Dir, number>();
  const indexFolders = (dir: Dir, parent: number) => {
    const index = folderPaths.length;
    folderOf.set(dir, index);
    folderPaths.push(dir.path);
    folderParent.push(parent);
    for (const child of dir.dirs) indexFolders(child, index);
  };
  indexFolders(root, -1);

  const build = (dir: Dir): Node => {
    const folder = folderOf.get(dir)!;
    const kids = dir.dirs.map(build);
    for (let i = 0; i < dir.files.length; i += twigSize) {
      const files = dir.files.slice(i, i + twigSize);
      kids.push({ w: files.length, kids: [], files, folder, ownsFolder: false, id: -1 });
    }
    return { w: dir.fileCount, kids, files: null, folder, ownsFolder: true, id: -1 };
  };
  const top = build(root);

  if (fileCount > 1500) {
    const threshold = fileCount / 140;
    const allFiles = (n: Node): FileEntry[] => n.files ?? n.kids.flatMap(allFiles);
    const collapse = (n: Node, depth: number) => {
      n.kids = n.kids.map((k) =>
        !k.files && k.w < threshold && depth > 0
          ? { w: k.w, kids: [], files: allFiles(k), folder: k.folder, ownsFolder: true, id: -1 }
          : k,
      );
      for (const k of n.kids) if (!k.files) collapse(k, depth + 1);
    };
    collapse(top, 0);
  }
  binarize(top);

  const order: Node[] = [];
  const parentOf: number[] = [];
  const lastOf: number[] = [];
  const number = (n: Node, parent: number) => {
    n.id = order.length;
    order.push(n);
    parentOf.push(parent);
    for (const k of n.kids) number(k, n.id);
    lastOf[n.id] = order.length - 1;
  };
  number(top, -1);
  const nodeCount = order.length;

  const range = new Uint32Array(folderPaths.length * 2);
  const ranged = new Uint8Array(folderPaths.length);
  for (const n of order) {
    if (!n.ownsFolder) continue;
    range[2 * n.folder] = n.id;
    range[2 * n.folder + 1] = lastOf[n.id]!;
    ranged[n.folder] = 1;
  }
  for (let f = 1; f < folderPaths.length; f++) {
    if (ranged[f]) continue;
    const p = folderParent[f]!;
    range[2 * f] = range[2 * p]!;
    range[2 * f + 1] = range[2 * p + 1]!;
  }

  const skeleton = growSkeleton(top, nodeCount, trunkR, mulberry32(params.seed));

  const langs = [...root.langs].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([l]) => l);
  const langIndex = new Map(langs.map((l, i) => [l, i]));

  const bark = emitBark(skeleton, quality);
  const leaves = emitLeaves(
    order,
    skeleton,
    quality,
    leafL,
    (file) => langIndex.get(langOf(file.path))!,
    mulberry32(params.seed ^ 0x5bd1e995),
  );

  const nodeFolder = new Uint32Array(nodeCount);
  const nodeFiles = new Uint32Array(nodeCount);
  for (const n of order) {
    nodeFolder[n.id] = n.folder;
    nodeFiles[n.id] = n.files?.length ?? 0;
  }

  return {
    bark,
    leaves,
    langs,
    nodes: {
      folder: nodeFolder,
      parent: Int32Array.from(parentOf),
      radius: Float32Array.from(skeleton.radius),
      files: nodeFiles,
    },
    folders: { path: folderPaths, range },
    labels: root.dirs.map((dir) => {
      const folder = folderOf.get(dir)!;
      return {
        folder,
        anchor: labelAnchor(order, skeleton, range[2 * folder]!, range[2 * folder + 1]!),
      };
    }),
    bounds: boundsOf([bark.position, leaves.position]),
  };
}

/** Huffman-style: merge the two lightest kids until two remain, so heavy limbs fork late. */
function binarize(n: Node) {
  for (const k of n.kids) binarize(k);
  if (n.kids.length <= 2) return;
  const kids = n.kids.slice().sort((a, b) => a.w - b.w);
  while (kids.length > 2) {
    const a = kids.shift()!;
    const b = kids.shift()!;
    const merged: Node = {
      w: a.w + b.w,
      kids: [a, b],
      files: null,
      folder: n.folder,
      ownsFolder: false,
      id: -1,
    };
    if (kids.length === 1) kids.push(merged);
    else kids.splice(upperBound(kids, merged.w), 0, merged);
  }
  n.kids = kids;
}

function upperBound(sorted: Node[], w: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.w <= w) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Skeleton = {
  start: Float64Array;
  mid: Float64Array;
  end: Float64Array;
  radius: Float64Array;
  path: Float64Array;
  depth: Uint16Array;
  maxPath: number;
};

function growSkeleton(
  top: Node,
  nodeCount: number,
  trunkR: number,
  random: () => number,
): Skeleton {
  const s: Skeleton = {
    start: new Float64Array(nodeCount * 3),
    mid: new Float64Array(nodeCount * 3),
    end: new Float64Array(nodeCount * 3),
    radius: new Float64Array(nodeCount * 2),
    path: new Float64Array(nodeCount * 2),
    depth: new Uint16Array(nodeCount),
    maxPath: 0,
  };
  const lenOf = (w: number) => SHAPE.lenK * SHAPE.trunkLen * (w / top.w) ** SHAPE.lenExp;
  const tropism = (d: Vec3, w: number): Vec3 => {
    const t = lerp(d, UP, SHAPE.tropism);
    if (w < 4) t[1] -= 0.12;
    return normalize(t);
  };

  const grow = (
    n: Node,
    start: Vec3,
    dir: Vec3,
    len: number,
    r0: number,
    roll: number,
    depth: number,
    path: number,
  ): void => {
    const side = rotate(perp(dir), dir, random() * 6.28);
    const end = addScaled(start, dir, len);
    const mid = addScaled(lerp(start, end, 0.5), side, len * 0.06 * (random() - 0.3));
    const kids = n.files ? [] : n.kids.slice().sort((a, b) => b.w - a.w);
    const rChild = (k: Node) => r0 * (k.w / n.w) ** (1 / SHAPE.pipe) * 0.92;
    const r1 = Math.min(
      r0,
      n.files ? Math.max(0.004, r0 * 0.35) : Math.max(0.005, rChild(kids[0]!)),
    );

    const id = n.id;
    s.start.set(start, id * 3);
    s.mid.set(mid, id * 3);
    s.end.set(end, id * 3);
    s.radius[id * 2] = r0;
    s.radius[id * 2 + 1] = r1;
    s.path[id * 2] = path;
    s.path[id * 2 + 1] = path + len;
    s.depth[id] = depth;
    s.maxPath = Math.max(s.maxPath, path + len);

    const [a, b] = kids;
    if (!a) return;
    if (!b) {
      const jitter: Vec3 = [(random() - 0.5) * 0.25, 0, (random() - 0.5) * 0.25];
      const d = normalize(lerp(add(dir, jitter), UP, SHAPE.tropism));
      return grow(a, end, d, lenOf(a.w), rChild(a), roll + GOLDEN_ANGLE, depth + 1, path + len);
    }
    const theta = SHAPE.spread * (0.85 + 0.3 * random());
    const angA = (theta * b.w) / (a.w + b.w);
    const angB = Math.max(0.42, (theta * a.w) / (a.w + b.w));
    const axis = rotate(perp(dir), dir, roll);
    grow(
      a,
      end,
      tropism(rotate(dir, axis, angA), a.w),
      lenOf(a.w),
      rChild(a),
      roll + GOLDEN_ANGLE,
      depth + 1,
      path + len,
    );
    grow(
      b,
      end,
      tropism(rotate(dir, axis, -angB), b.w),
      lenOf(b.w),
      rChild(b),
      roll + GOLDEN_ANGLE,
      depth + 1,
      path + len,
    );
  };
  grow(top, [0, -0.06, 0], normalize([0.05, 1, 0.02]), SHAPE.trunkLen, trunkR, 0, 0, 0);
  return s;
}

class MeshWriter {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly base: Float32Array;
  readonly timing: Float32Array;
  readonly nodeId: Float32Array;
  readonly index: Uint32Array;
  vertices = 0;
  private indices = 0;

  constructor(vertexCount: number, indexCount: number) {
    this.position = new Float32Array(vertexCount * 3);
    this.normal = new Float32Array(vertexCount * 3);
    this.base = new Float32Array(vertexCount * 3);
    this.timing = new Float32Array(vertexCount * 2);
    this.nodeId = new Float32Array(vertexCount);
    this.index = new Uint32Array(indexCount);
  }

  vertex(p: Vec3, n: Vec3, base: Vec3, id: number, t0: number, t1: number): number {
    const v = this.vertices++;
    this.position.set(p, v * 3);
    this.normal.set(n, v * 3);
    this.base.set(base, v * 3);
    this.timing[v * 2] = t0;
    this.timing[v * 2 + 1] = t1;
    this.nodeId[v] = id;
    return v;
  }

  triangle(a: number, b: number, c: number) {
    this.index[this.indices++] = a;
    this.index[this.indices++] = b;
    this.index[this.indices++] = c;
  }

  mesh(): MeshData {
    const { position, normal, base, timing, nodeId, index } = this;
    return { position, normal, base, timing, nodeId, index };
  }
}

function emitBark(s: Skeleton, quality: (typeof QUALITY)[Quality]): MeshData {
  const nodeCount = s.depth.length;
  const tubes = Array.from({ length: nodeCount }, (_, id) => {
    const r0 = s.radius[id * 2]!;
    const trunk = s.depth[id] === 0;
    return {
      segs: trunk ? 4 : 2,
      radial: r0 > 0.03 ? quality.radialThick : quality.radialThin,
      flare: trunk ? 0.55 : 0,
    };
  });
  let vertexCount = 0;
  let indexCount = 0;
  for (const { segs, radial, flare } of tubes) {
    vertexCount += (segs + 1) * (radial + 1) + (flare ? 1 : 2);
    indexCount += (segs * 6 + (flare ? 3 : 6)) * radial;
  }

  const out = new MeshWriter(vertexCount, indexCount);
  const time = (p: number) => (p / s.maxPath) * GROW_END;
  for (let id = 0; id < nodeCount; id++) {
    const { segs, radial, flare } = tubes[id]!;
    tube(
      out,
      vec(s.start, id),
      vec(s.mid, id),
      vec(s.end, id),
      s.radius[id * 2]!,
      s.radius[id * 2 + 1]!,
      segs,
      radial,
      flare,
      id,
      time(s.path[id * 2]!),
      time(s.path[id * 2 + 1]!),
    );
  }
  return out.mesh();
}

/**
 * A quadratic Bezier tube with an end cap, and a start cap unless it flares into the ground.
 * It samples the curve by its parameter, not arc length: the control point sits near the
 * chord's middle, so the two differ by less than a vertex wobble.
 */
function tube(
  out: MeshWriter,
  a: Vec3,
  m: Vec3,
  b: Vec3,
  r0: number,
  r1: number,
  segs: number,
  radial: number,
  flare: number,
  id: number,
  t0: number,
  t1: number,
) {
  const tangents: Vec3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    tangents.push(normalize(add(scale(sub(m, a), 2 * (1 - t)), scale(sub(b, m), 2 * t))));
  }
  const { normals, binormals } = frenetFrames(tangents);

  const first = out.vertices;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const u = 1 - t;
    const center = add(add(scale(a, u * u), scale(m, 2 * u * t)), scale(b, t * t));
    let r = r0 + (r1 - r0) * t ** 0.8;
    if (flare) r *= 1 + flare * u ** 4;
    for (let j = 0; j <= radial; j++) {
      const angle = (j / radial) * Math.PI * 2;
      const n = add(scale(normals[i]!, Math.cos(angle)), scale(binormals[i]!, Math.sin(angle)));
      out.vertex(addScaled(center, n, r), n, a, id, t0, t1);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const p = first + i * (radial + 1) + j;
      const q = p + radial + 1;
      out.triangle(p, q, p + 1);
      out.triangle(q, q + 1, p + 1);
    }
  }
  if (!flare) {
    const T0 = tangents[0]!;
    const cap = out.vertex(addScaled(a, T0, -r0 * 0.5), scale(T0, -1), a, id, t0, t1);
    for (let j = 0; j < radial; j++) out.triangle(first + j + 1, cap, first + j);
  }
  const T = tangents[segs]!;
  const tip = out.vertex(addScaled(b, T, r1 * 1.1), T, a, id, t0, t1);
  for (let j = 0; j < radial; j++) {
    const p = first + segs * (radial + 1) + j;
    out.triangle(p, tip, p + 1);
  }
}

/** Parallel-transported frames, as three.js Curve.computeFrenetFrames builds them. */
function frenetFrames(tangents: Vec3[]): { normals: Vec3[]; binormals: Vec3[] } {
  const t0 = tangents[0]!;
  const ax = Math.abs(t0[0]);
  const ay = Math.abs(t0[1]);
  const az = Math.abs(t0[2]);
  let seed: Vec3 = [1, 0, 0];
  let min = ax;
  if (ay <= min) {
    min = ay;
    seed = [0, 1, 0];
  }
  if (az <= min) seed = [0, 0, 1];
  const n0 = cross(t0, normalize(cross(t0, seed)));
  const normals: Vec3[] = [n0];
  const binormals: Vec3[] = [cross(t0, n0)];
  for (let i = 1; i < tangents.length; i++) {
    const prev = tangents[i - 1]!;
    const t = tangents[i]!;
    let n = normals[i - 1]!;
    const axis = cross(prev, t);
    if (length(axis) > Number.EPSILON) {
      n = rotate(n, normalize(axis), Math.acos(Math.min(1, Math.max(-1, dot(prev, t)))));
    }
    normals.push(n);
    binormals.push(cross(t, n));
  }
  return { normals, binormals };
}

function emitLeaves(
  order: Node[],
  s: Skeleton,
  quality: (typeof QUALITY)[Quality],
  leafL: number,
  langIndexOf: (file: FileEntry) => number,
  random: () => number,
): LeafMeshData {
  let leafCount = 0;
  for (const n of order) {
    if (n.files) leafCount += Math.min(n.files.length, quality.maxSprigs) * quality.leavesPerSprig;
  }
  const out = new MeshWriter(leafCount * 18, leafCount * 18);
  const lang = new Float32Array(leafCount * 18);
  const shade = new Float32Array(leafCount * 36);

  for (const n of order) {
    const files = n.files;
    if (!files) continue;
    const id = n.id;
    const start = vec(s.start, id);
    const end = vec(s.end, id);
    const p0 = s.path[id * 2]!;
    const p1 = s.path[id * 2 + 1]!;
    const T = normalize(sub(end, start));
    const sd = perp(T);
    const sprigs = Math.min(files.length, quality.maxSprigs);
    for (let i = 0; i < sprigs; i++) {
      const rep = files[Math.floor((i * files.length) / sprigs)]!;
      const tip = i >= sprigs - 2;
      const t = tip ? 1 : 0.35 + (0.6 * i) / Math.max(1, sprigs - 2);
      const at = lerp(start, end, t);
      const s2 = rotate(sd, T, i * 2.4);
      const ld = normalize(
        add(addScaled(scale(T, tip ? 0.8 : 0.45), s2, tip ? 0.6 : 0.9), [0, 0.2, 0]),
      );
      const t0 = ((p0 + (p1 - p0) * t) / s.maxPath) * GROW_END;
      const langIndex = langIndexOf(rep);
      for (let k = 0; k < quality.leavesPerSprig; k++) {
        const lk =
          k === 0
            ? ld
            : normalize(lerp(rotate(ld, T, (k % 2 ? 1 : -1) * (0.9 + 0.5 * random())), T, 0.2));
        const first = out.vertices;
        const [dh, dl] = leaf(out, addScaled(at, lk, k ? 0.02 : 0), lk, id, t0, leafL, random);
        for (let v = first; v < out.vertices; v++) {
          lang[v] = langIndex;
          shade[v * 2] = dh;
          shade[v * 2 + 1] = dl + ((v - first) % 6 < 3 ? -0.025 : 0.025);
        }
      }
    }
  }
  return { ...out.mesh(), lang, shade };
}

/** A faceted hexagonal leaf: six triangles fanned around a raised center. Returns its shade. */
function leaf(
  out: MeshWriter,
  at: Vec3,
  ld: Vec3,
  id: number,
  t0: number,
  leafL: number,
  random: () => number,
): [number, number] {
  const up = add(UP, scale([random() - 0.5, random() * 0.4, random() - 0.5], 0.9));
  const nrm = normalize(addScaled(up, ld, -dot(up, ld)));
  const yv = normalize(cross(nrm, ld));
  const L = leafL * (0.8 + 0.45 * random());
  const w = L * 0.42;
  const q = (u: number, v: number, h: number) =>
    addScaled(addScaled(addScaled(at, ld, u * L), yv, v * w), nrm, h * L);
  const rim = [
    q(0, 0, 0),
    q(0.3, -0.9, 0.03),
    q(0.66, -0.7, 0),
    q(1, 0, -0.05),
    q(0.66, 0.7, 0),
    q(0.3, 0.9, 0.03),
  ];
  const center = q(0.46, 0, 0.08);
  const hue = (random() - 0.5) * 0.04;
  const light = (random() - 0.5) * 0.1;
  const t1 = t0 + LEAF_UNFOLD;
  for (let k = 0; k < 6; k++) {
    const A = rim[k]!;
    const B = rim[(k + 1) % 6]!;
    let fn = normalize(cross(sub(B, A), sub(center, A)));
    if (dot(fn, nrm) < 0) fn = scale(fn, -1);
    const v = out.vertex(A, fn, at, id, t0, t1);
    out.vertex(B, fn, at, id, t0, t1);
    out.vertex(center, fn, at, id, t0, t1);
    out.triangle(v, v + 1, v + 2);
  }
  return [hue, light];
}

function labelAnchor(order: Node[], s: Skeleton, lo: number, hi: number): Vec3 {
  const tips: Vec3[] = [];
  for (let id = lo; id <= hi; id++) if (order[id]!.files) tips.push(vec(s.end, id));
  const centroid = scale(tips.reduce(add, [0, 0, 0]), 1 / tips.length);
  let best = tips[0]!;
  let bestDistance = Infinity;
  for (const tip of tips) {
    const d = dot(sub(tip, centroid), sub(tip, centroid));
    if (d < bestDistance) {
      bestDistance = d;
      best = tip;
    }
  }
  return best;
}

function boundsOf(buffers: Float32Array[]): TreeModel['bounds'] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const position of buffers) {
    for (let i = 0; i < position.length; i++) {
      const v = position[i]!;
      const axis = i % 3;
      if (v < min[axis]!) min[axis] = v;
      if (v > max[axis]!) max[axis] = v;
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

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const vec = (buffer: Float64Array, i: number): Vec3 => [
  buffer[i * 3]!,
  buffer[i * 3 + 1]!,
  buffer[i * 3 + 2]!,
];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const addScaled = (a: Vec3, b: Vec3, k: number): Vec3 => [
  a[0] + b[0] * k,
  a[1] + b[1] * k,
  a[2] + b[2] * k,
];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => addScaled(a, sub(b, a), t);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3) => Math.sqrt(dot(a, a));
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Rodrigues rotation of v about a unit axis. */
const rotate = (v: Vec3, axis: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
};
const perp = (d: Vec3): Vec3 => normalize(cross(d, Math.abs(d[1]) < 0.95 ? UP : [1, 0, 0]));
