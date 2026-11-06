# Compare trees

A user sets two repos side by side. `Compare trees` in the bottom controls covers the page with two panes, the repo on show on the left and a second repo on the right (stacked on a phone), each tree orbiting on its own. A card on each pane names its repo with files, folders and size, a sentence in the bar says how their file counts compare, and a table below lists files, folders, the deepest folder, size and the top languages with each tree's share. Both trees color leaves by language, ranked across the two, so a language wears one color on both.

## Sub-features

- `compare-open` opens beside the most recent other repo, else `vitejs/vite`, else `mathiasbynens/dotfiles` (a sample, so it grows with no network). The main tree holds still behind it and is inert.
- `compare-table` the table and the sentence fill once both trees are in; language rows name languages from either tree, with a bar in the leaf color.
- `compare-change` `Change` opens a field and quick picks (recent repos and samples not on show); a ref grows on the right, a bad one says so under the field, and a load error shows on the pane's card.
- `compare-swap` `Swap sides` loads the right repo as the one on show and moves the left one to the right.
- `compare-open-tree` `Open this tree` closes the view and loads the right repo on its own.
- `compare-link` the hash carries `vs=owner/repo` while open; a link with `vs` opens the view.
- `compare-close` Escape or the x closes it, drops `vs` and returns focus to the button.

## How to get to it (user POV)

- Choose `Compare trees` beside Timeline, or under `More actions` on a phone.
- Open a link with `vs=`, for example `#/vitejs/vite?vs=mathiasbynens/dotfiles`.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive compare --port <port>`, and again with `--viewport phone-390`.
- The journey serves `acme/widgets` from the dotfiles sample through the stand-in API.

- **Open.** Choose `Compare trees`. Step `open`. Both panes reach `data-ready`, the hash has `vs=mathiasbynens/dotfiles` and the bar says `vite has 81× the files of dotfiles`.
- **Change.** Choose `Change`, enter `acme/widgets`. Step `change`. The right pane grows it and the hash follows.
- **Swap.** Choose `Swap sides`. Step `swap`. Left shows `acme/widgets`, right `vitejs/vite`.
- **Close.** Press Escape. Step `close`. The view is gone, the main tree is `acme/widgets` and `vs` left the hash.

## Gotchas

- Each pane is its own WebGL context; wait for `.cmp-pane[data-side=a|b][data-ready="<owner>/<repo>"]`, not `body[data-ready]`, which is the main tree's.
- `getByRole('button', { name: 'Change' })` also matches `Change repository` behind the view in a non-inert query; use `exact: true`.
- `torvalds/linux` grows slowly on SwiftShader; the journey avoids it on the right.
