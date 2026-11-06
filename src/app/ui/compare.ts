import { loadInWorker, type Loaded, type LoadSource } from '../../load/load-in-worker';
import { githubToken } from '../../repo/auth';
import { parseRepoRef, type RepoRef } from '../../repo/ref';
import { PALETTES } from '../../render/palette';
import { leafCategories } from '../../render/tree-view';
import type { App } from '../app';
import { defaultPartner, languageRows, rankOf, sizeLine, treeStats } from '../compare';
import { byId, fill, h, icon, ICONS } from '../dom';
import { describeError } from '../errors';
import { bytes, count, percent, plural } from '../format';
import { SEED } from '../loader';
import { readRecent } from '../recent';
import { sampleFor, SAMPLES } from '../samples';
import { qualityOf, sameRef, type AppState } from '../state';

/** Languages the table lists, across both trees. */
const LANG_ROWS = 6;
/** Trees grown to compare, kept so switching back is instant. */
const KEEP = 3;
const SWITCH_ICON = ['M7 7h12m0 0-3.5-3.5M19 7l-3.5 3.5', 'M17 17H5m0 0 3.5 3.5M5 17l3.5-3.5'];

const leafFiles = (s: { langs: { files: number }[] }) =>
  s.langs.reduce((sum, l) => sum + l.files, 0);
const nameOf = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`;
const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;

/**
 * Compare trees: a second repo grows on its own island beside the one on show, in the same
 * world, and the camera frames and orbits both (main.ts hands it to the view). The panels keep
 * describing the repo on show; Switch trades the two, so the other one gets them. The title card
 * names the compared repo with Switch, Change and Stop, and the side panel sets both side by side
 * in a table. Color by applies to both, and languages rank across the two so each wears one
 * color on both. `state.compare` names the second repo, `state.companion` holds it once grown.
 */
export function mountCompare(app: App): { open(): void; close(): boolean } {
  const { store, view } = app;
  const root = byId('compare');
  const panel = byId('compare-panel');
  const openButton = byId<HTMLButtonElement>('compare-open');

  const name = h('strong', { class: 'cmp-name' });
  const meta = h('span', { class: 'cmp-meta' });
  const line = h('p', { class: 'cmp-line', id: 'compare-line' });
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
    { class: 'cmp-form', id: 'compare-form', novalidate: true },
    h(
      'div',
      { class: 'cmp-field' },
      input,
      h('button', { type: 'submit', class: 'go' }, 'Compare'),
    ),
    error,
    chips,
  );
  form.hidden = true;
  const switchButton = h(
    'button',
    { type: 'button', class: 'cmp-act', id: 'compare-switch' },
    icon(...SWITCH_ICON),
    h('span', {}, 'Switch'),
  );
  const change = h(
    'button',
    {
      type: 'button',
      class: 'cmp-act',
      id: 'compare-change',
      'aria-expanded': 'false',
      'aria-controls': 'compare-form',
    },
    'Change',
  );
  const stop = h(
    'button',
    { type: 'button', class: 'cmp-stop', 'aria-label': 'Stop comparing' },
    icon(...ICONS.close),
  );
  root.append(
    h(
      'div',
      { class: 'cmp-row' },
      h('span', { class: 'cmp-tag' }, 'Beside'),
      h('p', { class: 'cmp-with' }, name, meta),
      stop,
    ),
    line,
    h('div', { class: 'cmp-actions' }, switchButton, change),
    form,
  );
  const table = h('table', { class: 'cmp-table', 'aria-label': 'Both trees side by side' });
  panel.append(h('h2', { class: 'h' }, 'Side by side'), table);

  const memory = new Map<string, Loaded>();
  let abort: AbortController | null = null;
  let loading: RepoRef | null = null;
  let failed: RepoRef | null = null;

  const showForm = (on: boolean) => {
    form.hidden = !on;
    change.setAttribute('aria-expanded', String(on));
    if (on) {
      fillChips();
      input.focus();
    }
  };
  change.addEventListener('click', () => showForm(form.hidden === true));

  const fillChips = () => {
    const { repo, compare } = store.get();
    const shown = [repo?.info.ref, compare].filter(Boolean) as RepoRef[];
    const names = [...readRecent(), ...SAMPLES.map((s) => `${s.owner}/${s.repo}`)].filter(
      (n, i, all) => {
        const ref = parseRepoRef(n);
        if ('kind' in ref || shown.some((s) => sameRef(plain(s), plain(ref)))) return false;
        return all.findIndex((other) => other.toLowerCase() === n.toLowerCase()) === i;
      },
    );
    fill(
      chips,
      ...names
        .slice(0, 5)
        .map((n) =>
          h(
            'button',
            { type: 'button', onclick: () => pick(parseRepoRef(n) as RepoRef) },
            n.slice(n.indexOf('/') + 1),
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

  /** Grows the compared repo: the one on show as it is, else from memory, else in a worker. */
  async function grow(ref: RepoRef) {
    const state = store.get();
    const main = state.repo;
    if (main && sameRef(plain(main.info.ref), ref)) {
      return store.dispatch({ type: 'companion', companion: main });
    }
    const { hidden } = state.settings;
    const quality = qualityOf(state);
    const key = `${nameOf(ref).toLowerCase()}|${hidden.join('/')}|${quality}`;
    const kept = memory.get(key);
    if (kept) return store.dispatch({ type: 'companion', companion: kept });
    if (loading && sameRef(loading, ref)) return;
    abort?.abort();
    const signal = (abort = new AbortController()).signal;
    loading = ref;
    failed = null;
    root.setAttribute('aria-busy', 'true');
    meta.textContent = ' · growing…';
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
        failed = ref;
        meta.textContent = ` · ${describeError(result, ref, { hasToken: !!token }).title}`;
        return;
      }
      memory.set(key, result);
      if (memory.size > KEEP) memory.delete(memory.keys().next().value!);
      store.dispatch({ type: 'companion', companion: result });
    } catch (reason) {
      if (signal.aborted) return;
      console.error(reason);
      failed = ref;
      meta.textContent = ' · couldn’t grow it';
    } finally {
      if (abort?.signal === signal) {
        abort = null;
        loading = null;
        root.removeAttribute('aria-busy');
      }
    }
  }

  const renderTable = (state: AppState) => {
    const { repo, companion } = state;
    if (!repo || !companion) return fill(table);
    const [sa, sb] = [treeStats(repo), treeStats(companion)];
    const sameName = repo.info.ref.repo.toLowerCase() === companion.info.ref.repo.toLowerCase();
    const label = (l: Loaded) => (sameName ? nameOf(l.info.ref) : l.info.ref.repo);
    line.textContent = sizeLine(
      { name: label(repo), files: sa.files },
      { name: label(companion), files: sb.files },
    );
    const palette = PALETTES[state.settings.palette];
    const colors = new Map(
      leafCategories(repo.tree, 'language', palette, null, rankOf(state)).legend.map((e) => [
        e.label,
        e.color,
      ]),
    );
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
        h('span', { class: 'cmp-num' }, files ? percent(files, total) : '–'),
      );
    fill(
      table,
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('td', {}),
          h('th', { scope: 'col' }, label(repo)),
          h('th', { scope: 'col' }, label(companion)),
        ),
      ),
      h(
        'tbody',
        {},
        row('Files', count(sa.files), count(sb.files)),
        row('Folders', count(sa.folders), count(sb.folders)),
        row('Deepest', plural(sa.depth, 'level'), plural(sb.depth, 'level')),
        row('Size', bytes(sa.bytes), bytes(sb.bytes)),
        // Shares of the files the leaves count by language, as the legend's are.
        ...languageRows(sa, sb, LANG_ROWS).map(({ lang, a, b }) => {
          const color = colors.get(lang) ?? palette.rest;
          return row(
            h('span', { class: 'cmp-lang' }, h('i', { style: `background:${color}` }), lang),
            share(a, leafFiles(sa), color),
            share(b, leafFiles(sb), color),
          );
        }),
      ),
    );
  };

  const sync = (state: AppState, prev: AppState | null) => {
    const { compare, companion, repo } = state;
    const on = compare !== null;
    root.hidden = !on;
    openButton.setAttribute('aria-pressed', String(on));
    openButton.setAttribute('aria-disabled', String(!repo));
    panel.hidden = !(on && companion && repo);
    if (!on) {
      abort?.abort();
      abort = loading = failed = null;
      showForm(false);
      delete root.dataset.ready;
      return;
    }
    const moved = !prev || !sameRef(compare, prev.compare) || repo !== prev.repo;
    if (moved && !sameRef(compare, failed)) {
      name.textContent = nameOf(compare);
      if (!companion) void grow(compare);
    }
    if (!companion) delete root.dataset.ready;
    else if (companion !== prev?.companion || moved) {
      meta.textContent = ` · ${plural(treeStats(companion).files, 'file')}`;
    }
    if (
      !prev ||
      companion !== prev.companion ||
      repo !== prev.repo ||
      state.settings.palette !== prev.settings.palette
    ) {
      renderTable(state);
    }
  };
  store.subscribe((state, prev) => sync(state, prev));

  // The compared tree is on show once it has grown in, while the timeline (which hides it) is shut.
  view.onFrame(({ growth }) => {
    const { companion, timeline } = store.get();
    if (growth < 1 || !companion || timeline !== null) return;
    const shown = nameOf(companion.info.ref);
    if (root.dataset.ready !== shown) root.dataset.ready = shown;
  });

  function open() {
    const { repo, compare } = store.get();
    if (!repo || compare) return;
    store.dispatch({ type: 'compare', ref: defaultPartner(repo.info.ref, readRecent()) });
  }
  function close(): boolean {
    if (store.get().compare === null) return false;
    store.dispatch({ type: 'compare', ref: null });
    return true;
  }

  openButton.addEventListener('click', () => (store.get().compare ? close() : open()));
  stop.addEventListener('click', () => {
    close();
    openButton.focus();
  });
  switchButton.addEventListener('click', () => {
    const { repo, compare } = store.get();
    if (!repo || !compare) return;
    store.dispatch({ type: 'compare', ref: plain(repo.info.ref) });
    app.load(compare);
  });

  sync(store.get(), null);
  return { open, close };
}
