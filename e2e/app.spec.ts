import { expect, test, type Page } from '@playwright/test';
import { failRepo, quietSettings, ready, serveRepo } from './github';
import { treePixels } from './pixels';
import { chooseAction, settle } from './view';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

async function enterRepo(page: Page, text: string) {
  await page.getByLabel('GitHub repository').fill(text);
  await page.getByLabel('GitHub repository').press('Enter');
}

const detail = (page: Page) => page.getByRole('article', { name: /Pinned folder/ });

/** Checks the pinned folder's card; on a phone it waits in the sheet, so this opens and closes it. */
async function expectPinned(page: Page, path: string) {
  const sheet = page.locator('#sheet-toggle');
  const phone = await sheet.isVisible();
  if (phone) await sheet.click();
  await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toHaveText(path);
  if (phone) await sheet.click();
}

test('first visit grows a bundled sample', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
  await expect(page.locator('#view')).toHaveAttribute(
    'aria-label',
    /3D tree of vitejs\/vite: [\d,]+ files/,
  );
  await expect(page).toHaveURL(/#\/vitejs\/vite\?branch=main&palette=autumn&colorBy=language$/);
});

test('the repo suggestions show small icons beside readable names', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('repo-tree:recent', JSON.stringify(['facebook/react'])),
  );
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await page.getByLabel('GitHub repository').focus();
  const rows = page.locator('.suggest button');
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    const glyph = (await row.locator('svg').boundingBox())!;
    expect(glyph.width, 'icon width').toBeLessThanOrEqual(20);
    expect(glyph.height, 'icon height').toBeLessThanOrEqual(20);
    const name = (await row.locator('span').boundingBox())!;
    expect(name.width, 'room for the repo name').toBeGreaterThan(100);
  }
  await expect(rows.first()).toContainText('facebook/react');
});

test('typing owner/repo loads it from GitHub', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./');
  await ready(page, 'vitejs/vite');

  await enterRepo(page, 'not a repo');
  await expect(page.getByRole('alert').first()).toHaveText(/Use owner\/repo/);

  await enterRepo(page, 'https://github.com/acme/widgets');
  await ready(page, 'acme/widgets');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme/widgets');
  await expect(page.locator('#repo-meta')).toContainText('36 files');
  await expect(page).toHaveURL(/#\/acme\/widgets\?branch=main/);
});

test('a missing repo says so and keeps the tree on screen', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await failRepo(page, 404);
  await enterRepo(page, 'acme/missing');

  await expect(page.getByRole('alert')).toContainText('Can’t find acme/missing');
  await expect(page.getByRole('alert')).toContainText('add a GitHub token');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');

  await page.getByRole('button', { name: 'Add a token' }).click();
  await expect(page.getByLabel('GitHub token')).toBeFocused();
});

test('a rate limit names the reset time and suggests a token', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const reset = Math.floor(Date.now() / 1000) + 1800;
  await failRepo(page, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
  await enterRepo(page, 'acme/widgets');

  const at = await page.evaluate(
    (s) => new Date(s * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    reset,
  );
  await expect(page.getByRole('alert')).toContainText('rate limit');
  await expect(page.getByRole('alert')).toContainText(`resets at ${at}`);
  await expect(page.getByRole('button', { name: 'Add a token' })).toBeVisible();
});

test('a shared link restores repo, palette and pinned folder', async ({ page, context }) => {
  await page.goto('./#/vitejs/vite?palette=winter&sel=packages/vite');
  await ready(page, 'vitejs/vite');
  await expectPinned(page, 'vite/packages/vite');

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await chooseAction(page, /Copy link/);
  await expect(page.getByRole('status').last()).toHaveText('Link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(
    /#\/vitejs\/vite\?branch=main&palette=winter&colorBy=language&sel=packages\/vite$/,
  );

  const other = await context.newPage();
  await other.goto(link);
  await ready(other, 'vitejs/vite');
  await expectPinned(other, 'vite/packages/vite');
  await other.getByRole('button', { name: 'Settings' }).click();
  await expect(other.getByRole('radio', { name: /Winter/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('search finds a folder, frames it and pins it', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const before = await page.evaluate(
    () => (window as unknown as { __repoTree: { labels: unknown } }).__repoTree.labels,
  );

  await page.keyboard.press('/');
  const box = page.getByRole('combobox', { name: 'Search folders and files' });
  await expect(box).toBeFocused();
  await box.fill('node/server');
  await expect(page.getByRole('option').first()).toContainText('packages/vite/src/node/server/');
  await box.press('Enter');

  await expect(page.getByRole('dialog', { name: 'Search folders and files' })).toBeHidden();
  await expectPinned(page, 'vite/packages/vite/src/node/server');
  await expect(page).toHaveURL(/sel=packages\/vite\/src\/node\/server$/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __repoTree: { labels: unknown } }).__repoTree.labels,
      ),
    )
    .not.toEqual(before);

  await page.keyboard.press('Escape');
  await expect(detail(page)).toBeHidden();
});

test('a palette picked in settings survives a reload', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: /Spring blossom/ }).click();
  await expect(page).toHaveURL(/palette=spring/);

  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(page).toHaveURL(/palette=spring/);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('radio', { name: /Spring blossom/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('turning the ground off in settings survives a reload', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const before = (await settle(page)).triangles;
  await page.getByRole('button', { name: 'Settings' }).click();
  const ground = page.getByRole('switch', { name: 'Ground' });
  await expect(ground).toBeChecked();
  await ground.click();
  await expect(ground).not.toBeChecked();
  expect((await settle(page)).triangles, 'the mound, rocks and grass are gone').toBeLessThan(
    before - 1000,
  );
  const stored = () => page.evaluate(() => localStorage.getItem('repo-tree:settings'));
  expect(JSON.parse((await stored())!)).toMatchObject({ ground: false });

  await page.reload();
  await ready(page, 'vitejs/vite');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('switch', { name: 'Ground' })).not.toBeChecked();
});

test('a rock names its root file on hover and pins it on click', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hover');
  test.setTimeout(90_000);
  await page.goto('./#/torvalds/linux');
  await ready(page, 'torvalds/linux');
  await settle(page);
  const rock = await page.evaluate(() => {
    const { view } = (window as unknown as Debug).__repoTree;
    for (let y = innerHeight * 0.95; y > innerHeight * 0.45; y -= 12)
      for (let x = innerWidth * 0.2; x < innerWidth * 0.8; x += 12) {
        const picked = view.pickAt(x, y);
        if (picked?.rock !== undefined) return { x, y, picked };
      }
    return null;
  });
  expect(rock, 'a rock under some pixel').not.toBeNull();
  expect(rock!.picked.folder, 'rocks belong to the root folder').toBe(0);

  await page.mouse.move(rock!.x, rock!.y);
  const tip = page.locator('#tip');
  await expect(tip).toBeVisible();
  const root = ['MAINTAINERS', 'Makefile', 'CREDITS', 'COPYING', 'README', 'Kbuild', 'Kconfig'];
  const name = (await tip.locator('code').textContent())!;
  expect(name === 'linux/' || root.some((f) => name === f) || name.startsWith('.')).toBe(true);
  await expect(tip).toContainText(/B|more files/);

  await page.mouse.click(rock!.x, rock!.y);
  await expectPinned(page, 'linux');
  if (name !== 'linux/') {
    await expect(detail(page).locator('.file-card code')).toHaveText(name);
  }
});

type Debug = {
  __repoTree: {
    labels: { path: string; x: number; y: number }[];
    tree: { folders: { path: string[] } };
    view: {
      stats(): { distance: number; renders: number; triangles: number };
      pickAt(x: number, y: number): { folder: number; rock?: number } | null;
    };
  };
};
const labelsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as Debug).__repoTree.labels);
/** The share of a 12 by 12 grid of points in `band` where the tree is under the pointer. */
const treeUnder = (page: Page, band: { x: number; y: number; width: number; height: number }) =>
  page.evaluate(({ x, y, width, height }) => {
    const { view } = (window as unknown as Debug).__repoTree;
    let hits = 0;
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        if (view.pickAt(x + ((i + 0.5) * width) / 12, y + ((j + 0.5) * height) / 12) !== null)
          hits++;
    return hits / 144;
  }, band);
const boxOf = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

test('the tree frames beside the panels, not under them', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  await page.goto('./#/torvalds/linux');
  await ready(page, 'torvalds/linux');
  await settle(page);
  const panels = [await boxOf(page, '.title'), await boxOf(page, '#overview')];
  await page.addStyleTag({
    content: '.bar, .title, .side, .controls, #labels { opacity: 0 }',
  });
  const { share, hits } = await treePixels(page, undefined, panels);
  expect(share, 'share of the page that is tree').toBeGreaterThan(0.01);
  expect(hits, 'tree pixels under the title card and the side panel').toEqual([0, 0]);
});

test('pinning a deep folder frames it in context', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  await page.goto('./#/torvalds/linux');
  await ready(page, 'torvalds/linux');
  const whole = (await settle(page)).distance;

  await page.evaluate(() => (location.hash += '&sel=drivers/net/wireless/intel/iwlwifi'));
  await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toHaveText(
    'linux/drivers/net/wireless/intel/iwlwifi',
  );
  expect((await settle(page)).distance, 'stands back to show the branch in context').toBeCloseTo(
    whole * 0.5,
    3,
  );
});

test('on a phone the tree stays in view as folders are pinned', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone layout');
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await settle(page);
  const sheet = page.locator('#sheet-toggle');
  await expect(sheet).toHaveAttribute('aria-expanded', 'false');

  const label = (await labelsOf(page)).find((l) => l.path === 'playground')!;
  const playground = await page.evaluate(({ x, y }) => {
    const { view, tree } = (window as unknown as Debug).__repoTree;
    for (let r = 0; r < 16; r++)
      for (let dx = -r; dx <= r; dx++)
        for (const dy of [-r, r]) {
          const picked = view.pickAt(x + dx, y + dy);
          if (picked && tree.folders.path[picked.folder]!.startsWith('playground'))
            return { x: x + dx, y: y + dy };
        }
    return { x, y };
  }, label);
  await page.touchscreen.tap(playground.x, playground.y);
  await expect(sheet, 'the peek names the pinned folder').toContainText('playground');
  await expect(sheet).toHaveAttribute('aria-expanded', 'false');
  await expect(detail(page)).toBeHidden();

  const header = await boxOf(page, '.title');
  const controls = await boxOf(page, '.controls');
  const width = page.viewportSize()!.width;
  const band = {
    x: 0,
    y: header.y + header.height,
    width,
    height: controls.y - header.y - header.height,
  };
  expect(await treeUnder(page, band), 'tree between header and peek').toBeGreaterThan(0.05);

  await sheet.tap();
  await expect(sheet).toHaveAttribute('aria-expanded', 'true');
  await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toContainText(
    'playground',
  );
  const height = await page
    .locator('#folders button')
    .first()
    .evaluate((b) => b.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
  const open = await boxOf(page, '#side');
  const above = {
    x: 0,
    y: header.y + header.height,
    width,
    height: open.y - header.y - header.height,
  };
  await expect
    .poll(() => treeUnder(page, above), { message: 'tree above the open sheet' })
    .toBeGreaterThan(0.025);

  await page.getByRole('button', { name: 'Clear selection' }).first().tap();
  await expect(page.locator('#sheet-title')).toHaveText('Folders and leaf colors');
});

const legendEntry = (page: Page, name: string) =>
  page.locator('#legend').getByRole('button', { name: new RegExp(`^${name}\\b`) });

/** On a phone the legend waits in the sheet, so this opens it. */
async function openLegend(page: Page) {
  const sheet = page.locator('#sheet-toggle');
  if ((await sheet.isVisible()) && (await sheet.getAttribute('aria-expanded')) === 'false') {
    await sheet.click();
  }
}

/** The share of the page that is unfaded tree, with every panel and label made see-through. */
async function treeShare(page: Page) {
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

test('a legend color highlights only its leaves until clicked again', async ({ page }) => {
  // Without the island, which never fades, the share counts only bark and leaves.
  await page.addInitScript(() =>
    localStorage.setItem(
      'repo-tree:settings',
      JSON.stringify({ quality: 'low', spin: false, ground: false }),
    ),
  );
  await page.goto('./#/vitejs/vite?colorBy=language');
  await ready(page, 'vitejs/vite');
  await openLegend(page);
  const typescript = legendEntry(page, 'TypeScript');
  await expect(typescript).toHaveAttribute('aria-pressed', 'false');
  const whole = await treeShare(page);

  await typescript.click();
  await expect(typescript).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#legend-note')).toHaveText(/^TypeScript · [\d,]+ files$/);
  await expect(page).toHaveURL(/&hl=TypeScript$/);
  const lit = await treeShare(page);
  expect(lit, 'TypeScript leaves stay in color').toBeGreaterThan(whole * 0.05);
  expect(lit, 'bark and other leaves fade').toBeLessThan(whole * 0.6);

  await typescript.click();
  await expect(typescript).toHaveAttribute('aria-pressed', 'false');
  await expect(page).not.toHaveURL(/hl=/);
  expect(await treeShare(page), 'every leaf back in color').toBeCloseTo(whole, 2);
});

test('a shared highlight comes back, and a pinned folder replaces it', async ({ page }) => {
  await page.goto('./#/vitejs/vite?colorBy=language&hl=TypeScript');
  await ready(page, 'vitejs/vite');
  await openLegend(page);
  await expect(legendEntry(page, 'TypeScript')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#legend-note')).toHaveText(/^TypeScript · /);
  await expect(page).toHaveURL(/&hl=TypeScript$/);

  await page.locator('#folders button[data-folder]').first().click();
  await expect(legendEntry(page, 'TypeScript')).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/&sel=[^&]+$/);

  await legendEntry(page, 'JavaScript').click();
  await expect(legendEntry(page, 'JavaScript')).toHaveAttribute('aria-pressed', 'true');
  await expect(detail(page)).toBeHidden();
  await expect(page).toHaveURL(/&hl=JavaScript$/);
  await page.keyboard.press('Escape');
  await expect(legendEntry(page, 'JavaScript')).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/colorBy=language$/);

  await page.evaluate(() => (location.hash = '#/vitejs/vite?colorBy=language&hl=Cobol'));
  await expect(page.locator('#legend button[aria-pressed="true"]')).toHaveCount(0);
  await expect(page).toHaveURL(/colorBy=language$/);
});

test('the orbit hint fades after the first drag and stays gone', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the hint only shows on desktop');
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const hint = page.getByText('Drag to orbit');
  await expect(hint).toBeVisible();
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.width / 2, box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.width / 2 + 60, box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(hint).toBeHidden();
  await page.reload();
  await ready(page, 'vitejs/vite');
  await expect(hint).toBeHidden();
});

test('on a phone, focusing a text field does not zoom the page', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'iOS zooms into fields under 16px on phones');
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll('input')]
      .filter((el) => !['checkbox', 'range', 'radio'].includes(el.type))
      .map((el) => [el.id || el.name || el.type, parseFloat(getComputedStyle(el).fontSize)]),
  );
  // The repo field is always there; dialogs add theirs only when open.
  expect(sizes.map(([id]) => id)).toContain('repo-input');
  for (const [id, size] of sizes) expect(size, String(id)).toBeGreaterThanOrEqual(16);
  await page.locator('#search-open').click();
  const search = page.getByRole('combobox', { name: 'Search folders and files' });
  expect(
    await search.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
});

test('a tapped suggestion loads its repo even when tapping does not focus buttons', async ({
  page,
}) => {
  // iOS Safari: pressing a button blurs the focused field but focuses nothing, so the field's
  // focusout has no related target. Emulate that default for any press nobody prevented.
  await page.addInitScript(() =>
    addEventListener('mousedown', (event) => {
      const target = event.target as Element;
      if (event.defaultPrevented || !target.closest('button')) return;
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
    }),
  );
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const input = page.getByLabel('GitHub repository');
  await input.click();
  const row = page.locator('#suggest button', { hasText: 'torvalds/linux' });
  await expect(row).toBeVisible();
  await row.click();
  await ready(page, 'torvalds/linux');
  await expect(page.locator('#suggest')).toBeHidden();
});

test('Grow with an empty field offers the list instead of an error', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await page.getByRole('button', { name: 'Grow', exact: true }).click();
  await expect(page.locator('#suggest')).toBeVisible();
  await expect(page.getByLabel('GitHub repository')).toBeFocused();
  await expect(page.locator('#repo-error')).toBeEmpty();
});
