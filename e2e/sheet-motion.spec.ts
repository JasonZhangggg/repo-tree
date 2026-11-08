import { expect, test } from '@playwright/test';
import { quietSettings, ready } from './github';

// With motion allowed, the phone's sheets slide rather than jump, and the slides never strand them.
test.use({ reducedMotion: 'no-preference' });

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the sheets are a phone layout');
  await quietSettings(page);
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
});

test('a tap slides the side sheet open and shut, and a second tap mid-slide turns it back', async ({
  page,
}) => {
  const side = page.locator('#side');
  const toggle = page.locator('#sheet-toggle');
  await toggle.click();
  await expect(side).toHaveAttribute('data-open', '');
  await expect.poll(() => side.evaluate((el) => el.getAnimations().length)).toBe(0);

  await toggle.click();
  await expect(side).not.toHaveAttribute('data-open', '');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  // Mid-slide the bar is still moving, so skip the wait for it to settle.
  await toggle.click({ force: true });
  await expect.poll(() => side.evaluate((el) => el.getAnimations().length)).toBe(0);
  await expect(side).not.toHaveAttribute('data-open', '');
});

test('Settings slides down when closed by its X, and opens again at once', async ({ page }) => {
  const settings = page.locator('#settings');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(settings).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(settings).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(settings).toBeVisible();
  await expect(settings).toHaveCSS('transform', 'none');
});
