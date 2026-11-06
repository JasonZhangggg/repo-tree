# Compare trees

A user compares two repos in one world. `Compare trees` grows a second repo on its own island beside the one on show, close by, and the camera frames and orbits the pair about the middle between them. The app keeps one set of panels, for the repo on show. The repo card gains a `Beside` row naming the compared repo with its file count, a line on how the sizes compare, and `Switch`, `Change` and `Stop comparing`. The side panel gains a `Side by side` table: files, folders, deepest folder, size and the top languages with each tree's share. `Color by` applies to both trees. Languages rank by their share of each tree, so a language wears one color on both.

## Sub-features

- `compare-open` opens beside the most recent other repo, else `vitejs/vite`, else `mathiasbynens/dotfiles` (samples grow with no network). The button shows pressed, and a second press stops comparing.
- `compare-world` both islands sit side by side across the default view with a small gap; Reset view and spin frame the pair.
- `compare-table` the table and the size line fill once the compared repo has grown; language rows show swatches in the shared leaf colors.
- `compare-colors` folder colors give each tree its own folders; activity, changes and owner (which need a history) color the compared tree by language.
- `compare-change` `Change` opens a field and quick picks (recent repos and samples not on show). A bad ref is flagged under the field, and a load error shows in the `Beside` row.
- `compare-switch` `Switch` loads the compared repo as the one on show, and the old one goes beside it.
- `compare-link` the hash carries `vs=owner/repo` while comparing, and a link with `vs` compares.
- `compare-timeline` the compared island steps aside while the timeline is open.
- `compare-stop` the × in the `Beside` row (or the Compare button again) stops comparing and drops `vs`.

## How to get to it (user POV)

- Choose `Compare trees` beside Timeline, or under `More actions` on a phone.
- Open a link with `vs=`, for example `#/vitejs/vite?vs=mathiasbynens/dotfiles`.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive compare --port <port>`, and again with `--viewport phone-390`.
- The journey serves `acme/widgets` from the dotfiles sample through the stand-in API.

- **Open.** Choose `Compare trees`. Step `open`. `#compare[data-ready="mathiasbynens/dotfiles"]`, the hash has `vs=` and the size line reads `vite has 81× the files of dotfiles`. The screenshot shows two islands.
- **Change.** Choose `Change`, enter `acme/widgets`. Step `change`. It grows beside, and the hash follows.
- **Switch.** Choose `Switch`. Step `switch`. The heading is `acme/widgets`, and vite stands beside it.
- **Stop.** Choose `Stop comparing`. Step `stop`. One island again, and no `vs`.

## Gotchas

- Wait for `#compare[data-ready="<owner>/<repo>"]` for the compared tree. `body[data-ready]` is only the tree on show.
- `getByRole('button', { name: 'Change' })` also matches `Change repository`, so use `exact: true`.
- On a phone the table is in the sheet: open it with `#sheet-toggle` to see it.
- `torvalds/linux` grows slowly on SwiftShader, so the journey keeps it out.
