import type { FileEntry } from '../repo/github';
import type { Dir } from '../repo/hierarchy';
import { langOf, type Lang } from '../repo/languages';
import { treeHeight, twigBudget } from './size';

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
  /** Languages present, most files first. */
  langs: { lang: Lang; files: number }[];
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
  /**
   * Each sprig of leaves stands for a run of its twig's files. Sprig `s` draws leaf vertices
   * `vertex[s]` to `vertex[s + 1]` and stands for `files[file[s]]` to `files[file[s + 1]]`, which
   * are RepoIndex.files ids (folders in preorder, each folder's own files in order).
   */
  sprigs: { vertex: Uint32Array; file: Uint32Array; files: Uint32Array };
  /** One per top-level folder, at its anchor. */
  labels: { folder: number; files: number; anchor: Vec3 }[];
  /**
   * A label anchor per folder as xyz, on the outer face of its part of the crown: the twig tip
   * that reaches farthest out, and a little up, toward the side the folder's twigs lean to.
   */
  anchors: Float32Array;
  /**
   * The root folder's own files lie on the ground as rocks, largest first, when the root also
   * has subfolders. `files` index the root folder's own files; the last rock may hold the rest.
   */
  rocks: { files: number[]; bytes: number }[];
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
const MIN_TWIG_FILES = 4;
/** Leaf length on the approved tree, which had about APPROVED_TWIGS twigs. */
const LEAF_LENGTH = 0.16;
const APPROVED_TWIGS = 150;
const LEAF_UNFOLD = 0.12;
/** Past this many root files, the smallest share the last rock. */
const ROCKS = 12;

type Node = {
  w: number;
  kids: Node[];
  files: FileEntry[] | null;
  folder: number;
  ownsFolder: boolean;
  /** Folders folded into this twig that own no node of their own. */
  absorbed: number[];
  id: number;
};

export function growTree(root: Dir, params: GrowParams): TreeModel {
  if (root.fileCount === 0) throw new RangeError('growTree needs a folder with at least one file');
  const quality = QUALITY[params.quality];

  const folderPaths: string[] = [];
  const folderOf = new Map<Dir, number>();
  const fileId = new Map<FileEntry, number>();
  const indexFolders = (dir: Dir) => {
    folderOf.set(dir, folderPaths.length);
    folderPaths.push(dir.path);
    for (const file of dir.files) fileId.set(file, fileId.size);
    for (const child of dir.dirs) indexFolders(child);
  };
  indexFolders(root);

  const rocks = root.dirs.length > 0 ? rocksOf(root.files) : [];
  const build = (dir: Dir): Node => {
    const folder = folderOf.get(dir)!;
    const kids = dir.dirs.map(build);
    const twigFiles = dir === root && rocks.length > 0 ? [] : dir.files;
    for (const file of twigFiles) kids.push(node(1, [], [file], folder, false));
    const n = node(dir.fileCount - dir.files.length + twigFiles.length, kids, null, folder, true);
    binarize(n);
    return n;
  };
  const top = build(root);
  const twigs = cut(top, twigBudget(root.fileCount));

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
  for (const n of order) {
    if (n.ownsFolder) {
      range[2 * n.folder] = n.id;
      range[2 * n.folder + 1] = lastOf[n.id]!;
    }
    for (const folder of n.absorbed) {
      range[2 * folder] = n.id;
      range[2 * folder + 1] = n.id;
    }
  }

  const trunkR = Math.min(0.24, Math.max(0.09, 0.2 * (top.w / 527) ** 0.2));
  const skeleton = growSkeleton(top, nodeCount, trunkR, mulberry32(params.seed));
  const height = treeHeight(root.fileCount);
  scaleSkeleton(skeleton, height / tipHeight(skeleton));

  const treeLangs = new Map(root.langs);
  if (rocks.length > 0) {
    for (const file of root.files) {
      const lang = langOf(file.path);
      const left = treeLangs.get(lang)! - 1;
      if (left > 0) treeLangs.set(lang, left);
      else treeLangs.delete(lang);
    }
  }
  const langs = [...treeLangs]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .map(([lang, files]) => ({ lang, files }));
  const langIndex = new Map(langs.map(({ lang }, i) => [lang, i]));

  const bark = emitBark(skeleton, quality);
  const leaves = emitLeaves(
    order,
    skeleton,
    quality,
    LEAF_LENGTH * Math.min(2, Math.max(0.85, (APPROVED_TWIGS / twigs) ** 0.3)),
    (file) => langIndex.get(langOf(file.path))!,
    (file) => fileId.get(file)!,
    mulberry32(params.seed ^ 0x5bd1e995),
  );

  const anchors = new Float32Array(folderPaths.length * 3);
  for (let folder = 0; folder < folderPaths.length; folder++) {
    anchors.set(
      labelAnchor(order, skeleton, range[2 * folder]!, range[2 * folder + 1]!),
      folder * 3,
    );
  }

  const nodeFolder = new Uint32Array(nodeCount);
  const nodeFiles = new Uint32Array(nodeCount);
  for (const n of order) {
    nodeFolder[n.id] = n.folder;
    nodeFiles[n.id] = n.files?.length ?? 0;
  }

  return {
    bark,
    leaves: leaves.mesh,
    sprigs: leaves.sprigs,
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
      return { folder, files: dir.fileCount, anchor: vec(anchors, folder) };
    }),
    anchors,
    rocks,
    bounds: boundsOf([bark.position, leaves.mesh.position]),
  };
}

function rocksOf(files: readonly FileEntry[]): TreeModel['rocks'] {
  const ranked = files
    .map((file, i) => ({ i, bytes: file.size }))
    .sort((a, b) => b.bytes - a.bytes || a.i - b.i);
  const own = ranked.length > ROCKS ? ranked.slice(0, ROCKS - 1) : ranked;
  const rocks = own.map(({ i, bytes }) => ({ files: [i], bytes }));
  const rest = ranked.slice(own.length);
  if (rest.length > 0) {
    rocks.push({
      files: rest.map(({ i }) => i),
      bytes: rest.reduce((sum, { bytes }) => sum + bytes, 0),
    });
  }
  return rocks;
}

const node = (
  w: number,
  kids: Node[],
  files: FileEntry[] | null,
  folder: number,
  ownsFolder: boolean,
): Node => ({ w, kids, files, folder, ownsFolder, absorbed: [], id: -1 });

/**
 * Huffman-style: merge the two lightest kids until two remain, so heavy limbs fork late.
 * Merged weights only grow, so a second queue keeps them sorted without re-sorting.
 */
function binarize(n: Node) {
  if (n.kids.length <= 2) return;
  const kids = n.kids.slice().sort((a, b) => a.w - b.w);
  const merged: Node[] = [];
  let k = 0;
  let m = 0;
  const lightest = () =>
    m >= merged.length || (k < kids.length && kids[k]!.w <= merged[m]!.w)
      ? kids[k++]!
      : merged[m++]!;
  for (let left = kids.length; left > 2; left--) {
    const a = lightest();
    const b = lightest();
    merged.push(node(a.w + b.w, [a, b], null, n.folder, false));
  }
  n.kids = [...kids.slice(k), ...merged.slice(m)];
}

/**
 * Turns the full tree into at most `budget` twigs (see twigBudget), so the crown stays open.
 * It opens the heaviest branches first and folds each branch left closed into one twig that carries all its files and belongs to
 * the deepest folder that still owns a node. The forks between top-level folders open even
 * past the budget, so every top-level folder keeps its own limb. Returns the twig count.
 */
function cut(top: Node, budget: number): number {
  const opened = new Set<Node>();
  let twigs = 1;
  const open = (n: Node) => {
    opened.add(n);
    twigs += n.kids.length - 1;
  };
  const holdsTopFolder = (n: Node): boolean =>
    n.ownsFolder || (!n.files && n.kids.some(holdsTopFolder));
  open(top);
  const forced = top.kids.filter((k) => !k.ownsFolder && holdsTopFolder(k));
  while (forced.length > 0) {
    const n = forced.pop()!;
    open(n);
    for (const k of n.kids) if (!k.ownsFolder && holdsTopFolder(k)) forced.push(k);
  }

  const candidates: Node[] = [];
  const collect = (n: Node) => {
    if (n.kids.length === 0 || n.w <= MIN_TWIG_FILES) return;
    candidates.push(n);
    for (const k of n.kids) collect(k);
  };
  collect(top);
  const parent = new Map<Node, Node>();
  for (const n of candidates) for (const k of n.kids) parent.set(k, n);
  const ranked = candidates.map((n, i) => ({ n, i })).sort((a, b) => b.n.w - a.n.w || a.i - b.i);
  for (const { n } of ranked) {
    if (twigs >= budget) break;
    if (!opened.has(n) && opened.has(parent.get(n)!)) open(n);
  }

  const fold = (n: Node, into: Node) => {
    if (n.ownsFolder && n !== into) into.absorbed.push(n.folder);
    if (n.files) into.files!.push(...n.files);
    for (const k of n.kids) fold(k, into);
  };
  const close = (n: Node) => {
    if (opened.has(n)) {
      for (const k of n.kids) close(k);
      return;
    }
    if (n.files) return;
    const kids = n.kids;
    n.files = [];
    n.kids = [];
    for (const k of kids) fold(k, n);
  };
  close(top);
  return twigs;
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
    az0: number,
    az1: number,
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
      return grow(
        a,
        end,
        d,
        lenOf(a.w),
        rChild(a),
        roll + GOLDEN_ANGLE,
        depth + 1,
        path + len,
        az0,
        az1,
      );
    }
    // Each fork shares its slice of the compass between its kids (see ORDER).
    const cutAt = az0 + ((az1 - az0) * a.w ** ORDER.exp) / (a.w ** ORDER.exp + b.w ** ORDER.exp);
    const theta = SHAPE.spread * (0.85 + 0.3 * random());
    const angA = (theta * b.w) / (a.w + b.w);
    const angB = Math.max(0.42, (theta * a.w) / (a.w + b.w));
    const axis = forkAxis(dir, roll, az0, cutAt, az1, random);
    grow(
      a,
      end,
      tropism(rotate(dir, axis, angA), a.w),
      lenOf(a.w),
      rChild(a),
      roll + GOLDEN_ANGLE,
      depth + 1,
      path + len,
      az0,
      cutAt,
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
      cutAt,
      az1,
    );
  };
  grow(
    top,
    [0, -0.06, 0],
    normalize([0.05, 1, 0.02]),
    SHAPE.trunkLen,
    trunkR,
    0,
    0,
    0,
    0,
    Math.PI * 2,
  );
  return s;
}

/**
 * Folders keep to their own side of the crown by how each fork turns, not by bending branches:
 * every fork shares its slice of the compass between its kids (by files to the power `exp`, so
 * small folders still get room) and turns about its limb so each kid sets off toward its own
 * share, give or take `wobble` radians. A slice narrower than `least` radians no longer steers,
 * and its forks turn by the golden angle as before, so twigs spread naturally.
 */
const ORDER = { exp: 0.5, least: 0.35, wobble: 0.25 };

/** The axis a fork turns its kids about: `a` turns toward [az0, cut], `b` toward [cut, az1]. */
function forkAxis(
  dir: Vec3,
  roll: number,
  az0: number,
  cut: number,
  az1: number,
  random: () => number,
): Vec3 {
  const free = rotate(perp(dir), dir, roll);
  if (Math.min(cut - az0, az1 - cut) < ORDER.least) return free;
  const toward = (az: number): Vec3 => [Math.cos(az), 0, Math.sin(az)];
  const apart = sub(toward((az0 + cut) / 2), toward((cut + az1) / 2));
  const m = addScaled(apart, dir, -dot(apart, dir));
  if (length(m) < 1e-3) return free;
  const axis = normalize(cross(dir, normalize(m)));
  return rotate(axis, dir, (random() - 0.5) * 2 * ORDER.wobble);
}

function tipHeight(s: Skeleton): number {
  let top = 0;
  for (let i = 1; i < s.end.length; i += 3) top = Math.max(top, s.end[i]!);
  return top;
}

/** Scales the whole tree about its root, trunk thickness included, so its proportions hold. */
function scaleSkeleton(s: Skeleton, k: number) {
  for (const buffer of [s.start, s.mid, s.end, s.radius, s.path]) {
    for (let i = 0; i < buffer.length; i++) buffer[i]! *= k;
  }
  s.maxPath *= k;
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
  idOf: (file: FileEntry) => number,
  random: () => number,
): { mesh: LeafMeshData; sprigs: TreeModel['sprigs'] } {
  let sprigCount = 0;
  let fileCount = 0;
  for (const n of order) {
    if (!n.files) continue;
    sprigCount += Math.min(n.files.length, quality.maxSprigs);
    fileCount += n.files.length;
  }
  const leafCount = sprigCount * quality.leavesPerSprig;
  const out = new MeshWriter(leafCount * 18, leafCount * 18);
  const lang = new Float32Array(leafCount * 18);
  const shade = new Float32Array(leafCount * 36);
  const sprigs = {
    vertex: new Uint32Array(sprigCount + 1),
    file: new Uint32Array(sprigCount + 1),
    files: new Uint32Array(fileCount),
  };
  let sprig = 0;
  let slot = 0;

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
    const count = Math.min(files.length, quality.maxSprigs);
    for (let i = 0; i < count; i++) {
      const from = Math.floor((i * files.length) / count);
      const to = Math.floor(((i + 1) * files.length) / count);
      const rep = files[from]!;
      sprigs.vertex[sprig] = out.vertices;
      sprigs.file[sprig++] = slot;
      for (let f = from; f < to; f++) sprigs.files[slot++] = idOf(files[f]!);
      const tip = i >= count - 2;
      const t = tip ? 1 : 0.35 + (0.6 * i) / Math.max(1, count - 2);
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
          shade[v * 2 + 1] = dl + ((v - first) % 6 < 3 ? -SHADE.facet : SHADE.facet);
        }
      }
    }
  }
  sprigs.vertex[sprig] = out.vertices;
  sprigs.file[sprig] = slot;
  return { mesh: { ...out.mesh(), lang, shade }, sprigs };
}

/**
 * How far one leaf's color strays from its slot, as offsets the leaf shader applies in HSL: up to
 * `hue` turns of hue and `light` of lightness per leaf, and `facet` lighter or darker per half.
 */
export const SHADE = { hue: 0.008, light: 0.06, facet: 0.04 };

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
  const hue = (random() - 0.5) * 2 * SHADE.hue;
  const light = (random() - 0.5) * 2 * SHADE.light;
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
  const out = normalize([centroid[0], 0, centroid[2]]);
  let best = tips[0]!;
  let bestScore = -Infinity;
  for (const tip of tips) {
    const score = ANCHOR_OUT * dot(tip, out) + ANCHOR_UP * tip[1] - length(sub(tip, centroid));
    if (score > bestScore) {
      bestScore = score;
      best = tip;
    }
  }
  return best;
}

/**
 * A label anchor is the twig tip nearest the middle of its folder's twigs, leaning a little
 * outward and up so it sits on the crown's surface rather than buried inside it.
 */
const ANCHOR_OUT = 0.3;
const ANCHOR_UP = 0.15;

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
const vec = (buffer: Float64Array | Float32Array, i: number): Vec3 => [
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
