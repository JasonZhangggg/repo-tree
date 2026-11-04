/**
 * The wire contract between the history server and the app (`src/repo/history.ts`).
 * Times are ms since the epoch. Everything here is derived from public GitHub data.
 */

export const HISTORY_VERSION = 1;

/** Why a history is not complete. An empty list means nothing was capped or skipped. */
export type Gap =
  /**
   * A snapshot tree was over GitHub's limit and not re-read folder by folder (the request budget
   * ran out), so paths past the listed part were assumed unchanged over that interval.
   */
  | 'tree-truncated'
  /** The root commit could not be found, so the oldest snapshot is not the first commit. */
  | 'root-unknown'
  /** A CODEOWNERS file exists but could not be read. */
  | 'codeowners-unread'
  /**
   * A recent commit changed more files than GitHub lists for one commit (3,000), so the rest of
   * its changes are dated to snapshot resolution only.
   */
  | 'commit-files-capped';

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
  /** The token was refused by GitHub (expired or revoked): sign in again. */
  | 'unauthorized'
  /** Private repos are never stored, so their history is never shared. */
  | 'private'
  /** This client or login sent too many uploads, or the server took its writes for the day. */
  | 'rate-limited'
  /** The upload is over MAX_UPLOAD_BYTES, or unpacks to over MAX_INFLATED_BYTES. */
  | 'too-large'
  /** Only the repo's default branch is stored (one history per repo). */
  | 'not-default-branch'
  /** The stored histories together reached the server's storage budget. */
  | 'full'
  /** The claimed head is not the branch's head on GitHub (the branch moved, or a lie). */
  | 'stale'
  /** A history of this head is stored already: nothing was written. */
  | 'exists'
  /**
   * A spot-checked snapshot's tree or time is not GitHub's, the oldest is not a root commit, or
   * the snapshots do not follow the engine's schedule.
   */
  | 'mismatch'
  | 'upstream'
  | 'forbidden';

/**
 * Replies of the history Worker (`server/src/worker.ts`), other than a stored history:
 * GET /v1/history/<owner>/<repo>?branch=<b> answers 200 with the gzipped History JSON as its
 * body and its StoredManifest, JSON, in the X-History-Manifest header; else one of these.
 */
export type HistoryReply =
  /** Nothing stored for this branch yet: a signed-in visitor may compute and upload it. */
  | { status: 'missing' }
  /** PUT accepted: one KV write. */
  | { status: 'stored'; manifest: StoredManifest }
  /** POST .../bad accepted: the stored body may be replaced by the next good upload. */
  | { status: 'noted' }
  | { status: 'error'; error: HistoryError; retryAfter?: number };

/**
 * What a visitor's browser sends with a computed history (PUT /v1/history/<owner>/<repo>
 * ?branch=<b>, body the gzipped History JSON, this JSON in the X-History-Manifest header).
 * The Worker cannot afford to unpack the body (10 ms of CPU), so it checks this instead and
 * readers check that the body agrees with what the Worker stored (`snapshotDigest`).
 */
export type UploadManifest = {
  v: typeof HISTORY_VERSION;
  /** owner/repo, branch and head exactly as in the History. */
  repo: string;
  branch: string;
  head: string;
  computedAt: number;
  /** Every snapshot of the History, oldest first, with its root tree, for spot checks. */
  snapshots: { sha: string; at: number; tree: string }[];
  /** Bytes of the gzipped body. */
  bytes: number;
};

/** What the Worker keeps beside an accepted body (KV metadata, under 1 KiB). */
export type StoredManifest = {
  v: typeof HISTORY_VERSION;
  repo: string;
  branch: string;
  head: string;
  computedAt: number;
  /** Snapshots in the History, and the hex SHA-256 of their `<sha> <at>\n` lines, oldest first. */
  snapshots: number;
  digest: string;
  bytes: number;
  /** The GitHub login that uploaded it, and when (ms). */
  by: string;
  storedAt: number;
};

/**
 * The largest body the Worker stores: over twice Linux's (0.86 MB gzipped, 8 MB of JSON), far
 * under KV's 25 MiB, so a junk upload costs readers and the storage budget little.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * The most a body may unpack to: eight times Linux's 8 MB of JSON. The Worker reads the size
 * gzip records in its last four bytes (it cannot afford to unpack), and readers stop unpacking
 * past it, so a gzip bomb costs nobody more than this.
 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** The digest StoredManifest.digest holds, over a History's snapshots. */
export async function snapshotDigest(
  snapshots: readonly { sha: string; at: number }[],
): Promise<string> {
  const text = snapshots.map((s) => `${s.sha} ${s.at}\n`).join('');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
