# Birds

Open pull requests into the branch on show perch as small low-poly birds on the tree, each on the folder it changes most. A bird's color is its author's (a draft is pale), PRs that change the same folder sit side by side on it, and hovering or tapping a bird says which PR it is and links to it. Birds never block the tree and never show an error.

## Sub-features

- `birds-perch` puts each PR on the deepest folder holding over half its changed files (`perchOf`), on that folder's anchor moved out to the crown's surface, so it shows against the sky. PRs on one folder sit in a row.
- `birds-tip` shows `#<number> <title>` and its author in the hover tooltip, and highlights the perch folder, on a desktop.
- `birds-card` opens `#pr-card` on a click or tap: title, number, author, draft, files and folder, any other PRs on the same folder (a possible conflict), how many of the open PRs show when not all do, and `Open pull request` to GitHub in a new tab.
- `birds-budget` reads files for the six most recently updated PRs signed out and 24 signed in; signing in reads them again.
- `birds-fail-soft` shows no birds and no error when the PR list is rate limited, errors or is unreachable.
- `birds-off` turns birds off from Settings, persisted with the other settings.
- `birds-timeline` hides the birds while the timeline is open: they are today's PRs.

## How to get to it (user POV)

- Load any repo or sample whose branch has open PRs, and look at (or spin) the crown.
- Hover or click a bird; on a phone, tap it.
- Choose `Settings`, then the `Birds` switch.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive birds --port <port>` (and `--viewport phone`).
- `servePulls(page, repo, pulls)` in `e2e/github.ts` answers the PR list and each PR's files. `VITE_PULLS` is a stand-in set for the vite sample: six PRs from four made-up authors, one a draft, two on `packages/vite/src/node/optimizer`.

- **Perched.** Open `/` with `VITE_PULLS` served. Step `perched`. `view.birdsOnScreen()` lists six birds and the screenshot shows the ones on the near side of the crown.
- **Hover.** Desktop only. Step `hover` points at each bird until the tooltip reads `#<number> …` (birds behind the crown are hidden by it, so the pick pass skips them).
- **Card.** Step `card` clicks that bird (taps one on a phone). `#pr-card` shows and `Open pull request` links to `https://github.com/vitejs/vite/pull/<number>`.
- **Off.** Step `off` closes the card, turns off `Birds` in Settings and `birdsOnScreen()` is empty.
- **Proof.** `report.json` passes; `--scale 2` makes the birds readable in the screenshots.
- `birds-budget` and `birds-fail-soft` have no step: `src/repo/pulls.test.ts` and e2e `a rate-limited PR list leaves the tree with no birds and no error` cover them. `birds-timeline` has no step.

## Gotchas

- The tree is small in the whole view, and birds are about two leaves long: crop or zoom a screenshot to show them, and spin or drag to bring a bird on the far side round.
- Open PRs are cached in IndexedDB for ten minutes per `owner/repo@branch`, like CI runs. Use a new repo name per case.
- A sample reads its PRs live; none are bundled, so with `api.github.com` aborted (every journey) a sample has no birds unless the step serves some.
- `api.github.com` is unreachable from this sandbox, so the PR endpoints have only been exercised through the stand-in.
