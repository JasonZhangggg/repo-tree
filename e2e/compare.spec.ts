import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';
import { openRepoField } from './view';

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

/** B's card and field, under A's. */
const b = (page: Page) => page.getByRole('group', { name: 'Repository B' });
const bName = (page: Page) => b(page).getByRole('heading', { level: 2 });
const bField = (page: Page) => page.getByRole('textbox', { name: 'Repository B' });
/** The compared repo has grown in on its island beside the one on show. */
const besideReady = (page: Page, repo: string) =>
  expect(page.locator('#compare')).toHaveAttribute('data-ready', repo, { timeout: 60_000 });
const panel = (page: Page) => page.locator('#compare-panel');
const table = (page: Page, name: string) => page.getByRole('table', { name });

/** On a phone Compare sits behind More actions. */
async function openCompare(page: Page) {
  if (await page.locator('#compare-open').isHidden()) {
    await page.getByRole('button', { name: 'More actions' }).click();
  }
  await page.getByRole('button', { name: 'Compare trees' }).click();
}

/** On a phone B's field takes its card's place once B's mark is pressed. */
async function openBField(page: Page) {
  if (await bField(page).isHidden()) {
    await page.getByRole('button', { name: 'Change repository B' }).click();
  }
}

/** On a phone the side by side lives in the sheet. */
async function showPanel(page: Page) {
  if (await panel(page).isHidden()) await page.locator('#sheet-toggle').click();
}

test('Compare grows a second repo beside the one on show, and Stop takes it away', async ({
  page,
}) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await openCompare(page);

  await besideReady(page, 'mathiasbynens/dotfiles');
  // A keeps its card; B gets one just like it, below.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
  await expect(bName(page)).toHaveText('mathiasbynens/dotfiles');
  await expect(b(page).locator('#compare-meta')).toContainText('36 files');
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles');
  // A name tag under each island.
  await expect(page.locator('.island-tag')).toHaveText(['Avite', 'Bdotfiles']);
  // Folder labels belong to one tree, so they go.
  await expect(page.locator('#labels')).toBeHidden();

  await showPanel(page);
  await expect(page.locator('#compare-line')).toHaveText(/vite has \d+× the files of dotfiles/);
  const files = table(page, 'Both trees side by side').getByRole('row', { name: /^Files/ });
  await expect(files.getByRole('cell')).toHaveText([/^\d{1,3},\d{3}$/, '36']);
  // The side by side follows Color by: languages first.
  await expect(
    table(page, 'Languages side by side').getByRole('row', { name: /JSON/ }),
  ).toBeAttached();

  await page.getByRole('button', { name: 'Stop comparing' }).click();
  await expect(b(page)).toBeHidden();
  await expect(page.locator('.island-tag').first()).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(page.url()).not.toContain('vs=');
});

test('a link compares two repos, and each card has its own field', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');

  await openBField(page);
  await bField(page).fill('vitejs/vite');
  await bField(page).press('Enter');
  await expect(page.locator('#compare-error')).toHaveText(/already A/);
  await bField(page).fill('acme/widgets');
  await bField(page).press('Enter');
  await besideReady(page, 'acme/widgets');
  expect(page.url()).toContain('vs=acme/widgets');
  await expect(bName(page)).toHaveText('acme/widgets');

  // A's own field loads another repo in A's place and keeps B.
  await openRepoField(page);
  const field = page.getByLabel('GitHub repository');
  await field.fill('mathiasbynens/dotfiles');
  await field.press('Enter');
  await ready(page, 'mathiasbynens/dotfiles');
  await besideReady(page, 'acme/widgets');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('mathiasbynens/dotfiles');
});

test('the side by side follows Color by', async ({ page }) => {
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles&colorBy=changes');
  await besideReady(page, 'mathiasbynens/dotfiles');
  await showPanel(page);

  // Both histories are bundled, so both columns fill in, and each tree lists its busiest files.
  const changes = table(page, 'How often files change side by side');
  await expect(changes.getByRole('row', { name: /^Rarely/ }).getByRole('cell')).toHaveText([
    /%$/,
    /%$/,
  ]);
  await expect(panel(page).locator('.cmp-list')).toHaveCount(2);
  await expect(panel(page).locator('.cmp-list').nth(1).locator('li')).not.toHaveCount(0);
});
