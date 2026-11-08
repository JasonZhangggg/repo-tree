import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveBranches, VITE_BRANCHES } from './github';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
  await serveBranches(page, 'vitejs/vite', VITE_BRANCHES);
});
test.afterEach(() => expect(errors).toEqual([]));

/** The row at the foot of the repo card, or on a phone the More actions menu's entry. */
async function openPicker(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Show a branch’s changes' }).click();
}

test('a branch picked from the list shows its changes against main, and × puts the tree back', async ({
  page,
  isMobile,
}) => {
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await expect(page.locator('#repo-meta')).toContainText('2,898 files');
  await openPicker(page, isMobile);
  const picker = page.getByRole('dialog', { name: 'Show a branch’s changes against main' });
  await expect(picker.locator('.diff-ref')).toHaveCount(5);
  await page.getByLabel('Branch, tag or commit').fill('v6');
  await expect(picker.locator('.diff-ref')).toHaveText([/v6\.3\.0\s*tag/i, /v6\.2\.0\s*tag/i]);
  await page.getByLabel('Branch, tag or commit').fill('');
  await picker.getByRole('button', { name: /feat\/rolldown-bundler/ }).click();

  const shown = page.locator('#diff-on');
  await expect(shown).toContainText(/feat\/rolldown-bundler\s*vs\s*main/);
  await expect(shown).toContainText('13 new');
  await expect(shown).toContainText('9 changed');
  await expect(shown).toContainText('58 deleted');
  await expect(shown).toContainText('23 commits ahead, 4 behind.');
  // Its new files grow in as leaves of their own.
  await expect(page.locator('#repo-meta')).toContainText('2,911 files');
  await expect(page).toHaveURL(/diff=feat\/rolldown-bundler/);

  await page.getByRole('button', { name: 'Stop showing branch changes' }).click();
  await expect(page.locator('#diff-on')).toBeHidden();
  await expect(page.locator('#repo-meta')).toContainText('2,898 files');
  await expect(page).not.toHaveURL(/diff=/);
});

test('the picker closes with its corner X, with no Cancel beside Show changes', async ({
  page,
  isMobile,
}) => {
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await openPicker(page, isMobile);
  const picker = page.getByRole('dialog', { name: 'Show a branch’s changes against main' });
  await expect(picker.locator('.diff-ref')).toHaveCount(5);
  await expect(picker.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await picker.getByRole('button', { name: 'Close' }).click();
  await expect(picker).toBeHidden();
  await expect(page.locator('#diff-on')).toBeHidden();
});

test('a link opens with the branch shown', async ({ page }) => {
  await page.goto('./#/vitejs/vite?branch=main&diff=feat/rolldown-bundler');
  await expect(page.locator('#diff-on')).toContainText('13 new');
  await expect(page.locator('#repo-meta')).toContainText('2,911 files');
});

test('a name GitHub does not know says so, and the tree stays as it was', async ({
  page,
  isMobile,
}) => {
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await openPicker(page, isMobile);
  await page.getByLabel('Branch, tag or commit').fill('no-such-branch');
  await page.getByRole('button', { name: 'Show changes' }).click();
  await expect(page.locator('#diff-on')).toContainText(
    'GitHub has no branch, tag or commit “no-such-branch” here that shares history with main.',
  );
  await expect(page.locator('#repo-meta')).toContainText('2,898 files');
});
