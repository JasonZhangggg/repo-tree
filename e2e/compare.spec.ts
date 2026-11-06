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

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Compare trees' });
const pane = (page: Page, side: 'a' | 'b') => page.locator(`.cmp-pane[data-side="${side}"]`);
const paneReady = (page: Page, side: 'a' | 'b', repo: string) =>
  expect(pane(page, side)).toHaveAttribute('data-ready', repo, { timeout: 60_000 });
/** On a phone Compare sits behind More actions. */
async function openCompare(page: Page) {
  const more = page.getByRole('button', { name: 'More actions' });
  if (await page.locator('#compare-open').isHidden()) await more.click();
  await page.getByRole('button', { name: 'Compare trees' }).click();
}
const table = (page: Page) => page.getByRole('table', { name: 'Both trees side by side' });

test('Compare grows a second repo beside the one on show, and Escape closes it', async ({
  page,
  isMobile,
}) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await openCompare(page);

  await expect(dialog(page)).toBeVisible();
  await paneReady(page, 'a', 'vitejs/vite');
  await paneReady(page, 'b', 'mathiasbynens/dotfiles');
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles');
  await expect(page.locator('#compare-line')).toHaveText(/vite has \d+× the files of dotfiles/);
  const files = table(page).getByRole('row', { name: /^Files/ });
  await expect(files.getByRole('cell')).toHaveText([/^\d{1,3},\d{3}$/, '36']);
  // Both trees share one ranking of languages, so the table names languages from either.
  await expect(table(page).getByRole('row', { name: /JSON/ })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  expect(page.url()).not.toContain('vs=');
  await expect(page.locator(isMobile ? '#more' : '#compare-open')).toBeFocused();
});

test('a link opens the compare view, and Change grows another repo on the right', async ({
  page,
}) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await paneReady(page, 'b', 'mathiasbynens/dotfiles');

  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByLabel('Repository to compare').fill('acme/widgets');
  await page.getByLabel('Repository to compare').press('Enter');
  await paneReady(page, 'b', 'acme/widgets');
  expect(page.url()).toContain('vs=acme/widgets');
  await expect(pane(page, 'b').locator('.cmp-name')).toHaveText('acme/widgets');
});

test('Swap trades sides, and Open this tree shows the right-hand repo on its own', async ({
  page,
}) => {
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await paneReady(page, 'b', 'mathiasbynens/dotfiles');

  await page.getByRole('button', { name: 'Swap sides' }).click();
  await paneReady(page, 'a', 'mathiasbynens/dotfiles');
  await paneReady(page, 'b', 'vitejs/vite');
  expect(page.url()).toContain('#/mathiasbynens/dotfiles');
  expect(page.url()).toContain('vs=vitejs/vite');

  await page.getByRole('button', { name: 'Open this tree' }).click();
  await expect(dialog(page)).toBeHidden();
  await ready(page, 'vitejs/vite');
  expect(page.url()).not.toContain('vs=');
});
