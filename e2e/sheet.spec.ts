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

test('the phone row keeps four buttons and a short menu sits behind More actions', async ({
  page,
}) => {
  const row = page.locator('.controls > button:visible, .controls .tools button:visible');
  await expect(row).toHaveCount(4);
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
  // Spin and Dark mode are switches in Settings; Grow again is for a desktop.
  // (The drawer's quick switches carry the same names; this is about the row.)
  for (const name of ['Grow again', 'Spin', 'Dark mode'])
    await expect(page.locator('.controls').getByRole('button', { name })).toBeHidden();

  await menu.getByRole('button', { name: /Copy link/ }).tap();
  await expect(menu).toBeHidden();

  await more.tap();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await more.tap();
  await page.locator('#view').tap({ position: { x: 40, y: 300 } });
  await expect(menu).toBeHidden();
});

test('the collapsed drawer holds quick switches for Dark mode and Spin', async ({ page }) => {
  await expect(page.locator('#sheet-toggle')).toHaveAttribute('aria-expanded', 'false');
  const quick = page.getByRole('group', { name: 'Quick settings' });
  await expect(quick).toBeVisible();
  const dark = quick.getByRole('button', { name: 'Dark mode' });
  await expect(dark).toHaveAttribute('aria-pressed', 'false');
  await dark.tap();
  await expect(dark).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await dark.tap();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const spin = quick.getByRole('button', { name: 'Spin' });
  const before = await spin.getAttribute('aria-pressed');
  await spin.tap();
  await expect(spin).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
});
