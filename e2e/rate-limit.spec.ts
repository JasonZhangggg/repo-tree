import { expect, test } from '@playwright/test';
import { quietSettings, ready, serveRateLimit } from './github';

test.use({ reducedMotion: 'reduce' });

test('Settings says how many GitHub requests are left this hour, and whose they are', async ({
  page,
}) => {
  await quietSettings(page);
  const asked: (string | undefined)[] = [];
  page.on('request', (req) => {
    if (req.url() === 'https://api.github.com/rate_limit') asked.push(req.headers().authorization);
  });
  await serveRateLimit(page, 37, 60);
  await page.goto('./');
  await ready(page, 'vitejs/vite');

  await page.getByRole('button', { name: 'Settings' }).click();
  const left = page.locator('#rate-left');
  await expect(left).toHaveText(/^37 of 60 left, resets at \d{1,2}:\d{2}/);
  await expect(page.locator('#rate-field')).toContainText('Shared with everyone on your network');
  expect(asked).toEqual([undefined]);

  // A pasted token has its own budget, and the line asks again with it.
  await serveRateLimit(page, 4999, 5000);
  await page.getByLabel('GitHub token').fill('ghp_test');
  await page.getByLabel('GitHub token').press('Enter');
  await expect(left).toHaveText(/^4,999 of 5,000 left/);
  await expect(page.locator('#rate-field')).toContainText('Your token’s own budget.');
  expect(asked.at(-1)).toBe('Bearer ghp_test');
});

test('Settings says when GitHub does not answer', async ({ page }) => {
  await quietSettings(page);
  await page.route('https://api.github.com/rate_limit', (route) => route.fulfill({ status: 500 }));
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#rate-left')).toHaveText(/GitHub didn’t answer/);
});
