import { beforeAll, describe, expect, test } from 'vitest';
import { buildHierarchy, DEFAULT_FILTERS, type Dir } from '../repo/hierarchy';
import { sample, type SampleId } from '../test/samples';
import { growTree, type GrowParams, type MeshData, type TreeModel } from './grow';

const HIGH: GrowParams = { seed: 42, quality: 'high' };
const SAMPLES: SampleId[] = ['mathiasbynens-dotfiles', 'vitejs-vite', 'torvalds-linux'];

const dirs = new Map<SampleId, Dir>();
beforeAll(async () => {
  for (const id of SAMPLES) dirs.set(id, buildHierarchy(await sample(id), DEFAULT_FILTERS));
});
const dirOf = (id: SampleId) => dirs.get(id)!;

const allDirs = (dir: Dir): Dir[] => [dir, ...dir.dirs.flatMap(allDirs)];
const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const within = (path: string, ancestor: string) =>
  ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);

function triangleNodes(mesh: MeshData): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < mesh.index.length; i += 3) {
    const node = mesh.nodeId[mesh.index[i]!]!;
    counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return counts;
}

function positions(tree: TreeModel): Float32Array[] {
  return [tree.bark.position, tree.leaves.position];
}

describe.each(SAMPLES)('growTree on %s', (id) => {
  let tree: TreeModel;
  beforeAll(() => {
    tree = growTree(dirOf(id), HIGH);
  });

  test('represents every file in exactly one twig', () => {
    const total = tree.nodes.files.reduce((sum, n) => sum + n, 0);
    expect(total).toBe(dirOf(id).fileCount);
  });

  test('lists every folder in preorder with the root first', () => {
    expect(tree.folders.path).toEqual(allDirs(dirOf(id)).map((d) => d.path));
  });

  test('gives each folder a node range nested inside its parent folder range', () => {
    const { path, range } = tree.folders;
    const index = new Map(path.map((p, i) => [p, i]));
    for (let f = 1; f < path.length; f++) {
      const parent = index.get(parentPath(path[f]!))!;
      expect(range[2 * f]!).toBeLessThanOrEqual(range[2 * f + 1]!);
      expect(range[2 * f]!).toBeGreaterThanOrEqual(range[2 * parent]!);
      expect(range[2 * f + 1]!).toBeLessThanOrEqual(range[2 * parent + 1]!);
    }
  });

  test('keeps exactly a folder subtree inside each folder range', () => {
    const { path, range } = tree.folders;
    const nodeCount = tree.nodes.folder.length;
    expect(range[0]).toBe(0);
    expect(range[1]).toBe(nodeCount - 1);
    for (let f = 0; f < path.length; f++) {
      const lo = range[2 * f]!;
      const hi = range[2 * f + 1]!;
      const inside = (n: number) => within(path[tree.nodes.folder[n]!]!, path[f]!);
      const strays: number[] = [];
      for (let n = 0; n < nodeCount; n++) if (inside(n) && (n < lo || n > hi)) strays.push(n);
      expect(strays, `nodes of ${path[f]} outside its range`).toEqual([]);

      const merged = lo === hi && within(path[f]!, path[tree.nodes.folder[lo]!]!);
      const foreign: number[] = [];
      for (let n = lo; n <= hi && !merged; n++) if (!inside(n)) foreign.push(n);
      expect(foreign, `nodes of other folders in the range of ${path[f]}`).toEqual([]);
    }
  });

  test('never widens a branch toward the tips', () => {
    const { parent, radius } = tree.nodes;
    const widening: number[] = [];
    for (let n = 0; n < parent.length; n++) {
      const p = parent[n]!;
      const start = radius[2 * n]!;
      if (radius[2 * n + 1]! > start || (p >= 0 && start > radius[2 * p + 1]!)) widening.push(n);
    }
    expect(widening).toEqual([]);
  });

  test('writes only finite positions, all inside the bounds', () => {
    const { min, max } = tree.bounds;
    for (const position of positions(tree)) {
      const outside = position.findIndex(
        (v, i) => !Number.isFinite(v) || v < min[i % 3]! || v > max[i % 3]!,
      );
      expect(outside).toBe(-1);
    }
  });

  test('indexes every vertex and nothing past the end', () => {
    for (const mesh of [tree.bark, tree.leaves]) {
      const used = new Uint8Array(mesh.position.length / 3);
      for (const i of mesh.index) used[i] = 1;
      expect(used.every((u) => u === 1)).toBe(true);
    }
  });

  test('hangs leaves only on twigs', () => {
    for (const node of triangleNodes(tree.leaves).keys()) {
      expect(tree.nodes.files[node]).toBeGreaterThan(0);
    }
  });

  test('colors leaves by an index into the languages present, most files first', () => {
    expect(new Map(tree.langs.map((l) => [l.lang, l.files]))).toEqual(dirOf(id).langs);
    const files = tree.langs.map((l) => l.files);
    expect(files).toEqual(files.toSorted((a, b) => b - a));
    const invalid = tree.leaves.lang.findIndex(
      (lang) => !Number.isInteger(lang) || lang < 0 || lang >= tree.langs.length,
    );
    expect(invalid).toBe(-1);
  });

  test('labels each top-level folder once with its file count', () => {
    const top = dirOf(id).dirs.map((d) => [d.path, d.fileCount]);
    expect(tree.labels.map((l) => [tree.folders.path[l.folder], l.files])).toEqual(top);
  });

  test('keeps the crown open with at most 200 twigs', () => {
    const twigs = tree.nodes.files.filter((n) => n > 0).length;
    expect(twigs).toBeLessThanOrEqual(200);
  });

  test('gives every top-level folder a limb of its own', () => {
    for (const { folder } of tree.labels) {
      const lo = tree.folders.range[2 * folder]!;
      expect(tree.nodes.folder[lo], tree.folders.path[folder]).toBe(folder);
    }
  });
});

describe('growTree determinism', () => {
  test('grows byte-identical buffers from the same seed', () => {
    const a = growTree(dirOf('vitejs-vite'), HIGH);
    const b = growTree(dirOf('vitejs-vite'), HIGH);

    for (const key of ['position', 'normal', 'base', 'timing', 'nodeId', 'index'] as const) {
      expect(Buffer.from(a.bark[key].buffer).equals(Buffer.from(b.bark[key].buffer))).toBe(true);
      expect(Buffer.from(a.leaves[key].buffer).equals(Buffer.from(b.leaves[key].buffer))).toBe(
        true,
      );
    }
    expect(Buffer.from(a.leaves.shade.buffer).equals(Buffer.from(b.leaves.shade.buffer))).toBe(
      true,
    );
  });

  test('grows a different tree from a different seed', () => {
    const a = growTree(dirOf('vitejs-vite'), HIGH);
    const b = growTree(dirOf('vitejs-vite'), { ...HIGH, seed: 43 });

    expect(Buffer.from(a.bark.position.buffer).equals(Buffer.from(b.bark.position.buffer))).toBe(
      false,
    );
  });
});

describe('growTree quality', () => {
  test.each([
    ['low', 2, 3],
    ['medium', 3, 4],
    ['high', 3, 5],
  ] as const)(
    '%s hangs %i leaves per sprig and at most %i sprigs per twig',
    (quality, leaves, sprigs) => {
      const tree = growTree(dirOf('vitejs-vite'), { seed: 42, quality });

      const triangles = triangleNodes(tree.leaves);
      for (let n = 0; n < tree.nodes.files.length; n++) {
        const files = tree.nodes.files[n]!;
        if (files === 0) continue;
        expect(triangles.get(n)).toBe(Math.min(files, sprigs) * leaves * 6);
      }
    },
  );

  test('keeps the branch skeleton and labels the same at every quality', () => {
    const [low, medium, high] = (['low', 'medium', 'high'] as const).map((quality) =>
      growTree(dirOf('vitejs-vite'), { seed: 42, quality }),
    );

    for (const other of [low!, medium!]) {
      expect(other.nodes.radius).toEqual(high!.nodes.radius);
      expect(other.labels).toEqual(high!.labels);
    }
    expect(low!.bark.position.length).toBeLessThan(high!.bark.position.length);
  });
});

test('refuses a folder with no files', () => {
  const empty: Dir = {
    path: '',
    name: 'r',
    dirs: [],
    files: [],
    fileCount: 0,
    bytes: 0,
    langs: new Map(),
  };
  expect(() => growTree(empty, HIGH)).toThrow(RangeError);
});

test('grows the linux tree from its snapshot within the budget', async () => {
  const snapshot = await sample('torvalds-linux');
  growTree(buildHierarchy(snapshot, DEFAULT_FILTERS), HIGH);

  const start = performance.now();
  growTree(buildHierarchy(snapshot, DEFAULT_FILTERS), HIGH);
  const elapsed = performance.now() - start;

  expect(elapsed).toBeLessThan(1500);
});
