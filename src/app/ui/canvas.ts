import type { App } from '../app';
import { nameOf } from '../app';
import { debug } from '../debug';
import { byId, h } from '../dom';
import { bytes, count, plural } from '../format';
import { pickLabels, relaxLabels, type LabelPick } from '../labels';
import type { AppState, Repo, Selection } from '../state';
import type { Picked } from '../../render/tree-view';

const TAP_SLOP = 6;
/** Panels over the canvas that labels keep off. */
const PANELS = '.bar, .title, .side, .controls';

/** The root folder's own files a rock lies for, as indices into RepoIndex.files. */
const rockFiles = (repo: Repo, rock: number) =>
  repo.tree.rocks[rock]!.files.map((i) => repo.index.folders.own[0]! + i);

/** A rock pins the root folder with its file shown, or plainly when it holds several. */
const selectionOf = (repo: Repo, { folder, rock }: Picked): Selection => {
  if (rock === undefined) return { folder };
  const files = rockFiles(repo, rock);
  return files.length === 1 ? { folder, file: files[0]! } : { folder };
};

/** Pointer picking on the tree, the hover tooltip, and the folder labels that follow limbs. */
export function mountCanvas(app: App): {
  mark(folder: number | null): void;
  /** Shows each label's file count at a timeline date, or the counts today when null. */
  setCounts(counts: ReadonlyMap<number, number> | null): void;
} {
  const { store, view } = app;
  const container = byId('view');
  const tip = byId('tip');
  const layer = byId('labels');

  let hovered: Picked | null = null;
  let pointer: { x: number; y: number; clientX: number; clientY: number } | null = null;
  let pending = false;
  let down: { x: number; y: number } | null = null;

  const setHovered = (picked: Picked | null) => {
    if (picked?.folder === hovered?.folder && picked?.rock === hovered?.rock) return;
    hovered = picked;
    const folder = picked?.folder ?? null;
    const repo = store.get().repo;
    debug.hovered = folder === null || !repo ? null : repo.tree.folders.path[folder]!;
    document.body.dataset.hovered = debug.hovered ?? '';
    app.hover(folder);
    container.style.cursor = folder === null ? '' : 'pointer';
  };

  const showTip = (picked: Picked | null) => {
    const repo = store.get().repo;
    if (picked === null || !pointer || !repo) {
      tip.hidden = true;
      return;
    }
    const { folder, rock } = picked;
    const selection = store.get().selection;
    const pin = selectionOf(repo, picked);
    const pinned = selection?.folder === pin.folder && selection.file === pin.file;
    const hint = pinned ? '' : ' · click to pin';
    if (rock === undefined) {
      const path = repo.tree.folders.path[folder]!;
      tip.replaceChildren(
        h('code', {}, path ? `${path}/` : `${repo.info.ref.repo}/`),
        h('span', {}, `${plural(repo.index.folders.files[folder]!, 'file')}${hint}`),
      );
    } else {
      const files = rockFiles(repo, rock);
      const size = bytes(repo.tree.rocks[rock]!.bytes);
      tip.replaceChildren(
        h(
          'code',
          {},
          files.length === 1 ? repo.index.files.paths[files[0]!]! : `${repo.info.ref.repo}/`,
        ),
        h(
          'span',
          {},
          files.length === 1
            ? `${size}${hint}`
            : `${plural(files.length, 'more file')} · ${size}${hint}`,
        ),
      );
    }
    tip.hidden = false;
    const x = Math.min(pointer.clientX + 16, innerWidth - tip.offsetWidth - 12);
    const y = Math.min(pointer.clientY + 18, innerHeight - tip.offsetHeight - 12);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };

  const probe = () => {
    pending = false;
    const picked = pointer ? view.pickAt(pointer.x, pointer.y) : null;
    setHovered(picked);
    showTip(picked);
  };

  container.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || event.buttons) {
      tip.hidden = true;
      return;
    }
    const rect = container.getBoundingClientRect();
    pointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (!pending) {
      pending = true;
      requestAnimationFrame(probe);
    }
  });
  container.addEventListener('pointerleave', () => {
    pointer = null;
    probe();
  });
  container.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY };
  });
  container.addEventListener('pointerup', (event) => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_SLOP) return;
    down = null;
    const rect = container.getBoundingClientRect();
    const picked = view.pickAt(event.clientX - rect.left, event.clientY - rect.top);
    const repo = store.get().repo;
    tip.hidden = true;
    app.select(picked === null || !repo ? null : selectionOf(repo, picked));
  });

  /**
   * A stem is its own element, moved, turned and stretched by transform alone: resizing a stem
   * drawn inside its pill repainted the pill every spin frame, about a sixth of each frame's cost.
   */
  type Pill = {
    el: HTMLButtonElement;
    stem: HTMLElement;
    /** Marks where the stem meets the branch. */
    dot: HTMLElement;
    folder: number;
    files: number;
    tier: LabelPick['tier'];
    count: HTMLElement;
    width: number;
    height: number;
  };
  let pills: Pill[] = [];
  let labeledFor: { repo: Repo; folder: number | null } | null = null;

  /** The pinned folder's own subfolders, when it is not the root. */
  const childrenOf = (repo: Repo, folder: number | null) => {
    if (folder === null || folder === 0) return [];
    const { parent, files } = repo.index.folders;
    const children: { folder: number; files: number }[] = [];
    for (let f = folder + 1; f < parent.length; f++) {
      if (parent[f] === folder) children.push({ folder: f, files: files[f]! });
    }
    return children;
  };

  const buildLabels = (state: AppState) => {
    const repo = state.repo!;
    const pinned = state.selection?.folder ?? null;
    if (labeledFor?.repo === repo && labeledFor.folder === pinned) return;
    labeledFor = { repo, folder: pinned };
    const picks = pickLabels(
      repo.tree.labels,
      childrenOf(repo, pinned),
      pinned === null ? 0 : repo.index.folders.files[pinned]!,
    );
    const pinnedPath = pinned === null ? null : repo.tree.folders.path[pinned]!;
    const aside = (folder: number) => {
      if (!pinnedPath) return false;
      const path = repo.tree.folders.path[folder]!;
      return pinnedPath !== path && !pinnedPath.startsWith(`${path}/`);
    };
    pills = picks.map(({ folder, files, tier }) => {
      const tally = h('b', {}, count(files));
      const el = h(
        'button',
        {
          type: 'button',
          class: `pill ${tier}${tier !== 'sub' && aside(folder) ? ' aside' : ''}`,
          tabindex: '-1',
          onclick: () => app.select({ folder }, true),
          onpointerenter: () => setHovered({ folder }),
          onpointerleave: () => setHovered(null),
        },
        h('span', {}, nameOf(repo.tree.folders.path[folder]!), h('i', {}, '/')),
        tally,
      );
      return {
        el,
        stem: h('i', { class: 'stem' }),
        dot: h('i', { class: 'dot' }),
        folder,
        files,
        tier,
        count: tally,
        width: 0,
        height: 0,
      };
    });
    layer.replaceChildren(...pills.flatMap((p) => [p.stem, p.dot]), ...pills.map((p) => p.el));
    for (const pill of pills) {
      pill.width = pill.el.offsetWidth;
      pill.height = pill.el.offsetHeight;
    }
    view.setLabelFolders(pills.map((p) => p.folder));
    mark(marked);
  };

  let marked: number | null = null;
  const mark = (folder: number | null) => {
    marked = folder;
    for (const pill of pills) pill.el.classList.toggle('on', pill.folder === folder);
  };

  view.onFrame(({ labels, crown }) => {
    const repo = store.get().repo;
    if (!repo) return;
    debug.labels = labels.map(({ folder, x, y }) => ({
      path: repo.tree.folders.path[folder]!,
      x,
      y,
    }));
    if (!store.get().settings.labels || pills.length === 0) return;
    const at = new Map(labels.map((l) => [l.folder, l]));
    const shown = pills.filter((p) => at.get(p.folder)?.visible);
    layer.style.opacity = shown.length ? '1' : '0';
    for (const pill of pills) {
      pill.el.hidden = pill.stem.hidden = pill.dot.hidden = !shown.includes(pill);
    }
    for (const pill of shown) {
      if (pill.width < 0) pill.width = pill.el.offsetWidth;
      const back = !at.get(pill.folder)!.front;
      if (pill.el.classList.contains('back') !== back) {
        pill.el.classList.toggle('back', back);
        pill.stem.classList.toggle('back', back);
        pill.dot.classList.toggle('back', back);
      }
    }
    const anchors = shown.map((p) => {
      const { x, y, front } = at.get(p.folder)!;
      return { x, y, front, width: p.width, height: p.height };
    });
    const origin = layer.getBoundingClientRect();
    const panels = [...document.querySelectorAll<HTMLElement>(PANELS)]
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height };
      });
    const placed = relaxLabels(anchors, crown, panels);
    shown.forEach((pill, i) => {
      const { x, y } = placed[i]!;
      const a = anchors[i]!;
      const length = Math.max(0, Math.hypot(x - a.x, y - a.y) - pill.height / 2);
      const angle = Math.atan2(y - a.y, x - a.x);
      pill.el.style.transform = `translate(${x - pill.width / 2}px, ${y - pill.height / 2}px)`;
      pill.stem.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${angle}rad) scaleX(${length})`;
      pill.dot.style.transform = `translate(${a.x}px, ${a.y}px)`;
    });
  });

  store.subscribe((state, prev) => {
    if (state.repo && state.repo !== prev.repo) {
      setHovered(null);
      tip.hidden = true;
      buildLabels(state);
      layer.style.opacity = '0';
    } else if (state.repo && state.selection?.folder !== prev.selection?.folder) {
      buildLabels(state);
    }
    if (state.settings.labels !== prev.settings.labels) layer.hidden = !state.settings.labels;
  });
  layer.hidden = !store.get().settings.labels;

  const setCounts = (counts: ReadonlyMap<number, number> | null) => {
    for (const pill of pills) {
      const text = count(counts?.get(pill.folder) ?? pill.files);
      if (pill.count.textContent === text) continue;
      pill.count.textContent = text;
      pill.width = pill.el.hidden ? -1 : pill.el.offsetWidth;
    }
  };

  return { mark, setCounts };
}
