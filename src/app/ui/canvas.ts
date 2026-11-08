import type { App } from '../app';
import { nameOf } from '../app';
import { debug } from '../debug';
import { byId, h } from '../dom';
import { bytes, count, plural } from '../format';
import { pickLabels, relaxLabels, type LabelPick } from '../labels';
import { birdsOf, pullFiles } from '../birds';
import { mountCiCard } from './ci-card';
import { mountPrCard } from './pr-card';
import { companionsOf, weatherOf, type AppState, type Repo, type Selection } from '../state';
import { describeWeather } from '../weather';
import type { Picked } from '../../render/tree-view';
import type { Loaded } from '../../load/load-in-worker';

const TAP_SLOP = 6;
/** Folder labels show for the repo on show, and for no tree while several are compared. */
const labelsOn = (state: AppState) => state.settings.labels && state.compare.length === 0;
/** Panels over the canvas that labels keep off. */
const PANELS = '.bar, .title, .side, .controls, .steps';
/** How much a label straight behind the trunk shrinks, and how much its stem thins. */
const DEPTH_SHRINK = 0.15;
const STEM_THIN = 0.4;
/**
 * How quickly a label settles where the layout wants it, as a time constant in ms. Labels ride
 * their anchors exactly; only their offset from the anchor eases, so a label that the layout
 * swaps or shoves glides there instead of jumping while the camera moves.
 */
const GLIDE_MS = 90;
/** The least gap between a label and the side of the screen. */
const EDGE = 6;
const still = matchMedia('(prefers-reduced-motion: reduce)');

/** The root folder's own files a rock lies for, as indices into RepoIndex.files. */
const rockFiles = (repo: Loaded, rock: number) =>
  repo.tree.rocks[rock]!.files.map((i) => repo.index.folders.own[0]! + i);

/** A rock pins the root folder with its file shown, or plainly when it holds several. */
const selectionOf = (repo: Loaded, { folder, rock }: Picked): Selection => {
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
  const ci = mountCiCard(app);
  const pr = mountPrCard(app);
  // The CI chip explains the sky the same way before it leaves for GitHub.
  byId('weather').addEventListener('click', (event) => {
    if (ci.open()) event.preventDefault();
  });

  let hovered: Picked | null = null;
  /** The repo a pick lies on: the one on show, or a compared one. */
  const treeOf = (picked: Picked | null): Loaded | null => {
    const state = store.get();
    if (picked?.companion === undefined) return state.repo;
    return companionsOf(state)[picked.companion] ?? null;
  };
  let pointer: { x: number; y: number; clientX: number; clientY: number } | null = null;
  let pending = false;
  let down: { x: number; y: number } | null = null;

  const setHovered = (picked: Picked | null) => {
    if (
      picked?.folder === hovered?.folder &&
      picked?.rock === hovered?.rock &&
      picked?.bird === hovered?.bird &&
      picked?.companion === hovered?.companion
    ) {
      return;
    }
    hovered = picked;
    const folder = picked?.folder ?? null;
    const repo = treeOf(picked);
    debug.hovered = folder === null || !repo ? null : repo.tree.folders.path[folder]!;
    document.body.dataset.hovered = debug.hovered ?? '';
    debug.hoveredTree =
      picked?.companion === undefined || !repo
        ? null
        : `${repo.info.ref.owner}/${repo.info.ref.repo}`;
    // A bird lights its PR's files rather than its perch folder.
    const bird = picked?.bird ?? null;
    app.hover(bird === null ? folder : null, picked?.companion);
    app.showPull(bird);
    container.style.cursor = folder === null ? '' : 'pointer';
  };

  const showTip = (picked: Picked | null) => {
    const repo = treeOf(picked);
    if (picked === null || !pointer || !repo) {
      tip.hidden = true;
      return;
    }
    // A compared tree's branch names its repo too, and a click pins it there.
    if (picked.companion !== undefined) {
      const path = repo.tree.folders.path[picked.folder]!;
      const { owner, repo: name } = repo.info.ref;
      const held = app.companionPin();
      const pinned = held?.companion === picked.companion && held.folder === picked.folder;
      // Once pinned, its card names it, and the tag would sit on its label.
      if (pinned) {
        tip.hidden = true;
        return;
      }
      tip.replaceChildren(
        h('code', {}, `${owner}/${name}${path ? `/${path}` : ''}/`),
        h('span', {}, `${plural(repo.index.folders.files[picked.folder]!, 'file')} · click to pin`),
      );
      return placeTip();
    }
    const { folder, rock, bird } = picked;
    const pull = bird === undefined ? undefined : birdsOf(store.get())?.[bird]?.pull;
    if (pull) {
      tip.replaceChildren(
        h('code', {}, `#${pull.number} ${pull.title}`),
        h(
          'span',
          {},
          `${pull.author}${pull.draft ? ' · draft' : ''} · ${plural(pullFiles(pull.files, repo.index.files.paths).shown, 'changed file')} lit · click for details`,
        ),
      );
      return placeTip();
    }
    const selection = store.get().selection;
    const pin = selectionOf(repo, picked);
    const pinned = selection?.folder === pin.folder && selection.file === pin.file;
    // Once pinned, its card names it, and the tag would sit on its label.
    if (pinned) {
      tip.hidden = true;
      return;
    }
    const hint = ' · click to pin';
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
    placeTip();
  };

  const placeTip = () => {
    if (!pointer) return;
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
    // The sun and clouds open the CI card, so they light up and take a pointer too.
    const sky = !picked && pointer ? view.skyTargetAt(pointer.x, pointer.y) : null;
    container.style.cursor = picked || sky !== null ? 'pointer' : '';
    view.setHover(sky !== null ? { sky } : picked);
    if (sky !== null) showSkyTip();
  };

  /** Over the sun or a cloud, the tag says what the sky stands for, as a rock's names its file. */
  const showSkyTip = () => {
    const weather = weatherOf(store.get());
    if (!weather) return;
    const { verdict, detail } = describeWeather(weather.sky, weather.health, Date.now());
    tip.replaceChildren(
      h('code', {}, verdict),
      h('span', {}, `${detail ? `${detail} · ` : ''}click for details`),
    );
    placeTip();
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
  // A pinch is never a tap, even where its last finger lifts without moving.
  const pressed = new Set<number>();
  container.addEventListener('pointerdown', (event) => {
    pressed.add(event.pointerId);
    down = pressed.size > 1 ? null : { x: event.clientX, y: event.clientY };
  });
  container.addEventListener('pointercancel', (event) => {
    pressed.delete(event.pointerId);
    down = null;
  });
  container.addEventListener('pointerup', (event) => {
    pressed.delete(event.pointerId);
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_SLOP) return;
    down = null;
    tip.hidden = true;
    // On a touch screen a load error covers the top of the view, and a tap away puts it away
    // rather than pinning what lies under the finger.
    if (event.pointerType !== 'mouse' && store.get().load.phase === 'error') {
      store.dispatch({ type: 'dismiss-error' });
      return;
    }
    // On touch screens labels let gestures through to the tree, so a tap on one lands here.
    const pill = pillAt(event.clientX, event.clientY);
    if (pill) return app.select({ folder: pill.folder }, true);
    const rect = container.getBoundingClientRect();
    const [x, y] = [event.clientX - rect.left, event.clientY - rect.top];
    const picked = view.pickAt(x, y);
    // A tap on the sky says what it stands for, and keeps the pin as it was.
    if (picked === null && view.skyAt(x, y) && ci.open()) return;
    // A bird says which pull request it stands for, and keeps the pin as it was.
    if (picked?.bird !== undefined && pr.open(picked.bird)) return;
    // A compared tree's branch pins there, the grove kept in view: only the card's lines show
    // one tree alone.
    if (picked?.companion !== undefined) {
      app.pinCompanion({ companion: picked.companion, folder: picked.folder });
      return;
    }
    const repo = store.get().repo;
    // The rock of several files pins the root folder plainly, so it remembers it was a rock.
    pilePinned = picked?.rock !== undefined && !!repo && rockFiles(repo, picked.rock).length > 1;
    app.select(picked === null || !repo ? null : selectionOf(repo, picked));
    keepRock(store.get());
  });

  // A double click glides to the branch under it (the first click pinned it), or back out to
  // the whole tree from empty sky. A grove stays in view: its double click pins and nothing more.
  container.addEventListener('dblclick', (event) => {
    const repo = store.get().repo;
    if (!repo) return;
    const rect = container.getBoundingClientRect();
    const picked = view.pickAt(event.clientX - rect.left, event.clientY - rect.top);
    if (picked?.bird !== undefined || picked?.companion !== undefined) return;
    const comparing = store.get().compare.length > 0;
    if (picked && picked.folder !== 0) app.select(selectionOf(repo, picked), !comparing);
    else if (!picked && !view.skyAt(event.clientX - rect.left, event.clientY - rect.top)) {
      view.frameFolder(0);
    }
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
    /** Where the layout wants the label, as an offset from its anchor, and where it is now. */
    goal: { x: number; y: number };
    at: { x: number; y: number } | null;
    anchor: { x: number; y: number };
    size: number;
    thin: number;
  };
  let pills: Pill[] = [];

  /** The label under a point, front ones first, then the one drawn on top. */
  const pillAt = (x: number, y: number) => {
    if (layer.hidden) return null;
    let hit: Pill | null = null;
    for (const pill of pills) {
      if (pill.el.hidden) continue;
      const r = pill.el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (!hit || hit.el.classList.contains('back') || !pill.el.classList.contains('back')) {
        hit = pill;
      }
    }
    return hit;
  };
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
      pinned ?? undefined,
    );
    const pinnedPath = pinned === null ? null : repo.tree.folders.path[pinned]!;
    const aside = (folder: number) => {
      if (!pinnedPath) return false;
      const path = repo.tree.folders.path[folder]!;
      return pinnedPath !== path && !pinnedPath.startsWith(`${path}/`);
    };
    // A label that stays across a rebuild keeps its place, so pinning doesn't shove the rest.
    const kept = new Map(pills.map((p) => [p.folder, p.at]));
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
        goal: { x: 0, y: 0 },
        at: kept.get(folder) ?? null,
        anchor: { x: 0, y: 0 },
        size: 1,
        thin: 1,
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
    if (!labelsOn(store.get()) || pills.length === 0) return;
    const at = new Map(labels.map((l) => [l.folder, l]));
    const shown = pills.filter((p) => at.get(p.folder)?.visible);
    layer.style.opacity = shown.length ? '1' : '0';
    for (const pill of pills) {
      pill.el.hidden = pill.stem.hidden = pill.dot.hidden = !shown.includes(pill);
      if (pill.el.hidden) pill.at = null;
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
    // Labels toward the far side of the crown shrink a little, so the crown reads as round.
    const sizes = shown.map((p) => 1 - DEPTH_SHRINK * at.get(p.folder)!.depth);
    const anchors = shown.map((p, i) => {
      const { x, y, front } = at.get(p.folder)!;
      return { x, y, front, width: p.width * sizes[i]!, height: p.height * sizes[i]! };
    });
    const origin = layer.getBoundingClientRect();
    const panels = [...document.querySelectorAll<HTMLElement>(PANELS)]
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height };
      });
    const placed = relaxLabels(anchors, crown, panels, layer.clientWidth, EDGE);
    // Kept whole on screen: a label cut by the edge can't be read or tapped.
    const room = layer.clientWidth;
    shown.forEach((pill, i) => {
      const a = anchors[i]!;
      const half = a.width / 2 + EDGE;
      const x =
        room > 2 * half ? Math.min(Math.max(placed[i]!.x, half), room - half) : placed[i]!.x;
      pill.anchor = { x: a.x, y: a.y };
      pill.goal = { x: x - a.x, y: placed[i]!.y - a.y };
      pill.size = sizes[i]!;
      pill.thin = 1 - STEM_THIN * at.get(pill.folder)!.depth;
    });
    glide();
  });

  let gliding = 0;
  let lastGlide = 0;
  /** Moves each shown label toward its goal and draws it; runs on until they settle. */
  const glide = () => {
    cancelAnimationFrame(gliding);
    gliding = 0;
    const now = performance.now();
    const dt = lastGlide ? Math.min(now - lastGlide, 64) : 16;
    lastGlide = now;
    const k = still.matches ? 1 : 1 - Math.exp(-dt / GLIDE_MS);
    let moving = false;
    for (const pill of pills) {
      if (pill.el.hidden) continue;
      const { goal, anchor: a, size, thin } = pill;
      let at = pill.at;
      if (!at) at = pill.at = { ...goal };
      else {
        at.x += (goal.x - at.x) * k;
        at.y += (goal.y - at.y) * k;
        if (Math.hypot(goal.x - at.x, goal.y - at.y) > 0.3) moving = true;
        else pill.at = at = { ...goal };
      }
      const x = a.x + at.x;
      const y = a.y + at.y;
      const length = Math.max(0, Math.hypot(at.x, at.y) - (pill.height * size) / 2);
      const angle = Math.atan2(at.y, at.x);
      pill.el.style.transform = `translate(${x - pill.width / 2}px, ${y - pill.height / 2}px) scale(${size})`;
      pill.stem.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${angle}rad) scale(${length}, ${thin})`;
      pill.dot.style.transform = `translate(${a.x}px, ${a.y}px) scale(${size})`;
    }
    if (moving) gliding = requestAnimationFrame(glide);
    else lastGlide = 0;
  };

  /** Whether the pin came from a tap on the rock of several files. */
  let pilePinned = false;
  /** The rock the pin stands for: the one holding its file, or the pile tapped for it. */
  const rockOf = ({ repo, selection }: AppState): number | null => {
    if (!repo || selection?.folder !== 0) return null;
    const { rocks } = repo.tree;
    if (selection.file === undefined) {
      return pilePinned && rocks.length > 0 && rocks.at(-1)!.files.length > 1
        ? rocks.length - 1
        : null;
    }
    const own = selection.file - repo.index.folders.own[0]!;
    const rock = rocks.findIndex((r) => r.files.includes(own));
    return rock < 0 ? null : rock;
  };
  let kept: number | null = null;
  /** A pinned rock stays lit while the rest fades, as a pinned folder's leaves do. */
  const keepRock = (state: AppState) => {
    const rock = rockOf(state);
    if (rock === kept) return;
    kept = debug.keptRock = rock;
    view.keepRock(rock);
  };

  store.subscribe((state, prev) => {
    if (
      state.repo !== prev.repo ||
      (state.selection !== prev.selection && state.selection?.folder !== 0)
    ) {
      pilePinned = false;
    }
    if (state.selection !== prev.selection || state.repo !== prev.repo) keepRock(state);
    if (state.repo && state.repo !== prev.repo) {
      setHovered(null);
      view.setHover(null);
      tip.hidden = true;
      buildLabels(state);
      layer.style.opacity = '0';
    } else if (state.repo && state.selection?.folder !== prev.selection?.folder) {
      buildLabels(state);
    }
    if (labelsOn(state) !== labelsOn(prev)) layer.hidden = !labelsOn(state);
  });
  layer.hidden = !labelsOn(store.get());

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
