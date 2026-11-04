# Activity

Settings' `Color leaves by` has a third choice, `Activity`, that colors leaves by how long ago their files last changed, from the repo's commit history: green this month, orange this year, brown 1 to 3 years ago. Leaves whose files are mostly untouched for 3 years are dead wood: they drop, leaving bare branches, and a branch whose every file is dead wood turns silver-grey. The legend lists the four bands with their share of files, and the folder bars take each folder's band.

## Sub-features

- `activity-colors` recolors every sprig by the band most of its files are in (the fresher on a tie), from `History.files.changed`, measured from `History.computedAt` ("as of" in the legend note).
- `activity-dead-wood` drops dead-wood leaves in every pass (color, shadow and pick), and greys the bark of branches whose newest file is 3+ years old.
- `activity-highlight` picks a band in the legend to highlight its leaves. Highlighting `Dead wood` brings its dropped leaves back in grey so they can be seen. A link's `hl=` restores a band.
- `activity-folders` colors each top-level folder bar by its band.
- `activity-no-history` keeps language colors on a repo with no history and says why in the legend note: `Loading history…`, `No history for this repo yet. Open the timeline to compute it.` or `History is unavailable for this repo.`

## How to get to it (user POV)

- Choose `Settings`, then `Color leaves by`, then `Activity`.
- Open a link with `colorBy=activity` (and `hl=<band>`).

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive activity --port <port>` (and `--viewport phone`).
- Bundled samples carry `<id>.history.json.gz`, so they need no history server.

- **Language first.** Open linux by language. Step `language`. The usual autumn crown.
- **Switch.** Settings, `Activity`. Step `activity`. The legend title reads `Leaf colors by activity` and the screenshot shows an orange-and-brown crown with bare branches where linux is quiet.
- **Dead wood.** Click `Dead wood` in the legend. Step `dead-wood`. The URL carries `hl=Dead%20wood` and the dropped leaves show again, steel blue-grey against the faded crown.
- **Vite.** Open vite by activity. Step `vite`. `playground/` is mostly dead wood and its bar is grey.
- **No history.** Enter `acme/widgets` from the stand-in. Step `no-history`. The note reads `History is unavailable for this repo.` and the leaves keep their language colors.

## Gotchas

- `As of` is `History.computedAt`, not today, so a sample's bands are stable until its history is recomputed.
- A link's `hl=` for a band is kept while the history loads; the view applies it once the facts arrive.
- Without `VITE_HISTORY_URL` a live repo has no history at all, so it lands in `activity-no-history`.
