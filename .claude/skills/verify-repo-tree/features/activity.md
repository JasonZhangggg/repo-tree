# Activity

Settings' `Color leaves by` has a third choice, `Activity`, that colors leaves by how long ago their files last changed, from the repo's commit history: in the color scheme's own leaves (`Palette.ages`), liveliest for this month down to a withered one for dead wood, all from the palette's leaves with no greys (autumn: red-orange, gold, plum, brown). Leaves whose files are mostly untouched for 3 years are dead wood: they drop, leaving bare branches, and a branch whose every file is dead wood turns to a bleached version of the palette's bark. The legend lists the four bands with their share of files, and the folder bars take each folder's band.

## Sub-features

- `activity-colors` recolors every sprig by the band most of its files are in (the fresher on a tie), from `History.files.changed`, measured from `History.computedAt` ("as of" in the legend note).
- `activity-dead-wood` drops dead-wood leaves in every pass (color, shadow and pick), and bleaches the bark of branches whose newest file is 3+ years old.
- `activity-leaf-fall` lets the dead-wood leaves fall when they drop (Activity chosen, the history arriving, or the `Dead wood` highlight cleared): they take dead wood's palette color, tumble and drift down to the ground over 2.6 s and shrink away as they land. Reduced motion drops them at once.
- `activity-highlight` picks a band in the legend to highlight its leaves. Highlighting `Dead wood` brings its dropped leaves back in dead wood's color so they can be seen. A link's `hl=` restores a band.
- `activity-folders` colors each top-level folder bar by its band.
- `activity-no-history` keeps language colors on a repo with no history and says why in the legend note: `Loading history…`, `No history for this repo yet. Open the timeline to compute it.` or `History is unavailable for this repo.`

## How to get to it (user POV)

- Choose `Activity` in the side panel's `Color leaves by` row, or `Settings`, then `Color leaves by`, then `Activity`.
- Open a link with `colorBy=activity` (and `hl=<band>`).

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive activity --port <port>` (and `--viewport phone`).
- Bundled samples carry `<id>.history.json.gz`, so they need no history server.

- **Language first.** Open linux by language. Step `language`. The usual autumn crown.
- **Switch.** Settings, `Activity`. Step `activity`. The legend title reads `Leaf colors by activity` and the screenshot shows a gold-and-brown crown (autumn) with bare branches where linux is quiet.
- **Dead wood.** Click `Dead wood` in the legend. Step `dead-wood`. The URL carries `hl=Dead%20wood` and the dropped leaves show again, in dead wood's color (autumn: deep brown) against the faded crown.
- **Vite.** Open vite by activity. Step `vite`. `playground/` is mostly dead wood and its bar takes dead wood's color.
- **No history.** Enter `acme/widgets` from the stand-in. Step `no-history`. The note reads `History is unavailable for this repo.` and the leaves keep their language colors.

## Gotchas

- The band colors follow the palette: switch it in Settings and the leaves, legend swatches and folder bars all change.

- `As of` is `History.computedAt`, not today, so a sample's bands are stable until its history is recomputed.
- A link's `hl=` for a band is kept while the history loads; the view applies it once the facts arrive.
- Journeys run with reduced motion, so they never show the fall; to see it, open a context without `reducedMotion: 'reduce'` and screenshot every few hundred ms after choosing Activity.
- Without `VITE_HISTORY_URL` a live repo has no history at all, so it lands in `activity-no-history`.
