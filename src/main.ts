import '@fontsource-variable/hanken-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './app/app.css';
import { createTreeView } from './render/tree-view';
import { parseRepoRef, type RepoRef } from './repo/ref';
import { nameOf, type App, type CompanionPin } from './app/app';
import { birdsOf, pullFiles, type Bird } from './app/birds';
import { debug } from './app/debug';
import { byId } from './app/dom';
import { count } from './app/format';
import { freeRect, type Rect } from './app/free-rect';
import { formatLink, parseLink, type ViewLink } from './app/link';
import { createLoader } from './app/loader';
import { rememberRecent } from './app/recent';
import { FIRST_VISIT } from './app/samples';
import { autoQuality, parseSettings, STEP_DOWN, type Settings } from './app/settings';
import {
  companionFactsOf,
  companionsOf,
  createStore,
  factsOf,
  repoName,
  qualityOf,
  weatherOf,
  type AppState,
} from './app/state';
import { watchHistory } from './app/history-facts';
import { mountCanvas } from './app/ui/canvas';
import { mountHeader } from './app/ui/header';
import { mountHint } from './app/ui/hint';
import { mountMoreMenu } from './app/ui/more-menu';
import { mountQuick } from './app/ui/quick';
import { mountPinTray } from './app/ui/pin-tray';
import { mountSignIn } from './app/ui/signin';
import { mountSearch } from './app/ui/search-dialog';
import { mountSettings } from './app/ui/settings-dialog';
import { childrenOf, mountSide } from './app/ui/side';
import { mountHistoryCompute } from './app/ui/history-compute';
import { mountTimeline } from './app/ui/timeline';
import { mountCompare } from './app/ui/compare';
import { mountBranchDiff } from './app/ui/branch-diff';
import { diffMarks } from './repo/branch-diff';
import { rankOf, sizeScales, treeStats } from './app/compare';

const SETTINGS_KEY = 'repo-tree:settings';
/**
 * `embed=1`, in the hash link or the page's own query, shows just the tree for an iframe on
 * another page: the cards, panels, buttons and dialogs hide (app.css), and a small link opens
 * the same view in Repo Tree. Orbit, zoom, hover and pins still work.
 */
const embedded =
  parseLink(location.hash)?.embed === true ||
  new URLSearchParams(location.search).get('embed') === '1';
document.body.toggleAttribute('data-embed', embedded);
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
  settings: parseSettings(stored, matchMedia('(prefers-color-scheme: dark)').matches),
  autoQuality: autoQuality({
    pixelRatio: devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency || 4,
  }),
  ci: {},
  pulls: {},
  preview: null,
  timeline: null,
  history: null,
  compare: [],
  companions: [],
  companionHistory: [],
  diff: null,
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
  night: initial.settings.theme === 'dark',
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

const loader = createLoader(store, {
  signInExpired: () =>
    app.toast('Your GitHub sign-in expired, so you’re signed out. Sign in again any time.'),
});
watchHistory(store);
let hovered: number | null = null;
/** The compared tree the hovered folder is on, by its index in companionsOf, if not the one on show. */
let hoveredCompanion: number | undefined;
/** A folder pinned on a compared tree, kept while the grove stands as it is. */
let companionPin: CompanionPin | null = null;
/** The panels that show the compared tree's pin, told when it changes. */
const companionPinListeners: (() => void)[] = [];
function setCompanionPin(pin: CompanionPin | null) {
  if (pin === companionPin) return;
  companionPin = pin;
  for (const listener of companionPinListeners) listener();
}
/** Whether the camera glided to the pin on show, so clearing it glides back. */
let framedPin = false;
let hoveredCategory: string | null = null;
/** The birds whose PRs light their files: the one under the pointer, the one whose card is open. */
let pullHovered: number | null = null;
let pullHeld: number | null = null;
/** The bird whose files are lit now. */
let litBird: Bird | null = null;
let toastTimer = 0;
const toastEl = byId('toast');

const app: App = {
  store,
  view,
  load: (ref, options) => void loader.load(ref, options),
  cancelLoad: () => loader.cancel(),
  select(selection, frame = false) {
    const was = store.get().selection;
    const held = companionPin;
    setCompanionPin(null);
    store.dispatch({ type: 'select', selection });
    // Letting go of a compared tree's pin changes no state the store hears of.
    if (held && store.get().selection === was) applyHighlight();
    if (selection && frame) {
      view.frameFolder(selection.folder);
      framedPin = true;
    } else if (!selection && was && framedPin) {
      // Clearing a pin the camera glided to glides back to the whole tree.
      view.frameFolder(0);
    }
    if (!selection) framedPin = false;
  },
  hover(folder, companion) {
    hovered = folder;
    hoveredCompanion = folder === null ? undefined : companion;
    debug.previewed = folder;
    applyHighlight();
  },
  showPull(bird, held = false) {
    if (held) pullHeld = bird;
    else pullHovered = bird;
    applyPull();
  },
  highlight(label) {
    store.dispatch({ type: 'highlight', label });
  },
  hoverCategory(label) {
    hoveredCategory = label;
    applyHighlight();
  },
  pinCompanion(pin) {
    app.select(null);
    setCompanionPin(pin);
    applyHighlight();
  },
  companionPin: () => companionPin,
  onCompanionPin: (listener) => void companionPinListeners.push(listener),
  openSettings: (focus) => settings.open(focus),
  signIn: () => void signin.signIn(),
  refreshRuns: () => loader.refreshRuns(),
  openSearch: () => search.open(),
  toast(message) {
    const long = message.length > 120;
    toastEl.textContent = message;
    toastEl.classList.toggle('long', long);
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), long ? 30_000 : 2400);
  },
};

/** Whether search matches are being stepped through; set once search is mounted. */
let searchStepping = () => false;

/**
 * Lights the leaves of the files the shown bird's PR changes, as search lights its matches, and
 * puts back whatever search had lit once it goes.
 */
function applyPull() {
  const state = store.get();
  const index = pullHovered ?? pullHeld;
  const bird = (index !== null && state.repo && birdsOf(state)?.[index]) || null;
  if (bird === litBird) return;
  litBird = bird;
  debug.litPull = bird ? bird.pull.number : null;
  if (bird) view.setMatches(pullFiles(bird.pull.files, state.repo!.index.files.paths).lit);
  else {
    view.setMatches(null);
    search.relight();
  }
  applyHighlight();
}

/** A legend entry under the pointer shows first, then the pin or highlight, then a hovered folder. */
function applyHighlight() {
  const { repo, selection, highlight } = store.get();
  // A PR's files light across the tree, which nothing fades, its perch marked.
  if (litBird && repo) {
    const [lo, hi] = repo.tree.folders.range;
    view.setHighlight({ range: [lo!, hi!] });
    canvas.mark(litBird.folder);
    return;
  }
  const category = hoveredCategory ?? highlight;
  // A pin on a compared tree holds as a pin on the tree on show does.
  const pin = selection ?? companionPin;
  const folder = category === null ? (pin?.folder ?? hovered) : null;
  // Stepping through search matches keeps them all lit: the pin glides there but fades nothing.
  const faded = searchStepping() ? hovered : folder;
  // A folder pinned or hovered on a compared tree lights there.
  const other = selection ? undefined : companionPin ? companionPin.companion : hoveredCompanion;
  const tree = other === undefined ? repo : companionsOf(store.get())[other];
  const range = tree?.tree.folders.range;
  const held = companionPin && companionsOf(store.get())[companionPin.companion];
  debug.companionPin = held
    ? `${held.info.ref.owner}/${held.info.ref.repo}:${held.tree.folders.path[companionPin!.folder]}`
    : null;
  view.setHighlight(
    category !== null
      ? { category }
      : faded === null || faded === 0 || !range
        ? null
        : { range: [range[2 * faded]!, range[2 * faded + 1]!], companion: other },
  );
  canvas.mark(other === undefined ? folder : null);
}

/** The compared branch the tree on show was grown for, once read. */
function shownDiff({ repo, diff }: AppState) {
  return repo && diff?.status === 'ready' && repo.diffHead === diff.head ? diff : null;
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

/** The pin tray's folders for a link; set once the tray is mounted. */
let pinsOf: (state: AppState) => string[] | undefined = () => undefined;

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
    vs: state.compare.length ? [...state.compare] : undefined,
    pins: pinsOf(state),
    diff: state.diff?.head,
    embed: embedded || undefined,
  });
}

/** The same view in the full app, for the embed's link out and the embed code's source. */
function appUrl(hash: string, embed: boolean): string {
  const url = new URL(location.href);
  url.searchParams.delete('embed');
  const link = parseLink(hash);
  url.hash = link ? formatLink({ ...link, embed: embed || undefined }) : hash;
  return url.href;
}

function applyLink(link: ViewLink) {
  const patch: Partial<Settings> = {};
  if (link.palette) patch.palette = link.palette;
  if (link.colorBy) patch.colorBy = link.colorBy;
  if (Object.keys(patch).length) store.dispatch({ type: 'settings', patch });
  store.dispatch({ type: 'preview', sky: link.wx ?? null });
  store.dispatch({ type: 'compare', refs: link.vs ?? [] });
  pinTray.receive(link.ref, link.pins ?? []);
  // A branch's changes, once its repo shows; a link without one puts the tree back.
  const name = `${link.ref.owner}/${link.ref.repo}`.toLowerCase();
  if (link.diff) branchDiff.request(name, link.diff);
  else if (store.get().diff) store.dispatch({ type: 'diff', diff: null });
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
  // The compared trees stand beside this one, and replay with it on the timeline.
  const others = (s: AppState) => companionsOf(s);
  const [now, then] = [others(state), others(prev)];
  const moved = now.length !== then.length || now.some((c, i) => c !== then[i]);
  if (moved || state.repo !== prev.repo) {
    // A compared tree's pin goes with the grove it was made in.
    if (companionPin) {
      setCompanionPin(null);
      applyHighlight();
    }
    view.setLanguageRank(rankOf(state));
    // Their heights show their sizes against each other.
    const scales =
      now.length && state.repo
        ? sizeScales([state.repo, ...now].map((l) => treeStats(l).files))
        : [1];
    view.setCompanions(
      now.map((l) => l.tree),
      { main: scales[0]!, companions: scales.slice(1) },
    );
    reframe();
  }
  const facts = now.map((c) => companionFactsOf(state, c));
  if (moved || state.companionHistory !== prev.companionHistory) {
    view.setCompanionFacts(facts);
  }
  const birds = birdsOf(state);
  if (birds !== birdsOf(prev) || state.repo !== prev.repo) {
    view.setBirds(birds && birds.map(({ folder, color }) => ({ folder, color })));
    // The lit PR's files name the old tree's, or a bird no longer there.
    pullHovered = pullHeld = null;
    applyPull();
  }
  // The compared branch shows once the tree holds its new files.
  if (state.repo !== prev.repo || shownDiff(state) !== shownDiff(prev)) {
    const shown = shownDiff(state);
    view.setDiff(shown && diffMarks(shown.diff, state.repo!.index.files.paths).marks);
  }
  if (s.palette !== prev.settings.palette) view.setPalette(s.palette);
  if (s.colorBy !== prev.settings.colorBy) view.setColorBy(s.colorBy);
  if (factsOf(state) !== factsOf(prev) || state.repo !== prev.repo) view.setFacts(factsOf(state));
  if (s.theme !== prev.settings.theme) {
    view.setNight(s.theme === 'dark');
    syncTheme(state);
  }
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

  // A compared branch's new files grow in once its comparison is read, and go once it is let go.
  const diff = state.diff;
  const regrowDiff =
    diff !== prev.diff &&
    diff?.status !== 'loading' &&
    !!state.repo &&
    (diff?.status === 'ready' && diff.repo === repoName(state.repo) ? diff.head : undefined) !==
      state.repo.diffHead;
  // Side by side shows several repos; a branch's changes describe one.
  if (state.compare.length && diff)
    queueMicrotask(() => store.dispatch({ type: 'diff', diff: null }));
  const regrow =
    s.quality !== prev.settings.quality || s.hidden !== prev.settings.hidden || regrowDiff;
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

const themeButton = byId<HTMLButtonElement>('theme');
const themeColor = document.querySelector('meta[name="theme-color"]');
/** Dark mode marks the page for its CSS, and the button offers the other mode. */
function syncTheme({ settings: s }: AppState) {
  const dark = s.theme === 'dark';
  document.documentElement.dataset.theme = s.theme;
  themeColor?.setAttribute('content', dark ? '#050506' : '#f6f4f0');
  const label = dark ? 'Light mode' : 'Dark mode';
  themeButton.setAttribute('aria-label', label);
  themeButton.querySelector('.label')!.textContent = label;
  themeButton.querySelector('svg')!.innerHTML = dark
    ? '<circle cx="12" cy="12" r="4" /><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />'
    : '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" />';
}
syncTheme(store.get());
themeButton.addEventListener('click', () =>
  store.dispatch({
    type: 'settings',
    patch: { theme: store.get().settings.theme === 'dark' ? 'light' : 'dark' },
  }),
);

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
/** Reset view shows once the camera has zoomed, panned or glided off the whole tree. */
const resetButton = byId<HTMLButtonElement>('reset-view');
resetButton.addEventListener('click', () => view.frameFolder(0));
/** How long the camera must stay off (or back on) the whole tree before the button follows. */
const RESET_SETTLE_MS = 350;
let resetTimer = 0;
const syncReset = () => {
  const away = !view.atHome();
  // A camera hovering at the edge of "home" (a framing still easing, a nudge of a zoom) would
  // flash the button on and off every frame: it changes only once the new state has held, and
  // a timer, not the next frame, makes the change, since a still scene stops drawing frames.
  if (resetButton.hidden !== away) {
    clearTimeout(resetTimer);
    resetTimer = 0;
  } else if (!resetTimer) {
    resetTimer = window.setTimeout(() => {
      resetTimer = 0;
      if (resetButton.hidden === !view.atHome()) resetButton.hidden = view.atHome();
    }, RESET_SETTLE_MS);
  }
};
view.onFrame(syncReset);
mountHint();
// iOS Safari ignores user-scalable=no; its own gesture events are the way to keep a pinch
// from zooming the page, so it zooms the tree alone.
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

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
/** A phone's own share sheet, where the browser has one; it sits at the top of the More menu. */
const nativeShare = byId<HTMLButtonElement>('native-share');
nativeShare.hidden = typeof navigator.share !== 'function';
nativeShare.addEventListener('click', () => {
  const { repo } = store.get();
  const name = repo ? `${repo.info.ref.owner}/${repo.info.ref.repo}` : 'Repo Tree';
  // A dismissed sheet rejects; there is nothing to say then.
  navigator.share({ title: `${name} · Repo Tree`, url: location.href }).catch(() => {});
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
byId('embed-copy').addEventListener('click', async () => {
  const { repo } = store.get();
  if (!repo) return;
  const name = `${repo.info.ref.owner}/${repo.info.ref.repo}`;
  const src = appUrl(linkOf(store.get()) ?? location.hash, true).replaceAll('&', '&amp;');
  const code = `<iframe src="${src}" title="3D tree of ${name}" width="640" height="480" style="border:0;border-radius:12px" loading="lazy"></iframe>`;
  try {
    await navigator.clipboard.writeText(code);
    app.toast('Embed code copied');
  } catch {
    app.toast('Couldn’t copy: add ?embed=1 to the link to embed it');
  }
});

/** In an embed, the way out to the full app: the repo's name, opened in a new tab. */
const embedOpen = byId<HTMLAnchorElement>('embed-open');
embedOpen.hidden = !embedded;
if (embedded) {
  const sync = (state: AppState) => {
    const name = state.repo ? `${state.repo.info.ref.owner}/${state.repo.info.ref.repo}` : '';
    embedOpen.querySelector('.name')!.textContent = name;
    embedOpen.href = appUrl(linkOf(state) ?? location.hash, false);
    embedOpen.setAttribute('aria-label', `Open ${name || 'this tree'} in Repo Tree`);
  };
  store.subscribe(sync);
  sync(store.get());
}

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
// Moving between the bar and the menu restores the label the button started with.
phone.addEventListener('change', () => syncTheme(store.get()));

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
/**
 * On a desktop the repo card and the side panel grow with the repo's name and lists. Framing
 * reserves the card's whole column (its widest, as the CSS caps it with --col) and the side
 * panel's whole column, so repos frame into the same region and their islands show at one size.
 * While comparing, the card reserves only itself. The controls reserve their whole band across
 * the bottom: Reset view shows and hides with the framing, and if its width moved the framing,
 * showing it would hide it again, on repeat.
 */
function reserved(panel: HTMLElement, rect: Rect, origin: DOMRect): Rect {
  if (panel === controls) return { ...rect, left: 0, right: origin.width };
  if (phone.matches) return rect;
  // While comparing the card is the grove's list, one width whatever the repos, so the grove,
  // wide as it is, takes the room beside it rather than the widest a repo's card could be.
  if (panel === title && !document.body.hasAttribute('data-compare')) {
    const col = Math.min(520, origin.width * 0.42);
    return { ...rect, right: Math.max(rect.right, rect.left + col) };
  }
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
    // The grove while comparing, so a wide grove takes a wide region.
    const fit = (w: number, h: number) => h / view.wholeDistance(w / h);
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
    if (search.stop()) return;
    const { selection, highlight, load } = store.get();
    if (selection || companionPin) app.select(null);
    else if (highlight !== null) app.highlight(null);
    else if (load.phase === 'loading') loader.cancel();
    else if (load.phase === 'error') store.dispatch({ type: 'dismiss-error' });
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey || !byId('search').hidden) return;
  // An embed keeps the keys that move the tree, not the ones that open the app's panels.
  if (embedded && ['/', 't', 'T', 'd', 'D'].includes(event.key)) return;
  if (event.key === '/') {
    event.preventDefault();
    search.open({ instant: true });
  } else if (event.key === ' ' && !target.matches('button, a, [role="radio"]')) {
    event.preventDefault();
    toggleSpin();
  } else if (event.key === 'g' || event.key === 'G') {
    view.grow();
  } else if (event.key === 'f' || event.key === 'F') {
    view.frameFolder(0);
  } else if (event.key === 'd' || event.key === 'D') {
    themeButton.click();
  } else if (event.key === 't' || event.key === 'T') {
    byId('timeline').click();
  } else if (event.key === 'n' || event.key === 'N') {
    search.step(event.shiftKey ? -1 : 1);
  }
});

addEventListener('hashchange', () => {
  const link = parseLink(location.hash);
  // Into or out of an embed is a different page, so it starts again from the link.
  if (link && (link.embed === true) !== embedded && !location.search.includes('embed=1')) {
    return location.reload();
  }
  if (link) applyLink(link);
});

const canvas = mountCanvas(app);
mountHeader(app);
mountSide(app);
const search = mountSearch(app);
searchStepping = search.stepping;
const compute = mountHistoryCompute(app);
const timeline = mountTimeline(
  app,
  () => reducedMotion(store.get().settings),
  (counts) => canvas.setCounts(counts),
  compute,
);
const settings = mountSettings(app);
mountCompare(app);
const branchDiff = mountBranchDiff(app);
const signin = mountSignIn(app, { refreshRuns: () => loader.refreshRuns() });
mountQuick(app);
const pinTray = mountPinTray(app, () => {
  const link = linkOf(store.get());
  if (link && link !== location.hash) history.replaceState(null, '', link);
});
pinsOf = (state) => {
  // A tray of only the pin on show adds nothing to the link's sel.
  const pins = pinTray.pinsFor(state);
  const sel = state.selection && state.repo?.tree.folders.path[state.selection.folder];
  return pins.some((p) => p !== sel) ? pins : undefined;
};

const link = parseLink(location.hash);
if (link) applyLink(link);
else app.load(parseRepoRef(`${FIRST_VISIT.owner}/${FIRST_VISIT.repo}`) as RepoRef);
