/**
 * The wire contract between the history server and the app (`src/repo/history.ts`).
 * Times are ms since the epoch. Everything here is derived from public GitHub data.
 */

export const HISTORY_VERSION = 1;

/** Why a history is not complete. An empty list means nothing was capped or skipped. */
export type Gap =
  /** A snapshot tree was truncated by GitHub and could not be read in full. */
  | 'tree-truncated'
  /** Snapshots were dropped to stay inside the request budget. */
  | 'snapshots-skipped'
  /** The root commit could not be found, so the oldest snapshot is not the first commit. */
  | 'root-unknown'
  /** A CODEOWNERS file exists but could not be read. */
  | 'codeowners-unread';

/**
 * One row per path, as parallel columns. Folders have no trailing slash and the root folder
 * is ''. A time older than `History.recent.since` is known only to snapshot resolution and is
 * the time of the snapshot that first showed it, an upper bound on the true time.
 */
export type PathTable = {
  path: string[];
  /** Last change. */
  changed: number[];
  /** First appearance in its current, unbroken run (a path deleted and re-added counts from the re-add). */
  born: number[];
  /** Snapshot intervals in which its blob or tree sha changed. Intervals are shorter for recent times, so recent churn weighs more. */
  churn: number[];
  /** Commits in `History.recent` that touched it (for a folder, anything under it). */
  commits: number[];
};

export type Author = {
  name: string;
  /** Commits in `History.recent` that touched the folder. Exact. */
  commits: number;
  /** Commits by this author in snapshot intervals in which the folder changed. A rough share, not attribution. */
  weight: number;
};

export type History = {
  v: typeof HISTORY_VERSION;
  /** owner/repo as GitHub spells it. */
  repo: string;
  branch: string;
  /** The commit this history describes. */
  head: string;
  computedAt: number;
  gaps: Gap[];
  /** The newest commits read one by one; every change at or after `since` is counted exactly. `since` is 0 when they reach the first commit. */
  recent: { since: number; commits: number };
  /** The commits whose trees were compared, oldest first; the last is `head`. Time-lapse frames. */
  snapshots: { sha: string; at: number }[];
  files: PathTable;
  folders: PathTable;
  /** Files deleted since they were born, most recently deleted first, at most GONE_CAP. `gone` is the first snapshot without it (exact when inside `recent`). */
  gone: { path: string; born: number; gone: number }[];
  /** One per top-level folder of the head tree, plus '' for files at the root. Bot accounts are left out. */
  owners: { folder: string; authors: Author[]; codeowners: string[] }[];
};

export const GONE_CAP = 5000;
/** Authors kept per folder in `owners`. */
export const AUTHORS_PER_FOLDER = 5;

export type HistoryError =
  | 'invalid'
  | 'not-found'
  | 'empty'
  /** The token was refused by GitHub (expired or revoked): sign in again. */
  | 'unauthorized'
  /** Private repos are not computed by the server, so their history is never shared. */
  | 'private'
  | 'rate-limited'
  /** This client started too many new repos this hour. */
  | 'busy'
  | 'upstream'
  | 'forbidden';

export type HistoryReply =
  /** `stale`: an older head's history, served while the new head's is computed. */
  | { status: 'ready'; history: History; stale: boolean }
  /** `progress` runs 0 to 1. Ask again after `retryAfter` seconds. */
  | { status: 'pending'; progress: number; retryAfter: number }
  /** Not cached, and computing it takes a signed-in visitor's GitHub token. */
  | { status: 'needs-auth' }
  | { status: 'error'; error: HistoryError; retryAfter?: number };
