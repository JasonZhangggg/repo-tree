import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo, serveRuns } from './github';
import { openRepoField, settle } from './view';

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
  await openRepoField(page);
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

test('a rate-limited Actions API leaves the tree, says CI is unavailable, and a tap asks again', async ({
  page,
}) => {
  await serveRepo(page, 'acme/limited-ci');
  await serveRuns(page, 'acme/limited-ci', '', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
  });
  await page.goto('./#/acme/limited-ci');
  await ready(page, 'acme/limited-ci');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme/limited-ci');
  await expect(page.locator('#status')).toBeEmpty();
  // No sky, but the chip says why rather than nothing.
  await expect(chip(page)).toHaveAttribute('data-sky', 'unknown');
  await expect(page.getByRole('button', { name: 'CI unavailable, try again' })).toBeVisible();
  await expect(chip(page)).not.toHaveAttribute('href');

  // The limit resets: a tap reads the runs again, and the weather comes.
  await page.unroute((url) =>
    url.href.startsWith('https://api.github.com/repos/acme/limited-ci/actions/runs?'),
  );
  await serveRuns(page, 'acme/limited-ci', 'x' + '.'.repeat(19));
  await page.getByRole('button', { name: 'CI unavailable, try again' }).click();
  await expect(chip(page)).toHaveAttribute('data-sky', 'rain');
  await expect(chip(page)).toHaveAttribute('href', /actions/);
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

test('a sample reloaded live keeps its bundled weather when GitHub refuses its runs', async ({
  page,
}) => {
  await serveRepo(page, 'vitejs/vite', 'vitejs-vite');
  await serveRuns(page, 'vitejs/vite', '', { status: 403 });
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(chip(page)).toHaveAttribute('aria-label', 'CI passing, 20 of 20 recent runs');
  await page.getByRole('button', { name: 'Reload from GitHub' }).click();
  await expect(page.locator('#repo-meta [title^="Bundled with the app"]')).toHaveCount(0);
  await ready(page, 'vitejs/vite');
  await expect(chip(page)).toHaveAttribute('aria-label', 'CI passing, 20 of 20 recent runs');
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

  test('the sun and clouds in the scene keep moving', async ({ page }) => {
    type Stats = { renders: number; calls: number };
    const stats = () =>
      page.evaluate(() =>
        (window as unknown as { __repoTree: { view: { stats(): Stats } } }).__repoTree.view.stats(),
      );
    await page.goto('./?visit=clear#/vitejs/vite?wx=clear');
    await ready(page, 'vitejs/vite');
    // With motion allowed the breeze keeps the scene drawing, so a clear sky never comes to rest.
    await page.waitForTimeout(1500);
    const clear = await stats();

    await page.goto('./?visit=cloudy#/vitejs/vite?wx=cloudy');
    await ready(page, 'vitejs/vite');
    const before = await stats();
    await page.waitForTimeout(1500);
    const after = await stats();
    expect(after.renders - before.renders, 'the scene keeps drawing').toBeGreaterThan(2);
    expect(after.calls, 'the sun and the clouds draw in the scene').toBe(clear.calls + 2);
  });
});

test('a tap on the sun says what the sky stands for before leaving for CI', async ({
  page,
  isMobile,
}) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await settle(page);
  // Somewhere on the sun or a cloud and off the tree.
  const spot = await page.evaluate(() => {
    type View = {
      skyAt(x: number, y: number): boolean;
      pickAt(x: number, y: number): unknown;
    };
    const { view } = (window as unknown as { __repoTree: { view: View } }).__repoTree;
    const box = document.querySelector('#view')!.getBoundingClientRect();
    for (let y = 0; y < box.height; y += 8)
      for (let x = 0; x < box.width; x += 8)
        if (view.skyAt(x, y) && view.pickAt(x, y) === null) {
          const hit = document.elementFromPoint(box.x + x, box.y + y);
          if (hit?.closest('#view')) return { x: box.x + x, y: box.y + y };
        }
    return null;
  });
  expect(spot, 'the sun is on screen').not.toBeNull();
  // A real tap on a phone: the click that ends it must not land on the card's scrim and close it.
  if (isMobile) await page.touchscreen.tap(spot!.x, spot!.y);
  else await page.mouse.click(spot!.x, spot!.y);
  const card = page.getByRole('dialog', { name: 'CI passing' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('20 of 20 recent runs');
  await expect(card).toContainText('Opens GitHub in a new tab');
  await expect(card.getByRole('link', { name: 'Open GitHub Actions' })).toHaveAttribute(
    'href',
    /github\.com\/vitejs\/vite\/actions/,
  );
  // Nothing was pinned by the tap.
  await expect(page.getByRole('article', { name: /Pinned folder/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  // The chip opens the same card rather than leaving at once.
  await chip(page).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toBeHidden();
});

test('dark mode turns the sky to night and the panels dark, keeping the leaf colors', async ({
  page,
  isMobile,
}) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const legend = () =>
    page.evaluate(() =>
      (
        window as unknown as { __repoTree: { view: { legend(): { color: string }[] } } }
      ).__repoTree.view
        .legend()
        .map((e) => e.color),
    );
  const colors = await legend();
  const day = isMobile ? 0 : await skyLuma(page);
  /** The theme button on a desktop; on a phone, the Dark mode switch in Settings. */
  const toggle = async (name: string) => {
    if (!isMobile) return page.getByRole('button', { name }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('switch', { name: 'Dark mode' }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
  };

  await toggle('Dark mode');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  if (!isMobile) await expect(page.locator('#theme')).toHaveAttribute('aria-label', 'Light mode');
  const stored = await page.evaluate(() => localStorage.getItem('repo-tree:settings'));
  expect(JSON.parse(stored ?? '{}').theme).toBe('dark');
  if (!isMobile) expect(await skyLuma(page), 'the night sky is dark').toBeLessThan(day - 0.4);
  // Panels ease to their dark fill.
  await expect
    .poll(() => page.locator('.title').evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toMatch(/^rgba?\(25[0-5], 25[0-5], 25[0-5]/);
  expect(await legend(), 'leaf colors stay the palette’s').toEqual(colors);

  await page.reload();
  await ready(page, 'vitejs/vite');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await toggle('Light mode');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
