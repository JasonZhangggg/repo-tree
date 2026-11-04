import { langOf } from '../../repo/languages';
import { leafMapping, PALETTES, slotColors, type PaletteId } from '../../render/palette';
import { TOP_LANGS } from '../../load/repo-index';
import { githubUrl, nameOf, type App } from '../app';
import { byId, fill, h, icon, ICONS } from '../dom';
import { bytes, count, percent, plural } from '../format';
import { NO_OWNER, type Owners } from '../../timeline/owners';
import { factsOf, needsHistory, type AppState, type Repo } from '../state';

const FOLDER_ROWS = 10;
const MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Why activity or owner colors are not on yet, or null once they are (or not asked for). */
function historyWait(state: AppState): string | null {
  if (!needsHistory(state) || factsOf(state)) return null;
  const status = state.history?.repo === state.repo ? state.history?.status : 'loading';
  if (status === 'missing') return 'No history for this repo yet. Open the timeline to compute it.';
  if (status === 'unavailable') return 'History is unavailable for this repo.';
  return 'Loading history…';
}
const SUB_ROWS = 5;

/** Owners on show, once the history is in and leaves are colored by owner. */
const ownersOf = (state: AppState): Owners | null =>
  state.settings.colorBy === 'owner' ? (factsOf(state)?.owners ?? null) : null;

/** The owner a top-level folder's leaves take, as a legend label. */
const ownerLabel = (owners: Owners, repo: Repo, f: number): string =>
  owners.folders.get(repo.tree.folders.path[f]!)?.owner ?? NO_OWNER;

/** Where owner colors come from, for the legend note. */
function ownerNote(state: AppState): string | null {
  const owners = ownersOf(state);
  if (!owners) return null;
  const { from } = owners;
  const pick = 'pick a color to highlight their leaves.';
  if (from === 'codeowners') return `Owners from CODEOWNERS; ${pick}`;
  if (from === 'mixed') return `CODEOWNERS where it names one, else the top commit author; ${pick}`;
  return `Each top-level folder's top commit author${owners.codeownersUnread ? ' (CODEOWNERS could not be read)' : ''}; ${pick}`;
}

/** Children of a folder, most files first. */
export function childrenOf(repo: Repo, folder: number): number[] {
  const { parent, files } = repo.index.folders;
  const kids: number[] = [];
  for (let f = folder + 1; f < parent.length; f++) if (parent[f] === folder) kids.push(f);
  return kids.sort((a, b) => files[b]! - files[a]!);
}

function langColors(repo: Repo, palette: PaletteId): Map<string, string> {
  const p = PALETTES[palette];
  const { slotOf } = leafMapping(
    repo.tree.langs.map((l) => ({ label: l.lang, files: l.files })),
    p,
  );
  const shown = slotColors(p);
  return new Map(repo.tree.langs.map((l, i) => [l.lang, shown[slotOf[i]!]!]));
}

/** How far a press moves before it is a drag (px), and how fast a release counts as a flick (px/ms). */
const DRAG_SLOP = 8;
const FLICK = 0.45;
/** A drag this far toward the other state, in px or share of the sheet's travel, switches it. */
const SWITCH = { px: 72, share: 0.3 };

/**
 * On a phone the sheet follows a finger dragged up or down from its handle, or down from its
 * content once that is scrolled to the top, and snaps open or closed on release. While a drag
 * runs the sheet carries `data-dragging` and its content shows, offset by `--sheet-y`.
 */
function dragSheet(
  side: HTMLElement,
  toggle: HTMLElement,
  body: HTMLElement,
  setOpen: (open: boolean) => void,
): void {
  const phone = matchMedia('(max-width: 760px)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  type Press = {
    id: number;
    y0: number;
    wasOpen: boolean;
    fromBody: boolean;
    samples: { y: number; t: number }[];
    travel: number;
    dragging: boolean;
  };
  let press: Press | null = null;
  let swallowClick = false;
  let settle: (() => void) | null = null;

  const offsetFor = (p: Press, y: number) =>
    Math.min(p.travel, Math.max(0, (p.wasOpen ? 0 : p.travel) + y - p.y0));
  const show = (offset: number, travel: number) => {
    side.style.setProperty('--sheet-y', `${offset}px`);
    side.style.setProperty('--sheet-closed', String(travel ? offset / travel : 0));
  };
  const finish = (open: boolean) => {
    settle = null;
    side.removeAttribute('data-settling');
    side.style.removeProperty('--sheet-y');
    side.style.removeProperty('--sheet-closed');
    body.style.animation = open ? 'none' : '';
    setOpen(open);
    side.removeAttribute('data-dragging');
    markTop();
  };

  /** Lets the content scroll natively except a downward drag from its top, which closes the sheet. */
  const markTop = () => body.toggleAttribute('data-top', body.scrollTop <= 0);
  body.addEventListener('scroll', markTop, { passive: true });
  toggle.addEventListener('click', () => {
    body.style.animation = '';
    requestAnimationFrame(markTop);
  });
  markTop();

  side.addEventListener('pointerdown', (event) => {
    if (!phone.matches || press || settle || !event.isPrimary || event.button > 0) return;
    const target = event.target as Element;
    const fromBody = body.contains(target);
    if (!fromBody && !toggle.contains(target)) return;
    if (fromBody && (!side.hasAttribute('data-open') || body.scrollTop > 0)) return;
    swallowClick = false;
    press = {
      id: event.pointerId,
      y0: event.clientY,
      wasOpen: side.hasAttribute('data-open'),
      fromBody,
      samples: [{ y: event.clientY, t: event.timeStamp }],
      travel: 0,
      dragging: false,
    };
  });

  side.addEventListener('pointermove', (event) => {
    const p = press;
    if (!p || event.pointerId !== p.id) return;
    const dy = event.clientY - p.y0;
    if (!p.dragging) {
      if (Math.abs(dy) < DRAG_SLOP) return;
      if (p.fromBody && dy < 0) {
        press = null;
        return;
      }
      side.setAttribute('data-dragging', '');
      p.travel = body.offsetHeight;
      p.dragging = true;
      p.y0 += Math.sign(dy) * DRAG_SLOP;
      side.setPointerCapture(p.id);
    }
    p.samples.push({ y: event.clientY, t: event.timeStamp });
    if (p.samples.length > 6) p.samples.shift();
    show(offsetFor(p, event.clientY), p.travel);
  });

  const release = (event: PointerEvent) => {
    const p = press;
    if (!p || event.pointerId !== p.id) return;
    press = null;
    if (!p.dragging) return;
    swallowClick = true;
    const recent = p.samples.filter((s) => event.timeStamp - s.t < 100);
    const first = recent[0];
    const velocity =
      first && event.timeStamp > first.t
        ? (event.clientY - first.y) / (event.timeStamp - first.t)
        : 0;
    const offset = offsetFor(p, event.clientY);
    const moved = p.wasOpen ? offset : p.travel - offset;
    const open =
      event.type === 'pointercancel'
        ? p.wasOpen
        : Math.abs(velocity) > FLICK
          ? velocity < 0
          : moved > Math.min(SWITCH.px, p.travel * SWITCH.share)
            ? !p.wasOpen
            : p.wasOpen;
    const goal = open ? 0 : p.travel;
    if (reduce.matches || Math.abs(goal - offset) < 1) {
      finish(open);
      return;
    }
    side.setAttribute('data-settling', '');
    show(goal, p.travel);
    const done = () => {
      if (settle !== done) return;
      clearTimeout(timer);
      side.removeEventListener('transitionend', onEnd);
      finish(open);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === side && e.propertyName === 'transform') done();
    };
    const timer = setTimeout(done, 450);
    settle = done;
    side.addEventListener('transitionend', onEnd);
  };
  side.addEventListener('pointerup', release);
  side.addEventListener('pointercancel', release);

  side.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}

export function mountSide(app: App): void {
  const { store, view } = app;
  const side = byId('side');
  const toggle = byId('sheet-toggle');
  const sheetTitle = byId('sheet-title');
  const sheetStat = byId('sheet-stat');
  const sheetClear = byId('sheet-clear');
  const folders = byId('folders');
  const legend = byId('legend');
  const legendTitle = byId('legend-title');
  const legendNote = byId('legend-note');
  const detail = byId('detail');

  const setOpen = (open: boolean) => {
    side.toggleAttribute('data-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(!side.hasAttribute('data-open')));
  dragSheet(side, toggle, byId('side-body'), setOpen);
  sheetClear.addEventListener('click', () => app.select(null));

  const pick = (folder: number) => app.select({ folder }, true);

  folders.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...folders.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    items[
      Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))
    ]!.focus();
  });

  const renderFolders = (state: AppState) => {
    const repo = state.repo!;
    const colors = langColors(repo, state.settings.palette);
    const byFolder = new Map(view.legend().map((e) => [e.label, e.color]));
    const rest = slotColors(PALETTES[state.settings.palette]).at(-1)!;
    const { files, langs } = repo.index.folders;
    const tops = childrenOf(repo, 0);
    const most = files[tops[0] ?? 0] || 1;
    const facts = state.settings.colorBy === 'activity' ? factsOf(state) : null;
    const owners = ownersOf(state);
    const bands = view.legend();
    // An owner past the named entries is in the last, "N more", entry.
    const ownerColor = (f: number) =>
      (bands.find((e) => e.label === ownerLabel(owners!, repo, f)) ?? bands.at(-1))?.color ?? rest;
    const colorOf = (f: number) =>
      facts
        ? bands[facts.folderBand[f]!]!.color
        : state.settings.colorBy === 'folder'
          ? (byFolder.get(repo.tree.folders.path[f]!) ?? rest)
          : (colors.get(repo.index.langs[langs[f * TOP_LANGS * 2]!]!) ?? rest);
    const barColor = owners ? ownerColor : colorOf;
    folders.replaceChildren(
      ...tops.slice(0, FOLDER_ROWS).map((f) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              'data-folder': f,
              'aria-current': String(state.selection?.folder === f),
              onclick: () => pick(f),
              onpointerenter: () => app.hover(f),
              onpointerleave: () => app.hover(null),
              onfocus: () => app.hover(f),
              onblur: () => app.hover(null),
            },
            h('span', { class: 'fn' }, `${nameOf(repo.tree.folders.path[f]!)}/`),
            h(
              'span',
              { class: 'bar-track', 'aria-hidden': 'true' },
              h('i', {
                style: `width:${Math.max(3, (files[f]! / most) * 100)}%;--c:${barColor(f)}`,
              }),
            ),
            h('span', { class: 'num' }, count(files[f]!)),
          ),
        ),
      ),
    );
    if (tops.length > FOLDER_ROWS) {
      folders.append(
        h(
          'li',
          {},
          h('p', { class: 'more' }, `and ${plural(tops.length - FOLDER_ROWS, 'more folder')}`),
        ),
      );
    }
    if (tops.length === 0)
      folders.append(h('li', {}, h('p', { class: 'more' }, 'Every file sits at the top level.')));
  };

  /** A legend label as the panel shows it: folders end in a slash. */
  const shownLabel = (state: AppState, label: string) =>
    state.settings.colorBy === 'folder' && state.repo!.folderIds.has(label) ? `${label}/` : label;

  const renderLegend = (state: AppState) => {
    const entries = view.legend();
    const total = entries.reduce((sum, e) => sum + e.files, 0);
    legendTitle.textContent =
      state.settings.colorBy === 'folder'
        ? 'Leaf colors by folder'
        : ownersOf(state)
          ? 'Leaf colors by owner'
          : factsOf(state)
            ? 'Leaf colors by activity'
            : 'Leaf colors by language';
    legend.replaceChildren(
      ...entries.map(({ color, label, files }) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              'data-label': label,
              onclick: () => {
                app.hoverCategory(null);
                app.highlight(store.get().highlight === label ? null : label);
              },
              onpointerenter: (event: PointerEvent) => {
                if (event.pointerType === 'mouse') app.hoverCategory(label);
              },
              onpointerleave: () => app.hoverCategory(null),
            },
            h('i', { class: 'swatch', style: `--c:${color}` }),
            h('span', { title: label }, shownLabel(state, label)),
            h('span', { class: 'num', title: count(files) }, percent(files, total)),
          ),
        ),
      ),
    );
  };

  const markLegend = (state: AppState) => {
    for (const button of legend.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.label === state.highlight));
    }
    const entry = view.legend().find((e) => e.label === state.highlight);
    const facts = state.settings.colorBy === 'activity' ? factsOf(state) : null;
    legendNote.textContent = entry
      ? `${shownLabel(state, entry.label)} · ${plural(entry.files, 'file')}`
      : (historyWait(state) ??
        (facts
          ? `Last change, as of ${MONTH.format(facts.asOf)}. Dead wood is 3+ years untouched; pick a color to highlight its leaves.`
          : (ownerNote(state) ?? 'Pick a color to highlight its leaves.')));
  };

  /** A top-level folder's top authors and CODEOWNERS, while leaves are colored by owner. */
  const ownerCard = (state: AppState, folder: number): (HTMLElement | null)[] => {
    const repo = state.repo!;
    const owners = ownersOf(state);
    const row = owners?.folders.get(repo.tree.folders.path[folder]!);
    if (!owners || !row || repo.index.folders.parent[folder] !== 0) return [];
    const entries = view.legend();
    const rest = slotColors(PALETTES[state.settings.palette]).at(-1)!;
    const busiest = row.authors[0]?.commits || 1;
    const since = owners.since ? `commits since ${MONTH.format(owners.since)}` : 'commits';
    return [
      h('h3', { class: 'h' }, row.authors.length ? `Top authors · ${since}` : 'Owners'),
      row.authors.length
        ? h(
            'ul',
            { class: 'langs', 'aria-label': 'Top authors' },
            ...row.authors.map(({ name, commits }) => {
              const c = entries.find((e) => e.label === name)?.color ?? rest;
              return h(
                'li',
                {},
                h('i', { class: 'swatch', style: `--c:${c}` }),
                h('span', { title: name }, name),
                h(
                  'span',
                  { class: 'bar-track', 'aria-hidden': 'true' },
                  h('i', { style: `width:${Math.max(3, (commits / busiest) * 100)}%;--c:${c}` }),
                ),
                h('span', { class: 'num', title: plural(commits, 'commit') }, count(commits)),
              );
            }),
          )
        : null,
      row.codeowners.length
        ? h('p', { class: 'more' }, `CODEOWNERS: ${row.codeowners.join(', ')}`)
        : null,
    ];
  };

  const renderDetail = (state: AppState) => {
    const { repo, selection, highlight } = state;
    sheetClear.hidden = !selection && highlight === null;
    sheetClear.setAttribute('aria-label', selection ? 'Clear selection' : 'Clear highlight');
    const entry = view.legend().find((e) => e.label === highlight);
    if (repo && entry) {
      detail.hidden = true;
      sheetTitle.textContent = shownLabel(state, entry.label);
      sheetStat.textContent = `${plural(entry.files, 'file')} highlighted`;
      return;
    }
    if (!repo || !selection) {
      detail.hidden = true;
      sheetTitle.textContent = 'Folders and leaf colors';
      sheetStat.textContent = repo
        ? `${plural(childrenOf(repo, 0).length, 'top-level folder')} · ${plural(repo.index.langs.filter((l) => l !== 'Other').length, 'language')}`
        : '';
      return;
    }
    const { folder, file } = selection;
    const { path } = repo.tree.folders;
    const { parent, files, bytes: size, langs } = repo.index.folders;
    const repoName = repo.info.ref.repo;
    const ancestors: number[] = [];
    for (let a = parent[folder]!; a >= 0; a = parent[a]!) ancestors.unshift(a);
    const label = (f: number) => (f === 0 ? repoName : nameOf(path[f]!));
    const sep = () => h('em', {}, '/');
    const subs = childrenOf(repo, folder);
    const colors = langColors(repo, state.settings.palette);
    const rest = slotColors(PALETTES[state.settings.palette]).at(-1)!;
    const branch = repo.info.branch;

    const crumbs = h(
      'nav',
      { class: 'crumbs', 'aria-label': 'Folder path' },
      ...ancestors.flatMap((a) => [
        h(
          'button',
          { type: 'button', onclick: () => pick(a), title: `Select ${path[a] || repoName}` },
          label(a),
        ),
        sep(),
      ]),
      h('strong', { 'aria-current': 'location' }, label(folder)),
    );

    const topLangs = Array.from({ length: TOP_LANGS }, (_, k) => ({
      lang: langs[(folder * TOP_LANGS + k) * 2]!,
      n: langs[(folder * TOP_LANGS + k) * 2 + 1]!,
    })).filter((l) => l.lang >= 0);

    let fileCard: HTMLElement | null = null;
    if (file !== undefined) {
      const filePath = repo.index.files.paths[file]!;
      fileCard = h(
        'div',
        { class: 'file-card' },
        h('code', {}, nameOf(filePath)),
        h('span', {}, `${langOf(filePath)} · ${bytes(repo.index.files.size[file]!)}`),
        h(
          'a',
          {
            class: 'btn',
            href: githubUrl(repo.info.ref, branch, filePath, 'blob'),
            target: '_blank',
            rel: 'noopener',
          },
          'Open file on GitHub',
          icon(...ICONS.external),
        ),
      );
    }

    fill(
      detail,
      h(
        'button',
        {
          type: 'button',
          class: 'close',
          'aria-label': 'Clear selection',
          onclick: () => app.select(null),
        },
        icon(...ICONS.close),
      ),
      crumbs,
      fileCard,
      h(
        'div',
        { class: 'detail-head' },
        h('b', {}, plural(files[folder]!, 'file')),
        h(
          'span',
          {},
          [
            subs.length ? plural(subs.length, 'subfolder') : 'No subfolders',
            bytes(size[folder]!),
          ].join(' · '),
        ),
      ),
      topLangs.length
        ? h(
            'ul',
            { class: 'langs', 'aria-label': 'Top languages' },
            ...topLangs.map(({ lang, n }) => {
              const name = repo.index.langs[lang]!;
              const c = colors.get(name) ?? rest;
              return h(
                'li',
                {},
                h('i', { class: 'swatch', style: `--c:${c}` }),
                h('span', {}, name),
                h(
                  'span',
                  { class: 'bar-track', 'aria-hidden': 'true' },
                  h('i', { style: `width:${(n / files[folder]!) * 100}%;--c:${c}` }),
                ),
                h('span', { class: 'num' }, percent(n, files[folder]!)),
              );
            }),
          )
        : null,
      ...ownerCard(state, folder),
      subs.length ? h('h3', { class: 'h' }, 'Largest subfolders') : null,
      subs.length
        ? h(
            'ul',
            { class: 'subs' },
            ...subs.slice(0, SUB_ROWS).map((s) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', onclick: () => pick(s) },
                  h('span', { class: 'fn' }, `${nameOf(path[s]!)}/`),
                  h(
                    'span',
                    { class: 'bar-track', 'aria-hidden': 'true' },
                    h('i', {
                      style: `width:${Math.max(3, (files[s]! / files[subs[0]!]!) * 100)}%;--c:var(--ink)`,
                    }),
                  ),
                  h('span', { class: 'num' }, count(files[s]!)),
                ),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'actions' },
        h(
          'a',
          {
            class: 'btn dark',
            href: githubUrl(repo.info.ref, branch, path[folder]),
            target: '_blank',
            rel: 'noopener',
          },
          'Open on GitHub',
          icon(...ICONS.external),
        ),
        folder === 0
          ? null
          : h(
              'button',
              { type: 'button', class: 'btn', onclick: () => view.frameFolder(folder) },
              'Zoom in',
            ),
      ),
    );
    detail.setAttribute('aria-label', `Pinned folder ${path[folder] || repoName}`);
    detail.hidden = false;
    sheetTitle.textContent = `${label(folder)}/`;
    sheetStat.textContent = [
      plural(files[folder]!, 'file'),
      ancestors.length > 1 ? `in ${path[parent[folder]!]}/` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const render = (state: AppState, prev?: AppState) => {
    if (!state.repo) return;
    const repoChanged = state.repo !== prev?.repo;
    const colorsChanged =
      repoChanged ||
      state.settings.palette !== prev?.settings.palette ||
      state.settings.colorBy !== prev?.settings.colorBy ||
      state.history !== prev?.history;
    if (colorsChanged || state.selection !== prev?.selection) renderFolders(state);
    const focusChanged = state.selection !== prev?.selection || state.highlight !== prev?.highlight;
    if (colorsChanged) renderLegend(state);
    if (colorsChanged || focusChanged) {
      markLegend(state);
      renderDetail(state);
    }
    if (repoChanged && !state.selection) side.scrollTop = 0;
  };
  store.subscribe(render);
  render(store.get());
}
