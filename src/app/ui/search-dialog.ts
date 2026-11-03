import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';
import { bytes, count, plural } from '../format';
import { createSearch, type SearchHit } from '../search';
import type { Repo } from '../state';

/** The "/" palette: fuzzy search over every folder and file of the shown repo. */
export function mountSearch(app: App): { open(): void; close(): boolean } {
  const { store } = app;
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
      h('kbd', {}, 'esc'),
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
  };

  const choose = (i: number) => {
    const hit = hits[i];
    const repo = store.get().repo;
    if (!hit || !repo) return;
    close();
    if (hit.kind === 'folder') app.select({ folder: hit.id }, true);
    else app.select({ folder: repo.index.files.folder[hit.id]!, file: hit.id }, true);
  };

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
    dialog.hidden = true;
    scrim.hidden = true;
    returnFocus?.focus?.();
    return true;
  }

  return { open, close };
}
