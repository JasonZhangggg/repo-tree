import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';
import { treePixels } from './pixels';
import { settle } from './view';

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

/** The share of the page that is tree, with every panel and label made see-through. */
async function treeShare(page: Page) {
  // A pointer resting on a legend color highlights it and fades the rest, so park it in a corner.
  const box = page.viewportSize()!;
  await page.mouse.move(box.width - 4, box.height - 4);
  await settle(page);
  const veil = await page.addStyleTag({
    content: '.bar, .title, .side, .controls, #labels { opacity: 0 !important }',
  });
  await page.evaluate(
    () => new Promise((paint) => requestAnimationFrame(() => requestAnimationFrame(paint))),
  );
  const { share } = await treePixels(page);
  await veil.evaluate((style) => (style as Element).remove());
  return share;
}

test('Activity colors leaves by their last change, and dead wood drops its leaves', async ({
  page,
}) => {
  // Without the island the share counts only bark and leaves.
  await page.addInitScript(() =>
    localStorage.setItem(
      'repo-tree:settings',
      JSON.stringify({ quality: 'low', spin: false, ground: false }),
    ),
  );
  await page.goto('./#/vitejs/vite?colorBy=language');
  await ready(page, 'vitejs/vite');
  const inLeaf = await treeShare(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#color-pick').click();
  await page.locator('#settings').getByRole('radio', { name: 'Activity' }).click();
  await expect(page).toHaveURL(/colorBy=activity/);
  await expect(
    page.getByText(/^From commit history: how recently each file changed/),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by activity');
  for (const band of ['This month', 'This year', '1 to 3 years', 'Dead wood']) {
    await expect(legendEntry(page, band)).toBeVisible();
  }
  await expect(legendNote(page)).toHaveText(/^Last change, as of Nov 2026\./);
  const bare = await treeShare(page);
  // A sprig is dead wood only when all its files are, so few sprigs drop: about 6% of the tree here.
  expect(bare, 'dead wood leaves are gone').toBeLessThan(inLeaf * 0.97);

  await legendEntry(page, 'Dead wood').click();
  await expect(legendNote(page)).toHaveText(/^Dead wood · [\d,]+ files$/);
  await expect(page).toHaveURL(/&hl=Dead%20wood$/);
  const shown = await treeShare(page);
  expect(shown, 'highlighting dead wood brings its leaves back').toBeGreaterThan(bare * 0.2);
});

test('a shared activity link comes back with its highlighted band', async ({ page }) => {
  await page.goto('./#/vitejs/vite?colorBy=activity&hl=This%20year');
  await ready(page, 'vitejs/vite');
  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by activity');
  await expect(legendEntry(page, 'This year')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/colorBy=activity&hl=This%20year$/);
});

test('a repo with no history keeps language colors and says why', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/acme/widgets?colorBy=activity');
  await ready(page, 'acme/widgets');
  await openLegend(page);
  await expect(legendTitle(page)).toHaveText('Leaf colors by language');
  await expect(legendNote(page)).toHaveText('History is unavailable for this repo.');
});
