# Compare trees

A user compares two repos in one world. `Compare trees` grows a second repo on its own island beside the one on show, close by, and the camera frames and orbits the pair about the middle between them. The two are tree A (left in the default view) and tree B.

The repo card becomes a compare card titled `Comparing two trees`, with `Exit` and one identical row per tree: its letter badge, name, files and folders, and `Change`. Each row is a radio in the `Details shown for` group. The checked one, marked `In panels`, is the repo on show, and the panels describe it. A name tag with the same letter hangs under each island, outlined on the one in the panels. A line under the rows says how the sizes compare.

The side panel gains a `Side by side` table: files, folders, deepest folder, size and the top languages with each tree's share. Columns are headed by the A and B badges, and under the table a note says which tree the panels below show, with a button for the other. `Color by` applies to both trees. Languages rank by their share of each tree, so a language wears one color on both. CI weather (sky and chip), PR birds and folder labels show for neither tree while comparing.

## Sub-features

- `compare-open` opens beside the most recent other repo, else `vitejs/vite`, else `mathiasbynens/dotfiles` (samples grow with no network). The button shows pressed, and a second press stops comparing.
- `compare-world` both islands sit side by side across the default view with a small gap; Reset view and spin frame the pair.
- `compare-card` two alike rows, A and B, each with a letter, name, files · folders (or `Growing…` / the error), and `Change`; the shown row is outlined and marked `In panels`.
- `compare-tags` a tag under each island with the row's letter and name; a click shows that tree's details.
- `compare-table` the table and the size line fill once both trees have grown; columns follow A then B, with badges; language rows show swatches in the shared leaf colors.
- `compare-colors` folder colors give each tree its own folders; activity, changes and owner (which need a history) color the compared tree by language.
- `compare-neither` no CI sky or chip, no birds and no folder labels while comparing; they come back on Exit.
- `compare-change` `Change` on either row opens a field under it (`Repository to put in place of A|B`) and quick picks (recent repos and samples not on show). A bad ref is flagged under the field, and so is the other tree's repo. Changing the tree in the panels loads the new repo there; changing the other grows it beside.
- `compare-switch` picking the other row (or its tag, or the note's button) gives it the panels: the repo on show and the compared one trade, and both keep their letters and islands.
- `compare-link` the hash carries `vs=owner/repo` while comparing, plus `vsfirst=1` when the compared repo is A; a link with `vs` compares.
- `compare-timeline` the compared island and the tags step aside while the timeline is open.
- `compare-stop` `Exit` (or the Compare button again) stops comparing and drops `vs`.

## How to get to it (user POV)

- Choose `Compare trees` beside Timeline, or under `More actions` on a phone.
- Open a link with `vs=`, for example `#/vitejs/vite?vs=mathiasbynens/dotfiles`.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive compare --port <port>`, and again with `--viewport phone-390`.
- The journey serves `acme/widgets` from the dotfiles sample through the stand-in API.

- **Open.** Choose `Compare trees`. Step `open`. `#compare[data-ready="mathiasbynens/dotfiles"]`, the hash has `vs=` and the size line reads `vite has 81× the files of dotfiles`. The screenshot shows two islands with an A and a B tag.
- **Change.** Choose `Change B`, enter `acme/widgets`. Step `change`. It grows beside, and the hash follows.
- **Switch.** Check the `B: acme/widgets` row. Step `switch`. The heading is `acme/widgets`, B's row and tag are outlined, and vite stays on the left as A.
- **Stop.** Choose `Exit` (`Stop comparing`). Step `stop`. One island again, the normal repo card, and no `vs`.

## Gotchas

- Wait for `#compare[data-ready="<owner>/<repo>"]` for the compared tree. `body[data-ready]` is only the tree on show.
- The rows are radios named `A: owner/repo` and `B: owner/repo`; the Change buttons are `Change A, owner/repo` and `Change B, owner/repo`.
- The h1 stays in the page for screen readers but is hidden while comparing.
- On a phone the table is in the sheet: open it with `#sheet-toggle` to see it.
- `torvalds/linux` grows slowly on SwiftShader, so the journey keeps it out.
