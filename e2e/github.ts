import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Page } from '@playwright/test';

type Fixture = { repo: { default_branch: string }; tree: unknown };

/** A GitHub API stand-in that serves a bundled sample's tree as `owner/repo`. */
export async function serveRepo(page: Page, name: string, sample = 'mathiasbynens-dotfiles') {
  const fixture = JSON.parse(
    gunzipSync(readFileSync(`public/samples/${sample}.json.gz`)).toString(),
  ) as Fixture;
  const branch = fixture.repo.default_branch;
  await page.route(`https://api.github.com/repos/${name}`, (route) =>
    route.fulfill({ json: { ...fixture.repo, full_name: name } }),
  );
  await page.route(
    `https://api.github.com/repos/${name}/git/trees/${branch}?recursive=1`,
    (route) => route.fulfill({ json: fixture.tree }),
  );
}

/** Answers every API call with an error, exposing headers to the page the way GitHub does. */
export async function failRepo(page: Page, status: number, headers: Record<string, string> = {}) {
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      status,
      headers: {
        ...headers,
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'X-RateLimit-Remaining, X-RateLimit-Reset',
      },
      json: { message: 'nope' },
    }),
  );
}

/** Starts every page with fast, still settings unless the test already stored its own. */
export async function quietSettings(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('repo-tree:settings')) {
      localStorage.setItem('repo-tree:settings', JSON.stringify({ quality: 'low', spin: false }));
    }
  });
  await page.route('https://api.github.com/**', (route) => route.abort('internetdisconnected'));
}

/**
 * Answers every Actions runs request with a sample's bundled runs, so a spec that opens samples
 * knows its sky (a sample reads its live CI first) and logs no failed request.
 */
export async function serveSampleRuns(page: Page) {
  const SAMPLE_RUNS: Record<string, string> = {
    'mathiasbynens/dotfiles': 'mathiasbynens-dotfiles',
    'vitejs/vite': 'vitejs-vite',
    'torvalds/linux': 'torvalds-linux',
  };
  await page.route(
    (url) => url.host === 'api.github.com' && url.pathname.endsWith('/actions/runs'),
    (route) => {
      const [, , owner, repo] = new URL(route.request().url()).pathname.split('/');
      const id = SAMPLE_RUNS[`${owner}/${repo}`.toLowerCase()];
      return id
        ? route.fulfill({
            headers: { 'access-control-allow-origin': '*' },
            body: readFileSync(`public/samples/${id}.runs.json`),
            contentType: 'application/json',
          })
        : route.abort('internetdisconnected');
    },
  );
}

export const ready = (page: Page, repo: string) =>
  page.waitForSelector(`body[data-ready="${repo}"]`, { state: 'attached', timeout: 60_000 });

/**
 * Answers `owner/repo`'s Actions runs on `branch` with finished runs, newest first, from a
 * pattern: `.` passed, `x` failed. A status other than 200 answers with that error instead.
 */
export async function serveRuns(
  page: Page,
  name: string,
  pattern: string,
  { branch = 'main', status = 200, headers = {} as Record<string, string> } = {},
) {
  const now = Date.now();
  await page.route(
    (url) => url.href.startsWith(`https://api.github.com/repos/${name}/actions/runs?`),
    (route) =>
      route.fulfill({
        status,
        headers: {
          ...headers,
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'X-RateLimit-Remaining, X-RateLimit-Reset',
        },
        json:
          status === 200
            ? {
                total_count: pattern.length,
                workflow_runs: [...pattern].map((c, i) => ({
                  id: 1000 - i,
                  name: 'CI',
                  head_branch: branch,
                  event: 'push',
                  status: 'completed',
                  conclusion: c === '.' ? 'success' : 'failure',
                  updated_at: new Date(now - (i + 2) * 3_600_000).toISOString(),
                })),
              }
            : { message: 'API rate limit exceeded' },
      }),
  );
}
