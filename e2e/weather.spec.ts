import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo, serveRuns } from './github';
import { settle } from './view';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const chip = (page: Page) => page.locator('#weather');

async function enterRepo(page: Page, text: string) {
  await page.getByLabel('GitHub repository').fill(text);
  await page.getByLabel('GitHub repository').press('Enter');
}

/** Mean luma, 0 to 1, of the sky in a strip below the island that no panel covers on a desktop. */
async function skyLuma(page: Page): Promise<number> {
  await settle(page);
  const viewport = page.viewportSize()!;
  const png = await page.screenshot({
    clip: { x: viewport.width / 2 - 40, y: viewport.height - 110, width: 80, height: 30 },
  });
  return page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) / 255;
    }
    return sum / (data.length / 4);
  }, png.toString('base64'));
}

const CASES = [
  {
    repo: 'acme/sunny',
    runs: '.'.repeat(20),
    sky: 'sunny',
    label: 'CI passing, 20 of 20 recent runs',
  },
  {
    repo: 'acme/cloudy',
    runs: '..x' + '.'.repeat(17),
    sky: 'cloudy',
    label: 'CI mostly passing, 19 of 20 recent runs',
  },
  {
    repo: 'acme/rain',
    runs: 'x' + '.'.repeat(19),
    sky: 'rain',
    label: 'CI failing, last run failed 2 hours ago',
  },
  {
    repo: 'acme/storm',
    runs: 'xxxx' + '.'.repeat(16),
    sky: 'storm',
    label: 'CI failing, last 4 runs failed',
  },
  { repo: 'acme/quiet', runs: '', sky: 'clear', label: 'No recent CI runs' },
] as const;

test('the sky follows each repo’s recent Actions runs, darker as CI breaks', async ({
  page,
  isMobile,
}) => {
  for (const { repo, runs } of CASES) {
    await serveRepo(page, repo);
    await serveRuns(page, repo, runs);
  }
  await page.goto('./');
  await ready(page, 'vitejs/vite');

  const luma: Record<string, number> = {};
  for (const { repo, sky, label } of CASES) {
    await enterRepo(page, repo);
    await ready(page, repo);
    await expect(chip(page)).toHaveAttribute('data-sky', sky);
    await expect(chip(page)).toHaveAttribute('aria-label', label);
    if (sky !== 'clear') {
      await expect(chip(page)).toHaveAttribute(
        'href',
        `https://github.com/${repo}/actions?query=branch%3Amain`,
      );
    }
    if (!isMobile) luma[sky] = await skyLuma(page);
  }
  if (!isMobile) {
    expect(luma.storm!, 'storm under rain').toBeLessThan(luma.rain! - 0.05);
    expect(luma.rain!, 'rain under partly cloudy').toBeLessThan(luma.cloudy! - 0.05);
    expect(luma.cloudy!, 'partly cloudy under clear').toBeLessThan(luma.clear!);
  }
});

test('a rate-limited Actions API leaves the tree and shows no weather', async ({ page }) => {
  await serveRepo(page, 'acme/limited-ci');
  await serveRuns(page, 'acme/limited-ci', '', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
  });
  await page.goto('./#/acme/limited-ci');
  await ready(page, 'acme/limited-ci');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme/limited-ci');
  await expect(page.locator('#status')).toBeEmpty();
  await expect(chip(page)).toBeHidden();
});

test('bundled samples carry their own weather, and a link can preview any', async ({ page }) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(chip(page)).toHaveAttribute('aria-label', 'CI passing, 20 of 20 recent runs');

  await page.goto('./#/torvalds/linux');
  await ready(page, 'torvalds/linux');
  await expect(chip(page)).toHaveAttribute('aria-label', 'No recent CI runs');

  await page.goto('./#/vitejs/vite?wx=storm');
  await ready(page, 'vitejs/vite');
  await expect(chip(page)).toHaveAttribute('aria-label', 'Weather preview, storm');
  await expect(chip(page)).not.toHaveAttribute('href');
  await expect(page).toHaveURL(/&wx=storm$/);
});

test('a sample shows its live CI when GitHub answers, and its bundled runs when not', async ({
  page,
}) => {
  await serveRuns(page, 'torvalds/linux', 'x' + '.'.repeat(19), { branch: 'master' });
  await page.goto('./#/torvalds/linux');
  await ready(page, 'torvalds/linux');
  await expect(chip(page)).toHaveAttribute('data-sky', 'rain');
  await expect(chip(page)).toHaveAttribute('aria-label', 'CI failing, last run failed 2 hours ago');
});

test('turning weather off in settings clears the sky and survives a reload', async ({
  page,
  isMobile,
}) => {
  await page.goto('./#/vitejs/vite?wx=rain');
  await ready(page, 'vitejs/vite');
  const rain = isMobile ? 0 : await skyLuma(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const weather = page.getByRole('switch', { name: /^Weather/ });
  await expect(weather).toBeChecked();
  await weather.click();
  await expect(weather).not.toBeChecked();
  await expect(chip(page)).toBeHidden();
  if (!isMobile)
    expect(await skyLuma(page), 'the plain sky is lighter').toBeGreaterThan(rain + 0.1);
  const stored = () => page.evaluate(() => localStorage.getItem('repo-tree:settings'));
  expect(JSON.parse((await stored())!)).toMatchObject({ weather: false });

  await page.reload();
  await ready(page, 'vitejs/vite');
  await expect(chip(page)).toBeHidden();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('switch', { name: /^Weather/ })).not.toBeChecked();
});

test.describe('with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the sun and clouds in the scene keep moving, and a clear sky rests', async ({ page }) => {
    type Stats = { renders: number; calls: number };
    const stats = () =>
      page.evaluate(() =>
        (window as unknown as { __repoTree: { view: { stats(): Stats } } }).__repoTree.view.stats(),
      );
    await page.goto('./?visit=clear#/vitejs/vite?wx=clear');
    await ready(page, 'vitejs/vite');
    await settle(page);
    const clear = await stats();

    await page.goto('./?visit=cloudy#/vitejs/vite?wx=cloudy');
    await ready(page, 'vitejs/vite');
    const before = await stats();
    await page.waitForTimeout(1500);
    const after = await stats();
    expect(
      after.renders - before.renders,
      'spin is off, so only the weather renders',
    ).toBeGreaterThan(2);
    expect(after.calls, 'the sun and the clouds draw in the scene').toBe(clear.calls + 2);
  });
});
