import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { quietSettings, ready } from './github';

/**
 * Opening a link (or reloading) grows its repo on a cold page, and a page whose first load fails
 * is empty but for the error. These are the ways that load used to fail where picking the same
 * repo from the search a moment later grew it: none of them should show an error.
 */

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const fixture = JSON.parse(
  gunzipSync(readFileSync('public/samples/mathiasbynens-dotfiles.json.gz')).toString(),
) as { repo: { default_branch: string }; tree: unknown };
const NAME = 'acme/web';
const LINK = `./#/${NAME}?branch=${fixture.repo.default_branch}`;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Retry-After, X-RateLimit-Remaining, X-RateLimit-Reset',
};

/**
 * Serves `acme/web`'s repo and tree, passing each read to `fail` first: it answers with a
 * failure, or returns false to serve the read. Returns the tree reads seen, with their tokens.
 */
async function serve(page: Page, fail: (route: Route, read: number) => Promise<boolean> | false) {
  const reads: (string | undefined)[] = [];
  await page.route(`https://api.github.com/repos/${NAME}/git/trees/**`, async (route) => {
    reads.push(route.request().headers()['authorization']);
    if (await fail(route, reads.length)) return;
    await route.fulfill({ json: fixture.tree, headers: CORS });
  });
  return reads;
}

const failWith =
  (status: number, headers: Record<string, string> = {}) =>
  async (route: Route) => {
    await route.fulfill({ status, headers: { ...CORS, ...headers }, json: { message: 'nope' } });
    return true;
  };

const signedIn = (page: Page) =>
  page.addInitScript(() => sessionStorage.setItem('repo-tree:github-signin', 'gho_expired'));

test('a sign-in that expired since the last visit loads the link signed out', async ({ page }) => {
  await signedIn(page);
  const reads = await serve(page, (route) =>
    route.request().headers()['authorization'] ? failWith(401)(route) : false,
  );

  await page.goto(LINK);

  await ready(page, NAME);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('sign-in expired');
  expect(reads).toEqual(['Bearer gho_expired', undefined]);
  expect(await page.evaluate(() => sessionStorage.getItem('repo-tree:github-signin'))).toBeNull();
});

for (const [why, fail] of [
  ['a server error', failWith(502)],
  ['a dropped connection', (route: Route) => route.abort('connectionreset').then(() => true)],
  ['the secondary rate limit', failWith(403, { 'retry-after': '1' })],
] as const) {
  test(`a link still grows after ${why} on its first read`, async ({ page }) => {
    const reads = await serve(page, (route, read) => (read === 1 ? fail(route) : false));

    await page.goto(LINK);

    await ready(page, NAME);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(reads).toHaveLength(2);
  });
}

test('a refusal with no token sent never blames a token', async ({ page }) => {
  await serve(page, failWith(403, { 'x-ratelimit-remaining': '41' }));

  await page.goto(LINK);

  await expect(page.getByRole('alert')).toContainText('Can’t reach GitHub');
  await expect(page.getByRole('alert')).not.toContainText('token');
});
