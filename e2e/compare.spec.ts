import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRepo } from './github';

test.use({ reducedMotion: 'reduce' });
// Each test grows several trees, one after the other, on a software renderer shared with other workers.
test.describe.configure({ timeout: 90_000 });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const field = (page: Page) => page.getByLabel('GitHub repository');
/** The tag in the repo field that says it adds to the comparison rather than growing. */
const mode = (page: Page) => page.locator('#repo-mode');
const rows = (page: Page) => page.getByRole('group', { name: 'Compared repos' });
/** The grove's lines, the repo on show first, by full name. */
const rowNames = (page: Page) =>
  expect.poll(() =>
    rows(page)
      .locator('.cmp-row')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.repo)),
  );
const add = (page: Page) => page.locator('#compare-add');
/** Every compared repo has grown in on its island beside the one on show. */
const besideReady = (page: Page, ...repos: string[]) =>
  expect(page.locator('#compare')).toHaveAttribute('data-ready', repos.join(' '), {
    timeout: 60_000,
  });
const panel = (page: Page) => page.locator('#compare-panel');
const table = (page: Page, name: string) => page.getByRole('table', { name });

/** Starts adding a repo: the card's add row, or Compare under More actions on a phone. */
async function startAdding(page: Page) {
  if (await add(page).isVisible()) return add(page).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Compare trees' }).click();
}

/** On a phone the side by side lives in the sheet. */
async function showPanel(page: Page) {
  const toggle = page.locator('#sheet-toggle');
  if ((await panel(page).isHidden()) && (await toggle.isVisible())) await toggle.click();
  await expect(panel(page)).toBeVisible();
}

test('the card adds a repo to compare through the search bar, and × takes it away', async ({
  page,
}) => {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await expect(mode(page)).toBeHidden();

  // Adding shows a Compare tag in the field, and clicking out takes it away.
  await startAdding(page);
  await expect(field(page)).toBeFocused();
  await expect(mode(page)).toHaveText('Compare');
  await expect(field(page)).toHaveAttribute('placeholder', 'Compare vitejs/vite with…');
  await page.keyboard.press('Escape');
  await expect(mode(page)).toBeHidden();

  // The list offers only repos not already compared.
  await startAdding(page);
  await expect(page.locator('#suggest')).not.toContainText('vitejs/vite');
  await page.locator('#suggest button', { hasText: 'mathiasbynens/dotfiles' }).click();
  await besideReady(page, 'mathiasbynens/dotfiles');
  await expect(mode(page)).toBeHidden();
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
  await rowNames(page).toEqual(['vitejs/vite', 'mathiasbynens/dotfiles']);
  await expect(rows(page)).toContainText('Side by side · 2 trees');
  // A name tag under each island; folder labels belong to one tree, so they go.
  await expect(page.locator('.island-tag:visible')).toHaveText(['vite', 'dotfiles']);
  await expect(page.locator('#labels')).toBeHidden();

  await showPanel(page);
  await expect(page.locator('#compare-line')).toHaveText(/vite has \d+× the files of dotfiles/);
  const bars = table(page, 'All trees side by side');
  await expect(bars.getByRole('row').locator('.cmp-num')).toHaveText([/^\d{1,3},\d{3}$/, '36']);
  // The switch sets them side by side by another number.
  await panel(page).getByRole('button', { name: 'Folders' }).click();
  await expect(panel(page).getByRole('button', { name: 'Folders' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(bars.getByRole('row').locator('.cmp-num')).toHaveText([/^\d+$/, '8']);
  await expect(
    table(page, 'Languages side by side').getByRole('img', { name: /JSON \d+%/ }),
  ).toHaveCount(2);
  // One key for both trees: picking a color highlights it on all of them, and again clears it.
  const key = panel(page).getByRole('list', { name: 'Leaf colors on every tree' });
  const json = key.getByRole('button', { name: /^JSON \d+%$/ });
  await json.click();
  await expect(json).toHaveAttribute('aria-pressed', 'true');
  await json.click();
  await expect(json).toHaveAttribute('aria-pressed', 'false');
  if (await page.locator('#sheet-toggle').isVisible()) await page.locator('#sheet-toggle').click();

  await page
    .getByRole('button', { name: 'Remove mathiasbynens/dotfiles from the comparison' })
    .click();
  await rowNames(page).toEqual([]);
  await expect(page.locator('.island-tag:visible')).toHaveCount(0);
  expect(page.url()).not.toContain('vs=');
});

test('a link compares several repos, a typed one adds on, and A hands over to B', async ({
  page,
}) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');

  // A repo already in the comparison is refused; a new one joins as C.
  await startAdding(page);
  await field(page).fill('vitejs/vite');
  await field(page).press('Enter');
  await expect(page.locator('#repo-error')).toHaveText(/already in the comparison/);
  await field(page).fill('acme/widgets');
  await field(page).press('Enter');
  await besideReady(page, 'mathiasbynens/dotfiles', 'acme/widgets');
  expect(page.url()).toContain('vs=mathiasbynens/dotfiles&vs=acme/widgets');
  await rowNames(page).toEqual(['vitejs/vite', 'mathiasbynens/dotfiles', 'acme/widgets']);
  await showPanel(page);
  await expect(table(page, 'All trees side by side').getByRole('row')).toHaveCount(3);
  if (await page.locator('#sheet-toggle').isVisible()) await page.locator('#sheet-toggle').click();

  // Each tree's seed, by line.
  const seeds = () =>
    rows(page)
      .locator('.cmp-row')
      .evaluateAll((els) =>
        els.map((el) => el.querySelector<HTMLElement>('.cmp-seed')!.dataset.seed),
      );
  expect(await seeds()).toEqual(['0', '1', '2']);

  // Taking A away puts B on show, and C stays beside it, each in its own color still.
  await page.getByRole('button', { name: 'Remove vitejs/vite from the comparison' }).click();
  await ready(page, 'mathiasbynens/dotfiles');
  await besideReady(page, 'acme/widgets');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('mathiasbynens/dotfiles');
  await rowNames(page).toEqual(['mathiasbynens/dotfiles', 'acme/widgets']);
  expect(await seeds()).toEqual(['1', '2']);
  await expect(page.locator('.island-tag:visible')).toHaveText(['dotfiles', 'widgets']);
  expect(
    await page
      .locator('.island-tag:visible')
      .evaluateAll((els) => els.map((el) => el.dataset.seed)),
  ).toEqual(['1', '2']);
});

test('the add row goes quiet once five repos are compared', async ({ page }) => {
  for (const name of ['acme/one', 'acme/two', 'acme/three']) await serveRepo(page, name);
  await page.goto(
    './#/vitejs/vite?vs=mathiasbynens/dotfiles&vs=acme/one&vs=acme/two&vs=acme/three',
  );
  await besideReady(page, 'mathiasbynens/dotfiles', 'acme/one', 'acme/two', 'acme/three');
  await expect(rows(page).locator('.cmp-row')).toHaveCount(5);
  await expect(add(page)).toBeDisabled();
  await expect(add(page)).toHaveText(/5 repos is the most/);
  await expect(page.locator('.island-tag:visible')).toHaveCount(5);
});

test('the side by side follows Color by', async ({ page }) => {
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles&colorBy=changes');
  await besideReady(page, 'mathiasbynens/dotfiles');
  await showPanel(page);

  // Both histories are bundled, so both columns fill in, and each tree lists its busiest files.
  const changes = table(page, 'How often files change side by side');
  await expect(changes.getByRole('img', { name: /Rarely \d+%/ })).toHaveCount(2);
  await expect(panel(page).locator('.cmp-list')).toHaveCount(2);
  await expect(panel(page).locator('.cmp-list').nth(1).locator('li')).not.toHaveCount(0);
});

test("a tree's tag or line shows it alone, and the card brings the grove back", async ({
  page,
}) => {
  await serveRepo(page, 'acme/widgets');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles&vs=acme/widgets');
  await besideReady(page, 'mathiasbynens/dotfiles', 'acme/widgets');

  // The tag under dotfiles' island puts it on show alone.
  await page.locator('.island-tag', { hasText: 'dotfiles' }).click();
  await ready(page, 'mathiasbynens/dotfiles');
  expect(page.url()).not.toContain('vs=');
  await expect(page.locator('.island-tag:visible')).toHaveCount(0);
  const back = page.locator('#compare-back');
  await expect(back).toHaveText(/Back to all 3 trees/);
  await expect(add(page)).toBeHidden();

  // Back puts the grove as it was, the same repo on show.
  await back.click();
  await ready(page, 'vitejs/vite');
  await besideReady(page, 'mathiasbynens/dotfiles', 'acme/widgets');
  await rowNames(page).toEqual(['vitejs/vite', 'mathiasbynens/dotfiles', 'acme/widgets']);
  await expect(back).toBeHidden();

  // The line of the repo on show shows it alone in place, and Done ends the comparison.
  await page.getByRole('button', { name: 'Show only vitejs/vite' }).click();
  await expect(page.locator('.island-tag:visible')).toHaveCount(0);
  await expect(back).toBeVisible();
  await back.click();
  await besideReady(page, 'mathiasbynens/dotfiles', 'acme/widgets');
  await page.getByRole('button', { name: 'Done' }).click();
  await rowNames(page).toEqual([]);
  await expect(back).toBeHidden();
  expect(page.url()).not.toContain('vs=');
});

test("hovering another tree's branch names it, and a click pins it with the grove kept in view", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'hover');
  await page.goto('./#/mathiasbynens/dotfiles?vs=vitejs/vite');
  await besideReady(page, 'vitejs/vite');
  const debug = () =>
    page.evaluate(() => {
      const d = (
        window as unknown as {
          __repoTree: {
            hovered: string | null;
            hoveredTree: string | null;
            companionPin: string | null;
            view: { atHome(): boolean };
          };
        }
      ).__repoTree;
      return {
        path: d.hovered,
        tree: d.hoveredTree,
        pin: d.companionPin,
        home: d.view.atHome(),
      };
    });

  // A spot on one of vite's branches above its tag, from the view's own pick; tried again while
  // the camera still glides as the panels settle.
  const spot = () =>
    page.evaluate(() => {
      type View = { pickAt(x: number, y: number): { folder: number; companion?: number } | null };
      const view = (window as unknown as { __repoTree: { view: View } }).__repoTree.view;
      const rect = document.getElementById('view')!.getBoundingClientRect();
      const tag = [...document.querySelectorAll<HTMLElement>('.island-tag')]
        .find((el) => !el.hidden && el.textContent?.includes('vite'))!
        .getBoundingClientRect();
      const x0 = tag.x + tag.width / 2;
      for (let dy = 30; dy < 400; dy += 4) {
        for (const dx of [0, -6, 6, -12, 12, -20, 20]) {
          const [x, y] = [x0 + dx, tag.y - dy];
          // A folder's branch, not the trunk: the root folder pins nothing.
          const picked = view.pickAt(x - rect.left, y - rect.top);
          if (picked?.companion === 0 && picked.folder !== 0) return { x, y };
        }
      }
      return null;
    });
  // A click pins the folder on vite where it stands. Tried again while the camera still glides
  // as the panels settle, so the pointer may slip onto the trunk between hover and click.
  let found: Awaited<ReturnType<typeof debug>> | null = null;
  await expect(async () => {
    const at = await spot();
    expect(at, "a branch of vite's tree above its tag").not.toBeNull();
    await page.mouse.move(at!.x, at!.y);
    await expect.poll(() => debug().then((d) => d.tree), { timeout: 1_500 }).toBe('vitejs/vite');
    found = await debug();
    expect(found.path, 'a branch, not the trunk').toBeTruthy();
    await expect(page.locator('#tip')).toContainText('click to pin');
    await expect(page.locator('#tip code')).toContainText('vitejs/vite/');
    await page.mouse.down();
    await page.mouse.up();
    await expect
      .poll(() => debug().then((d) => d.pin), { timeout: 1_500 })
      .toBe(`vitejs/vite:${found.path}`);
  }).toPass({ timeout: 30_000 });
  // The panel shows the pinned folder, as it does one on the tree on show, and the tip goes.
  const pinned = page.getByRole('article', { name: `Pinned folder vitejs/vite/${found!.path}` });
  await expect(pinned).toBeVisible();
  await expect(pinned.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
    'href',
    new RegExp(`github\\.com/vitejs/vite/tree/main/${found!.path}$`),
  );
  await expect(page.locator('#tip')).toBeHidden();
  // Both trees stay, and the camera keeps the whole grove in view.
  expect(page.url()).toContain('vs=vitejs');
  await expect(page.locator('.island-tag:visible')).toHaveCount(2);
  await page.waitForTimeout(1_000);
  expect((await debug()).home, 'the camera frames the whole grove').toBe(true);
  // Escape lets go, as it does a pin on the tree on show.
  await page.keyboard.press('Escape');
  await expect.poll(() => debug().then((d) => d.pin)).toBeNull();
  // So does a click on empty ground.
  await expect(async () => {
    const at = await spot();
    await page.mouse.click(at!.x, at!.y);
    await expect.poll(() => debug().then((d) => d.pin), { timeout: 1_500 }).not.toBeNull();
  }).toPass({ timeout: 30_000 });
  await page.mouse.click(5, (await page.viewportSize())!.height / 2);
  await expect.poll(() => debug().then((d) => d.pin)).toBeNull();
});

test("search looks through every tree, names each hit's repo, and pins without leaving the grove", async ({
  page,
}) => {
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');
  await page.locator('#search-open').click();
  await page.getByRole('combobox', { name: 'Search folders and files' }).fill('readme');
  const results = page.locator('#results li');
  // Each tree's best match comes in turn, so the small repo is not crowded out by the big one.
  await expect(results.locator('.hit-repo')).toContainText(['vite', 'dotfiles']);
  const pinOf = () =>
    page.evaluate(
      () =>
        (window as unknown as { __repoTree: { companionPin: string | null } }).__repoTree
          .companionPin,
    );
  await results
    .filter({ has: page.locator('.hit-repo', { hasText: 'dotfiles' }) })
    .first()
    .click();
  await expect.poll(pinOf).toMatch(/^mathiasbynens\/dotfiles:/);
  // The grove stays: both trees, the camera on all of them, and the matches still stepping.
  expect(page.url()).toContain('vs=mathiasbynens');
  await expect(page.locator('.island-tag:visible')).toHaveCount(2);
  await expect(page.locator('#search-steps')).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __repoTree: { view: { atHome(): boolean } } }
      ).__repoTree.view.atHome(),
    ),
  ).toBe(true);
  // The pill keeps clear of the grove's card.
  const card = (await page.locator('#title').boundingBox())!;
  const pill = (await page.locator('#search-steps').boundingBox())!;
  const across = pill.x < card.x + card.width && card.x < pill.x + pill.width;
  if (across) expect(pill.y).toBeGreaterThanOrEqual(card.y + card.height);
});

test('the timeline replays every tree in the grove on one calendar', async ({ page }) => {
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles&t=2016');
  await besideReady(page, 'mathiasbynens/dotfiles');
  const files = page.locator('#timeline-files');
  await expect(page.locator('#scrubber')).toBeVisible();
  // Both trees stay on show, and the count is theirs together.
  await expect(page.locator('.island-tag:visible')).toHaveText(['vite', 'dotfiles']);
  await expect(files).toHaveAttribute('title', /across 2 trees$/);
  // The link's date is before vite's first commit but on the grove's calendar, so it shows.
  await expect(page.locator('#timeline-date')).toHaveText('Jan 2016');
  const before = Number((await files.textContent())!.replace(/\D/g, ''));
  await page.getByRole('slider', { name: 'Timeline position' }).press('End');
  await expect(files).toHaveAttribute('title', /^2,934 files across 2 trees$/);
  expect(before).toBeLessThan(2934);
  // Dropping a tree replays the one left on its own.
  await page
    .getByRole('button', { name: 'Remove mathiasbynens/dotfiles from the comparison' })
    .click();
  await expect(files).not.toHaveAttribute('title', /across/);
  await expect(page.locator('#scrubber')).toBeVisible();
});

test('on a phone the open sheet folds the card to its head, so the grove stays in view', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'the desktop keeps its side panel beside the card');
  await page.goto('./#/vitejs/vite?vs=mathiasbynens/dotfiles');
  await besideReady(page, 'mathiasbynens/dotfiles');
  const list = rows(page).locator('.cmp-list-rows');
  await expect(list).toBeVisible();
  await page.locator('#sheet-toggle').click();
  await expect(list).toBeHidden();
  await expect(rows(page)).toContainText('Side by side · 2 trees');
  // The grove keeps the room between the card's head and the sheet, once the camera settles.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const head = document.getElementById('compare')!.getBoundingClientRect();
          const sheet = document.getElementById('side')!.getBoundingClientRect();
          const tags = [...document.querySelectorAll<HTMLElement>('.island-tag')].filter(
            (el) => !el.hidden,
          );
          return (
            tags.length === 2 &&
            tags.every((el) => {
              const r = el.getBoundingClientRect();
              return r.top > head.bottom && r.bottom < sheet.top;
            })
          );
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
  await page.locator('#sheet-toggle').click();
  await expect(list).toBeVisible();
});
