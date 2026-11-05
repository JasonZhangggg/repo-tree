import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { quietSettings, ready } from './github';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page, isMobile }) => {
  errors = [];
  test.skip(!isMobile, 'the bottom sheet is phone layout');
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
  await page.goto('./');
  await ready(page, 'vitejs/vite');
});
test.afterEach(() => expect(errors).toEqual([]));

/**
 * Drags one finger from `y0` to `y1` through the browser's touch input, so touch-action and
 * native scrolling apply. Event times are set explicitly, `ms` apart, plus `hold` ms still
 * before lifting: a software GL makes each real input step slow, which would read as a slow drag.
 */
async function swipe(
  cdp: CDPSession,
  x: number,
  y0: number,
  y1: number,
  { steps = 12, ms = 16, hold = 0 } = {},
) {
  let at = Date.now() / 1000;
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', y?: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      timestamp: at,
      touchPoints: y === undefined ? [] : [{ x, y }],
    });
  await send('touchStart', y0);
  for (let i = 1; i <= steps; i++) {
    at += ms / 1000;
    await send('touchMove', y0 + ((y1 - y0) * i) / steps);
  }
  at += (ms + hold) / 1000;
  await send('touchEnd');
}

const sheet = (page: Page) => page.locator('#sheet-toggle');
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.y };
};

test('swiping the handle up opens the sheet and down closes it', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const handle = await center(page, '#sheet-toggle');
  await swipe(cdp, handle.x, handle.y, handle.y - 320, { hold: 200 });
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#folders')).toBeVisible();

  const open = await center(page, '#sheet-toggle');
  await swipe(cdp, open.x, open.y, open.y + 320, { hold: 200 });
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#folders')).toBeHidden();
});

test('a short slow drag springs back, a short flick switches', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const handle = await center(page, '#sheet-toggle');
  await swipe(cdp, handle.x, handle.y, handle.y - 40, { steps: 6, ms: 40, hold: 200 });
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#side')).not.toHaveAttribute('data-dragging');

  await swipe(cdp, handle.x, handle.y, handle.y - 40, { steps: 3, ms: 12 });
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'true');

  const open = await center(page, '#sheet-toggle');
  await swipe(cdp, open.x, open.y, open.y + 40, { steps: 3, ms: 12 });
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'false');
});

test('a tap on the handle still toggles the sheet', async ({ page }) => {
  await sheet(page).tap();
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'true');
  await sheet(page).tap();
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'false');
});

test('the open sheet scrolls its content, and closes from it only at the top', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await sheet(page).tap();
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'true');
  const body = page.locator('#side-body');
  const scrollTop = () => body.evaluate((el) => el.scrollTop);
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const { x, top } = await center(page, '#side-body');

  await swipe(cdp, x, top + 220, top + 40, { ms: 30, hold: 200 });
  await expect.poll(scrollTop, { message: 'content scrolled' }).toBeGreaterThan(40);
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'true');

  await swipe(cdp, x, top + 40, top + 260, { ms: 30, hold: 200 });
  await expect.poll(scrollTop, { message: 'content scrolled back' }).toBe(0);
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'true');

  await swipe(cdp, x, top + 40, top + 300, { ms: 30, hold: 200 });
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'false');
});

test('Settings opens as a drawer from the bottom, with a tab to drag or tap it closed', async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  const settings = page.locator('#settings');
  const opener = page.getByRole('button', { name: 'Settings' });
  await opener.tap();
  await expect(settings).toBeVisible();
  // Flush with the bottom and both sides once it has slid up, its tab centered on top.
  const { width, height } = page.viewportSize()!;
  await expect
    .poll(async () => {
      const b = (await settings.boundingBox())!;
      return Math.round(b.y + b.height);
    })
    .toBe(height);
  const box = (await settings.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(width);
  const tab = page.locator('.settings-grip');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAccessibleName('Close settings');
  const grip = (await tab.locator('.grip').boundingBox())!;
  expect(Math.abs(grip.x + grip.width / 2 - width / 2)).toBeLessThan(2);
  expect(grip.y - box.y).toBeLessThan(20);

  // A short slow drag springs back; a longer one closes it.
  const at = await center(page, '.settings-grip');
  await swipe(cdp, at.x, at.y, at.y + 40, { steps: 6, ms: 40, hold: 200 });
  await expect(settings).toBeVisible();
  await expect(settings).not.toHaveAttribute('data-dragging');
  await swipe(cdp, at.x, at.y, at.y + 260, { hold: 200 });
  await expect(settings).toBeHidden();
  await expect(opener).toHaveAttribute('aria-expanded', 'false');

  // A tap on the tab closes it too.
  await opener.tap();
  await expect(settings).toBeVisible();
  await tab.tap();
  await expect(settings).toBeHidden();
});

test('the phone row keeps five buttons, Dark mode left of Search, and a short menu sits behind More actions', async ({
  page,
}) => {
  const row = page.locator('.controls > button:visible, .controls .tools button:visible');
  await expect(row).toHaveCount(5);
  const theme = (await page.getByRole('button', { name: 'Dark mode' }).boundingBox())!;
  const search = (await page.locator('#search-open').boundingBox())!;
  expect(theme.x + theme.width, 'Dark mode sits left of Search').toBeLessThanOrEqual(search.x);
  expect(theme.width).toBe(search.width);
  const more = page.getByRole('button', { name: 'More actions' });
  const menu = page.getByRole('group', { name: 'More actions' });
  await expect(menu).toBeHidden();

  await more.tap();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  for (const name of [/Copy link/, 'Export PNG'])
    await expect(menu.getByRole('button', { name })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/vitejs/vite',
  );
  // Spin is a switch in Settings; Grow again is for a desktop.
  for (const name of ['Grow again', 'Spin'])
    await expect(page.getByRole('button', { name })).toBeHidden();

  await menu.getByRole('button', { name: /Copy link/ }).tap();
  await expect(menu).toBeHidden();

  await more.tap();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await more.tap();
  await page.locator('#view').tap({ position: { x: 40, y: 300 } });
  await expect(menu).toBeHidden();
});

test('the drawer bar picks Color leaves by, collapsed or open', async ({ page }) => {
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'false');
  const field = page.locator('#quick-color-pick');
  await expect(field).toBeVisible();
  await expect(field).toHaveAccessibleName('Color leaves by: Language');
  const box = (await field.boundingBox())!;
  const bar = (await sheet(page).boundingBox())!;
  expect(box.y + box.height, 'in the bar').toBeLessThanOrEqual(bar.y + bar.height);

  await field.tap();
  const menu = page.locator('#quick').getByRole('radiogroup', { name: 'Color leaves by' });
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.y + menuBox.height, 'opens upward').toBeLessThanOrEqual(box.y);
  await menu.getByRole('radio', { name: /Folder/ }).tap();
  await expect(menu).toBeHidden();
  await expect(field).toHaveAccessibleName('Color leaves by: Folder');
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'false');

  await sheet(page).tap();
  await expect(sheet(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(field).toBeVisible();
  await expect(field).toHaveAccessibleName('Color leaves by: Folder');
  await expect(page.locator('#side-color-pick'), 'no second picker below').toBeHidden();
  const title = (await page.locator('#sheet-title').boundingBox())!;
  const open = (await field.boundingBox())!;
  expect(
    Math.abs(title.y + title.height / 2 - (open.y + open.height / 2)),
    'side by side',
  ).toBeLessThan(16);
});
