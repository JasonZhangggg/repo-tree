# Phone layout

On a narrow screen the side panel becomes a bottom sheet with a peek row, the bottom row keeps Timeline, Search, Settings and `More actions`, and a tap on a branch pins it while the tree stays in view.

## Sub-features

- `phone-frame` frames the tree between the header and the sheet peek.
- `phone-tap-pin` pins a folder with a tap and names it in the peek without opening the sheet.
- `phone-sheet` opens and closes the sheet from its handle and shows the pinned card inside it.
- `phone-sheet-drag` drags the sheet with a finger: it follows the handle up or down, or down from its content once that is scrolled to the top, and snaps open or closed by distance and speed on release. A quick short flick switches it, a short slow drag springs back, and content further down scrolls instead.
- `phone-clear` clears the pin from inside the sheet.
- `phone-settings` opens Settings as a bottom sheet from the bottom controls.
- `phone-orbit` orbits by touch drag.
- `phone-more` opens `More actions` from the bottom row, which holds Sign in (in a build with the history server), Copy link, Export PNG and Open on GitHub. Grow again, Spin and Dark mode are desktop buttons only: on a phone Spin and Dark mode are switches in Settings. Choosing one, Escape or a tap outside closes it. e2e covers it in `the phone row keeps four buttons and a short menu sits behind More actions`; journeys choose those actions through it.

- `phone-repo-row` folds the repo field into the repo row: name, branch, files, reload and weather on one line, with a GitHub button (`Change repository`) that opens the field in its place with the suggestions. Escape, picking a repo or tapping away folds it again. Tapping the repo name opens the field too. The branch chip links to the branch on GitHub, and on a phone shows only for a branch asked for by link (`/tree/<branch>`), not the default one; `Open on GitHub` sits last in `More actions`. The weather chip shows its icon and a short verdict (`CI passing`, `No CI runs`) so it reads as CI, and under 420 px the file count drops so the row's buttons never clip. e2e: `on a phone the repo field folds into the repo row`. Helpers that type a repo open it first (`openRepoField` in `e2e/view.ts`, `enter` in drive.mjs).
- `phone-touch` keeps gestures on the tree: the page never pinch- or double-tap-zooms (`touch-action: pan-x pan-y` on body, plus iOS `gesturestart` prevented), long presses don't select text, and labels take no pointer events on touch screens, so a drag or pinch that starts on a label turns or zooms the tree. A tap on a label still pins it: `canvas.ts` hit-tests the labels on pointerup. e2e: `on a phone a drag that starts on a label turns the tree`.

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
- `phone-sheet-drag` is asserted in `e2e/sheet.spec.ts`, not here. Its swipes go through CDP `Input.dispatchTouchEvent` with explicit timestamps, so touch-action and native scrolling apply. Playwright's `touchscreen` only taps, and on a software GL each real input step is slow enough to read as a slow drag, so set the timestamps.

## Gotchas

- The plan's target is a 390 px phone. `Pixel 7` is 412 px. For the narrower width, add `--viewport` support or prove it by hand with `viewport: { width: 390, height: 844 }`.
- While the sheet is open, the bottom controls (Timeline, Search, Settings, More actions) are hidden. Collapse the sheet before tapping them.
- Framing waits for a drag to settle: `reframe` skips while `#side` has `data-dragging` and runs when it clears.
- Labels are hidden while the sheet or Settings is open, so `__repoTree.labels` positions are not tappable then.
- Labels on touch screens have `pointer-events: none`, so Playwright's actionability check refuses to click one. Tap its box with `touchscreen.tap`, or `click({ force: true })`.
