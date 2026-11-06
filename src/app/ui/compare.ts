import { loadInWorker, type Loaded, type LoadSource } from '../../load/load-in-worker';
import { githubToken } from '../../repo/auth';
import { parseRepoRef, type RepoRef } from '../../repo/ref';
import { PALETTES } from '../../render/palette';
import { createTreeView, type TreeView } from '../../render/tree-view';
import type { App } from '../app';
import {
  defaultPartner,
  languageRows,
  sharedRank,
  sizeLine,
  treeStats,
  type TreeStats,
} from '../compare';
import { byId, fill, h, icon, ICONS } from '../dom';
import { describeError } from '../errors';
import { bytes, count, percent, plural } from '../format';
import { SEED } from '../loader';
import { readRecent } from '../recent';
import { sampleFor, SAMPLES } from '../samples';
import { qualityOf, sameRef, type AppState } from '../state';

/** Languages the table lists, across both trees. */
const LANG_ROWS = 6;
/** Trees grown for the right-hand side, kept so switching back is instant. */
const KEEP = 3;
const SWAP_ICON = ['M7 7h12m0 0-3.5-3.5M19 7l-3.5 3.5', 'M17 17H5m0 0 3.5 3.5M5 17l3.5-3.5'];

type Side = {
  pane: HTMLElement;
  host: HTMLElement;
  card: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  status: HTMLElement;
  view: TreeView | null;
  shown: Loaded | null;
  stats: TreeStats | null;
};

const nameOf = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`;
const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;

/**
 * Compare trees: the repo on show and a second one grown side by side (stacked on a phone), each
 * orbiting on its own, with their sizes and languages in a table below. Both trees color leaves
 * by language, ranked across the two, so a language wears one color on both. The second repo is
 * `state.compare`; opening picks the most recent other repo, else a quick sample.
 * While it is open the main tree holds still behind it.
 */
export function mountCompare(
  app: App,
  {
    reducedMotion,
    pauseMain,
  }: { reducedMotion: () => boolean; pauseMain: (paused: boolean) => void },
): { open(): void; close(): boolean; isOpen(): boolean } {
  const { store } = app;
  const root = byId('compare');
  const openButton = byId<HTMLButtonElement>('compare-open');
  const line = h('p', { class: 'cmp-line', id: 'compare-line', 'aria-live': 'polite' });
  const table = h('table', { class: 'cmp-table', 'aria-label': 'Both trees side by side' });

  const side = (key: 'a' | 'b', label: string): Side => {
    const name = h('h3', { class: 'cmp-name' });
    const meta = h('p', { class: 'cmp-meta' });
    const status = h('p', { class: 'cmp-status', role: 'status' });
    const card = h('div', { class: 'cmp-card' }, name, meta, status);
    const host = h('div', { class: 'cmp-view' });
    const pane = h(
      'section',
      { class: 'cmp-pane', 'data-side': key, 'aria-label': label },
      host,
      card,
    );
    return { pane, host, card, name, meta, status, view: null, shown: null, stats: null };
  };
  const a = side('a', 'Tree on show');
  const b = side('b', 'Tree to compare');

  const input = h('input', {
    type: 'text',
    id: 'compare-input',
    placeholder: 'owner/repo or GitHub URL',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    'aria-label': 'Repository to compare',
    'aria-describedby': 'compare-error',
  });
  const error = h('p', { class: 'field-error', id: 'compare-error', role: 'alert' });
  const chips = h('div', { class: 'cmp-chips', role: 'group', 'aria-label': 'Quick picks' });
  const form = h(
    'form',
    { class: 'cmp-form', novalidate: true },
    h(
      'div',
      { class: 'cmp-field' },
      input,
      h('button', { type: 'submit', class: 'go' }, 'Compare'),
    ),
    error,
    chips,
  );
  const openMain = h(
    'button',
    { type: 'button', class: 'cmp-open', id: 'compare-show' },
    'Open this tree',
  );
  const change = h(
    'button',
    {
      type: 'button',
      class: 'cmp-open',
      id: 'compare-change',
      'aria-expanded': 'false',
      'aria-controls': 'compare-form',
    },
    'Change',
  );
  form.id = 'compare-form';
  form.hidden = true;
  /** The field folds away so the tree keeps its room; Change opens it. */
  const showForm = (on: boolean) => {
    form.hidden = !on;
    change.setAttribute('aria-expanded', String(on));
    if (on) input.focus();
  };
  change.addEventListener('click', () => showForm(form.hidden === true));
  b.card.append(h('div', { class: 'cmp-actions' }, change, openMain), form);

  const swap = h(
    'button',
    { type: 'button', class: 'pill-btn cmp-swap', id: 'compare-swap', 'aria-label': 'Swap sides' },
    icon(...SWAP_ICON),
    h('span', {}, 'Swap'),
  );
  const closeButton = h(
    'button',
    { type: 'button', class: 'close cmp-close', 'aria-label': 'Close compare' },
    icon(...ICONS.close),
  );
  root.append(
    h(
      'header',
      { class: 'cmp-bar' },
      h('h2', { id: 'compare-title' }, 'Compare trees'),
      line,
      swap,
      closeButton,
    ),
    h('div', { class: 'cmp-panes' }, a.pane, b.pane),
    h('div', { class: 'cmp-foot' }, table),
  );

  const memory = new Map<string, Loaded>();
  let abort: AbortController | null = null;
  let loading: RepoRef | null = null;
  let returnFocus: HTMLElement | null = null;
  const inerted: HTMLElement[] = [];
  const isOpen = () => !root.hidden;

  const makeView = (s: Side): TreeView => {
    const state = store.get();
    const view = createTreeView(s.host, {
      quality: qualityOf(state),
      palette: state.settings.palette,
      colorBy: 'language',
      spin: state.settings.spin,
      reducedMotion: reducedMotion(),
      ground: state.settings.ground,
      night: state.settings.theme === 'dark',
    });
    view.onFrame(({ growth }) => {
      if (growth < 1 || !s.shown) return;
      const name = nameOf(s.shown.info.ref);
      if (s.pane.dataset.ready !== name) s.pane.dataset.ready = name;
    });
    return view;
  };

  /** The card covers the top of its pane, so each tree frames into the room below it. */
  const inset = (s: Side) => {
    if (!s.view) return;
    const pane = s.pane.getBoundingClientRect();
    const card = s.card.getBoundingClientRect();
    s.view.setInsets({
      top: Math.max(0, card.bottom - pane.top) + 8,
      right: 0,
      bottom: 0,
      left: 0,
    });
  };
  const cards = new ResizeObserver(() => {
    inset(a);
    inset(b);
  });
  cards.observe(a.card);
  cards.observe(b.card);
  cards.observe(a.pane);
  cards.observe(b.pane);

  const show = (s: Side, loaded: Loaded) => {
    if (s.shown === loaded) return;
    s.shown = loaded;
    s.stats = treeStats(loaded);
    delete s.pane.dataset.ready;
    s.view?.setTree(loaded.tree);
    s.name.textContent = nameOf(loaded.info.ref);
    s.meta.textContent = [
      plural(s.stats.files, 'file'),
      plural(s.stats.folders, 'folder'),
      bytes(s.stats.bytes),
    ].join(' · ');
    s.status.textContent = '';
    s.pane.removeAttribute('aria-busy');
    compareBoth();
  };

  /** Shares the language ranking, then fills the sentence and the table. */
  const compareBoth = () => {
    if (!a.stats || !b.stats || !a.shown || !b.shown) {
      a.view?.setLanguageRank(null);
      b.view?.setLanguageRank(null);
      line.textContent = '';
      fill(table);
      return;
    }
    const rank = sharedRank(a.stats, b.stats);
    a.view?.setLanguageRank(rank);
    b.view?.setLanguageRank(rank);
    const [left, right] = [a.shown.info.ref.repo, b.shown.info.ref.repo];
    const sameName = left.toLowerCase() === right.toLowerCase();
    const label = (s: Side) => (sameName ? nameOf(s.shown!.info.ref) : s.shown!.info.ref.repo);
    line.textContent = sizeLine(
      { name: label(a), files: a.stats.files },
      { name: label(b), files: b.stats.files },
    );
    const colors = new Map<string, string>();
    const rest = PALETTES[store.get().settings.palette].rest;
    for (const view of [b.view, a.view]) {
      for (const e of view?.legend() ?? []) colors.set(e.label, e.color);
    }
    const row = (head: Node | string, x: Node | string, y: Node | string) =>
      h('tr', {}, h('th', { scope: 'row' }, head), h('td', {}, x), h('td', {}, y));
    const share = (files: number, total: number, color: string) =>
      h(
        'span',
        { class: 'cmp-share' },
        files > 0 &&
          h('span', {
            class: 'cmp-fill',
            style: `--w:${total ? (files / total) * 100 : 0}%;--c:${color}`,
          }),
        h('span', { class: 'cmp-num' }, files ? `${count(files)} · ${percent(files, total)}` : '–'),
      );
    const { stats: sa } = a;
    const { stats: sb } = b;
    fill(
      table,
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('td', {}),
          h('th', { scope: 'col' }, label(a)),
          h('th', { scope: 'col' }, label(b)),
        ),
      ),
      h(
        'tbody',
        {},
        row('Files', count(sa.files), count(sb.files)),
        row('Folders', count(sa.folders), count(sb.folders)),
        row('Deepest folder', plural(sa.depth, 'level'), plural(sb.depth, 'level')),
        row('Size', bytes(sa.bytes), bytes(sb.bytes)),
        ...languageRows(sa, sb, LANG_ROWS).map(({ lang, a: x, b: y }) => {
          const color = colors.get(lang) ?? rest;
          return row(
            h('span', { class: 'cmp-lang' }, h('i', { style: `background:${color}` }), lang),
            share(x, sa.files, color),
            share(y, sb.files, color),
          );
        }),
      ),
    );
  };

  const fillChips = () => {
    const shown = [store.get().repo?.info.ref, store.get().compare].filter(Boolean) as RepoRef[];
    const names = [...readRecent(), ...SAMPLES.map((s) => `${s.owner}/${s.repo}`)].filter(
      (name, i, all) => {
        const ref = parseRepoRef(name);
        if ('kind' in ref) return false;
        if (shown.some((s) => sameRef(plain(s), plain(ref)))) return false;
        return all.findIndex((n) => n.toLowerCase() === name.toLowerCase()) === i;
      },
    );
    fill(
      chips,
      ...names
        .slice(0, 5)
        .map((name) =>
          h(
            'button',
            { type: 'button', onclick: () => pick(parseRepoRef(name) as RepoRef) },
            name.slice(name.indexOf('/') + 1),
          ),
        ),
    );
  };

  const pick = (ref: RepoRef) => {
    error.textContent = '';
    input.value = '';
    showForm(false);
    store.dispatch({ type: 'compare', ref: plain(ref) });
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const ref = parseRepoRef(input.value);
    if ('kind' in ref) {
      error.textContent = 'Enter owner/repo or a GitHub URL';
      return;
    }
    pick(ref);
  });

  /** Grows the right-hand repo: the one on show as it is, else from memory, else in a worker. */
  async function loadSide(ref: RepoRef) {
    const state = store.get();
    const main = state.repo;
    if (main && sameRef(plain(main.info.ref), ref)) return show(b, main);
    const { hidden } = state.settings;
    const quality = qualityOf(state);
    const key = `${nameOf(ref).toLowerCase()}|${hidden.join('/')}|${quality}`;
    const kept = memory.get(key);
    if (kept) return show(b, kept);
    if (loading && sameRef(loading, ref)) return;
    abort?.abort();
    const signal = (abort = new AbortController()).signal;
    loading = ref;
    b.pane.setAttribute('aria-busy', 'true');
    b.status.textContent = `Growing ${nameOf(ref)}…`;
    const token = githubToken(state.settings.token);
    const sample = sampleFor(ref);
    const source: LoadSource = sample
      ? { kind: 'sample', id: sample.id, base: new URL('./', location.href).href }
      : { kind: 'github', ref, token, fresh: false };
    try {
      const result = await loadInWorker(
        { source, filters: { hidden }, params: { seed: SEED, quality } },
        { step: () => {} },
        signal,
      );
      if ('kind' in result) {
        b.pane.removeAttribute('aria-busy');
        b.status.textContent = describeError(result, ref, { hasToken: !!token }).title;
        return;
      }
      memory.set(key, result);
      if (memory.size > KEEP) memory.delete(memory.keys().next().value!);
      if (sameRef(store.get().compare, ref)) show(b, result);
    } catch (reason) {
      if (signal.aborted) return;
      console.error(reason);
      b.pane.removeAttribute('aria-busy');
      b.status.textContent = `Couldn’t grow ${nameOf(ref)}`;
    } finally {
      if (abort?.signal === signal) {
        abort = null;
        loading = null;
      }
    }
  }

  const sync = (state: AppState, prev: AppState | null) => {
    const want = state.compare !== null && state.repo !== null;
    if (want && !isOpen()) {
      returnFocus = document.activeElement as HTMLElement | null;
      root.hidden = false;
      document.body.dataset.comparing = '';
      // Everything behind the view is out of reach, for a keyboard and a screen reader too.
      for (const el of document.body.children) {
        if (el !== root && el instanceof HTMLElement && !el.inert && el.id !== 'toast') {
          el.inert = true;
          inerted.push(el);
        }
      }
      pauseMain(true);
      a.view = makeView(a);
      b.view = makeView(b);
      a.shown = b.shown = null;
      a.stats = b.stats = null;
      for (const s of [a, b]) {
        delete s.pane.dataset.ready;
        s.name.textContent = '';
        s.meta.textContent = '';
      }
      inset(a);
      inset(b);
      closeButton.focus();
    } else if (!want && isOpen()) {
      abort?.abort();
      abort = null;
      loading = null;
      for (const s of [a, b]) {
        s.view?.dispose();
        s.view = null;
        s.shown = null;
        s.stats = null;
      }
      root.hidden = true;
      delete document.body.dataset.comparing;
      for (const el of inerted.splice(0)) el.inert = false;
      pauseMain(false);
      // Back to what opened it, or More actions when that hides in its menu on a phone.
      const shown = (el: HTMLElement | null) => !!el?.isConnected && el.offsetParent !== null;
      const back = [returnFocus, openButton, byId('more')].find(shown);
      back?.focus();
      returnFocus = null;
    }
    if (!want) return;
    if (state.repo !== a.shown) show(a, state.repo!);
    if (!prev || !sameRef(state.compare, prev.compare) || !b.shown) {
      const shownB = b.shown?.info.ref;
      if (!shownB || !sameRef(plain(shownB), state.compare)) {
        b.name.textContent = nameOf(state.compare!);
        b.meta.textContent = '';
        void loadSide(state.compare!);
      }
      fillChips();
    }
    const s = state.settings;
    if (prev && s !== prev.settings) {
      for (const view of [a.view, b.view]) {
        if (s.theme !== prev.settings.theme) view?.setNight(s.theme === 'dark');
        if (s.palette !== prev.settings.palette) view?.setPalette(s.palette);
      }
      if (s.palette !== prev.settings.palette) compareBoth();
    }
  };
  store.subscribe((state, prev) => sync(state, prev));

  const syncButton = () => {
    const ready = store.get().repo !== null;
    openButton.setAttribute('aria-disabled', String(!ready));
  };
  store.subscribe(syncButton);
  syncButton();

  function open() {
    const { repo, compare } = store.get();
    if (!repo || compare) return;
    store.dispatch({ type: 'compare', ref: defaultPartner(repo.info.ref, readRecent()) });
  }
  function close(): boolean {
    if (!isOpen()) return false;
    store.dispatch({ type: 'compare', ref: null });
    return true;
  }

  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  swap.addEventListener('click', () => {
    const { repo, compare } = store.get();
    if (!repo || !compare || !b.shown) return;
    const left = plain(repo.info.ref);
    store.dispatch({ type: 'compare', ref: left });
    app.load(compare);
  });
  openMain.addEventListener('click', () => {
    const { compare } = store.get();
    if (!compare) return;
    store.dispatch({ type: 'compare', ref: null });
    app.load(compare);
  });
  // Escape and the app's shortcuts are main.ts's; this keeps Tab inside the open view.
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll<HTMLElement>('button, input, a[href]')].filter(
      (el) => el.offsetParent !== null,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });

  if (store.get().compare) sync(store.get(), null);
  return { open, close, isOpen };
}
