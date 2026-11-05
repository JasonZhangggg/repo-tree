import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const hot = (page: Page) => page.locator('#hot');
const note = (page: Page) => page.locator('#hot-note');
const hotFile = (page: Page) => page.locator('#hot-files button');
const glowing = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { __repoTree: { view: { stats(): { glowing: number } } } }
      ).__repoTree.view.stats().glowing,
  );

/** On a phone the side panel waits in the sheet, so this opens it. */
async function openSide(page: Page) {
  const sheet = page.locator('#sheet-toggle');
  if ((await sheet.isVisible()) && (await sheet.getAttribute('aria-expanded')) === 'false') {
    await sheet.click();
  }
}

test('Changes lists the busiest files, which glow, each pinning its folder', async ({ page }) => {
  await page.goto('./#/vitejs/vite?colorBy=changes');
  await ready(page, 'vitejs/vite');
  await openSide(page);
  await expect(page.locator('#hot-title')).toHaveText('Busiest files');
  await expect(note(page)).toHaveText(/^The [\d,]+ busiest files glow, from commit history\.$/);
  await expect(hotFile(page)).toHaveCount(5);
  await expect(hotFile(page).first()).toHaveText(/…\/vite\/package\.json\s*\d+/);
  await expect.poll(() => glowing(page)).toBeGreaterThan(0);

  await hotFile(page).first().click();
  const card = page.getByRole('article', { name: /Pinned folder/ });
  await expect(card.locator('.file-card code')).toHaveText('package.json');
  await expect(card.getByRole('navigation', { name: 'Folder path' })).toContainText('packages');
  await expect(hotFile(page).first()).toHaveAttribute('aria-current', 'true');
});

test('other color modes have no glow and no busiest list', async ({ page }) => {
  await page.goto('./#/vitejs/vite?colorBy=activity');
  await ready(page, 'vitejs/vite');
  await openSide(page);
  await expect(page.locator('#legend-title')).toHaveText('Leaf colors by activity');
  await expect(hot(page)).toBeHidden();
  expect(await glowing(page)).toBe(0);
});

test('settings have no separate Hotspots switch', async ({ page }) => {
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('switch', { name: /^Weather/ })).toBeVisible();
  await expect(page.getByRole('switch', { name: /^Hotspots/ })).toHaveCount(0);
});

test('a repo with no history has no busiest files and says why', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/acme/widgets?colorBy=changes');
  await ready(page, 'acme/widgets');
  await openSide(page);
  await expect(note(page)).toHaveText('History is unavailable for this repo.');
  await expect(hotFile(page)).toHaveCount(0);
  expect(await glowing(page)).toBe(0);
});
