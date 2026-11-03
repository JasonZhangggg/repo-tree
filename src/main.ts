import type { Quality, TreeModel } from './grow/grow';
import { loadInWorker } from './load/load-in-worker';
import { DEFAULT_FILTERS } from './repo/hierarchy';
import { PALETTES, type ColorBy, type PaletteId } from './render/palette';
import { createTreeView, type TreeView } from './render/tree-view';

const SAMPLES = ['mathiasbynens-dotfiles', 'vitejs-vite', 'torvalds-linux'];

const query = new URLSearchParams(location.search);
const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
  const value = query.get(name);
  return allowed.find((a) => a === value || a.endsWith(`-${value}`)) ?? fallback;
};
const sample = pick('sample', SAMPLES, 'vitejs-vite');
const palette = pick('palette', Object.keys(PALETTES) as PaletteId[], 'autumn');
const colorBy = pick<ColorBy>('colorBy', ['language', 'folder'], 'language');
const quality = pick<Quality>('quality', ['low', 'medium', 'high'], 'high');
const spin = query.get('spin') !== '0';

type Debug = {
  ready: boolean;
  hovered: string | null;
  labels: { path: string; x: number; y: number }[];
  timings: Record<string, number>;
  view?: TreeView;
  tree?: TreeModel;
};
const debug: Debug = { ready: false, hovered: null, labels: [], timings: {} };
(window as unknown as { __repoTree: Debug }).__repoTree = debug;

const container = document.getElementById('view')!;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const view = createTreeView(container, {
  quality,
  palette,
  colorBy,
  spin,
  reducedMotion: motion.matches,
});
motion.addEventListener('change', () => view.setReducedMotion(motion.matches));
debug.view = view;

const loaded = await loadInWorker(
  {
    source: { kind: 'sample', id: sample, base: new URL('./', location.href).href },
    filters: DEFAULT_FILTERS,
    params: { seed: 42, quality },
  },
  (step) => {
    if (step === 'build') debug.timings.loaded = performance.now();
  },
  new AbortController().signal,
);
if ('kind' in loaded) throw new Error(`sample ${sample} did not load: ${loaded.kind}`);
const { info: snapshot, tree } = loaded;
debug.timings.grown = performance.now();
view.setTree(tree);
debug.tree = tree;

const title = document.getElementById('title')!;
title.textContent = `${snapshot.ref.owner}/${snapshot.ref.repo}`;
const legend = document.getElementById('legend')!;
legend.replaceChildren(
  ...view.legend().map(({ color, label, files }) => {
    const item = document.createElement('li');
    item.style.setProperty('--c', color);
    item.textContent = `${label} ${files.toLocaleString()}`;
    return item;
  }),
);

view.onFrame(({ growth, labels }) => {
  debug.labels = labels.map(({ folder, x, y }) => ({ path: tree.folders.path[folder]!, x, y }));
  if (growth < 1 || debug.ready) return;
  debug.ready = true;
  debug.timings.ready = performance.now();
  document.body.dataset.ready = '';
});

let pointer: { x: number; y: number } | null = null;
let pending = false;
const hover = () => {
  pending = false;
  const folder = pointer ? view.pickAt(pointer.x, pointer.y) : null;
  const path = folder === null ? null : tree.folders.path[folder]!;
  if (path === debug.hovered) return;
  debug.hovered = path;
  document.body.dataset.hovered = path ?? '';
  view.setHighlight(
    folder === null ? null : [tree.folders.range[2 * folder]!, tree.folders.range[2 * folder + 1]!],
  );
};
container.addEventListener('pointermove', (event) => {
  if (event.buttons) return;
  const rect = container.getBoundingClientRect();
  pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (!pending) {
    pending = true;
    requestAnimationFrame(hover);
  }
});
container.addEventListener('pointerleave', () => {
  pointer = null;
  hover();
});
