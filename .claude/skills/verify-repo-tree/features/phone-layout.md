# Phone layout

On a narrow screen the side panel becomes a bottom sheet with a peek row, the tools join the bottom controls, and a tap on a branch pins it while the tree stays in view.

## Sub-features

- `phone-frame` frames the tree between the header and the sheet peek.
- `phone-tap-pin` pins a folder with a tap and names it in the peek without opening the sheet.
- `phone-sheet` opens and closes the sheet from its handle and shows the pinned card inside it.
- `phone-clear` clears the pin from inside the sheet.
- `phone-settings` opens Settings as a bottom sheet from the bottom controls.
- `phone-orbit` orbits by touch drag.

## How to get to it (user POV)

- Open the app on a phone-width screen (760 px wide or less).
- Tap a branch or a label, then tap the sheet handle.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive phone-layout --viewport phone --port <port>`.
- The viewport is Playwright's `Pixel 7` (412 by 839 CSS px, touch, device scale 2.625).

- **Open.** Open `/`. Step `open`. `#sheet-toggle` has `aria-expanded="false"`.
- **Tap to pin.** Tap the `playground` label anchor. Step `tap-to-pin`. `#sheet-toggle` contains `playground` and the card is still hidden.
- **Open sheet.** Tap `#sheet-toggle`. Step `sheet-open`. It is expanded and the crumbs contain `playground`.
- **Clear.** Tap `Clear selection`. Step `clear`. `#sheet-title` reads `Folders and leaf colors`.
- **Settings.** Tap `#sheet-toggle` to collapse, then tap `Settings`. Step `settings-sheet`. The `Settings` dialog is visible.
- **Proof.** `report.json` passes, and `02-tap-to-pin.png` and `03-sheet-open.png` show the peek and the open sheet.
- `phone-frame` is asserted by pixel share in `e2e/app.spec.ts`, not here. `phone-orbit` has no step.

## Gotchas

- The plan's target is a 390 px phone. `Pixel 7` is 412 px. For the narrower width, add `--viewport` support or prove it by hand with `viewport: { width: 390, height: 844 }`.
- While the sheet is open, the bottom controls (Settings, Search, Share, PNG) are hidden. Collapse the sheet before tapping them.
- Labels are hidden while the sheet or Settings is open, so `__repoTree.labels` positions are not tappable then.
