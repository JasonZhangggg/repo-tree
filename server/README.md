# Repo Tree history server

A small Cloudflare Worker that stores each repo's commit history (when each file and folder last changed, how often, when it appeared and was deleted, who works where) and serves it to everyone. It computes nothing. A signed-in visitor's browser computes a missing history with their own GitHub token (`src/core/engine.ts`, run in a Web Worker by the app) and uploads it here. The Worker checks the upload against GitHub and stores it in KV, and every visitor after that reads the stored copy. The app reads from `VITE_HISTORY_URL`. Without that variable the app has no history features beyond the bundled samples, and needs none of this.

## How it works

- **The browser computes.** The engine samples about 50 to 80 first-parent commits, spaced weekly for 26 weeks, monthly back to two years, then yearly back to the root. It reads their trees through GitHub's GraphQL API and the newest 100 commits for exact recent dates and authors. A small repo costs a few dozen requests and well under 1 MB. Linux costs about 85 MB and roughly 500 MB of tab memory, so the app warns first on a big repo or a phone. The result is a `History` (`src/shape.ts`) of 0.05 MB gzipped for vite and 0.86 MB for Linux.
- **Upload.** `PUT /v1/history/{owner}/{repo}?branch=` with `Authorization: Bearer <the visitor's token>`, the gzipped History JSON as the body and an `UploadManifest` in the `X-History-Manifest` header. The manifest names the repo, the branch, the head sha, the byte count and every snapshot as `{sha, at, tree}`. Linux's manifest is 7.8 KB.
- **The Worker never opens the body.** Unpacking and parsing Linux's 8 MB of JSON takes about 60 ms of CPU, six times the free plan's 10 ms. The Worker checks the manifest against GitHub with the uploader's token instead (`src/core/upload.ts`):
  1. `GET /user`: the token is valid. Its login is recorded as `by`.
  2. `GET /repos/{repo}`: the repo exists and is public. Private repos are refused and never stored.
  3. `GET /repos/{repo}/commits/{branch}` (as `application/vnd.github.sha`): the claimed head is the branch's head now. Anything else is `stale`.
  4. `GET /repos/{repo}/git/commits/{sha}` for the head and 3 snapshots picked at random: each exists in the repo, with the claimed tree sha and commit time. Anything else is `mismatch`.

  Then it checks that the body is the declared size and starts with the gzip magic bytes. It stores the body with a `StoredManifest` as KV metadata. The metadata holds the repo, branch, head, snapshot count, a SHA-256 digest of the snapshots' `sha at` lines, the byte count, the uploader and the time.

- **Readers check the binding.** `GET` streams the stored body and the `StoredManifest` (in `X-History-Manifest`) untouched. The app unpacks the body and drops it unless it parses as a History whose repo, branch, head, snapshot count and snapshot digest match the manifest. A stored body therefore always matches what the Worker checked against GitHub.
- **One write per history.** An upload for the head that is already stored answers `409 exists` without writing. A history expires after 90 days, and a branch that moves gets a new upload under the same key.
- **Sign-in.** An OAuth App with no scopes, so the token reads public data only. `/v1/auth/login` redirects to GitHub with a state signed by HMAC-SHA-256 (the app's origin, a 10-minute expiry and a nonce), so sign-in needs no KV. The callback exchanges the code and posts the token to the opener window at that origin only. The app keeps the token in `sessionStorage` for that tab and sends it only to GitHub's API and this Worker. The Worker never stores or logs it.

## What a forged upload can and cannot do

The history is cosmetic data about a public repo, and the checks are sized to the free plan rather than to proof.

- **Caught:** a bad, revoked or missing token; a private repo; a head that is not the branch's current head; a snapshot sha that does not exist in the repo, or whose tree or time is wrong (for the head and 3 random snapshots per upload); an oversized or non-gzip body; a body that does not match its manifest (readers drop it).
- **Not caught:** everything per path. The dates, churn, commit counts, author names, CODEOWNERS teams and even the paths are the uploader's word. A signed-in attacker could make a repo's timeline show made-up paths, dates or offensive author names, up to the moment the branch moves. Snapshots the spot check did not pick could also be wrong, and nothing checks that snapshots are ancestors of the head. A commit reachable only in a fork can pass `git/commits`, since GitHub shares objects across a fork network.
- **How bad:** the timeline of one repo and branch shows wrong data until the branch's next commit. Nothing reaches the tree itself, which comes from GitHub directly, and no visitor's token or data is exposed. A junk upload blocks a correct one for the same head (`exists`). The owner can delete the key (`npx wrangler kv key delete --binding HISTORY 'h1:<owner/repo, lowercase>@<branch>'`), and the `by` login in its metadata names who uploaded it.

## Limits (free plan)

| Route                   | CPU (measured)           | Subrequests | KV              |
| ----------------------- | ------------------------ | ----------- | --------------- |
| `GET /v1/history/...`   | 0.75 ms Linux, 0.15 vite | 0           | 1 read          |
| `PUT /v1/history/...`   | 1.85 ms Linux, 0.88 vite | 7 GitHub    | 1 read, 1 write |
| `GET /v1/auth/login`    | under 1 ms (one HMAC)    | 0           | none            |
| `GET /v1/auth/callback` | under 1 ms               | 1 GitHub    | none            |

`node scripts/worker-cpu.mjs` measures the CPU numbers in Node against the fake. Workers run the same V8, so treat them as estimates.

- **Requests.** Each IP gets 60 requests a minute (the `LIMITER` binding).
- **Uploads.** Each IP gets 2 uploads a minute (`UPLOAD_LIMITER`) and 6 an hour (`UPLOADS_PER_IP_HOUR`). The Worker as a whole takes 300 a day (`UPLOADS_PER_DAY`). That leaves room in the account's 1,000 KV writes a day, which the owner's other project shares. The hourly and daily counters live in each data center's Cache API, so they cost no KV writes but are approximate. An upload over the limit answers `429` with `Retry-After`.
- **Size.** Bodies over 8 MiB are refused (`413`). That is ten times Linux's. KV values may be up to 25 MiB.
- **CORS.** `ALLOWED_ORIGINS` plus any localhost port. Other origins get `403`.

## Endpoints

| Route                                    | Answers                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/history/{owner}/{repo}?branch=` | `200` with the gzipped History and `X-History-Manifest`, or `404 {status: 'missing'}`.                                                                                                                                     |
| `PUT /v1/history/{owner}/{repo}?branch=` | `201 {status: 'stored', manifest}`, or an error: `400 invalid`, `401 unauthorized`, `403 private`/`forbidden`, `404 not-found`, `409 exists`/`stale`, `413 too-large`, `422 mismatch`, `429 rate-limited`, `502 upstream`. |
| `GET /v1/auth/login?origin=`             | Starts sign-in in a popup opened by the app at `origin`.                                                                                                                                                                   |
| `GET /v1/auth/callback`                  | GitHub returns here. The page posts the token to the opener and closes.                                                                                                                                                    |
| `GET /health`                            | `ok`.                                                                                                                                                                                                                      |

Errors are JSON, `{status: 'error', error, retryAfter?}`.

## Setup (owner)

The Worker is deployed at `https://repo-tree-history.jasonxyz.workers.dev`, and the KV namespace id is already in `wrangler.toml`. What remains is in `server/`.

1. **GitHub OAuth App.** On GitHub go to Settings, Developer settings, OAuth Apps, New OAuth App.
   - Application name: Repo Tree.
   - Homepage URL: `https://jasonzhangggg.github.io/repo-tree/`.
   - Authorization callback URL: `https://repo-tree-history.jasonxyz.workers.dev/v1/auth/callback`.
   - Leave device flow off.

   After you create it, copy the Client ID and generate a client secret.

2. **Worker secrets.** Run `npx wrangler secret put GITHUB_CLIENT_ID`, then `npx wrangler secret put GITHUB_CLIENT_SECRET`, and paste each value when asked. Until both exist, sign-in answers `503` and only stored histories are served. The Worker needs no GitHub token of its own. If an older setup set `GITHUB_TOKEN`, remove it with `npx wrangler secret delete GITHUB_TOKEN`.
3. **Deploys.** `.github/workflows/deploy-server.yml` deploys every push to `main` that touches `server/`, using the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **Point the app at it.** Set the Actions variable `VITE_HISTORY_URL` to `https://repo-tree-history.jasonxyz.workers.dev` (Settings, Secrets and variables, Actions, Variables). The Pages build reads it. Until it is set, the app builds with history off.

Everything fits the free Workers plan. There is no cron and nothing runs between requests.

## Local development

No GitHub access is needed. `scripts/fake-github.mjs` answers the REST, GraphQL and OAuth paths that the engine and the Worker use, from local git repositories. `scripts/local-worker.mjs` runs `src/worker.ts` in Node (22.18 or later) with KV in memory:

```sh
git clone --bare --filter=blob:none https://github.com/vitejs/vite.git /tmp/vite.git
node scripts/fake-github.mjs 8791 vitejs/vite=/tmp/vite.git &
FAKE_URL=http://localhost:8791 node scripts/local-worker.mjs 8790 &
# then build the app against both, from the repo root:
VITE_HISTORY_URL=http://localhost:8790 VITE_GITHUB_API=http://localhost:8791 npx vite build
```

`wrangler dev --var GITHUB_API:http://127.0.0.1:8791 --var GITHUB_WEB:http://127.0.0.1:8791 --var GITHUB_CLIENT_ID:local --var GITHUB_CLIENT_SECRET:local` runs the real Workers runtime in place of `local-worker.mjs`. `FAKE_NETWORK=<rtt ms>,<bytes per ms>` slows the fake down to watch progress. From the repo root, `node e2e/history-stack.mjs <app> <worker> <fake>` starts all three with a small test repo, `acme/widgets`. The Playwright `history` project and the `verify-repo-tree` skill's `history-compute` journey use it.

`npm run check` typechecks and runs the tests. They build small git repos and drive the engine, the upload checks and the Worker's routes through the same fake. `node scripts/save-history.mjs <api url> <owner/repo> <branch> <out.history.json.gz> [token]` runs the engine in Node and writes a history file like the bundled samples in `public/samples/`.
