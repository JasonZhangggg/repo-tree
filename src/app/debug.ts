import type { TraceSummary } from '../../server/src/core/trace';
import type { TreeModel } from '../grow/grow';
import type { TreeView } from '../render/tree-view';

/** State the e2e tests and scripts/perf.mjs read from `window.__repoTree`. */
export const debug: {
  repo: string;
  ready: boolean;
  hovered: string | null;
  /** The compared repo (owner/repo) the hovered folder lies on, or null on the repo on show. */
  hoveredTree: string | null;
  /** The folder pinned on a compared tree, as `owner/repo:path`, or null. */
  companionPin: string | null;
  /** The folder the tree previews (fades the rest for), from the canvas or a side-panel row. */
  previewed: number | null;
  /** The rock a pin keeps lit while the rest fades, by its index in the tree's rocks. */
  keptRock: number | null;
  labels: { path: string; x: number; y: number }[];
  timings: Record<string, number>;
  view?: TreeView;
  tree?: TreeModel;
  /** The open timeline's scrubber position (0 to 1), the date it shows and its file count. */
  timeline: { s: number; date: number; files: number } | null;
  /** The history compute dialog's step while it is open. */
  compute: 'offer' | 'computing' | 'sharing' | 'failed' | null;
  /** Where the last history computation's time and bytes went. */
  computeTrace: TraceSummary | null;
} = {
  repo: '',
  ready: false,
  hovered: null,
  hoveredTree: null,
  companionPin: null,
  previewed: null,
  keptRock: null,
  labels: [],
  timings: {},
  timeline: null,
  compute: null,
  computeTrace: null,
};

/**
 * The debug flag: `?debug` in the page's address, or localStorage `repo-tree:debug` set to 1.
 * With it, a history computation's breakdown shows in a toast as well as the console.
 */
export function debugEnabled(): boolean {
  if (/[?&]debug\b/.test(location.search)) return true;
  try {
    return localStorage.getItem('repo-tree:debug') === '1';
  } catch {
    return false;
  }
}

Object.assign(window, { __repoTree: debug });
