import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';

test.use({ reducedMotion: 'reduce' });
// Each test grows several trees, one after the other, on a software renderer shared with other workers.
test.describe.configure({ timeout: 90_000 });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const field = (page: Page) => page.getByLabel('GitHub repository');
const go = (page: Page) => page.locator('#repo-go');
const rows = (page: Page) => page.getByRole('group', { name: 'Compared repos' });
const rowNames = (page: Page) => rows(page).getByRole('heading', { level: 2 });
const add = (page: Page) => page.locator('#compare-add');
/** Every compared repo has grown in on its island beside the one on show. */
const besideReady = (page: Page, ...repos: string[]) =>
  expect(page.locator('#compare')).toHaveAttribute('data-ready', repos.join(' '), {
    timeout: 60_000,
  });
const panel = (page: Page) => page.locator('#compare-panel');
const table = (page: Page, name: string) => page.getByRole('table', { name });

/** Starts adding a repo: the card's add row, or Compare under More actions on a phone. */
async function startAdding(page: Page) {
  if (await add(page).isVisible()) return add(page).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Compare trees' }).click();
}

/** On a phone the side by side lives in the sheet. */
async function showPanel(page: Page) {
  const toggle = page.locator('#sheet-toggle');
  if ((await panel(page).isHidden()) && (await toggle.isVisible())) await toggle.click();
  await expect(panel(page)).toBeVisible();
}

test('the card adds a repo to compare through the search bar, and × takes it away', async ({
  page,
}) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(go(page)).toHaveText('Grow');

  // Adding turns Grow into Compare, and clicking out turns it back.
  await startAdding(page);
  await expect(field(page)).toBeFocused();
  await expect(go(page)).toHaveText('Compare');
  await expect(field(page)).toHaveAttribute('placeholder', 'Compare vitejs/vite with…');
  await page.keyboard.press('Escape');
  await expect(go(page)).toHaveText('Grow');

  // The list offers only repos not already compared.
  await startAdding(page);
  await expect(page.locator('#suggest')).not.toContainText('vitejs/vite');
  await page.locator('#suggest button', { hasText: 'mathiasbynens/dotfiles' }).click();
  await besideReady(page, 'mathiasbynens/dotfiles');
  await expect(go(page)).toHaveText('Grow');
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
  await expect(rowNames(page)).toHaveText(['mathiasbynens/dotfiles']);
  // A name tag under each island; folder labels belong to one tree, so they go.
  await expect(page.locator('.island-tag:visible')).toHaveText(['Avite', 'Bdotfiles']);
  await expect(page.locator('#labels')).toBeHidden();

  await showPanel(page);
  await expect(page.locator('#compare-line')).toHaveText(/vite has \d+× the files of dotfiles/);
  const files = table(page, 'All trees side by side').getByRole('row', { name: /^Files/ });
  await expect(files.getByRole('cell')).toHaveText([/^\d{1,3},\d{3}$/, '36']);
  await expect(
    table(page, 'Languages side by side').getByRole('row', { name: /JSON/ }),
  ).toBeAttached();
  if (await page.locator('#sheet-toggle').isVisible()) await page.locator('#sheet-toggle').click();

  await page
    .getByRole('button', { name: 'Remove mathiasbynens/dotfiles from the comparison' })
    .click();
  await expect(rowNames(page)).toHaveCount(0);
  await expect(page.locator('.island-tag:visible')).toHaveCount(0);
  expect(page.url()).not.toContain('vs=');
});

test('a link compares several repos, a typed one adds on, and A hands over to B', async ({
  page,
}) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');

  // A repo already in the comparison is refused; a new one joins as C.
  await startAdding(page);
  await field(page).fill('vitejs/vite');
  await field(page).press('Enter');
  await expect(page.locator('#repo-error')).toHaveText(/already in the comparison/);
  await field(page).fill('acme/widgets');
  await field(page).press('Enter');
  await besideReady(page, 'mathiasbynens/dotfiles', 'acme/widgets');
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles&vs=acme/widgets');
  await expect(rowNames(page)).toHaveText(['mathiasbynens/dotfiles', 'acme/widgets']);
  await showPanel(page);
  const files = table(page, 'All trees side by side').getByRole('row', { name: /^Files/ });
  await expect(files.getByRole('cell')).toHaveCount(3);
  if (await page.locator('#sheet-toggle').isVisible()) await page.locator('#sheet-toggle').click();

  // Taking A away puts B on show, and C stays beside it.
  await page.getByRole('button', { name: 'Remove A from the comparison' }).click();
  await ready(page, 'mathiasbynens/dotfiles');
  await besideReady(page, 'acme/widgets');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('mathiasbynens/dotfiles');
  await expect(rowNames(page)).toHaveText(['acme/widgets']);
});

test('the add row goes quiet once five repos are compared', async ({ page }) => {
  for (const name of ['acme/one', 'acme/two', 'acme/three']) await serveRepo(page, name);
  await page.goto(
    './#/vitejs/vite?vs=mathiasbynens/dotfiles&vs=acme/one&vs=acme/two&vs=acme/three',
  );
  await besideReady(page, 'mathiasbynens/dotfiles', 'acme/one', 'acme/two', 'acme/three');
  await expect(rowNames(page)).toHaveCount(4);
  await expect(add(page)).toBeDisabled();
  await expect(add(page)).toHaveText(/5 repos is the most/);
  await expect(page.locator('.island-tag:visible')).toHaveCount(5);
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
