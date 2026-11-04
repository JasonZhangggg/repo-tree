# Performance

A user should see the page respond while a large repo loads and should be able to orbit smoothly. The plan's Definition of done item 3 sets the targets on the largest sample (about 100k files). The main thread is never blocked over 100 ms during generation, and orbiting holds at least 50 fps at quality Low on the CI runner's software renderer.

## Sub-features

- `perf-blocking` is the longest main-thread task from navigation to the grown tree.
- `perf-spin` is the average fps over 5 s of spin.
- `perf-time-to-tree` is the time from navigation to the snapshot loaded, the first tree frame and the fully grown tree.
- `perf-geometry` is the draw calls and triangles per frame while spinning.
- `perf-weather` is the same spin fps and geometry under a previewed weather.

## How to get to it (user POV)

- Open a sample at `#/torvalds/linux` (or `vitejs/vite`, `mathiasbynens/dotfiles`) and watch it grow and spin.
- Choose a quality in Settings. Higher draws more leaves and sharper shadows.

## Driving it with drive.mjs

Preconditions:

- `PW_CHROMIUM_PATH` set as in the baseline. `scripts/perf.mjs` builds and serves its own preview on port `4174`, so no `drive launch` is needed and port `4174` must be free.
- Run nothing else heavy on the machine. The numbers swing with CPU load.

- **Measure.** Run `node scripts/perf.mjs <dotfiles|vite|linux> <low|medium|high> [clear|sunny|cloudy|rain|storm]`. A weather previews that sky through the link's `wx`, so moving weather's cost shows in the spin fps and the triangle count. It sets the quality in localStorage, records long tasks with a `PerformanceObserver`, waits for `body[data-ready]`, then counts `view.stats().renders` over 5 s of spin.
- **Read.** Compare `longest main-thread task during load` to 100 ms and `average fps over 5 s of spin` to 50 at quality Low on `linux`. The `every task over 50 ms` line gives each task's start, which tells page startup (first 300 ms or so) apart from tasks during generation.
- **Proof.** Paste the script's output into the PR when it touches rendering or generation, as `CLAUDE.md` asks.

Last measured on 2026-11-03 at commit `a0c88b8` in the Claude Code sandbox (4 cores, Chromium SwiftShader, 1280 by 720). Each cell is one run.

| Sample   | Quality | Longest task | Spin fps | Snapshot loaded | First frame | Grown   | Triangles |
| -------- | ------- | ------------ | -------- | --------------- | ----------- | ------- | --------- |
| dotfiles | low     | 905 ms       | 44.4     | 1260 ms         | 1274 ms     | 3892 ms | 973       |
| dotfiles | high    | 888 ms       | 25.8     | 1357 ms         | 1368 ms     | 4282 ms | 1555      |
| vite     | low     | 202 ms       | 27.4     | 475 ms          | 522 ms      | 3227 ms | 15133     |
| vite     | high    | 302 ms       | 10.4     | 572 ms          | 634 ms      | 3610 ms | 30511     |
| linux    | low     | 930 ms       | 29.4     | 1419 ms         | 1647 ms     | 4306 ms | 15265     |
| linux    | high    | 241 ms       | 11.0     | 652 ms          | 873 ms      | 3585 ms | 30823     |

Every run drew 4 calls per frame. Repeat runs of `linux low` and `dotfiles low` gave longest tasks of 1339 ms and 1460 ms and spin of 18.0 and 25.2 fps, so a single run here varies by 2x or more. None of these runs meets the 100 ms or 50 fps target. The longest task usually starts in the first 300 ms after navigation, before the worker reports any load step, and it is as long for the 36-file dotfiles sample as for linux. That points at page startup rather than generation (inferred from the task start times, not profiled).

## Gotchas

- The sandbox renderer is SwiftShader, which rasterizes on the CPU and shares cores with the build, the preview server and the browser. Its fps is a floor, not a prediction for a GPU, and it differs from the CI runner's software renderer. Judge the plan's targets on CI or name the machine with the number.
- `longest main-thread task during load` covers everything from navigation, including script parse and startup, while the target speaks of generation. Read the task start times before calling a regression.
- Spin fps counts renders. Render on demand means an idle tree renders nothing, so the script relies on spin being on, which is the default it leaves in place.
- Port `4174` is fixed in the script. Two perf runs at once collide.

Weather, measured on 2026-11-04 in the same sandbox at load average 7 to 8 with other agents running, `vite low`, five interleaved runs each, median spin fps: main 14.8, this branch with the sample's own sunny sky 14.8 (8 draw calls, 16,489 triangles), `rain` 13.2 (7 calls, 18,923 triangles), `storm` 12.8 (7 calls, 19,507 triangles). Disabling the rain alone recovered the storm's loss in a one-off run, so falling drops are most of the cost (inferred from one noisy run).
