import { expect, test, type Page } from '@playwright/test';
import { quietSettings, ready, serveRateLimit, serveRepo } from './github';
import { openRepoField } from './view';

/**
 * Computing a missing history in the browser and sharing it, against e2e/history-stack.mjs:
 * a fake GitHub (API and sign-in), the real history Worker, and the app built to use both.
 */
const WORKER = process.env.HISTORY_WORKER ?? 'http://localhost:4177';
const FAKE = process.env.HISTORY_GITHUB ?? 'http://localhost:4178';

test.use({ reducedMotion: 'reduce' });

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await quietSettings(page);
  await serveRepo(page, 'acme/widgets');
  await serveRepo(page, 'acme/gadgets');
});
test.afterEach(() => expect(errors).toEqual([]));

/** Waits for the sign-in popup to close, which it may already have done. */
const closed = async (popup: Page) => {
  if (!popup.isClosed()) await popup.waitForEvent('close');
};

const dialog = (page: Page) => page.getByRole('dialog', { name: /timeline|history/i });

async function open(page: Page, name = 'acme/widgets') {
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await openRepoField(page);
  const input = page.getByLabel('GitHub repository');
  await input.fill(name);
  await input.press('Enter');
  await ready(page, name);
}

test.describe.configure({ mode: 'serial' });

test('a signed-out visitor is offered to compute a missing history, and may decline', async ({
  page,
}) => {
  await open(page);
  await page.locator('#timeline').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('No timeline yet for acme/widgets');
  await expect(dialog(page)).toContainText('your own GitHub requests, under 1 MB to download');
  await expect(dialog(page)).toContainText('everyone who opens acme/widgets gets it at once');
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('group', { name: 'Timeline' })).toBeHidden();
});

test('signs in, computes in the browser, shares it, and opens the timeline', async ({
  page,
  context,
}) => {
  const authorized: string[] = [];
  context.on('request', (req) => {
    if (req.headers()['authorization']) authorized.push(new URL(req.url()).origin);
  });
  const logged: string[] = [];
  page.on('console', (m) => void (m.type() === 'info' && logged.push(m.text())));
  await open(page);
  await page.locator('#timeline').click();
  const popup = page.waitForEvent('popup');
  await dialog(page).getByRole('button', { name: 'Sign in with GitHub' }).click();
  await closed(await popup);
  await expect(page.getByRole('group', { name: 'Timeline' })).toBeVisible({ timeout: 60_000 });
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#timeline-date')).not.toBeEmpty();

  // Stored for everyone, with the manifest the Worker checked.
  const res = await fetch(`${WORKER}/v1/history/acme/widgets?branch=main`);
  expect(res.status).toBe(200);
  const manifest = JSON.parse(res.headers.get('x-history-manifest')!);
  expect(manifest).toMatchObject({ repo: 'acme/widgets', branch: 'main', by: 'visitor' });
  // The token went to GitHub (the fake) and the Worker, nowhere else.
  expect(new Set(authorized)).toEqual(new Set([FAKE, WORKER]));
  expect(await page.evaluate(() => localStorage.getItem('repo-tree:github-signin'))).toBeNull();

  // The run says where its time went, the upload included, on one console line.
  const line = logged.find((l) => l.startsWith('history acme/widgets: '));
  expect(line).toMatch(/listings [\d.]+ s, probes/);
  expect(line).toMatch(/upload [\d.]+ s/);
  // Every tree came in one git fetch through the Worker.
  expect(line).toMatch(/pack 1 req/);
  expect(line).toContain('fell back: no');
  const trace = await page.evaluate(
    () =>
      (window as unknown as { __repoTree: { computeTrace: { requests: number } | null } })
        .__repoTree.computeTrace,
  );
  expect(trace?.requests).toBeGreaterThan(0);
});

test('a signed-out visitor then gets the shared history with no prompt', async ({ page }) => {
  await open(page);
  await page.locator('#timeline').click();
  await expect(page.getByRole('group', { name: 'Timeline' })).toBeVisible();
  await expect(dialog(page)).toBeHidden();
});

test('a signed-in visitor is offered to bring an out-of-date history up to date', async ({
  page,
}) => {
  const manifest = async () =>
    JSON.parse(
      (await fetch(`${WORKER}/v1/history/acme/widgets?branch=main`)).headers.get(
        'x-history-manifest',
      )!,
    ) as { head: string; computedAt: number };
  const before = await manifest();
  // GitHub gets a new commit, and two days pass: the shared history is behind.
  await fetch(`${FAKE}/__head`, {
    method: 'POST',
    body: JSON.stringify({ repo: 'acme/widgets', sha: null }),
  });
  await page.addInitScript((token) => {
    sessionStorage.setItem('repo-tree:github-signin', token);
    // The debug flag: the run's breakdown shows in a toast too.
    localStorage.setItem('repo-tree:debug', '1');
    const now = Date.now;
    Date.now = () => now() + 2 * 24 * 60 * 60 * 1000;
  }, 'gho_fakefakefakefakefake');
  await open(page);
  await page.locator('#timeline').click();
  await expect(dialog(page)).toContainText('The timeline of acme/widgets is out of date');
  await expect(dialog(page)).toContainText('the branch has moved since');
  await expect(dialog(page)).toContainText('add the commits since then');
  await page.getByRole('button', { name: 'Refresh history' }).click();
  await expect(page.getByRole('group', { name: 'Timeline' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#toast')).toContainText(
    /^history acme\/widgets: [\d.]+ s, \d+ requests/,
  );
  await expect(page.locator('#toast')).toContainText('upload');
  // Built on the stored history: one new snapshot, the stored ones kept.
  await expect(page.locator('#toast')).toContainText(/refreshed: 1 new, \d+ kept/);
  const after = await manifest();
  expect(after.head).not.toBe(before.head);
  expect(after.computedAt).toBeGreaterThan(before.computedAt);
});

test('the Sign in button signs in from anywhere, and GitHub reads then carry the token', async ({
  page,
}) => {
  const sent: (string | undefined)[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith('https://api.github.com/repos/acme/gadgets/git/trees/')) {
      sent.push(req.headers()['authorization']);
    }
  });
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const button = page.locator('#signin');
  await expect(button).toHaveAccessibleName('Sign in with GitHub');
  await expect(button).toBeVisible();
  const popup = page.waitForEvent('popup');
  await button.click();
  await closed(await popup);
  await expect(page.locator('#toast')).toHaveText('Signed in with GitHub');
  await expect(button).toHaveAccessibleName('GitHub account');

  const input = page.getByLabel('GitHub repository');
  await input.fill('acme/gadgets');
  await input.press('Enter');
  await ready(page, 'acme/gadgets');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/^Bearer \S+$/);

  // Settings no longer holds sign-in: the account button does.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#settings')).toBeVisible();
  await expect(page.locator('#settings')).not.toContainText('Sign out');
  await expect(page.locator('#settings')).not.toContainText('GitHub sign-in');
  await page.keyboard.press('Escape');
});

test('the GitHub account menu shows the requests left this hour, links to what Repo Tree sees, and signs out', async ({
  page,
}) => {
  const asked: (string | undefined)[] = [];
  page.on('request', (req) => {
    if (req.url() === 'https://api.github.com/rate_limit') asked.push(req.headers().authorization);
  });
  await serveRateLimit(page, 4812, 5000);
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const button = page.locator('#signin');
  const popup = page.waitForEvent('popup');
  await button.click();
  await closed(await popup);
  await expect(button).toHaveAccessibleName('GitHub account');

  await button.click();
  const panel = page.getByRole('dialog', { name: 'GitHub account' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('#account-usage')).toHaveText('4,812 of 5,000 left');
  await expect(panel.locator('#account-reset')).toHaveText(/^Resets at /);
  // The meter shows the share left.
  const fill = await panel
    .locator('.account-meter i')
    .evaluate((el) => (el as HTMLElement).style.width);
  expect(fill).toBe('96.2%');
  // Asked with the sign-in token, so it is the account's own budget.
  expect(asked.at(-1)).toMatch(/^Bearer \S+$/);
  // Under the button, not off screen.
  const at = (await button.boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThan(at.y + at.height);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  // What Repo Tree can see is on the questions page, which opens in a new tab.
  const faq = panel.getByRole('link', { name: 'What Repo Tree can see' });
  await expect(faq).toHaveAttribute('href', './faq.html#github');
  await expect(faq).toHaveAttribute('target', '_blank');
  const page2 = await page.context().newPage();
  await page2.goto(new URL('./faq.html#github', page.url()).href);
  await expect(page2.getByRole('heading', { name: 'Questions and answers' })).toBeVisible();
  // Most questions are about Repo Tree itself; a few are about GitHub.
  await expect(page2.locator('#about details')).toHaveCount(5);
  await expect(page2.locator('#github details')).toHaveCount(3);
  await expect(page2.locator('#what-can-it-see')).toContainText('Public data only');
  await expect(page2.locator('#what-can-it-see')).toContainText('CODEOWNERS');
  await page2.close();

  // Escape closes it; a click outside does too.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await button.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(400, 600);
  await expect(panel).toBeHidden();

  // GitHub not answering says so.
  await page.route('https://api.github.com/rate_limit', (route) => route.fulfill({ status: 500 }));
  await button.click();
  await expect(panel.locator('#account-usage')).toHaveText(/GitHub didn’t answer/);
  await expect(panel.locator('.account-meter')).toBeHidden();

  await panel.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#toast')).toHaveText('Signed out of GitHub');
  await expect(panel).toBeHidden();
  await expect(button).toHaveAccessibleName('Sign in with GitHub');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Sign in is its own box at the top right, beside the repo card', async ({ page }) => {
    await serveRateLimit(page, 4812, 5000);
    await page.goto('./');
    await ready(page, 'vitejs/vite');
    const bubble = page.getByRole('button', { name: 'Sign in with GitHub' });
    await expect(bubble).toBeVisible();
    const at = (await bubble.boundingBox())!;
    const card = (await page.locator('#title').boundingBox())!;
    // A rounded box like the repo card, not a circle.
    expect(await bubble.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('14px');
    expect(at.y).toBeLessThan(card.y + card.height);
    expect(at.x).toBeGreaterThanOrEqual(card.x + card.width);
    expect(at.x + at.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    // The More menu no longer holds it.
    await page.getByRole('button', { name: 'More actions' }).tap();
    await expect(page.locator('#more-menu #signin')).toHaveCount(0);
    await page.getByRole('button', { name: 'More actions' }).tap();

    const popup = page.waitForEvent('popup');
    await bubble.tap();
    await closed(await popup);
    const account = page.getByRole('button', { name: 'GitHub account' });
    await account.tap();
    const panel = page.getByRole('dialog', { name: 'GitHub account' });
    await expect(panel.locator('#account-usage')).toHaveText(/^4,812 of 5,000 left/);
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });

  test('warns with the estimate before starting, and lets the visitor choose', async ({ page }) => {
    // A repo nobody computed yet (acme/widgets is shared by now).
    await open(page, 'acme/gadgets');
    await page.locator('#timeline').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('This looks like a phone or a small device.');
    await expect(dialog(page)).toContainText('drain the battery');
    await expect(page.getByRole('button', { name: 'Sign in and compute anyway' })).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog(page)).toBeHidden();
  });
});
