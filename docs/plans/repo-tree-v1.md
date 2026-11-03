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
function loadSample(id: string): Promise<Snapshot | LoadError>; // public/samples/<id>.json.gz

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
type GrowParams = { seed: number; leafDensity: number; quality: Quality };
type MeshData = { position: Float32Array; normal: Float32Array; base: Float32Array; timing: Float32Array; nodeId: Float32Array; color?: Float32Array; index: Uint32Array };
type TreeModel = {
  bark: MeshData; leaves: MeshData;
  nodes: { folderPath: Uint32Array /* node -> folder index */ };
  folders: { path: string[]; range: Uint32Array /* [lo, hi] node-id range per folder */ };
  labels: { folder: number; anchor: [number, number, number] }[];
  bounds: { center: [number, number, number]; radius: number; height: number };
};
function growTree(root: Dir, params: GrowParams): TreeModel;

// render/  (three.js, owns GPU state)
interface TreeView {
  setTree(model: TreeModel, palette: Palette): void; // starts the grow animation
  setPalette(p: Palette): void;
  setHighlight(range: [number, number] | null): void;
  frameFolder(folder: number): void;
  pickAt(x: number, y: number): number | null; // folder index under the pointer
  setQuality(q: Quality): void;
  snapshotPNG(scale: number): Promise<Blob>;
}

// app/state.ts  (one store, a reducer, no scattered flags)
type LoadState =
  | { phase: 'idle' } | { phase: 'loading'; ref: RepoRef; step: 'fetch' | 'grow' }
  | { phase: 'ready'; snapshot: Snapshot; tree: TreeModel; dir: Dir }
  | { phase: 'error'; ref: RepoRef; error: LoadError };
type Settings = { palette: PaletteId; colorBy: 'language' | 'folder'; quality: Quality; spin: boolean; labels: boolean; hidden: string[]; growAnim: boolean };
type Quality = 'low' | 'medium' | 'high'; // 'auto' resolves to one of these at startup from device signals and measured frame time
```

Palettes are a table: `PaletteId -> { bark, ground, sky, leafByLang: Record<Lang, hex>, folderRamp: hex[] }`. Autumn is the approved default. Spring blossom, summer green and winter are the other three.

## Rendering decisions

- One merged `BufferGeometry` for bark and one for leaves, so the whole tree is two draw calls. The mock's `onBeforeCompile` patch does grow animation and highlight on the GPU. Keep that approach.
- Picking by a GPU id pass that renders one pixel under the pointer into a 1x1 target, not a CPU raycast. Raycasting 100k-file geometry on every pointer move is too slow.
- Render on demand. The loop runs only while growing, spinning, damping or after input, so an idle tab costs nothing.
- Spin orbits the camera and leaves the tree still, so the shadow map renders once per tree, not per frame.
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
