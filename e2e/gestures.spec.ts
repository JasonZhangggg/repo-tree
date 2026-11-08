import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { quietSettings, ready } from './github';

// Throws and spring backs are motion, so they run only where motion is allowed.
test.use({ reducedMotion: 'no-preference' });

let errors: string[];
test.beforeEach(async ({ page, isMobile }) => {
  errors = [];
  test.skip(isMobile, 'a mouse drags and wheels here; the phone sheets have sheet.spec');
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await still(page);
});
test.afterEach(() => expect(errors).toEqual([]));

type Stats = { distance: number; azimuth: number };
const stats = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __repoTree: { view: { stats(): Stats } } }).__repoTree.view.stats(),
  );
/**
 * Waits until the camera stops moving. With motion allowed the breeze keeps the view rendering,
 * so this watches the camera across rendered frames rather than waiting for none: on a software
 * GL a single frame can outlast any fixed wait.
 */
async function still(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          type View = { stats(): Stats & { renders: number } };
          const { view } = (window as unknown as { __repoTree: { view: View } }).__repoTree;
          const before = view.stats();
          // Reduced motion renders nothing once still, so a quiet second counts as still too.
          const until = performance.now() + 1000;
          while (view.stats().renders < before.renders + 4 && performance.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
          const after = view.stats();
          return (
            Math.abs(after.azimuth - before.azimuth) + Math.abs(after.distance - before.distance)
          );
        }),
      { message: 'the camera comes to rest', timeout: 30_000 },
    )
    .toBeLessThan(1e-5);
}

/** How far the camera has turned from `from`, in radians, the short way round. */
const turned = (from: number, to: number) =>
  Math.abs(Math.atan2(Math.sin(to - from), Math.cos(to - from)));

/**
 * Drags the mouse `dx` px across the middle of the view in `steps` moves `ms` apart, then holds
 * still `hold` ms and lets go. Event times are explicit, so a slow software GL frame between
 * moves does not read as a slow drag.
 */
async function drag(
  page: Page,
  cdp: CDPSession,
  dx: number,
  { steps = 8, ms = 16, hold = 0 } = {},
) {
  const box = (await page.locator('#view').boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  let at = Date.now() / 1000;
  const send = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', to: number) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x: to,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      timestamp: at,
    });
  await send('mousePressed', x);
  for (let i = 1; i <= steps; i++) {
    at += ms / 1000;
    await send('mouseMoved', x + (dx * i) / steps);
  }
  at += (ms + hold) / 1000;
  await send('mouseReleased', x + dx);
}

test('a flicked tree keeps turning after the mouse lets go, then comes to rest', async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, 90);
  const released = (await stats(page)).azimuth;
  await still(page);
  expect(turned(released, (await stats(page)).azimuth)).toBeGreaterThan(0.3);
});

test('a drag held still before letting go stays where it was put', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, 90, { steps: 10, ms: 40, hold: 250 });
  const released = (await stats(page)).azimuth;
  await still(page);
  expect(turned(released, (await stats(page)).azimuth)).toBeLessThan(0.01);
});

test('zooming past the nearest view gives a little and springs back', async ({ page }) => {
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -120);
  await still(page);
  const nearest = (await stats(page)).distance;
  // The nearest distance the camera reaches, read every frame: the give can come and go
  // between two reads from here.
  await page.evaluate(() => {
    const w = window as unknown as {
      __repoTree: { view: { stats(): Stats } };
      closest: number;
    };
    w.closest = Infinity;
    const read = () => {
      w.closest = Math.min(w.closest, w.__repoTree.view.stats().distance);
      requestAnimationFrame(read);
    };
    read();
  });
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120);
  await still(page);
  const closest = await page.evaluate(() => (window as unknown as { closest: number }).closest);
  expect(closest, 'gives past the nearest').toBeLessThan(nearest * 0.97);
  expect((await stats(page)).distance, 'springs back to it').toBeCloseTo(nearest, 3);
});

test('with reduced motion a flick stops where the mouse lets go', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, 90);
  const released = (await stats(page)).azimuth;
  await still(page);
  expect(turned(released, (await stats(page)).azimuth)).toBeLessThan(0.01);
});
