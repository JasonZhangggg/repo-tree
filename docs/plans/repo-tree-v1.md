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
function fetchSnapshot(ref: RepoRef, token?: string, signal?: AbortSignal): Promise<Snapshot | LoadError>; // rejects only on abort
function loadSample(id: string, base?: string): Promise<Snapshot | LoadError>; // <base>samples/<id>.json.gz; a worker passes the page's base

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
  labels: { folder: number; files: number; anchor: [number, number, number] }[]; // one per top-level folder
  bounds: { min: [number, number, number]; max: [number, number, number] };
};
function growTree(root: Dir, params: GrowParams): TreeModel; // throws RangeError when root has no files

// load/repo-index.ts  (pure; folders aligned with TreeModel.folders, files grouped by folder in the same order)
type RepoIndex = { langs: Lang[];
  folders: { parent: Int32Array; files: Uint32Array; bytes: Float64Array; langs: Int32Array /* TOP_LANGS [lang, files] pairs */; own: Uint32Array /* [first, count] */ };
  files: { paths: string[]; size: Float64Array; folder: Uint32Array } };
function indexRepo(root: Dir): RepoIndex;

// load/load-in-worker.ts  (replaces grow/grow-in-worker.ts: fetch, parse, build and grow all run in the worker)
type LoadSource = { kind: 'sample'; id: string; base: string } | { kind: 'github'; ref: RepoRef; token?: string; fresh: boolean };
type LoadRequest = { source: LoadSource; filters: Filters; params: GrowParams };
type LoadStep = 'fetch' | 'build' | 'grow';
type RepoInfo = Omit<Snapshot, 'files'> & { files: number };
type Loaded = { info: RepoInfo; tree: TreeModel; index: RepoIndex };
function loadInWorker(request: LoadRequest, onStep: (step: LoadStep) => void, signal: AbortSignal): Promise<Loaded | LoadError>; // abort terminates the worker
// load/cache.ts: GitHub snapshots are kept in IndexedDB for an hour, keyed by owner/repo@ref; `fresh` skips it.

// render/palette.ts  (table)
type PaletteId = 'autumn' | 'spring' | 'summer' | 'winter';
type ColorBy = 'language' | 'folder';
type Palette = { id: PaletteId; name: string; bark: hex; sky: { center: hex; edge: hex }; shadow: hex;
  light: { key: hex; sky: hex; ground: hex }; leaves: hex[] /* 9, same length in every palette */; rest: hex };
const PALETTES: Record<PaletteId, Palette>;
type LegendEntry = { color: hex; label: string; files: number };
// Categories ranked by files take leaves[] in order; the rest share `rest`. Same repo, same mapping.
function leafMapping(categories: { label: string; files: number }[], p: Palette): { slotOf: number[]; legend: LegendEntry[] };

// render/tree-view.ts  (three.js, owns GPU state, the canvas and the orbit controls)
function createTreeView(container: HTMLElement, options: { quality: Quality; palette: PaletteId; colorBy: ColorBy; spin: boolean; reducedMotion: boolean }): TreeView;
interface TreeView {
  setTree(model: TreeModel): void; // frames the whole tree, grows unless reduced motion
  grow(): void; // replays the growth of the tree on show
  setPalette(id: PaletteId): void; // recolors without regrowing
  setColorBy(by: ColorBy): void; // language, or top-level folder
  legend(): LegendEntry[];
  setHighlight(range: [number, number] | null): void; // fades nodes outside the id range
  frameFolder(folder: number): void; // glides the camera; 0 frames the whole tree
  pickAt(x: number, y: number): number | null; // folder under a CSS pixel of the container
  setQuality(q: Quality): void; // pixel ratio, shadow map size, antialias (swaps the canvas)
  setSpin(on: boolean): void;
  setReducedMotion(on: boolean): void;
  onFrame(listener: (info: { growth: number; labels: { folder: number; x: number; y: number; visible: boolean }[] }) => void): () => void;
  snapshotPNG(scale: number): Promise<Blob>;
  stats(): { renders: number; calls: number; triangles: number; geometries: number; textures: number };
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
type AppState = { load: LoadState; repo: Repo | null; selection: Selection | null; notice: 'truncated' | null; settings: Settings; autoQuality: Quality };

// app/settings.ts  (localStorage 'repo-tree:settings'; each malformed field falls back to its default)
type Settings = { palette: PaletteId; colorBy: ColorBy; quality: 'auto' | Quality; spin: boolean; labels: boolean; growAnim: boolean; hidden: string[]; token: string };
// 'auto' starts from devicePixelRatio and hardwareConcurrency, then steps down once if the first 2 s after growth render under 30 fps.
// The token is sent only by fetchSnapshot, which only calls api.github.com.

// app/link.ts  (URL hash: #/owner/repo?branch=&palette=&colorBy=&sel=<folder path>)
type ViewLink = { ref: RepoRef; palette?: PaletteId; colorBy?: ColorBy; sel?: string };
function parseLink(hash: string): ViewLink | null;
function formatLink(link: ViewLink): string;
// A ref naming a bundled sample on its branch (or with no branch) loads the sample; Reload fetches it live.

// app/search.ts  (pure)
type SearchHit = { kind: 'folder' | 'file'; id: number; path: string; marks: number[] };
function createSearch(folders: readonly string[], files: readonly string[]): (query: string, limit?: number) => SearchHit[];
```

Palettes are a table (`render/palette.ts` above). Autumn is the approved default. Spring blossom, summer green and winter are the other three. Leaf colors come from rank, not from a per-language table, so a repo of languages no table knows is as colorful as any other.

## Rendering decisions

- The crown is capped at 200 twigs (`TWIG_BUDGET` in `grow.ts`). The heaviest branches open first; each branch left closed folds into one twig owned by the deepest folder that still owns a node. Forks between top-level folders always open. This keeps large repos as open as the approved tree and bounds geometry at any repo size.
- One merged `BufferGeometry` for bark and one for leaves, so the whole tree is two draw calls. The mock's `onBeforeCompile` patch does grow animation and highlight on the GPU. Keep that approach.
- Picking by a GPU id pass that renders one pixel under the pointer into a 1x1 target, not a CPU raycast. Raycasting 100k-file geometry on every pointer move is too slow.
- Render on demand. The loop runs only while growing, spinning, damping or after input, so an idle tab costs nothing.
- Spin orbits the camera and leaves the tree still, so the shadow map renders once per tree, palette or quality change (and each frame of the grow animation), not per frame. The ground shadow is baked into a texture after each shadow map update.
- No environment map: generating the mock's RoomEnvironment blocked the main thread for up to 1.7 s on a software GL. A calibrated hemisphere light stands in for its fill.
- Quality tiers set pixel ratio cap, shadow map size, antialias, and leaf sprigs per twig.
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

Commit history over time, GitLab or Bitbucket, a server or OAuth app, and file contents. The growth animation shows load order, not git history.
