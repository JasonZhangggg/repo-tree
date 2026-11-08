# Share and export

A user copies a link that restores the repo, branch, palette, color by and pinned folder, saves the current view as a PNG, and copies an iframe embed code that shows just the tree.

## Sub-features

- `share-copy` copies `location.href` and toasts `Link copied`.
- `share-restore` restores repo, palette and pinned folder from the link alone.
- `share-fallback` toasts `Copy the link from the address bar` when the clipboard is refused.
- `export-png` downloads `<owner>-<repo>-tree.png` at twice the canvas size and toasts `Saved <name>`.
- `embed-copy` copies `<iframe src="…&embed=1" …>` for the view on show and toasts `Embed code copied`.
- `embed-view` opens a link with `embed=1` (in the hash, or the page's own `?embed=1`): the repo card, side panel, bottom controls and toolbar hide, keys `/`, `T` and `D` do nothing, orbit, zoom, hover and pins still work, and a pill at the bottom right (`Open <owner>/<repo> in Repo Tree`) opens the same view without `embed` in a new tab. The repo card shows only while the first tree loads, and load errors keep their corner.

## How to get to it (user POV)

- Choose `Share` (`Copy link to this view`) in the header tools.
- Open a link of the form `#/owner/repo?branch=&palette=&colorBy=&sel=<folder path>`.
- Choose `PNG` (`Export PNG`) in the header tools.
- Choose `Embed` (`Copy embed code`) in the header tools, or `Copy embed code` in a phone's `More actions` menu, then paste it into another page.
- Open any link with `embed=1` added to its hash query.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive share-and-export --port <port>`.
- The journey grants `clipboard-read` and `clipboard-write` to read the copied link back.

- **Open link.** Open `#/vitejs/vite?palette=winter&sel=packages/vite`. Step `open-link`. The crumbs read `vite/packages/vite`.
- **Copy link.** Choose `Copy link to this view`. Step `copy-link`. `#toast` reads `Link copied` and the clipboard ends with `#/vitejs/vite?branch=main&palette=winter&colorBy=language&sel=packages/vite`.
- **Restore.** Open the copied link and reload so the page starts from the URL alone. Step `restore-link`. The crumbs read `vite/packages/vite` again.
- **Export.** Choose `Export PNG`. Step `export-png`. A download named `vitejs-vite-tree.png` arrives, is saved to the evidence folder and starts with the PNG signature, and `#toast` reads `Saved vitejs-vite-tree.png`.
- **Embed code.** Choose `Copy embed code`. Step `copy-embed-code`. `#toast` reads `Embed code copied` and the iframe's `src` ends with `&sel=packages/vite&embed=1`.
- **Embed view.** Open a host page the journey serves on `127.0.0.1` (another origin), then that `src`, so it starts cold. Step `open-embed`. Only the tree and the `Open vitejs/vite in Repo Tree` pill show.
- **In an iframe.** Go back to that host page, which holds the iframe. Step `embed-in-iframe`. The tree grows inside it, framed to the iframe's 640 by 480.
- **Proof.** `report.json` passes, `07-embed-in-iframe.png` shows the embed on a host page, `03-restore-link.png` shows the restored view and `vitejs-vite-tree.png` is the exported file.
- `share-fallback` has no step.

## Gotchas

- A hash change into or out of `embed=1` reloads the page, so a `goto` that only adds `embed=1` to the hash detaches any `reload` that follows it.
- `about:blank` and `setContent` pages refuse localStorage, so `quietSettings`' init script throws there and fails `no-page-errors`. Chromium also blocks a routed (public) page from framing `localhost` (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`), so the host page is a real server on `127.0.0.1`.

- `goto` to a URL that differs only in its hash does not reload the page. Reload after it to prove a cold start.
- The restore runs in the same browser context, so localStorage settings carry over. The link's own `palette` wins over stored settings, which is what the step checks.
- Without clipboard permission the copy falls back to a toast and the clipboard read throws.
