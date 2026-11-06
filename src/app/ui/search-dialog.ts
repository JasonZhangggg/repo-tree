import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';
import { bytes, count, plural } from '../format';
import { createSearch, type SearchHit } from '../search';
import type { Repo } from '../state';

/**
 * Every file a hit stands for, by RepoIndex.files id: a file hit itself, a folder hit all the
 * files under it. Folders are in preorder, so a parent's mark is set before its children read it.
 */
export function matchedFiles(repo: Repo, hits: readonly SearchHit[]): Uint8Array {
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
 * The "/" palette: fuzzy search over every folder and file of the shown repo. Its matches light
 * up on the tree while it is open; picking one keeps them lit and shows a bar that steps through
 * them, gliding to each, until it is closed.
 */
export function mountSearch(app: App): {
  open(): void;
  close(): boolean;
  /** Ends stepping through matches, if it runs: the matches go dark and the pin clears. */
  stop(): boolean;
  /** Steps to the next match (`by` 1) or the previous (-1), if stepping runs. */
  step(by: 1 | -1): boolean;
  stepping(): boolean;
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
  /** The matches being stepped through, and which one is pinned. */
  let stepper: { hits: SearchHit[]; at: number } | null = null;

  let search: ((query: string) => SearchHit[]) | null = null;
  let searchedRepo: Repo | null = null;
  let hits: SearchHit[] = [];
  let active = 0;
  let returnFocus: HTMLElement | null = null;

  const searchFor = (repo: Repo) => {
    if (searchedRepo !== repo) {
      search = createSearch(repo.tree.folders.path, repo.index.files.paths);
      searchedRepo = repo;
    }
    return search!;
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
    const repo = store.get().repo;
    if (!repo) return;
    const query = input.value;
    hits = query.trim() ? searchFor(repo)(query) : [];
    const { folders, files } = repo.index;
    list.replaceChildren(
      ...hits.map((hit, i) =>
        h(
          'li',
          {
            id: `hit-${i}`,
            role: 'option',
            'aria-selected': 'false',
            onpointermove: () => active !== i && setActive(i),
            onclick: () => choose(i),
          },
          icon(...(hit.kind === 'folder' ? ICONS.folder : ICONS.file)),
          highlight(hit.kind === 'folder' ? `${hit.path}/` : hit.path, hit.marks),
          h(
            'small',
            {},
            hit.kind === 'folder'
              ? plural(folders.files[hit.id]!, 'file')
              : bytes(files.size[hit.id]!),
          ),
        ),
      ),
    );
    empty.hidden = hits.length > 0;
    empty.textContent = query.trim()
      ? `No folder or file matches “${query.trim()}”.`
      : `Search ${count(files.paths.length)} files and ${count(folders.files.length - 1)} folders by name or path.`;
    setActive(0);
    // The tree shows what the list does, behind the dialog.
    view.setMatches(hits.length ? matchedFiles(repo, hits) : null);
  };

  const pin = (hit: SearchHit) => {
    const repo = store.get().repo;
    if (!repo) return;
    if (hit.kind === 'folder') app.select({ folder: hit.id }, true);
    else app.select({ folder: repo.index.files.folder[hit.id]!, file: hit.id }, true);
  };

  const showStep = () => {
    if (!stepper) return;
    const { hits: all, at } = stepper;
    stepAt.textContent = `${at + 1} of ${all.length}`;
    for (const b of steps.querySelectorAll<HTMLButtonElement>('.steps-btn')) {
      if (b.getAttribute('aria-label') !== 'Stop searching') b.disabled = all.length < 2;
    }
  };

  const choose = (i: number) => {
    const hit = hits[i];
    const repo = store.get().repo;
    if (!hit || !repo) return;
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

  // Another repo ends the stepping: its matches name the last one's files.
  store.subscribe((state, prev) => {
    if (state.repo === prev.repo) return;
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
    const repo = store.get().repo;
    view.setMatches(stepper && repo ? matchedFiles(repo, stepper.hits) : null);
    input.blur();
    dialog.hidden = true;
    scrim.hidden = true;
    returnFocus?.focus?.();
    return true;
  }

  return { open, close, stop, step, stepping: () => stepper !== null };
}
