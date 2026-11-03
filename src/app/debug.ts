import type { TreeModel } from '../grow/grow';
import type { TreeView } from '../render/tree-view';

/** State the e2e tests and scripts/perf.mjs read from `window.__repoTree`. */
export const debug: {
  repo: string;
  ready: boolean;
  hovered: string | null;
  labels: { path: string; x: number; y: number }[];
  timings: Record<string, number>;
  view?: TreeView;
  tree?: TreeModel;
} = { repo: '', ready: false, hovered: null, labels: [], timings: {} };

Object.assign(window, { __repoTree: debug });
