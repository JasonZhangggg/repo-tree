# Hotspots

Settings has a `Hotspots` switch ("Busiest files glow, from commit history"), off by default. With it on, the repo's history loads as it does for Activity, and the leaves of the busiest files (churn: snapshot intervals in which a file changed, plus its recent commits) glow: they stand twice as large in an ember amber that pulses gently, while every other leaf calms a little so the glow reads on any palette and any color mode. Under the legend a Hotspots block says how many files glow and lists the five hottest, each pinning its folder and file.

## Sub-features

- `hotspots-glow` lights the sprigs of the hotspot files from `Facts.sprigHeat`: the busiest leaf files, a whole tie at a time, within 4% of all files and 5% of the sprigs, each needing 6 or more changes. The root's own files lie as rocks, so they never glow and are not listed.
- `hotspots-pulse` breathes the glow slowly while motion is allowed, at about 14 frames a second when nothing else moves; reduced motion (or the growth animation off) keeps it still.
- `hotspots-note` reads `The N busiest files glow, from commit history.`, `The busiest file glows, …` or `No file has changed often enough to glow yet.`
- `hotspots-list` lists the five hottest files with their change count; a click pins the file's folder with its file card, and the row is marked current.
- `hotspots-any-color` glows over language, folder and activity colors and every palette, and with the timeline (a hot leaf grows in when its sprig is born).
- `hotspots-no-history` lights nothing on a repo with no history and says why: `Loading history…`, `No history for this repo yet. Open the timeline to compute it.` or `History is unavailable for this repo.`
- `hotspots-persist` keeps the switch in localStorage `repo-tree:settings` as `hotspots`. Links do not carry it.

## How to get to it (user POV)

- Choose `Settings`, then the `Hotspots` switch.
- Reload with it stored on.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive hotspots --port <port>` (and `--viewport phone`).
- Bundled samples carry `<id>.history.json.gz`, so they need no history server.

- **Before.** Open vite by language. Step `vite`. No Hotspots block under the legend.
- **On.** Settings, `Hotspots`. Step `hotspots-on`. The note reads `The N busiest files glow, from commit history.`, the first row is `…/vite/package.json`, localStorage has `hotspots: true`, `stats().glowing` is above 0, and the screenshot shows a few large amber leaves in a calmer crown.
- **Pin.** Click the first hot file. Step `pin-hot-file`. The pinned card shows `package.json` in `packages/vite`.
- **Activity.** Open vite by activity. Step `with-activity`. The glow sits over the green, orange and brown bands.
- **Linux.** Open linux. Step `linux`. A big crown glows in a handful of spots, not everywhere.
- **No history.** Enter `acme/widgets` from the stand-in. Step `no-history`. The note reads `History is unavailable for this repo.` and nothing glows.

## Gotchas

- Journeys run with reduced motion, so screenshots show the still glow; the pulse needs a context without `reducedMotion: 'reduce'`.
- How many files glow depends on the quality tier: a lower tier has fewer, bigger sprigs, so the sprig share admits fewer files.
- Calming the other leaves changes their on-screen color a little; the legend swatches keep the uncalmed colors.
