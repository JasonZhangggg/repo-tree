import { beforeAll, describe, expect, test } from 'vitest';
import { buildHierarchy, DEFAULT_FILTERS } from '../repo/hierarchy';
import { sample, type SampleId } from '../test/samples';
import { growTree, type Quality, type TreeModel } from './grow';
import { growGround, KIND, type GroundMesh, type GroundSite } from './ground';

const FLARE = 1.55;
const BUDGET: Record<Quality, number> = { low: 3000, medium: 4500, high: 6000 };
const trees = new Map<SampleId, TreeModel>();
beforeAll(async () => {
  for (const id of ['mathiasbynens-dotfiles', 'torvalds-linux'] as SampleId[]) {
    const dir = buildHierarchy(await sample(id), DEFAULT_FILTERS);
    trees.set(id, growTree(dir, { seed: 42, quality: 'high' }));
  }
});

const siteOf = (tree: TreeModel): GroundSite => ({
  trunk: tree.nodes.radius[0]! * FLARE,
  bounds: tree.bounds,
  front: Math.atan2(0.95, 0.3),
  rocks: tree.rocks.map((r) => r.bytes),
});
const triangles = (mesh: GroundMesh) => mesh.kind.length / 3;
const horizontal = (mesh: GroundMesh, v: number) =>
  Math.hypot(mesh.position[v * 3]!, mesh.position[v * 3 + 2]!);

describe.each(['mathiasbynens-dotfiles', 'torvalds-linux'] as SampleId[])(
  'growGround for %s',
  (id) => {
    test('grows the same ground from the same seed and another from another', () => {
      const site = siteOf(trees.get(id)!);
      const a = growGround(site, { seed: 7, quality: 'high' });
      expect(growGround(site, { seed: 7, quality: 'high' })).toEqual(a);
      expect(growGround(site, { seed: 8, quality: 'high' }).land.position).not.toEqual(
        a.land.position,
      );
    });

    test.each(['low', 'medium', 'high'] as const)(
      'stays within the %s triangle budget',
      (quality) => {
        const ground = growGround(siteOf(trees.get(id)!), { seed: 7, quality });
        expect(triangles(ground.land) + triangles(ground.cover)).toBeLessThan(BUDGET[quality]);
      },
    );

    test('keeps every vertex inside its bounds, and its bounds near the crown', () => {
      const tree = trees.get(id)!;
      const { land, cover, bounds } = growGround(siteOf(tree), { seed: 7, quality: 'high' });
      for (const { position } of [land, cover]) {
        for (let i = 0; i < position.length; i++) {
          expect(position[i]!).toBeGreaterThanOrEqual(bounds.min[i % 3]!);
          expect(position[i]!).toBeLessThanOrEqual(bounds.max[i % 3]!);
        }
      }
      const span = Math.max(
        tree.bounds.max[0] - tree.bounds.min[0],
        tree.bounds.max[2] - tree.bounds.min[2],
      );
      expect(Math.max(-bounds.min[0], bounds.max[0], -bounds.min[2], bounds.max[2])).toBeLessThan(
        span * 0.6,
      );
      expect(bounds.max[1], 'nothing rises past the lower trunk').toBeLessThan(span * 0.15);
    });

    test('lays rocks and grass around the trunk, never inside it', () => {
      const site = siteOf(trees.get(id)!);
      const { land, cover } = growGround(site, { seed: 7, quality: 'high' });
      for (let v = 0; v < land.rock.length; v++) {
        if (land.kind[v] === KIND.rock || land.kind[v] === KIND.cap) {
          expect(horizontal(land, v)).toBeGreaterThan(site.trunk);
        }
      }
      for (let v = 0; v < cover.kind.length; v++) {
        expect(horizontal(cover, v)).toBeGreaterThan(site.trunk);
      }
    });

    test('lays one rock for each entry, larger for more bytes', () => {
      const site = siteOf(trees.get(id)!);
      const { land } = growGround(site, { seed: 7, quality: 'high' });
      const xs = new Map<number, number[]>();
      for (let v = 0; v < land.rock.length; v++) {
        const rock = land.rock[v]!;
        if (rock < 0) continue;
        expect(land.kind[v] === KIND.rock || land.kind[v] === KIND.cap).toBe(true);
        xs.set(rock, [...(xs.get(rock) ?? []), land.position[v * 3]!]);
      }
      expect([...xs.keys()].sort((a, b) => a - b)).toEqual(site.rocks.map((_, i) => i));
      const width = (rock: number) => Math.max(...xs.get(rock)!) - Math.min(...xs.get(rock)!);
      const smallest = trees.get(id)!.rocks.findLastIndex((r) => r.files.length === 1);
      expect(width(0)).toBeGreaterThan(width(smallest));
    });
  },
);

test('leaves only bare pebbles that pick nothing when the root holds no files', () => {
  const tree = trees.get('torvalds-linux')!;
  const { land } = growGround({ ...siteOf(tree), rocks: [] }, { seed: 7, quality: 'high' });
  const stones = land.kind.filter((k) => k === KIND.rock || k === KIND.cap).length;
  expect(stones).toBeGreaterThan(0);
  expect(land.rock.every((r) => r === -1)).toBe(true);
});

test('shows blades, then flowers, then fallen leaves, each as one run', () => {
  const { cover } = growGround(siteOf(trees.get('torvalds-linux')!), { seed: 7, quality: 'high' });
  const runs = [
    [KIND.blade, cover.blades],
    [KIND.flower, cover.flowers],
    [KIND.litter, cover.litter],
  ] as const;
  let start = 0;
  for (const [kind, count] of runs) {
    expect(count).toBeGreaterThan(0);
    const run = [...cover.kind.slice(start, start + count)];
    expect(run.every((k) => k === kind || (kind === KIND.flower && k === KIND.blade))).toBe(true);
    start += count;
  }
  expect(start).toBe(cover.kind.length);
});
