# History sign-in and compute

A repo that is not a sample has no timeline until someone computes its history. When the build names a history server (`VITE_HISTORY_URL`) and the server has nothing for the repo's branch, `Timeline` opens a dialog. The dialog offers to work out the history in the visitor's browser with their own GitHub requests and says roughly how much that downloads. It also says the result is then shared for everyone. After the visitor signs in with GitHub in a popup, the browser computes the history, uploads it to the history Worker and opens the timeline. The next visitor, signed in or not, gets the shared copy with no prompt.

## Sub-features

- `history-offer` the dialog `No timeline yet for <repo>` names the download estimate (`under 1 MB`, `about N MB`) and that the result is shared. It offers `Sign in with GitHub` (or `Compute history` when already signed in) and `Not now`.
- `history-warn` a big repo (an estimate of 25 MB or more, Linux-sized) or a constrained device (`navigator.deviceMemory` ≤ 4 or a coarse pointer) shows a warning with the download and memory estimates. The button then reads `Sign in and compute anyway` (or `Compute anyway`).
- `history-decline` `Not now`, Escape or a click on the scrim closes the dialog without opening the timeline.
- `history-progress` during the computation the dialog shows `Working out the history of <repo>`, a progress bar, `N% · X MB of about Y MB` (just `N% · under 1 MB` for a small repo) and `Cancel`. `Sharing the history of <repo>` follows while it uploads.
- `history-failed` a failure (rate limit with its reset time, revoked token, repo gone, GitHub trouble) shows `The history could not be finished` with `Try again`, which resumes where it stopped.
- `history-shared` on success the timeline opens. The Worker holds the history with a manifest naming the uploader, and a fresh signed-out visitor opens the timeline with no dialog.
- `history-refresh` a signed-in visitor whose shared history was worked out over a day ago, and whose branch has moved since, sees `The timeline of <repo> is out of date` with the date it was worked out. It offers `Refresh history` (`Refresh anyway` on a big repo or a constrained device) and `Use this one`, which opens the old timeline. Signed-out visitors are not asked: checking the branch head costs a GitHub request. Refreshing builds on the stored history (only the commits since it was worked out, so the dialog's estimate is a few head trees, never "big"), uploads, and replaces the stored copy. The debug trace then ends with `refreshed: N new, M kept, K aged out`; a stored history GitHub no longer agrees with (a force-push, a changed snapshot) is computed from scratch instead.
- `history-branch` only the repo's default branch offers compute. A repo opened at another branch (`owner/repo/tree/<branch>`) with nothing stored just toasts that its history is unavailable. The Worker refuses uploads for other branches.
- `history-bad` a stored body that does not unpack (64 MiB cap), parse or agree with its manifest reads as missing, so the offer shows, and the app reports it so the next upload may replace it.
- `history-trace` every run logs a one-line breakdown to the console (`console.info`, `history <repo>: …`) and keeps it in `window.__repoTree.computeTrace`. With the debug flag (`?debug` in the address, or localStorage `repo-tree:debug` = `1`) it also shows in a toast that wraps and stays 30 s.
- `history-token` the token lives in this tab only (sessionStorage) and goes in an `Authorization` header only to GitHub's API and the history Worker.

## How to get to it (user POV)

- Load a repo that is not a sample (type `owner/repo`), then choose `Timeline`.
- Open a link to such a repo with `t=` in its hash, which opens the timeline at once.

## Driving it with drive.mjs

Preconditions:

- `drive launch --history --port <p>` instead of a plain launch. It starts `e2e/history-stack.mjs`, which serves the app built with `VITE_HISTORY_URL` and `VITE_GITHUB_API` on `p`, the real Worker (`server/scripts/local-worker.mjs`, with KV in memory) on `p+1`, and `server/scripts/fake-github.mjs` on `p+2`. The fake serves `acme/widgets` from a three-commit git repo and runs on a slow link (`FAKE_NETWORK=400,30`, meaning 400 ms round trips at 30 KB/ms), so progress stays on screen long enough to capture. The fake's `main` starts one commit behind the repo's newest commit, until `POST /__head {"repo":"acme/widgets","sha":null}` moves it to the newest.
- Ports `p+1` and `p+2` must be free too. The launch fails when the stack exits.
- The Worker's KV is in memory, so each journey run needs a fresh stack: run `cleanup` and `launch --history` again before the next viewport.
- Run `drive history-compute --port <p> --scale 2`, then the same with `--viewport phone-390`.

- **Offer.** Load `acme/widgets` through the stand-in API and choose `Timeline`. Step `offer`. The dialog names `under 1 MB` and the sharing. On a phone it also shows the small-device warning.
- **Decline.** Choose `Not now`. Step `decline`. The dialog and the scrubber are hidden.
- **Big repo.** Load `acme/huge` (the Linux sample's tree) and choose `Timeline`. Step `big-repo`. The dialog warns `This is a big repo.` with `about 50 MB` and offers `Sign in and compute anyway`.
- **Progress.** Choose `Not now`, load `acme/widgets`, choose `Timeline`, then choose `Sign in…`. The popup signs in against the fake and closes. Step `progress`. The bar and `N% ·` show, with `Cancel`.
- **Timeline.** Step `timeline`. The scrubber opens on `36 files`, and the Worker answers `GET /v1/history/acme/widgets?branch=main` with a manifest `by: visitor`. Only the fake and the Worker received an `Authorization` header, and localStorage holds no token.
- **Shared.** A second, signed-out browser context opens `#/acme/widgets` and chooses `Timeline`. Step `shared`. The scrubber opens with no dialog. The screenshot shows the first page, and the step only checks the second.
- **Refresh offer.** The journey moves the fake's head to the newest commit and shifts the page's clock two days on (`addInitScript`), then reopens `#/acme/widgets` signed in and chooses `Timeline`. Step `refresh-offer`. The dialog reads `The timeline of acme/widgets is out of date` with `Refresh history` and `Use this one`.
- **Refreshed.** Choose `Refresh history`. Step `refreshed`. The scrubber opens, the Worker's manifest names the new head, and the trace says `refreshed: 1 new, 2 kept` (`window.__repoTree.computeTrace.refreshed`). The journey sets the debug flag (localStorage `repo-tree:debug` = `1`), so a wrapped toast shows the run's breakdown line: `history acme/widgets: N s, N requests, …`, with each phase's time (the upload's included), requests by kind with bytes and mean/p90 latency, waits, GraphQL batches (none when the git fetch read the trees: `pack 1 req`) and whether it fell back (`fell back: no`).
- `history-failed` has no journey step. `src/timeline/compute-view.test.ts` checks each failure's text, and `src/repo/compute-history.test.ts` checks resuming.

## Gotchas

- The plain `drive launch` build has no `VITE_HISTORY_URL`, so `Timeline` on a non-sample repo only toasts `History unavailable for this repo` (see [timeline](./timeline.md)).
- The progress step needs the slow link. With `FAKE_NETWORK` unset, the small repo finishes before the screenshot.
- `e2e/history-compute.spec.ts` runs the same flow as assertions in the Playwright `history` project, on ports 4176 to 4178.
- Without `ALLOW_LOCALHOST=1` (the stack sets it) the Worker refuses localhost origins with 403 `forbidden`.
- The Worker counts uploads in its Ledger (in memory under Node), at most 2 a minute from one address. A journey that uploads more than twice a minute gets 429 `rate-limited` and the toast says the timeline was not shared.
- The fake records `visitor` as the login for any token it issued, so the manifest's `by` is always `visitor` here.
- Sign in with GitHub sits beside Settings on a desktop and in the More menu on a phone, only in a build with the history server. Signed in, tree loads and Actions runs carry the token (5,000 requests an hour), the button reads Sign out, and Settings shows the same choice with what sign-in lets Repo Tree see (`#signin-privacy`).
