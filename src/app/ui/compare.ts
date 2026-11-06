import { cachedRuns, cacheRuns } from '../../load/cache';
import { loadInWorker, type Loaded, type LoadSource } from '../../load/load-in-worker';
import { githubToken } from '../../repo/auth';
import { ciKey, fetchRuns, loadSampleRuns, type CiRun } from '../../repo/ci';
import type { RepoRef } from '../../repo/ref';
import type { Facts } from '../../timeline/facts';
import { PALETTES, type ColorBy, type LegendEntry } from '../../render/palette';
import { leafCategories } from '../../render/tree-view';
import type { App } from '../app';
import { languageRows, rankOf, sizeLine, treeStats } from '../compare';
import { byId, fill, h, icon, ICONS } from '../dom';
import { describeError } from '../errors';
import { bytes, count, percent, plural } from '../format';
import { SEED } from '../loader';
import { sampleFor } from '../samples';
import {
  companionFactsOf,
  companionsOf,
  factsOf,
  MAX_COMPARED,
  qualityOf,
  sameRef,
  type AppState,
  type HistoryFacts,
} from '../state';
import { paintWeather, repoMeta } from './header';

/** Rows each mode's comparison lists. */
const ROWS = 6;
/** Busiest files listed for each tree. */
const HOT_ROWS = 5;
/** Trees grown to compare, kept so changing back is instant. */
const KEEP = 3;

const nameOf = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`;
const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;
const tail = (path: string) => {
  const parts = path.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
};
const letter = (i: number) =>
  h(
    'span',
    { class: 'cmp-letter', 'data-side': 'abcde'[i] ?? 'e', 'aria-hidden': 'true' },
    'ABCDE'[i] ?? '?',
  );

const MODE_TITLE: Record<ColorBy, string> = {
  language: 'Languages',
  folder: 'Top-level folders',
  activity: 'Last changed',
  changes: 'How often files change',
  owner: 'Owners',
};

/** The letter each compared tree goes by, the repo on show first. */
const LETTERS = 'ABCDE';

/**
 * Compare trees: the repo on show (A) and up to four more (B–E), each on its own island in the
 * same world, in a row. The repo card gains a row per compared repo, alike: its letter, name, CI
 * chip, branch and counts, and × to take it away (A's × hands the panels to B). Under them,
 * "Compare with another repo" turns the search bar's Grow into Compare until it picks one or
 * loses focus (header.ts), and goes quiet at MAX_COMPARED. A letter tag hangs under each
 * island. The side panel trades its single-tree panels for all the trees side by side: the
 * overall numbers, then whatever Color by shows, for each. Color by colors every tree, each from
 * its own history where the mode needs one; the sky, birds and folder labels show for none.
 * `state.compare` names B–E, `state.companions` holds them once grown.
 */
export function mountCompare(app: App): { open(): void; close(): boolean } {
  const { store, view } = app;
  const root = byId('compare');
  const panel = byId('compare-panel');
  const title = byId('title');
  const form = byId<HTMLFormElement>('repo-form');
  const openButton = byId<HTMLButtonElement>('compare-open');

  // A's letter in its card, shown only while comparing, and A's own way out of the comparison.
  byId('repo-switch').append(letter(0));
  const dropMain = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn cmp-x',
      id: 'compare-drop-a',
      'aria-label': 'Remove A from the comparison',
    },
    icon(...ICONS.close),
  );
  // The compared repos' rows and the add row close A's card, as one card with it.
  title.append(dropMain, root);

  const rows = h('div', { class: 'cmp-list-rows' });
  const add = h(
    'button',
    { type: 'button', class: 'cmp-add', id: 'compare-add' },
    h('span', { class: 'cmp-plus', 'aria-hidden': 'true' }, '+'),
    h('span', {}, 'Compare with another repo'),
  );
  root.append(rows, add);

  // Name tags under the islands, one per letter.
  const tagLayer = byId('island-tags');
  const tags = [...LETTERS].map((L, i) => {
    const name = h('span', {});
    const el = h(
      'span',
      { class: 'island-tag', 'data-side': L.toLowerCase() },
      h('b', {}, L),
      name,
    );
    el.hidden = true;
    tagLayer.append(el);
    return { el, name, i };
  });

  const memory = new Map<string, Loaded>();
  /** Repos growing now, by name, and those that could not grow, with why. */
  const loading = new Map<string, AbortController>();
  const failed = new Map<string, string>();
  const keyOf = (ref: { owner: string; repo: string }) => nameOf(ref).toLowerCase();

  /** Grows a compared repo: the one on show as it is, else from memory, else in a worker. */
  async function grow(ref: RepoRef, fresh = false) {
    const state = store.get();
    const main = state.repo;
    if (main && sameRef(plain(main.info.ref), ref)) {
      return store.dispatch({ type: 'companion', companion: main });
    }
    const { hidden } = state.settings;
    const quality = qualityOf(state);
    const key = `${keyOf(ref)}|${hidden.join('/')}|${quality}`;
    const kept = fresh ? undefined : memory.get(key);
    if (kept) return store.dispatch({ type: 'companion', companion: kept });
    if (!fresh && loading.has(keyOf(ref))) return;
    loading.get(keyOf(ref))?.abort();
    const abort = new AbortController();
    loading.set(keyOf(ref), abort);
    failed.delete(keyOf(ref));
    render(store.get());
    const token = githubToken(state.settings.token);
    const sample = fresh ? undefined : sampleFor(ref);
    const source: LoadSource = sample
      ? { kind: 'sample', id: sample.id, base: new URL('./', location.href).href }
      : { kind: 'github', ref, token, fresh };
    try {
      const result = await loadInWorker(
        { source, filters: { hidden }, params: { seed: SEED, quality } },
        { step: () => {} },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      if ('kind' in result) {
        failed.set(keyOf(ref), describeError(result, ref, { hasToken: !!token }).title);
        return;
      }
      memory.set(key, result);
      if (memory.size > KEEP) memory.delete(memory.keys().next().value!);
      store.dispatch({ type: 'companion', companion: result });
      void readRuns(result, false);
    } catch (reason) {
      if (abort.signal.aborted) return;
      console.error(reason);
      failed.set(keyOf(ref), 'Couldn’t grow it');
    } finally {
      if (loading.get(keyOf(ref)) === abort) {
        loading.delete(keyOf(ref));
        render(store.get());
      }
    }
  }

  /** A compared repo's recent Actions runs, for its CI chip, as the loader reads A's. */
  const reading = new Set<string>();
  async function readRuns(repo: Loaded, fresh: boolean) {
    const state = store.get();
    if (!state.settings.weather) return;
    const { ref, branch } = repo.info;
    const key = ciKey(ref, branch);
    if (reading.has(key) || (!fresh && state.ci[key] !== undefined)) return;
    reading.add(key);
    try {
      let runs: CiRun[] | null | undefined = fresh ? undefined : await cachedRuns(key);
      if (runs === undefined) {
        runs = await fetchRuns(ref, branch, githubToken(state.settings.token), undefined);
        if (runs) void cacheRuns(key, runs);
        else {
          const sample = sampleFor({ ...ref, ref: branch });
          if (sample)
            runs = await loadSampleRuns(sample.id, branch, new URL('./', location.href).href);
        }
      }
      store.dispatch({ type: 'ci', key, runs: runs ?? null });
    } catch {
      // The chip stays hidden.
    } finally {
      reading.delete(key);
    }
  }

  const remove = (ref: RepoRef) => {
    const { compare } = store.get();
    loading.get(keyOf(ref))?.abort();
    loading.delete(keyOf(ref));
    failed.delete(keyOf(ref));
    store.dispatch({ type: 'compare', refs: compare.filter((r) => !sameRef(r, ref)) });
  };

  /** One row per compared repo, like A's card: letter, name, CI, branch and counts, and ×. */
  const rowOf = (state: AppState, ref: RepoRef, i: number) => {
    const grown = state.companions.find((c) => sameRef(plain(c.info.ref), ref)) ?? null;
    const key = keyOf(ref);
    const chip = h('a', { class: 'weather', target: '_blank', rel: 'noopener' });
    chip.hidden = true;
    paintWeather(chip, state, grown);
    chip.addEventListener('click', (event) => {
      if (chip.dataset.sky !== 'unknown' || !grown) return;
      event.preventDefault();
      void readRuns(grown, true);
    });
    const growing = !grown && !failed.has(key);
    const x = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn cmp-x',
        'aria-label': `Remove ${nameOf(ref)} from the comparison`,
      },
      icon(...ICONS.close),
    );
    x.addEventListener('click', () => remove(ref));
    return h(
      'div',
      {
        class: 'cmp-row',
        'data-repo': nameOf(ref),
        'aria-busy': growing ? 'true' : null,
      },
      letter(i),
      h(
        'p',
        { class: 'name', role: 'heading', 'aria-level': '2' },
        h(
          'a',
          { href: `https://github.com/${nameOf(ref)}`, target: '_blank', rel: 'noopener' },
          nameOf(ref),
        ),
      ),
      chip,
      x,
      grown
        ? h('p', { class: 'meta' }, ...repoMeta(grown, () => void grow(ref, true)))
        : h(
            'p',
            { class: 'cmp-status', role: 'status' },
            growing ? `Growing ${nameOf(ref)}…` : failed.get(key)!,
          ),
    );
  };

  const render = (state: AppState) => {
    const on = state.compare.length > 0;
    fill(rows, ...state.compare.map((ref, i) => rowOf(state, ref, i + 1)));
    const full = state.compare.length + 1 >= MAX_COMPARED;
    add.disabled = full || !state.repo;
    add.lastElementChild!.textContent = full
      ? `${MAX_COMPARED} repos is the most at once`
      : on
        ? 'Add another repo'
        : 'Compare with another repo';
  };
  add.addEventListener('click', () => form.dispatchEvent(new Event('repo-add')));
  dropMain.addEventListener('click', () => {
    // B takes A's place, and the rest keep theirs.
    const { compare } = store.get();
    const [next, ...rest] = compare;
    if (!next) return;
    store.dispatch({ type: 'compare', refs: rest });
    app.load(next);
  });
  /** The rows a mode's legend gives each tree, matched by label, in the first legend's order. */
  const legendRows = (legends: LegendEntry[][]) => {
    const totals = legends.map((l) =>
      Math.max(
        1,
        l.reduce((sum, e) => sum + e.files, 0),
      ),
    );
    const labels = new Map<string, { color: string; files: number[] }>();
    legends.forEach((list, i) => {
      for (const e of list) {
        if (/^\d+ more$/.test(e.label)) continue;
        const row = labels.get(e.label) ?? { color: e.color, files: legends.map(() => 0) };
        row.files[i]! += e.files;
        labels.set(e.label, row);
      }
    });
    return { rows: [...labels].map(([label, r]) => ({ label, ...r })), totals };
  };

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
  const row = (head: Node | string, cells: (Node | string)[]) =>
    h('tr', {}, h('th', { scope: 'row' }, head), ...cells.map((c) => h('td', {}, c)));
  const swatch = (label: string, color: string) =>
    h(
      'span',
      { class: 'cmp-lang' },
      h('i', { style: `background:${color}` }),
      h('span', {}, label),
    );

  /** Why a tree's history is not on the table, or null once it is. */
  const historyNote = (history: HistoryFacts<Loaded> | null | undefined, facts: Facts | null) => {
    if (facts) return null;
    if (!history || history.status === 'loading') return 'Reading its history…';
    return history.status === 'missing' ? 'No stored history' : 'History unavailable';
  };

  const renderPanel = (state: AppState) => {
    const { repo } = state;
    const others = companionsOf(state);
    if (!repo || !others.length) return fill(panel);
    const trees = [repo, ...others];
    // Letters follow compare's order, so a tree still growing leaves its letter unused.
    const letters = [
      0,
      ...others.map((c) => state.compare.findIndex((r) => sameRef(r, plain(c.info.ref))) + 1),
    ];
    const stats = trees.map(treeStats);
    const names = trees.map((l) => l.info.ref.repo.toLowerCase());
    const short = (l: Loaded) =>
      names.filter((n) => n === l.info.ref.repo.toLowerCase()).length > 1
        ? nameOf(l.info.ref)
        : l.info.ref.repo;
    panel.dataset.trees = String(trees.length);
    const head = (l: Loaded, i: number) =>
      h(
        'th',
        { scope: 'col', title: nameOf(l.info.ref) },
        h(
          'span',
          { class: 'cmp-col' },
          letter(letters[i]!),
          h('span', { class: 'cmp-colname' }, short(l)),
        ),
      );
    const thead = () => h('thead', {}, h('tr', {}, h('td', {}), ...trees.map(head)));
    const table = (label: string, ...rows: Node[]) =>
      h('table', { class: 'cmp-table', 'aria-label': label }, thead(), h('tbody', {}, ...rows));

    const palette = PALETTES[state.settings.palette];
    const mode = state.settings.colorBy;
    const rank = rankOf(state);
    const facts = [factsOf(state), ...others.map((c) => companionFactsOf(state, c))];
    const histories = [
      state.history,
      ...others.map((c) => state.companionHistory.find((x) => x.repo === c)),
    ];
    const notes = trees.map((_, i) => historyNote(histories[i], facts[i]!));
    const legendOf = (l: Loaded, f: Facts | null) =>
      leafCategories(l.tree, mode, palette, f, mode === 'folder' ? null : rank).legend;
    const listHead = (i: number) =>
      h('p', { class: 'cmp-list-head' }, letter(letters[i]!), h('span', {}, short(trees[i]!)));

    let section: Node[];
    if (mode === 'language') {
      const colors = new Map(
        leafCategories(repo.tree, 'language', palette, null, rank).legend.map((e) => [
          e.label,
          e.color,
        ]),
      );
      const totals = stats.map((st) => st.langs.reduce((sum, l) => sum + l.files, 0));
      section = [
        table(
          'Languages side by side',
          ...languageRows(stats, ROWS).map(({ lang, files }) => {
            const color = colors.get(lang) ?? palette.rest;
            return row(
              swatch(lang, color),
              files.map((n, i) => share(n, totals[i]!, color)),
            );
          }),
        ),
      ];
    } else if (mode === 'folder' || mode === 'owner') {
      // Each tree has its own folders and people, so each lists its biggest.
      const list = (i: number) => {
        const note = mode === 'owner' ? notes[i] : null;
        const legend = note
          ? []
          : legendOf(trees[i]!, facts[i]!).filter((e) => !/^\d+ more$/.test(e.label));
        const total = Math.max(
          1,
          legend.reduce((sum, e) => sum + e.files, 0),
        );
        const suffix = mode === 'folder' ? '/' : '';
        return h(
          'div',
          { class: 'cmp-list' },
          listHead(i),
          note
            ? h('p', { class: 'more' }, note)
            : h(
                'ol',
                {},
                ...[...legend]
                  .sort((x, y) => y.files - x.files)
                  .slice(0, ROWS)
                  .map((e) =>
                    h(
                      'li',
                      { title: e.label + suffix },
                      swatch(`${e.label}${suffix}`, e.color),
                      h('span', { class: 'cmp-num' }, percent(e.files, total)),
                    ),
                  ),
              ),
        );
      };
      section = [h('div', { class: 'cmp-lists' }, ...trees.map((_, i) => list(i)))];
    } else {
      const { rows, totals } = legendRows(
        trees.map((l, i) => (facts[i] ? legendOf(l, facts[i]!) : [])),
      );
      section = [
        table(
          `${MODE_TITLE[mode]} side by side`,
          ...(notes.some(Boolean)
            ? [
                row(
                  '',
                  notes.map((n) => n ?? ''),
                ),
              ]
            : []),
          ...rows.map((r) =>
            row(
              swatch(r.label, r.color),
              r.files.map((n, i) => (facts[i] ? share(n, totals[i]!, r.color) : '')),
            ),
          ),
        ),
      ];
      if (mode === 'changes' && facts.some(Boolean)) {
        const hot = (i: number) => {
          const f = facts[i]!;
          const l = trees[i]!;
          return h(
            'div',
            { class: 'cmp-list' },
            listHead(i),
            !f
              ? h('p', { class: 'more' }, 'No history yet')
              : busiest(f).length === 0
                ? h('p', { class: 'more' }, 'No changes recorded')
                : h(
                    'ol',
                    {},
                    ...busiest(f).map((file) =>
                      h(
                        'li',
                        { title: l.index.files.paths[file]! },
                        h('span', { class: 'fn' }, tail(l.index.files.paths[file]!)),
                        h('span', { class: 'cmp-num' }, count(f.fileChurn[file]!)),
                      ),
                    ),
                  ),
          );
        };
        section.push(
          h('h3', { class: 'h' }, 'Busiest files'),
          h('div', { class: 'cmp-lists' }, ...trees.map((_, i) => hot(i))),
        );
      }
    }

    fill(
      panel,
      h('h2', { class: 'h' }, 'Side by side'),
      h(
        'p',
        { class: 'cmp-line', id: 'compare-line' },
        sizeLine(trees.map((l, i) => ({ name: short(l), files: stats[i]!.files }))),
      ),
      table(
        'All trees side by side',
        row(
          'Files',
          stats.map((st) => count(st.files)),
        ),
        row(
          'Folders',
          stats.map((st) => count(st.folders)),
        ),
        row(
          'Deepest',
          stats.map((st) => plural(st.depth, 'level')),
        ),
        row(
          'Size',
          stats.map((st) => bytes(st.bytes)),
        ),
        row(
          'Languages',
          stats.map((st) => count(st.langs.length)),
        ),
      ),
      h('h2', { class: 'h' }, MODE_TITLE[mode]),
      ...section,
    );
  };

  const sync = (state: AppState, prev: AppState | null) => {
    const { compare, repo } = state;
    const on = compare.length > 0;
    root.hidden = !repo;
    document.body.toggleAttribute('data-compare', on);
    openButton.setAttribute('aria-pressed', String(on));
    openButton.setAttribute('aria-disabled', String(!repo));
    dropMain.hidden = !on;
    const others = companionsOf(state);
    panel.hidden = !(on && others.length && repo);
    for (const key of [...loading.keys()]) {
      if (!compare.some((r) => keyOf(r) === key)) {
        loading.get(key)!.abort();
        loading.delete(key);
      }
    }
    for (const key of [...failed.keys()]) {
      if (!compare.some((r) => keyOf(r) === key)) failed.delete(key);
    }
    const moved = !prev || prev.compare !== compare || repo !== prev.repo;
    if (moved) {
      for (const ref of compare) {
        const grown = state.companions.some((c) => sameRef(plain(c.info.ref), ref));
        if (!grown && !failed.has(keyOf(ref))) void grow(ref);
      }
    }
    if (!others.length) delete root.dataset.ready;
    render(state);
    if (
      !prev ||
      state.companions !== prev.companions ||
      compare !== prev.compare ||
      repo !== prev.repo ||
      state.settings.palette !== prev.settings.palette ||
      state.settings.colorBy !== prev.settings.colorBy ||
      state.history !== prev.history ||
      state.companionHistory !== prev.companionHistory
    ) {
      renderPanel(state);
    }
    // The card carries the full names, so a tag needs only the repo's own, unless two share it.
    const refs = repo ? [plain(repo.info.ref), ...compare] : [...compare];
    const short = (ref: RepoRef) =>
      refs.filter((r) => r.repo.toLowerCase() === ref.repo.toLowerCase()).length > 1
        ? nameOf(ref)
        : ref.repo;
    tags.forEach((tag, i) => (tag.name.textContent = refs[i] ? short(refs[i]!) : ''));
  };
  store.subscribe((state, prev) => sync(state, prev));

  // The compared trees are on show once grown in, while the timeline (which hides them) is shut;
  // the name tags follow the islands.
  view.onFrame(({ growth, islands }) => {
    const state = store.get();
    const others = companionsOf(state);
    const on = others.length > 0 && state.timeline === null && growth > 0.2;
    tagLayer.hidden = !on;
    if (!on) return;
    const letters = [
      0,
      ...others.map((c) => state.compare.findIndex((r) => sameRef(r, plain(c.info.ref))) + 1),
    ];
    const feet = [islands.main, ...islands.companions];
    tags.forEach((tag) => (tag.el.hidden = true));
    feet.forEach((foot, i) => {
      const tag = tags[letters[i]!];
      if (!tag || !foot) return;
      tag.el.hidden = !foot.visible;
      if (foot.visible) tag.el.style.transform = `translate(${foot.x}px, ${foot.y}px)`;
    });
    if (growth < 1) return;
    const shown = others.map((c) => nameOf(c.info.ref)).join(' ');
    if (root.dataset.ready !== shown) root.dataset.ready = shown;
  });

  /** Starts adding a repo to compare: the search bar's Grow turns to Compare. */
  function open() {
    if (!store.get().repo) return;
    form.dispatchEvent(new Event('repo-add'));
  }
  function close(): boolean {
    if (!store.get().compare.length) return false;
    store.dispatch({ type: 'compare', refs: [] });
    return true;
  }

  openButton.addEventListener('click', () => (store.get().compare.length ? close() : open()));

  sync(store.get(), null);
  return { open, close };
}

/**
 * A tree's most changed files, busiest first: by churn alone, since the hotspots that glow on
 * the tree leave a small repo with none to list.
 */
function busiest(facts: Facts): number[] {
  return Array.from(facts.fileChurn.keys())
    .filter((i) => facts.fileChurn[i]! > 0)
    .sort((a, b) => facts.fileChurn[b]! - facts.fileChurn[a]! || a - b)
    .slice(0, HOT_ROWS);
}
