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
/** A legend entry by its whole label, followed by its share. */
const legendEntry = (page: Page, name: string) =>
  page.locator('#legend').getByRole('button', { name: new RegExp(`^${name}\\s*[\\d.<]+%$`) });

/** On a phone the legend waits in the sheet, so this opens it. */
async function openLegend(page: Page) {
  const sheet = page.locator('#sheet-toggle');
  if ((await sheet.isVisible()) && (await sheet.getAttribute('aria-expanded')) === 'false') {
    await sheet.click();
  }
}

test('Owner colors each top-level folder by who to ask, and its card names them', async ({
  page,
}) => {
  await page.goto('./#/vitejs/vite?colorBy=language');
  await ready(page, 'vitejs/vite');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Owner' }).click();
  await expect(page).toHaveURL(/colorBy=owner/);
  await expect(page.getByText(/^Each top-level folder takes its owner/)).toBeVisible();
  await page.keyboard.press('Escape');

  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by owner');
  await expect(legendNote(page)).toHaveText(/^Each top-level folder's top commit author;/);
  // Folders that share an owner share one color.
  await expect(page.locator('#legend li')).toHaveCount(3);
  await expect(legendEntry(page, 'andrew')).toBeVisible();
  await expect(legendEntry(page, '翠')).toBeVisible();
  await expect(legendEntry(page, '翠 / green')).toBeVisible();
  const swatch = (name: string) =>
    page
      .locator('#folders button', { hasText: new RegExp(`^${name}/`) })
      .locator('.bar-track i')
      .evaluate((i) => getComputedStyle(i).getPropertyValue('--c'));
  expect(await swatch('packages')).toBe(await swatch('docs'));
  expect(await swatch('packages')).not.toBe(await swatch('patches'));
  expect(await swatch('packages')).not.toBe(await swatch('playground'));

  await legendEntry(page, '翠').click();
  await expect(legendNote(page)).toHaveText(/^翠 · [\d,]+ files$/);
  await expect(page).toHaveURL(/&hl=%E7%BF%A0$/);

  await page.locator('#folders button', { hasText: /^packages\// }).click();
  const card = page.getByRole('article', { name: 'Pinned folder packages' });
  await expect(card.getByRole('heading', { name: /^Top authors · commits since/ })).toBeVisible();
  const authors = card.getByRole('list', { name: 'Top authors' }).getByRole('listitem');
  await expect(authors).toHaveCount(5);
  await expect(authors.first()).toHaveText(/^翠\s*22$/);
});

test('a shared owner link comes back with its highlighted owner', async ({ page }) => {
  await page.goto('./#/torvalds/linux?colorBy=owner&hl=Alexei%20Starovoitov');
  await ready(page, 'torvalds/linux');
  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by owner');
  await expect(legendEntry(page, 'Alexei Starovoitov')).toHaveAttribute('aria-pressed', 'true');
  await expect(legendNote(page)).toHaveText(/^Alexei Starovoitov · [\d,]+ files$/);
  await expect(page).toHaveURL(/colorBy=owner&hl=Alexei%20Starovoitov$/);
});

test('a repo with no history keeps language colors and says why', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/acme/widgets?colorBy=owner');
  await ready(page, 'acme/widgets');
  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by language');
  await expect(legendNote(page)).toHaveText('History is unavailable for this repo.');
});
