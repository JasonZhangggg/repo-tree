import type { Quality } from '../grow/grow';
import type { Loaded, LoadStep } from '../load/load-in-worker';
import { ciHealth, ciKey, type CiHealth, type CiRun, type Sky } from '../repo/ci';
import type { LoadError } from '../repo/github';
import { addedPaths, type BranchDiff, type DiffError } from '../repo/branch-diff';
import type { OpenPulls } from '../repo/pulls';
import type { RepoRef } from '../repo/ref';
import type { Facts } from '../timeline/facts';
import type { Settings } from './settings';

/** A loaded repo, a lookup from folder path to its index in the tree, and the bundled sample it came from. */
export type Repo = Loaded & {
  folderIds: Map<string, number>;
  sample?: string;
  /** The compared branch or tag whose new files this tree was grown with, if any. */
  diffHead?: string;
};
/**
 * A branch, tag or sha shown against the branch on show (`base`) of repo `repo` (owner/repo,
 * lowercase): its comparison loading, read, or failed.
 */
export type DiffView = { repo: string; base: string; head: string } & (
  | { status: 'loading' }
  | { status: 'ready'; diff: BranchDiff }
  | { status: 'error'; error: DiffError }
);
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
export type HistoryFacts<R extends Loaded = Repo> =
  | { repo: R; status: 'loading' }
  | { repo: R; status: 'ready'; facts: Facts }
  | { repo: R; status: 'missing' | 'unavailable' };
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
  /**
   * The repos compared with the one on show, in order (B, C, …), each grown beside it on its own
   * island; empty when not comparing.
   */
  compare: readonly RepoRef[];
  /** Those repos once grown, any order; one still loading is missing. */
  companions: readonly Loaded[];
  /** Their histories, loaded like `history` once the colors need them, one per companion asked. */
  companionHistory: readonly HistoryFacts<Loaded>[];
  /** A branch or tag shown against the branch on show, or null. Another repo drops it. */
  diff: DiffView | null;
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
  | { type: 'compare'; refs: readonly RepoRef[] }
  | { type: 'companion'; companion: Loaded }
  | { type: 'companion-history'; history: HistoryFacts<Loaded> }
  | { type: 'diff'; diff: DiffView | null };

const IDLE: LoadState = { phase: 'idle' };
/** The most trees compared at once, the repo on show among them. */
export const MAX_COMPARED = 5;

/** A repo's name as a DiffView keeps it. */
export const repoName = (repo: Loaded) =>
  `${repo.info.ref.owner}/${repo.info.ref.repo}`.toLowerCase();

/**
 * The paths a load of `ref` grows in beside its own: the shown branch's new files, when its
 * comparison is read and names this repo.
 */
export function diffExtra(state: AppState, ref: { owner: string; repo: string }) {
  const { diff } = state;
  if (diff?.status !== 'ready' || diff.repo !== `${ref.owner}/${ref.repo}`.toLowerCase()) {
    return null;
  }
  return { head: diff.head, paths: addedPaths(diff.diff) };
}

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
        diff: state.diff && state.diff.repo === repoName(action.repo) ? state.diff : null,
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
    case 'compare': {
      const refs = action.refs
        .filter((ref, i) => action.refs.findIndex((other) => sameRef(other, ref)) === i)
        .slice(0, MAX_COMPARED - 1);
      if (
        refs.length === state.compare.length &&
        refs.every((r, i) => sameRef(r, state.compare[i]!))
      )
        return state;
      const named = (l: Loaded) => refs.some((r) => sameRef(r, plainRef(l)));
      const companions = state.companions.filter(named);
      return {
        ...state,
        compare: refs,
        companions,
        companionHistory: state.companionHistory.filter((h) => companions.includes(h.repo)),
      };
    }
    case 'companion': {
      const grown = plainRef(action.companion);
      if (!state.compare.some((r) => sameRef(r, grown))) return state;
      if (state.companions.includes(action.companion)) return state;
      const stale = state.companions.filter((c) => sameRef(plainRef(c), grown));
      return {
        ...state,
        companions: [...state.companions.filter((c) => !stale.includes(c)), action.companion],
        companionHistory: state.companionHistory.filter((h) => !stale.includes(h.repo)),
      };
    }
    case 'companion-history': {
      const { repo } = action.history;
      if (!state.companions.includes(repo)) return state;
      return {
        ...state,
        companionHistory: [
          ...state.companionHistory.filter((h) => h.repo !== repo),
          action.history,
        ],
      };
    }
    case 'diff':
      return action.diff === state.diff ? state : { ...state, diff: action.diff };
  }
}

/**
 * A grown repo's CI weather for its card: from its recent runs, or for the repo on show a
 * preview from the link. Null with weather off, before its runs arrive, or when they could not
 * be read; `health` is null for a preview.
 */
export function ciOf(
  state: AppState,
  repo: Loaded | null,
): { sky: Sky; health: CiHealth | null } | null {
  const { settings, preview } = state;
  if (!repo || !settings.weather) return null;
  if (preview && repo === state.repo) return { sky: preview, health: null };
  const runs = state.ci[ciKey(repo.info.ref, repo.info.branch)];
  if (!runs) return null;
  const health = ciHealth(runs);
  return { sky: health.sky, health };
}

/**
 * The weather over the repo on screen, from `ciOf`. Null while two trees are compared: one sky
 * over both would describe only one of them, so each card says its own instead.
 */
export function weatherOf(state: AppState): { sky: Sky; health: CiHealth | null } | null {
  return state.compare.length ? null : ciOf(state, state.repo);
}

/**
 * Whether a grown repo has CI weather turned on but its runs could not be read (GitHub refused
 * or did not answer), as against not read yet.
 */
export function ciFailed(state: AppState, repo: Loaded | null = state.repo): boolean {
  const { settings, preview } = state;
  if (!repo || !settings.weather || (preview && repo === state.repo)) return false;
  return state.ci[ciKey(repo.info.ref, repo.info.branch)] === null;
}

/** A grown repo's owner/repo, on its default branch, as compare names it. */
export const plainRef = (l: Loaded): RepoRef =>
  ({ owner: l.info.ref.owner, repo: l.info.ref.repo }) as RepoRef;

/** The compared repos once grown, in compare's order (B, C, …), skipping any still loading. */
export function companionsOf(state: Pick<AppState, 'compare' | 'companions'>): Loaded[] {
  return state.compare.flatMap(
    (ref) => state.companions.find((c) => sameRef(plainRef(c), ref)) ?? [],
  );
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

/** A compared repo's history facts, once loaded. */
export function companionFactsOf(state: AppState, companion: Loaded): Facts | null {
  const history = state.companionHistory.find((h) => h.repo === companion);
  return history?.status === 'ready' ? history.facts : null;
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
