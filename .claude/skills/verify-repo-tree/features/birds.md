# Birds

Open pull requests into the branch on show perch as small low-poly birds on the tree, each on the folder it changes most. A bird's color is its author's (a draft is pale), PRs that change the same folder sit side by side on it, and hovering or tapping a bird says which PR it is and links to it. Birds never block the tree and never show an error.

## Sub-features

- `birds-perch` puts each PR on the deepest folder holding over half its changed files (`perchOf`) and stands it on a leaf at the top of the crown nearest that folder's anchor (`perchOnCrown`), so it shows against the sky and never floats. PRs on one folder stand side by side.
- `birds-alive` unless motion is reduced: each bird pecks, glances, ruffles its wings, flicks its tail and hops on its own clock, every half minute or so flies a short hop out and back, and sways with the crown in the breeze. Under reduced motion every bird holds still.
- `birds-tip` shows `#<number> <title>`, its author and how many changed files are lit in the hover tooltip, and lights the leaves of the PR's changed files across the tree (the rest fade), on a desktop.
- `birds-card` opens `#pr-card` in the side panel's column on a click or tap (on a desktop the panel fades out while it is open, so the two never overlap), the tree left in view: title, number, author, draft, files and folder, how many changed files are lit and how many are new or hidden, any other PRs on the same folder (a possible conflict), how many of the open PRs show when not all do, and `Open pull request` to GitHub in a new tab. While it is open the PR's files stay lit and the camera eases toward the perch; closing it puts both back.
- `birds-lit` the PR's changed files (`pullFiles` in `app/birds.ts`) light as search matches do; `window.__repoTree.litPull` names the lit PR. Search's own matches come back when it lets go.
- `birds-budget` reads files for the six most recently updated PRs signed out and 24 signed in; signing in reads them again.
- `birds-fail-soft` shows no birds and no error when the PR list is rate limited, errors or is unreachable.
- `birds-off` turns birds off with the `Show PRs` switch in Settings, persisted with the other settings.
- `birds-timeline` hides the birds while the timeline is open: they are today's PRs.

## How to get to it (user POV)

- Load any repo or sample whose branch has open PRs, and look at (or spin) the crown.
- Hover or click a bird; on a phone, tap it or near it: a tap within 28 px of a bird in plain sight counts (e2e `on a phone a tap beside a bird still opens its PR`).
- Choose `Settings`, then the `Show PRs` switch.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive birds --port <port>` (and `--viewport phone`).
- `servePulls(page, repo, pulls)` in `e2e/github.ts` answers the PR list and each PR's files. `VITE_PULLS` is a stand-in set for the vite sample: six PRs from four made-up authors, one a draft, two on `packages/vite/src/node/optimizer`.

- **Perched.** Open `/` with `VITE_PULLS` served. Step `perched`. `view.birdsOnScreen()` lists six birds and the screenshot shows the ones on the near side of the crown.
- **Hover.** Desktop only. Step `hover` points at each bird until the tooltip reads `#<number> …` (birds behind the crown are hidden by it, so the pick pass skips them).
- **Card.** Step `card` clicks that bird (taps one on a phone). `#pr-card` shows, `Open pull request` links to `https://github.com/vitejs/vite/pull/<number>`, the card says its files are lit on the tree, `__repoTree.litPull` is set and on a desktop `.side` is hidden; the screenshot shows the lit leaves with the rest faded.
- **Off.** Step `off` closes the card, turns off `Show PRs` in Settings and `birdsOnScreen()` is empty.
- **Proof.** `report.json` passes; `--scale 2` makes the birds readable in the screenshots.
- `birds-budget` and `birds-fail-soft` have no step: `src/repo/pulls.test.ts` and e2e `a rate-limited PR list leaves the tree with no birds and no error` cover them. `birds-timeline` has no step.

## Gotchas

- The tree is small in the whole view, and birds are under two leaves long: crop or zoom a screenshot to show them, and spin or drag to bring a bird on the far side round.
- Open PRs are cached in IndexedDB for ten minutes per `owner/repo@branch`, like CI runs. Use a new repo name per case.
- A sample reads its PRs live; none are bundled, so with `api.github.com` aborted (every journey) a sample has no birds unless the step serves some.
- Journeys run with reduced motion, so birds hold still in them. To see them move, open the build with motion allowed; under the software renderer frames come slowly, so slow the page's clock to make a smooth capture.
- `api.github.com` is unreachable from this sandbox, so the PR endpoints have only been exercised through the stand-in.
