# Share and export

A user copies a link that restores the repo, branch, palette, color by and pinned folder, and saves the current view as a PNG.

## Sub-features

- `share-copy` copies `location.href` and toasts `Link copied`.
- `share-restore` restores repo, palette and pinned folder from the link alone.
- `share-fallback` toasts `Copy the link from the address bar` when the clipboard is refused.
- `export-png` downloads `<owner>-<repo>-tree.png` at twice the canvas size and toasts `Saved <name>`.

## How to get to it (user POV)

- Choose `Share` (`Copy link to this view`) in the header tools.
- Open a link of the form `#/owner/repo?branch=&palette=&colorBy=&sel=<folder path>`.
- Choose `PNG` (`Export PNG`) in the header tools.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive share-and-export --port <port>`.
- The journey grants `clipboard-read` and `clipboard-write` to read the copied link back.

- **Open link.** Open `#/vitejs/vite?palette=winter&sel=packages/vite`. Step `open-link`. The crumbs read `vite/packages/vite`.
- **Copy link.** Choose `Copy link to this view`. Step `copy-link`. `#toast` reads `Link copied` and the clipboard ends with `#/vitejs/vite?branch=main&palette=winter&colorBy=language&sel=packages/vite`.
- **Restore.** Open the copied link and reload so the page starts from the URL alone. Step `restore-link`. The crumbs read `vite/packages/vite` again.
- **Export.** Choose `Export PNG`. Step `export-png`. A download named `vitejs-vite-tree.png` arrives, is saved to the evidence folder and starts with the PNG signature, and `#toast` reads `Saved vitejs-vite-tree.png`.
- **Proof.** `report.json` passes, `03-restore-link.png` shows the restored view and `vitejs-vite-tree.png` is the exported file.
- `share-fallback` has no step.

## Gotchas

- `goto` to a URL that differs only in its hash does not reload the page. Reload after it to prove a cold start.
- The restore runs in the same browser context, so localStorage settings carry over. The link's own `palette` wins over stored settings, which is what the step checks.
- Without clipboard permission the copy falls back to a toast and the clipboard read throws.
