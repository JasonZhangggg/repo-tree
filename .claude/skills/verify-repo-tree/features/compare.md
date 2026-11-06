# Compare trees

A user compares up to five repos in one world, a grove. Each repo is grown on its own island, and the islands stand in a shape: two side by side, three in a triangle, four in a square, five as three behind and two in front. The tallest trees take the back row, which floats higher; each row keeps the card's order left to right. The camera frames them all, and spin sways it gently about the front instead of going round, so the grove never shows backwards.

There is one search bar, with no button: a pick or Enter loads a repo in place of the one on show. The repo card ends with `Compare with another repo` (`Add another repo` once comparing). That row shows a `Compare` tag in the bar (`#repo-mode`) and turns its placeholder into `Compare owner/repo with…`, and the next pick adds a repo beside the others instead. Clicking out or Escape takes the tag away. While comparing the card becomes the grove's list: a head `Side by side · N trees` with `Done`, then one line per tree, the one on show first: a seed in the tree's own soft color, its name and owner, its files, its CI chip as a glyph alone (the words in its tooltip), and × (`Remove owner/repo from the comparison`; on a desktop it shows on hover). The first tree's × puts the next on show and keeps the rest. At five trees the add row turns off and says `5 repos is the most at once`. A tag with the same seed and the repo's name hangs under each island. A line (`Show only owner/repo`) or a tag shows that tree alone: the comparison ends and the card's add row becomes `Back to all N trees`, which brings the grove back as it was. Hovering a branch on any tree of the grove lights that branch and names it in the tip (`owner/repo/path/`, its files, `click to show`); a click on another tree's branch shows that tree alone with that folder pinned, and `Back to all N trees` returns.

While comparing, the side panel's repo sections give way to `Side by side`: a size line, a `Compare by` switch (Files, Folders, Depth, Size) and a line per tree with a bar in its seed color and the number (`All trees side by side`), then a section for the Color by mode, again a line per tree. `Color by` applies to every tree, each colored from its own history. The sky and PR birds describe one repo, so they wait while comparing; each row has its own CI chip instead. Folder labels go too.

## Sub-features

- `compare-add` the card's add row (or `Compare trees` under `More actions` on a phone) focuses the bar in its Compare state; it lists recent repos and samples not already compared, refuses one already in (`That one is already in the comparison…`), and drops the Compare tag on click-out or Escape. The refusal shows in `#alerts`, not under the field.
- `compare-world` the islands stand in the grove's shape (`groveSpots`) a small gap apart; Reset view frames them, spin sways about the front so the grove never shows backwards, and the view takes the free region that fits it best.
- `compare-scale` the biggest tree keeps its height and each other shrinks to the cube root of its file ratio of it (`sizeScales`); islands keep their size, and stopping puts the tree back at its own height.
- `compare-rows` one line per tree, the one on show first; a line shows `Growing…` or the error in place of its files while it loads.
- `compare-focus` a line or a tag shows that tree alone; `Back to all N trees` (`#compare-back`) brings the grove back; `Done` ends the comparison.
- `compare-remove` each line's × drops that repo; the first tree's × puts the next on show; dropping the last one ends the comparison.
- `compare-cap` at five trees the add row is disabled.
- `compare-tags` a tag under each island with its seed and repo name (owner too when two share a name); a click shows that tree alone.
- `compare-panel` the size line (two trees: `vite has 81× the files of dotfiles`; more: biggest against smallest), the `Compare by` switch and a bar per tree for the chosen number.
- `compare-mode` the section under it follows Color by, a line per tree: `language` a bar split by the shared leaf colors, with one key for every tree under them (each color's share of all the trees' files, a button that highlights it on every tree); `folder` and `owner` a bar of the tree's own and its two biggest named; `activity` and `changes` a bar of the tree's split and the same shared key, and for `changes` each tree's three `Busiest files`. Each bar is an image whose label lists its parts. A tree with no history says `Reading its history…`, `No stored history` or `History unavailable`.
- `compare-ci` each line has its own CI glyph; no sky, birds or folder labels while comparing; they come back on stop.
- `compare-link` the hash carries one `vs=owner/repo` per compared repo, in order; a link with `vs` compares.
- `compare-timeline` the timeline replays every tree in the grove on one calendar (`sharedTimelines`): a younger repo's island stays bare until its first commit, the count is all the trees' files (its tooltip ends `across N trees`), and a tree joining or leaving replays from the same date. A compared repo with no stored history stands whole.

## How to get to it (user POV)

- Choose `Compare with another repo` at the bottom of the repo card, or `Compare trees` under `More actions` on a phone, then pick or type a repo.
- Open a link with `vs=`, for example `#/vitejs/vite?vs=mathiasbynens/dotfiles&vs=acme/widgets`.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive compare --port <port>`, and again with `--viewport phone-390`.
- The journey serves `acme/widgets` from the dotfiles sample through the stand-in API.

- **Adding.** Choose the add row. Step `adding`. The bar's button reads `Compare` and the list is open.
- **Open.** Pick `mathiasbynens/dotfiles`. Step `open`. `#compare[data-ready="mathiasbynens/dotfiles"]`, the hash has `vs=`, the Compare tag is gone, and the size line reads `vite has 81× the files of dotfiles`.
- **Three.** Add `acme/widgets` by typing it. Step `three`. Three islands, tags `vite`, `dotfiles`, `widgets`, and two `vs=` in the hash.
- **Focus.** Click the `dotfiles` tag. Step `focus`. dotfiles is on show alone, no `vs=`, and the card says `Back to all 3 trees`.
- **Back.** Choose `Back to all 3 trees`. Step `back`. vite is on show again with both others beside it.
- **Changes.** Open `#/vitejs/vite?vs=mathiasbynens/dotfiles&colorBy=changes`. Step `changes`. The panel shows a change bar for both and two `Busiest files` lists.
- **Stop.** Remove dotfiles with its ×. Step `stop`. One island, no rows, and no `vs`.

## Gotchas

- `#compare[data-ready]` lists the grown compared repos in order, space-separated. `body[data-ready]` is only the tree on show.
- The lines are list items in the `Compared repos` group, each with `data-repo`; the name button is `Show only owner/repo`. The repo on show's name stays the h1, visually hidden while comparing.
- On a phone the side by side is in the sheet: open it with `#sheet-toggle` to see it. The owner is hidden there to keep each line short.
- Tags are buttons with `tabindex=-1`: a keyboard reaches the same action through the lines.
- `torvalds/linux` grows slowly on SwiftShader, so the journey keeps it out.
