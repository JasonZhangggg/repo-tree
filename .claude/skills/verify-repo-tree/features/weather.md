# Weather

The scene's weather reflects the repo's recent GitHub Actions health on its default branch. A chip under the title says what it stands for and links to the Actions runs. Passing CI is sunny, some failures are partly cloudy, a failing latest run is rain (snow in Winter), several failures in a row are a storm with lightning, and a repo with no runs has a plain clear sky. Weather never blocks the tree and never shows an error; runs GitHub won't send leave a plain sky and a `CI unavailable` chip that asks again when tapped.

## Sub-features

- `weather-sky` dresses the sky, light, sun, clouds, rain or snow and lightning for clear, sunny, cloudy, rain and storm. The sun and clouds are low-poly 3D objects in the island's world, so they turn with it; light rain falls from under the clouds onto the island (none past its rim) and lightning strikes from a cloud.
- `weather-chip` names the verdict and the runs behind it (`CI passing · 20 of 20 recent runs`, `CI failing · last run failed 2 hours ago`) and links to the Actions page filtered to the branch. On a phone it shows its icon and a short verdict.
- `weather-samples` gives each bundled sample its own runs snapshot (`public/samples/<id>.runs.json`): vite is sunny, dotfiles and linux have no CI. A sample reads its live runs first and uses the snapshot only when that fails, after `Reload from GitHub` too, so journeys (which abort `api.github.com`) see the snapshot; `serveRuns` on a sample's name shows its live sky instead.
- `weather-preview` shows any weather from a link's `wx=clear|sunny|cloudy|rain|storm`, which the chip calls a preview.
- `weather-fail-soft` shows no weather when the runs endpoint is rate limited, errors or is unreachable, and the chip says `CI unavailable` (a button, `CI unavailable, try again`); a tap reads the runs again past the cache. e2e: `a rate-limited Actions API leaves the tree, says CI is unavailable, and a tap asks again`.
- `weather-off` turns weather off from Settings, persisted with the other settings.
- `weather-motion` turns the sun's rays, breathes its halo and rolls its faceted core (sunny and cloudy), drifts clouds round the trunk, falls rain or snow (always down, however long the page is open: unit test `a drop only ever falls`) and flashes lightning, and holds a still frame under reduced motion.
- `weather-deck` floats the clouds and the sun above both the crown's top and the framed camera's height, so in the whole view they never cover the crown or its labels, for a sapling and for linux alike, on a desktop and a phone.

## How to get to it (user POV)

- Load any repo or sample and read the chip under the title.
- Open a link with `wx=` in its hash.
- Choose `Settings`, then the `Weather` switch.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive weather --port <port>` (and `--viewport phone-390`).
- `serveRuns(page, repo, pattern)` in `e2e/github.ts` answers the runs endpoint from a pattern, newest first, `.` passed and `x` failed, or with an error status.

- **Sample.** Open `/`. Step `sample-sunny`. The chip reads `CI passing, 20 of 20 recent runs` and a pale sun shows in a warm sky.
- **Cloudy, rain, storm.** Enter `acme/cloudy`, `acme/rain` and `acme/storm` from the stand-in. Steps `cloudy`, `rain` and `storm`. The chip's `data-sky` matches and the screenshots show white clouds beside the sun, grey clouds with rain falling from them onto the island, and dark clouds with heavier slanted rain, all above the crown.
- **Rate limited.** Enter `acme/limited`, whose runs answer 403. Step `rate-limited`. The tree loads, `#status` stays empty and the chip reads `CI unavailable`.
- **Winter storm.** Open `#/vitejs/vite?palette=winter&wx=storm`. Step `winter-preview`. The chip reads `Weather preview, storm` and snow falls instead of rain.
- **Off.** Turn off `Weather` in Settings. Step `off`. The chip is hidden and the sky is the palette's plain one.
- **Proof.** `report.json` passes, and `01-sample-sunny.png` through `06-winter-preview.png` show each sky.
- `weather-motion` has no step: journeys run with reduced motion, which is the still frame. e2e `the sun and clouds in the scene keep moving` checks that cloudy weather keeps rendering with spin off. Prove the look of motion by hand with `reducedMotion: 'no-preference'` (a frame strip a second apart for the sun; drag to orbit between frames to show the sun and clouds turning with the island) and say so.
- `weather-deck` has no step of its own: `src/render/weather.test.ts` checks the deck for trees from 1 to a million files at phone, square and laptop aspects, and the `linux` sample with `wx=storm` on `phone-390` shows it.

## Gotchas

- Runs are cached in IndexedDB for ten minutes per `owner/repo@branch`. Use a new repo name per case, as with trees.
- Journeys and e2e run with reduced motion, so moving weather is still and `settle` returns. Without reduced motion, any weather but clear (the sun too) keeps the view rendering every frame, like spin, and `settle` never returns.
- A light sky helps the e2e pixel checks that count tree pixels: the sun is pale enough not to count as tree. Darker skies from `wx=` would count, so those checks run on samples without a preview.
- `api.github.com` is unreachable from this sandbox, so the runs endpoint has only been exercised through the stand-in.
- Navigating by hash alone (`page.goto(base + '#/...')`) and reloading before the tree is ready reloads the old repo: applying a link dispatches its palette first, and the store writes the shown repo's link back into the hash. Use a `?visit=` query so the navigation is a real page load.
- A tap or click on the sun or a cloud (`view.skyAt`), or on the chip, opens the CI card (`#ci-card`, `src/app/ui/ci-card.ts`): the verdict, the runs behind it, and `Open GitHub Actions`, which leaves for GitHub in a new tab. The scrim closes it on a fresh press, not a click, since the click ending a tap lands on it. e2e: `a tap on the sun says what the sky stands for before leaving for CI`.
