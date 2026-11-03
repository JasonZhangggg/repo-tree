# Repo Tree

The plan is `docs/plans/repo-tree-v1.md`. Its Data shapes are the contracts between modules; a change to one is recorded there in the same PR.

## Before pushing

- Run `npm run check` and `npm run e2e`.
- Locally, set `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` for Playwright. Never run `playwright install`.

## Pull requests

- Every PR with a visible change includes screenshots of it in the description.
- Store them on the `screenshots` branch under `pr-<number>/` and link them with `https://raw.githubusercontent.com/<owner>/<repo>/screenshots/pr-<number>/<file>.png` URLs.
- `node scripts/perf.mjs [sample] [quality]` prints load blocking, spin fps and time to tree; include its output when a PR touches rendering or generation.
