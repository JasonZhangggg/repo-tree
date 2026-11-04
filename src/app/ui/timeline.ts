import { signedInToken } from '../../repo/auth';
import { historySource } from '../../timeline/source';
import type { mountHistoryCompute } from './history-compute';
import {
  buildTimeline,
  cursorOf,
  dateAt,
  filesAt,
  positionAt,
  progressOf,
  SPAN,
  type Timeline,
} from '../../timeline/timeline';
import type { App } from '../app';
import { debug } from '../debug';
import { byId, h } from '../dom';
import { count } from '../format';
import type { AppState, Repo } from '../state';

/** A whole life plays in this long; the easing gives busy years the room. */
const PLAY_MS = 20_000;
const STEPS = 1000;
/** Year labels closer than this many pixels to the last one shown are left as bare ticks. */
const LABEL_GAP = 40;

type Phase =
  | { kind: 'closed' }
  | { kind: 'loading'; repo: Repo; abort: AbortController }
  | { kind: 'open'; repo: Repo; timeline: Timeline; s: number; playing: boolean };

const MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/**
 * The Timeline button and the scrubber. Playback and dragging move the view directly every
 * frame and write the date to the store only when they stop, so the share link follows.
 */
export function mountTimeline(
  app: App,
  reducedMotion: () => boolean,
  showCounts: (counts: ReadonlyMap<number, number> | null) => void,
  compute: ReturnType<typeof mountHistoryCompute>,
): { date(): number | null } {
  const { store, view } = app;
  const button = byId<HTMLButtonElement>('timeline');
  const scrubber = byId('scrubber');
  const play = byId<HTMLButtonElement>('timeline-play');
  const range = byId<HTMLInputElement>('timeline-range');
  const dateEl = byId('timeline-date');
  const filesEl = byId('timeline-files');
  const ticks = byId('timeline-ticks');
  const built = new WeakMap<Repo, Timeline>();
  let phase: Phase = { kind: 'closed' };
  let raf = 0;
  let last = 0;

  const syncButton = () => {
    const repo = store.get().repo;
    const available = !!repo && historySource(repo) !== null;
    button.setAttribute('aria-pressed', String(phase.kind !== 'closed'));
    button.toggleAttribute('aria-busy', phase.kind === 'loading');
    button.setAttribute('aria-disabled', String(!available));
    button.title = available ? 'Replay the repo from its first commit' : 'History unavailable';
    scrubber.hidden = phase.kind !== 'open';
  };

  const syncPlay = (playing: boolean) => {
    play.setAttribute('aria-label', playing ? 'Pause timeline' : 'Play timeline');
    play.querySelector('path')!.setAttribute('d', playing ? 'M9 6v12m6-12v12' : 'M8 6.5v11l9-5.5Z');
  };

  /** Shows the repo as of scrubber position `s`. */
  const seek = (s: number) => {
    if (phase.kind !== 'open') return;
    const { timeline } = phase;
    phase.s = Math.max(0, Math.min(1, s));
    const cursor = cursorOf(phase.s);
    view.setTime(cursor);
    const date = dateAt(timeline, phase.s);
    const { files, atLeast } = filesAt(timeline, phase.s);
    dateEl.textContent = MONTH.format(date);
    filesEl.textContent = `${atLeast ? 'at least ' : ''}${count(files)} ${files === 1 ? 'file' : 'files'}`;
    range.value = String(Math.round(phase.s * STEPS));
    range.setAttribute('aria-valuetext', `${DAY.format(date)}, ${filesEl.textContent}`);
    scrubber.style.setProperty('--at', String(phase.s));
    const at = phase.s;
    debug.timeline = { s: at, date, files };
    showCounts(
      new Map(
        [...timeline.tops].map(([folder, census]) => [folder, filesAt(timeline, at, census).files]),
      ),
    );
    const selection = store.get().selection;
    if (selection && selection.folder !== 0 && !bornBy(timeline, selection.folder, cursor)) {
      app.select(null);
    }
  };

  const settle = () => {
    if (phase.kind === 'open')
      store.dispatch({ type: 'timeline', at: dateAt(phase.timeline, phase.s) });
  };

  const tick = (now: number) => {
    raf = 0;
    if (phase.kind !== 'open' || !phase.playing) return;
    const dt = last ? Math.min(100, now - last) : 16;
    last = now;
    const s = phase.s + dt / PLAY_MS;
    seek(s);
    if (s >= 1) return pause();
    raf = requestAnimationFrame(tick);
  };

  const start = () => {
    if (phase.kind !== 'open') return;
    if (phase.s >= 1) seek(0);
    phase.playing = true;
    last = 0;
    syncPlay(true);
    raf ||= requestAnimationFrame(tick);
  };

  /** Stops playback; `keep` leaves the store alone because a drag is still moving. */
  const pause = (keep = false) => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (phase.kind !== 'open') return;
    const was = phase.playing;
    phase.playing = false;
    syncPlay(false);
    if (was && !keep) settle();
  };

  const layTicks = () => {
    if (phase.kind !== 'open') return;
    const { timeline } = phase;
    const width = range.clientWidth;
    let shown = -Infinity;
    const marks: HTMLElement[] = [];
    const first = new Date(timeline.start).getUTCFullYear() + 1;
    for (let year = first; year <= new Date(timeline.end).getUTCFullYear(); year++) {
      const at = progressOf(timeline.ease, Date.UTC(year, 0, 1)) / (1 + SPAN);
      const x = at * width;
      const label = x - shown >= LABEL_GAP && width - x >= LABEL_GAP / 2;
      if (label) shown = x;
      marks.push(
        h('i', { style: `left:${(at * 100).toFixed(2)}%`, 'data-y': label ? year : null }),
      );
    }
    ticks.replaceChildren(...marks);
  };
  new ResizeObserver(layTicks).observe(range);

  /** Opens at a date, or at the start to play when `autoplay`, or whole. */
  const open = async ({ at, autoplay }: { at?: number; autoplay: boolean }) => {
    const repo = store.get().repo;
    const source = repo && historySource(repo);
    if (!repo || !source) {
      if (at !== undefined) store.dispatch({ type: 'timeline', at: null });
      return;
    }
    const abort = new AbortController();
    phase = { kind: 'loading', repo, abort };
    syncButton();
    let timeline = built.get(repo);
    if (!timeline) {
      const loaded = await source.load(abort.signal).catch(() => null);
      if (phase.kind !== 'loading' || phase.abort !== abort) return;
      let history = loaded?.status === 'ready' ? loaded.history : null;
      const token = signedInToken();
      if (history && token && source.outdated && source.compute) {
        // Signed in and the shared history is behind the branch: offer to bring it up to date.
        const old = history;
        const behind = await source.outdated(old, token, abort.signal).catch(() => false);
        if (phase.kind !== 'loading' || phase.abort !== abort) return;
        if (behind) {
          phase = { kind: 'closed' };
          syncButton();
          const fresh = await compute.offer(repo, source, { refresh: old });
          if (store.get().repo !== repo || phase.kind !== 'closed') return;
          history = fresh ?? old;
          phase = { kind: 'loading', repo, abort };
        }
      }
      if (loaded?.status === 'missing' && source.compute) {
        // Nobody computed it yet: offer to, here. The button stops spinning meanwhile.
        phase = { kind: 'closed' };
        syncButton();
        history = await compute.offer(repo, source);
        if (store.get().repo !== repo || phase.kind !== 'closed') return;
        if (!history) return store.dispatch({ type: 'timeline', at: null });
        phase = { kind: 'loading', repo, abort };
      }
      if (!history) {
        phase = { kind: 'closed' };
        syncButton();
        store.dispatch({ type: 'timeline', at: null });
        return app.toast('History unavailable for this repo');
      }
      timeline = buildTimeline(history, repo.tree, repo.index, store.get().settings.hidden);
      built.set(repo, timeline);
    }
    view.setTimeline(timeline);
    phase = { kind: 'open', repo, timeline, s: 1, playing: false };
    syncButton();
    layTicks();
    seek(at !== undefined ? positionAt(timeline, at) : autoplay ? 0 : 1);
    if (autoplay) start();
    else settle();
  };

  /** Back to the whole tree; `quiet` when the store already says closed. */
  const close = (quiet = false) => {
    pause(true);
    if (phase.kind === 'loading') phase.abort.abort();
    const wasOpen = phase.kind === 'open';
    phase = { kind: 'closed' };
    if (wasOpen) view.setTimeline(null);
    showCounts(null);
    debug.timeline = null;
    syncButton();
    if (!quiet) store.dispatch({ type: 'timeline', at: null });
  };

  button.addEventListener('click', () => {
    if (phase.kind !== 'closed') return close();
    if (button.getAttribute('aria-disabled') === 'true') {
      return app.toast('History unavailable for this repo');
    }
    void open({ autoplay: !reducedMotion() });
  });
  byId('timeline-close').addEventListener('click', () => close());
  play.addEventListener('click', () => {
    if (phase.kind !== 'open') return;
    if (phase.playing) pause();
    else start();
  });
  range.addEventListener('pointerdown', () => pause(true));
  range.addEventListener('input', () => {
    pause(true);
    seek(Number(range.value) / STEPS);
  });
  range.addEventListener('change', settle);

  store.subscribe((state: AppState, prev: AppState) => {
    if (state.repo !== prev.repo) {
      if (phase.kind !== 'closed') close(true);
      if (state.timeline !== null) void open({ at: state.timeline, autoplay: false });
      syncButton();
      return;
    }
    if (state.timeline !== prev.timeline) {
      if (state.timeline === null) {
        if (phase.kind !== 'closed') close(true);
      } else if (phase.kind === 'closed') {
        void open({ at: state.timeline, autoplay: false });
      } else if (phase.kind === 'open' && dateAt(phase.timeline, phase.s) !== state.timeline) {
        pause(true);
        seek(positionAt(phase.timeline, state.timeline));
      }
    }
    const folder = state.selection?.folder;
    if (state.selection !== prev.selection && phase.kind === 'open' && folder) {
      const born = phase.timeline.folders[folder]! + SPAN;
      if (born > cursorOf(phase.s)) {
        pause(true);
        seek(born / (1 + SPAN) + 1e-6);
        settle();
      }
    }
  });
  syncButton();

  return {
    date: () => (phase.kind === 'open' ? dateAt(phase.timeline, phase.s) : null),
  };
}

/** Whether a folder's branch has fully grown in by the cursor. */
const bornBy = (timeline: Timeline, folder: number, cursor: number) =>
  timeline.folders[folder]! + SPAN <= cursor;
