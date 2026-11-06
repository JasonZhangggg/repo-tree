import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';

test.use({ reducedMotion: 'reduce' });
// Each test grows two trees, one after the other, on a software renderer shared with other workers.
test.describe.configure({ timeout: 60_000 });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const card = (page: Page) => page.getByRole('group', { name: 'Compared tree' });
const tree = (page: Page, side: 'A' | 'B') =>
  page.getByRole('radio', { name: new RegExp(`^${side}: `) });
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
  // One row per tree, alike: A is the repo on show, its details in the panels; B grew beside it.
  await expect(tree(page, 'A')).toHaveAccessibleName('A: vitejs/vite');
  await expect(tree(page, 'A')).toBeChecked();
  await expect(tree(page, 'B')).toHaveAccessibleName('B: mathiasbynens/dotfiles');
  await expect(card(page).getByRole('button', { name: /^Change [AB]/ })).toHaveCount(2);
  await expect(card(page)).toContainText('36 files');
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles');
  await expect(page.locator('#compare-line')).toHaveText(/vite has \d+× the files of dotfiles/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
  // A name tag under each island.
  await expect(page.locator('.island-tag')).toHaveText(['Avitejs/vite', 'Bmathiasbynens/dotfiles']);
  // Nothing on screen that only one tree has: no CI weather, birds or folder labels.
  await expect(page.locator('#weather')).toBeHidden();
  await expect(page.locator('#labels')).toBeHidden();
  if (await table(page).isHidden()) await page.locator('#sheet-toggle').click();
  const files = table(page).getByRole('row', { name: /^Files/ });
  await expect(files.getByRole('cell')).toHaveText([/^\d{1,3},\d{3}$/, '36']);
  await expect(table(page).getByRole('row', { name: /JSON/ })).toBeAttached();

  await page.getByRole('button', { name: 'Stop comparing' }).click();
  await expect(card(page)).toBeHidden();
  await expect(page.locator('.island-tag').first()).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(page.url()).not.toContain('vs=');
});

test('a link compares two repos, and Change puts another one in either place', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');

  const field = page.getByLabel(/^Repository to put in place of/);
  await page.getByRole('button', { name: /^Change B/ }).click();
  await expect(field).toHaveAccessibleName('Repository to put in place of B');
  await field.fill('vitejs/vite');
  await field.press('Enter');
  await expect(page.locator('#compare-error')).toHaveText('That one is already the other tree');
  await field.fill('acme/widgets');
  await field.press('Enter');
  await besideReady(page, 'acme/widgets');
  expect(page.url()).toContain('vs=acme/widgets');
  await expect(tree(page, 'B')).toHaveAccessibleName('B: acme/widgets');

  // A is the repo on show, so changing it loads another in its place and keeps B.
  await page.getByRole('button', { name: /^Change A/ }).click();
  await field.fill('mathiasbynens/dotfiles');
  await field.press('Enter');
  await ready(page, 'mathiasbynens/dotfiles');
  await besideReady(page, 'acme/widgets');
  await expect(tree(page, 'A')).toHaveAccessibleName('A: mathiasbynens/dotfiles');
  await expect(tree(page, 'A')).toBeChecked();
});

test('picking the other tree gives it the panels, and both keep their places', async ({ page }) => {
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');

  await tree(page, 'B').check();
  await ready(page, 'mathiasbynens/dotfiles');
  await besideReady(page, 'vitejs/vite');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('mathiasbynens/dotfiles');
  await expect(tree(page, 'A')).toHaveAccessibleName('A: vitejs/vite');
  await expect(tree(page, 'B')).toBeChecked();
  expect(page.url()).toContain('#/mathiasbynens/dotfiles');
  expect(page.url()).toContain('vs=vitejs/vite&vsfirst=1');

  // The tag under A's island hands the panels back.
  await page.locator('.island-tag[data-side="a"]').click();
  await ready(page, 'vitejs/vite');
  await expect(tree(page, 'A')).toBeChecked();
  expect(page.url()).not.toContain('vsfirst');
});
