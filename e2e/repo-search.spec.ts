import { expect, test, type Page } from '@playwright/test';
import { ready, serveRepo } from './github';
import { openRepoField } from './view';

const field = (page: Page) => page.getByLabel('GitHub repository');
const list = (page: Page) => page.locator('#suggest');

/** A stand-in for GitHub's repository search that records each query it is asked. */
async function serveSearch(page: Page, reply: (q: string) => { status?: number; json: unknown }) {
  const asked: string[] = [];
  await page.route('https://api.github.com/search/repositories?**', (route) => {
    // The API version header makes the browser ask first, the way GitHub answers it.
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'Accept, Authorization, X-GitHub-Api-Version',
        },
      });
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    asked.push(q);
    const { status = 200, json } = reply(q);
    return route.fulfill({
      status,
      json,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'X-RateLimit-Remaining, X-RateLimit-Reset',
        ...(status === 403 && {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 40),
        }),
      },
    });
  });
  return asked;
}

const item = (name: string, stars: number, description = '') => ({
  full_name: name,
  stargazers_count: stars,
  description,
});

test('typing suggests GitHub repos once typing pauses, and a pick grows it', async ({ page }) => {
  const asked = await serveSearch(page, () => ({
    json: {
      items: [item('mrdoob/three.js', 117670, 'JavaScript 3D Library.'), item('acme/thread', 12)],
    },
  }));
  await serveRepo(page, 'mrdoob/three.js');
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await openRepoField(page);
  await field(page).pressSequentially('thre', { delay: 40 });
  const hit = list(page).locator('button', { hasText: 'mrdoob/three.js' });
  await expect(hit).toContainText('JavaScript 3D Library.');
  await expect(hit).toContainText('★ 117.7k');
  await expect(list(page).locator('b').first()).toHaveText('thre');
  // One search for the whole word, not one per letter.
  expect(asked).toEqual(['thre in:name']);
  await hit.click();
  await ready(page, 'mrdoob/three.js');
});

test("an owner and a slash lists that owner's repos, under the samples that match", async ({
  page,
}) => {
  const asked = await serveSearch(page, () => ({
    json: { items: [item('vitejs/vite', 83767), item('vitejs/awesome-vite', 17286)] },
  }));
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await openRepoField(page);
  await field(page).fill('vitejs/');
  await expect(list(page).getByText('vitejs on GitHub')).toBeVisible();
  // The bundled sample shows once, as a sample, not again from GitHub.
  const vite = list(page).locator('button', { hasText: 'vitejs/vite' });
  await expect(vite).toHaveCount(1);
  await expect(vite).toContainText('files');
  await expect(list(page).locator('button', { hasText: 'awesome-vite' })).toBeVisible();
  expect(asked).toEqual(['user:vitejs']);
});

test('a spent search budget keeps the local rows and says so', async ({ page }) => {
  await serveSearch(page, () => ({ status: 403, json: { message: 'API rate limit exceeded' } }));
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  await openRepoField(page);
  await field(page).fill('lin');
  await expect(list(page).locator('button', { hasText: 'torvalds/linux' })).toBeVisible();
  await expect(list(page)).toContainText('GitHub search is resting');
  await expect(list(page)).toContainText('Enter still grows any owner/repo.');
});

test('while adding to a comparison, a GitHub pick joins it and compared repos are left out', async ({
  page,
}) => {
  const asked = await serveSearch(page, () => ({
    json: { items: [item('vitejs/vite', 83767), item('acme/gadgets', 12, 'Small tools.')] },
  }));
  await serveRepo(page, 'acme/gadgets');
  // DIAGNOSTIC (temporary): what the page did when CI sees this fail.
  const logs: string[] = [];
  const t0 = Date.now();
  page.on('console', (m) => logs.push(`${Date.now() - t0} ${m.type()} ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => logs.push(`${Date.now() - t0} pageerror ${e.message.slice(0, 300)}`));
  page.on('requestfailed', (r) =>
    logs.push(`${Date.now() - t0} failed ${r.url().slice(0, 120)} ${r.failure()?.errorText}`),
  );
  page.on(
    'response',
    (r) =>
      /github\.com/.test(r.url()) &&
      logs.push(`${Date.now() - t0} ${r.status()} ${r.url().slice(0, 120)}`),
  );
  await page.addInitScript(() => {
    const at = () => Math.round(performance.now());
    for (const type of ['focusin', 'focusout'])
      document.addEventListener(
        type,
        (e) =>
          console.log(
            `[probe] ${at()} ${type} ${(e.target as HTMLElement).id || (e.target as HTMLElement).className} -> ${((e as FocusEvent).relatedTarget as HTMLElement | null)?.id ?? null}`,
          ),
        true,
      );
    const fetch0 = window.fetch;
    window.fetch = (...args) => {
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      if (url.includes('search')) console.log(`[probe] ${at()} fetch ${url}`);
      return fetch0(...args).then(
        (r) => {
          if (url.includes('search')) console.log(`[probe] ${at()} fetched ${r.status} ${url}`);
          return r;
        },
        (e) => {
          if (url.includes('search')) console.log(`[probe] ${at()} fetch threw ${e} ${url}`);
          throw e;
        },
      );
    };
  });
  await page.goto('./');
  await ready(page, 'vitejs/vite');
  const add = page.locator('#compare-add');
  if (await add.isVisible()) await add.click();
  else {
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('button', { name: 'Compare trees' }).click();
  }
  await expect(page.locator('#repo-mode')).toHaveText('Compare');
  await field(page).fill('ga');
  const hit = list(page).locator('button', { hasText: 'acme/gadgets' });
  await expect(hit).toBeVisible();
  await field(page).fill('vite');
  try {
    await expect(list(page)).toContainText('On GitHub');
  } catch (error) {
    const state = await page.evaluate(() => ({
      active: document.activeElement?.id,
      hidden: document.getElementById('suggest')!.hidden,
      value: (document.getElementById('repo-input') as HTMLInputElement).value,
      mode: document.getElementById('repo-mode')!.hidden,
      body: [...document.body.attributes].map((a) => `${a.name}=${a.value}`).join(' '),
      now: Math.round(performance.now()),
    }));
    throw new Error(
      `DIAG ${JSON.stringify({ asked, state })}\n${logs.filter((l) => !/ 200 https:\/\/api.github.com\/repos\/vitejs\/vite\/pulls\/\d/.test(l)).join('\n')}`,
      { cause: error },
    );
  }
  await expect(list(page).locator('button', { hasText: 'vitejs/vite' })).toHaveCount(0);
  await field(page).fill('ga');
  await hit.click();
  await expect(page.locator('#compare')).toHaveAttribute('data-ready', 'acme/gadgets', {
    timeout: 60_000,
  });
});
