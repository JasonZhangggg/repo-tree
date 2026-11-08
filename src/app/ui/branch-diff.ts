import { githubToken } from '../../repo/auth';
import {
  diffMarks,
  fetchCompare,
  fetchRefs,
  type BranchDiff,
  type DiffError,
  type Refs,
} from '../../repo/branch-diff';
import type { App } from '../app';
import { byId, fill, h, icon, ICONS } from '../dom';
import { count, plural } from '../format';
import { repoName, type AppState, type DiffView } from '../state';

/** Branches and tags the picker lists at once. */
const LISTED = 8;

/** What went wrong comparing, in a sentence, with what to do next. */
export function describeDiffError(error: DiffError, head: string, base: string): string {
  if (error.kind === 'not-found') {
    return `GitHub has no branch, tag or commit “${head}” here that shares history with ${base}.`;
  }
  if (error.kind === 'rate-limited') {
    const at = new Date(error.resetAt).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `GitHub’s hourly limit is spent until ${at}. Sign in with GitHub for more.`;
  }
  return 'GitHub could not be reached. Check the connection and try again.';
}

/** Branches then tags holding the query (case-insensitive), the base branch left out. */
export function matchRefs(refs: Refs, query: string, base: string) {
  const q = query.trim().toLowerCase();
  const hit = (name: string) => name !== base && name.toLowerCase().includes(q);
  return [
    ...refs.branches.filter(hit).map((name) => ({ name, kind: 'branch' as const })),
    ...refs.tags.filter(hit).map((name) => ({ name, kind: 'tag' as const })),
  ].slice(0, LISTED);
}

/**
 * A branch or tag against the branch on show. The repo card ends with "Show a branch's
 * changes", which opens a picker of the repo's branches and tags (or any name or sha typed);
 * the pick reads GitHub's comparison (repo/branch-diff.ts), and once read the tree regrows with
 * the head's new files (the loader's `extra`) and shows the comparison (TreeView.setDiff): new
 * files' leaves lit bright, changed ones lit, deleted ones fallen on the island. While it shows,
 * the row is its key: head vs base, the counts, and × to put the tree back.
 */
export function mountBranchDiff(app: App): {
  /** Shows `head` against the branch on show once a repo named `repo` is, as a link asks. */
  request(repo: string, head: string): void;
} {
  const { store } = app;
  const title = byId('title');
  const root = h('div', {
    class: 'diff-rows',
    id: 'diff',
    role: 'group',
    'aria-label': 'Branch changes',
  });
  root.hidden = true;
  title.append(root);

  const openButton = h(
    'button',
    { type: 'button', class: 'cmp-add', id: 'diff-open' },
    h('span', { class: 'cmp-plus', 'aria-hidden': 'true' }, icon(...ICONS.branch)),
    h('span', {}, 'Show a branch’s changes'),
  );
  const shown = h('div', { class: 'diff-on', id: 'diff-on' });
  root.append(openButton, shown);

  // The picker.
  const scrim = h('div', { class: 'scrim', id: 'diff-scrim' });
  const heading = h('h2', { id: 'diff-title' });
  const input = h('input', {
    type: 'text',
    class: 'diff-input',
    placeholder: 'Branch, tag or commit',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Branch, tag or commit',
  });
  const list = h('ul', { class: 'diff-refs', role: 'listbox', 'aria-label': 'Branches and tags' });
  const note = h('p', { class: 'compute-fine diff-note' });
  const go = h('button', { type: 'submit', class: 'btn dark' }, 'Show changes');
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const form = h(
    'form',
    {
      class: 'dialog compute diff-picker',
      id: 'diff-picker',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'diff-title',
    },
    h(
      'div',
      { class: 'ci-head' },
      h('span', { class: 'ci-glyph diff-glyph', 'aria-hidden': 'true' }, icon(...ICONS.branch)),
      heading,
    ),
    h(
      'p',
      {},
      'Its new files grow in as bright leaves, changed ones light up, and deleted ones fall.',
    ),
    input,
    list,
    note,
    h('div', { class: 'actions' }, go, cancel),
  );
  scrim.hidden = form.hidden = true;
  document.body.append(scrim, form);

  const refsCache = new Map<string, Refs | DiffError>();
  const compares = new Map<string, BranchDiff>();
  let refsAbort: AbortController | null = null;
  let compareAbort: AbortController | null = null;
  let pending: { repo: string; head: string } | null = null;
  let opener: Element | null = null;

  const close = () => {
    if (form.hidden) return;
    refsAbort?.abort();
    form.hidden = scrim.hidden = true;
    (opener as HTMLElement | null)?.focus?.();
    opener = null;
  };
  cancel.addEventListener('click', close);
  scrim.addEventListener('pointerdown', close);
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || form.hidden) return;
      event.stopPropagation();
      close();
    },
    true,
  );

  const listRefs = () => {
    const repo = store.get().repo;
    if (!repo) return;
    const refs = refsCache.get(repoName(repo));
    if (!refs) {
      note.textContent = 'Reading branches and tags…';
      return list.replaceChildren();
    }
    if ('kind' in refs) {
      note.textContent =
        refs.kind === 'rate-limited'
          ? describeDiffError(refs, '', repo.info.branch)
          : 'GitHub did not list this repo’s branches and tags. Type a name to compare.';
      return list.replaceChildren();
    }
    const hits = matchRefs(refs, input.value, repo.info.branch);
    list.replaceChildren(
      ...hits.map(({ name, kind }) =>
        h(
          'li',
          { role: 'option', 'aria-selected': 'false' },
          h(
            'button',
            { type: 'button', class: 'diff-ref', onclick: () => pick(name) },
            icon(...ICONS.branch),
            h('span', { class: 'diff-ref-name' }, name),
            kind === 'tag' ? h('small', {}, 'tag') : '',
          ),
        ),
      ),
    );
    const total = refs.branches.length + refs.tags.length;
    note.textContent = hits.length
      ? ''
      : input.value.trim()
        ? `No branch or tag holds “${input.value.trim()}”. Show changes looks it up as typed.`
        : total
          ? ''
          : 'This repo has no other branches or tags. Type a commit to compare.';
  };
  input.addEventListener('input', listRefs);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const typed = input.value.trim();
    if (typed) pick(typed);
  });

  const open = async () => {
    const state = store.get();
    const repo = state.repo;
    if (!repo) return;
    opener = document.activeElement;
    heading.textContent = `Show a branch’s changes against ${repo.info.branch}`;
    input.value = '';
    form.hidden = scrim.hidden = false;
    input.focus();
    const name = repoName(repo);
    listRefs();
    if (refsCache.has(name)) return;
    refsAbort?.abort();
    const abort = (refsAbort = new AbortController());
    try {
      const refs = await fetchRefs(repo.info.ref, githubToken(state.settings.token), abort.signal);
      refsCache.set(name, refs);
      if (store.get().repo === repo) listRefs();
    } catch {
      // Closed, or another repo: it reads its own.
    }
  };
  openButton.addEventListener('click', () => void open());
  // A phone's repo card keeps to the repo: there the way in is the More actions menu.
  const menuButton = h(
    'button',
    { type: 'button', class: 'tool', id: 'diff-menu' },
    icon(...ICONS.branch),
    h('span', { class: 'label' }, 'Show a branch’s changes'),
  );
  menuButton.addEventListener('click', () => void open());
  byId('more-menu').prepend(menuButton);

  const pick = (head: string) => {
    close();
    void show(head);
  };

  /** Reads the comparison of `head` against the branch on show, then shows it. */
  async function show(head: string) {
    const state = store.get();
    const repo = state.repo;
    if (!repo) return;
    const base = repo.info.branch;
    const name = repoName(repo);
    const at = { repo: name, base, head };
    compareAbort?.abort();
    const key = `${name}|${base}|${head}`;
    const known = compares.get(key);
    if (known)
      return store.dispatch({ type: 'diff', diff: { ...at, status: 'ready', diff: known } });
    const abort = (compareAbort = new AbortController());
    const loading: DiffView = { ...at, status: 'loading' };
    store.dispatch({ type: 'diff', diff: loading });
    try {
      const result = await fetchCompare(
        repo.info.ref,
        base,
        head,
        githubToken(state.settings.token),
        abort.signal,
      );
      if (store.get().diff !== loading) return;
      if ('kind' in result) {
        return store.dispatch({ type: 'diff', diff: { ...at, status: 'error', error: result } });
      }
      compares.set(key, result);
      store.dispatch({ type: 'diff', diff: { ...at, status: 'ready', diff: result } });
    } catch {
      // Let go, or replaced by another pick.
    }
  }

  const stop = () => {
    compareAbort?.abort();
    store.dispatch({ type: 'diff', diff: null });
  };

  const swatch = (kind: 'added' | 'modified' | 'removed') =>
    h('span', { class: `diff-swatch ${kind}`, 'aria-hidden': 'true' });

  const paint = (state: AppState) => {
    const { repo, diff } = state;
    // Comparing trees shows several repos; a branch's changes describe one.
    root.hidden = !repo || state.compare.length > 0;
    menuButton.hidden = root.hidden || !!diff;
    if (!repo || root.hidden) return;
    openButton.hidden = !!diff;
    shown.hidden = !diff;
    if (!diff) return;
    const head = h('code', { class: 'diff-head' }, diff.head);
    const stopButton = h(
      'button',
      {
        type: 'button',
        class: 'diff-stop',
        'aria-label': 'Stop showing branch changes',
        title: 'Show the tree as it is',
        onclick: stop,
      },
      icon(...ICONS.close),
    );
    const line = h(
      'p',
      { class: 'diff-line' },
      icon(...ICONS.branch),
      head,
      h('span', { class: 'diff-vs' }, 'vs'),
      h('code', {}, diff.base),
    );
    if (diff.status === 'loading') {
      return fill(
        shown,
        h('div', { class: 'diff-top' }, line, stopButton),
        h('p', { class: 'diff-detail', role: 'status' }, `Comparing with ${diff.base}…`),
      );
    }
    if (diff.status === 'error') {
      return fill(
        shown,
        h('div', { class: 'diff-top' }, line, stopButton),
        h(
          'p',
          { class: 'diff-detail diff-error', role: 'alert' },
          describeDiffError(diff.error, diff.head, diff.base),
        ),
      );
    }
    const { counts, off } = diffMarks(diff.diff, repo.index.files.paths);
    const grown = repo.diffHead === diff.head;
    const { ahead, behind, capped } = diff.diff;
    const total = counts.added + counts.modified + counts.removed;
    fill(
      shown,
      h('div', { class: 'diff-top' }, line, stopButton),
      total
        ? h(
            'p',
            { class: 'diff-counts' },
            h('span', {}, swatch('added'), `${count(counts.added)} new`),
            h('span', {}, swatch('modified'), `${count(counts.modified)} changed`),
            h('span', {}, swatch('removed'), `${count(counts.removed)} deleted`),
          )
        : h('p', { class: 'diff-detail' }, `No files differ from ${diff.base}.`),
      h(
        'p',
        { class: 'diff-detail' },
        grown || !total ? '' : 'Growing its new files… ',
        `${plural(ahead, 'commit')} ahead${behind ? `, ${count(behind)} behind` : ''}.`,
        capped ? ' GitHub lists only its first 300 files.' : '',
        grown && off
          ? ` ${plural(off, 'file')} in hidden folders ${off === 1 ? 'is' : 'are'} not on the tree.`
          : '',
      ),
    );
  };

  store.subscribe((state, prev) => {
    if (
      state.repo !== prev.repo ||
      state.diff !== prev.diff ||
      state.compare.length !== prev.compare.length
    ) {
      paint(state);
    }
    // A repo or grove change closes the picker: it lists the last repo's branches.
    if (state.repo !== prev.repo || state.compare.length !== prev.compare.length) close();
    // A link's branch waits for its repo.
    if (
      pending &&
      state.repo &&
      state.repo !== prev.repo &&
      repoName(state.repo) === pending.repo
    ) {
      const { head } = pending;
      pending = null;
      queueMicrotask(() => void show(head));
    }
  });
  paint(store.get());

  return {
    request(repo, head) {
      const state = store.get();
      const on = state.diff;
      if (on && on.repo === repo && on.head === head) return;
      if (state.repo && repoName(state.repo) === repo && state.load.phase !== 'loading') {
        pending = null;
        void show(head);
      } else pending = { repo, head };
    },
  };
}
