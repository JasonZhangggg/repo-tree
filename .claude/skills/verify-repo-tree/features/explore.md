# Explore the tree

A user points at a branch to see which folder it is, clicks to pin that folder's card, walks up through the path crumbs, and frames the whole tree again. Pinning fades every other branch and eases the camera onto the folder.

## Sub-features

- `explore-hover` highlights the folder under the pointer and shows a tooltip with its path and file count.
- `explore-pin` pins the folder under a click and shows its card with crumbs, languages, largest subfolders and `Open on GitHub`.
- `explore-crumb` pins an ancestor from the crumbs.
- `explore-side-list` pins a top-level folder from the side panel list.
- `explore-label` pins a folder from its label pill over the tree. Pinned, the folder's biggest subfolders get smaller labels of their own, and the other top-level labels fade.
- `explore-rock` hovers a rock on the ground to see the root file it stands for (name and size, or `N more files` on the last rock past twelve), and clicks it to pin the root folder with that file's card. `view.pickAt` returns `{ folder: 0, rock }` there. e2e covers it in `a rock names its root file on hover and pins it on click`.
- `explore-clear` clears the pin with Escape or `Clear selection`.
- `explore-legend` highlights one legend entry's leaves on click (hover previews it on desktop), shows its file count under the legend, writes `hl=` to the URL, and clears on a second click, Escape or a pin.
- `explore-frame` frames the whole tree with `f`.
- `explore-orbit` orbits by dragging and zooms by scrolling.
- `explore-breeze` sways the tree gently in a breeze unless motion is reduced: the crown's top by about a hundredth of the tree's height, each leaf fluttering faintly on its stem, and the grass and flowers from their roots. The trunk stays put. Under reduced motion the scene holds still. Journeys run with reduced motion, so check it with motion allowed.
- `explore-hint` shows `Drag to orbit · scroll to zoom · click a branch to pin` beside the desktop controls until the first drag or click on the tree, then fades it out and keeps it hidden on later visits (localStorage `repo-tree:hint-seen`). e2e covers it in `the orbit hint fades after the first drag and stays gone`.

## How to get to it (user POV)

- Move the mouse over a branch or leaf cluster.
- Click a branch, a label pill, or a folder in the `Top-level folders` list.
- Choose a crumb button in the pinned card.
- Press Escape, or choose `Clear selection` in the card.
- Press `f` anywhere outside a text field.
- Drag on the canvas, or scroll over it.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive explore --port <port>`.
- The journey opens `#/vitejs/vite` and waits for the camera to rest, recording the whole-tree camera distance from `view.stats().distance`.

- **Hover.** Move the mouse to the first label anchor offset where the bare canvas has a limb (the helper `limb()` checks `elementFromPoint` is the canvas and `view.pickAt` is not null). Step `hover`. `body[data-hovered]` names a folder and `role="tooltip"` is visible.
- **Pin.** Click the same point. Step `pin`. The crumbs read `vite/<hovered path>`, the URL ends with `sel=<hovered path>`, and `Open on GitHub` links to `https://github.com/vitejs/vite/tree/main/<hovered path>`.
- **Crumb.** Choose the `vite` crumb. Step `crumb`. The crumbs read `vite`.
- **Side list.** Choose `playground/` in `Top-level folders`. Step `side-list`. The crumbs read `vite/playground`.
- **Frame whole.** Press Escape, then `f`. Step `frame-whole`. The card is hidden and the camera distance returns to the whole-tree distance.
- **Proof.** `report.json` passes, and `02-hover.png` shows the tooltip while `03-pin.png` shows the faded tree and the pinned card.
- `explore-label`, `explore-orbit` and `explore-legend` have no step. `e2e/app.spec.ts` covers pinning by label on a phone and the legend highlight on both viewports.

## Gotchas

- A label anchor can fall between leaves, where nothing picks, and a label pill covers its own anchor. Hovering a pill highlights the folder but shows no tooltip. Aim with `limb()`, not a fixed label.
- The pick returns the deepest folder under the pixel, often a subfolder of the labeled one. Assert against `window.__repoTree.hovered`, not the label's path.
- Pinning eases the camera. Wait for `view.stats().renders` to stop changing before measuring distance or taking a framing screenshot.
- Escape first closes an open dialog, then clears the pin, then cancels a load, then dismisses an error. Close dialogs before pressing it to clear.
