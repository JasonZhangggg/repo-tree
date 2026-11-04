# Repo Tree history server

A Cloudflare Worker that computes a repo's commit history (when each file and folder last changed, how often, when it appeared and was deleted, who works where) and caches it in KV. The app reads it from `VITE_HISTORY_URL`. Without that variable the app has no history features and needs none of this.

## How it works

- **Snapshots, not commits.** For each repo and branch head the server finds about 50 to 80 commits spaced weekly for 26 weeks, every 30 days back to two years, then yearly back to the first commit (`/commits?until=`). It reads each one's recursive tree and compares blob and tree shas between neighbours. That gives last-changed, churn, first-seen and deleted dates to within one interval for every path. The newest 100 non-merge commits are then read one by one (`/commits/{sha}`) for exact recent dates, commit counts and authors. CODEOWNERS is read when the head has one.
- **Cost.** About 120 GitHub requests for a small repo and 180 for one like vite, almost all of them the 100 recent commits. It stays roughly flat with history length. A tree over GitHub's 100k-entry limit (Linux) is re-read one top-level folder at a time, skipping folders whose sha did not change, under a cap (`SPLIT_REQUESTS`). Past the cap, snapshots are skipped and the result lists the gap.
- **Steps.** One request advances the job by at most `STEP_REQUESTS` GitHub requests and `STEP_ENTRIES` tree entries, saves progress in KV and answers `202 {status: 'pending', progress, retryAfter}`. The app polls until `200 {status: 'ready'}`.
- **Who pays.** Visitors sign in with GitHub (an OAuth App with no scopes, so public data only). An uncached repo is computed with the visitor's own token, sent as `Authorization: Bearer`, for that request only. It is never stored or logged. The result comes from public data, so it goes in the shared KV cache and anyone can read it, signed in or not. A signed-out visitor asking for an uncached repo gets `401 {status: 'needs-auth'}`. Private repos are refused and never cached. If a token runs out of GitHub requests, the job waits for the reset (`pending` with `retryAfter`) and then resumes.
- **Freshness.** A history is stored per head commit for 30 days. A branch head is trusted for six hours. After that, a signed-in request gets the stored history at once (`stale: true` while a newer head computes) and the update runs in the background.
- **Limits.** Each IP gets 60 requests a minute (the `[[ratelimits]]` binding) and may start 10 new repos an hour (`NEW_REPOS_PER_HOUR`). Cached repos don't count. CORS allows `ALLOWED_ORIGINS` plus any localhost port.
- **Prewarm.** If `GITHUB_TOKEN` is set, a cron runs one job step every ten minutes for one repo in `PREWARM` (`src/worker.ts`), taking turns. That is the only use of the server's own token.
- **Plan limits.** The free Workers plan allows 50 subrequests and 10 ms CPU per request. That handles small and medium repos with the default `STEP_REQUESTS = 40`. A Linux-sized tree takes over a second of CPU to parse, so large repos need the paid plan (30 s CPU, 1,000 subrequests). The free plan also caps KV at 1,000 writes a day, and every job step is one write.

The core (`src/core/`) uses only `fetch` and a small `Store` interface, so a Vercel or Netlify adapter would be another file like `src/worker.ts`.

## Endpoints

| Route                                    | What it does                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /v1/history/{owner}/{repo}?branch=` | The history, or `pending`, `needs-auth` or an error. Omit `branch` for the default branch. |
| `GET /v1/auth/login?origin=`             | Starts sign-in in a popup opened by the app at `origin`.                                   |
| `GET /v1/auth/callback`                  | GitHub returns here. The page posts the token to the opener and closes.                    |
| `GET /health`                            | `ok`.                                                                                      |

## Setup (owner)

Do these once, in order. Run the commands in `server/`.

1. **Cloudflare account.** Sign up at https://dash.cloudflare.com/sign-up (the free plan is enough to start). Then run `npm ci` and `npx wrangler login`.
2. **KV namespace.** Run `npx wrangler kv namespace create HISTORY`. Paste the `id` it prints into `wrangler.toml` in place of the zeros, for both `id` and `preview_id`. Commit that change. The id is not a secret.
3. **First deploy.** Run `npx wrangler deploy`. It prints the Worker URL, for example `https://repo-tree-history.<your-subdomain>.workers.dev`. Call it `WORKER_URL` below.
4. **GitHub OAuth App.** On GitHub go to Settings, Developer settings, OAuth Apps, New OAuth App.
   - Application name: Repo Tree.
   - Homepage URL: `https://jasonzhangggg.github.io/repo-tree/`.
   - Authorization callback URL: `WORKER_URL/v1/auth/callback`.
   - Leave device flow off.

   After you create it, copy the Client ID and generate a client secret.

5. **Worker secrets.** Run `npx wrangler secret put GITHUB_CLIENT_ID`, then `npx wrangler secret put GITHUB_CLIENT_SECRET`, and paste each value when asked. The client id is public, but keeping it as a secret keeps both values in one place.
6. **Optional prewarm token.** To keep the `PREWARM` repos warm, create a fine-grained personal access token with public repository read access only. Run `npx wrangler secret put GITHUB_TOKEN` and paste it. Skip this step and the cron does nothing.
7. **Deploys from GitHub.** Create a Cloudflare API token with the "Edit Cloudflare Workers" template (My Profile, API Tokens). In the GitHub repo, under Settings, Secrets and variables, Actions, add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The account id is on the Workers overview page. From then on, `.github/workflows/deploy-server.yml` deploys every push to `main` that touches `server/`. Until both secrets exist, the workflow skips with a notice instead of failing.
8. **Point the app at it.** In the GitHub repo, add the Actions variable `VITE_HISTORY_URL` with the value `WORKER_URL` (Settings, Secrets and variables, Actions, Variables). The Pages build in `.github/workflows/deploy.yml` already reads it:

   ```yaml
   - run: npm run build
     env:
       VITE_HISTORY_URL: ${{ vars.VITE_HISTORY_URL }}
   ```

   Until the variable is set, the app builds with history off.

## Local development

`wrangler dev` with no GitHub access runs against `scripts/fake-github.mjs`, which answers the API paths the job uses from local git clones and plays GitHub's OAuth endpoints:

```sh
git clone --bare --filter=blob:none https://github.com/vitejs/vite.git /tmp/vite.git
node scripts/fake-github.mjs 8788 vitejs/vite=/tmp/vite.git &
npx wrangler dev --var GITHUB_API:http://127.0.0.1:8788 --var GITHUB_WEB:http://127.0.0.1:8788 \
  --var GITHUB_CLIENT_ID:local --var GITHUB_CLIENT_SECRET:local
curl -H 'Authorization: Bearer gho_fakefakefakefakefake' http://127.0.0.1:8787/v1/history/vitejs/vite
```

`npm run check` typechecks and runs the tests, which build small git repos and drive the core and the Worker through the same fake. `node scripts/save-history.mjs <worker url> <owner/repo> <out.history.json.gz> <token>` writes a history file like the bundled samples in `public/samples/`.
