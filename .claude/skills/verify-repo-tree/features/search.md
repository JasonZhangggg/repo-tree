# Search

A user finds a folder or file by name or path, chooses a hit, and the tree pins and frames it. A file hit pins its folder and shows a file card.

## Sub-features

- `search-open` opens the dialog from the `Search` tool or the `/` key.
- `search-match` lists folder and file hits with the matched characters marked.
- `search-folder` pins and frames a folder hit.
- `search-file` pins the file's folder and shows the file card with `Open file on GitHub`.
- `search-empty` shows `No folder or file matches “<query>”.` for a query with no hits.
- `search-keys` moves through hits with the arrow keys and closes with Escape.

## How to get to it (user POV)

- Press `/` while focus is outside a text field.
- Choose `Search` in the header tools (in the bottom controls on a phone).

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive search --port <port>`.
- The first-visit `vitejs/vite` tree is ready.

- **Open.** Press `/`. Step `open`. The combobox `Search folders and files` has focus.
- **Match.** Type `node/server`. Step `match`. The first option contains `packages/vite/src/node/server/`.
- **Choose folder.** Press Enter. Step `choose`. The dialog closes, the crumbs read `vite/packages/vite/src/node/server`, and the URL ends with `sel=packages/vite/src/node/server`.
- **File hit.** Choose `#search-open`, type `packages/vite/package.json` and press Enter. Step `file-hit`. The card's `.file-card code` reads `package.json` and the crumbs read `vite/packages/vite`.
- **No match.** Reopen search and type `zzqqxx`. Step `no-match`. No option is listed and the dialog shows `No folder or file matches “zzqqxx”.`
- **Proof.** `report.json` passes, and `03-choose.png` and `04-file-hit.png` show the framed, pinned results.
- `search-keys` has no step beyond Enter on the first hit.

## Gotchas

- `/` typed while the repo input has focus types a slash. Click the canvas or press Escape first.
- Search covers only the repo on screen. Wait for `body[data-ready]` after a load before searching.
- The empty-state text uses typographic quotes around the query.
