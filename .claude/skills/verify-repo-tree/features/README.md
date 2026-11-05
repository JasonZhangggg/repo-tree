# Repo Tree verification map

This directory is the maintained source for verifying what a Repo Tree user can do. Read this index, then use the matching feature file as the recipe. `drive` below means `node .claude/skills/verify-repo-tree/scripts/drive.mjs`, run from the repo root.

## Baseline preconditions

- `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` in the sandbox.
- `drive launch --port <port>` printed `ready`, and `drive doctor --port <port>` printed no `FAIL`.
- Each journey opens a fresh browser context, so localStorage and IndexedDB start empty, settings start as quality Low with spin off, and `api.github.com` is unreachable unless a step installs a stand-in.
- Never drive a preview this run did not launch.

## Driving conventions

- Act through the page the way a user does. Read `window.__repoTree` only to find a point to aim at or to wait for a regrow.
- Prefer accessible names and the ids listed in `SKILL.md` over coordinates. The canvas is the exception, where label anchors from the debug hook give the coordinates.
- Wait for `body[data-ready="<owner>/<repo>"]` after anything that loads or regrows a tree, never a fixed sleep.
- Pass `--viewport phone` to run a journey in the phone layout. `phone-layout` requires it.

## Proof and skip reporting

- A proof is the journey's evidence folder with a passing `report.json`, plus the screenshots named in the feature file.
- Name the feature file, the journey and the viewport with every artifact you cite.
- When a sub-feature has no step in its journey, say so and name it. Never report it verified through a different entry point.
- A failing step stays failing. Fix the app or record the unmet precondition in that feature's `Gotchas`. Never loosen the step.

## Feature entry contract

Each feature file starts with an H1 and one paragraph on what the user sees. Then exactly four H2s in this order.

1. `Sub-features` lists short IDs, one line each.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with drive.mjs` starts with `Preconditions:` and pairs each user action with the journey step that does it and the observable result.
4. `Gotchas` lists traps that waste or invalidate a run.

## Features

- [Load a repo](./load-repo.md) covers the first visit, samples, typed refs and URLs, the stand-in GitHub API, the truncated notice and every load error.
- [Explore the tree](./explore.md) covers hover, pin, crumbs, the side folder list, the GitHub link and framing the whole tree.
- [Search](./search.md) covers folder and file matches, choosing a hit and the empty state.
- [Settings](./settings.md) covers palette, color by, quality, hidden folders, the token and persistence.
- [Share and export](./share-and-export.md) covers the copied link, restoring from it and the PNG download.
- [Phone layout](./phone-layout.md) covers tap to pin and the bottom sheet.
- [Timeline](./timeline.md) covers the Timeline button, scrubbing, play and pause, the `t=` link, the dated PNG and the unavailable state.
- [History sign-in and compute](./history-compute.md) covers the offer for a repo with no history, the big-repo and phone warning, sign-in, progress, sharing through the history Worker and the token's reach.
- [Activity](./activity.md) covers leaf colors by last change from the history, dead wood dropping its leaves, the highlighted band and repos with no history.
- [Changes](./changes.md) covers leaf colors by how often files changed, from the history, the highlighted band and repos with no history.
- [Busiest files](./busiest.md) covers, in Changes, the busiest files glowing in their own color, the busiest listed under the legend to pin, no glow in other modes and repos with no history.
- [Owner](./owner.md) covers leaf colors by each top-level folder's owner (CODEOWNERS or top commit author), the highlighted owner, the pinned card's top authors and repos with no history.
- [Weather](./weather.md) covers the sky from recent Actions runs, the chip, sample snapshots, `wx=` previews, failing soft and the setting.
- [Birds](./birds.md) covers open pull requests perched as birds, the tooltip, the PR card, the request budget, failing soft and the setting.
- [Hover highlight](./hover.md) covers birds, rocks, clouds and the sun lighting up under the mouse with a pointer cursor, by day and night.
- [Performance](./performance.md) covers `scripts/perf.mjs`, the plan's targets and the last measured numbers.
