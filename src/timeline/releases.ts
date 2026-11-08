import type { Release } from '../repo/releases';

/**
 * How much a release stands out: 0 a major (v3.0.0, v3.0), 1 a minor (v3.1.0) or a tag that is
 * no version, 2 a patch (v3.1.4, Linux's v2.6.32). Under 1.0 the minor counts as the major.
 */
export type Rank = 0 | 1 | 2;

type Version = { rank: Rank; pre: boolean; bare: boolean; short: string };

const VERSION = /^(.*?)(v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:\.\d+)*)(.*)$/i;

/**
 * Reads a tag as a version. `bare` is a tag that is only a version (`v2.0.0`, `2.0`), unlike a
 * monorepo's package tags (`create-vite@5.0.0`); `pre` is a prerelease or any other suffix
 * (`-rc1`, `-beta.2`, Linux's `-tree`), build metadata (`+build.7`) aside. `short` is the label:
 * the tag, a major or minor without its `.0` patch.
 */
export function versionOf(tag: string): Version {
  const m = VERSION.exec(tag);
  if (!m) return { rank: 1, pre: false, bare: false, short: tag };
  const [, prefix = '', v = '', a = '', b, c, extra = '', suffix = ''] = m;
  const major = Number(a);
  const minor = Number(b ?? 0);
  const patch = Number(c ?? 0) + (extra ? 1 : 0);
  // Under 1.0, 0.y is the release line and 0.y.z its patches.
  const rank: Rank =
    major === 0
      ? minor > 0 && patch === 0
        ? 0
        : 2
      : minor === 0 && patch === 0
        ? 0
        : patch === 0
          ? 1
          : 2;
  const pre = suffix !== '' && !suffix.startsWith('+');
  const short =
    rank < 2 && c !== undefined && !extra && Number(c) === 0
      ? `${prefix}${v}${a}.${b}${suffix}`
      : tag;
  return { rank, pre, bare: prefix === '', short };
}

/** A release placed on the scrubber. */
export type Mark = {
  tag: string;
  /** The label: the tag, or a major or minor without its `.0` patch. */
  short: string;
  at: number;
  /** Scrubber position, 0 to 1. */
  s: number;
  rank: Rank;
  /** Which tree's release: 0 the one on show, then the compared ones in order. */
  tree: number;
  /** Whether it carries a label under the track. */
  labeled: boolean;
};

/**
 * The releases worth marking: prereleases dropped, each tag once, and where a repo has bare
 * version tags, only those, so a monorepo marks its main package rather than every one.
 */
export function releaseCandidates(releases: readonly Release[]): (Release & Version)[] {
  const seen = new Set<string>();
  const all: (Release & Version)[] = [];
  for (const r of releases) {
    if (seen.has(r.tag)) continue;
    seen.add(r.tag);
    const v = versionOf(r.tag);
    if (!v.pre) all.push({ ...r, ...v });
  }
  return all.some((r) => r.bare) ? all.filter((r) => r.bare) : all;
}

/**
 * Lays releases along a track `width` px wide. Majors go first, then minors, then patches, each
 * newest first, and a release is kept only `gap` px or more from every one kept before it, so
 * the track never crowds and a long history keeps its majors and fills in around them. The
 * most standing-out rank on show is labeled where its label, `charWidth` px a character, leaves room.
 */
export function placeMarks(
  trees: readonly { releases: readonly Release[]; position: (ms: number) => number | null }[],
  width: number,
  gap: number,
  charWidth = 6,
): Mark[] {
  const all: Mark[] = [];
  trees.forEach(({ releases, position }, tree) => {
    for (const r of releaseCandidates(releases)) {
      const s = position(r.at);
      if (s === null) continue;
      all.push({ tag: r.tag, short: r.short, at: r.at, s, rank: r.rank, tree, labeled: false });
    }
  });
  all.sort((a, b) => a.rank - b.rank || b.at - a.at || a.tree - b.tree);
  const kept: Mark[] = [];
  for (const mark of all) {
    const x = mark.s * width;
    if (kept.every((k) => Math.abs(k.s * width - x) >= gap)) kept.push(mark);
  }
  const top = Math.min(...kept.map((k) => k.rank));
  const taken: [number, number][] = [];
  for (const mark of kept) {
    if (mark.rank !== top) continue;
    const half = (mark.short.length * charWidth) / 2 + 4;
    const x = mark.s * width;
    // A label reaching past either end of the track would be cut off.
    if (x - half < -4 || x + half > width + 4) continue;
    if (taken.some(([a, b]) => x - half < b && x + half > a)) continue;
    taken.push([x - half, x + half]);
    mark.labeled = true;
  }
  return kept.sort((a, b) => a.s - b.s || a.tree - b.tree);
}

/** The release a scrubber date sits on: one dated the same UTC day, as a link's `t=` keeps. */
export function releaseOn(marks: readonly Mark[], date: number, tree = -1): Mark | null {
  const day = Math.floor(date / 86_400_000);
  return (
    marks.find((m) => Math.floor(m.at / 86_400_000) === day && (tree === -1 || m.tree === tree)) ??
    null
  );
}
