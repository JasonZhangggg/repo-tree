# Hover focus

On desktop, when the mouse is over something in the 3D scene that a click opens, everything else fades and a pointer cursor shows. This works the way a folder's hover preview already does. Over a bird, its perch folder stays too, and the rest of the tree, the ground, the other birds and the sky fade. Over a rock, only that rock stays. Over the sun (the moon in dark mode) or a cloud, only that one stays, and the tree, the ground and the rest of the sky fade. The hovered object itself shifts a little toward a warm light (HOVER_TINT), so it stands out from the faded scene without glowing. Moving off clears the fade, the tint and the cursor. Touch screens have no hover, so nothing changes there.

## Sub-features

- `hover-bird` keeps the bird and its perch folder while the rest fades, and shows the PR tooltip.
- `hover-rock` keeps only the rock and shows its file tooltip.
- `hover-cloud` keeps only the cloud under the mouse and shows a tag with the CI verdict, like a rock's file tag.
- `hover-sun` keeps only the sun, or the moon in dark mode, with the same tag.
- `hover-cursor` shows the pointer cursor over each of these and clears it over empty sky.
- `hover-night` fades the same way against the night sky.

## How to get to it (user POV)

- Move the mouse over a bird, a rock, a cloud or the sun on desktop.

## Driving it with drive.mjs

Preconditions: desktop viewport. The journey serves `VITE_PULLS` so birds perch, and opens `vitejs/vite` with `wx=cloudy` so the sun and clouds are out.

- **Bird, rock, cloud, sun.** Steps `bird`, `rock`, `cloud` and `sun` each find a point on the object. Birds come from `view.birdsOnScreen()` and the tooltip, and the rest from scanning `view.pickAt` and `view.skyTargetAt`. Each step saves a close-up pair, `<kind>-off.png` with the mouse away and `<kind>-on.png` with it over the object, and asserts the pointer cursor. The `cloud` and `sun` steps also assert the tag reads `… click for details`. The numbered full-page screenshot after each step shows the whole scene faded around the object.
- **Away.** Step `away` moves to a bare corner, and the fade and the cursor clear.
- **Night.** Step `night` stores `theme: 'dark'`, reloads, and saves `night-cloud-*` and `night-moon-*` pairs.
- **Proof.** `report.json` passes, and each numbered screenshot from `02-bird` to `05-sun` shows everything faded except that object.

## Gotchas

- `bird-on.png` keeps the bird's perch folder in full color because of the bird's folder preview. That is intended.
- A pinned folder keeps its own fade on the tree while a rock or the sky is hovered. Only the ground, the birds and the sky follow the hover.
- `view.skyTargetAt` returns `'sun'` or a cloud's index, and index 0 is a cloud. Compare its result to `null`, because 0 is falsy.
