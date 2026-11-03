# Settings

A user changes how the tree looks and loads from the Settings popover (a bottom sheet on a phone). Every control applies live and survives a reload. Palette and color by also travel in the share link.

## Sub-features

- `settings-palette` recolors leaves, bark and sky with Autumn, Spring blossom, Summer green or Winter without regrowing.
- `settings-color-by` colors leaves by language or by top-level folder and retitles the legend.
- `settings-quality` picks Auto, Low, Medium or High and regrows the tree.
- `settings-toggles` switches spin, folder labels and the growth animation.
- `settings-hidden` hides folders by exact name at any depth and regrows the tree.
- `settings-token` saves a GitHub token in this browser and sends it only to `api.github.com`.
- `settings-persist` restores every setting after a reload.

## How to get to it (user POV)

- Choose the `Settings` tool in the header (in the bottom controls on a phone).
- Choose `Add a token` in a not-found or rate-limit error.
- Press Space outside a text field to toggle spin.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive settings --port <port>`.
- The first-visit `vitejs/vite` tree is ready.

- **Open.** Choose `Settings`. Step `open`. The dialog `Settings` is visible.
- **Palette.** Choose the `Winter` radio. Step `palette`. The URL has `palette=winter`.
- **Color by.** Choose `Top-level folder`. Step `color-by`. The URL has `colorBy=folder` and `#legend-title` reads `Leaf colors by folder`.
- **Quality.** Choose `High`. Step `quality`. A new tree replaces the old one (`__repoTree.tree` changes and `ready` is true) and `High` is checked.
- **Hidden folder.** Type `playground` into `Folder name to hide` and choose `Hide`. Step `hide-folder`. The tree regrows and no folder path is `playground`.
- **Token.** Type `ghp_verify_fake` into `GitHub token` and press Enter, close Settings, and load `acme/widgets` from the stand-in API. Step `token`. `Token saved in this browser` shows, and every request that carried an `Authorization` header went to `api.github.com`.
- **Persist.** Reload. Step `reload`. localStorage `repo-tree:settings` holds `palette: winter`, `colorBy: folder`, `quality: high`, the token and `playground` in `hidden`, and the reopened dialog has `Winter` checked.
- **Proof.** `report.json` passes, and `02-palette.png`, `03-color-by.png` and `05-hide-folder.png` show each visible change.
- `settings-toggles` has no step.

## Gotchas

- Quality and hidden folders regrow the tree, which swaps `__repoTree.tree`. Wait for that swap. `body[data-ready]` may still name the same repo from before the regrow.
- Auto quality steps down once if the first 2 s after growth render under 30 fps. On the SwiftShader renderer it usually lands on Low, so journeys pin quality explicitly.
- With reduced motion on, the growth animation toggle is disabled and says so.
- The token step proves the header goes only to `api.github.com` against a stand-in. It cannot prove that GitHub accepts the token here.
