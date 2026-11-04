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

const legendTitle = (page: Page) => page.locator('#legend-title');
const legendNote = (page: Page) => page.locator('#legend-note');
const legendEntry = (page: Page, name: string) =>
  page.locator('#legend').getByRole('button', { name: new RegExp(`^${name}\\b`) });

/** On a phone the legend waits in the sheet, so this opens it. */
async function openLegend(page: Page) {
  const sheet = page.locator('#sheet-toggle');
  if ((await sheet.isVisible()) && (await sheet.getAttribute('aria-expanded')) === 'false') {
    await sheet.click();
  }
}

test('Changes colors leaves by how often their files changed', async ({ page }) => {
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#color-pick').click();
  await page.getByRole('radio', { name: 'Changes' }).click();
  await expect(page).toHaveURL(/colorBy=changes/);
  await expect(page.getByText(/^From commit history: how often each file changed/)).toBeVisible();
  await page.keyboard.press('Escape');

  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by changes');
  for (const band of ['Constantly', 'Often', 'Sometimes', 'Rarely']) {
    await expect(legendEntry(page, band)).toBeVisible();
  }
  await expect(legendNote(page)).toHaveText(/^How often each file changed, as of Nov 2026\./);
  await legendEntry(page, 'Constantly').click();
  await expect(legendNote(page)).toHaveText(/^Constantly · [\d,]+ files$/);
  await expect(page).toHaveURL(/&hl=Constantly$/);
});

test('a shared changes link comes back with its highlighted band', async ({ page }) => {
  await page.goto('./#/vitejs/vite?colorBy=changes&hl=Often');
  await ready(page, 'vitejs/vite');
  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by changes');
  await expect(legendEntry(page, 'Often')).toHaveAttribute('aria-pressed', 'true');
});

test('a repo with no history keeps language colors for changes and says why', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/acme/widgets?colorBy=changes');
  await ready(page, 'acme/widgets');
  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by language');
  await expect(legendNote(page)).toHaveText('History is unavailable for this repo.');
});
