import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';
import { growTree, type TreeModel } from '../grow/grow';
import { indexRepo } from '../load/repo-index';
import { PALETTES } from '../render/palette';
import { leafCategories } from '../render/tree-view';
import { buildHierarchy, DEFAULT_FILTERS } from '../repo/hierarchy';
import { parseHistory, type History } from '../repo/history';
import { sample, type SampleId } from '../test/samples';
import { historyFacts, type Facts } from './facts';
import { folderOwner, historyOwners, NO_OWNER, ownerCategories } from './owners';

const author = (name: string, commits: number, weight: number) => ({ name, commits, weight });

describe('folderOwner', () => {
  test("CODEOWNERS' first owner wins over every author", () => {
    const row = {
      folder: 'packages',
      authors: [author('ada', 9, 40)],
      codeowners: ['@vitejs/team', '@ada'],
    };
    expect(folderOwner(row)).toMatchObject({ owner: '@vitejs/team', from: 'codeowners' });
  });

  test('else the author with the most recent commits, then the most weight', () => {
    const row = {
      folder: 'docs',
      authors: [author('old hand', 0, 300), author('peer', 3, 10), author('busy', 3, 40)],
      codeowners: [],
    };
    const owner = folderOwner(row);
    expect(owner).toMatchObject({ owner: 'busy', from: 'authors' });
    expect(owner.authors.map((a) => a.name)).toEqual(['busy', 'peer', 'old hand']);
  });

  test('nobody when there are neither', () => {
    expect(folderOwner({ folder: 'x', authors: [], codeowners: [] })).toMatchObject({
      owner: null,
      from: null,
    });
  });
});

const historyOf = (id: SampleId): History =>
  parseHistory(
    JSON.parse(gunzipSync(readFileSync(`public/samples/${id}.history.json.gz`)).toString()),
  )!;

describe('ownerCategories', () => {
  test('owners shared across folders share one category with all their files', () => {
    const owners = historyOwners(historyOf('vitejs-vite'));
    const { categories, categoryOf } = ownerCategories(
      [
        { folder: 'packages', files: 100 },
        { folder: 'playground', files: 50 },
        { folder: 'docs', files: 20 },
        { folder: 'patches', files: 3 },
        { folder: 'nowhere', files: 2 },
      ],
      owners,
    );
    expect(categories).toEqual([
      { label: '翠', files: 120 },
      { label: 'andrew', files: 50 },
      { label: '翠 / green', files: 3 },
      { label: NO_OWNER, files: 2 },
    ]);
    expect(categoryOf).toEqual([0, 1, 0, 2, 3]);
  });
});

for (const id of ['vitejs-vite', 'torvalds-linux', 'mathiasbynens-dotfiles'] as const) {
  describe(`owner colors on ${id}`, () => {
    let tree: TreeModel;
    let history: History;
    let facts: Facts;
    beforeAll(async () => {
      const dir = buildHierarchy(await sample(id), DEFAULT_FILTERS);
      tree = growTree(dir, { seed: 42, quality: 'low' });
      history = historyOf(id);
      facts = historyFacts(history, tree, indexRepo(dir));
    });

    test('owners come from commit authors, none of them bots', () => {
      expect(facts.owners.from).toBe('authors');
      expect(facts.owners.since).toBe(history.recent.since);
      for (const row of facts.owners.folders.values()) {
        expect(row.owner).toBe(row.authors[0]!.name);
        expect(row.authors.some((a) => /\[bot\]$/.test(a.name))).toBe(false);
      }
    });

    test("every top-level folder's leaves take its owner's legend slot", () => {
      const palette = PALETTES.autumn;
      const { legend, slotOf, nodeCategory } = leafCategories(tree, 'owner', palette, facts);
      const ramp = palette.leaves.length;
      expect(legend.reduce((sum, e) => sum + e.files, 0)).toBe(
        tree.nodes.files.reduce((sum, n) => sum + n, 0),
      );
      expect(legend.length).toBeLessThanOrEqual(ramp + 1);
      for (const { folder } of tree.labels) {
        const owner = facts.owners.folders.get(tree.folders.path[folder]!)?.owner ?? NO_OWNER;
        const node = tree.folders.range[2 * folder]!;
        const slot = slotOf[nodeCategory![node]!]!;
        const at = legend.findIndex((e) => e.label === owner);
        // Legend index is the slot, and owners past the named ones share the last.
        expect(slot).toBe(at >= 0 ? at : ramp);
      }
    });

    test('without the history, leaves keep language colors', () => {
      const palette = PALETTES.autumn;
      expect(leafCategories(tree, 'owner', palette, null).legend).toEqual(
        leafCategories(tree, 'language', palette).legend,
      );
    });
  });
}

test("linux's folders go to their recent maintainers, else the heaviest author", () => {
  const owners = historyOwners(historyOf('torvalds-linux'));
  const names = new Set([...owners.folders.values()].map((o) => o.owner));
  expect(names.size).toBeGreaterThan(2);
  expect(owners.folders.get('kernel')!.owner).toBe('Alexei Starovoitov');
  expect(owners.folders.get('arch')!.owner).toBe('Sean Christopherson');
  // Nobody touched drivers/ lately, so weight decides.
  expect(owners.folders.get('drivers')!.owner).toBe('Linus Torvalds');
});
