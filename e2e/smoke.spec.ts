import { expect, test } from '@playwright/test';

test('built page renders a non-blank canvas without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('./');
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  const png = await canvas.screenshot();
  const drawnShare = await page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let differing = 0;
    for (let i = 0; i < data.length; i += 4) {
      const delta =
        Math.abs(data[i]! - data[0]!) +
        Math.abs(data[i + 1]! - data[1]!) +
        Math.abs(data[i + 2]! - data[2]!);
      if (delta > 24) differing++;
    }
    return differing / (data.length / 4);
  }, png.toString('base64'));

  expect(drawnShare, 'share of pixels that differ from the background corner').toBeGreaterThan(
    0.05,
  );
  expect(errors).toEqual([]);
});
