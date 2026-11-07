# Repo Tree history server

A small Cloudflare Worker that stores each repo's commit history (when each file and folder last changed, how often, when it appeared and was deleted, who works where) and serves it to everyone. It computes nothing. A signed-in visitor's browser computes a missing history with their own GitHub token (`src/core/engine.ts`, run in a Web Worker by the app) and uploads it here. The Worker checks the upload against GitHub and stores it in KV, and every visitor after that reads the stored copy. One global Durable Object, the ledger, counts every write first. The app reads from `VITE_HISTORY_URL`. Without that variable the app has no history features beyond the bundled samples, and needs none of this.

## How it works

- **The browser computes.** The engine samples up to 80 first-parent commits, spaced weekly for 26 weeks, monthly back to two years, then yearly back to the root, picked with REST commit listings (up to 12 at once, looking up to 24 targets ahead). It then reads every snapshot's trees in **one git fetch** through this Worker (`POST /v1/git/{owner}/{repo}/git-upload-pack`, below): the snapshot commits at depth 1 without blobs, each distinct tree once, as a packfile, which the browser unpacks itself (`src/core/pack.ts`, with a small inflater and SHA-1 of its own, 6 KB gzipped). The same fetch brings the newest 100 commits and their parents, so their changes are diffs of their trees at no extra cost. If the fetch fails or is cut short, GraphQL (up to 400 trees a query) and then REST read only what it left unread. Modelled on GitHub's latency (`scripts/measure.mjs --latency github --pack`, 40 Mbit/s and 60 ms):

  | Repo     | Requests | Downloaded | Time   | Before (GraphQL)  |
  | -------- | -------- | ---------- | ------ | ----------------- |
  | vite     | 36       | 1.8 MB     | 5.3 s  | 88, 2.1 MB, 19 s  |
  | supabase | 55       | 8.7 MB     | 7.4 s  | 148, 14 MB, 40 s  |
  | Linux    | 102      | 54 MB      | 23.3 s | 400, 87 MB, 140 s |

  The fetch itself is 1.0, 5.7 and 50 MB; GitHub takes about 0.1 s per MB to make the pack before it sends it (Linux: 5 s), and the rest is the link. Checking the wants first (one GraphQL query, below) adds about 0.3 to 1 s in this model, which charges it like a tree read. Linux peaks at about 450 MB of tab memory in Chromium (it was 500 MB), so the app still warns first on a big repo or a phone. Each run logs where its time went to the console (`history <repo>: …`), and with `?debug` in the address it also shows in a toast. The result is a `History` (`src/shape.ts`) of 0.05 MB gzipped for vite and 0.86 MB for Linux.

- **One history per repo.** Only the repo's default branch is stored. The app offers to compute only for a repo opened at its default branch. An upload for another branch is refused (`not-default-branch`), so branches cannot multiply the writes.
- **Upload.** `PUT /v1/history/{owner}/{repo}?branch=` carries:
  - `Authorization: Bearer <the visitor's token>`;
  - the gzipped History JSON as the body, at most 2 MiB;
  - an `UploadManifest` in the `X-History-Manifest` header: the repo, the branch, the head sha, the byte count, and every snapshot as `{sha, at, tree}`, oldest first. Linux's manifest is 7.8 KB.
- **The Worker never unpacks the body.** Unpacking and parsing Linux's 8 MB of JSON takes about 60 to 70 ms of CPU, six times the free plan's 10 ms. Instead the Worker checks the manifest (`src/core/upload.ts`):
  1. **Shape.** The snapshots must look like the engine's picks, with no request needed. They are in time order with the head last, there are at most 80, and walking the schedule's target times from the newest, each snapshot below the head is the pick of a later target than the one before it, at or before that target. A claim of many snapshots in the last week is refused (`invalid`).
  2. **Token.** `GET /user` checks the token. Its login is recorded as `by`.
  3. **Repo.** `GET /repos/{repo}` checks the repo is public and the branch is its default branch.
  4. **Head.** `GET /repos/{repo}/commits/{branch}` (as `application/vnd.github.sha`) checks the claimed head is the branch's head now. Anything else is `stale`.
  5. **Commits.** `GET /repos/{repo}/git/commits/{sha}` runs for the head, for the oldest snapshot, and for 3 other snapshots picked at random. Each must exist in the repo with the claimed tree and commit time, and the oldest must be a root commit with no parents. Anything else is `mismatch`.

  Then the Worker checks that the body is the declared size, starts with the gzip magic bytes, and declares in its last four bytes (gzip's ISIZE) at most 64 MiB unpacked. A gzip bomb that tells the truth is refused (`too-large`) without unpacking a byte.

- **The ledger decides, then one KV write.** The `Ledger` Durable Object (`src/core/ledger.ts`, SQLite-backed, one global instance) runs each check-and-count alone. The Worker asks it twice:
  - **Before GitHub:** is this head already stored and good under this key (`exists`), or is today's global cap taken (`rate-limited`)?
  - **After GitHub's checks:** may this login write once more today (20 a day), may the Worker (200 a day in all), and does the body fit the stored-bytes budget (500 MB)? Past the budget, the ledger evicts the oldest histories first-in first-out, any reported bad before the rest, at most 20 for one upload, and the Worker deletes them from KV before its put. Each delete is a KV write, so the day's budget of 400 KV writes (`KV_WRITES_PER_DAY`) counts the put and its deletes together. A body that 20 evictions cannot make room for is refused as `full`. Views are not tracked (no LRU), because that would cost a ledger request on every read.

  Only then does the Worker write the body to KV with a `StoredManifest` as metadata: the repo, branch, head, snapshot count, a SHA-256 digest of the snapshots' `sha at` lines, the byte count, the uploader and the time.

  KV's own view of what exists is only eventually consistent, so the ledger is the source of truth. Two uploads of one head at once write once.

- **Readers check the binding.** `GET` streams the stored body and its `StoredManifest` (in `X-History-Manifest`) untouched, for one KV read. The app unpacks the body, stopping past 64 MiB. It uses the body only if it parses as a History whose repo, branch, head, snapshot count and snapshot digest match the manifest. Otherwise the app treats the history as missing and offers the compute. It also tells the Worker (`POST .../bad?head=`).
- **Replacing a stored history.** A good upload replaces the stored one when:
  - the branch has moved to a newer head;
  - a reader reported the stored body bad;
  - the stored one is over a day old.

  A bad first upload therefore blocks a head for a day at most, and only until someone opens it. Every replacement counts against the same caps.

- **Out-of-date histories.** A signed-in visitor who opens a stored history over a day old gets an offer to bring it up to date when GitHub names a newer head. The app makes one request for that. The recompute reuses whatever that tab has already read for the repo. A history expires after 90 days.
- **The git route.** `POST /v1/git/{owner}/{repo}/git-upload-pack` takes a git protocol v2 fetch request and forwards it to `https://github.com/{owner}/{repo}.git/git-upload-pack` with the visitor's token (as `x-access-token` basic auth, so GitHub's git limits count against the visitor) and `Git-Protocol: version=2`. It then streams GitHub's answer back without reading it, so its CPU is the checks alone, under 1 ms. It refuses a request with no `Origin` (`403 forbidden`), as a page always sends one. Before asking GitHub it refuses (`400 invalid`) any request that is not exactly a fetch with `filter blob:none`, `deepen 1` and `done`, 1 to 256 `want <sha>` lines, and nothing else but `no-progress` and `ofs-delta`: no `have`, no other filter, no `include-tag`, `want-ref`, `thin-pack` or packfile URIs, at most 64 KiB, printable ASCII. That form is not enough on its own: GitHub sends any object wanted by name, whatever the filter or depth, so a blob's sha would bring the file back whole. So one GraphQL query (`repository { isPrivate w0: object(oid:) { __typename } … }`, an alias per want) checks that the repo is public and that every want is a `Commit`, beside `GET /user` for the token, and anything else is `400 invalid`. It serves trees and commits of public repos, never file contents, in 3 subrequests. It rate-limits per IP before GitHub and per login after (`PACK_LIMITER`, 6 a minute each; a run makes one). An IPv6 client is counted by its /64, as one subscriber may hold all of it.
- **No byte cap on the answer, by default.** The browser stops reading past 200 MiB and falls back (`MAX_PACK_BYTES`); Linux's is 50 MB. The Worker can cut the answer off too (`PACK_MAX_BYTES`), but counting it runs JavaScript for every chunk, where an untouched body is piped by the runtime and costs the Worker nothing. In workerd a fetch body arrives in chunks of about 4 KB, 13,000 for Linux's pack, and passing it through a counting stream took about 450 ms more CPU than piping it (`node scripts/stream-cpu.mjs`, Miniflare), against the free plan's 10 ms. So it is off, and the answer is bounded by what it can hold: the trees of at most 256 commits of one public repo, no blobs.
- **Sign-in.** An OAuth App with no scopes, so the token reads public data only. `/v1/auth/login` redirects to GitHub with a state signed by HMAC-SHA-256 (the app's origin, a 10-minute expiry and a nonce), so sign-in needs no storage. The callback exchanges the code and posts the token to the opener window at that origin only. Its page refuses to be framed. The app keeps the token in `localStorage` for that browser until the visitor signs out and sends it only to GitHub's API and this Worker. The Worker never stores or logs it. An upload refused as `unauthorized` signs the visitor out, as a refused compute does.

## What a forged upload can and cannot do

The history is cosmetic data about a public repo, and the checks are sized to the free plan rather than to proof.

- **Caught:**
  - a bad, revoked or missing token;
  - a private repo, or a branch other than the default;
  - a head that is not the branch's current head;
  - an oldest snapshot that is not a root commit;
  - snapshots out of order, or denser than the schedule;
  - a snapshot that does not exist in the repo, or whose tree or time is wrong (for the head, the root and 3 random others per upload);
  - an oversized body, a non-gzip body, or a gzip bomb that declares its size;
  - a body that does not match its manifest, or that unpacks past 64 MiB whatever it declares (readers drop it, report it, and offer the compute).
- **Not caught:**
  - **Per-path data.** The dates, churn, commit counts, author names, CODEOWNERS teams and even the paths are the uploader's word. A signed-in attacker could make a repo's timeline show made-up paths, dates or offensive author names, up to the moment the branch moves, someone reports it, or a day passes.
  - **No floor on snapshots.** A repo with three commits has three snapshots whatever its age, and telling that from a sparse claim would take listing the commits. So a real root plus a real head passes as a thin history.
  - **Ancestry and forks.** The snapshots that are not spot-checked could be wrong, and nothing checks that snapshots are ancestors of the head. A commit reachable only in a fork can pass `git/commits`, since GitHub shares objects across a fork network.
  - **Anonymous reports.** Anyone can report a stored body bad. That only lets the next good upload replace it, within the caps.
- **How bad:**
  - **Scope.** One repo's timeline shows wrong data for a while. Nothing reaches the tree itself, which comes from GitHub directly, and no visitor's token or data is exposed.
  - **Quota.** The worst case is bounded by the ledger: 20 writes a day per GitHub account, 200 a day in all, 400 KV writes and deletes a day (of the account's 1,000), 500 MB stored (of KV's 1 GB), and 2 MiB per body. Uploading many histories rotates older ones out, so it costs other repos their shared history (they can compute it again) but never the quota.
  - **Many accounts.** An attacker with many GitHub accounts can use up the day's 200 writes. That stops sharing for everyone until midnight UTC, but computing in the browser still works.
  - **Clean-up.** The owner can delete a key with `npx wrangler kv key delete --binding HISTORY 'h1:<owner/repo, lowercase>@<branch>'`. The `by` login in its metadata names the uploader.

## Limits (free plan)

| Route                                | Worker CPU (measured)    | Subrequests         | KV                                          | Ledger (DO)         |
| ------------------------------------ | ------------------------ | ------------------- | ------------------------------------------- | ------------------- |
| `GET /v1/history/...`                | 0.70 ms Linux, 0.20 vite | 0                   | 1 read                                      | none                |
| `PUT /v1/history/...`                | 2.4 ms Linux, 1.5 vite   | 8 GitHub + 2 ledger | 1 write, 0 read, up to 20 deletes when full | 2 requests, ~0.3 ms |
| `PUT` refused as `exists` or day cap | under 1 ms               | 1 ledger            | none                                        | 1 request           |
| `POST /v1/history/.../bad?head=`     | under 1 ms               | 1 ledger            | none                                        | 1 request           |
| `POST /v1/git/.../git-upload-pack`   | 0.7 ms, any pack size    | 2 GitHub + 1 git    | none                                        | none                |
| `GET /v1/auth/login`                 | under 1 ms (one HMAC)    | 0                   | none                                        | none                |
| `GET /v1/auth/callback`              | under 1 ms               | 1 GitHub            | none                                        | none                |

`node scripts/worker-cpu.mjs <history.json>` measures the Worker's CPU in Node with GitHub and the ledger answered from memory. It measures one ledger call separately, on node:sqlite. Workers run the same V8, so treat the numbers as estimates. The Durable Object's CPU is its own, not the Worker's.

The free plan allows 100,000 Durable Object requests a day and 5 GB of SQLite storage. The ledger keeps one small row per stored history and per uploader per day.

- **Requests.** Each IP gets 60 requests a minute (the `LIMITER` binding). IPv6 clients are counted by /64 here and for uploads too.
- **Pack fetches.** Each IP (an IPv6 /64) and each GitHub login gets 6 a minute (`PACK_LIMITER`).
- **Uploads.** Each IP gets 2 uploads a minute (`UPLOAD_LIMITER`). Each GitHub login gets 20 stored uploads a day (`UPLOADS_PER_LOGIN`) and the Worker 200 in all (`UPLOADS_PER_DAY`), counted in the ledger, so the caps are global and exact. An upload over a limit answers `429` with `Retry-After`. For the daily caps that is the seconds to midnight UTC.
- **Storage.** All stored bodies together stay under 500 MB (`STORED_BYTES`). Past it the oldest are evicted, at most 20 an upload, and `507 full` only when that is not enough. A body is at most 2 MiB (`413`), over twice Linux's, and unpacks to at most 64 MiB.
- **CORS.** `ALLOWED_ORIGINS` only. Localhost origins are allowed only when `ALLOW_LOCALHOST` is `1`, which `scripts/local-worker.mjs` and `wrangler dev --var ALLOW_LOCALHOST:1` set and `wrangler.toml` does not. Other origins get `403`.

**Proxying packs, and Cloudflare's terms.** The git route sends large binary bodies through the Worker: 1 MB for vite, 6 MB for supabase, 50 MB for Linux, one per computed history. What applies, as of the Service-Specific Terms last updated 28 September 2026:

- The CDN section restricts the **CDN** (caching and serving websites), not Workers: on a non-Enterprise plan, Cloudflare may limit an account that uses the CDN "without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files". It names the Developer Platform, of which Workers are part, as one of those services. The Developer Platform section says nothing about the size or type of what a Worker returns, and the free plan has no response size limit. Since May 2023 (the end of the old self-serve section 2.8) there is no rule against non-HTML content as such.
- The pack is not cached or served from the CDN's cache: each response is made by the Worker for one signed-in visitor (`Cache-Control: no-store`), the way an API answers. The Worker does not pass through video or media, only git objects of public repos, and never blobs.
- The terms do not say in so many words whether a free Workers plan counts as a "Paid Service" or where "disproportionate" starts. The traffic is small (one fetch per computed history, at most 200 histories stored a day), but a site whose Workers traffic were mostly multi-megabyte proxied downloads could draw Cloudflare's attention under that clause. If it ever does, the app keeps working: a refused or failed fetch falls back to GraphQL in the browser, at the old cost. Removing the route only makes runs slower.
- Workers' limits that do apply: 10 ms CPU a request (the route uses 0.4 ms; streaming a body it does not read costs none), 50 subrequests (it makes 3), and 100,000 requests a day.

**Its own account, ideally.** The free plan's quotas apply per Cloudflare account, not per Worker: requests, KV reads and writes, KV storage and Durable Object requests. A Worker on an account shared with another project shares those quotas, and either project can use them up for the other. The caps above keep this Worker within about a fifth of the KV writes and half the KV storage. Running it on an account of its own removes the overlap. The setup steps below work either way.

## Endpoints

| Route                                               | Answers                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/history/{owner}/{repo}?branch=`            | `200` with the gzipped History and `X-History-Manifest`, or `404 {status: 'missing'}`.                                                                                                                                                                                          |
| `PUT /v1/history/{owner}/{repo}?branch=`            | `201 {status: 'stored', manifest}`, or an error: `400 invalid`, `401 unauthorized`, `403 private`/`forbidden`, `404 not-found`, `409 exists`/`stale`, `413 too-large`, `422 mismatch`/`not-default-branch`, `429 rate-limited`, `502 upstream`, `507 full`.                     |
| `POST /v1/history/{owner}/{repo}/bad?branch=&head=` | `202 {status: 'noted'}`: the body stored for that head may be replaced by the next good upload.                                                                                                                                                                                 |
| `POST /v1/git/{owner}/{repo}/git-upload-pack`       | `200` with github.com's `application/x-git-upload-pack-result` stream, or an error: `400 invalid` (not a tree-only fetch, or a want that is not a commit), `401 unauthorized`, `403 private`/`forbidden`, `404 not-found`, `413 too-large`, `429 rate-limited`, `502 upstream`. |
| `GET /v1/auth/login?origin=`                        | Starts sign-in in a popup opened by the app at `origin`.                                                                                                                                                                                                                        |
| `GET /v1/auth/callback`                             | GitHub returns here. The page posts the token to the opener and closes.                                                                                                                                                                                                         |
| `GET /health`                                       | `ok`.                                                                                                                                                                                                                                                                           |

Errors are JSON, `{status: 'error', error, retryAfter?}`.

## Setup (owner)

The Worker is deployed at `https://repo-tree-history.jasonxyz.workers.dev`, and `wrangler.toml` already names a KV namespace. Run the commands below in `server/`, signed in to the Cloudflare account the Worker should live on (see "Its own account, ideally").

1. **KV namespace (only on a new account).** The id in `wrangler.toml` belongs to the account the Worker is on now. On another account, run `npx wrangler kv namespace create HISTORY` and put the id it prints in `wrangler.toml` as both `id` and `preview_id`.
2. **The ledger.** Nothing to create. `wrangler.toml` binds the `Ledger` Durable Object class and declares it in a `[[migrations]]` entry as `new_sqlite_classes`, the kind the free plan runs. The first deploy creates it, and later deploys leave it alone.
3. **GitHub OAuth App.** On GitHub go to Settings, Developer settings, OAuth Apps, New OAuth App.
   - Application name: Repo Tree.
   - Homepage URL: `https://jasonzhangggg.github.io/repo-tree/`.
   - Authorization callback URL: `<the Worker's URL>/v1/auth/callback`, for example `https://repo-tree-history.jasonxyz.workers.dev/v1/auth/callback`.
   - Leave device flow off.

   After you create it, copy the Client ID and generate a client secret.

4. **Worker secrets.** Run `npx wrangler secret put GITHUB_CLIENT_ID`, then `npx wrangler secret put GITHUB_CLIENT_SECRET`, and paste each value when asked. Until both exist, sign-in answers `503` and only stored histories are served. The Worker needs no GitHub token of its own. If an older setup set `GITHUB_TOKEN`, remove it with `npx wrangler secret delete GITHUB_TOKEN`.
5. **Deploys.** `.github/workflows/deploy-server.yml` deploys every push to `main` that touches `server/`. It uses the repository secrets `CLOUDFLARE_API_TOKEN` (from the "Edit Cloudflare Workers" template, which covers Durable Objects) and `CLOUDFLARE_ACCOUNT_ID`, both for the account the Worker lives on.
6. **Point the app at it.** Set the Actions variable `VITE_HISTORY_URL` to the Worker's URL (Settings, Secrets and variables, Actions, Variables). The Pages build reads it. Until it is set, the app builds with history off.

Everything fits the free Workers plan. There is no cron and nothing runs between requests.

## Local development

No GitHub access is needed. `scripts/fake-github.mjs` answers the REST, GraphQL, git fetch and OAuth paths that the engine and the Worker use, from local git repositories (the git fetch with `git upload-pack --stateless-rpc`; `FAKE_GIT_CACHE=<dir>` keeps the packs it makes, as Linux's takes git 17 s). It also plays GitHub's GraphQL failures:

- a spent budget (200 with `RATE_LIMITED`);
- secondary limits (403, or 200 with the message);
- timeouts (200 with an error, 502 or 504);
- partial replies.

`scripts/local-worker.mjs` runs `src/worker.ts` in Node (22.18 or later) with KV in memory and the ledger on node:sqlite (`scripts/ledger-sqlite.mjs`), localhost allowed:

```sh
git clone --bare --filter=blob:none https://github.com/vitejs/vite.git /tmp/vite.git
node scripts/fake-github.mjs 8791 vitejs/vite=/tmp/vite.git &
FAKE_URL=http://localhost:8791 node scripts/local-worker.mjs 8790 &
# then build the app against both, from the repo root:
VITE_HISTORY_URL=http://localhost:8790 VITE_GITHUB_API=http://localhost:8791 npx vite build
```

To use the real Workers runtime, with the Durable Object on its local SQLite, run `wrangler dev` in place of `local-worker.mjs`:

```sh
npx wrangler dev --var ALLOW_LOCALHOST:1 --var GITHUB_API:http://127.0.0.1:8791 --var GITHUB_WEB:http://127.0.0.1:8791 --var GITHUB_CLIENT_ID:local --var GITHUB_CLIENT_SECRET:local
```

Other helpers:

- `FAKE_NETWORK=<rtt ms>,<bytes per ms>` slows the fake down, to watch progress. `FAKE_LATENCY=github` adds GitHub's own time to answer (REST 150 to 400 ms, GraphQL about 0.8 s for 100 small trees to 3 s for 100k entries, a git fetch 300 ms plus about 0.1 s per MB of pack, measured against github.com), and `node scripts/measure.mjs --latency github [--pack] <repo>` measures a run under it, phase by phase (`--pack` puts this Worker's git route in front of the fake). `POST /__head {repo, sha}` moves a branch head, as a push would.
- From the repo root, `node e2e/history-stack.mjs <app> <worker> <fake>` starts all three with a small test repo, `acme/widgets`. The Playwright `history` project and the `verify-repo-tree` skill's `history-compute` journey use it.

`npm run check` typechecks and runs the tests. They build small git repos and drive the engine, the upload checks, the ledger and the Worker's routes through the same fake. `node scripts/save-history.mjs <api url> <owner/repo> <branch> <out.history.json.gz> [token]` runs the engine in Node and writes a history file like the bundled samples in `public/samples/`.
