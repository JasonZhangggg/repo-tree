import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';

/**
 * Computing a missing history in the browser and sharing it, against e2e/history-stack.mjs:
 * a fake GitHub (API and sign-in), the real history Worker, and the app built to use both.
 */
const WORKER = process.env.HISTORY_WORKER ?? 'http://localhost:4177';
const FAKE = process.env.HISTORY_GITHUB ?? 'http://localhost:4178';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
  await serveRepo(page, 'acme/widgets');
  await serveRepo(page, 'acme/gadgets');
});
test.afterEach(() => expect(errors).toEqual([]));

const dialog = (page: Page) => page.getByRole('dialog', { name: /timeline|history/i });

async function open(page: Page, name = 'acme/widgets') {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const input = page.getByLabel('GitHub repository');
  await input.fill(name);
  await input.press('Enter');
  await ready(page, name);
}

test.describe.configure({ mode: 'serial' });

test('a signed-out visitor is offered to compute a missing history, and may decline', async ({
  page,
}) => {
  await open(page);
  await page.locator('#timeline').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('No timeline yet for acme/widgets');
  await expect(dialog(page)).toContainText('your own GitHub requests, under 1 MB to download');
  await expect(dialog(page)).toContainText('everyone who opens acme/widgets gets it at once');
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('group', { name: 'Timeline' })).toBeHidden();
});

test('signs in, computes in the browser, shares it, and opens the timeline', async ({
  page,
  context,
}) => {
  const authorized: string[] = [];
  context.on('request', (req) => {
    if (req.headers()['authorization']) authorized.push(new URL(req.url()).origin);
  });
  await open(page);
  await page.locator('#timeline').click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await (await popup).waitForEvent('close');
  await expect(page.getByRole('group', { name: 'Timeline' })).toBeVisible({ timeout: 60_000 });
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#timeline-date')).not.toBeEmpty();

  // Stored for everyone, with the manifest the Worker checked.
  const res = await fetch(`${WORKER}/v1/history/acme/widgets?branch=main`);
  expect(res.status).toBe(200);
  const manifest = JSON.parse(res.headers.get('x-history-manifest')!);
  expect(manifest).toMatchObject({ repo: 'acme/widgets', branch: 'main', by: 'visitor' });
  // The token went to GitHub (the fake) and the Worker, nowhere else.
  expect(new Set(authorized)).toEqual(new Set([FAKE, WORKER]));
  expect(await page.evaluate(() => localStorage.getItem('repo-tree:github-signin'))).toBeNull();
});

test('a signed-out visitor then gets the shared history with no prompt', async ({ page }) => {
  await open(page);
  await page.locator('#timeline').click();
  await expect(page.getByRole('group', { name: 'Timeline' })).toBeVisible();
  await expect(dialog(page)).toBeHidden();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('warns with the estimate before starting, and lets the visitor choose', async ({ page }) => {
    // A repo nobody computed yet (acme/widgets is shared by now).
    await open(page, 'acme/gadgets');
    await page.locator('#timeline').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('This looks like a phone or a small device.');
    await expect(dialog(page)).toContainText('drain the battery');
    await expect(page.getByRole('button', { name: 'Sign in and compute anyway' })).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog(page)).toBeHidden();
  });
});
