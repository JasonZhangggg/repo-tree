import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';
import { settle } from './view';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

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

/** And closes it again, so the toolbar under it can be reached. */
async function closeSide(page: Page) {
  const sheet = page.locator('#sheet-toggle');
  if ((await sheet.isVisible()) && (await sheet.getAttribute('aria-expanded')) === 'true') {
    await sheet.click();
  }
}

/** Ember pixels: the glow's vivid amber, which spring's pink and white crown never shows. */
async function embers(page: Page) {
  await settle(page);
  const veil = await page.addStyleTag({
    content: '.bar, .title, .side, .controls, #labels { opacity: 0 !important }',
  });
  await page.evaluate(
    () => new Promise((paint) => requestAnimationFrame(() => requestAnimationFrame(paint))),
  );
  const png = await page.screenshot();
  await veil.evaluate((style) => (style as Element).remove());
  return page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
      if (r > 200 && g > 90 && g < 190 && b < 90 && r - g > 50) n++;
    }
    return n;
  }, png.toString('base64'));
}

test('Hotspots make the busiest files glow and list them to pin', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'repo-tree:settings',
      JSON.stringify({ quality: 'low', spin: false, ground: false, palette: 'spring' }),
    ),
  );
  await page.goto('./#/vitejs/vite?colorBy=language');
  await ready(page, 'vitejs/vite');
  await openSide(page);
  await expect(page.locator('#hot')).toBeHidden();
  const before = await embers(page);

  await closeSide(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: /^Hotspots/ }).check();
  await expect(page.getByText('Busiest files glow', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const stored = await page.evaluate(() => localStorage.getItem('repo-tree:settings'));
  expect(JSON.parse(stored!).hotspots).toBe(true);

  await openSide(page);
  await expect(note(page)).toHaveText(/^The [\d,]+ busiest files glow, from commit history\.$/);
  await expect(hotFile(page)).toHaveCount(5);
  await expect(hotFile(page).first()).toHaveText(/…\/vite\/package\.json\s*\d+/);
  expect(await glowing(page)).toBeGreaterThan(0);
  const lit = await embers(page);
  expect(lit, 'hot leaves glow amber').toBeGreaterThan(Math.max(50, before * 3));

  await openSide(page);
  await hotFile(page).first().click();
  const card = page.getByRole('article', { name: /Pinned folder/ });
  await expect(card.locator('.file-card code')).toHaveText('package.json');
  await expect(card.getByRole('navigation', { name: 'Folder path' })).toContainText('packages');
  await expect(hotFile(page).first()).toHaveAttribute('aria-current', 'true');

  await closeSide(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: /^Hotspots/ }).uncheck();
  await page.keyboard.press('Escape');
  await openSide(page);
  await expect(page.locator('#hot')).toBeHidden();
  expect(await glowing(page)).toBe(0);
});

test('hotspots glow over activity colors too, and come back from storage', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'repo-tree:settings',
      JSON.stringify({ quality: 'low', spin: false, hotspots: true }),
    ),
  );
  await page.goto('./#/vitejs/vite?colorBy=activity');
  await ready(page, 'vitejs/vite');
  await openSide(page);
  await expect(page.locator('#legend-title')).toHaveText('Leaf colors by activity');
  await expect(note(page)).toHaveText(/busiest files glow/);
  await expect.poll(() => glowing(page)).toBeGreaterThan(0);
});

test('hotspots alone keep the legend by language', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'repo-tree:settings',
      JSON.stringify({ quality: 'low', spin: false, hotspots: true }),
    ),
  );
  await page.goto('./#/vitejs/vite?colorBy=language');
  await ready(page, 'vitejs/vite');
  await openSide(page);
  await expect(note(page)).toHaveText(/busiest files glow/);
  await expect(page.locator('#legend-title')).toHaveText('Leaf colors by language');
});

test('a repo with no history has no hotspots and says why', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'repo-tree:settings',
      JSON.stringify({ quality: 'low', spin: false, hotspots: true }),
    ),
  );
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/acme/widgets');
  await ready(page, 'acme/widgets');
  await openSide(page);
  await expect(note(page)).toHaveText('History is unavailable for this repo.');
  await expect(hotFile(page)).toHaveCount(0);
  expect(await glowing(page)).toBe(0);
});
