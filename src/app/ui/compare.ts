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

const leafFiles = (s: { langs: { files: number }[] }) =>
  s.langs.reduce((sum, l) => sum + l.files, 0);
const nameOf = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`;
const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;

type Side = 'a' | 'b';
const LETTER: Record<Side, string> = { a: 'A', b: 'B' };
const badge = (side: Side) => h('span', { class: 'cmp-badge', 'data-side': side }, LETTER[side]);

/**
 * Compare trees: two repos, A and B, each on its own island in the same world, A on the left in
 * the default view. The title card turns into a compare card with one identical row per tree:
 * its letter, name and size, picked to show its details in the panels, and Change to put another
 * repo in its place. A name tag with the same letter hangs under each island, and the side panel
 * sets both side by side in a table. Color by applies to both, and languages rank across the two
 * so each wears one color on both; CI weather, birds and folder labels show for neither, so
 * nothing on screen tells only one tree's story.
 *
 * The tree whose details show is the repo on show (`state.repo`); the other is `state.compare`,
 * grown into `state.companion`. Picking the other row trades the two, and each keeps its letter
 * and its island (`state.compareFirst` says whether the compared one is A).
 */
export function mountCompare(app: App): { open(): void; close(): boolean } {
  const { store, view } = app;
  const root = byId('compare');
  const title = byId('title');
  const panel = byId('compare-panel');
  const openButton = byId<HTMLButtonElement>('compare-open');

  const exit = h(
    'button',
    { type: 'button', class: 'cmp-exit', id: 'compare-exit', 'aria-label': 'Stop comparing' },
    icon(...ICONS.close),
    h('span', {}, 'Exit'),
  );

  /** One row per tree, built alike: the radio that shows its details, and Change. */
  const makeRow = (side: Side) => {
    const radio = h('input', { type: 'radio', name: 'cmp-shown' });
    const name = h('strong', { class: 'cmp-name' });
    const sub = h('span', { class: 'cmp-sub' });
    const state = h('span', { class: 'cmp-state', 'aria-hidden': 'true' });
    const change = h(
      'button',
      {
        type: 'button',
        class: 'cmp-change',
        'aria-expanded': 'false',
        'aria-controls': 'compare-form',
      },
      'Change',
    );
    const el = h(
      'div',
      { class: 'cmp-tree', 'data-side': side },
      h(
        'label',
        { class: 'cmp-pick' },
        radio,
        badge(side),
        h('span', { class: 'cmp-id' }, name, sub),
        state,
      ),
      change,
    );
    radio.addEventListener('change', () => radio.checked && show(side));
    change.addEventListener('click', () => toggleForm(side));
    return { side, el, radio, name, sub, state, change };
  };
  const rows = { a: makeRow('a'), b: makeRow('b') };

  const line = h('p', { class: 'cmp-line', id: 'compare-line' });
  const input = h('input', {
    type: 'text',
    id: 'compare-input',
    placeholder: 'owner/repo or GitHub URL',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
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
  /** The row the field replaces, while it is open. */
  let changing: Side | null = null;

  root.append(
    h('div', { class: 'cmp-head' }, h('h2', { class: 'cmp-title' }, 'Comparing two trees'), exit),
    h(
      'div',
      { class: 'cmp-trees', role: 'radiogroup', 'aria-label': 'Details shown for' },
      rows.a.el,
      rows.b.el,
    ),
    form,
    line,
  );

  const table = h('table', { class: 'cmp-table', 'aria-label': 'Both trees side by side' });
  const shownNote = h('p', { class: 'cmp-note' });
  panel.append(h('h2', { class: 'h' }, 'Side by side'), table, shownNote);

  // Name tags under the islands, matching the rows; a tap shows that tree's details.
  const tagLayer = byId('island-tags');
  const makeTag = (side: Side) => {
    const name = h('span', { class: 'tag-name' });
    const el = h(
      'button',
      { type: 'button', class: 'island-tag', 'data-side': side, tabindex: '-1' },
      badge(side),
      name,
    );
    el.hidden = true;
    el.addEventListener('click', () => show(side));
    tagLayer.append(el);
    return { el, name };
  };
  const tags = { a: makeTag('a'), b: makeTag('b') };

  const memory = new Map<string, Loaded>();
  let abort: AbortController | null = null;
  let loading: RepoRef | null = null;
  let failed: RepoRef | null = null;
  /** Why `failed` did not grow. */
  let failure = '';

  /** The repo on show, or the one loading in its place. */
  const mainRef = (state: AppState): RepoRef | null => {
    const { load, repo } = state;
    if (load.phase === 'loading' || load.phase === 'error') return plain(load.ref);
    return repo ? plain(repo.info.ref) : null;
  };
  /** Which side the repo on show stands on. */
  const mainSide = (state: AppState): Side => (state.compareFirst ? 'b' : 'a');
  const other = (side: Side): Side => (side === 'a' ? 'b' : 'a');

  /** Hands the panels to that side's tree; the trees keep their sides and letters. */
  function show(side: Side) {
    const state = store.get();
    const { repo, compare } = state;
    if (!repo || !compare || side === mainSide(state)) return;
    store.dispatch({ type: 'compare', ref: plain(repo.info.ref), first: !state.compareFirst });
    app.load(compare);
  }

  const toggleForm = (side: Side) => showForm(changing === side ? null : side);
  const showForm = (side: Side | null) => {
    changing = side;
    form.hidden = side === null;
    for (const row of Object.values(rows)) {
      row.change.setAttribute('aria-expanded', String(row.side === side));
    }
    if (side) {
      rows[side].el.after(form);
      input.setAttribute('aria-label', `Repository to put in place of ${LETTER[side]}`);
      error.textContent = '';
      fillChips();
      input.focus();
    }
  };

  const fillChips = () => {
    const state = store.get();
    const shown = [mainRef(state), state.compare].filter(Boolean) as RepoRef[];
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

  /** Puts a repo in place of the side the field is open for. */
  const pick = (ref: RepoRef) => {
    const side = changing;
    error.textContent = '';
    input.value = '';
    showForm(null);
    if (!side) return;
    const state = store.get();
    if (side === mainSide(state)) app.load(plain(ref));
    else store.dispatch({ type: 'compare', ref: plain(ref) });
    rows[side].radio.focus();
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const ref = parseRepoRef(input.value);
    if ('kind' in ref) {
      error.textContent = 'Enter owner/repo or a GitHub URL';
      return;
    }
    const state = store.get();
    const keep = changing === mainSide(state) ? state.compare : mainRef(state);
    if (keep && sameRef(plain(ref), plain(keep))) {
      error.textContent = 'That one is already the other tree';
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
    render(store.get());
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
        failure = describeError(result, ref, { hasToken: !!token }).title;
        return;
      }
      memory.set(key, result);
      if (memory.size > KEEP) memory.delete(memory.keys().next().value!);
      store.dispatch({ type: 'companion', companion: result });
    } catch (reason) {
      if (signal.aborted) return;
      console.error(reason);
      failed = ref;
      failure = 'Couldn’t grow it';
    } finally {
      if (abort?.signal === signal) {
        abort = null;
        loading = null;
        render(store.get());
      }
    }
  }

  /** Each side's name, and its size once grown or what is keeping it. */
  const describe = (state: AppState) => {
    const { repo, compare, companion, load } = state;
    const main = mainRef(state)!;
    const mainLoaded = repo && sameRef(plain(repo.info.ref), main) && load.phase === 'idle';
    const size = (l: Loaded) => {
      const s = treeStats(l);
      return `${plural(s.files, 'file')} · ${plural(s.folders, 'folder')}`;
    };
    const mainSub =
      load.phase === 'error' ? 'Couldn’t grow it' : mainLoaded ? size(repo!) : 'Growing…';
    const compareSub = companion
      ? size(companion)
      : failed && sameRef(failed, compare)
        ? failure
        : 'Growing…';
    const mine = { ref: main, sub: mainSub, busy: !mainLoaded && load.phase !== 'error' };
    const theirs = { ref: compare!, sub: compareSub, busy: !companion && !failed };
    return state.compareFirst ? { a: theirs, b: mine } : { a: mine, b: theirs };
  };

  /** Short names, unless both repos share one. */
  const labels = (a: RepoRef, b: RepoRef) => {
    const same = a.repo.toLowerCase() === b.repo.toLowerCase();
    return { a: same ? nameOf(a) : a.repo, b: same ? nameOf(b) : b.repo };
  };

  const render = (state: AppState) => {
    if (!state.compare || !mainRef(state)) return;
    const sides = describe(state);
    const shown = mainSide(state);
    for (const side of ['a', 'b'] as const) {
      const row = rows[side];
      const { ref, sub, busy } = sides[side];
      row.name.textContent = nameOf(ref);
      row.sub.textContent = sub;
      row.el.toggleAttribute('data-shown', side === shown);
      row.state.textContent = side === shown ? 'In panels' : 'Show in panels';
      row.el.toggleAttribute('aria-busy', busy);
      row.radio.checked = side === shown;
      row.radio.setAttribute('aria-label', `${LETTER[side]}: ${nameOf(ref)}`);
      row.change.setAttribute('aria-label', `Change ${LETTER[side]}, ${nameOf(ref)}`);
      tags[side].name.textContent = nameOf(ref);
      tags[side].el.toggleAttribute('data-shown', side === shown);
      tags[side].el.title = side === shown ? 'Details in the panels' : 'Show its details';
    }
    root.toggleAttribute('aria-busy', sides.a.busy || sides.b.busy);
  };

  const renderTable = (state: AppState) => {
    const { repo, companion } = state;
    if (!repo || !companion) {
      line.textContent = '';
      return fill(table);
    }
    const [mine, theirs] = [
      { loaded: repo, stats: treeStats(repo) },
      { loaded: companion, stats: treeStats(companion) },
    ];
    const [a, b] = state.compareFirst ? [theirs, mine] : [mine, theirs];
    const short = labels(plain(a.loaded.info.ref), plain(b.loaded.info.ref));
    line.textContent = sizeLine(
      { name: short.a, files: a.stats.files },
      { name: short.b, files: b.stats.files },
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
    const head = (side: Side) =>
      h(
        'th',
        { scope: 'col', 'aria-label': `${LETTER[side]}, ${short[side]}` },
        h('span', { class: 'cmp-col' }, badge(side), h('span', {}, short[side])),
      );
    const [sa, sb] = [a.stats, b.stats];
    fill(
      table,
      h('thead', {}, h('tr', {}, h('td', {}), head('a'), head('b'))),
      h(
        'tbody',
        {},
        row('Files', count(sa.files), count(sb.files)),
        row('Folders', count(sa.folders), count(sb.folders)),
        row('Deepest', plural(sa.depth, 'level'), plural(sb.depth, 'level')),
        row('Size', bytes(sa.bytes), bytes(sb.bytes)),
        // Shares of the files the leaves count by language, as the legend's are.
        ...languageRows(sa, sb, LANG_ROWS).map(({ lang, a: x, b: y }) => {
          const color = colors.get(lang) ?? palette.rest;
          return row(
            h('span', { class: 'cmp-lang' }, h('i', { style: `background:${color}` }), lang),
            share(x, leafFiles(sa), color),
            share(y, leafFiles(sb), color),
          );
        }),
      ),
    );
    const shown = mainSide(state);
    fill(
      shownNote,
      'Panels below show',
      badge(shown),
      h('strong', {}, short[shown]),
      h(
        'button',
        { type: 'button', class: 'cmp-note-switch', onclick: () => show(other(shown)) },
        'Show ',
        badge(other(shown)),
        short[other(shown)],
      ),
    );
  };

  const sync = (state: AppState, prev: AppState | null) => {
    const { compare, companion, repo } = state;
    const on = compare !== null;
    root.hidden = !on;
    title.toggleAttribute('data-compare', on);
    document.body.toggleAttribute('data-compare', on);
    openButton.setAttribute('aria-pressed', String(on));
    openButton.setAttribute('aria-disabled', String(!repo));
    panel.hidden = !(on && companion && repo);
    if (!on) {
      abort?.abort();
      abort = loading = failed = null;
      showForm(null);
      delete root.dataset.ready;
      tagLayer.hidden = true;
      return;
    }
    const moved = !prev || !sameRef(compare, prev.compare) || repo !== prev.repo;
    if (moved && !sameRef(compare, failed) && !companion) void grow(compare);
    if (!companion) delete root.dataset.ready;
    render(state);
    if (
      !prev ||
      companion !== prev.companion ||
      repo !== prev.repo ||
      state.compareFirst !== prev.compareFirst ||
      state.settings.palette !== prev.settings.palette
    ) {
      renderTable(state);
    }
  };
  store.subscribe((state, prev) => sync(state, prev));

  // The compared tree is on show once it has grown in, while the timeline (which hides it) is
  // shut; the name tags follow the islands.
  view.onFrame(({ growth, islands }) => {
    const state = store.get();
    const { companion, timeline } = state;
    const on = !!companion && timeline === null && growth > 0.2;
    tagLayer.hidden = !on;
    if (!on) return;
    const feet = state.compareFirst
      ? { a: islands.companion, b: islands.main }
      : { a: islands.main, b: islands.companion };
    for (const side of ['a', 'b'] as const) {
      const foot = feet[side];
      const tag = tags[side].el;
      tag.hidden = !foot?.visible;
      if (foot?.visible) tag.style.transform = `translate(${foot.x}px, ${foot.y}px)`;
    }
    if (growth < 1) return;
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
  exit.addEventListener('click', () => {
    close();
    openButton.focus();
  });

  sync(store.get(), null);
  return { open, close };
}
