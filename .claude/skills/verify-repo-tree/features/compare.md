# Compare trees

A user compares two repos in one world. `Compare` grows a second repo on its own island beside the one on show, close by, and the camera frames and orbits the pair about the middle between them. The repo on show is tree A (left in the default view) and the compared one tree B.

The top left keeps A's own repo field and card, each marked with an `A`, and adds the same pair for B under them: a field (`Repository B`) and a card like A's with its name, branch, counts, its own CI chip and `Stop comparing` (×). On a desktop both fields stay open in their own rows; on a phone each card is a single row and B's mark (`Change repository B`) opens its field in the card's place. A name tag with the same letter hangs under each island.

While comparing, the side panel's repo sections give way to `Side by side`: a size line, a table of files, folders, deepest folder, size and languages for both (`Both trees side by side`), then a section for the Color by mode. `Color by` applies to both trees, each colored from its own history. The sky and PR birds describe one repo, so they wait while comparing; each card has its own CI chip instead. Folder labels go too.

## Sub-features

- `compare-open` the `Compare` button sits beside the repo field in the top bar (under `More actions` on a phone). It opens beside the most recent other repo, else `vitejs/vite`, else `mathiasbynens/dotfiles` (samples grow with no network). It shows pressed, and a second press stops comparing.
- `compare-world` both islands sit side by side across the default view with a small gap; Reset view and spin frame the pair.
- `compare-scale` the bigger tree keeps its height and the smaller shrinks to the cube root of their file ratio of it (vite beside dotfiles: dotfiles stands about a quarter of vite's height); its island keeps its size, and stopping puts the tree back at its own height.
- `compare-cards` A's and B's cards look alike: letter, name, branch, reload, counts, GitHub link and CI chip. B's shows `Growing …` or the error while it loads.
- `compare-fields` each tree has its own field. B's offers recent repos and samples, flags a bad ref, and refuses A's repo (`That one is already A…`). A's loads another repo in A's place and keeps B.
- `compare-tags` a tag under each island with its letter and repo name (owner too when both share a name).
- `compare-panel` the size line and the general table fill once both trees have grown; columns follow A then B, with badges.
- `compare-mode` the section under it follows Color by: `language` a share table in the shared leaf colors; `folder` and `owner` each tree's own list; `activity` and `changes` a table of each tree's split, and for `changes` each tree's `Busiest files`. A tree with no history says `Reading its history…`, `No stored history` or `History unavailable`.
- `compare-ci` each card has its own CI chip; no sky, birds or folder labels while comparing; they come back on stop.
- `compare-link` the hash carries `vs=owner/repo` while comparing; a link with `vs` compares.
- `compare-timeline` the compared island and the tags step aside while the timeline is open.
- `compare-stop` `Stop comparing` (or the Compare button again) stops comparing and drops `vs`.

## How to get to it (user POV)

- Choose `Compare` beside the repo field, or under `More actions` on a phone.
- Open a link with `vs=`, for example `#/vitejs/vite?vs=mathiasbynens/dotfiles`.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive compare --port <port>`, and again with `--viewport phone-390`.
- The journey serves `acme/widgets` from the dotfiles sample through the stand-in API.

- **Open.** Choose `Compare trees`. Step `open`. `#compare[data-ready="mathiasbynens/dotfiles"]`, the hash has `vs=` and the size line reads `vite has 81× the files of dotfiles`. The screenshot shows two cards and two islands with an A and a B tag.
- **Changes.** Open `#/vitejs/vite?vs=mathiasbynens/dotfiles&colorBy=changes`. Step `changes`. The panel shows the change split for both and two `Busiest files` lists.
- **Change.** Enter `acme/widgets` in `Repository B`. Step `change`. It grows beside, and the hash follows.
- **Stop.** Choose `Stop comparing`. Step `stop`. One island, one card, and no `vs`.

## Gotchas

- Wait for `#compare[data-ready="<owner>/<repo>"]` for the compared tree. `body[data-ready]` is only the tree on show.
- B's card and field are in the `Repository B` group; its name is a level-2 heading. A's name stays the h1.
- On a phone the side by side is in the sheet: open it with `#sheet-toggle` to see it.
- `torvalds/linux` grows slowly on SwiftShader, so the journey keeps it out.
