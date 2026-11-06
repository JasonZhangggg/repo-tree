# Load a repo

A user grows a tree from a bundled sample or from any GitHub repository named as `owner/repo` or a GitHub URL. While a new repo loads, the old tree stays on screen. A failed load names the problem and offers a next step.

## Sub-features

- `load-first-visit` grows the bundled `vitejs/vite` sample on a visit with no hash.
- `load-sample` grows a bundled sample from its button with no network.
- `load-suggest` lists recent repos and bundled samples under the focused input.
- `load-invalid` explains the accepted formats for text that is not a repo.
- `load-github` loads `owner/repo` or a `github.com` URL from the GitHub API.
- `load-truncated` warns when GitHub cut the file list short.
- `load-network` says GitHub is unreachable and keeps the old tree.
- `load-rate-limited` names the reset time and offers a token.
- `load-not-found` names the repo and offers a token for private repos.
- `load-reload` skips the one-hour cache with the reload button beside the branch.
- `load-size` grows a bigger tree for more files on an island of one size, framed at one scale for every repo.

## How to get to it (user POV)

- Open the app with no hash.
- Open the repo field (the repo card's GitHub mark or name) and choose `dotfiles`, `vite` or `linux` in its suggestion list.
- Focus the `owner/repo or GitHub URL` input to see suggestions.
- Type a repo or paste a URL into the input and press Enter (there is no Grow button; a pick from the list grows at once). A bad name shows `Use owner/repo…` in `#alerts`, the bottom-left corner just above the bottom row's buttons (on a phone a full-width row under the card up top); load errors and the partial-tree notice render there too, in `#notices`.
- Open a link with a `#/owner/repo` hash.
- Choose `Reload from GitHub` beside the branch name.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive load-repo --port <port>`.
- Each GitHub step installs its own stand-in. `acme/widgets` and `acme/partial` serve the dotfiles sample (36 files) through `serveRepo`.

- **First visit.** Open `/`. Step `first-visit`. The heading reads `vitejs/vite` and `body[data-ready="vitejs/vite"]` is set.
- **Sample.** Open the repo field and choose the `mathiasbynens/dotfiles` suggestion. Step `sample-button`. `body[data-ready="mathiasbynens/dotfiles"]` is set.
- **Invalid text.** Enter `not a repo`. Step `invalid-input`. `#repo-error` reads `Use owner/repo, like vitejs/vite, or paste a GitHub URL.`
- **GitHub URL.** Enter `https://github.com/acme/widgets`. Step `github-url`. The tree grows, `#repo-meta` shows `36 files` and the URL hash is `#/acme/widgets?branch=main...`.
- **Truncated.** Enter `acme/partial`, whose stand-in tree has `truncated: true`. Step `truncated`. `#notices` shows `Partial tree`.
- **Unreachable.** Enter `acme/offline` with every API call aborted. Step `unreachable`. The alert in `#notices` reads `Can’t reach GitHub` and the heading still reads `acme/partial`.
- **Rate limit.** Enter `acme/limited` with a 403 and `x-ratelimit-remaining: 0`. Step `rate-limited`. The alert says the rate limit is used up and names the reset time.
- **Not found.** Enter `acme/missing` with a 404. Step `not-found`. The alert reads `Can’t find acme/missing`. Choosing `Add a token` opens Settings with focus in `GitHub token`.
- **Proof.** `report.json` passes, and `04-github-url.png`, `05-truncated.png` and `08-not-found.png` show the loaded repo, the notice and the error card.
- **Tree sizes.** Run `drive tree-sizes --port <port>` (and `--viewport phone-390`). Steps `dotfiles`, `vite` and `linux` open each sample by link in Autumn. The island has the same size and place in all three, and the tree grows from a sapling to a full crown with nothing clipped.
- `load-suggest` and `load-reload` have no step yet. Prove them by hand with the same page and say so.

## Gotchas

- The app's error copy uses a typographic apostrophe (`Can’t`). Match it exactly or use a regex.
- Later `page.route` handlers win. `failRepo` catches every API URL, so install it after any `serveRepo` the journey still needs.
- GitHub snapshots are cached in IndexedDB for an hour per `owner/repo@ref`. A repo loaded once in the context comes back from cache even after its route changes. Use a new repo name per case.
- An `offline` message appears only when `navigator.onLine` is false. An aborted request with the browser online reads `Can’t reach GitHub`.
- `api.github.com` is unreachable from this sandbox, so `load-github` against a real repo cannot be proven here. The stand-in exercises the same `fetchSnapshot` code. A live check needs a machine with GitHub access.
