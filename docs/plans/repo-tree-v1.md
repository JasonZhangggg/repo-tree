# Repo Tree v1

## Goal

Jason approved an interactive mock (`reference/mock.html`, look in `reference/approved-look.png`) that grows a low-poly autumn tree from a repository: folders are forks, the heavier child continues as the leader, branch radius follows the pipe model, and leaves (one sprig per group of files, colored by language) sit on twig tips. v1 turns that mock into a real, deployed web app. A user pastes any public GitHub repo and gets its tree. The app stays smooth on repos with 100k files, looks at least as good as the mock, and ships with CI and deploys to GitHub Pages.

## Definition of done

Each item is checked on the deployed build or the production `vite preview` build in Chromium, not on the dev server.

1. Entering `owner/repo` or a GitHub URL loads that repo's default branch and renders its tree. Bundled sample repos render with no network.
2. The tree for the bundled small, medium and large samples matches the approved look: tapering forked trunk, leaves only at twig tips, no ball-shaped crown. A Playwright screenshot of each sample is in the PR.
3. The largest sample (about 100k files) loads with the main thread never blocked over 100 ms during generation, and orbiting holds at least 50 fps on the CI runner's software renderer at quality Low. The perf script prints both numbers.
4. Hover highlights a folder subtree. Click pins a detail card with path crumbs and a link to the folder on GitHub. Search finds a file or folder and frames it.
5. Settings persist across reloads. The URL alone restores repo and settings.
6. API failures (not found, rate limited, truncated tree, offline) each show a specific message and a next step. A personal token can be added for private repos and higher limits. It stays in localStorage and is sent only to `api.github.com`.
7. CI runs typecheck, lint, unit tests, build and Playwright e2e on every PR. Merging to `main` deploys to GitHub Pages.
8. Usable on a 390 px wide phone: tree framed, panels as a bottom sheet, touch orbit and tap to pin.

## Stack

Vite, TypeScript (strict), three.js from npm, Vitest, Playwright. No UI framework. The UI is a few panels over a canvas, and plain DOM with one state store is less to load and less to read than React for that. Exact versions are pinned in `package.json`.

## Data shapes

These are the contracts between modules. Implementation follows them. A change to one is a plan change and gets noted in the PR.

```ts
// repo/ref.ts  (boundary: user input)
type RepoRef = { owner: string; repo: string; ref?: string } & { readonly __brand: 'RepoRef' };
type ParseError = { kind: 'invalid-ref' };
function parseRepoRef(input: string): RepoRef | ParseError; // accepts owner/repo, github.com URLs, /tree/<ref> URLs

// repo/github.ts  (boundary: network)
type Snapshot = { ref: RepoRef; branch: string; sha: string; truncated: boolean; files: FileEntry[]; fetchedAt: number };
type FileEntry = { path: string; size: number };
type LoadError =
  | { kind: 'not-found' } | { kind: 'rate-limited'; resetAt: number } | { kind: 'unauthorized' }
  | { kind: 'network' } | { kind: 'empty' };
function fetchSnapshot(ref: RepoRef, token?: string, signal?: AbortSignal, onBranch?: (branch: string) => void): Promise<Snapshot | LoadError>; // rejects only on abort; onBranch as soon as the branch is known
function loadSample(id: string, base?: string): Promise<Snapshot | LoadError>; // <base>samples/<id>.json.gz; a worker passes the page's base

// repo/ci.ts  (boundary: network, plus the pure health rule)
type CiRun = { passed: boolean; at: number /* ms, when it finished */ };
type Sky = 'clear' | 'sunny' | 'cloudy' | 'rain' | 'storm'; // clear: no CI to report on
type CiHealth = { sky: Sky; runs: number; passed: number; streak: number /* failures in a row from the newest */; latest: CiRun | null };
function ciHealth(runs: readonly CiRun[]): CiHealth; // last 20: storm at 3+ failures in a row; rain when the newest failed or 3+ failures that are half the runs; cloudy for any other failure; sunny when all passed; clear when none
function parseRuns(body: unknown, branch: string): CiRun[] | null; // GET /repos/{o}/{r}/actions/runs body: finished success or failure/timed_out/startup_failure on branch, newest first
function fetchRuns(ref: RepoRef, branch: string, token?: string, signal?: AbortSignal): Promise<CiRun[] | null>; // ?branch=&status=completed&per_page=20; 404 is [] (no CI), any other failure null (no weather); rejects only on abort
function loadSampleRuns(id: string, branch: string, base?: string): Promise<CiRun[] | null>; // <base>samples/<id>.runs.json, in the API's shape
// load/cache.ts also keeps runs for ten minutes under runs:owner/repo@branch.

// server/src/shape.ts  (wire contract of the history server; repo/history.ts re-exports the types)
type Gap = 'tree-truncated' /* paths past an over-limit listing assumed unchanged for that interval */ | 'root-unknown' | 'codeowners-unread' | 'commit-files-capped' /* a recent commit listed 3,000 files, GitHub's cap: the rest are not dated by it */;
type PathTable = { path: string[] /* folders without trailing slash, root '' */; changed: number[]; born: number[]; churn: number[] /* snapshot intervals with a sha change */; commits: number[] /* in `recent` */ };
// A time older than recent.since is known to snapshot resolution: the time of the snapshot that first showed it, an upper bound.
type History = { v: 1; repo: string; branch: string; head: string; computedAt: number; gaps: Gap[];
  recent: { since: number /* 0: reaches the first commit */; commits: number }; snapshots: { sha: string; at: number }[] /* oldest first, last is head: time-lapse frames */;
  files: PathTable; folders: PathTable; gone: { path: string; born: number; gone: number }[] /* most recent first, at most 5000 */;
  owners: { folder: string /* top-level, '' for root files */; authors: { name: string; commits: number /* recent, exact */; weight: number /* commits in intervals where it changed */ }[] /* up to 5, no bots */; codeowners: string[] }[] };
// The Worker computes nothing: a visitor's browser computes (core/engine.ts) and uploads; the Worker checks and stores.
type HistoryError = 'invalid' | 'not-found' | 'unauthorized' | 'private' | 'rate-limited' | 'too-large' | 'stale' /* head is not the branch head */
  | 'exists' /* this head is stored, good and under a day old */ | 'mismatch' /* a spot-checked snapshot is wrong, or the oldest is not the root */
  | 'upstream' | 'forbidden' /* origin */ | 'not-default-branch' | 'full' /* the stored-bytes budget */;
type HistoryReply = { status: 'missing' } | { status: 'stored'; manifest: StoredManifest } | { status: 'noted' /* a bad-body report, 202 */ } | { status: 'error'; error: HistoryError; retryAfter?: number };
type UploadManifest = { v: 1; repo: string; branch: string; head: string; computedAt: number;
  snapshots: { sha: string; at: number; tree: string /* root tree sha */ }[] /* the History's, oldest first */; bytes: number /* gzipped body */ };
type StoredManifest = { v: 1; repo: string; branch: string; head: string; computedAt: number; snapshots: number;
  digest: string /* snapshotDigest */; bytes: number; by: string /* uploader's GitHub login */; storedAt: number };
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // gzipped; Linux's history is 0.85 MB
const MAX_INFLATED_BYTES = 64 * 1024 * 1024; // the gzip ISIZE the Worker accepts, and where readers stop inflating
function snapshotDigest(snapshots: { sha: string; at: number }[]): Promise<string>; // SHA-256 hex of `${sha} ${at}\n` joined; binds a body to its manifest
// GET <VITE_HISTORY_URL>/v1/history/{owner}/{repo}?branch=  200: the gzipped History JSON, its StoredManifest in X-History-Manifest; 404 missing.
// PUT the same URL, Authorization: Bearer <visitor token>, body the gzipped History JSON, X-History-Manifest an UploadManifest. 201 stored.
// POST <...>/{owner}/{repo}/bad?branch=&head=  202 noted: a reader could not use the stored body; the next upload for that head may replace it.
// POST <VITE_HISTORY_URL>/v1/git/{owner}/{repo}/git-upload-pack  Origin required (none → 403 forbidden), Authorization: Bearer <visitor token>, Content-Type
//   application/x-git-upload-pack-request, body a git protocol v2 fetch (core/pack.ts fetchRequest). 200: github.com's answer, streamed
//   untouched (application/x-git-upload-pack-result; cut off past PACK_MAX_BYTES only if that var is set: a JS count per chunk is ~450 ms
//   of CPU for Linux's), fetched with Basic x-access-token:<token>, Git-Protocol: version=2, redirect: 'manual'. Refused before
//   GitHub unless checkFetchRequest(body) passes (command=fetch; caps agent=, object-format=sha1; args only want <sha> (1 to MAX_WANTS = 256),
//   no-progress, ofs-delta, and deepen 1, filter blob:none, done, all three required; printable ASCII; at most 64 KiB) → 400 invalid / 413
//   too-large; then GET /user beside one GraphQL query, repository(owner,name) { isPrivate w<i>: object(oid) { __typename } } per want
//   (GitHub sends any object wanted by name, filter or not) → 401 / 403 private / 404 / 400 invalid unless every want is a Commit;
//   PACK_LIMITER (6 a minute) keyed ip:<ipKey> before GitHub, login:<login> after. A bad % escape in a route's path → 400 invalid, with CORS.
// worker.ts ipKey(ip): an IPv4 address as is (::ffff:-mapped too), an IPv6 address as its /64 ('2001:db8:1:2::/64'): the key of every
//   per-IP limiter (LIMITER, UPLOAD_LIMITER, PACK_LIMITER). capped(body, max): the stream, errored past max bytes.
// Uploads are taken for the repo's default branch only. Localhost origins only when the ALLOW_LOCALHOST var is set (local runs, e2e).
// KV (the store): key `h1:${repo.toLowerCase()}@${branch}` (core/upload.ts historyKey), value the body untouched, metadata the StoredManifest,
// 90-day TTL, one write per accepted upload (plus a delete per eviction), none per job step or sign-in. The Worker never decompresses or parses a body (10 ms CPU);
// it reads the gzip trailer's ISIZE and refuses past MAX_INFLATED_BYTES.
// core/upload.ts: parseManifest also wants unique shas, the head last, time order, and followsSchedule(snapshots): at most one snapshot per
//   schedule(head.at, root.at, 80) target, at or before it (as the engine picks). There is no floor: a sparse branch has few snapshots.
// core/upload.ts: verifyUpload(m: UploadManifest, { fetch, api, token, now, pick? }): Promise<{ ok: true; manifest: StoredManifest } | { ok: false; error: HistoryError; retryAfter?: number }>
//   GET /user, /repos/{repo} (public, default_branch === branch), /repos/{repo}/commits/{branch} (sha === head), /git/commits/{sha} for the head,
//   the oldest snapshot (no parents: the root) and SPOT_CHECKS = 3 random others (tree and time): 8 requests.
// core/ledger.ts, run by the `Ledger` Durable Object (one global, SQLite-backed, binding LEDGER): the source of truth for what is stored and the caps.
type LedgerRequest = { op: 'check'; key: string; head: string; now: number } /* before GitHub requests */
  | { op: 'reserve'; key: string; head: string; bytes: number; login: string; now: number } /* before the KV put: counts one write */
  | { op: 'release'; key; head; now } /* the put failed */ | { op: 'bad'; key; head; now } /* a reader's report */;
type LedgerReply = { ok: true; evict?: string[] /* KV keys the Worker deletes before its put */ } | { ok: false; error: 'exists' | 'rate-limited' | 'full'; retryAfter?: number /* to UTC midnight */ };
type LedgerLimits = { perLogin: 20; perDay: 200; maxBytes: 500 MB; writesPerDay: 400; evictPerUpload: 20; replaceAfterMs: 1 day; ttlMs: 90 days };
// vars UPLOADS_PER_LOGIN, UPLOADS_PER_DAY, STORED_BYTES, KV_WRITES_PER_DAY. Past maxBytes a reserve evicts FIFO: entries reported bad first, then
// the oldest by stored_at, at most evictPerUpload, else 'full'. Each eviction's KV delete counts in writesPerDay with the put. No LRU: a view
// would cost a Durable Object request per read.
// A stored head is refused as 'exists' unless it was reported bad or is a day old; a new head replaces it. Bytes count a replaced entry once.
// Readers (repo/history.ts agrees) drop a body unless its repo, branch, head, snapshot count and snapshotDigest match the StoredManifest.

// server/src/core/engine.ts  (pure but for the injected fetch; runs in the visitor's browser in repo/history-worker.ts, and in Node for tests and scripts)
type EngineOptions = { fetch: typeof fetch; api: string; token?: string; repo: string /* owner/repo */; branch: string; signal?: AbortSignal;
  onProgress?: (p: number /* never falls */, bytes: number /* body bytes read so far */) => void; concurrency?: number /* 6; 12 with a pack */; recentCommits?: number /* 100 */;
  maxSnapshots?: number; sparse?: boolean /* every other week and month past the 12th: a subset of schedule() */; reader?: 'graphql' | 'rest';
  trace?: Trace /* core/trace.ts, filled with where the run's time and bytes went */;
  packUrl?: string /* the Worker's git-upload-pack route: with a token (and no finite treeBudget), every tree in one git fetch */;
  checkpoint?: Checkpoint /* pass the same one again to resume after a failure */; treeBudget?: number; now?: () => number;
  onStats?: (stats: EngineStats) => void; onSamples?: (snapshots: { sha: string; at: number; tree: string }[]) => void /* the UploadManifest's snapshots */ };
function computeHistory(options: EngineOptions): Promise<History>; // rejects with { kind: 'not-found' | 'empty' | 'unauthorized' | 'upstream' } | { kind: 'rate-limited'; resetAt }
// core/github.ts: limits { core, graphql: { remaining, resetAt } }, kept apart by x-ratelimit-resource. A spent budget (REST 403/429, GraphQL
// RATE_LIMITED, a secondary limit's 403 or 200 message) waits for retry-after or the reset when it is near, else rejects rate-limited.
// A GraphQL 5xx (a timeout) is not retried: the loader splits the batch. Partial GraphQL data comes back; its null objects are asked once more.
// A resumed run re-reads the newest commits page (the branch may have moved); trees held by sha are kept.
// With GraphQL the recent commits' changes are diffs of their trees and their listed parents' (treeChanges), read with the snapshots'
// trees; only a commit whose parent is unlisted or whose trees stayed unread takes a REST /commits/{sha}. The head's trees start before
// the root lookup; probes go first in the request pool, and a target out of the last page's reach (by twice its span) is probed ahead.
// GraphQL batches start at 100 trees and grow to 400; a part batch goes once 100 are queued or nothing is in flight.
// Tree readers in order: the pack (packUrl), then GraphQL, then REST; each reads only the trees still unread below the snapshots' roots
// (engine.ts unread(store, roots)). With a pack: once the probes have picked every snapshot, one fetch wants the head, every snapshot and
// the diffed recent commits with their first parents; nothing else is read unless it fails or is cut short. Probes look up to 24 targets
// ahead; a mainline pick goes out when its ahead page shows it is needed; the branch's length (per_page=1) is asked beside the first page.
// core/pack.ts: fetchRequest(wants): Uint8Array; checkFetchRequest(body): { ok: true; wants: string[] /* deduplicated */ } | { ok: false; reason };
//   PackReader({ onObject({ oid, type: 'commit' | 'tree' | 'blob' | 'tag', data }), cacheBytes? /* 24 MiB */, segmentBytes? /* 8 MiB */ })
//   .push(chunk) / .end(): PackStats { bytes, objects, deltas, reinflated, held, shallow, retries }: pkt-lines, side band 1 (2 ignored, 3 or ERR throw
//   PackError), the pack kept compressed in segments, objects inflated (core/inflate.ts inflateAt) and deltas (ofs and ref) resolved against
//   an LRU of inflated bases, each named by core/sha1.ts gitOid; a blob, an ofs delta at offset 0, or an object or delta result past 256 MiB
//   throws; an object cut short is retried once more bytes are in, the step growing with what it has (retries: linear time for a 64 MB
//   object). fetchPack(wants, store, { url, token, fetch, signal, maxBytes? /* MAX_PACK_BYTES = 200 MiB, then PackError: fall back */ }, onBytes?)
//   → PackResult = PackStats & { commits: Map<sha, { tree; parents }>; trees; firstByteMs; ms }, trees via TreeStore.addRaw(t, bytes).
// core/trace.ts: tracer() → Trace { begin/end(phase), request(kind, ms, bytes, wire?), waited, batch, cpu, summary(): TraceSummary };
// TraceSummary = { ms; phases: { name: 'listings' | 'probes' | 'head tree' | 'pack' | 'graphql' | 'rest' | 'recent' | 'upload'; from; ms }[];
//   kinds: { kind: 'listing' | 'probe' | 'pack' | 'tree' | 'graphql' | 'commit' | 'blob' | 'upload'; requests; bytes; wire?; meanMs; p90Ms }[];
//   requests; bytes; waitedMs; retried; batches: Record<size, queries>; failed; fellBack /* the first reader left trees unread */; cpuMs };
//   formatTrace(repo, s) is one line. EngineStats.pack: PackResult less commits, plus wants and commits counts, or { wants; error }, or null.
type Checkpoint = { pages: Map<string, { commits: CommitSummary[]; link: string | null }>; store: TreeStore; changes: Map<string, { files: FileChange[]; capped: boolean }>; codeowners: Map<string, string> };
// core/store.ts TreeStore: every distinct tree object read, once, in typed arrays (a tree id per oid; entries of name id, mode, ref sorted by name;
// a folder's ref is its tree id, a file's the first 52 bits of its blob oid). id(oid), add(t, entries), addRaw(t, gitTreeBytes) /* same rows,
// names interned by their bytes */, loaded(t), length/name/mode/ref/find(t, ...), count(t).

// repo/history.ts  (boundary: network; history features are off when VITE_HISTORY_URL is unset)
type HistoryResult = { status: 'ready'; history: History } | { status: 'missing' /* nobody computed it yet, or the stored body is unusable */ } | null /* off or failed */;
function fetchHistory(ref: RepoRef, branch: string, options?: { base?: string; signal?: AbortSignal }): Promise<HistoryResult>; // one GET, no polling; rejects only on abort
// A body that does not inflate within MAX_INFLATED_BYTES (repo/github.ts decode(buffer, limit) throws RangeError), parse, or agree with its
// manifest is 'missing', so the compute offer shows, and is reported with POST .../bad (best effort).
function loadHistory(ref, branch, options & { fresh?: boolean }): Promise<HistoryResult>; // behind load/cache.ts, six hours under history:owner/repo@branch
type UploadResult = 'stored' | HistoryError | 'network';
function uploadHistory(history: History, snapshots: Snapshot[], token: string, options?: { base?: string; signal?: AbortSignal; onBody?: (bytes: number) => void }): Promise<UploadResult>; // gzips with CompressionStream, PUTs with its UploadManifest
function cacheComputed(ref, branch, history: History): Promise<void>; // a computed history, cached as if fetched

// repo/compute-history.ts  (boundary: the engine in a module Worker; a failed or cancelled run's worker is kept, with its checkpoint, to resume)
type ComputeRequest = { run: number; repo: string; branch: string; token?: string; api: string; packUrl?: string /* timeline/source.ts: <server>/v1/git/<owner>/<repo>/git-upload-pack */ }; type ComputeCommand = ComputeRequest | { cancel: number /* run */ };
type ComputeMessage = { run: number } & ({ progress: number } | { history: History; snapshots: Snapshot[]; trace?: TraceSummary } | { error: ComputeError; trace?: TraceSummary }); // another run's are ignored
type Snapshot = { sha: string; at: number; tree: string };
type ComputeError = { kind: 'not-found' | 'empty' | 'unauthorized' | 'upstream' } | { kind: 'rate-limited'; resetAt: number } | { kind: 'not-default-branch'; defaultBranch: string }; // the last from historySource's compute, for a branch link to a branch that is not the default
type ComputeResult = { status: 'ready'; history: History; snapshots: Snapshot[]; trace?: TraceSummary } | { status: 'error'; error: ComputeError; trace?: TraceSummary };
function computeHistoryInWorker(ref, branch, options?: { token?: string | null; signal?: AbortSignal; onProgress?: (p: number) => void; api?: string; packUrl?: string; spawn?: () => WorkerLike }): Promise<ComputeResult>; // rejects only on abort
function loadSampleHistory(id: string, base?: string): Promise<History | null>; // <base>samples/<id>.history.json.gz
function parseHistory(body: unknown): History | null; // version and column alignment checked

// repo/auth.ts  (sign in with GitHub through the history server's OAuth App; no scopes)
function signIn(base?: string): Promise<string | null>; // popup to <base>/v1/auth/login (state HMAC-signed, no KV); the callback posts the token to this origin; kept in sessionStorage 'repo-tree:github-signin' (this tab only)
function signedInToken(): string | null;
function signOut(): void;
// The sign-in token goes only in the Authorization header of requests to GitHub's API and the history Worker, never in a link.

// repo/languages.ts  (table, not branching)
type Lang = string & { __brand: 'Lang' };
const LANGS: ReadonlyArray<{ lang: Lang; exts: string[]; filenames?: string[] }>;
function langOf(path: string): Lang;

// repo/hierarchy.ts  (pure)
type Dir = { path: string; name: string; dirs: Dir[]; files: FileEntry[]; fileCount: number; bytes: number; langs: Map<Lang, number> };
type Filters = { hidden: ReadonlyArray<string> }; // folder names matched exactly at any depth
const DEFAULT_FILTERS: Filters; // node_modules, vendor, third_party, dist, build, .git, target ...
function buildHierarchy(snapshot: Snapshot, filters: Filters): Dir; // folders left without files are dropped

// grow/grow.ts  (pure, deterministic, runs in a worker)
type Quality = 'low' | 'medium' | 'high'; // leaves per sprig, sprigs per twig, tube facets; never the skeleton
type GrowParams = { seed: number; quality: Quality };
type MeshData = { position: Float32Array; normal: Float32Array; base: Float32Array; timing: Float32Array; nodeId: Float32Array; index: Uint32Array };
type LeafMeshData = MeshData & { lang: Float32Array /* index into TreeModel.langs */; shade: Float32Array /* [hue, lightness] offsets */ };
type TreeModel = {
  bark: MeshData; leaves: LeafMeshData; langs: { lang: Lang; files: number }[]; // most files first
  nodes: { folder: Uint32Array; parent: Int32Array; radius: Float32Array /* [start, end] */; files: Uint32Array /* twig file count */ };
  folders: { path: string[]; range: Uint32Array /* [lo, hi] node-id range per folder, preorder, root first */ };
  sprigs: { vertex: Uint32Array; file: Uint32Array /* per sprig, first leaf vertex and first slot in files, plus the end */; files: Uint32Array /* RepoIndex.files ids */ }; // each sprig of leaves stands for a run of its twig's files
  labels: { folder: number; files: number; anchor: [number, number, number] }[]; // one per top-level folder, at its entry in anchors
  anchors: Float32Array; // xyz label anchor per folder: the twig tip nearest the middle of the folder's twigs, leaning a little outward and up
  rocks: { files: number[] /* indices into the root folder's own files */; bytes: number }[]; // root files as rocks, largest first, at most 12 (the last holds the rest); empty when the root has no subfolders
  bounds: { min: [number, number, number]; max: [number, number, number] };
};
function growTree(root: Dir, params: GrowParams): TreeModel; // throws RangeError when root has no files; every file sits on exactly one twig or rock

// grow/size.ts  (world size, the same for every repo)
const ISLAND_RADIUS: number; // every island is this wide
function treeHeight(files: number): number; // highest twig tip: 3.8 * (files / 100k) ** 0.18, at least 0.9, 3.8 from 100k files
function twigBudget(files: number): number; // twigs a crown may open: 200 up to 3k files, linear in log10(files) to 260 at 100k
const TALLEST: Box; // the room the tallest tree can fill; framing fits it, not the tree on show

// grow/ground.ts  (pure, deterministic; the view calls it on the main thread, about 10 to 35 ms at high)
type GroundSite = { trunk: number /* flare radius */; front: number /* view direction, radians */; rocks: number[] /* bytes per rock */ }; // the island is ISLAND_RADIUS for every tree
const ISLAND: Box; // the room any island takes
type GroundMesh = { position: Float32Array; normal: Float32Array; kind: Uint8Array /* KIND */; tone: Float32Array; pick: Float32Array; rock: Float32Array /* TreeModel.rocks index or -1 */ };
type GroundModel = { land: GroundMesh; cover: GroundMesh & { blades: number; flowers: number; litter: number } /* vertex runs in that order */; bounds: Box };
function growGround(site: GroundSite, params: { seed: number; quality: Quality }): GroundModel; // under 3k triangles at low, 6k at high

// load/repo-index.ts  (pure; folders aligned with TreeModel.folders, files grouped by folder in the same order)
type RepoIndex = { langs: Lang[];
  folders: { parent: Int32Array; files: Uint32Array; bytes: Float64Array; langs: Int32Array /* TOP_LANGS [lang, files] pairs */; own: Uint32Array /* [first, count] */ };
  files: { paths: string[]; size: Float64Array; folder: Uint32Array } };
function indexRepo(root: Dir): RepoIndex;

// load/load-in-worker.ts  (replaces grow/grow-in-worker.ts: fetch, parse, build and grow all run in the worker)
type LoadSource = { kind: 'sample'; id: string; base: string } | { kind: 'github'; ref: RepoRef; token?: string; fresh: boolean };
type LoadRequest = { source: LoadSource; filters: Filters; params: GrowParams };
type LoadStep = 'fetch' | 'build' | 'grow';
type LoadProgress = { step(step: LoadStep): void; branch?(name: string): void }; // branch: a GitHub repo's branch once known, so its runs load beside the tree
type RepoInfo = Omit<Snapshot, 'files'> & { files: number };
type Loaded = { info: RepoInfo; tree: TreeModel; index: RepoIndex };
function loadInWorker(request: LoadRequest, progress: LoadProgress, signal: AbortSignal): Promise<Loaded | LoadError>; // abort terminates the worker
// load/cache.ts: GitHub snapshots are kept in IndexedDB for an hour, keyed by owner/repo@ref; `fresh` skips it.

// render/palette.ts  (table)
type PaletteId = 'autumn' | 'spring' | 'summer' | 'winter';
type ColorBy = 'language' | 'folder' | 'activity' | 'owner'; // activity and owner need the history (timeline/facts.ts); without it leaves keep language colors
const AGE_COLORS: hex[]; // one per AGES band, the same in every palette: green, orange, brown, and dead wood's legend grey
const DEAD_BARK: hex; // bark of a branch whose every file is dead wood
type Palette = { id: PaletteId; name: string; bark: hex; sky: { center: hex; edge: hex }; shadow: hex;
  light: { key: hex; sky: hex; ground: hex }; leaves: hex[] /* 9, same length in every palette */; rest: hex; precip: 'rain' | 'snow' /* what falls from a rain or storm sky */;
  ground: { grass: hex; meadow: hex; dirt: hex; soil: hex; stone: hex; rock: hex; cap: hex; blade: hex; flowers: hex[] /* none hides them */; litter: boolean; blades: number /* share of tufts shown */ } };
const PALETTES: Record<PaletteId, Palette>;
type LegendEntry = { color: hex; label: string; files: number };
// Categories ranked by files take leaves[] in order; the rest share `rest`. Same repo, same mapping.
// Legend colors are slotColors(p): each slot as a lit leaf shows it on screen, not the raw albedo.
function leafMapping(categories: { label: string; files: number }[], p: Palette): { slotOf: number[]; legend: LegendEntry[] };

// render/tree-view.ts  (three.js, owns GPU state, the canvas and the orbit controls)
function createTreeView(container: HTMLElement, options: { quality: Quality; palette: PaletteId; colorBy: ColorBy; spin: boolean; reducedMotion: boolean; ground: boolean; hotspots: boolean }): TreeView;
interface TreeView {
  setTree(model: TreeModel): void; // frames the stage (tallest tree on the island), grows unless reduced motion
  grow(): void; // replays the growth of the tree on show
  setTimeline(births: { nodes: Float32Array; sprigs: Float32Array } | null): void; // timeline progress each node and sprig appears at (aBorn per vertex), or the whole tree
  setTime(cursor: number): void; // uTime: elements grow in as it crosses aBorn plus their aT window scaled to SPAN; labels wait for their branch
  setPalette(id: PaletteId): void; // recolors without regrowing
  setColorBy(by: ColorBy): void; // language, top-level folder, or activity or owner once setFacts gave the history. Owner: each top-level folder's leaves take its Facts.owners owner, ranked by files through leafMapping like folders (owners shared across folders share a slot, the rest share the last)
  setFacts(facts: Facts | null): void; // the history laid over the tree on show; setTree clears it. Activity: each sprig takes its AGES band's color, dead-wood sprigs are born never (no pass draws them) unless that band is highlighted, and dead branches (newest file 3+ years old) take DEAD_BARK
  setHotspots(on: boolean): void; // once setFacts gave the history, each leaf of a sprig with sprigHeat glows (aHeat per vertex): twice as large about its stem, its color mostly an ember amber, plus uGlowColor emission by heat times uGlow; the other leaves calm (uCalm). uGlow pulses gently (frames every PULSE_FRAME_MS while only the pulse moves), steady under reduced motion
  legend(): LegendEntry[];
  setHighlight(h: { range: [number, number] } | { category: string } | null): void; // fades nodes outside the id range, or bark and every leaf outside the legend entry with that label, drained to grey while that entry's own leaves deepen (a per-leaf slot test in the shader)
  frameFolder(folder: number): void; // eases the camera onto the folder's leaves, never nearer than half the distance that frames the tree on show nor further than the stage; 0 frames the stage
  setInsets(insets: { top: number; right: number; bottom: number; left: number }): void; // CSS px the panels cover; the tree frames into the rest
  pickAt(x: number, y: number): { folder: number; rock?: number } | null; // folder or rock under a CSS pixel of the container; a rock's folder is 0
  setGround(on: boolean): void; // the island with its rocks and grass, or the bare baked shadow; framing includes it while shown
  setWeather(weather: { sky: Sky; still: boolean } | null): void; // sky tint, light, and in world space over the island a low-poly sun, low-poly clouds above the crown, rain or snow falling from them, lightning from a cloud; moving weather keeps rendering unless still
  setQuality(q: Quality): void; // pixel ratio, shadow map size, antialias (swaps the canvas)
  setSpin(on: boolean): void;
  setReducedMotion(on: boolean): void;
  setLabelFolders(folders: readonly number[] | null): void; // which folders' anchors onFrame reports; null (and every setTree) means the top-level folders
  onFrame(listener: (info: { growth: number; labels: { folder: number; x: number; y: number; visible: boolean; front: boolean; depth: number }[]; crown: { x: number; y: number; rx: number; ry: number } }) => void): () => void; // visible: grown, in front of the camera, inside the free region; front: on the near side of the crown; depth: 0 facing the camera to 1 straight behind the trunk; crown: the crown's outline on screen, as an ellipse
  snapshotPNG(scale: number): Promise<Blob>;
  stats(): { renders: number; distance: number; calls: number; triangles: number; geometries: number; textures: number; glowing: number }; // distance: camera to orbit target; glowing: hot sprigs
  dispose(): void;
}

// app/state.ts  (one store, a reducer, no scattered flags)
// The load in flight is separate from the repo on screen, so the old tree stays until the new one is ready.
// A result whose id is not the current load's (replaced or cancelled) is ignored.
type Repo = Loaded & { folderIds: Map<string, number>; sample?: string };
type AppError = LoadError | { kind: 'unexpected' };
type LoadState =
  | { phase: 'idle' } | { phase: 'loading'; id: number; ref: RepoRef; step: LoadStep }
  | { phase: 'error'; ref: RepoRef; error: AppError };
type Selection = { folder: number; file?: number }; // indices into the shown repo
type AppState = { load: LoadState; repo: Repo | null; selection: Selection | null; highlight: string | null; notice: 'truncated' | null; settings: Settings; autoQuality: Quality;
  ci: Record<string /* ciKey */, readonly CiRun[] | null /* could not be read */>; preview: Sky | null /* from a link's wx */;
  timeline: number | null /* the date (ms) the open timeline settled on; null while closed */;
  history: HistoryFacts | null /* loaded once needsHistory(state) (activity or owner colors, or hotspots); a new repo clears it */ };
type HistoryFacts = { repo: Repo; status: 'loading' } | { repo: Repo; status: 'ready'; facts: Facts } | { repo: Repo; status: 'missing' | 'unavailable' };
// app/history-facts.ts watchHistory(store): reads the stored history (historySource(repo).load, never a compute) a microtask after the change that asked, and dispatches { type: 'history' }.
function needsHistory(state: AppState): boolean; // colorBy activity or owner, or hotspots on
function weatherOf(state: AppState): { sky: Sky; health: CiHealth | null } | null; // null with weather off, before runs arrive or when they failed
// highlight is a legend label. A pin and a highlight never coexist: picking one drops the other, and switching colorBy drops the highlight.
// A loaded link's hl must name a legend entry, except an activity band or (by owner) any name: those wait for the history.

// app/settings.ts  (localStorage 'repo-tree:settings'; each malformed field falls back to its default)
type Settings = { palette: PaletteId; colorBy: ColorBy; quality: 'auto' | Quality; spin: boolean; labels: boolean; growAnim: boolean; ground: boolean; weather: boolean; hotspots: boolean /* default false */; hidden: string[]; token: string };
// 'auto' starts from devicePixelRatio and hardwareConcurrency, then steps down once if the first 2 s after growth render under 30 fps.
// The token is sent only by fetchSnapshot, which only calls api.github.com.

// app/link.ts  (URL hash: #/owner/repo?branch=&palette=&colorBy=&sel=<folder path>&hl=<legend label>&wx=<sky preview>&t=<YYYY-MM-DD>)
type ViewLink = { ref: RepoRef; palette?: PaletteId; colorBy?: ColorBy; sel?: string; hl?: string; wx?: Sky; t?: number /* timeline date, ms UTC; YYYY-MM and YYYY also read */ };
function parseLink(hash: string): ViewLink | null;
function formatLink(link: ViewLink): string;
// A ref naming a bundled sample on its branch (or with no branch) loads the sample; Reload fetches it live.

// timeline/source.ts  (boundary: where History comes from; swap the source here alone)
type HistoryLoad = { status: 'ready'; history: History } | { status: 'missing' } | null;
type ComputeOutcome = { status: 'ready'; history: History; shared: UploadResult; trace?: TraceSummary /* the upload added */ } | { status: 'error'; error: ComputeError; trace?: TraceSummary };
// app/ui/history-compute.ts logs formatTrace for every run (console.info) and keeps it in window.__repoTree.computeTrace; with the debug flag
// (app/debug.ts debugEnabled: `?debug` in the address, or localStorage repo-tree:debug = 1) it also shows it in a toast.
type HistorySource = { load(signal: AbortSignal): Promise<HistoryLoad>;
  compute: ((o: { token: string; signal: AbortSignal; onProgress?: (p: number) => void }) => Promise<ComputeOutcome>) | null /* samples, no server, or a ref other than the default branch */;
  outdated: ((history: History, token: string, signal: AbortSignal) => Promise<boolean>) | null /* computedAt over STALE_AFTER_MS (1 day) ago and GitHub's branch head differs */ };
function historySource(repo: { sample?: string; info: { ref: RepoRef; branch: string } }, options?: { base?: string; server?: string; api?: string /* VITE_GITHUB_API */; spawn? }): HistorySource | null; // sample file, else the history server when VITE_HISTORY_URL is set, else null (timeline unavailable). compute: engine in a Worker, then upload, then cache
// timeline/estimate.ts: estimateCompute(headEntries) → { downloadMB, memoryMB, big /* ≥ 25 MB */ }; constrainedDevice() = deviceMemory ≤ 4 or a coarse pointer.
// timeline/compute-view.ts (pure): Step = offer{refresh?: {since}} | computing{progress} | sharing | failed{error}; describeStep(step, ctx) → title, progress, lines, buttons. app/ui/history-compute.ts renders it.

// timeline/timeline.ts  (pure; consumes only History, TreeModel and RepoIndex)
type Ease = { at: Float64Array /* snapshot times */; p: Float64Array /* progress 0..1: LINEAR (0.3) by time, the rest by births and deletions */ };
type Census = { born: Float64Array; goneBorn: Float64Array; goneGone: Float64Array }; // progress, ascending
type Timeline = { start: number; end: number; ease: Ease; nodes: Float32Array; sprigs: Float32Array; folders: Float32Array /* progress each appears at */;
  census: Census; tops: Map<number /* label folder */, Census>; partialBefore: number /* deletions cut off (GONE_CAP) before this progress */ };
function buildTimeline(history: History, tree: TreeModel, index: RepoIndex, hidden?: readonly string[]): Timeline; // snapshot-resolution times spread over their interval by hash; a folder's earliest sprig takes the folder's birth
const SPAN: number; // grow-in per element, in progress
function cursorOf(s: number): number; // scrubber position 0..1 to uTime, s * (1 + SPAN)
function positionAt(t: Timeline, ms: number): number; function dateAt(t: Timeline, s: number): number;
function filesAt(t: Timeline, s: number, census?: Census): { files: number; atLeast: boolean }; // files alive then, deleted ones while they lived
function aliveAt(t: number, born: number, gone?: number): boolean;

// timeline/facts.ts  (pure; consumes only History, TreeModel and RepoIndex)
const AGES: { label: 'This month' | 'This year' | '1 to 3 years' | 'Dead wood'; within: number /* ms before asOf */ }[]; const DEAD: number; // the last band
function ageBand(asOf: number, changed: number): number;
type Facts = { asOf: number /* History.computedAt */; fileChanged: Float64Array /* per RepoIndex file; files the history lacks count as asOf */;
  sprigBand: Uint8Array; folderBand: Uint8Array /* the band most files are in, the fresher on a tie */; nodeChanged: Float64Array /* newest file on the node or beyond it */;
  fileChurn: Uint32Array /* per RepoIndex file: History.files churn + commits, 0 when the history lacks it */; fileHeat: Float32Array /* 0, or HOT_FLOOR..1 for a hotspot */;
  sprigHeat: Float32Array /* its hottest file's */; hot: Uint32Array /* hotspot files, hottest first */;
  owners: Owners /* historyOwners(history) */ };
function historyFacts(history: History, tree: TreeModel, index: RepoIndex): Facts;
const HOT_SHARE = 0.04, HOT_SPRIGS = 0.05, HOT_MIN = 6, HOT_FLOOR = 0.35;
function hotspots(churn: Uint32Array, sprigOf: Int32Array /* -1: off the leaves (root rocks) */, sprigCount: number): { heat: Float32Array; hot: Uint32Array };
// Takes the busiest leaf files (churn >= HOT_MIN) a whole tie at a time while within HOT_SHARE of all files and HOT_SPRIGS of the sprigs (at least one tie); heat runs linearly from HOT_FLOOR at the cut to 1 at the top.

// timeline/owners.ts  (pure; consumes only History.owners, recent and gaps)
type FolderOwner = { owner: string | null /* CODEOWNERS' first, else the author with most recent commits (then weight) */; from: 'codeowners' | 'authors' | null;
  authors: { name: string; commits: number; weight: number }[] /* most recent commits first, then weight */; codeowners: string[] };
type Owners = { folders: Map<string /* top-level folder, '' root files */, FolderOwner>; from: 'codeowners' | 'authors' | 'mixed' | null; since: number /* recent.since */; codeownersUnread: boolean };
const NO_OWNER = 'No known owner'; // the label of folders the history has no owner for
function folderOwner(row: History['owners'][number]): FolderOwner; function historyOwners(history: History): Owners;
function ownerCategories(tops: { folder: string; files: number }[], owners: Owners): { categories: { label: string; files: number }[] /* one per distinct owner */; categoryOf: number[] /* per top */ };

// app/search.ts  (pure)
type SearchHit = { kind: 'folder' | 'file'; id: number; path: string; marks: number[] };
function createSearch(folders: readonly string[], files: readonly string[]): (query: string, limit?: number) => SearchHit[];
```

Palettes are a table (`render/palette.ts` above). Autumn is the approved default. Spring blossom, summer green and winter are the other three. Leaf colors come from rank, not from a per-language table, so a repo of languages no table knows is as colorful as any other. Each ramp keeps to its season's hues, close neighbours included: a twig carries files of several languages, so no ramp makes every category readable at a glance. Clicking a legend entry highlights that category's leaves instead. `scripts/palette-check.mjs` reports how far apart the slots show; it informs a palette change and gates nothing.

## Rendering decisions

- The crown is capped at `twigBudget` twigs (`grow/size.ts`): 200 up to 3k files, rising to 260 at 100k, so a bigger repo shows more detail as well as more height. The heaviest branches open first; each branch left closed folds into one twig owned by the deepest folder that still owns a node. Forks between top-level folders always open. This keeps large repos as open as the approved tree and bounds geometry at any repo size.
- Each top-level folder gathers on its own side of the crown by how its forks turn, not by bending branches (`ORDER` and `forkAxis` in `grow.ts`). Every fork shares its slice of the compass between its two kids by the square root of their files, and turns about its limb so each kid sets off toward its own share, with a little wobble. Fork angles, lengths and thicknesses stay as they were, and slices under 0.35 rad turn by the golden angle as before, so the tree keeps its natural shape.
- Labels (`app/labels.ts`) go on top-level folders holding at least 2% of the tree's files, at least three and at most seven; those over 15% are larger. Pinning a folder adds smaller labels on its biggest subfolders and fades the other sections' labels. Each label reads as a folder (`drivers/`) and sits just outside the crown's outline on screen, on the line from the crown's middle through its anchor, joined by a stem that ends in a dot on the branch. Labels whose stems would cross swap places. Labels keep off the panels over the canvas, and labels on the far side of the crown fade and give way to those in front. Toward the back they also ease down to 85% with a thinner stem, a gentle depth cue that keeps the size difference between major and other labels readable.
- One merged `BufferGeometry` for bark and one for leaves, so the whole tree is two draw calls. The mock's `onBeforeCompile` patch does grow animation and highlight on the GPU. Keep that approach.
- Picking by a GPU id pass that renders one pixel under the pointer into a 1x1 target, not a CPU raycast. Raycasting 100k-file geometry on every pointer move is too slow.
- Render on demand. The loop runs only while growing, spinning, damping or after input, so an idle tab costs nothing.
- Spin orbits the camera and leaves the tree still, so the shadow map renders once per tree, palette or quality change (and each frame of the grow animation), not per frame. The ground shadow is baked into a texture after each shadow map update.
- The tree stands on a low-poly floating island (`grow/ground.ts`, `render/ground.ts`): grass, a dirt patch at the trunk, a soil cross-section, flowers, tufts and fallen leaves. Each rock is a root-level file. It is two draws, colored per palette on the CPU so a palette switch never regrows it. The island receives the live shadow map, so the baked ground shadow only shows with the ground off. Rocks pick in the id pass after the tree's node ids; grass and soil write no id but still hide what lies behind them. A floating island beat a gentle hill and a small rock bed in a side-by-side comparison: its soil edge anchors the tree against the plain backdrop.
- Size shows repo size. Every island has one radius, a tree's height grows as its files to the power 0.18 (`grow/size.ts`), so ten times the files is about 1.5 times as tall, and the camera frames the stage (the tallest tree on the island), not the tree on show. On a desktop the free region reserves the side panel's whole column and a typical title width, so panel content never changes the scale.
- No environment map: generating the mock's RoomEnvironment blocked the main thread for up to 1.7 s on a software GL. A calibrated hemisphere light stands in for its fill.
- Quality tiers set pixel ratio cap, shadow map size, antialias, and leaf sprigs per twig.
- Weather reflects the repo's recent GitHub Actions runs on its default branch (`repo/ci.ts`, `render/weather.ts`). Its sky tint goes into the container's CSS gradient and the PNG export's sky quad alike; a lightning flash repaints the gradient for its half second. The sun, the clouds, the rain or snow under them and lightning are 3D objects in world space over the island, so they turn with it as the camera orbits: a faceted sun core with camera-facing rays and glow hangs toward the key light (which keeps its bearing, so shadows fall away from the sun from every angle and the baked shadow never needs redrawing), and flat-shaded low-poly clouds lit by the scene's lights drift over the island on a deck about a unit above the crown's top and the whole view's camera height, capped a little under the top of the view (and never less than 0.32 above either), so seen from the framed view no cloud passes in front of the crown or its labels. The whole view looks 8% of the stage's height higher than the stage's middle (`frameTree`'s `lift`), leaving that sky. Light rain (60/140/260 drops by quality, 2.2x in a storm) and snow fall from each cloud's underside only where they land inside the island's rim, and end just under its surface, fading; a bolt strikes from a cloud to the island. Drift, fall, flashes and the sun's turning rays, breathing halo and rolling core run in vertex shaders from one time uniform and up to six cloud positions a frame; sun, clouds, fall and bolt are one mesh each, so weather adds four draws at most and casts no shadows. Moving weather, the sun included, renders every frame like spin does, stops with the page's animation frames when the tab is hidden, and holds a still frame under reduced motion. Runs load on the main thread beside the tree, never block it, and fail soft to no weather. A sample reads its live runs first, like any repo, and falls back to its hand-written `<id>.runs.json` offline or rate-limited, so its sky matches its CI without a reload.
- Commit history comes from a separate server (`server/`, a Cloudflare Worker with KV; setup in `server/README.md`). It compares about 50 to 80 sampled tree snapshots (weekly, monthly, then yearly) by blob and tree sha and reads the newest 100 commits one by one, so its cost is about 120 to 200 GitHub requests whatever the history length. Jobs run in bounded steps across requests. Visitors sign in with GitHub to compute an uncached repo; results come from public data and are shared through the cache, and private repos are refused. Samples carry a `<id>.history.json.gz` made by that server against local clones.
- The timeline replays a repo's history over the head tree it already grew (`timeline/`, `app/ui/timeline.ts`). Each bark and leaf vertex carries the progress its node or sprig appears at, and the shared grow hook compares it with a `uTime` uniform, so scrubbing never regrows geometry and the depth and pick passes hide unborn parts too. Files deleted before head have no geometry: they count in the scrubber while they lived, and a folder older than its files today sprouts in leaf at its own birth. Playback spans the whole life in 20 s on an eased axis and stops on the full tree; reduced motion opens it paused.
- `vite build` output loads three.js in its own chunk. Generation runs in a module worker and returns geometry as transferable buffers.

## PR stack

Each PR is landable on its own and ends in a passing CI run.

1. **Scaffold and CI.** Vite and TypeScript project, lint, Vitest, Playwright, `ci.yml` and `deploy.yml` (GitHub Pages), and `scripts/make-fixture.mjs`, which turns a shallow clone of any public repo into a GitHub-API-shaped fixture. Bundled samples are generated by that script. Seams: none beyond a smoke test that the built page loads.
2. **Repo model.** `ref.ts`, `github.ts`, `languages.ts`, `hierarchy.ts`. Seams: `parseRepoRef`, `fetchSnapshot` (against a fake `fetch`), `buildHierarchy`.
3. **Grow.** `grow.ts` and the worker, ported from the mock and made deterministic. Seams: `growTree` invariants (every file is represented by exactly one twig, folder ranges are contiguous and nested, output is identical for the same seed, radius never grows toward the tips), plus a timing budget on the large sample.
4. **Render.** `TreeView`, palettes, GPU picking, quality tiers, render on demand. Seams: a Playwright screenshot per sample and a pick test that hovers a known folder.
5. **App.** State store, repo input, panels, search, settings, share URL, PNG export, errors, phone layout, keyboard. Seams: Playwright journeys from the feature map.
6. **Verification skill.** `.claude/skills/verify-repo-tree/` with a feature map and the perf script.

## Out of scope for v1

GitLab or Bitbucket, and file contents. The growth animation shows load order, not git history. Commit history and its server were out of scope for v1 and came after it; the time-lapse timeline landed after it; seasons and dead wood landed as the Activity color mode, color by owner as the Owner color mode, and hotspots as the Hotspots setting. GIF or MP4 export of the timeline is not built.
