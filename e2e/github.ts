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

export const ready = (page: Page, repo: string) =>
  page.waitForSelector(`body[data-ready="${repo}"]`, { state: 'attached', timeout: 60_000 });
