import type { App } from '../app';
import { nameOf } from '../app';
import { byId, h, icon, ICONS } from '../dom';
import { count } from '../format';
import { addPin, mergePins, removePin } from '../pins';
import type { AppState, Repo } from '../state';
import type { RepoRef } from '../../repo/ref';

const KEY = 'repo-tree:pins:';
const keyOf = (repo: Repo) =>
  `${KEY}${repo.info.ref.owner}/${repo.info.ref.repo}@${repo.info.branch}`.toLowerCase();

function load(repo: Repo): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(keyOf(repo)) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function save(repo: Repo, pins: readonly string[]) {
  try {
    if (pins.length) localStorage.setItem(keyOf(repo), JSON.stringify(pins));
    else localStorage.removeItem(keyOf(repo));
  } catch {
    // Private mode keeps the tray for this visit only.
  }
}

/**
 * The pin tray: the folders pinned in this repo, as chips at the top of the side panel, so one
 * tap glides back to any of them. Each pin joins it, it stays per repo in this browser, and a
 * shared link carries it. `onChange` rewrites the link when a chip is removed.
 */
export function mountPinTray(
  app: App,
  onChange: () => void,
): {
  /** The tray's paths for a state: the kept ones, and the pin on show if it is new. */
  pinsFor(state: AppState): string[];
  /** Adds a link's pins to the tray of its repo, now or once that repo shows. */
  receive(ref: RepoRef, pins: readonly string[]): void;
} {
  const { store } = app;
  const tray = byId('pins');
  const list = h('ul', { class: 'pin-list' });
  const clear = h(
    'button',
    { type: 'button', class: 'pin-clear', onclick: () => setPins([]) },
    'Clear',
  );
  tray.replaceChildren(
    h('div', { class: 'pin-head' }, h('h2', { class: 'h' }, 'Pinned'), clear),
    list,
  );

  let pins: string[] = [];
  let shownRepo: Repo | null = null;
  let pending: { ref: RepoRef; pins: readonly string[] } | null = null;

  const pathOf = ({ repo, selection }: AppState) =>
    repo && selection && selection.folder !== 0 ? repo.tree.folders.path[selection.folder]! : '';
  const pinsFor = (state: AppState) => addPin(pins, pathOf(state));

  const matches = (ref: RepoRef, repo: Repo) =>
    ref.owner.toLowerCase() === repo.info.ref.owner.toLowerCase() &&
    ref.repo.toLowerCase() === repo.info.ref.repo.toLowerCase() &&
    (ref.ref ?? repo.info.branch) === repo.info.branch;

  const setPins = (next: string[]) => {
    pins = next;
    if (shownRepo) save(shownRepo, pins);
    render(store.get());
    onChange();
  };

  const render = (state: AppState) => {
    const { repo } = state;
    const current = pathOf(state);
    const shown = repo ? pinsFor(state).filter((p) => repo.folderIds.has(p)) : [];
    // The tray earns its place once it offers somewhere else to go.
    tray.hidden = shown.filter((p) => p !== current).length === 0;
    if (tray.hidden || !repo) return;
    list.replaceChildren(
      ...shown.map((path) => {
        const folder = repo.folderIds.get(path)!;
        const here = path === current;
        return h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'pin-chip',
              title: here ? `${path}/` : `Glide to ${path}/`,
              'aria-current': here ? 'true' : null,
              onclick: () => app.select({ folder }, true),
            },
            h('span', {}, `${nameOf(path)}/`),
            h('small', {}, count(repo.index.folders.files[folder]!)),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'pin-drop',
              'aria-label': `Remove ${path}/ from pinned`,
              onclick: () => {
                if (here) app.select(null);
                setPins(removePin(pinsFor(store.get()), path));
              },
            },
            icon(...ICONS.close),
          ),
        );
      }),
    );
  };

  store.subscribe((state, prev) => {
    if (state.repo && state.repo !== prev.repo) {
      shownRepo = state.repo;
      pins = load(state.repo).filter((p) => state.repo!.folderIds.has(p));
      if (pending && matches(pending.ref, state.repo)) {
        pins = mergePins(
          pins,
          pending.pins.filter((p) => state.repo!.folderIds.has(p)),
        );
        pending = null;
      }
      save(state.repo, pins);
    }
    if (state.selection !== prev.selection && shownRepo) {
      const next = pinsFor(state);
      if (next.length !== pins.length) {
        pins = next;
        save(shownRepo, pins);
      }
    }
    if (state.repo !== prev.repo || state.selection !== prev.selection) render(state);
  });

  return {
    pinsFor,
    receive(ref, more) {
      if (!more.length) return;
      if (shownRepo && matches(ref, shownRepo)) {
        setPins(
          mergePins(
            pins,
            more.filter((p) => shownRepo!.folderIds.has(p)),
          ),
        );
      } else {
        pending = { ref, pins: more };
      }
    },
  };
}
