import type { Quality } from '../grow/grow';
import type { Loaded, LoadStep } from '../load/load-in-worker';
import { ciHealth, ciKey, type CiHealth, type CiRun, type Sky } from '../repo/ci';
import type { LoadError } from '../repo/github';
import type { OpenPulls } from '../repo/pulls';
import type { RepoRef } from '../repo/ref';
import type { Facts } from '../timeline/facts';
import type { Settings } from './settings';

/** A loaded repo, a lookup from folder path to its index in the tree, and the bundled sample it came from. */
export type Repo = Loaded & { folderIds: Map<string, number>; sample?: string };
/** A LoadError, or a bug in loading that the user can only retry. */
export type AppError = LoadError | { kind: 'unexpected' };
/** The load in flight, independent of the repo on screen, which stays until a new one is ready. */
export type LoadState =
  | { phase: 'idle' }
  | { phase: 'loading'; id: number; ref: RepoRef; step: LoadStep }
  | { phase: 'error'; ref: RepoRef; error: AppError };
/**
 * The history behind the colors that need one, for the repo it was asked for: loading, laid over
 * that repo's tree as Facts, `missing` (nobody computed it yet) or `unavailable`.
 */
export type HistoryFacts =
  | { repo: Repo; status: 'loading' }
  | { repo: Repo; status: 'ready'; facts: Facts }
  | { repo: Repo; status: 'missing' | 'unavailable' };
/** A pinned folder, and optionally one of its own files (an index into RepoIndex.files). */
export type Selection = { folder: number; file?: number };

export type AppState = {
  load: LoadState;
  repo: Repo | null;
  selection: Selection | null;
  /**
   * The legend entry whose leaves stand out, by its label. A pinned folder and a highlight never
   * coexist: each is a different place to look, and picking one drops the other.
   */
  highlight: string | null;
  /** Shown once per repo when GitHub truncated its tree. */
  notice: 'truncated' | null;
  settings: Settings;
  /** What 'auto' quality resolves to on this device. */
  autoQuality: Quality;
  /**
   * Recent Actions runs by `ciKey`: a list (empty for no CI) once known, null when they could
   * not be read. A repo missing here is still loading or never asked.
   */
  ci: Readonly<Record<string, readonly CiRun[] | null>>;
  /**
   * Open pull requests by `pullsKey`, perched as birds: known once read, null when they could
   * not be. A repo missing here is still loading or never asked.
   */
  pulls: Readonly<Record<string, OpenPulls | null>>;
  /** A weather to show in place of the repo's own, from a link's `wx`. */
  preview: Sky | null;
  /**
   * The date (ms) the timeline shows, or null while it is closed. Playback and dragging move the
   * view directly and settle here when they stop, so the link follows without churning history.
   */
  timeline: number | null;
  /** Loaded only once something on show needs it (activity, changes or owner colors); null until then. */
  history: HistoryFacts | null;
  /** The repo compared with the one on show, grown beside it on its own island; null when not comparing. */
  compare: RepoRef | null;
  /** That repo once grown (`compare` names it); null while it loads or when not comparing. */
  companion: Loaded | null;
};

export type Action =
  | { type: 'load'; id: number; ref: RepoRef }
  | { type: 'step'; id: number; step: LoadStep }
  | {
      type: 'loaded';
      id: number;
      repo: Repo;
      selection: Selection | null;
      highlight?: string;
      timeline?: number;
    }
  | { type: 'failed'; id: number; error: AppError }
  | { type: 'cancel' }
  | { type: 'dismiss-error' }
  | { type: 'dismiss-notice' }
  | { type: 'select'; selection: Selection | null }
  | { type: 'highlight'; label: string | null }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'auto-quality'; quality: Quality }
  | { type: 'ci'; key: string; runs: readonly CiRun[] | null }
  | { type: 'pulls'; key: string; pulls: OpenPulls | null }
  | { type: 'preview'; sky: Sky | null }
  | { type: 'timeline'; at: number | null }
  | { type: 'history'; history: HistoryFacts }
  | { type: 'compare'; ref: RepoRef | null }
  | { type: 'companion'; companion: Loaded };

const IDLE: LoadState = { phase: 'idle' };

export function reduce(state: AppState, action: Action): AppState {
  const { load } = state;
  const current = load.phase === 'loading' && 'id' in action && action.id === load.id;
  switch (action.type) {
    case 'load':
      return {
        ...state,
        load: { phase: 'loading', id: action.id, ref: action.ref, step: 'fetch' },
      };
    case 'step':
      return current ? { ...state, load: { ...load, step: action.step } as LoadState } : state;
    case 'loaded':
      if (!current) return state;
      return {
        ...state,
        load: IDLE,
        repo: action.repo,
        selection: action.selection,
        highlight: action.selection ? null : (action.highlight ?? null),
        notice: action.repo.info.truncated ? 'truncated' : null,
        timeline: action.timeline ?? null,
        history: null,
      };
    case 'failed':
      if (!current || load.phase !== 'loading') return state;
      return { ...state, load: { phase: 'error', ref: load.ref, error: action.error } };
    case 'cancel':
      return load.phase === 'loading' ? { ...state, load: IDLE } : state;
    case 'dismiss-error':
      return load.phase === 'error' ? { ...state, load: IDLE } : state;
    case 'dismiss-notice':
      return { ...state, notice: null };
    case 'select':
      return { ...state, selection: action.selection, highlight: null };
    case 'highlight':
      return action.label === null
        ? { ...state, highlight: null }
        : { ...state, highlight: action.label, selection: null };
    case 'settings': {
      const settings = { ...state.settings, ...action.patch };
      const recolored = settings.colorBy !== state.settings.colorBy;
      return { ...state, settings, highlight: recolored ? null : state.highlight };
    }
    case 'auto-quality':
      return { ...state, autoQuality: action.quality };
    case 'ci':
      return { ...state, ci: { ...state.ci, [action.key]: action.runs } };
    case 'pulls':
      return { ...state, pulls: { ...state.pulls, [action.key]: action.pulls } };
    case 'preview':
      return action.sky === state.preview ? state : { ...state, preview: action.sky };
    case 'timeline':
      return action.at === state.timeline ? state : { ...state, timeline: action.at };
    case 'history':
      return action.history.repo === state.repo ? { ...state, history: action.history } : state;
    case 'compare':
      return sameRef(action.ref, state.compare)
        ? state
        : { ...state, compare: action.ref, companion: null };
    case 'companion': {
      const { owner, repo } = action.companion.info.ref;
      const named = state.compare && sameRef({ owner, repo } as RepoRef, state.compare);
      return named ? { ...state, companion: action.companion } : state;
    }
  }
}

/**
 * The weather over the repo on screen: a preview, or its CI's health. Null with weather off,
 * before its runs arrive, or when they could not be read; `health` is null for a preview.
 */
export function weatherOf(state: AppState): { sky: Sky; health: CiHealth | null } | null {
  const { repo, settings, preview } = state;
  if (!repo || !settings.weather) return null;
  if (preview) return { sky: preview, health: null };
  const runs = state.ci[ciKey(repo.info.ref, repo.info.branch)];
  if (!runs) return null;
  const health = ciHealth(runs);
  return { sky: health.sky, health };
}

/**
 * Whether the repo on show has CI weather turned on but its runs could not be read (GitHub
 * refused or did not answer), as against not read yet.
 */
export function ciFailed(state: AppState): boolean {
  const { repo, settings, preview } = state;
  if (!repo || !settings.weather || preview) return false;
  return state.ci[ciKey(repo.info.ref, repo.info.branch)] === null;
}

/** Whether two refs name the same repo and branch; GitHub names ignore case. */
export function sameRef(a: RepoRef | null, b: RepoRef | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.ref === b.ref
  );
}

/** Whether what is on show needs the repo's history. */
export const needsHistory = (state: AppState): boolean =>
  state.settings.colorBy === 'activity' ||
  state.settings.colorBy === 'changes' ||
  state.settings.colorBy === 'owner';

/** The history's facts for the repo on show, once loaded. */
export const factsOf = (state: AppState): Facts | null =>
  state.history?.repo === state.repo && state.history?.status === 'ready'
    ? state.history.facts
    : null;

export const qualityOf = (state: AppState): Quality =>
  state.settings.quality === 'auto' ? state.autoQuality : state.settings.quality;

export type Store = {
  get(): AppState;
  dispatch(action: Action): void;
  /** Calls the listener after every change with the new and the previous state. */
  subscribe(listener: (state: AppState, prev: AppState) => void): () => void;
};

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<(state: AppState, prev: AppState) => void>();
  return {
    get: () => state,
    dispatch(action) {
      const prev = state;
      state = reduce(state, action);
      if (state !== prev) for (const listener of listeners) listener(state, prev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
