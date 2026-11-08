import { langOf } from '../../repo/languages';
import { leafMapping, PALETTES, slotColors, type PaletteId } from '../../render/palette';
import { litColor } from '../../render/color';
import { TOP_LANGS } from '../../load/repo-index';
import { githubUrl, nameOf, type App } from '../app';
import { byId, fill, h, icon, ICONS } from '../dom';
import { bytes, count, percent, plural } from '../format';
import { NO_OWNER, type Owners } from '../../timeline/owners';
import { companionsOf, factsOf, type AppState, type Repo } from '../state';
import type { Loaded } from '../../load/load-in-worker';
import { colorByPicker } from './color-by';
import { springTo, type Run } from './spring';
import { band, project, pushSample, releaseVelocity, type Sample } from '../../render/momentum';

const FOLDER_ROWS = 10;
const MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Why the history is not in yet, or null once it is. */
function historyWait(state: AppState): string | null {
  if (factsOf(state)) return null;
  const status = state.history?.repo === state.repo ? state.history?.status : 'loading';
  if (status === 'missing') return 'No history for this repo yet. Open the timeline to compute it.';
  if (status === 'unavailable') return 'History is unavailable for this repo.';
  return 'Loading history…';
}

/** Why activity or owner colors are not on yet, or null once they are (or not asked for). */
const colorWait = (state: AppState): string | null =>
  state.settings.colorBy === 'activity' ||
  state.settings.colorBy === 'changes' ||
  state.settings.colorBy === 'owner'
    ? historyWait(state)
    : null;

const SUB_ROWS = 5;
/** Hottest files listed under the legend. */
const HOT_ROWS = 5;
/** A file's name with its folder, so `package.json` in two packages tells apart. */
const tail = (path: string) => {
  const parts = path.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
};

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
export function childrenOf(repo: Loaded, folder: number): number[] {
  const { parent, files } = repo.index.folders;
  const kids: number[] = [];
  for (let f = folder + 1; f < parent.length; f++) if (parent[f] === folder) kids.push(f);
  return kids.sort((a, b) => files[b]! - files[a]!);
}

function langColors(repo: Loaded, palette: PaletteId): Map<string, string> {
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
/** How far the sheet gives past open or shut under a finger (px). */
const SHEET_GIVE = 36;
/** How quickly a thrown sheet would slow on its own, per ms: what decides where a throw lands. */
const SHEET_DECELERATION = 0.995;

/**
 * On a phone the sheet follows a finger dragged up or down from its handle, or down from its
 * content once that is scrolled to the top, and snaps open or closed on release. While a drag
 * or the spring after it runs, the sheet carries `data-dragging` and its content shows.
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
    /** The sheet's offset where the finger took it: closed or open, or wherever it was caught. */
    from: number;
    wasOpen: boolean;
    fromBody: boolean;
    samples: Sample[];
    travel: number;
    dragging: boolean;
    /** Taken while still moving: a press that then barely moves turns it back, as a tap would. */
    caught: boolean;
  };
  let press: Press | null = null;
  let swallowClick = false;
  /** The spring a release hands the sheet to, until it rests open or shut. */
  let settle: { run: Run; open: boolean; travel: number } | null = null;

  // Past open or past shut the sheet gives a little under the finger instead of stopping dead.
  const offsetFor = (p: Press, y: number) => band(p.from + y - p.y0, 0, p.travel, SHEET_GIVE);
  // The bar's controls ride on the sheet on a phone (main.ts moves them in).
  const controls = document.querySelector<HTMLElement>('.controls');
  /**
   * Moves the sheet by its own transform, and fades the bar's controls with how shut it is.
   * Written on the elements themselves: a custom property on the sheet restyled all it holds.
   */
  const show = (offset: number, travel: number) => {
    side.style.transform = `translateY(${offset}px)`;
    if (controls) {
      controls.style.opacity = String(travel ? Math.min(1, Math.max(0, offset / travel)) : 0);
    }
  };
  const finish = (open: boolean) => {
    settle = null;
    side.style.removeProperty('transform');
    controls?.style.removeProperty('opacity');
    body.style.animation = open ? 'none' : '';
    setOpen(open);
    // Let the sheet land while transitions are still off: dropping `data-dragging` first started
    // a transition back from the drag's offset, which held the sheet there until the next frame.
    void side.offsetHeight;
    side.removeAttribute('data-dragging');
    markTop();
  };
  /** Hands the sheet to a spring toward open or shut, at `velocity` px/s. */
  const springOpen = (
    from: number,
    open: boolean,
    travel: number,
    velocity: number,
    response: number,
    damping = 1,
  ) => {
    const run = springTo(
      from,
      open ? 0 : travel,
      velocity,
      (y) => show(y, travel),
      () => finish(open),
      { response, damping },
    );
    settle = { run, open, travel };
  };

  /** Lets the content scroll natively except a downward drag from its top, which closes the sheet. */
  const markTop = () => body.toggleAttribute('data-top', body.scrollTop <= 0);
  body.addEventListener('scroll', markTop, { passive: true });
  /**
   * A tap on the bar slides the sheet open or shut with a spring, without bounce (a tap throws
   * nothing), from wherever it is if it is still moving. Shutting is quicker than opening.
   */
  toggle.addEventListener('click', () => {
    const open = settle ? !settle.open : !side.hasAttribute('data-open');
    requestAnimationFrame(markTop);
    if (!phone.matches || reduce.matches) {
      settle?.run.stop();
      finish(open);
      body.style.animation = '';
      return;
    }
    let from: number;
    let travel: number;
    if (settle) {
      from = settle.run.stop();
      travel = settle.travel;
    } else {
      body.style.animation = 'none';
      side.setAttribute('data-dragging', '');
      travel = body.offsetHeight;
      from = open ? travel : 0;
      show(from, travel);
    }
    springOpen(from, open, travel, 0, open ? 0.42 : 0.32);
  });
  markTop();

  side.addEventListener('pointerdown', (event) => {
    if (!phone.matches || press || !event.isPrimary || event.button > 0) return;
    const target = event.target as Element;
    const fromBody = body.contains(target);
    if (!fromBody && !toggle.contains(target)) return;
    // A sheet still moving is caught where it is, and follows the finger from there. Speed is
    // read from moves alone: a press can carry a different clock than the moves after it.
    if (settle) {
      const from = settle.run.stop();
      const { open, travel } = settle;
      settle = null;
      show(from, travel);
      side.setPointerCapture(event.pointerId);
      swallowClick = true;
      press = {
        id: event.pointerId,
        y0: event.clientY,
        from,
        wasOpen: open,
        fromBody,
        samples: [],
        travel,
        dragging: true,
        caught: true,
      };
      return;
    }
    if (fromBody && (!side.hasAttribute('data-open') || body.scrollTop > 0)) return;
    swallowClick = false;
    press = {
      id: event.pointerId,
      y0: event.clientY,
      from: 0,
      wasOpen: side.hasAttribute('data-open'),
      fromBody,
      samples: [],
      travel: 0,
      dragging: false,
      caught: false,
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
      p.from = p.wasOpen ? 0 : p.travel;
      p.dragging = true;
      p.y0 += Math.sign(dy) * DRAG_SLOP;
      side.setPointerCapture(p.id);
    }
    // A slow frame folds several moves into one event; each still says how fast the finger went.
    for (const e of event.getCoalescedEvents?.() ?? [event]) {
      pushSample(p.samples, { at: e.clientY, t: e.timeStamp });
    }
    show(offsetFor(p, event.clientY), p.travel);
  });

  /**
   * A release throws the sheet: where its speed would carry it decides open or shut (a quick
   * flick goes the way it was flung), and a spring takes it there at the finger's own speed,
   * overshooting a touch when it was flung.
   */
  const release = (event: PointerEvent) => {
    const p = press;
    if (!p || event.pointerId !== p.id) return;
    press = null;
    if (!p.dragging) return;
    swallowClick = true;
    pushSample(p.samples, { at: event.clientY, t: event.timeStamp });
    const velocity = releaseVelocity(p.samples, event.timeStamp);
    const offset = offsetFor(p, event.clientY);
    const landing = offset + project(velocity, SHEET_DECELERATION);
    const moved = p.wasOpen ? landing : p.travel - landing;
    const flung = Math.abs(velocity) > FLICK;
    const tapped = p.caught && Math.abs(event.clientY - p.y0) < DRAG_SLOP;
    const open =
      event.type === 'pointercancel'
        ? p.wasOpen
        : tapped
          ? !p.wasOpen
          : flung
            ? velocity < 0
            : moved > Math.min(SWITCH.px, p.travel * SWITCH.share)
              ? !p.wasOpen
              : p.wasOpen;
    const goal = open ? 0 : p.travel;
    if (reduce.matches || (Math.abs(goal - offset) < 1 && Math.abs(velocity) < 0.05)) {
      finish(open);
      return;
    }
    // A throw lands with a touch of bounce; a sheet that stays put snaps back quickly.
    springOpen(
      offset,
      open,
      p.travel,
      velocity * 1000,
      open === p.wasOpen ? 0.3 : 0.4,
      flung ? 0.82 : 1,
    );
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
  /** Color leaves by, at the top of the side panel: the same dropdown as in Settings. */
  /** The folder row and legend row the mouse last moved over, so a move hovers each once. */
  let hoveredFolder: number | null = null;
  let hoveredLabel: string | null = null;
  const colorBy = colorByPicker('side-color-pick', (colorBy) =>
    store.dispatch({ type: 'settings', patch: { colorBy } }),
  );
  byId('color-by').replaceChildren(h('h2', { class: 'h' }, 'Color leaves by'), colorBy.element);
  const legendNote = byId('legend-note');
  const hot = byId('hot');
  const hotNote = byId('hot-note');
  const hotFiles = byId('hot-files');
  const detail = byId('detail');

  const setOpen = (open: boolean) => {
    side.toggleAttribute('data-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
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
    // Languages take the leaves' colors, which rank across both trees while comparing.
    const byFolder = new Map(view.legend().map((e) => [e.label, e.color]));
    const rest = slotColors(PALETTES[state.settings.palette]).at(-1)!;
    const byLang =
      state.settings.colorBy === 'language' ? byFolder : langColors(repo, state.settings.palette);
    const { files, langs } = repo.index.folders;
    const tops = childrenOf(repo, 0);
    const most = files[tops[0] ?? 0] || 1;
    const facts = state.settings.colorBy === 'activity' ? factsOf(state) : null;
    const changes = state.settings.colorBy === 'changes' ? factsOf(state) : null;
    const owners = ownersOf(state);
    const bands = view.legend();
    // An owner past the named entries is in the last, "N more", entry.
    const ownerColor = (f: number) =>
      (bands.find((e) => e.label === ownerLabel(owners!, repo, f)) ?? bands.at(-1))?.color ?? rest;
    const colorOf = (f: number) =>
      facts
        ? bands[facts.folderBand[f]!]!.color
        : changes
          ? bands[changes.folderChangeBand[f]!]!.color
          : state.settings.colorBy === 'folder'
            ? (byFolder.get(repo.tree.folders.path[f]!) ?? rest)
            : (byLang.get(repo.index.langs[langs[f * TOP_LANGS * 2]!]!) ?? rest);
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
              // Moves, not pointerenter: the browser fires enter when a row slides under a
              // still pointer (the Color leaves by menu closing over it), which would preview
              // a folder nobody pointed at and flash the tree.
              onpointermove: () => {
                if (hoveredFolder === f) return;
                hoveredFolder = f;
                app.hover(f);
              },
              onpointerleave: () => {
                hoveredFolder = null;
                app.hover(null);
              },
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
          : state.settings.colorBy === 'activity' && factsOf(state)
            ? 'Leaf colors by activity'
            : state.settings.colorBy === 'changes' && factsOf(state)
              ? 'Leaf colors by changes'
              : 'Leaf colors by language';
    legend.replaceChildren(
      // While comparing, the legend has the other tree's languages too, with none of their files here.
      ...entries
        .filter((e) => e.files > 0)
        .map(({ color, label, files }) =>
          h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                'data-label': label,
                onclick: () => {
                  hoveredLabel = null;
                  app.hoverCategory(null);
                  app.highlight(store.get().highlight === label ? null : label);
                },
                onpointermove: (event: PointerEvent) => {
                  if (event.pointerType !== 'mouse' || hoveredLabel === label) return;
                  hoveredLabel = label;
                  app.hoverCategory(label);
                },
                onpointerleave: () => {
                  hoveredLabel = null;
                  app.hoverCategory(null);
                },
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
    const changes = state.settings.colorBy === 'changes' ? factsOf(state) : null;
    legendNote.textContent = entry
      ? `${shownLabel(state, entry.label)} · ${plural(entry.files, 'file')}`
      : (colorWait(state) ??
        (facts
          ? `Last change, as of ${MONTH.format(facts.asOf)}. Dead wood is 3+ years untouched; pick a color to highlight its leaves.`
          : changes
            ? `How often each file changed, as of ${MONTH.format(changes.asOf)}. Pick a color to highlight its leaves.`
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

  /**
   * Under the Changes legend: how many files glow, and the busiest, each pinning its folder.
   * Their swatch is the gradient's busiest stop.
   */
  const renderHot = (state: AppState) => {
    hot.hidden = state.settings.colorBy !== 'changes';
    if (hot.hidden) return;
    const palette = PALETTES[state.settings.palette];
    const swatch = litColor(palette.changes[0], palette);
    const repo = state.repo!;
    const facts = factsOf(state);
    const n = facts?.hot.length ?? 0;
    hotNote.textContent =
      historyWait(state) ??
      (n === 0
        ? 'No file has changed often enough to glow yet.'
        : n === 1
          ? 'The busiest file glows, from commit history.'
          : `The ${count(n)} busiest files glow, from commit history.`);
    const { paths, folder } = repo.index.files;
    hotFiles.replaceChildren(
      ...Array.from(facts?.hot.slice(0, HOT_ROWS) ?? [], (file) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              'data-file': file,
              'aria-current': String(state.selection?.file === file),
              title: paths[file]!,
              onclick: () => app.select({ folder: folder[file]!, file }, true),
            },
            h('i', { class: 'swatch', style: `--c:${swatch}` }),
            h('span', { class: 'fn' }, tail(paths[file]!)),
            h(
              'span',
              { class: 'num', title: 'Snapshots it changed in, plus recent commits' },
              count(facts!.fileChurn[file]!),
            ),
          ),
        ),
      ),
    );
  };

  const renderDetail = (state: AppState) => {
    const { repo, selection, highlight } = state;
    // A folder pinned on a compared tree shows here as one on the tree on show does.
    const held = selection ? null : app.companionPin();
    const other = held ? companionsOf(state)[held.companion] : undefined;
    const pinned = !!selection || !!other;
    sheetClear.hidden = !pinned && highlight === null;
    sheetClear.setAttribute('aria-label', pinned ? 'Clear selection' : 'Clear highlight');
    const entry = view.legend().find((e) => e.label === highlight);
    if (repo && entry) {
      detail.hidden = true;
      sheetTitle.textContent = shownLabel(state, entry.label);
      sheetStat.textContent = `${plural(entry.files, 'file')} highlighted`;
      return;
    }
    if (repo && !pinned && state.compare.length) {
      // While comparing, the sheet holds the two trees side by side (compare.ts).
      detail.hidden = true;
      sheetTitle.textContent = 'Compare';
      sheetStat.textContent = [repo.info.ref, ...state.compare].map((r) => r.repo).join(', ');
      return;
    }
    if (!repo || !pinned) {
      detail.hidden = true;
      sheetTitle.textContent = 'Folders and leaf colors';
      sheetStat.textContent = repo
        ? `${plural(childrenOf(repo, 0).length, 'top-level folder')} · ${plural(repo.index.langs.filter((l) => l !== 'Other').length, 'language')}`
        : '';
      return;
    }
    const tree: Loaded = other ?? repo;
    const { folder, file } = selection ?? { folder: held!.folder, file: undefined };
    /** Picks a folder of the same tree: a crumb or a subfolder. */
    const pickHere = other
      ? (f: number) => app.pinCompanion({ companion: held!.companion, folder: f })
      : pick;
    const clear = () => (other ? app.pinCompanion(null) : app.select(null));
    const { path } = tree.tree.folders;
    const { parent, files, bytes: size, langs } = tree.index.folders;
    const repoName = tree.info.ref.repo;
    const ancestors: number[] = [];
    for (let a = parent[folder]!; a >= 0; a = parent[a]!) ancestors.unshift(a);
    const label = (f: number) => (f === 0 ? repoName : nameOf(path[f]!));
    const sep = () => h('em', {}, '/');
    const subs = childrenOf(tree, folder);
    const colors = langColors(tree, state.settings.palette);
    const rest = slotColors(PALETTES[state.settings.palette]).at(-1)!;
    const branch = tree.info.branch;

    const crumbs = h(
      'nav',
      { class: 'crumbs', 'aria-label': 'Folder path' },
      ...ancestors.flatMap((a) => [
        h(
          'button',
          { type: 'button', onclick: () => pickHere(a), title: `Select ${path[a] || repoName}` },
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
      const filePath = tree.index.files.paths[file]!;
      fileCard = h(
        'div',
        { class: 'file-card' },
        h('code', {}, nameOf(filePath)),
        h('span', {}, `${langOf(filePath)} · ${bytes(tree.index.files.size[file]!)}`),
        h(
          'a',
          {
            class: 'btn',
            href: githubUrl(tree.info.ref, branch, filePath, 'blob'),
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
          onclick: clear,
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
              const name = tree.index.langs[lang]!;
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
      ...(other ? [] : ownerCard(state, folder)),
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
                  { type: 'button', onclick: () => pickHere(s) },
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
            href: githubUrl(tree.info.ref, branch, path[folder]),
            target: '_blank',
            rel: 'noopener',
          },
          'Open on GitHub',
          icon(...ICONS.external),
        ),
        folder === 0 || other
          ? null
          : h(
              'button',
              // Through select, so clearing the pin later glides back out.
              {
                type: 'button',
                class: 'btn',
                onclick: () => app.select(store.get().selection, true),
              },
              'Zoom in',
            ),
      ),
    );
    const where = other ? `${tree.info.ref.owner}/${tree.info.ref.repo}/` : '';
    detail.setAttribute('aria-label', `Pinned folder ${where}${path[folder] || repoName}`);
    detail.hidden = false;
    if (file !== undefined) {
      // A pinned file (a rock, or a busy file) names itself in the sheet's peek, not its folder.
      const filePath = tree.index.files.paths[file]!;
      sheetTitle.textContent = nameOf(filePath);
      sheetStat.textContent = [
        langOf(filePath),
        bytes(tree.index.files.size[file]!),
        `in ${folder === 0 ? repoName : path[folder]}/`,
      ].join(' · ');
      return;
    }
    sheetTitle.textContent = `${label(folder)}/`;
    sheetStat.textContent = [
      // While comparing, say first which tree it is on.
      state.compare.length ? `on ${tree.info.ref.repo}` : null,
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
      state.history !== prev?.history ||
      // A compared tree's languages rank with this one's, which moves their colors.
      state.companions !== prev?.companions ||
      state.timeline !== prev?.timeline;
    if (colorsChanged || state.selection !== prev?.selection) renderHot(state);
    if (colorsChanged || state.selection !== prev?.selection) renderFolders(state);
    const focusChanged =
      state.selection !== prev?.selection ||
      state.highlight !== prev?.highlight ||
      state.compare !== prev?.compare;
    if (colorsChanged) {
      colorBy.render(state.settings.colorBy);
      renderLegend(state);
    }
    if (colorsChanged || focusChanged) {
      markLegend(state);
      renderDetail(state);
    }
    if (repoChanged && !state.selection) side.scrollTop = 0;
  };
  store.subscribe(render);
  app.onCompanionPin(() => renderDetail(store.get()));
  render(store.get());
}
