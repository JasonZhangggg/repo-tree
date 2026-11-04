# Timeline

A user replays a repo from its first commit. The `Timeline` button opens a scrubber above the bottom controls (above the sheet peek on a phone) with play and pause, a draggable thumb over year ticks, the date and the file count then. Folders sprout in leaf when they first appear, labels wait for their branch, and the link carries the date.

## Sub-features

- `timeline-open` opens the scrubber. With motion allowed it plays from the first commit; under reduced motion or with the grow animation off it opens on the whole tree, paused.
- `timeline-scrub` clicking or dragging the track moves the date and the count (`#timeline-date`, `#timeline-files`) and the tree with them.
- `timeline-play` `Play timeline` runs the whole life in about 20 s and stops on the full tree; `Pause timeline` holds it.
- `timeline-link` the hash gains `t=YYYY-MM-DD` when playback or a drag stops; a link with `t` (or `YYYY-MM`, `YYYY`) opens the timeline there.
- `timeline-labels` a folder not yet grown in has no label, cannot be hovered or pinned, and a pin drops when the scrub goes before it. Search picking such a folder moves the scrub to its birth.
- `timeline-export` `Export PNG` captures the tree at that date as `<owner>-<repo>-tree-<YYYY-MM-DD>.png`.
- `timeline-unavailable` a repo with no history source (not a sample, and the build has no `VITE_HISTORY_URL`) shows the button as `aria-disabled`; a click toasts `History unavailable for this repo`.

## How to get to it (user POV)

- Choose `Timeline` in the bottom controls (an icon button on a phone).
- Open a link with `t=`, for example `#/vitejs/vite?t=2022-06-15`.
- Close it with `Close timeline` (the x at the scrubber's end) or `Timeline` again.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive timeline --port <port>`, and again with `--viewport phone-390` for the phone layout.
- Journeys run under reduced motion, so `open` lands on the whole tree, paused.

- **Open.** Choose `Timeline`. Step `open`. The scrubber shows `2,898 files` and the current month.
- **Scrub.** Click the track at 5%, 25%, 50% and 75%. Steps `early`, `quarter`, `half`, `three-quarters`. The count drops, the date moves back and the hash ends in `t=<date>`; the screenshots show the tree at each point.
- **Play.** Choose `Play timeline`, then `Pause timeline`. Step `play-pause`. The date moved while playing.
- **Link.** Open `#/vitejs/vite?t=2022-06-15`. Step `restore-link`. The date reads `Jun 2022`.
- **Export.** Choose `Export PNG`. Step `export-png`. `vitejs-vite-tree-2022-06-15.png` is saved to the evidence folder.
- **Unavailable.** Load `acme/widgets` from the stand-in API and click `Timeline`. Step `unavailable`. The toast reads `History unavailable for this repo`.
- `timeline-labels` has no journey step; `e2e/timeline.spec.ts` checks the label and hover at Jul 2020 against the head.

## Gotchas

- `aria-disabled` makes Playwright refuse a plain click; the unavailable step clicks with `force`, as a user's tap still lands.
- The scrubber's thumb is 18 px wide, so a fraction of the track maps to `9 + at * (width - 18)` px.
- Linux's history keeps only the last 5,000 deletions (to 2025-02), so its earlier counts read `at least N files`.
- Early frames still show the rocks: root files sit on the island for the whole timeline.
