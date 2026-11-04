# Changes

Settings' `Color leaves by` has a `Changes` choice that colors leaves by how often their files changed, from the repo's commit history: red `Constantly` (30 or more changes), orange `Often` (10 to 29), gold `Sometimes` (3 to 9) and blue-grey `Rarely` (0 to 2). A file's changes are `Facts.fileChurn`, the same count the Hotspots list shows: the snapshot intervals in which it changed plus its exact recent commits. The legend lists the four bands with their share of files, and the folder bars take each folder's band.

## Sub-features

- `changes-colors` recolors every sprig by the band most of its files are in (the busier on a tie), from `Facts.sprigChangeBand`.
- `changes-highlight` picks a band in the legend to highlight its leaves. A link's `hl=` restores a band.
- `changes-folders` colors each top-level folder bar by its band (`Facts.folderChangeBand`).
- `changes-no-history` keeps language colors on a repo with no history and says why in the legend note, as Activity does.

## How to get to it (user POV)

- Choose `Settings`, then `Color leaves by`, then `Changes`.
- Open a link with `colorBy=changes` (and `hl=<band>`).

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive changes --port <port>` (and `--viewport phone`).
- Bundled samples carry `<id>.history.json.gz`, so they need no history server.

- **Language first.** Open vite by language. Step `language`. The usual autumn crown.
- **Switch.** Settings, `Changes`. Step `changes`. The legend title reads `Leaf colors by changes`, the note `How often each file changed, as of …`, and the crown is mostly blue-grey with red and orange twigs where vite is busy (`packages/`).
- **Constantly.** Click `Constantly`. Step `constantly`. The URL carries `hl=Constantly` and only the red twigs stay bright.
- **Linux.** Open linux by changes. Step `linux`. A big crown, mostly gold and blue-grey.
- **No history.** Enter `acme/widgets` from the stand-in. Step `no-history`. The note reads `History is unavailable for this repo.`

## Gotchas

- Churn counts snapshot intervals, not every commit: recent intervals are shorter, so recent work weighs more. The bands are fixed counts, so a young repo reads mostly `Rarely`.
