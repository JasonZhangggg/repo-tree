# Timeline

A user replays a repo from its first commit. The `Timeline` button opens a scrubber above the bottom controls (above the sheet peek on a phone) with play and pause, a draggable thumb over year ticks, the date and the file count then. Folders sprout in leaf when they first appear, labels wait for their branch, and the link carries the date.

## Sub-features

- `timeline-open` opens the scrubber. With motion allowed it plays from the first commit; under reduced motion or with the grow animation off it opens on the whole tree, paused.
- `timeline-scrub` clicking or dragging the track moves the date and the count (`#timeline-date`, `#timeline-files`) and the tree with them.
- `timeline-play` `Play timeline` runs the whole life in about 20 s and stops on the full tree; `Pause timeline` holds it.
- `timeline-link` the hash gains `t=YYYY-MM-DD` when playback or a drag stops; a link with `t` (or `YYYY-MM`, `YYYY`) opens the timeline there.
- `timeline-labels` a folder not yet grown in has no label, cannot be hovered or pinned, and a pin drops when the scrub goes before it. Search picking such a folder moves the scrub to its birth.
- `timeline-export` `Export PNG` captures the tree at that date as `<owner>-<repo>-tree-<YYYY-MM-DD>.png`.
- `timeline-releases` releases (or, where a repo publishes none, its version tags) are diamonds on the track, majors largest and labeled above it, as many as fit 18 px apart (28 on a touch screen); prereleases and a monorepo's package tags (`create-vite@…`) are left out. A repo whose ranks tell nothing apart (over 24 releases of its top rank, such as a minor bump on every merge) gets 8 evenly spaced diamonds, unlabeled. A tap or click within half that of one lands on its day, and the date, the link's `t=`, the slider's `aria-valuetext` (`…, release v4.0.0, …`) and the diamond (`data-on`, in the accent) follow; Page Up and Page Down step from release to release; a mouse over one shows its tag and day in the bubble. Side by side, each tree's releases share the track in its seed color. Samples read their bundled tags (`public/samples/<id>.releases.json`, `scripts/make-releases.mjs`); a live repo reads GitHub's releases (one request signed out, up to ten signed in, then its tags through GraphQL when it has no releases). dotfiles has no tags, so no marks.
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
- **Releases.** Steps `release-marks` (vite's majors labeled, `v4.0` among them), `release-tap` (tap `v4.0`: `Dec 2022`, `t=2022-12-09`, the diamond lit) and `release-keys` (Page Up moves off it, Page Down comes back).
- **Play.** Choose `Play timeline`, then `Pause timeline`. Step `play-pause`. The date moved while playing.
- **Link.** Open `#/vitejs/vite?t=2022-06-15`. Step `restore-link`. The date reads `Jun 2022`.
- **Release link and grove.** Step `release-link` opens `#/vitejs/vite?t=2021-02-16` on `v2.0`. Step `release-grove` opens vite beside Linux at `t=2022-07-13`: marks in both seeds, Linux's 2.6 releases reaching back before vite's first commit.
- **Export.** Choose `Export PNG`. Step `export-png`. `vitejs-vite-tree-2022-06-15.png` is saved to the evidence folder.
- **Unavailable.** Load `acme/widgets` from the stand-in API and click `Timeline`. Step `unavailable`. The toast reads `History unavailable for this repo`.
- `timeline-labels` has no journey step; `e2e/timeline.spec.ts` checks the label and hover at Jul 2020 against the head.

## Gotchas

- A click on the track within half a gap of a release diamond lands on the release, not on the exact point clicked. A journey that scrubs to a fraction may land on a release's day; assert on direction (the count dropped, the date moved), not an exact month.
- `aria-disabled` makes Playwright refuse a plain click; the unavailable step clicks with `force`, as a user's tap still lands.
- The scrubber's thumb is `--thumb` wide on `#scrubber` (18 px on desktop, 22 px on a phone), so a fraction of the track maps to `thumb / 2 + at * (width - thumb)` px. The journey and `e2e/timeline.spec.ts` read the variable.
- Linux's history keeps only the last 5,000 deletions (to 2025-02), so its earlier counts read `N+ files` (`at least N files` in the slider's `aria-valuetext`). The date and count sit in a fixed-width slot so the track never resizes mid-drag; `e2e/timeline.spec.ts` checks the track holds still on Linux.
- Early frames still show the rocks: root files sit on the island for the whole timeline.
- A sample reloaded live (Reload from GitHub) keeps its timeline: with no history shared, the bundled one stands in. A branch link (every shared link names its branch) is offered to compute like a plain one, and told the default branch's name if it names another.
