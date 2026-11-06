# Compare trees

A user compares up to five repos in one world. The repo on show is tree A; each repo added is grown on its own island in a row to its right (B, C, D, E), and the camera frames and orbits the row about its middle.

There is one search bar. It says `Grow` and loads a repo in place of the one on show. The repo card ends with `Compare with another repo` (`Add another repo` once comparing). That row turns the bar's button into `Compare` and its placeholder into `Compare owner/repo with…`, and the next pick adds a repo beside the others instead. Clicking out or Escape turns it back to Grow. Each compared repo gets a row in the card, like A's: its letter, name, CI chip, branch and counts, and × (`Remove owner/repo from the comparison`). A gets an × of its own while comparing (`Remove A from the comparison`), which puts B on show and keeps the rest. At five trees the add row turns off and says `5 repos is the most at once`. A name tag with the same letter hangs under each island.

While comparing, the side panel's repo sections give way to `Side by side`: a size line, a table of files, folders, deepest folder, size and languages with a column per tree (`All trees side by side`), then a section for the Color by mode. `Color by` applies to every tree, each colored from its own history. The sky and PR birds describe one repo, so they wait while comparing; each row has its own CI chip instead. Folder labels go too.

## Sub-features

- `compare-add` the card's add row (or `Compare trees` under `More actions` on a phone) focuses the bar in its Compare state; it lists recent repos and samples not already compared, refuses one already in (`That one is already in the comparison…`), and reverts to Grow on click-out or Escape.
- `compare-world` the islands sit in a row across the default view with a small gap; Reset view and spin frame the row, and the view takes the free region that fits the row best.
- `compare-scale` the biggest tree keeps its height and each other shrinks to the cube root of its file ratio of it (`sizeScales`); islands keep their size, and stopping puts the tree back at its own height.
- `compare-rows` one row per compared repo, like A's; a row shows `Growing …` or the error while it loads.
- `compare-remove` each row's × drops that repo; A's × puts B on show; dropping the last one ends the comparison.
- `compare-cap` at five trees the add row is disabled.
- `compare-tags` a tag under each island with its letter and repo name (owner too when two share a name).
- `compare-panel` the size line (two trees: `vite has 81× the files of dotfiles`; more: biggest against smallest) and the general table, a column per tree; with more than two the share bars drop and the numbers stay.
- `compare-mode` the section under it follows Color by: `language` a share table in the shared leaf colors; `folder` and `owner` each tree's own list; `activity` and `changes` a table of each tree's split, and for `changes` each tree's `Busiest files`. A tree with no history says `Reading its history…`, `No stored history` or `History unavailable`.
- `compare-ci` each row has its own CI chip; no sky, birds or folder labels while comparing; they come back on stop.
- `compare-link` the hash carries one `vs=owner/repo` per compared repo, in order; a link with `vs` compares.
- `compare-timeline` the compared islands and the tags step aside while the timeline is open.

## How to get to it (user POV)

- Choose `Compare with another repo` at the bottom of the repo card, or `Compare trees` under `More actions` on a phone, then pick or type a repo.
- Open a link with `vs=`, for example `#/vitejs/vite?vs=mathiasbynens/dotfiles&vs=acme/widgets`.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive compare --port <port>`, and again with `--viewport phone-390`.
- The journey serves `acme/widgets` from the dotfiles sample through the stand-in API.

- **Adding.** Choose the add row. Step `adding`. The bar's button reads `Compare` and the list is open.
- **Open.** Pick `mathiasbynens/dotfiles`. Step `open`. `#compare[data-ready="mathiasbynens/dotfiles"]`, the hash has `vs=`, the bar says Grow again, and the size line reads `vite has 81× the files of dotfiles`.
- **Three.** Add `acme/widgets` by typing it. Step `three`. Three islands, tags A to C, and two `vs=` in the hash.
- **Changes.** Open `#/vitejs/vite?vs=mathiasbynens/dotfiles&colorBy=changes`. Step `changes`. The panel shows the change split for both and two `Busiest files` lists.
- **Stop.** Remove dotfiles with its ×. Step `stop`. One island, no rows, and no `vs`.

## Gotchas

- `#compare[data-ready]` lists the grown compared repos in order, space-separated. `body[data-ready]` is only the tree on show.
- The rows are in the `Compared repos` group; each name is a level-2 heading. A's name stays the h1.
- On a phone the side by side is in the sheet: open it with `#sheet-toggle` to see it. Row meta is hidden there to keep each row to one line.
- `torvalds/linux` grows slowly on SwiftShader, so the journey keeps it out.
