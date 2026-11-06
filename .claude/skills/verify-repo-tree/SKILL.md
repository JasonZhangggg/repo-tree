---
name: verify-repo-tree
description: Drive the Repo Tree web app in headless Chromium on the production build and capture screenshots as proof. Use before calling a UI, rendering or loading change done, to reproduce a bug on the real page, or to measure load blocking and spin fps.
---

# Verify Repo Tree

Repo Tree is a single web page. A user types `owner/repo` or picks a bundled sample, and a three.js tree grows in a canvas with panels around it. Verification drives the production build (`vite build` plus `vite preview`) in Chromium, never the dev server, because the plan's Definition of done is judged on that build.

Everything below runs from the repo root through one helper, `node .claude/skills/verify-repo-tree/scripts/drive.mjs <command>`. Call it `drive` in your head. It takes `--port` (default `4175`, or `VERIFY_PORT`), so parallel worktrees each drive their own instance. Port `4173` belongs to `npm run e2e` and `4174` to `scripts/perf.mjs`. Pick another port for each extra lane.

Set the browser once per shell. The sandbox ships its own Chromium, and its Playwright revision differs.

```sh
export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium
```

Never run `playwright install`. Without `PW_CHROMIUM_PATH`, Playwright looks for its own download, which is fine on CI and on a laptop that installed it.

## Launch

```sh
node .claude/skills/verify-repo-tree/scripts/drive.mjs launch --port 4175
```

This runs `vite build`, starts `vite preview --port 4175 --strictPort` detached, writes its pid to `.verify/preview-4175.pid` and its log to `.verify/preview-4175.log`, and waits until the port answers. The ready signal is the line `ready http://localhost:4175/ pid <pid>`. Launch refuses a port that already answers, so it never drives someone else's server.

A port that answers only means the files are served. The page is usable once `body[data-ready="<owner>/<repo>"]` is set, which happens after the first tree has fully grown. Doctor and every journey wait for it. There is no data dir to seed. Bundled samples load from `public/samples/` with no network, and each journey opens a fresh browser context, so localStorage and IndexedDB start empty.

## Doctor

```sh
node .claude/skills/verify-repo-tree/scripts/drive.mjs doctor --port 4175
```

Doctor is read-only. It prints `ok` or `FAIL` for each check and exits 1 on any failure.

- `started by this skill` and `pid owns the port`. The pid file exists and that pid listens on the port (via `lsof`).
- `dist newer than src`. The served build includes your latest source edits. On failure, run cleanup and launch again.
- `title is Repo Tree`, `debug hook present`, `no page errors`. The first visit reaches `body[data-ready]`, `window.__repoTree.view` exists, and no uncaught error fired.
- `renderer:` names the WebGL renderer. In this sandbox it is SwiftShader, a CPU renderer. Read every fps number with that in mind.

Run doctor first, and again whenever a journey fails in a way that looks like the instance rather than the app.

## Drive

```sh
node .claude/skills/verify-repo-tree/scripts/drive.mjs <journey> --port 4175 [--viewport desktop|phone|phone-390] [--out dir]
```

Journeys are `load-repo`, `explore`, `search`, `settings`, `share-and-export`, `phone-layout`, `tree-sizes`, `timeline`, `compare`, `weather`, `birds`, `hover`, `activity`, `changes`, `busiest`, `owner` and `history-compute`. `history-compute` needs `launch --history`, which also serves the history Worker and a fake GitHub on the next two ports (see [`features/history-compute.md`](features/history-compute.md)). `--scale 2` sets the device scale factor for sharper screenshots. Each one is a Playwright recipe for one file of the feature map in [`features/`](features/README.md). Read the matching feature file before changing a journey or proving a feature it does not cover.

Every journey sets these up before the first navigation.

- Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`, so WebGL works headless.
- Desktop is 1280 by 800. Phone is Playwright's `Pixel 7` (412 px wide, touch). `phone-390` is the same phone at 390 by 844.
- `reducedMotion: 'reduce'`, so trees appear grown at once instead of animating.
- `quietSettings` from `e2e/github.ts`. Stored settings start as `{ quality: 'low', spin: false }` and every request to `api.github.com` is aborted.
- A stand-in GitHub API where a step needs one. `serveRepo(page, 'acme/widgets')` answers the repo and tree endpoints from a bundled sample, `serveRuns(page, 'acme/widgets', '..x')` answers its Actions runs, and `failRepo(page, status, headers)` answers every API call with an error. Real `api.github.com` is unreachable from this sandbox. The app's network boundaries are `fetchSnapshot` in `src/repo/github.ts` and `fetchRuns` in `src/repo/ci.ts`, so a `page.route` stand-in exercises the same code path a live response would.

Selectors come from the page's accessible names and stable ids.

- Repo input is `getByLabel('GitHub repository')`. Once a repo shows, it folds into the repo card; `getByRole('button', { name: 'Change repository' })` opens it. There is no Grow button: a pick from the list grows at once and Enter submits what is typed. While adding to a comparison `#repo-mode` reads Compare. Errors and notices have their own corner, `#alerts`, at the bottom left above the bottom row's buttons, clear of the tree and the cards: the field's error is `#repo-error` and load errors and notices render in `#notices`. Load progress stays in the card's `#status`.
- Bundled samples (and recent repos) are rows of the field's suggestion list, `#suggest button`.
- The pinned card is `getByRole('article', { name: /Pinned folder/ })`, with crumbs in `getByRole('navigation', { name: 'Folder path' })`.
- Tools are `#search-open`, `getByRole('button', { name: 'Copy link to this view' })`, `getByRole('button', { name: 'Export PNG' })` and `getByRole('button', { name: 'Settings' })`. The toast is `#toast`.
- On a phone the side panel is a bottom sheet toggled by `#sheet-toggle`.

`window.__repoTree` is the debug hook (`src/app/debug.ts`). `repo` names the tree on screen, `ready` turns true once it has grown, `hovered` holds the folder path under the pointer, `labels` lists each folder label's anchor in CSS px, `timings` holds load milestones, and `view` is the `TreeView` (`stats()`, `pickAt(x, y)`). Use it to find where to point and to wait for a regrow. Act through the page as a user does (click, type, keys, touch) and read the hook only to observe.

For a check no journey covers, add a step to the journey for that feature in `drive.mjs` and a bullet to its feature file. Keep steps short. Each step is `await step('<id>', async () => { ...actions and expects... })`, and the helper screenshots after it.

## Evidence

Each journey writes to `--out`, by default `.verify/<journey>-<viewport>-<UTC time>/`. `.verify/` is gitignored and cleanup never deletes it.

- `NN-<step>.png` is a full-page screenshot taken right after each step, pass or fail. Steps after the first failure are skipped.
- `report.json` lists every step with `ok`, its screenshot and the error, plus any uncaught page error as a failing `no-page-errors` entry.
- `share-and-export` also saves the exported `vitejs-vite-tree.png`.
- The exit code is 0 only when every step passed.

Proof standards for this app follow.

- Drive the real user path. Type, click, press keys and tap. Never dispatch to the store or call `view` methods to cause the state you are proving.
- Capture the action and the resulting state. The numbered screenshots do this when each step is one user action.
- Check side effects next to what is visible. Settings land in localStorage `repo-tree:settings`, the URL hash carries repo and view, the token goes only to `api.github.com` in an `Authorization` header, and export writes a PNG file.
- A stand-in API only replaces GitHub. Never stub the worker, the loader or the renderer.
- Put screenshots in a PR on the `screenshots` branch, as `CLAUDE.md` says.

## Cleanup

```sh
node .claude/skills/verify-repo-tree/scripts/drive.mjs cleanup --port 4175
```

Cleanup reads `.verify/preview-4175.pid`, kills that pid only if it still owns the port, and deletes the pid file and preview log. It never kills by process name and never touches the evidence folders in `.verify/`. Journeys close their own browser. Run cleanup after every failed attempt too, so no preview is left holding a port.

## Helpers

- `scripts/drive.mjs` is the helper above. It imports `serveRepo`, `failRepo`, `quietSettings` and `ready` from `e2e/github.ts`, so the stand-in API matches the e2e suite. Node 22.18 or later strips the TypeScript types on import.
- `node scripts/perf.mjs [dotfiles|vite|linux] [low|medium|high] [clear|sunny|cloudy|rain|storm]` builds and serves its own preview on port `4174`, then prints load blocking, spin fps and time to tree. See [`features/performance.md`](features/performance.md).
- `npm run e2e` runs the Playwright suite on port `4173`. It covers the same journeys as assertions without evidence folders.
