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

const compared = (page: Page) => page.getByRole('group', { name: 'Compared tree' });
/** The compared repo has grown in on its island beside the one on show. */
const besideReady = (page: Page, repo: string) =>
  expect(page.locator('#compare')).toHaveAttribute('data-ready', repo, { timeout: 60_000 });
const table = (page: Page) => page.getByRole('table', { name: 'Both trees side by side' });

/** On a phone Compare sits behind More actions. */
async function openCompare(page: Page) {
  if (await page.locator('#compare-open').isHidden()) {
    await page.getByRole('button', { name: 'More actions' }).click();
  }
  await page.getByRole('button', { name: 'Compare trees' }).click();
}

test('Compare grows a second repo beside the one on show, and Stop takes it away', async ({
  page,
}) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await openCompare(page);

  await besideReady(page, 'mathiasbynens/dotfiles');
  await expect(compared(page)).toContainText('mathiasbynens/dotfiles');
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles');
  await expect(page.locator('#compare-line')).toHaveText(/vite has \d+× the files of dotfiles/);
  // The one set of panels still describes the repo on show.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
  if (await table(page).isHidden()) await page.locator('#sheet-toggle').click();
  const files = table(page).getByRole('row', { name: /^Files/ });
  await expect(files.getByRole('cell')).toHaveText([/^\d{1,3},\d{3}$/, '36']);
  await expect(table(page).getByRole('row', { name: /JSON/ })).toBeAttached();

  await page.getByRole('button', { name: 'Stop comparing' }).click();
  await expect(compared(page)).toBeHidden();
  expect(page.url()).not.toContain('vs=');
});

test('a link compares two repos, and Change grows another one beside', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');

  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByLabel('Repository to compare').fill('acme/widgets');
  await page.getByLabel('Repository to compare').press('Enter');
  await besideReady(page, 'acme/widgets');
  expect(page.url()).toContain('vs=acme/widgets');
});

test('Switch gives the panels to the other tree and keeps both in view', async ({ page }) => {
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');

  await page.getByRole('button', { name: 'Switch' }).click();
  await ready(page, 'mathiasbynens/dotfiles');
  await besideReady(page, 'vitejs/vite');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('mathiasbynens/dotfiles');
  expect(page.url()).toContain('#/mathiasbynens/dotfiles');
  expect(page.url()).toContain('vs=vitejs/vite');
});
