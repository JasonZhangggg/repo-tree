import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';
import { bytes, count, plural } from '../format';
import type { Loaded } from '../../load/load-in-worker';
import { createSearch, type SearchHit } from '../search';
import { companionsOf, type AppState } from '../state';

/** A hit on one tree of what is on show: 0 the repo on show, k + 1 compared tree k. */
type Hit = SearchHit & { tree: number };
/** The trees a search looks through: the repo on show, then the compared ones in their order. */
const treesOf = (state: AppState): Loaded[] =>
  state.repo ? [state.repo, ...companionsOf(state)] : [];
/** Most hits listed, across every tree. */
const LIMIT = 20;

/**
 * Every file a hit stands for, by RepoIndex.files id: a file hit itself, a folder hit all the
 * files under it. Folders are in preorder, so a parent's mark is set before its children read it.
 */
export function matchedFiles(repo: Loaded, hits: readonly SearchHit[]): Uint8Array {
  const { folders, files } = repo.index;
  const folderLit = new Uint8Array(folders.files.length);
  const lit = new Uint8Array(files.paths.length);
  for (const hit of hits) {
    if (hit.kind === 'folder') folderLit[hit.id] = 1;
    else lit[hit.id] = 1;
  }
  for (let f = 1; f < folderLit.length; f++) {
    if (folderLit[folders.parent[f]!]) folderLit[f] = 1;
  }
  for (let i = 0; i < lit.length; i++) if (folderLit[files.folder[i]!]) lit[i] = 1;
  return lit;
}

/**
 * The "/" palette: fuzzy search over every folder and file of the shown repo, and while comparing
 * of every tree in the grove, each hit naming its repo. Its matches light up on the trees while
 * it is open; picking one keeps them lit and shows a bar that steps through them, pinning each
 * (gliding to it on a lone tree; a grove stays in view), until it is closed.
 */
export function mountSearch(app: App): {
  open(): void;
  close(): boolean;
  /** Ends stepping through matches, if it runs: the matches go dark and the pin clears. */
  stop(): boolean;
  /** Steps to the next match (`by` 1) or the previous (-1), if stepping runs. */
  step(by: 1 | -1): boolean;
  stepping(): boolean;
  /** Lights the matches again, if any show, after something else lit its own leaves. */
  relight(): void;
} {
  const { store, view } = app;
  const dialog = byId('search');
  const scrim = byId('search-scrim');
  const input = h('input', {
    type: 'search',
    placeholder: 'Search folders and files',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'results',
    'aria-autocomplete': 'list',
    'aria-label': 'Search folders and files',
  });
  const list = h('ul', {
    class: 'results',
    id: 'results',
    role: 'listbox',
    'aria-label': 'Matches',
  });
  const empty = h('p', { class: 'search-empty' });
  dialog.append(
    h(
      'div',
      { class: 'search-field' },
      icon('M15.8 15.8 20 20', 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z'),
      input,
      // A key hint for a keyboard, a word to tap on a touch screen: either way it closes.
      h(
        'button',
        {
          type: 'button',
          class: 'search-close',
          'aria-label': 'Close search',
          onclick: () => close(),
        },
        h('kbd', {}, 'esc'),
        h('span', {}, 'Cancel'),
      ),
    ),
    list,
    empty,
    h(
      'div',
      { class: 'search-foot', 'aria-hidden': 'true' },
      h('span', {}, h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' to move'),
      h('span', {}, h('kbd', {}, 'enter'), ' to pin'),
    ),
  );

  const stepQuery = h('button', {
    type: 'button',
    class: 'steps-query',
    title: 'Search again',
    onclick: () => open(),
  });
  const stepAt = h('span', { class: 'steps-at', 'aria-live': 'polite' });
  const stepButton = (label: string, d: string, by: 1 | -1) =>
    h(
      'button',
      { type: 'button', class: 'steps-btn', 'aria-label': label, onclick: () => step(by) },
      icon(d),
    );
  const steps = h(
    'div',
    {
      class: 'steps',
      id: 'search-steps',
      role: 'group',
      'aria-label': 'Search matches',
      hidden: true,
    },
    icon('M15.8 15.8 20 20', 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z'),
    stepQuery,
    stepAt,
    stepButton('Previous match', 'm14.5 6-6 6 6 6', -1),
    stepButton('Next match', 'm9.5 6 6 6-6 6', 1),
    h(
      'button',
      { type: 'button', class: 'steps-btn', 'aria-label': 'Stop searching', onclick: () => stop() },
      icon(...ICONS.close),
    ),
  );
  document.body.append(steps);
  /**
   * The pill sits under the header, and under the repo card where they would meet: a grove's
   * card on a phone runs the screen's width and grows with each tree.
   */
  const title = byId('title');
  const place = () => {
    if (steps.hidden) return;
    steps.style.top = '';
    const card = title.getBoundingClientRect();
    const pill = steps.getBoundingClientRect();
    const across = pill.left < card.right && card.left < pill.right;
    const below = card.height > 0 && across && pill.top < card.bottom + 8;
    if (below) steps.style.top = `${card.bottom + 8 + window.scrollY}px`;
  };
  new ResizeObserver(place).observe(title);
  addEventListener('resize', place);
  /** The matches being stepped through, and which one is pinned. */
  let stepper: { hits: Hit[]; at: number } | null = null;

  const searches = new WeakMap<Loaded, (query: string, limit?: number) => SearchHit[]>();
  let hits: Hit[] = [];
  let active = 0;
  let returnFocus: HTMLElement | null = null;

  const searchFor = (repo: Loaded) => {
    let search = searches.get(repo);
    if (!search) {
      search = createSearch(repo.tree.folders.path, repo.index.files.paths);
      searches.set(repo, search);
    }
    return search;
  };

  /** Lights each tree's share of the hits, or puts every tree back. */
  const light = (shown: readonly Hit[] | null) => {
    const trees = treesOf(store.get());
    if (!shown?.length || !trees.length) return view.setMatches(null);
    const [main, ...others] = trees.map((repo, t) =>
      matchedFiles(
        repo,
        shown.filter((hit) => hit.tree === t),
      ),
    );
    view.setMatches(main!, others);
  };

  const highlight = (path: string, marks: number[]) => {
    const set = new Set(marks);
    const name = path.lastIndexOf('/') + 1;
    const parts: Node[] = [];
    for (let i = 0; i < path.length; i++) {
      const ch = path[i]!;
      const node = set.has(i) ? h('b', {}, ch) : document.createTextNode(ch);
      parts.push(i >= name ? h('span', { class: 'name' }, node) : node);
    }
    return h('span', { class: 'path', title: path }, h('bdi', {}, ...parts));
  };

  const setActive = (index: number) => {
    active = index;
    list
      .querySelectorAll('li')
      .forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    const li = list.children[index] as HTMLElement | undefined;
    li?.scrollIntoView({ block: 'nearest' });
    if (li) input.setAttribute('aria-activedescendant', li.id);
    else input.removeAttribute('aria-activedescendant');
  };

  const run = () => {
    const trees = treesOf(store.get());
    if (!trees.length) return;
    const query = input.value;
    // Each tree's best in turn, then each one's second best, and so on, so a big repo's many
    // equal matches never crowd a small one's out of the list.
    hits = query.trim()
      ? trees
          .flatMap((repo, tree) =>
            searchFor(repo)(query, LIMIT).map((hit, rank) => ({ ...hit, tree, rank })),
          )
          .sort((a, b) => a.rank - b.rank || b.score - a.score || a.tree - b.tree)
          .slice(0, LIMIT)
      : [];
    const grove = trees.length > 1;
    list.replaceChildren(
      ...hits.map((hit, i) => {
        const { folders, files } = trees[hit.tree]!.index;
        return h(
          'li',
          {
            id: `hit-${i}`,
            role: 'option',
            'aria-selected': 'false',
            onpointermove: () => active !== i && setActive(i),
            onclick: () => choose(i),
          },
          icon(...(hit.kind === 'folder' ? ICONS.folder : ICONS.file)),
          // While comparing, each hit says which tree it lies on.
          grove ? h('span', { class: 'hit-repo' }, trees[hit.tree]!.info.ref.repo) : null,
          highlight(hit.kind === 'folder' ? `${hit.path}/` : hit.path, hit.marks),
          h(
            'small',
            {},
            hit.kind === 'folder'
              ? plural(folders.files[hit.id]!, 'file')
              : bytes(files.size[hit.id]!),
          ),
        );
      }),
    );
    empty.hidden = hits.length > 0;
    const sum = (of: (repo: Loaded) => number) => trees.reduce((n, repo) => n + of(repo), 0);
    empty.textContent = query.trim()
      ? `No folder or file matches “${query.trim()}”.`
      : `Search ${count(sum((r) => r.index.files.paths.length))} files and ${count(
          sum((r) => r.index.folders.files.length - 1),
        )} folders by name or path${grove ? `, across ${trees.length} trees` : ''}.`;
    setActive(0);
    // The trees show what the list does, behind the dialog.
    light(hits);
  };

  /** Pins a hit: on a lone tree the camera glides to it; a grove stays in view. */
  const pin = (hit: Hit) => {
    const state = store.get();
    const repo = treesOf(state)[hit.tree];
    if (!repo) return;
    const folder = hit.kind === 'folder' ? hit.id : repo.index.files.folder[hit.id]!;
    if (hit.tree > 0) return app.pinCompanion({ companion: hit.tree - 1, folder });
    const glide = state.compare.length === 0;
    if (hit.kind === 'folder') app.select({ folder }, glide);
    else app.select({ folder, file: hit.id }, glide);
  };

  const showStep = () => {
    if (!stepper) return;
    place();
    const { hits: all, at } = stepper;
    stepAt.textContent = `${at + 1} of ${all.length}`;
    for (const b of steps.querySelectorAll<HTMLButtonElement>('.steps-btn')) {
      if (b.getAttribute('aria-label') !== 'Stop searching') b.disabled = all.length < 2;
    }
  };

  const choose = (i: number) => {
    const hit = hits[i];
    if (!hit || !store.get().repo) return;
    stepper = { hits, at: i };
    stepQuery.textContent = `“${input.value.trim()}”`;
    steps.hidden = false;
    showStep();
    close();
    pin(hit);
  };

  function step(by: 1 | -1): boolean {
    if (!stepper) return false;
    const n = stepper.hits.length;
    stepper.at = (stepper.at + by + n) % n;
    showStep();
    pin(stepper.hits[stepper.at]!);
    return true;
  }

  function stop(): boolean {
    if (!stepper) return false;
    stepper = null;
    steps.hidden = true;
    view.setMatches(null);
    app.select(null);
    return true;
  }

  // Another repo, or another grove, ends the stepping: its matches name the last trees' files.
  store.subscribe((state, prev) => {
    const before = treesOf(prev);
    const now = treesOf(state);
    if (now.length === before.length && now.every((repo, i) => repo === before[i])) return;
    if (stepper && state.repo === prev.repo) view.setMatches(null);
    stepper = null;
    steps.hidden = true;
  });

  input.addEventListener('input', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length)
        setActive((active + (event.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  });
  scrim.addEventListener('click', () => close());

  function open() {
    if (!store.get().repo) return;
    returnFocus = document.activeElement as HTMLElement | null;
    dialog.hidden = false;
    scrim.hidden = false;
    input.select();
    input.focus();
    run();
  }

  function close(): boolean {
    if (dialog.hidden) return false;
    // Closing without a pick puts back the matches being stepped through, or none.
    light(stepper?.hits ?? null);
    input.blur();
    dialog.hidden = true;
    scrim.hidden = true;
    returnFocus?.focus?.();
    return true;
  }

  const relight = () => {
    if (!dialog.hidden) light(hits);
    else if (stepper) light(stepper.hits);
  };

  return { open, close, stop, step, stepping: () => stepper !== null, relight };
}
