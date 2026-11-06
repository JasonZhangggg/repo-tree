import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';
import { chooseAction } from './view';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const scrubber = (page: Page) => page.getByRole('group', { name: 'Timeline' });
const timelineButton = (page: Page) => page.locator('#timeline');
const date = (page: Page) => page.locator('#timeline-date');
const files = (page: Page) => page.locator('#timeline-files');
const fileCount = async (page: Page) =>
  Number((await files(page).textContent())!.replace(/\D/g, ''));

/** Clicks the scrubber's track at a fraction of its width, as a tap or a short drag would. */
async function scrubTo(page: Page, at: number) {
  const range = page.getByRole('slider', { name: 'Timeline position' });
  const box = (await range.boundingBox())!;
  // The thumb is wider on a phone; its centre travels from half a thumb to width minus half.
  const thumb =
    (await page
      .locator('#scrubber')
      .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--thumb')))) / 2;
  await range.click({ position: { x: thumb + at * (box.width - 2 * thumb), y: box.height / 2 } });
}

type Debug = {
  __repoTree: { labels: { path: string; x: number; y: number }[]; hovered: string | null };
};

test('the Timeline button opens a scrubber on the whole tree, and closes it', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(scrubber(page)).toBeHidden();
  await timelineButton(page).click();

  await expect(scrubber(page)).toBeVisible();
  await expect(timelineButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(date(page)).toHaveText(/^Nov 2026$/);
  await expect(files(page)).toHaveText('2,898 files');
  await expect(page.getByRole('button', { name: 'Play timeline' })).toBeVisible();
  await expect(page).toHaveURL(/&t=2026-11-0\d$/);

  await page.getByRole('button', { name: 'Close timeline' }).click();
  await expect(scrubber(page)).toBeHidden();
  await expect(page).not.toHaveURL(/t=/);
});

test('dragging back in time shows fewer files on an earlier date', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await timelineButton(page).click();
  await expect(files(page)).toHaveText('2,898 files');

  await scrubTo(page, 0.3);
  await expect(date(page)).not.toHaveText('Nov 2026');
  const year = Number((await date(page).textContent())!.slice(-4));
  expect(year).toBeGreaterThanOrEqual(2021);
  expect(year).toBeLessThanOrEqual(2023);
  const mid = await fileCount(page);
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(2898);

  await scrubTo(page, 0.05);
  const early = await fileCount(page);
  expect(early).toBeLessThan(mid);
  await expect(date(page)).toHaveText(/2020$/);
  await expect(page).toHaveURL(/&t=2020-\d\d-\d\d$/);
});

test('play runs time forward and pause holds it', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await timelineButton(page).click();
  await scrubTo(page, 0);
  await expect(files(page)).toHaveText('0 files');

  await page.getByRole('button', { name: 'Play timeline' }).click();
  await expect(page.getByRole('button', { name: 'Pause timeline' })).toBeVisible();
  await expect.poll(() => fileCount(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause timeline' }).click();
  await expect(page.getByRole('button', { name: 'Play timeline' })).toBeVisible();
  const held = await files(page).textContent();
  const when = await date(page).textContent();
  await page.waitForTimeout(600);
  await expect(files(page)).toHaveText(held!);
  await expect(date(page)).toHaveText(when!);
  await expect(page).toHaveURL(/&t=\d{4}-\d\d-\d\d$/);
});

test('a shared link restores the timeline at its date', async ({ page, context }) => {
  await page.goto('./#/vitejs/vite?t=2022-06-15');
  await ready(page, 'vitejs/vite');
  await expect(scrubber(page)).toBeVisible();
  await expect(date(page)).toHaveText('Jun 2022');
  const count = await fileCount(page);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(2898);
  await expect(page).toHaveURL(/&t=2022-06-15$/);
  const playground = page.locator('#labels .pill', { hasText: 'playground' }).locator('b');
  await expect(playground).not.toHaveText('1,859');
  expect(Number((await playground.textContent())!.replace(/\D/g, ''))).toBeGreaterThan(0);

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await chooseAction(page, /Copy link/);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const other = await context.newPage();
  other.on('pageerror', (err) => errors.push(err.message));
  await other.goto(link);
  await ready(other, 'vitejs/vite');
  await expect(date(other)).toHaveText('Jun 2022');
  await expect(files(other)).toHaveText(`${count.toLocaleString('en-US')} files`);
});

test('exporting a PNG mid-timeline names its date', async ({ page }) => {
  await page.goto('./#/vitejs/vite?t=2022-06-15');
  await ready(page, 'vitejs/vite');
  await expect(date(page)).toHaveText('Jun 2022');
  const download = page.waitForEvent('download');
  await chooseAction(page, 'Export PNG');
  expect((await download).suggestedFilename()).toBe('vitejs-vite-tree-2022-06-15.png');
});

test('a folder that does not exist yet has no label and cannot be hovered', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'hover needs a mouse');
  const labelled = (path: string) => page.locator('#labels .pill', { hasText: path });
  const pointAt = async (path: string) => {
    // The view eases into its framing beside the panels, so wait for the label to stand still.
    const read = async () =>
      (await page.evaluate(() => (window as unknown as Debug).__repoTree.labels)).find(
        (l) => l.path === path,
      )!;
    let point = await read();
    await expect
      .poll(async () => {
        const last = point;
        await page.waitForTimeout(200);
        point = await read();
        return Math.hypot(point.x - last.x, point.y - last.y);
      })
      .toBeLessThan(2);
    return point;
  };
  const hoversNear = async ({ x, y }: { x: number; y: number }) => {
    for (const [dx, dy] of [
      [0, 0],
      [0, -4],
      [-4, 0],
      [4, 0],
      [0, 4],
      [4, 4],
      [-4, -4],
    ]) {
      await page.mouse.move(x + dx!, y + dy!);
      await page.waitForTimeout(150);
      const hovered = await page.evaluate(() => (window as unknown as Debug).__repoTree.hovered);
      if (hovered) return hovered;
    }
    return null;
  };

  await page.goto('./#/vitejs/vite?t=2026-11-03');
  await ready(page, 'vitejs/vite');
  await expect(labelled('playground')).toBeVisible();
  const playground = await pointAt('playground');
  expect(await hoversNear(playground)).toMatch(/^playground/);

  await page.mouse.move(2, 2);
  await page.goto('./#/vitejs/vite?t=2020-07-01');
  await expect(date(page)).toHaveText('Jul 2020');
  await expect(labelled('playground')).toBeHidden();
  expect(await hoversNear(await pointAt('playground'))).toBeNull();
});

test('a sample reloaded live from GitHub keeps its timeline', async ({ page }) => {
  await serveRepo(page, 'vitejs/vite', 'vitejs-vite');
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(page.locator('#repo-meta [title^="Bundled with the app"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Reload from GitHub' }).click();
  // The live tree has no "snapshot" tag; with no history shared, the bundled one stands in.
  await expect(page.locator('#repo-meta [title^="Bundled with the app"]')).toHaveCount(0);
  await ready(page, 'vitejs/vite');
  await expect(timelineButton(page)).toHaveAttribute('aria-disabled', 'false');
  await timelineButton(page).click();
  await expect(scrubber(page)).toBeVisible();
  await expect(date(page)).toHaveText(/^Nov 2026$/);
});

test('a repo with no history source shows the timeline as unavailable', async ({ page }) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/acme/widgets');
  await ready(page, 'acme/widgets');
  await expect(timelineButton(page)).toHaveAttribute('aria-disabled', 'true');
  // Still focusable and clickable, so a tap says why rather than doing nothing.
  await timelineButton(page).click({ force: true });
  await expect(page.locator('#toast')).toHaveText('History unavailable for this repo');
  // One line, even on a phone, so it covers as little of the tree as it can.
  const toast = (await page.locator('#toast').boundingBox())!;
  expect(toast.height).toBeLessThan(48);
  await expect(scrubber(page)).toBeHidden();
  await expect(timelineButton(page)).toHaveAttribute('aria-pressed', 'false');
});

test('the track holds still while the count changes, so a drag to either end never jumps', async ({
  page,
}) => {
  // Linux's early counts are lower bounds, the widest label; at 0 they shrink to `0 files`.
  await page.goto('./#/torvalds/linux');
  await ready(page, 'torvalds/linux');
  await timelineButton(page).click();
  await expect(files(page)).toHaveText('97,141 files');
  // Let the scrubber finish rising into place before measuring.
  await scrubber(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const range = page.getByRole('slider', { name: 'Timeline position' });
  const at = async () => JSON.stringify(await range.boundingBox());
  const whole = await at();
  for (const s of [0.5, 0.1, 0.03, 0, 1]) {
    await scrubTo(page, s);
    expect(await at()).toBe(whole);
  }
  await scrubTo(page, 0.1);
  await expect(files(page)).toHaveText(/^[\d,]+\+ files$/);
  await expect(range).toHaveAttribute('aria-valuetext', /, at least [\d,]+ files$/);
});

test.describe('with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('opening the timeline plays the repo from its first commit', async ({ page }) => {
    await page.goto('./');
    await ready(page, 'vitejs/vite');
    await timelineButton(page).click();
    await expect(page.getByRole('button', { name: 'Pause timeline' })).toBeVisible();
    await expect(date(page)).toHaveText(/2020|2021/);
  });

  test('a drag while playing shows the month over the thumb, then plays on', async ({ page }) => {
    await page.goto('./');
    await ready(page, 'vitejs/vite');
    await timelineButton(page).click();
    await expect(page.getByRole('button', { name: 'Pause timeline' })).toBeVisible();
    const range = page.getByRole('slider', { name: 'Timeline position' });
    const box = (await range.boundingBox())!;
    const y = box.y + box.height / 2;
    // A press anywhere on the track takes the thumb there, not only on the thumb.
    await page.mouse.move(box.x + box.width * 0.6, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 });
    const bubble = page.locator('#timeline-bubble');
    await expect(bubble).toHaveCSS('opacity', '1');
    await expect(bubble).toHaveText((await date(page).textContent())!);
    await expect(page.getByRole('button', { name: 'Play timeline' })).toBeVisible();
    const held = await date(page).textContent();
    await page.mouse.up();
    await expect(bubble).toHaveCSS('opacity', '0');
    await expect(page.getByRole('button', { name: 'Pause timeline' })).toBeVisible();
    await expect(date(page)).not.toHaveText(held!);
  });
});

test('a phone gives the track the whole width', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone layout');
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await timelineButton(page).click();
  const range = (await page.getByRole('slider', { name: 'Timeline position' }).boundingBox())!;
  const bar = (await scrubber(page).boundingBox())!;
  expect(range.width / bar.width).toBeGreaterThan(0.85);
});
