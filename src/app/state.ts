import type { Quality } from '../grow/grow';
import type { Loaded, LoadStep } from '../load/load-in-worker';
import { ciHealth, ciKey, type CiHealth, type CiRun, type Sky } from '../repo/ci';
import type { LoadError } from '../repo/github';
import type { RepoRef } from '../repo/ref';
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
  /** A weather to show in place of the repo's own, from a link's `wx`. */
  preview: Sky | null;
  /**
   * The date (ms) the timeline shows, or null while it is closed. Playback and dragging move the
   * view directly and settle here when they stop, so the link follows without churning history.
   */
  timeline: number | null;
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
  | { type: 'preview'; sky: Sky | null }
  | { type: 'timeline'; at: number | null };

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
    case 'preview':
      return action.sky === state.preview ? state : { ...state, preview: action.sky };
    case 'timeline':
      return action.at === state.timeline ? state : { ...state, timeline: action.at };
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
