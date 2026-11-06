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
import { paintWeather } from './header';

/** Rows each mode's comparison lists. */
const ROWS = 6;
/** Busiest files listed for each tree. */
const HOT_ROWS = 3;
/** Trees grown to compare, kept so changing back is instant. */
const KEEP = 3;

const nameOf = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`;
const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;
const tail = (path: string) => {
  const parts = path.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
};
/** A small seed in each tree's own soft color marks its row, its tag and its bars. */
const seed = (i: number) =>
  h('span', { class: 'cmp-seed', 'data-seed': String(i), 'aria-hidden': 'true' });

/** What the side by side's switch can set the trees against each other by. */
type Metric = 'files' | 'folders' | 'depth' | 'size';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'folders', label: 'Folders' },
  { id: 'depth', label: 'Depth' },
  { id: 'size', label: 'Size' },
];

const MODE_TITLE: Record<ColorBy, string> = {
  language: 'Languages',
  folder: 'Top-level folders',
  activity: 'Last changed',
  changes: 'How often files change',
  owner: 'Owners',
};

/**
 * Compare trees, as a grove: the repo on show and up to four more, each on its own island in the
 * same world, in a row that always reads in the card's order. While comparing, the repo card turns
 * into the grove's list: a head ("Side by side · 3 trees", Done), then one line per tree (its seed,
 * name, files, CI glyph and ×), then "Add another repo", which turns the search bar to adding
 * (header.ts) and goes quiet at MAX_COMPARED. A tag with the same seed hangs under each island.
 * Choosing a tree's line or its tag shows that tree alone, and the card offers "Back to all"
 * until another repo is grown. The side panel trades its single-tree panels for one line per tree:
 * a bar for files, folders, depth or size, then a bar per tree for whatever Color by shows. Color
 * by colors every tree, each from its own history where the mode needs one; the sky, birds and
 * folder labels show for none. `state.compare` names the others, `state.companions` holds them
 * once grown.
 */
export function mountCompare(app: App): { open(): void; close(): boolean } {
  const { store, view } = app;
  const root = byId('compare');
  const panel = byId('compare-panel');
  const title = byId('title');
  const form = byId<HTMLFormElement>('repo-form');
  const openButton = byId<HTMLButtonElement>('compare-open');
  title.append(root);

  const count_ = h('span', {});
  const done = h('button', { type: 'button', class: 'cmp-done', id: 'compare-done' }, 'Done');
  const head = h(
    'div',
    { class: 'cmp-head' },
    h('p', { class: 'cmp-title' }, 'Side by side', count_),
    done,
  );
  const rows = h('div', { class: 'cmp-list-rows', role: 'list' });
  const add = h(
    'button',
    { type: 'button', class: 'cmp-add', id: 'compare-add' },
    h('span', { class: 'cmp-plus', 'aria-hidden': 'true' }, '+'),
    h('span', {}, 'Compare with another repo'),
  );
  const backSeeds = h('span', { class: 'cmp-seeds', 'aria-hidden': 'true' });
  const backLabel = h('span', {});
  const back = h(
    'button',
    { type: 'button', class: 'cmp-add cmp-back', id: 'compare-back' },
    h('span', { class: 'cmp-plus', 'aria-hidden': 'true' }, icon(...ICONS.chevron)),
    backLabel,
    backSeeds,
  );
  back.hidden = true;
  root.append(head, rows, add, back);

  // Name tags under the islands, one per tree; each shows its tree alone.
  const tagLayer = byId('island-tags');
  const tags = Array.from({ length: MAX_COMPARED }, (_, i) => {
    const name = h('span', {});
    const el = h(
      'button',
      { type: 'button', class: 'island-tag', 'data-seed': String(i), tabindex: '-1' },
      seed(i),
      name,
    );
    el.hidden = true;
    el.addEventListener('click', () => focus(i));
    tagLayer.append(el);
    return { el, name, i };
  });

  /**
   * The grove as it stood before one tree was chosen to show alone, so the card can bring it
   * back; dropped once a comparison starts again or a repo outside it is on show.
   */
  let grove: { main: RepoRef; compare: RepoRef[] } | null = null;
  /** Shows tree i of the grove (0 is the one on show) alone. */
  function focus(i: number) {
    const { repo, compare } = store.get();
    if (!repo || !compare.length) return;
    const main = plain(repo.info.ref);
    const target = i === 0 ? main : compare[i - 1];
    if (!target) return;
    const was = { main, compare: [...compare] };
    store.dispatch({ type: 'compare', refs: [] });
    grove = was;
    if (i > 0) app.load(target);
    else render(store.get());
  }
  function regroup() {
    const was = grove;
    if (!was) return;
    grove = null;
    const { repo } = store.get();
    store.dispatch({ type: 'compare', refs: was.compare });
    if (!repo || !sameRef(plain(repo.info.ref), was.main)) app.load(was.main);
  }
  back.addEventListener('click', regroup);
  done.addEventListener('click', () => close());

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
  /** Takes the repo on show out: the next takes its place, and the rest keep theirs. */
  const removeMain = () => {
    const { compare } = store.get();
    const [next, ...rest] = compare;
    if (!next) return;
    store.dispatch({ type: 'compare', refs: rest });
    app.load(next);
  };

  /**
   * One line per tree: its seed and name (which show it alone), its files, its CI as a glyph
   * (the chip's words stay in its tooltip and label), and × to take it out.
   */
  const rowOf = (state: AppState, ref: RepoRef, i: number) => {
    const main = i === 0 ? state.repo : null;
    const grown = main ?? state.companions.find((c) => sameRef(plain(c.info.ref), ref)) ?? null;
    const key = keyOf(ref);
    const chip = h('a', { class: 'weather', target: '_blank', rel: 'noopener' });
    chip.hidden = true;
    paintWeather(chip, state, grown);
    chip.addEventListener('click', (event) => {
      if (chip.dataset.sky !== 'unknown' || !grown) return;
      event.preventDefault();
      if (main) app.refreshRuns();
      else void readRuns(grown, true);
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
    x.addEventListener('click', () => (main ? removeMain() : remove(ref)));
    const pick = h(
      'button',
      {
        type: 'button',
        class: 'cmp-pick',
        title: `Show only ${nameOf(ref)}`,
        'aria-label': `Show only ${nameOf(ref)}`,
        disabled: !grown,
      },
      seed(i),
      h(
        'span',
        { class: 'cmp-name' },
        h('b', {}, ref.repo),
        h('span', { class: 'cmp-owner' }, ref.owner),
      ),
      h(
        'span',
        { class: 'cmp-files', role: grown ? null : 'status' },
        grown
          ? `${count(grown.index.folders.files[0] ?? 0)} files`
          : growing
            ? 'Growing…'
            : failed.get(key)!,
      ),
    );
    pick.addEventListener('click', () => focus(i));
    return h(
      'div',
      {
        class: 'cmp-row',
        role: 'listitem',
        'data-repo': nameOf(ref),
        'data-failed': !grown && !growing ? 'true' : null,
        'aria-busy': growing ? 'true' : null,
      },
      pick,
      chip,
      x,
    );
  };

  const render = (state: AppState) => {
    const on = state.compare.length > 0;
    const { repo } = state;
    fill(
      rows,
      ...(on && repo
        ? [plain(repo.info.ref), ...state.compare].map((ref, i) => rowOf(state, ref, i))
        : []),
    );
    count_.textContent = ` · ${state.compare.length + 1} trees`;
    const full = state.compare.length + 1 >= MAX_COMPARED;
    add.disabled = full || !repo;
    add.lastElementChild!.textContent = full
      ? `${MAX_COMPARED} repos is the most at once`
      : on
        ? 'Add another repo'
        : 'Compare with another repo';
    const regrouping = !on && grove !== null;
    back.hidden = !regrouping;
    add.hidden = regrouping;
    if (grove) {
      const all = [grove.main, ...grove.compare];
      backLabel.textContent = `Back to all ${all.length} trees`;
      const at = repo ? all.findIndex((r) => sameRef(r, plain(repo.info.ref))) : -1;
      fill(
        backSeeds,
        ...all.map((_, i) => {
          const s = seed(i);
          if (i !== at) s.dataset.off = '';
          return s;
        }),
      );
    }
  };
  add.addEventListener('click', () => form.dispatchEvent(new Event('repo-add')));
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

  /** Why a tree's history is not on the table, or null once it is. */
  const historyNote = (history: HistoryFacts<Loaded> | null | undefined, facts: Facts | null) => {
    if (facts) return null;
    if (!history || history.status === 'loading') return 'Reading its history…';
    return history.status === 'missing' ? 'No stored history' : 'History unavailable';
  };

  /** The side by side's switch: which number the first bars set the trees against each other by. */
  let metric: Metric = 'files';
  const swatch = (label: string, color: string) =>
    h('span', { class: 'cmp-key' }, h('i', { style: `background:${color}` }), h('span', {}, label));
  /** A bar split into each part's share, in its leaf color, with the parts in its label. */
  const stack = (parts: { label: string; color: string; n: number }[], total: number) => {
    const shown = parts.filter((p) => p.n > 0);
    return h(
      'span',
      {
        class: 'cmp-track cmp-stack',
        role: 'img',
        'aria-label': shown.map((p) => `${p.label} ${percent(p.n, total)}`).join(', ') || 'None',
      },
      ...shown.map((p) =>
        h('i', {
          style: `--w:${(p.n / Math.max(1, total)) * 100}%;--c:${p.color}`,
          title: `${p.label} ${percent(p.n, total)}`,
        }),
      ),
    );
  };

  const renderPanel = (state: AppState) => {
    const { repo } = state;
    const others = companionsOf(state);
    if (!repo || !others.length) return fill(panel);
    const trees = [repo, ...others];
    // Seeds follow compare's order, so a tree still growing leaves its seed unused.
    const seeds = [
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
    const who = (i: number) =>
      h(
        'th',
        { scope: 'row', title: nameOf(trees[i]!.info.ref) },
        h('span', { class: 'cmp-who' }, seed(seeds[i]!), h('span', {}, short(trees[i]!))),
      );
    /** A table with a row per tree: who, then its cells. */
    const table = (label: string, cells: (i: number) => (Node | string)[], cls = '') =>
      h(
        'table',
        { class: `cmp-table ${cls}`.trim(), 'aria-label': label },
        h(
          'tbody',
          {},
          ...trees.map((_, i) => h('tr', {}, who(i), ...cells(i).map((c) => h('td', {}, c)))),
        ),
      );

    const values: Record<Metric, number[]> = {
      files: stats.map((st) => st.files),
      folders: stats.map((st) => st.folders),
      depth: stats.map((st) => st.depth),
      size: stats.map((st) => st.bytes),
    };
    const shown: Record<Metric, (n: number) => string> = {
      files: count,
      folders: count,
      depth: (n) => plural(n, 'level'),
      size: bytes,
    };
    const most = Math.max(1, ...values[metric]);
    const switcher = h(
      'div',
      { class: 'cmp-switch', role: 'group', 'aria-label': 'Compare by' },
      ...METRICS.map(({ id, label }) => {
        const b = h(
          'button',
          { type: 'button', 'aria-pressed': String(id === metric), 'data-metric': id },
          label,
        );
        b.addEventListener('click', () => {
          metric = id;
          renderPanel(store.get());
          panel.querySelector<HTMLElement>(`[data-metric="${id}"]`)?.focus();
        });
        return b;
      }),
    );

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
    const real = (e: LegendEntry) => !/^\d+ more$/.test(e.label);
    const note = (text: string) => h('span', { class: 'cmp-note' }, text);

    let section: Node[];
    if (mode === 'language') {
      const colors = new Map(
        leafCategories(repo.tree, 'language', palette, null, rank).legend.map((e) => [
          e.label,
          e.color,
        ]),
      );
      const totals = stats.map((st) => st.langs.reduce((sum, l) => sum + l.files, 0));
      const langs = languageRows(stats, ROWS).map(({ lang, files }) => ({
        label: lang,
        color: colors.get(lang) ?? palette.rest,
        files,
      }));
      section = [
        table('Languages side by side', (i) => [
          stack(
            langs.map((l) => ({ label: l.label, color: l.color, n: l.files[i]! })),
            totals[i]!,
          ),
        ]),
        h('p', { class: 'cmp-keys' }, ...langs.map((l) => swatch(l.label, l.color))),
      ];
    } else if (mode === 'folder' || mode === 'owner') {
      // Each tree has its own folders and people, so each bar names its own biggest.
      const suffix = mode === 'folder' ? '/' : '';
      section = [
        table(
          `${MODE_TITLE[mode]} side by side`,
          (i) => {
            const why = mode === 'owner' ? notes[i] : null;
            if (why) return [note(why)];
            const legend = legendOf(trees[i]!, facts[i]!)
              .filter(real)
              .sort((x, y) => y.files - x.files);
            const total = Math.max(
              1,
              legend.reduce((sum, e) => sum + e.files, 0),
            );
            const parts = legend.map((e) => ({
              label: e.label + suffix,
              color: e.color,
              n: e.files,
            }));
            return [
              h(
                'span',
                { class: 'cmp-own' },
                stack(parts.slice(0, ROWS), total),
                h(
                  'span',
                  { class: 'cmp-top' },
                  ...parts
                    .slice(0, 2)
                    .map((p) => swatch(`${p.label} ${percent(p.n, total)}`, p.color)),
                ),
              ),
            ];
          },
          'cmp-tall',
        ),
      ];
    } else {
      const { rows, totals } = legendRows(
        trees.map((l, i) => (facts[i] ? legendOf(l, facts[i]!) : [])),
      );
      section = [
        table(`${MODE_TITLE[mode]} side by side`, (i) => [
          notes[i]
            ? note(notes[i]!)
            : stack(
                rows.map((r) => ({ label: r.label, color: r.color, n: r.files[i]! })),
                totals[i]!,
              ),
        ]),
        h('p', { class: 'cmp-keys' }, ...rows.map((r) => swatch(r.label, r.color))),
      ];
      if (mode === 'changes' && facts.some(Boolean)) {
        const hot = (i: number) => {
          const f = facts[i]!;
          const l = trees[i]!;
          const files = f ? busiest(f) : [];
          return h(
            'div',
            { class: 'cmp-list' },
            h('p', { class: 'cmp-who' }, seed(seeds[i]!), h('span', {}, short(l))),
            !f
              ? h('p', { class: 'more' }, 'No history yet')
              : files.length === 0
                ? h('p', { class: 'more' }, 'No changes recorded')
                : h(
                    'ol',
                    {},
                    ...files.map((file) =>
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
      switcher,
      table(
        'All trees side by side',
        (i) => [
          h(
            'span',
            { class: 'cmp-track', 'aria-hidden': 'true' },
            h('i', {
              style: `--w:${(values[metric][i]! / most) * 100}%`,
              'data-seed': String(seeds[i]),
            }),
          ),
          h('span', { class: 'cmp-num' }, shown[metric](values[metric][i]!)),
        ],
        'cmp-bars',
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
    // The grove to go back to lasts until a comparison starts again or another repo shows.
    if (on) grove = null;
    else if (grove && repo) {
      const all = [grove.main, ...grove.compare];
      if (!all.some((r) => sameRef(r, plain(repo.info.ref)))) grove = null;
    }
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
    tags.forEach((tag, i) => {
      tag.name.textContent = refs[i] ? short(refs[i]!) : '';
      tag.el.title = refs[i] ? `Show only ${nameOf(refs[i]!)}` : '';
    });
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
    const seeds = [
      0,
      ...others.map((c) => state.compare.findIndex((r) => sameRef(r, plain(c.info.ref))) + 1),
    ];
    const feet = [islands.main, ...islands.companions];
    tags.forEach((tag) => (tag.el.hidden = true));
    feet.forEach((foot, i) => {
      const tag = tags[seeds[i]!];
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
