import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';
import { growTree, type TreeModel } from '../grow/grow';
import { indexRepo, type RepoIndex } from '../load/repo-index';
import { buildHierarchy, DEFAULT_FILTERS } from '../repo/hierarchy';
import { parseHistory, type History } from '../repo/history';
import { sample } from '../test/samples';
import { AGES, ageBand, DEAD, historyFacts, type Facts } from './facts';

const DAY = 24 * 3600 * 1000;

describe('ageBand', () => {
  const now = Date.UTC(2025, 5, 1);
  test('runs from this month to dead wood', () => {
    expect(ageBand(now, now)).toBe(0);
    expect(ageBand(now, now - 30 * DAY)).toBe(0);
    expect(ageBand(now, now - 40 * DAY)).toBe(1);
    expect(ageBand(now, now - 400 * DAY)).toBe(2);
    expect(ageBand(now, now - 4 * 365 * DAY)).toBe(DEAD);
    expect(ageBand(now, -Infinity)).toBe(DEAD);
    expect(DEAD).toBe(AGES.length - 1);
  });
});

describe('historyFacts on vitejs/vite', () => {
  let tree: TreeModel;
  let index: RepoIndex;
  let history: History;
  let facts: Facts;
  beforeAll(async () => {
    const dir = buildHierarchy(await sample('vitejs-vite'), DEFAULT_FILTERS);
    tree = growTree(dir, { seed: 42, quality: 'low' });
    index = indexRepo(dir);
    history = parseHistory(
      JSON.parse(gunzipSync(readFileSync('public/samples/vitejs-vite.history.json.gz')).toString()),
    )!;
    facts = historyFacts(history, tree, index);
  });

  test('every file takes its history row, or head when the history lacks it', () => {
    const row = new Map(history.files.path.map((p, i) => [p, history.files.changed[i]!]));
    index.files.paths.forEach((path, i) => {
      expect(facts.fileChanged[i]).toBe(row.get(path) ?? history.computedAt);
    });
  });

  test('a sprig and a folder take the band most of their files are in', () => {
    const { sprigs } = tree;
    const bandOf = (file: number) => ageBand(facts.asOf, facts.fileChanged[file]!);
    const majority = (files: number[]) => {
      const counts = AGES.map(() => 0);
      for (const f of files) counts[bandOf(f)]! += 1;
      return counts.indexOf(Math.max(...counts));
    };
    for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
      const files = Array.from(sprigs.files.subarray(sprigs.file[s]!, sprigs.file[s + 1]!));
      expect(facts.sprigBand[s]).toBe(majority(files));
    }
    const all = index.files.paths.map((_, i) => i);
    expect(facts.folderBand[0]).toBe(majority(all));
    const packages = tree.folders.path.indexOf('packages');
    const under = all.filter((i) => index.files.paths[i]!.startsWith('packages/'));
    expect(facts.folderBand[packages]).toBe(majority(under));
  });

  test('a branch is as fresh as the newest file on it or beyond it', () => {
    const newest = facts.fileChanged.reduce((a, b) => Math.max(a, b), -Infinity);
    expect(facts.nodeChanged[0]).toBe(newest);
    for (let n = 1; n < tree.nodes.parent.length; n++) {
      expect(facts.nodeChanged[tree.nodes.parent[n]!]).toBeGreaterThanOrEqual(
        facts.nodeChanged[n]!,
      );
    }
  });

  test('a living repo shows every season, from fresh leaves to dead wood', () => {
    const bands = AGES.map(() => 0);
    for (const ms of facts.fileChanged) bands[ageBand(facts.asOf, ms)]! += 1;
    expect(bands.every((n) => n > 0)).toBe(true);
    expect(ageBand(facts.asOf, facts.nodeChanged[0]!)).toBe(0);
  });
});
