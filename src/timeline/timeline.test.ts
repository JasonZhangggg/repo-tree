import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, test } from 'vitest';
import { growTree, type TreeModel } from '../grow/grow';
import { indexRepo, type RepoIndex } from '../load/repo-index';
import { buildHierarchy, DEFAULT_FILTERS } from '../repo/hierarchy';
import { parseHistory, type History } from '../repo/history';
import { sample, type SampleId } from '../test/samples';
import {
  aliveAt,
  buildTimeline,
  cursorOf,
  dateAt,
  dateOf,
  easeOf,
  filesAt,
  positionAt,
  progressOf,
  sharedTimelines,
  SPAN,
  type Timeline,
} from './timeline';

const YEAR = 365.25 * 24 * 3600 * 1000;

const historyOf = (id: SampleId): History =>
  parseHistory(
    JSON.parse(gunzipSync(readFileSync(`public/samples/${id}.history.json.gz`)).toString()),
  )!;

describe('aliveAt', () => {
  test('a file exists from its birth, and until its deletion if it was deleted', () => {
    expect(aliveAt(5, 5)).toBe(true);
    expect(aliveAt(4, 5)).toBe(false);
    expect(aliveAt(9e15, 5)).toBe(true);
    expect(aliveAt(5, 5, 8)).toBe(true);
    expect(aliveAt(7.9, 5, 8)).toBe(true);
    expect(aliveAt(8, 5, 8)).toBe(false);
    expect(aliveAt(4, 5, 8)).toBe(false);
  });
});

describe('easing dates onto the scrubber', () => {
  const start = Date.UTC(2010, 0, 1);
  const at = Float64Array.from([0, 1, 2, 3, 4, 5], (y) => start + y * YEAR);
  const ease = easeOf(at);

  test('runs from 0 at the first commit to 1 at head, never backwards', () => {
    expect(progressOf(ease, start)).toBe(0);
    expect(progressOf(ease, start - YEAR)).toBe(0);
    expect(progressOf(ease, at[5]!)).toBe(1);
    expect(progressOf(ease, at[5]! + YEAR)).toBe(1);
    let last = -1;
    for (let ms = start; ms <= at[5]!; ms += YEAR / 50) {
      const p = progressOf(ease, ms);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  test('every year takes the same room, like a calendar', () => {
    for (let y = 0; y <= 5; y++) expect(progressOf(ease, at[y]!)).toBeCloseTo(y / 5);
    expect(progressOf(ease, start + 2.5 * YEAR)).toBeCloseTo(0.5);
  });

  test('a date comes back from its progress', () => {
    for (const ms of [start, start + 0.3 * YEAR, start + 3.5 * YEAR, at[5]! - 1000]) {
      expect(dateOf(ease, progressOf(ease, ms))).toBeCloseTo(ms, -1);
    }
  });
});

describe.each<SampleId>(['mathiasbynens-dotfiles', 'vitejs-vite', 'torvalds-linux'])(
  'buildTimeline on %s',
  (id) => {
    let tree: TreeModel;
    let index: RepoIndex;
    let history: History;
    let timeline: Timeline;
    beforeAll(async () => {
      const dir = buildHierarchy(await sample(id), DEFAULT_FILTERS);
      tree = growTree(dir, { seed: 42, quality: 'low' });
      index = indexRepo(dir);
      history = historyOf(id);
      timeline = buildTimeline(history, tree, index, DEFAULT_FILTERS.hidden);
    });

    test('spans the first commit to head', () => {
      expect(timeline.start).toBe(history.snapshots[0]!.at);
      expect(timeline.end).toBe(history.snapshots.at(-1)!.at);
    });

    test('the scrubber runs evenly in time: the middle of its life is halfway', () => {
      const { start, end } = timeline;
      for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        expect(progressOf(timeline.ease, start + f * (end - start))).toBeCloseTo(f, 6);
      }
    });

    test('a branch never appears after anything that grows on it', () => {
      const { parent } = tree.nodes;
      for (let n = 1; n < parent.length; n++) {
        expect(timeline.nodes[parent[n]!]!).toBeLessThanOrEqual(timeline.nodes[n]!);
      }
      const { vertex } = tree.sprigs;
      timeline.sprigs.forEach((p, s) => {
        expect(timeline.nodes[tree.leaves.nodeId[vertex[s]!]!]!).toBeLessThanOrEqual(p);
      });
      expect(timeline.nodes[0]).toBe(0);
    });

    test('a sprig appears by its first file, and no earlier than its folders appeared', () => {
      const born = new Map(history.files.path.map((p, i) => [p, history.files.born[i]!]));
      const folderBorn = new Map(history.folders.path.map((p, i) => [p, history.folders.born[i]!]));
      const snapshots = history.snapshots.map((x) => x.at);
      const intervalStart = (ms: number) =>
        Math.max(snapshots[0]!, ...snapshots.filter((at) => at < ms));
      const { file, files, vertex } = tree.sprigs;
      timeline.sprigs.forEach((p, s) => {
        const first = Math.min(
          ...Array.from(files.subarray(file[s]!, file[s + 1]!), (f) =>
            born.get(index.files.paths[f]!)!,
          ),
        );
        expect(p).toBeLessThanOrEqual(progressOf(timeline.ease, first) + 1e-6);
        let earliest = first;
        for (let f = tree.nodes.folder[tree.leaves.nodeId[vertex[s]!]!]!; f >= 0;) {
          earliest = Math.min(earliest, folderBorn.get(tree.folders.path[f]!) ?? Infinity);
          f = index.folders.parent[f]!;
        }
        expect(p).toBeGreaterThanOrEqual(progressOf(timeline.ease, intervalStart(earliest)) - 1e-6);
      });
    });

    test('every folder appears in leaf: its earliest sprig is no later than the folder', () => {
      const { range } = tree.folders;
      const twig = (s: number) => tree.leaves.nodeId[tree.sprigs.vertex[s]!]!;
      tree.folders.path.forEach((_, f) => {
        let earliest = Infinity;
        timeline.sprigs.forEach((p, s) => {
          if (twig(s) >= range[2 * f]! && twig(s) <= range[2 * f + 1]!)
            earliest = Math.min(earliest, p);
        });
        if (earliest < Infinity && f !== 0) expect(earliest).toBeCloseTo(timeline.folders[f]!, 5);
      });
    });

    test('the file count at a position is the brute-force count of files alive then', () => {
      const born = Array.from(timeline.census.born);
      const gone = Array.from(
        timeline.census.goneBorn,
        (b, i) => [b, timeline.census.goneGone[i]!] as const,
      );
      for (const s of [0.01, 0.1, 0.33, 0.5, 0.77, 0.95, 1]) {
        const p = Math.min(1, cursorOf(s));
        const head = born.filter((b) => aliveAt(p, b)).length;
        const { files } = filesAt(timeline, s);
        expect(files).toBeGreaterThanOrEqual(head);
        // Births and deletions are sorted separately, so count them the same way.
        const deleted = gone.filter(([b]) => b <= p).length - gone.filter(([, g]) => g <= p).length;
        expect(files).toBe(head + deleted);
      }
      expect(filesAt(timeline, 0).files).toBe(0);
      expect(filesAt(timeline, 1).files).toBe(index.files.paths.length);
    });

    test('each top-level folder counts its own files, which add up within the whole', () => {
      for (const s of [0.2, 0.6, 1]) {
        let sum = 0;
        for (const { folder } of tree.labels) {
          const { files } = filesAt(timeline, s, timeline.tops.get(folder)!);
          sum += files;
          if (s === 1) expect(files).toBe(index.folders.files[folder]);
        }
        expect(sum).toBeLessThanOrEqual(filesAt(timeline, s).files);
      }
    });

    test('the scrubber ends on the whole tree and a date maps back to its position', () => {
      expect(cursorOf(1)).toBeCloseTo(1 + SPAN);
      for (let n = 0; n < tree.nodes.parent.length; n++) {
        expect(timeline.nodes[n]! + SPAN).toBeLessThanOrEqual(cursorOf(1) + 1e-6);
      }
      expect(positionAt(timeline, timeline.end)).toBe(1);
      expect(dateAt(timeline, 1)).toBe(timeline.end);
      const mid = timeline.start + (timeline.end - timeline.start) / 2;
      expect(dateAt(timeline, positionAt(timeline, mid))).toBeCloseTo(mid, -3);
    });
  },
);

describe('a history whose deletions were cut off', () => {
  test('counts files only as a lower bound before the oldest kept deletion', async () => {
    const dir = buildHierarchy(await sample('torvalds-linux'), DEFAULT_FILTERS);
    const tree = growTree(dir, { seed: 42, quality: 'low' });
    const timeline = buildTimeline(historyOf('torvalds-linux'), tree, indexRepo(dir));
    expect(timeline.partialBefore).toBeGreaterThan(0);
    expect(filesAt(timeline, 0.2).atLeast).toBe(true);
    expect(filesAt(timeline, 1).atLeast).toBe(false);
  });
});

describe('sharedTimelines', () => {
  const line = (start: number, end: number, born: number[]): Timeline => {
    const ease = { at: Float64Array.of(start, end), p: Float64Array.of(0, 1) };
    const census = {
      born: Float64Array.from(born),
      goneBorn: new Float64Array(),
      goneGone: new Float64Array(),
    };
    return {
      start,
      end,
      ease,
      nodes: Float32Array.of(0, ...born),
      sprigs: Float32Array.from(born),
      folders: Float32Array.of(0),
      census,
      tops: new Map(),
      partialBefore: 0,
    };
  };

  test('one timeline stays as it is', () => {
    const one = line(0, 100, [0.5]);
    expect(sharedTimelines([one])[0]).toBe(one);
  });

  test('every tree goes on one calendar, a younger one bare until its first commit', () => {
    const old = line(0, 1000, [0.1, 0.9]);
    const young = line(500, 1000, [0.2, 1]);
    const [a, b] = sharedTimelines([old, young]);
    expect(a!.start).toBe(0);
    expect(b!.start).toBe(0);
    expect(a!.end).toBe(1000);
    expect(a!.ease).toBe(b!.ease);
    // The young tree's trunk waits for its first commit, halfway along the calendar or later.
    expect(b!.nodes[0]).toBeGreaterThan(0.3);
    expect(a!.nodes[0]).toBe(0);
    // Births keep their dates: a birth at a date shows at the shared progress of that date.
    expect(dateOf(b!.ease, b!.sprigs[0]!)).toBeCloseTo(600, 0);
    expect(dateOf(a!.ease, a!.sprigs[1]!)).toBeCloseTo(900, 0);
    expect(b!.sprigs[1]).toBeCloseTo(1);
  });

  test('the shared calendar runs evenly in time, whatever each tree was busy with', () => {
    const old = line(0, 1000, [0.1, 0.9]);
    // The young tree's own axis gives its first year most of the room.
    const young = line(500, 1000, [0.2, 1]);
    young.ease = { at: Float64Array.of(500, 600, 1000), p: Float64Array.of(0, 0.9, 1) };
    const [a] = sharedTimelines([old, young]);
    for (const ms of [0, 250, 500, 600, 800, 1000]) {
      expect(progressOf(a!.ease, ms)).toBeCloseTo(ms / 1000);
    }
  });

  test('file counts read the same at a date on the shared axis', () => {
    const old = line(0, 1000, [0.1, 0.5, 0.9]);
    const young = line(500, 1000, [0.2, 0.6]);
    const [, b] = sharedTimelines([old, young]);
    const at = (t: Timeline, ms: number) => filesAt(t, positionAt(t, ms)).files;
    expect(at(b!, 400)).toBe(0);
    expect(at(b!, 650)).toBe(1);
    expect(at(b!, 1000)).toBe(2);
    expect(at(young, 650)).toBe(1);
  });
});
