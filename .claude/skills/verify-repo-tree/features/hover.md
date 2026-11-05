# Hover highlight

On a desktop, everything in the 3D scene that a click opens lights up under the mouse and takes a pointer cursor. A bird swells and shows a gold halo, drawn over the leaves so a half-hidden bird still shows where it is. A rock, a cloud and the sun (or moon) tint toward the same gold, and the sun and clouds swell a little. A folder's branch keeps its own hover preview: the rest of the tree fades (see [Explore](./explore.md)). Moving off the scene clears the highlight and the cursor. Touch screens have no hover, so nothing lights up there.

## Sub-features

- `hover-bird` swells the bird under the mouse, rings it in gold and shows the PR tooltip.
- `hover-rock` tints the rock under the mouse gold and shows its file tooltip.
- `hover-cloud` tints and swells the cloud under the mouse.
- `hover-sun` brightens and swells the sun, or the moon in dark mode.
- `hover-cursor` sets the pointer cursor on each of these and clears it on empty sky.
- `hover-night` reads the same gold on the night sky.

## How to get to it (user POV)

- Move the mouse over a bird, a rock, a cloud or the sun on a desktop.

## Driving it with drive.mjs

Preconditions: desktop viewport. The journey serves `VITE_PULLS` for birds and opens `vitejs/vite` with `wx=cloudy`, so a sun and clouds are out.

- **Bird, rock, cloud, sun.** Steps `bird`, `rock`, `cloud` and `sun` each find a point on the object (birds through `view.birdsOnScreen()` and the tooltip, the rest by scanning `view.pickAt` and `view.skyTargetAt`), then save a close-up pair: `<kind>-off.png` with the mouse away and `<kind>-on.png` with it over the object. Each asserts the pointer cursor.
- **Away.** Step `away` moves to a bare corner and the cursor clears.
- **Night.** Step `night` seeds `theme: 'dark'`, reloads and saves `night-cloud-*` and `night-moon-*` pairs.
- **Proof.** `report.json` passes, and each `*-on.png` shows the gold highlight its `*-off.png` lacks. Pass `--scale 2` for close-ups worth reading.

## Gotchas

- A bird the pick finds may be mostly behind leaves. The halo draws over them on purpose, so that is still a fair proof.
- Hovering a bird also previews its perch folder, so the tree fades in `bird-on.png`. That is the bird's existing folder preview, not this feature.
- `view.skyTargetAt` returns `'sun'` or a cloud's index, and 0 is a cloud. Test it against `null`, not for truthiness.
