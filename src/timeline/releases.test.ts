import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseTags, type Release } from '../repo/releases';
import { placeMarks, releaseCandidates, releaseOn, versionOf } from './releases';

const day = (iso: string) => Date.parse(iso);
const bundled = (id: string) =>
  parseTags(JSON.parse(readFileSync(`public/samples/${id}.releases.json`, 'utf8')))!;

describe('versionOf', () => {
  test('ranks majors, minors and patches', () => {
    expect(versionOf('v2.0.0')).toMatchObject({ rank: 0, pre: false, bare: true, short: 'v2.0' });
    expect(versionOf('v3.0')).toMatchObject({ rank: 0, short: 'v3.0' });
    expect(versionOf('v3.1')).toMatchObject({ rank: 1, short: 'v3.1' });
    expect(versionOf('2.4.0')).toMatchObject({ rank: 1, short: '2.4' });
    expect(versionOf('v2.6.32')).toMatchObject({ rank: 2, short: 'v2.6.32' });
    expect(versionOf('v1.2.3.4')).toMatchObject({ rank: 2 });
  });

  test('under 1.0 the minor is the release line', () => {
    expect(versionOf('0.5.0').rank).toBe(0);
    expect(versionOf('0.5.1').rank).toBe(2);
  });

  test('a suffix is a prerelease, build metadata is not', () => {
    expect(versionOf('v6.0.0-beta.1').pre).toBe(true);
    expect(versionOf('v6.1-rc3').pre).toBe(true);
    expect(versionOf('v2.6.11-tree').pre).toBe(true);
    expect(versionOf('v1.0.0+build.7').pre).toBe(false);
  });

  test('a package tag is a version but not a bare one', () => {
    expect(versionOf('create-vite@5.0.0')).toMatchObject({ rank: 0, bare: false });
    expect(versionOf('stable')).toMatchObject({ rank: 1, bare: false, short: 'stable' });
  });
});

describe('releaseCandidates', () => {
  test('keeps only bare tags in a monorepo, each once, no prereleases', () => {
    const at = day('2024-01-01');
    const tags = releaseCandidates([
      { tag: 'v5.0.0', at },
      { tag: 'v5.0.0', at },
      { tag: 'create-vite@5.0.0', at },
      { tag: 'v5.1.0-beta.0', at },
    ]);
    expect(tags.map((t) => t.tag)).toEqual(['v5.0.0']);
  });

  test('keeps every tag where none is bare', () => {
    const at = day('2024-01-01');
    const tags = releaseCandidates([
      { tag: 'pkg@1.0.0', at },
      { tag: 'pkg@1.1.0', at },
    ]);
    expect(tags).toHaveLength(2);
  });
});

describe('placeMarks', () => {
  const linear = (start: number, end: number) => (ms: number) =>
    ms < start || ms > end ? null : (ms - start) / (end - start);

  test('keeps majors first and never two closer than the gap', () => {
    const releases: Release[] = [
      { tag: 'v1.0.0', at: 10 },
      { tag: 'v1.0.1', at: 15 },
      { tag: 'v1.1.0', at: 30 },
      { tag: 'v2.0.0', at: 50 },
      { tag: 'v2.0.1', at: 52 },
    ];
    const marks = placeMarks([{ releases, position: linear(0, 100) }], 200, 20);
    expect(marks.map((m) => m.tag)).toEqual(['v1.0.0', 'v1.1.0', 'v2.0.0']);
    expect(marks.filter((m) => m.labeled).map((m) => m.short)).toEqual(['v1.0', 'v2.0']);
  });

  test('a label that would run off the track is left off', () => {
    const marks = placeMarks(
      [{ releases: [{ tag: 'v1.0.0', at: 0 }], position: linear(0, 100) }],
      200,
      20,
    );
    expect(marks[0]!.labeled).toBe(false);
  });

  test('leaves out releases outside the tree’s history', () => {
    const releases: Release[] = [
      { tag: 'v1.0.0', at: -10 },
      { tag: 'v2.0.0', at: 50 },
    ];
    expect(placeMarks([{ releases, position: linear(0, 100) }], 100, 10)).toHaveLength(1);
  });

  test('a compared tree’s releases carry its index', () => {
    const marks = placeMarks(
      [
        { releases: [{ tag: 'v1.0.0', at: 10 }], position: linear(0, 100) },
        { releases: [{ tag: 'v9.0.0', at: 80 }], position: linear(0, 100) },
      ],
      200,
      10,
    );
    expect(marks.map((m) => [m.tag, m.tree])).toEqual([
      ['v1.0.0', 0],
      ['v9.0.0', 1],
    ]);
  });

  test('vite’s bundled tags mark every major from v2 on a desktop track', () => {
    const tags = bundled('vitejs-vite');
    const marks = placeMarks(
      [{ releases: tags, position: linear(day('2020-04-20'), day('2026-11-02')) }],
      900,
      18,
    );
    const majors = marks.filter((m) => m.rank === 0).map((m) => m.short);
    expect(majors).toEqual(['v2.0', 'v3.0', 'v4.0', 'v5.0', 'v6.0', 'v7.0', 'v8.0']);
    expect(marks.every((m) => !m.tag.includes('@'))).toBe(true);
  });

  test('linux’s bundled tags keep its majors and fill in with minors and 2.6 releases', () => {
    const tags = bundled('torvalds-linux');
    const marks = placeMarks(
      [{ releases: tags, position: linear(day('2005-04-16'), day('2026-11-03')) }],
      900,
      18,
    );
    expect(marks.filter((m) => m.rank === 0).map((m) => m.tag)).toEqual([
      'v3.0',
      'v4.0',
      'v5.0',
      'v6.0',
      'v7.0',
    ]);
    expect(marks.some((m) => m.tag.startsWith('v2.6.'))).toBe(true);
    expect(marks.every((m) => !m.tag.includes('-rc'))).toBe(true);
    for (let i = 1; i < marks.length; i++) {
      expect((marks[i]!.s - marks[i - 1]!.s) * 900).toBeGreaterThanOrEqual(18);
    }
  });
});

describe('releaseOn', () => {
  test('finds the release dated the same UTC day', () => {
    const marks = placeMarks(
      [{ releases: [{ tag: 'v2.0.0', at: day('2021-02-16T22:48:47Z') }], position: () => 0.5 }],
      100,
      10,
    );
    expect(releaseOn(marks, day('2021-02-16'))?.tag).toBe('v2.0.0');
    expect(releaseOn(marks, day('2021-02-17'))).toBeNull();
  });
});
