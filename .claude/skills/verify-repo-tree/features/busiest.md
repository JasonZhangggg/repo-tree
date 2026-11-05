# Busiest files

Part of the `Changes` color mode (see [changes](./changes.md)); there is no separate switch. While leaves show Changes, the leaves of the busiest files (churn: snapshot intervals in which a file changed, plus its recent commits) glow a little in their own leaf color, at their own size, with a soft glow of that color spilling past each leaf's edges, and both pulse gently. Under the legend a `Busiest files` block says how many files glow and lists the five busiest, each pinning its folder and file. Every other color mode shows no glow and no block.

## Sub-features

- `busiest-glow` lights the sprigs of the busiest files from `Facts.sprigHeat`: the busiest leaf files, a whole tie at a time, within 4% of all files and 5% of the sprigs, each needing 6 or more changes. The root's own files lie as rocks, so they never glow and are not listed. A hot leaf keeps its gradient color and adds a little of it as emission.
- `busiest-halo` spills a glow past each hot leaf's edges in that leaf's color, lifted bright: a copy of the hot leaves, a little over twice as large about each leaf's heart and set just behind it, fading toward its rim. It is plain triangles, so it looks the same on any GPU. It grows in with its leaf on the timeline and dims outside a pinned folder or a legend highlight.
- `busiest-pulse` breathes the glow slowly while motion is allowed, at about 14 frames a second when nothing else moves; reduced motion (or the growth animation off) keeps it still.
- `busiest-note` reads `The N busiest files glow, from commit history.`, `The busiest file glows, …` or `No file has changed often enough to glow yet.`
- `busiest-list` lists the five busiest files with their change count, each with the gradient's busiest swatch; a click pins the file's folder with its file card, and the row is marked current.
- `busiest-no-history` lights nothing on a repo with no history and says why: `Loading history…`, `No history for this repo yet. Open the timeline to compute it.` or `History is unavailable for this repo.`

## How to get to it (user POV)

- Choose `Changes` from the `Color leaves by` dropdown at the top of the side panel, or `Settings`, then `Color leaves by`, then `Changes`.
- Open a link with `colorBy=changes`.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive busiest --port <port>` (and `--viewport phone`).
- Bundled samples carry `<id>.history.json.gz`, so they need no history server.

- **Before.** Open vite by language. Step `vite`. No Busiest files block, nothing glows.
- **Changes.** Open vite by changes. Step `changes`. The note reads `The N busiest files glow, from commit history.`, the first row is `…/vite/package.json`, `stats().glowing` is above 0, and the screenshot shows a few of the darkest leaves with a soft glow of their own color.
- **Pin.** Click the first busiest file. Step `pin-hot-file`. The pinned card shows `package.json` in `packages/vite`.
- **Activity.** Open vite by activity. Step `with-activity`. No block, nothing glows.
- **Linux.** Open linux by changes. Step `linux`. A big crown glows in a handful of spots, not everywhere.
- **No history.** Enter `acme/widgets` from the stand-in. Step `no-history`. The note reads `History is unavailable for this repo.` and nothing glows.

## Gotchas

- Journeys run with reduced motion, so screenshots show the still glow; the pulse needs a context without `reducedMotion: 'reduce'`.
- How many files glow depends on the quality tier: a lower tier has fewer, bigger sprigs, so the sprig share admits fewer files.
- The glow is meant to be slight. On a light sky, a pale palette's glow reads more as a soft halo than as light.
