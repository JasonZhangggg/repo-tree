import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';
import { growTree, type TreeModel } from '../grow/grow';
import { indexRepo, type RepoIndex } from '../load/repo-index';
import { buildHierarchy, DEFAULT_FILTERS } from '../repo/hierarchy';
import { parseHistory, type History } from '../repo/history';
import { sample } from '../test/samples';
import {
  AGES,
  ageBand,
  CHANGES,
  changeBand,
  changeLevel,
  DEAD,
  historyFacts,
  HOT_FLOOR,
  HOT_MIN,
  HOT_SHARE,
  HOT_SPRIGS,
  hotspots,
  type Facts,
} from './facts';

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

describe('changeBand', () => {
  test('runs from the busiest files down to the quiet ones', () => {
    expect(changeBand(0)).toBe(CHANGES.length - 1);
    expect(changeBand(2)).toBe(3);
    expect(changeBand(3)).toBe(2);
    expect(changeBand(10)).toBe(1);
    expect(changeBand(30)).toBe(0);
    expect(changeBand(500)).toBe(0);
    // Sprig and folder majorities count four bands, as for AGES.
    expect(CHANGES.length).toBe(AGES.length);
  });
});

describe('changeLevel', () => {
  test('climbs from 0 to the last band, with band edges halfway between stops', () => {
    expect(changeLevel(0)).toBe(0);
    expect(changeLevel(3)).toBeCloseTo(0.5);
    expect(changeLevel(10)).toBeCloseTo(1.5);
    expect(changeLevel(30)).toBeCloseTo(2.5);
    expect(changeLevel(100)).toBeCloseTo(3);
    expect(changeLevel(5000)).toBe(3);
  });
  test('rounds to the file band, counted from the quiet end', () => {
    for (let churn = 0; churn < 200; churn++) {
      expect(CHANGES.length - 1 - Math.round(changeLevel(churn))).toBe(changeBand(churn));
    }
  });
  test('rises with every change', () => {
    for (let churn = 1; churn <= 100; churn++) {
      expect(changeLevel(churn)).toBeGreaterThan(changeLevel(churn - 1));
    }
  });
});

describe('hotspots', () => {
  /** Every file on a sprig of its own. */
  const own = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

  test('the busiest share glows, a whole tie at a time, hottest first', () => {
    const churn = new Uint32Array(100);
    churn[7] = 40;
    churn[3] = 20;
    churn[5] = 10;
    churn[9] = 10;
    churn[1] = 9;
    const { heat, hot } = hotspots(churn, own(100), 100);
    expect(Array.from(hot)).toEqual([7, 3, 5, 9]);
    expect(heat[7]).toBe(1);
    expect(heat[5]).toBeCloseTo(HOT_FLOOR);
    expect(heat[3]).toBeCloseTo(HOT_FLOOR + ((1 - HOT_FLOOR) * 10) / 30);
    expect(heat[1]).toBe(0);
    expect(heat[0]).toBe(0);
  });

  test('a tie that would pass the share stays out', () => {
    const churn = new Uint32Array(100);
    churn[7] = 40;
    churn[3] = 20;
    for (const i of [4, 5, 6]) churn[i] = 10;
    expect(Array.from(hotspots(churn, own(100), 100).hot)).toEqual([7, 3]);
  });

  test('a big crown lights at most its share of sprigs', () => {
    // 1,000 files, ten to a sprig: a share of files alone would light every sprig.
    const churn = Uint32Array.from({ length: 1000 }, (_, i) => (i % 10 === 0 ? 100 + i : 0));
    const sprigOf = Int32Array.from({ length: 1000 }, (_, i) => Math.floor(i / 10));
    const { hot } = hotspots(churn, sprigOf, 100);
    expect(hot.length).toBe(100 * HOT_SPRIGS);
    expect(hot[0]).toBe(990);
  });

  test('files off the leaves, the root rocks, never glow', () => {
    const churn = Uint32Array.from([50, 40, 0, 0]);
    const { hot } = hotspots(churn, Int32Array.from([-1, 1, 2, 3]), 4);
    expect(Array.from(hot)).toEqual([1]);
  });

  test('a young repo, where nothing changed much yet, does not glow', () => {
    const { heat, hot } = hotspots(
      Uint32Array.from({ length: 50 }, () => HOT_MIN - 1),
      own(50),
      50,
    );
    expect(hot.length).toBe(0);
    expect(heat.every((h) => h === 0)).toBe(true);
  });

  test('a tiny repo still shows its busiest file', () => {
    const { hot, heat } = hotspots(Uint32Array.from([2, HOT_MIN, 30, 4]), own(4), 4);
    expect(Array.from(hot)).toEqual([2]);
    expect(heat[2]).toBe(1);
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

  test('a sprig and a folder take the changes band most of their files are in', () => {
    const { sprigs } = tree;
    const majority = (files: number[]) => {
      const counts = CHANGES.map(() => 0);
      for (const f of files) counts[changeBand(facts.fileChurn[f]!)]! += 1;
      return counts.indexOf(Math.max(...counts));
    };
    for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
      const files = Array.from(sprigs.files.subarray(sprigs.file[s]!, sprigs.file[s + 1]!));
      expect(facts.sprigChangeBand[s]).toBe(majority(files));
    }
    const all = index.files.paths.map((_, i) => i);
    expect(facts.folderChangeBand[0]).toBe(majority(all));
    for (const level of facts.sprigChangeLevel) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(CHANGES.length - 1);
    }
    const bands = new Set(facts.sprigChangeBand);
    expect(bands.size, 'vite has busy and quiet twigs').toBeGreaterThan(2);
  });

  test('a glowing sprig sits at its hottest file on the gradient, so Constantly shows', () => {
    const { sprigs } = tree;
    let constantly = 0;
    for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
      const files = Array.from(sprigs.files.subarray(sprigs.file[s]!, sprigs.file[s + 1]!));
      const levels = files.map((f) => changeLevel(facts.fileChurn[f]!));
      const mean = levels.reduce((a, b) => a + b, 0) / Math.max(1, levels.length);
      const hot = files.filter((f) => facts.fileHeat[f]! > 0);
      const hottest = Math.max(0, ...hot.map((f) => changeLevel(facts.fileChurn[f]!)));
      expect(facts.sprigChangeLevel[s]).toBeCloseTo(Math.max(mean, hottest), 5);
      // The legend's Constantly highlight takes slots within half a stop of 0.
      if (CHANGES.length - 1 - facts.sprigChangeLevel[s]! <= 0.5) constantly++;
    }
    expect(constantly, 'some twigs take the darkest stop').toBeGreaterThan(0);
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

  test('a file is as busy as its churn plus its recent commits', () => {
    const row = new Map(history.files.path.map((p, i) => [p, i]));
    index.files.paths.forEach((path, i) => {
      const r = row.get(path);
      const busy = r === undefined ? 0 : history.files.churn[r]! + history.files.commits[r]!;
      expect(facts.fileChurn[i]).toBe(busy);
    });
  });

  test('the busiest files on the leaves glow, within both shares', () => {
    const { hot, fileHeat, fileChurn } = facts;
    const files = index.files.paths.length;
    const sprigCount = tree.sprigs.vertex.length - 1;
    expect(hot.length).toBeGreaterThan(10);
    expect(hot.length).toBeLessThanOrEqual(Math.round(files * HOT_SHARE));
    for (let k = 1; k < hot.length; k++) {
      expect(fileChurn[hot[k]!]).toBeLessThanOrEqual(fileChurn[hot[k - 1]!]!);
    }
    const lit = facts.sprigHeat.filter((h) => h > 0).length;
    expect(lit).toBeLessThanOrEqual(Math.round(sprigCount * HOT_SPRIGS));
    // Root files lie as rocks: vite's busiest, the lockfile, is not a leaf.
    const paths = Array.from(hot, (i) => index.files.paths[i]!);
    expect(paths).not.toContain('pnpm-lock.yaml');
    expect(paths[0]).toBe('packages/vite/package.json');
    expect(fileHeat[hot[0]!]).toBe(1);
    expect(fileHeat.filter((h) => h > 0).length).toBe(hot.length);
    const coolest = Math.min(...Array.from(hot, (i) => fileHeat[i]!));
    expect(coolest).toBeCloseTo(HOT_FLOOR);
  });

  test("a sprig glows with its hottest file's heat", () => {
    const { sprigs } = tree;
    let lit = 0;
    for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
      const files = Array.from(sprigs.files.subarray(sprigs.file[s]!, sprigs.file[s + 1]!));
      expect(facts.sprigHeat[s]).toBe(Math.max(0, ...files.map((f) => facts.fileHeat[f]!)));
      if (facts.sprigHeat[s]! > 0) lit++;
    }
    expect(lit).toBeGreaterThan(0);
  });
});
