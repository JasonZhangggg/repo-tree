import type { App } from '../app';
import { nameOf } from '../app';
import { debug } from '../debug';
import { byId, h } from '../dom';
import { bytes, count, plural } from '../format';
import { relaxLabels } from '../labels';
import type { AppState, Repo, Selection } from '../state';
import type { Picked } from '../../render/tree-view';

const LABELS = 6;
const TAP_SLOP = 6;

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
export function mountCanvas(app: App): { mark(folder: number | null): void } {
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

  type Pill = { el: HTMLButtonElement; folder: number; width: number };
  let pills: Pill[] = [];

  const buildLabels = (state: AppState) => {
    const repo = state.repo!;
    const top = [...repo.tree.labels].sort((a, b) => b.files - a.files).slice(0, LABELS);
    pills = top.map(({ folder, files }) => {
      const el = h(
        'button',
        {
          type: 'button',
          class: 'pill',
          tabindex: '-1',
          onclick: () => app.select({ folder }, true),
          onpointerenter: () => setHovered({ folder }),
          onpointerleave: () => setHovered(null),
        },
        h('span', {}, nameOf(repo.tree.folders.path[folder]!)),
        h('b', {}, count(files)),
      );
      return { el, folder, width: 0 };
    });
    layer.replaceChildren(...pills.map((p) => p.el));
    for (const pill of pills) pill.width = pill.el.offsetWidth;
  };

  const mark = (folder: number | null) => {
    for (const pill of pills) pill.el.classList.toggle('on', pill.folder === folder);
  };

  view.onFrame(({ labels }) => {
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
    const anchors = shown.map((p) => ({
      x: at.get(p.folder)!.x,
      y: at.get(p.folder)!.y,
      width: p.width,
    }));
    const placed = relaxLabels(anchors);
    for (const pill of pills) pill.el.hidden = !shown.includes(pill);
    shown.forEach((pill, i) => {
      const { x, y } = placed[i]!;
      pill.el.style.transform = `translate(${x - pill.width / 2}px, ${y - 14}px)`;
      pill.el.style.setProperty('--stem', `${Math.max(0, anchors[i]!.y - y - 14)}px`);
    });
  });

  store.subscribe((state, prev) => {
    if (state.repo && state.repo !== prev.repo) {
      setHovered(null);
      tip.hidden = true;
      buildLabels(state);
      layer.style.opacity = '0';
    }
    if (state.settings.labels !== prev.settings.labels) layer.hidden = !state.settings.labels;
  });
  layer.hidden = !store.get().settings.labels;

  return { mark };
}
