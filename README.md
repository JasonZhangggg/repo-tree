# Repo Tree

Paste a public GitHub repository and watch it grow into a low-poly autumn tree. Folders are forks, the heavier child continues as the leader, branch radius follows the pipe model, and leaves are colored by language. The approved look is in `reference/`, and the v1 plan is `docs/plans/repo-tree-v1.md`.

## Develop

Needs Node 22.

```sh
npm ci
npm run dev     # Vite dev server
npm test        # unit tests (Vitest)
npm run e2e     # Playwright against a production build served by `vite preview`
```

`npm run check` runs typecheck, lint and unit tests. `npm run e2e` builds first, then tests the desktop Chromium and Pixel 7 projects. If your Playwright browser revision is missing and another Chromium is installed, point `PW_CHROMIUM_PATH` at it.

## Samples

`public/samples/` holds three repos as fixtures shaped like the GitHub REST API (`GET /repos/{o}/{r}` and the recursive trees response), so they render with no network. `node scripts/make-samples.mjs` regenerates them and `index.json`. `node scripts/make-fixture.mjs owner/repo out.json[.gz] [--slim]` makes one from a shallow clone. `--slim` drops each entry's `sha` and `url`.
