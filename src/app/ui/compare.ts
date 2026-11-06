import { cachedRuns, cacheRuns } from '../../load/cache';
import { loadInWorker, type Loaded, type LoadSource } from '../../load/load-in-worker';
import { githubToken } from '../../repo/auth';
import { ciKey, fetchRuns, loadSampleRuns, type CiRun } from '../../repo/ci';
import { parseRepoRef, type RepoRef } from '../../repo/ref';
import type { Facts } from '../../timeline/facts';
import { PALETTES, type ColorBy, type LegendEntry } from '../../render/palette';
import { leafCategories } from '../../render/tree-view';
import type { App } from '../app';
import { defaultPartner, languageRows, rankOf, sizeLine, treeStats } from '../compare';
import { byId, fill, h, icon, ICONS } from '../dom';
import { describeError } from '../errors';
import { bytes, compact, count, percent, plural } from '../format';
import { SEED } from '../loader';
import { readRecent } from '../recent';
import { sampleFor, SAMPLES } from '../samples';
import {
  companionFactsOf,
  factsOf,
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
const GITHUB_MARK =
  'M9 19c-4 1.5-4-2-6-2.5m12 4.5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21';

const nameOf = (ref: { owner: string; repo: string }) => `${ref.owner}/${ref.repo}`;
const plain = ({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo }) as RepoRef;
const tail = (path: string) => {
  const parts = path.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
};
const letter = (side: 'a' | 'b') =>
  h('span', { class: 'cmp-letter', 'data-side': side, 'aria-hidden': 'true' }, side.toUpperCase());

const MODE_TITLE: Record<ColorBy, string> = {
  language: 'Languages',
  folder: 'Top-level folders',
  activity: 'Last changed',
  changes: 'How often files change',
  owner: 'Owners',
};

/**
 * Compare trees: two repos, A (the one on show) and B, each on its own island in the same world,
 * A on the left. Each gets the same repo card: A keeps the page's own, and B's below it is built
 * alike, with its own search field (always open on a desktop, in the card's place on a phone),
 * CI chip, branch and counts, and × to stop comparing. A letter marks each card, its search
 * field and a tag under its island. The side panel trades its single-tree panels for both trees
 * side by side: the overall numbers, then whatever Color by shows, for each. Color by colors
 * both trees, each from its own history where the mode needs one; the sky, birds and folder
 * labels show for neither. `state.compare` names B, `state.companion` holds it once grown.
 */
export function mountCompare(app: App): { open(): void; close(): boolean } {
  const { store, view } = app;
  const root = byId('compare');
  const panel = byId('compare-panel');
  const title = byId('title');
  const openButton = byId<HTMLButtonElement>('compare-open');

  // A's letter, in its card and its search field; shown only while comparing.
  byId('repo-switch').append(letter('a'));
  byId('repo-form').prepend(letter('a'));

  // B's search field: like A's, with Recent and the samples under it.
  const input = h('input', {
    type: 'text',
    id: 'compare-input',
    placeholder: 'Compare with owner/repo',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    'aria-label': 'Repository B',
    'aria-describedby': 'compare-error',
    'aria-controls': 'compare-suggest',
    'aria-expanded': 'false',
  });
  const error = h('p', { class: 'field-error', id: 'compare-error', role: 'alert' });
  const suggest = h('div', { class: 'suggest', id: 'compare-suggest' });
  suggest.hidden = true;
  const form = h(
    'form',
    { class: 'repo', id: 'compare-form', role: 'search', novalidate: true },
    letter('b'),
    input,
    h('button', { type: 'submit', class: 'go' }, 'Grow'),
    error,
    suggest,
  );

  // B's card: the page's repo card again, for B.
  const switcher = h(
    'button',
    {
      type: 'button',
      class: 'repo-switch',
      'aria-label': 'Change repository B',
      'aria-controls': 'compare-form',
    },
    icon(GITHUB_MARK),
    letter('b'),
  );
  const link = h('button', {
    type: 'button',
    id: 'compare-link',
    title: 'Change repository B',
    'aria-controls': 'compare-form',
  });
  const meta = h('p', { class: 'meta', id: 'compare-meta' });
  const chip = h('a', {
    class: 'weather',
    id: 'compare-weather',
    target: '_blank',
    rel: 'noopener',
  });
  chip.hidden = true;
  const status = h('p', { class: 'cmp-status', id: 'compare-status', role: 'status' });
  const stop = h(
    'button',
    { type: 'button', class: 'icon-btn cmp-stop', 'aria-label': 'Stop comparing' },
    icon(...ICONS.close),
  );
  const card = h(
    'div',
    { class: 'title cmp-card', id: 'compare-card' },
    switcher,
    h('p', { class: 'name', role: 'heading', 'aria-level': '2' }, link),
    meta,
    chip,
    status,
    stop,
  );
  root.append(form, card);

  // Name tags under the islands.
  const tagLayer = byId('island-tags');
  const makeTag = (side: 'a' | 'b') => {
    const name = h('span', {});
    const el = h(
      'span',
      { class: 'island-tag', 'data-side': side },
      h('b', {}, side.toUpperCase()),
      name,
    );
    el.hidden = true;
    tagLayer.append(el);
    return { el, name };
  };
  const tags = { a: makeTag('a'), b: makeTag('b') };

  const memory = new Map<string, Loaded>();
  let abort: AbortController | null = null;
  let loading: RepoRef | null = null;
  let failed: RepoRef | null = null;
  let failure = '';

  // The field: always shown on a desktop; on a phone B's mark or name opens it in the card's place.
  const setOpen = (open: boolean) => {
    root.toggleAttribute('data-open', open);
    for (const b of [switcher, link]) b.setAttribute('aria-expanded', String(open));
  };
  const openField = () => {
    setOpen(true);
    input.focus();
  };
  switcher.addEventListener('click', openField);
  link.addEventListener('click', openField);

  const closeSuggest = () => {
    suggest.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  const setInvalid = (message: string) => {
    error.textContent = message;
    input.setAttribute('aria-invalid', String(!!message));
    form.toggleAttribute('data-invalid', !!message);
    if (message) closeSuggest();
  };
  const pick = (ref: RepoRef) => {
    const repo = store.get().repo;
    if (repo && sameRef(plain(ref), plain(repo.info.ref))) {
      return setInvalid('That one is already A. Pick another to compare.');
    }
    input.value = '';
    setInvalid('');
    closeSuggest();
    input.blur();
    setOpen(false);
    store.dispatch({ type: 'compare', ref: plain(ref) });
  };
  const openSuggest = () => {
    const row = (label: string, glyph: string[], note?: string) =>
      h(
        'button',
        { type: 'button', onclick: () => pick(parseRepoRef(label) as RepoRef) },
        icon(...glyph),
        h('span', {}, label),
        note && h('small', {}, note),
      );
    const recent = readRecent();
    suggest.replaceChildren(
      ...(recent.length
        ? [h('p', { class: 'h' }, 'Recent'), ...recent.map((r) => row(r, ICONS.history))]
        : []),
      h('p', { class: 'h' }, 'Bundled samples'),
      ...SAMPLES.map((s) => row(`${s.owner}/${s.repo}`, ICONS.sample, `${compact(s.files)} files`)),
    );
    suggest.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return openSuggest();
    }
    const ref = parseRepoRef(text);
    if ('kind' in ref)
      return setInvalid('Use owner/repo, like vitejs/vite, or paste a GitHub URL.');
    pick(ref);
  });
  input.addEventListener('input', () => setInvalid(''));
  input.addEventListener('focus', openSuggest);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !suggest.hidden) {
      event.preventDefault();
      suggest.querySelector('button')?.focus();
    }
    if (event.key === 'Escape') {
      closeSuggest();
      setInvalid('');
      input.blur();
      setOpen(false);
    }
  });
  suggest.addEventListener('mousedown', (event) => event.preventDefault());
  form.addEventListener('focusout', (event) => {
    if (form.contains(event.relatedTarget as Node | null)) return;
    closeSuggest();
    if (!input.value.trim()) setInvalid('');
    setOpen(false);
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if ((event.target as Element).closest('#compare')) return;
      if (form.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      closeSuggest();
      setOpen(false);
    },
    true,
  );

  /** Grows B: the one on show as it is, else from memory, else in a worker. */
  async function grow(ref: RepoRef, fresh = false) {
    const state = store.get();
    const main = state.repo;
    if (main && sameRef(plain(main.info.ref), ref)) {
      return store.dispatch({ type: 'companion', companion: main });
    }
    const { hidden } = state.settings;
    const quality = qualityOf(state);
    const key = `${nameOf(ref).toLowerCase()}|${hidden.join('/')}|${quality}`;
    const kept = fresh ? undefined : memory.get(key);
    if (kept) return store.dispatch({ type: 'companion', companion: kept });
    if (!fresh && loading && sameRef(loading, ref)) return;
    abort?.abort();
    const signal = (abort = new AbortController()).signal;
    loading = ref;
    failed = null;
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
      void readRuns(result, false);
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

  /** B's recent Actions runs, for its CI chip, as the loader reads A's. */
  let runsFor: string | null = null;
  async function readRuns(repo: Loaded, fresh: boolean) {
    const state = store.get();
    if (!state.settings.weather) return;
    const { ref, branch } = repo.info;
    const key = ciKey(ref, branch);
    if (runsFor === key || (!fresh && state.ci[key] !== undefined)) return;
    runsFor = key;
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
      if (runsFor === key) runsFor = null;
    }
  }
  chip.addEventListener('click', (event) => {
    if (chip.dataset.sky !== 'unknown') return;
    event.preventDefault();
    const { companion } = store.get();
    if (companion) void readRuns(companion, true);
  });

  /** B's card: its name, its CI, its branch and counts, or how its growing is going. */
  const render = (state: AppState) => {
    const { compare, companion } = state;
    if (!compare) return;
    card.dataset.repo = nameOf(compare);
    link.replaceChildren(h('span', {}, nameOf(compare)), icon(...ICONS.chevron));
    const growing = !companion && !(failed && sameRef(failed, compare));
    card.toggleAttribute('data-loading', !companion);
    root.toggleAttribute('aria-busy', growing);
    paintWeather(chip, state, companion);
    if (companion) {
      fill(meta, ...repoMeta(companion, () => void grow(plain(compare), true)));
      status.textContent = '';
    } else {
      fill(meta);
      status.textContent = growing ? `Growing ${nameOf(compare)}…` : failure;
    }
  };

  /** The rows a mode's legend gives each tree, matched by label. */
  const legendRows = (a: LegendEntry[], b: LegendEntry[], keepOrder: boolean) => {
    const total = (l: LegendEntry[]) =>
      Math.max(
        1,
        l.reduce((sum, e) => sum + e.files, 0),
      );
    const [ta, tb] = [total(a), total(b)];
    const labels = new Map<string, { color: string; a: number; b: number }>();
    for (const [list, side] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      for (const e of list) {
        if (/^\d+ more$/.test(e.label)) continue;
        const row = labels.get(e.label) ?? { color: e.color, a: 0, b: 0 };
        row[side] += e.files;
        labels.set(e.label, row);
      }
    }
    const rows = [...labels].map(([label, r]) => ({ label, ...r, share: r.a / ta + r.b / tb }));
    if (!keepOrder) rows.sort((x, y) => y.share - x.share || (x.label < y.label ? -1 : 1));
    return { rows: rows.slice(0, keepOrder ? rows.length : ROWS), ta, tb };
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
  const row = (head: Node | string, x: Node | string, y: Node | string) =>
    h('tr', {}, h('th', { scope: 'row' }, head), h('td', {}, x), h('td', {}, y));
  const swatch = (label: string, color: string) =>
    h(
      'span',
      { class: 'cmp-lang' },
      h('i', { style: `background:${color}` }),
      h('span', {}, label),
    );

  /** Why a tree's history is not on the table, or null once it is. */
  const historyNote = (history: HistoryFacts<Loaded> | null, facts: Facts | null) => {
    if (facts) return null;
    if (!history || history.status === 'loading') return 'Reading its history…';
    return history.status === 'missing' ? 'No stored history' : 'History unavailable';
  };

  const renderPanel = (state: AppState) => {
    const { repo, companion } = state;
    if (!repo || !companion) return fill(panel);
    const [sa, sb] = [treeStats(repo), treeStats(companion)];
    const sameName = repo.info.ref.repo.toLowerCase() === companion.info.ref.repo.toLowerCase();
    const short = (l: Loaded) => (sameName ? nameOf(l.info.ref) : l.info.ref.repo);
    const head = (side: 'a' | 'b', l: Loaded) =>
      h(
        'th',
        { scope: 'col' },
        h('span', { class: 'cmp-col' }, letter(side), h('span', {}, short(l))),
      );
    const thead = () =>
      h('thead', {}, h('tr', {}, h('td', {}), head('a', repo), head('b', companion)));
    const table = (label: string, ...rows: Node[]) =>
      h('table', { class: 'cmp-table', 'aria-label': label }, thead(), h('tbody', {}, ...rows));

    const palette = PALETTES[state.settings.palette];
    const mode = state.settings.colorBy;
    const rank = rankOf(state);
    const [fa, fb] = [factsOf(state), companionFactsOf(state)];
    const legendOf = (l: Loaded, facts: Facts | null) =>
      leafCategories(l.tree, mode, palette, facts, mode === 'folder' ? null : rank).legend;

    let section: Node[];
    if (mode === 'language') {
      const colors = new Map(
        leafCategories(repo.tree, 'language', palette, null, rank).legend.map((e) => [
          e.label,
          e.color,
        ]),
      );
      const files = (s: typeof sa) => s.langs.reduce((sum, l) => sum + l.files, 0);
      section = [
        table(
          'Languages side by side',
          ...languageRows(sa, sb, ROWS).map(({ lang, a, b }) => {
            const color = colors.get(lang) ?? palette.rest;
            return row(swatch(lang, color), share(a, files(sa), color), share(b, files(sb), color));
          }),
        ),
      ];
    } else if (mode === 'folder' || mode === 'owner') {
      // Each tree has its own folders and people, so each lists its biggest.
      const list = (l: Loaded, side: 'a' | 'b', facts: Facts | null, note: string | null) => {
        const legend = note ? [] : legendOf(l, facts).filter((e) => !/^\d+ more$/.test(e.label));
        const total = Math.max(
          1,
          legend.reduce((sum, e) => sum + e.files, 0),
        );
        const suffix = mode === 'folder' ? '/' : '';
        return h(
          'div',
          { class: 'cmp-list' },
          h('p', { class: 'cmp-list-head' }, letter(side), h('span', {}, short(l))),
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
      const owners = mode === 'owner';
      section = [
        h(
          'div',
          { class: 'cmp-lists' },
          list(repo, 'a', fa, owners ? historyNote(state.history, fa) : null),
          list(companion, 'b', fb, owners ? historyNote(state.companionHistory, fb) : null),
        ),
      ];
    } else {
      const notes = [historyNote(state.history, fa), historyNote(state.companionHistory, fb)];
      const { rows, ta, tb } = legendRows(
        fa ? legendOf(repo, fa) : [],
        fb ? legendOf(companion, fb) : [],
        true,
      );
      section = [
        table(
          `${MODE_TITLE[mode]} side by side`,
          ...(notes.some(Boolean) ? [row('', notes[0] ?? '', notes[1] ?? '')] : []),
          ...rows.map((r) =>
            row(
              swatch(r.label, r.color),
              fa ? share(r.a, ta, r.color) : '',
              fb ? share(r.b, tb, r.color) : '',
            ),
          ),
        ),
      ];
      if (mode === 'changes' && (fa || fb)) {
        const hot = (l: Loaded, facts: Facts | null, side: 'a' | 'b') =>
          h(
            'div',
            { class: 'cmp-list' },
            h('p', { class: 'cmp-list-head' }, letter(side), h('span', {}, short(l))),
            !facts
              ? h('p', { class: 'more' }, 'No history yet')
              : busiest(facts).length === 0
                ? h('p', { class: 'more' }, 'No changes recorded')
                : h(
                    'ol',
                    {},
                    ...busiest(facts).map((file) =>
                      h(
                        'li',
                        { title: l.index.files.paths[file]! },
                        h('span', { class: 'fn' }, tail(l.index.files.paths[file]!)),
                        h('span', { class: 'cmp-num' }, count(facts.fileChurn[file]!)),
                      ),
                    ),
                  ),
          );
        section.push(
          h('h3', { class: 'h' }, 'Busiest files'),
          h('div', { class: 'cmp-lists' }, hot(repo, fa, 'a'), hot(companion, fb, 'b')),
        );
      }
    }

    fill(
      panel,
      h('h2', { class: 'h' }, 'Side by side'),
      h(
        'p',
        { class: 'cmp-line', id: 'compare-line' },
        sizeLine(
          { name: short(repo), files: sa.files },
          { name: short(companion), files: sb.files },
        ),
      ),
      table(
        'Both trees side by side',
        row('Files', count(sa.files), count(sb.files)),
        row('Folders', count(sa.folders), count(sb.folders)),
        row('Deepest', plural(sa.depth, 'level'), plural(sb.depth, 'level')),
        row('Size', bytes(sa.bytes), bytes(sb.bytes)),
        row('Languages', count(sa.langs.length), count(sb.langs.length)),
      ),
      h('h2', { class: 'h' }, MODE_TITLE[mode]),
      ...section,
    );
  };

  /** B sits under A's card. */
  const place = () => {
    root.style.top = `${title.offsetTop + title.offsetHeight + 10}px`;
  };
  new ResizeObserver(place).observe(title);
  addEventListener('resize', place);

  const sync = (state: AppState, prev: AppState | null) => {
    const { compare, companion, repo } = state;
    const on = compare !== null;
    root.hidden = !on;
    document.body.toggleAttribute('data-compare', on);
    openButton.setAttribute('aria-pressed', String(on));
    openButton.setAttribute('aria-disabled', String(!repo));
    panel.hidden = !(on && companion && repo);
    if (!on) {
      abort?.abort();
      abort = loading = failed = null;
      setOpen(false);
      delete root.dataset.ready;
      tagLayer.hidden = true;
      return;
    }
    if (!prev?.compare) place();
    const moved = !prev || !sameRef(compare, prev.compare) || repo !== prev.repo;
    if (moved && !sameRef(compare, failed) && !companion) void grow(compare);
    if (!companion) delete root.dataset.ready;
    render(state);
    if (
      !prev ||
      companion !== prev.companion ||
      repo !== prev.repo ||
      state.settings.palette !== prev.settings.palette ||
      state.settings.colorBy !== prev.settings.colorBy ||
      state.history !== prev.history ||
      state.companionHistory !== prev.companionHistory
    ) {
      renderPanel(state);
    }
    // The cards carry the full names, so a tag needs only the repo's own, unless both share it.
    const same = !!repo && repo.info.ref.repo.toLowerCase() === compare.repo.toLowerCase();
    const tagName = (ref: RepoRef) => (same ? nameOf(ref) : ref.repo);
    tags.a.name.textContent = repo ? tagName(repo.info.ref) : '';
    tags.b.name.textContent = tagName(compare);
  };
  store.subscribe((state, prev) => sync(state, prev));

  // B is on show once it has grown in, while the timeline (which hides it) is shut; the name
  // tags follow the islands.
  view.onFrame(({ growth, islands }) => {
    const { companion, timeline } = store.get();
    const on = !!companion && timeline === null && growth > 0.2;
    tagLayer.hidden = !on;
    if (!on) return;
    for (const [side, foot] of [
      ['a', islands.main],
      ['b', islands.companion],
    ] as const) {
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
  stop.addEventListener('click', () => {
    close();
    openButton.focus();
  });

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
