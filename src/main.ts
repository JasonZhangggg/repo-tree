import '@fontsource-variable/hanken-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './app/app.css';
import { distanceOf, frameTree, stage } from './render/framing';
import { createTreeView } from './render/tree-view';
import { parseRepoRef, type RepoRef } from './repo/ref';
import { nameOf, type App } from './app/app';
import { debug } from './app/debug';
import { byId } from './app/dom';
import { count } from './app/format';
import { freeRect, type Rect } from './app/free-rect';
import { formatLink, parseLink, type ViewLink } from './app/link';
import { createLoader } from './app/loader';
import { rememberRecent } from './app/recent';
import { FIRST_VISIT } from './app/samples';
import { autoQuality, parseSettings, STEP_DOWN, type Settings } from './app/settings';
import { createStore, qualityOf, weatherOf, type AppState } from './app/state';
import { mountCanvas } from './app/ui/canvas';
import { mountHeader } from './app/ui/header';
import { mountHint } from './app/ui/hint';
import { mountMoreMenu } from './app/ui/more-menu';
import { mountSearch } from './app/ui/search-dialog';
import { mountSettings } from './app/ui/settings-dialog';
import { childrenOf, mountSide } from './app/ui/side';
import { mountHistoryCompute } from './app/ui/history-compute';
import { mountTimeline } from './app/ui/timeline';

const SETTINGS_KEY = 'repo-tree:settings';
const MEASURE_MS = 2000;
const SMOOTH_FPS = 30;
const PANEL_GAP = 12;

const stored = (() => {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
})();
const store = createStore({
  load: { phase: 'idle' },
  repo: null,
  selection: null,
  highlight: null,
  notice: null,
  settings: parseSettings(stored),
  autoQuality: autoQuality({
    pixelRatio: devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency || 4,
  }),
  ci: {},
  preview: null,
  timeline: null,
});

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = (s: Settings) => motion.matches || !s.growAnim;
const spinning = (s: AppState) => s.settings.spin && !s.selection;
const container = byId('view');
const initial = store.get();
const view = createTreeView(container, {
  quality: qualityOf(initial),
  palette: initial.settings.palette,
  colorBy: initial.settings.colorBy,
  spin: spinning(initial),
  reducedMotion: reducedMotion(initial.settings),
  ground: initial.settings.ground,
});
const showWeather = (state: AppState) => {
  const weather = weatherOf(state);
  view.setWeather(weather && { sky: weather.sky, still: motion.matches });
};
motion.addEventListener('change', () => {
  view.setReducedMotion(reducedMotion(store.get().settings));
  showWeather(store.get());
});
debug.view = view;

const loader = createLoader(store);
let hovered: number | null = null;
let hoveredCategory: string | null = null;
let toastTimer = 0;
const toastEl = byId('toast');

const app: App = {
  store,
  view,
  load: (ref, options) => void loader.load(ref, options),
  cancelLoad: () => loader.cancel(),
  select(selection, frame = false) {
    store.dispatch({ type: 'select', selection });
    if (selection && frame) view.frameFolder(selection.folder);
  },
  hover(folder) {
    hovered = folder;
    applyHighlight();
  },
  highlight(label) {
    store.dispatch({ type: 'highlight', label });
  },
  hoverCategory(label) {
    hoveredCategory = label;
    applyHighlight();
  },
  openSettings: (focus) => settings.open(focus),
  openSearch: () => search.open(),
  toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), 2400);
  },
};

/** A legend entry under the pointer shows first, then the pin or highlight, then a hovered folder. */
function applyHighlight() {
  const { repo, selection, highlight } = store.get();
  const category = hoveredCategory ?? highlight;
  const folder = category === null ? (selection?.folder ?? hovered) : null;
  const range = repo?.tree.folders.range;
  view.setHighlight(
    category !== null
      ? { category }
      : folder === null || folder === 0 || !range
        ? null
        : { range: [range[2 * folder]!, range[2 * folder + 1]!] },
  );
  canvas.mark(folder);
}

function describe(state: AppState): string {
  const repo = state.repo!;
  const { files } = repo.index.folders;
  const tops = childrenOf(repo, 0)
    .slice(0, 3)
    .map((f) => nameOf(repo.tree.folders.path[f]!));
  return [
    `3D tree of ${repo.info.ref.owner}/${repo.info.ref.repo}: ${count(files[0]!)} files in ${count(files.length - 1)} folders.`,
    tops.length ? `Largest folders: ${tops.join(', ')}.` : '',
    'Drag to orbit. Pick a folder from the list or search with the slash key.',
  ].join(' ');
}

const repoKey = (s: AppState) =>
  s.repo ? `${s.repo.info.ref.owner}/${s.repo.info.ref.repo}@${s.repo.info.branch}` : '';

function linkOf(state: AppState): string | null {
  const { repo, selection, highlight, settings: s } = state;
  if (!repo) return null;
  const ref = { ...repo.info.ref, ref: repo.info.branch } as RepoRef;
  const sel =
    selection && selection.folder !== 0 ? repo.tree.folders.path[selection.folder] : undefined;
  return formatLink({
    ref,
    palette: s.palette,
    colorBy: s.colorBy,
    sel,
    hl: highlight ?? undefined,
    wx: state.preview ?? undefined,
    t: state.timeline ?? undefined,
  });
}

function applyLink(link: ViewLink) {
  const patch: Partial<Settings> = {};
  if (link.palette) patch.palette = link.palette;
  if (link.colorBy) patch.colorBy = link.colorBy;
  if (Object.keys(patch).length) store.dispatch({ type: 'settings', patch });
  store.dispatch({ type: 'preview', sky: link.wx ?? null });
  const { repo } = store.get();
  const same =
    repo &&
    repo.info.ref.owner.toLowerCase() === link.ref.owner.toLowerCase() &&
    repo.info.ref.repo.toLowerCase() === link.ref.repo.toLowerCase() &&
    (link.ref.ref ?? repo.info.branch) === repo.info.branch;
  if (!same) {
    return app.load(link.ref, { select: link.sel, highlight: link.hl, timeline: link.t });
  }
  store.dispatch({ type: 'timeline', at: link.t ?? null });
  const folder = link.sel === undefined ? undefined : repo.folderIds.get(link.sel);
  app.select(folder === undefined ? null : { folder }, true);
  if (folder === undefined && view.legend().some((e) => e.label === link.hl)) {
    app.highlight(link.hl!);
  }
}

store.subscribe((state, prev) => {
  const { settings: s } = state;
  if (state.repo && state.repo !== prev.repo) {
    delete document.body.dataset.ready;
    debug.ready = false;
    debug.repo = `${state.repo.info.ref.owner}/${state.repo.info.ref.repo}`;
    debug.tree = state.repo.tree;
    debug.timings.grown ??= performance.now();
    view.setTree(state.repo.tree);
    if (state.selection) view.frameFolder(state.selection.folder);
    reframe();
    container.setAttribute('aria-label', describe(state));
    if (!state.repo.sample && repoKey(state) !== repoKey(prev)) rememberRecent(debug.repo);
  }
  if (s.palette !== prev.settings.palette) view.setPalette(s.palette);
  if (s.colorBy !== prev.settings.colorBy) view.setColorBy(s.colorBy);
  if (s.ground !== prev.settings.ground) {
    view.setGround(s.ground);
    reframe();
  }
  if (spinning(state) !== spinning(prev)) view.setSpin(spinning(state));
  const weather = weatherOf(state);
  const before = weatherOf(prev);
  if (weather?.sky !== before?.sky) showWeather(state);
  if (reducedMotion(s) !== reducedMotion(prev.settings)) view.setReducedMotion(reducedMotion(s));
  if (qualityOf(state) !== qualityOf(prev)) view.setQuality(qualityOf(state));
  if (
    state.selection !== prev.selection ||
    state.highlight !== prev.highlight ||
    state.repo !== prev.repo
  ) {
    applyHighlight();
  }

  const regrow = s.quality !== prev.settings.quality || s.hidden !== prev.settings.hidden;
  if (regrow && state.repo) {
    const path = state.selection ? state.repo.tree.folders.path[state.selection.folder] : undefined;
    const ref = state.repo.info.ref;
    const highlight = state.highlight ?? undefined;
    const timeline = state.timeline ?? undefined;
    queueMicrotask(() => app.load(ref, { select: path, highlight, timeline }));
  }
  if (s !== prev.settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
      // Private mode keeps settings for this visit only.
    }
  }
  const link = linkOf(state);
  if (link && link !== location.hash) {
    const moved = prev.repo !== null && repoKey(state) !== repoKey(prev);
    history[moved ? 'pushState' : 'replaceState'](null, '', link);
  }
  syncSpinButton(state);
});

const spinButton = byId<HTMLButtonElement>('spin');
function syncSpinButton({ settings: s }: AppState) {
  spinButton.setAttribute('aria-pressed', String(s.spin));
  spinButton.querySelector('span')!.textContent = s.spin ? 'Pause spin' : 'Spin';
  spinButton.setAttribute('aria-label', s.spin ? 'Pause spin' : 'Spin');
  spinButton
    .querySelector('path')!
    .setAttribute('d', s.spin ? 'M9 6v12m6-12v12' : 'M8 6.5v11l9-5.5Z');
}
syncSpinButton(store.get());
const toggleSpin = () =>
  store.dispatch({ type: 'settings', patch: { spin: !store.get().settings.spin } });
spinButton.addEventListener('click', toggleSpin);
byId('grow').addEventListener('click', () => view.grow());
mountHint();

let measured = false;
view.onFrame(({ growth }) => {
  if (growth < 1 || debug.ready || !debug.repo) return;
  debug.ready = true;
  debug.timings.ready ??= performance.now();
  document.body.dataset.ready = debug.repo;
  if (measured || store.get().settings.quality !== 'auto') return;
  measured = true;
  const before = view.stats().renders;
  const start = performance.now();
  setTimeout(() => {
    const frames = view.stats().renders - before;
    const fps = (frames * 1000) / (performance.now() - start);
    const { autoQuality: current } = store.get();
    if (frames > 10 && fps < SMOOTH_FPS && current !== 'low') {
      store.dispatch({ type: 'auto-quality', quality: STEP_DOWN[current] });
    }
  }, MEASURE_MS);
});

byId('share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    app.toast('Link copied');
  } catch {
    app.toast('Copy the link from the address bar');
  }
});
byId('export').addEventListener('click', async () => {
  const { repo } = store.get();
  if (!repo) return;
  const blob = await view.snapshotPNG(2);
  const at = timeline.date();
  const when = at === null ? '' : `-${new Date(at).toISOString().slice(0, 10)}`;
  const name = `${repo.info.ref.owner}-${repo.info.ref.repo}-tree${when}.png`;
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: name,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  app.toast(`Saved ${name}`);
});
byId('search-open').addEventListener('click', () => search.open());

const phone = matchMedia('(max-width: 760px)');
const tools = document.querySelector<HTMLElement>('.tools')!;
const controls = document.querySelector<HTMLElement>('.controls')!;
const side = byId('side');
/** On phones the tools join the bottom controls, which ride on top of the sheet. */
const placeTools = () => {
  if (phone.matches) {
    side.prepend(controls);
    controls.append(tools);
  } else {
    side.after(controls);
    document.querySelector('.bar')!.append(tools);
  }
};
phone.addEventListener('change', placeTools);
placeTools();
mountMoreMenu(phone);

/** A panel covers the union of its visible children, so a row holding two buttons covers just them. */
function footprint(panel: HTMLElement, origin: DOMRect): Rect | null {
  const shown = [...panel.children]
    .map((child) => child.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (shown.length === 0) return null;
  return {
    left: Math.min(...shown.map((r) => r.left)) - origin.left,
    top: Math.min(...shown.map((r) => r.top)) - origin.top,
    right: Math.max(...shown.map((r) => r.right)) - origin.left,
    bottom: Math.max(...shown.map((r) => r.bottom)) - origin.top,
  };
}

const title = byId('title');
const panels = [
  document.querySelector<HTMLElement>('.bar')!,
  title,
  side,
  controls,
  byId('settings'),
];
/** Content width of a title card with a name and counts as long as torvalds/linux's. */
const TITLE_ROOM = 460;
/**
 * On a desktop the title card and the side panel grow with the repo's name and lists. Framing
 * reserves room for a typical title and the side panel's whole column, so repos frame into the
 * same region and their islands show at one size.
 */
function reserved(panel: HTMLElement, rect: Rect, origin: DOMRect): Rect {
  if (phone.matches) return rect;
  if (panel === title) return { ...rect, right: Math.max(rect.right, rect.left + TITLE_ROOM) };
  if (panel === side) return { ...rect, bottom: origin.height };
  return rect;
}
let reframing = 0;
/** Frames the tree into the largest region the panels leave uncovered, once a sheet drag settles. */
function reframe() {
  cancelAnimationFrame(reframing);
  reframing = requestAnimationFrame(() => {
    if (side.hasAttribute('data-dragging')) return;
    const origin = container.getBoundingClientRect();
    const covered = panels
      .map((p) => {
        const rect = footprint(p, origin);
        return rect && reserved(p, rect, origin);
      })
      .filter((r): r is Rect => r !== null);
    const room = stage(store.get().settings.ground);
    const fit = (w: number, h: number) => {
      const { position, target } = frameTree(room, w / h);
      return h / distanceOf(position, target);
    };
    const free = freeRect(origin.width, origin.height, covered, PANEL_GAP, fit);
    view.setInsets({
      top: free.top,
      right: origin.width - free.right,
      bottom: origin.height - free.bottom,
      left: free.left,
    });
  });
}
const panelObserver = new ResizeObserver(reframe);
for (const panel of panels) {
  panelObserver.observe(panel);
  for (const child of panel.children) panelObserver.observe(child);
}
new MutationObserver(reframe).observe(side, { attributeFilter: ['data-dragging'] });
phone.addEventListener('change', reframe);
addEventListener('resize', reframe);

addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  const typing = target.matches('input, textarea, select, [contenteditable]');
  if (event.key === 'Escape') {
    if (search.close() || settings.close() || compute.close() || typing) return;
    const { selection, highlight, load } = store.get();
    if (selection) app.select(null);
    else if (highlight !== null) app.highlight(null);
    else if (load.phase === 'loading') loader.cancel();
    else if (load.phase === 'error') store.dispatch({ type: 'dismiss-error' });
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey || !byId('search').hidden) return;
  if (event.key === '/') {
    event.preventDefault();
    search.open();
  } else if (event.key === ' ' && !target.matches('button, a, [role="radio"]')) {
    event.preventDefault();
    toggleSpin();
  } else if (event.key === 'g' || event.key === 'G') {
    view.grow();
  } else if (event.key === 'f' || event.key === 'F') {
    view.frameFolder(0);
  }
});

addEventListener('hashchange', () => {
  const link = parseLink(location.hash);
  if (link) applyLink(link);
});

const canvas = mountCanvas(app);
mountHeader(app);
mountSide(app);
const search = mountSearch(app);
const compute = mountHistoryCompute(app);
const timeline = mountTimeline(
  app,
  () => reducedMotion(store.get().settings),
  (counts) => canvas.setCounts(counts),
  compute,
);
const settings = mountSettings(app);

const link = parseLink(location.hash);
if (link) applyLink(link);
else app.load(parseRepoRef(`${FIRST_VISIT.owner}/${FIRST_VISIT.repo}`) as RepoRef);
