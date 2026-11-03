import { expect, test, type Page } from '@playwright/test';
import { failRepo, quietSettings, ready, serveRepo } from './github';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

async function enterRepo(page: Page, text: string) {
  await page.getByLabel('GitHub repository').fill(text);
  await page.getByLabel('GitHub repository').press('Enter');
}

const detail = (page: Page) => page.getByRole('article', { name: /Pinned folder/ });

test('first visit grows a bundled sample', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
  await expect(page.locator('#view')).toHaveAttribute(
    'aria-label',
    /3D tree of vitejs\/vite: [\d,]+ files/,
  );
  await expect(page).toHaveURL(/#\/vitejs\/vite\?branch=main&palette=autumn&colorBy=language$/);
});

test('typing owner/repo loads it from GitHub', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./');
  await ready(page, 'vitejs/vite');

  await enterRepo(page, 'not a repo');
  await expect(page.getByRole('alert').first()).toHaveText(/Use owner\/repo/);

  await enterRepo(page, 'https://github.com/acme/widgets');
  await ready(page, 'acme/widgets');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme/widgets');
  await expect(page.locator('#repo-meta')).toContainText('36 files');
  await expect(page).toHaveURL(/#\/acme\/widgets\?branch=main/);
});

test('a missing repo says so and keeps the tree on screen', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await failRepo(page, 404);
  await enterRepo(page, 'acme/missing');

  await expect(page.getByRole('alert')).toContainText('Can’t find acme/missing');
  await expect(page.getByRole('alert')).toContainText('add a GitHub token');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');

  await page.getByRole('button', { name: 'Add a token' }).click();
  await expect(page.getByLabel('GitHub token')).toBeFocused();
});

test('a rate limit names the reset time and suggests a token', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const reset = Math.floor(Date.now() / 1000) + 1800;
  await failRepo(page, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
  await enterRepo(page, 'acme/widgets');

  const at = await page.evaluate(
    (s) => new Date(s * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    reset,
  );
  await expect(page.getByRole('alert')).toContainText('rate limit');
  await expect(page.getByRole('alert')).toContainText(`resets at ${at}`);
  await expect(page.getByRole('button', { name: 'Add a token' })).toBeVisible();
});

test('a shared link restores repo, palette and pinned folder', async ({ page, context }) => {
  await page.goto('./#/vitejs/vite?palette=winter&sel=packages/vite');
  await ready(page, 'vitejs/vite');
  await expect(detail(page)).toBeVisible();
  await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toHaveText(
    'vite/packages/vite',
  );

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: /Copy link/ }).click();
  await expect(page.getByRole('status').last()).toHaveText('Link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(
    /#\/vitejs\/vite\?branch=main&palette=winter&colorBy=language&sel=packages\/vite$/,
  );

  const other = await context.newPage();
  await other.goto(link);
  await ready(other, 'vitejs/vite');
  await expect(detail(other).getByRole('navigation', { name: 'Folder path' })).toHaveText(
    'vite/packages/vite',
  );
  await other.getByRole('button', { name: 'Settings' }).click();
  await expect(other.getByRole('radio', { name: /Winter/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('search finds a folder, frames it and pins it', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const before = await page.evaluate(
    () => (window as unknown as { __repoTree: { labels: unknown } }).__repoTree.labels,
  );

  await page.keyboard.press('/');
  const box = page.getByRole('combobox', { name: 'Search folders and files' });
  await expect(box).toBeFocused();
  await box.fill('node/server');
  await expect(page.getByRole('option').first()).toContainText('packages/vite/src/node/server/');
  await box.press('Enter');

  await expect(page.getByRole('dialog', { name: 'Search folders and files' })).toBeHidden();
  await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toHaveText(
    'vite/packages/vite/src/node/server',
  );
  await expect(page).toHaveURL(/sel=packages\/vite\/src\/node\/server$/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __repoTree: { labels: unknown } }).__repoTree.labels,
      ),
    )
    .not.toEqual(before);

  await page.keyboard.press('Escape');
  await expect(detail(page)).toBeHidden();
});

test('a palette picked in settings survives a reload', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: /Spring blossom/ }).click();
  await expect(page).toHaveURL(/palette=spring/);

  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(page).toHaveURL(/palette=spring/);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: /Spring blossom/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('on a phone the sheet opens and a tap pins a folder', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone layout');
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const sheet = page.getByRole('button', { name: /Folders and leaf colors/ });
  await sheet.tap();
  await expect(sheet).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#folders button').first()).toBeVisible();
  const height = await page
    .locator('#folders button')
    .first()
    .evaluate((b) => b.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
  await sheet.tap();
  await expect(sheet).toHaveAttribute('aria-expanded', 'false');

  const labels = await page.evaluate(
    () =>
      (window as unknown as { __repoTree: { labels: { path: string; x: number; y: number }[] } })
        .__repoTree.labels,
  );
  const playground = labels.find((l) => l.path === 'playground')!;
  await page.touchscreen.tap(playground.x, playground.y);
  await expect(detail(page)).toBeVisible();
  await expect(page.locator('#sheet-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toContainText(
    'playground',
  );
});
