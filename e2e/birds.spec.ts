import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo, servePulls, VITE_PULLS } from './github';
import { settle } from './view';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

type Point = { x: number; y: number };
type Debug = { __repoTree: { view: { birdsOnScreen(): Point[] } } };
const litPull = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __repoTree: { litPull: number | null } }).__repoTree.litPull,
  );
const birdsOnScreen = (page: Page) =>
  page.evaluate(() => (window as unknown as Debug).__repoTree.view.birdsOnScreen());

/**
 * Taps or points at each bird until one answers (birds behind the crown are hidden by it), and
 * returns which PR number it stood for.
 */
async function touchABird(page: Page, isMobile: boolean): Promise<number> {
  await settle(page);
  const box = (await page.locator('#view').boundingBox())!;
  for (const { x, y } of await birdsOnScreen(page)) {
    const [px, py] = [box.x + x, box.y + y];
    if (isMobile) {
      await page.touchscreen.tap(px, py);
      if (await page.locator('#pr-card').isVisible()) {
        return Number(/#(\d+)/.exec((await page.locator('#pr-card .pr-meta').textContent())!)![1]);
      }
    } else {
      await page.mouse.move(px, py);
      const tip = page.locator('#tip');
      try {
        await expect(tip).toContainText(/^#\d+/, { timeout: 1500 });
      } catch {
        continue;
      }
      const number = Number(/^#(\d+)/.exec((await tip.textContent())!)![1]);
      await page.mouse.click(px, py);
      return number;
    }
  }
  throw new Error('no bird answered');
}

test('open PRs perch as birds; one says which PR it is and links to it', async ({
  page,
  isMobile,
}) => {
  await servePulls(page, 'vitejs/vite', VITE_PULLS);
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await expect.poll(async () => (await birdsOnScreen(page)).length).toBe(VITE_PULLS.length);

  const number = await touchABird(page, isMobile);
  const pull = VITE_PULLS.find((p) => p.number === number)!;
  const card = page.getByRole('dialog', { name: pull.title });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`#${pull.number} by ${pull.author}`);
  await expect(card.getByRole('link', { name: 'Open pull request' })).toHaveAttribute(
    'href',
    `https://github.com/vitejs/vite/pull/${pull.number}`,
  );
  // Its changed files light on the tree while the card is open, and go dark when it closes.
  await expect(card).toContainText(
    `The ${pull.files.length} files it changes are lit on the tree.`,
  );
  await expect.poll(() => litPull(page)).toBe(pull.number);
  await expect(card.getByRole('button', { name: 'Not now' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(card).toBeHidden();
  await expect.poll(() => litPull(page)).toBeNull();
});

test('a PR whose files are new says so on its card', async ({ page, isMobile }) => {
  const fresh = {
    number: 3001,
    title: 'Add a Marko template',
    author: 'carmen',
    files: [
      'packages/create-vite/template-marko/index.html',
      'packages/create-vite/template-marko/src/main.tsx',
      'packages/create-vite/src/index.ts',
    ],
  };
  await servePulls(page, 'vitejs/vite', [fresh]);
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await expect.poll(async () => (await birdsOnScreen(page)).length).toBe(1);
  for (let turn = 0; turn < 8; turn++) {
    try {
      await touchABird(page, isMobile);
      break;
    } catch {
      const box = (await page.locator('#view').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 60);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height - 60, { steps: 6 });
      await page.mouse.up();
    }
  }
  await expect(page.locator('#pr-card')).toContainText(
    'Its changed file is lit on the tree. 2 more are new in this PR, or in a hidden folder.',
  );
});

test('two PRs on one folder share its branch, and the card says they may conflict', async ({
  page,
}) => {
  const pair = VITE_PULLS.filter((p) => p.number === 2101 || p.number === 2087);
  await servePulls(page, 'vitejs/vite', pair);
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await expect.poll(async () => (await birdsOnScreen(page)).length).toBe(2);
  // Spin until the pair faces the camera.
  for (let turn = 0; turn < 8; turn++) {
    try {
      const number = await touchABird(page, false);
      const card = page.locator('#pr-card');
      await expect(card).toContainText(
        `Also perched here: #${number === 2101 ? 2087 : 2101}. PRs that change the same folder may conflict.`,
      );
      await expect(card).toContainText('most in packages/vite/src/node/optimizer/');
      return;
    } catch {
      const box = (await page.locator('#view').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 60);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height - 60, { steps: 6 });
      await page.mouse.up();
    }
  }
  throw new Error('the pair never faced the camera');
});

test('Show PRs turns birds off in Settings', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Settings are the same on a phone');
  await servePulls(page, 'vitejs/vite', VITE_PULLS);
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await expect.poll(async () => (await birdsOnScreen(page)).length).toBe(VITE_PULLS.length);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: /Show PRs/ }).click();
  await expect.poll(async () => (await birdsOnScreen(page)).length).toBe(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('repo-tree:settings')!).birds),
  ).toBe(false);
});

test('a rate-limited PR list leaves the tree with no birds and no error', async ({ page }) => {
  await serveRepo(page, 'acme/limited', 'vitejs-vite');
  await page.route(
    (url) => url.href.startsWith('https://api.github.com/repos/acme/limited/pulls'),
    (route) =>
      route.fulfill({
        status: 403,
        headers: { 'access-control-allow-origin': '*', 'x-ratelimit-remaining': '0' },
        json: { message: 'API rate limit exceeded' },
      }),
  );
  await page.goto('./#/acme/limited');
  await ready(page, 'acme/limited');
  await expect(page.locator('#notices')).toBeEmpty();
  expect(await birdsOnScreen(page)).toEqual([]);
});

test('on a phone a tap beside a bird still opens its PR', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'a fingertip reach');
  await servePulls(page, 'vitejs/vite', VITE_PULLS);
  await page.goto('./#/vitejs/vite');
  await ready(page, 'vitejs/vite');
  await expect.poll(async () => (await birdsOnScreen(page)).length).toBe(VITE_PULLS.length);
  await settle(page);
  const box = (await page.locator('#view').boundingBox())!;
  const spots = await birdsOnScreen(page);
  // A bird in plain sight, tapped a fingertip's width to its side where no other bird is nearer
  // and the GPU pick finds a branch or the sky instead.
  const pick = (x: number, y: number) =>
    page.evaluate(
      ([x, y]) =>
        (
          window as unknown as {
            __repoTree: { view: { pickAt(x: number, y: number): { bird?: number } | null } };
          }
        ).__repoTree.view.pickAt(x!, y!),
      [x, y],
    );
  const nearest = (x: number, y: number) =>
    spots.reduce(
      (best, s, j) =>
        Math.hypot(s.x - x, s.y - y) < Math.hypot(spots[best]!.x - x, spots[best]!.y - y)
          ? j
          : best,
      0,
    );
  let target: { i: number; x: number; y: number } | null = null;
  for (const [i, { x, y }] of spots.entries()) {
    if ((await pick(x, y))?.bird !== i) continue;
    for (const [dx, dy] of [
      [16, 0],
      [-16, 0],
      [0, 16],
      [0, -16],
      [12, 12],
      [-12, 12],
      [12, -12],
      [-12, -12],
    ] as const) {
      const [tx, ty] = [x + dx, y + dy];
      if (nearest(tx, ty) === i && (await pick(tx, ty))?.bird === undefined) {
        target = { i, x: tx, y: ty };
        break;
      }
    }
    if (target) break;
  }
  expect(target, 'a bird with open space beside it').not.toBeNull();
  await page.touchscreen.tap(box.x + target!.x, box.y + target!.y);
  const card = page.locator('#pr-card');
  await expect(card).toBeVisible();
  const number = Number(/#(\d+)/.exec((await card.locator('.pr-meta').textContent())!)![1]);
  expect(VITE_PULLS.map((p) => p.number)).toContain(number);
});
