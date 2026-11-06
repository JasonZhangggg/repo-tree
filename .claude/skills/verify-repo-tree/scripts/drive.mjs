#!/usr/bin/env node
// Usage: node .claude/skills/verify-repo-tree/scripts/drive.mjs <command> [--port 4175]
//          [--out dir] [--viewport desktop|phone|phone-390] [--scale 2] [--history]
// Commands: launch, doctor, cleanup, or a journey: load-repo, explore, search, settings,
// share-and-export, phone-layout, tree-sizes, timeline, compare, weather, birds, hover, activity, changes, busiest,
// history-compute.
// `launch --history` starts e2e/history-stack.mjs instead (app, history Worker and fake GitHub
// on port, port+1 and port+2), which the history-compute journey needs. Journeys save numbered screenshots and report.json in --out
// (default .verify/<journey>-<viewport>-<time>/) and exit 1 when a step fails.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { chromium, devices } from 'playwright';
import {
  failRepo,
  quietSettings,
  ready,
  serveRepo,
  servePulls,
  serveRuns,
  VITE_PULLS,
} from '../../../../e2e/github.ts';

process.chdir(new URL('../../../../', import.meta.url).pathname);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: process.env.VERIFY_PORT ?? '4175' },
    out: { type: 'string' },
    viewport: { type: 'string', default: 'desktop' },
    scale: { type: 'string' },
    history: { type: 'boolean', default: false },
  },
});
const [command = ''] = positionals;
const { port, viewport } = values;
const base = `http://localhost:${port}/`;
const pidFile = `.verify/preview-${port}.pid`;
const worker = `http://localhost:${Number(port) + 1}`;
const fake = `http://localhost:${Number(port) + 2}`;
const dist = existsSync(`dist-history-${port}`) ? `dist-history-${port}` : 'dist';
const answers = () =>
  fetch(base).then(
    (r) => r.ok,
    () => false,
  );

async function launch() {
  if (await answers()) throw new Error(`port ${port} already answers; pick another --port`);
  if (values.history) return launchHistory();
  if (spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' }).status)
    throw new Error('vite build failed');
  mkdirSync('.verify', { recursive: true });
  const log = openSync(`.verify/preview-${port}.log`, 'w');
  const args = ['node_modules/vite/bin/vite.js', 'preview', '--port', port, '--strictPort'];
  const child = spawn('node', args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; !(await answers()); i++) {
    if (i > 100) throw new Error(`no answer on ${base}; see .verify/preview-${port}.log`);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`ready ${base} pid ${child.pid}`);
}

/** The app, the history Worker and a fake GitHub on a slow link, so progress can be watched. */
async function launchHistory() {
  mkdirSync('.verify', { recursive: true });
  const log = openSync(`.verify/preview-${port}.log`, 'w');
  const ports = [port, String(Number(port) + 1), String(Number(port) + 2)];
  const child = spawn('node', ['e2e/history-stack.mjs', ...ports], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, FAKE_NETWORK: process.env.FAKE_NETWORK ?? '400,30' },
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; !(await answers()); i++) {
    if (exited || i > 900) throw new Error(`no answer on ${base}; see .verify/preview-${port}.log`);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`ready ${base} worker ${worker} github ${fake} pid ${child.pid}`);
}

/** The process group a pid leads (a detached launch leads its own). */
const group = (pid) => spawnSync('ps', ['-o', 'pgid=', '-p', pid]).stdout.toString().trim();

const owners = () =>
  spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    .stdout.toString()
    .split(/\s+/)
    .filter(Boolean);

function cleanup() {
  if (!existsSync(pidFile)) return console.log(`nothing started on ${port} by this skill`);
  const pid = readFileSync(pidFile, 'utf8').trim();
  // A history stack's preview is its child, in the group the launched pid leads.
  if (owners().some((o) => o === pid || group(o) === pid)) process.kill(Number(pid));
  else console.log(`pid ${pid} no longer owns port ${port}; left it alone`);
  rmSync(pidFile);
  rmSync(`.verify/preview-${port}.log`, { force: true });
  console.log(`stopped pid ${pid}; evidence in .verify/ is kept`);
}

async function newest(dir) {
  let latest = 0;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (e.isFile()) latest = Math.max(latest, statSync(`${e.parentPath}/${e.name}`).mtimeMs);
  return latest;
}

async function open() {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const device = {
    desktop: { viewport: { width: 1280, height: 800 } },
    phone: devices['Pixel 7'],
    'phone-390': { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
  }[viewport];
  if (!device) throw new Error(`unknown --viewport ${viewport}; use desktop, phone or phone-390`);
  const context = await browser.newContext({
    ...device,
    ...(values.scale ? { deviceScaleFactor: Number(values.scale) } : {}),
    reducedMotion: 'reduce',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await quietSettings(page);
  return { browser, context, page, errors };
}

async function doctor() {
  const pid = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : null;
  const checks = {
    'started by this skill': pid !== null,
    'pid owns the port': pid !== null && owners().some((o) => o === pid || group(o) === pid),
    'dist newer than src':
      existsSync(`${dist}/index.html`) &&
      statSync(`${dist}/index.html`).mtimeMs >= (await newest('src')),
  };
  const { browser, page, errors } = await open();
  try {
    await page.goto(base);
    await ready(page, 'vitejs/vite');
    checks['title is Repo Tree'] = (await page.title()) === 'Repo Tree';
    checks['debug hook present'] = await page.evaluate(() => !!window.__repoTree?.view);
    checks['no page errors'] = errors.length === 0;
    const gl = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('webgl2');
      const ext = ctx?.getExtension('WEBGL_debug_renderer_info');
      return ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'none';
    });
    console.log(`renderer: ${gl}`);
  } catch (e) {
    checks['first visit reaches body[data-ready]'] = false;
    console.log(String(e));
  } finally {
    await browser.close();
  }
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (Object.values(checks).includes(false)) process.exitCode = 1;
}

const enter = async (page, text) => {
  // The repo field folds into the repo card until its GitHub mark or the name opens it.
  if (await page.getByLabel('GitHub repository').isHidden()) {
    await page.getByRole('button', { name: 'Change repository' }).click();
  }
  await page.getByLabel('GitHub repository').fill(text);
  await page.getByLabel('GitHub repository').press('Enter');
};
const detail = (page) => page.getByRole('article', { name: /Pinned folder/ });
/** The pinned folder's crumbs; on a phone the card waits in the sheet, so this opens and closes it. */
async function expectPinned(page, path) {
  const sheet = page.locator('#sheet-toggle');
  const phone = await sheet.isVisible();
  if (phone) await sheet.click();
  await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toHaveText(path);
  if (phone) await sheet.click();
}
const label = (page, path) =>
  page.evaluate((p) => window.__repoTree.labels.find((l) => l.path === p), path);
/** A point where the bare canvas has a limb under it; label pills can cover their own anchors. */
const limb = (page) =>
  page.evaluate(() => {
    const { labels, view } = window.__repoTree;
    const near = labels.flatMap(({ x, y }) => [-40, 40, -24, 24].map((dy) => ({ x, y: y + dy })));
    return near.find(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.tagName === 'CANVAS' && view.pickAt(x, y) !== null,
    );
  });
/** The nearest point to a label's anchor where its folder's branch is on screen; a twig tip is a pixel or two wide. */
const branchNear = (page, at, folder) =>
  page.evaluate(
    ({ at: { x, y }, folder }) => {
      const { view, tree } = window.__repoTree;
      for (let r = 0; r < 16; r++)
        for (let dx = -r; dx <= r; dx++)
          for (const dy of [-r, r]) {
            const picked = view.pickAt(x + dx, y + dy);
            if (picked && tree.folders.path[picked.folder].startsWith(folder))
              return { x: x + dx, y: y + dy };
          }
      return { x, y };
    },
    { at, folder },
  );
/** Waits until the view renders on demand again, so the camera has come to rest. */
/** Chooses a tree action, opening `More actions` first on a phone, where the action lives. */
async function chooseAction(page, name) {
  const more = page.getByRole('button', { name: 'More actions' });
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name }).click();
}

async function settle(page) {
  let renders = -1;
  await expect
    .poll(
      async () =>
        renders === (renders = await page.evaluate(() => window.__repoTree.view.stats().renders)),
      {
        intervals: [500],
      },
    )
    .toBe(true);
  return page.evaluate(() => window.__repoTree.view.stats());
}
/** Runs `act` and waits for the regrown tree it causes. */
async function regrow(page, act) {
  await page.evaluate(() => (window.__before = window.__repoTree.tree));
  await act();
  await page.waitForFunction(
    () => window.__repoTree.tree !== window.__before && window.__repoTree.ready,
    null,
    {
      timeout: 60_000,
    },
  );
}

const JOURNEYS = {
  'load-repo': async ({ page, step }) => {
    await step('first-visit', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('vitejs/vite');
    });
    await step('sample-button', async () => {
      await page.getByRole('button', { name: 'Change repository' }).click();
      await page.locator('#suggest button', { hasText: 'mathiasbynens/dotfiles' }).click();
      await ready(page, 'mathiasbynens/dotfiles');
    });
    await step('invalid-input', async () => {
      await enter(page, 'not a repo');
      await expect(page.locator('#repo-error')).toHaveText(/Use owner\/repo/);
    });
    await step('github-url', async () => {
      await serveRepo(page, 'acme/widgets');
      await enter(page, 'https://github.com/acme/widgets');
      await ready(page, 'acme/widgets');
      await expect(page.locator('#repo-meta')).toContainText('36 files');
      await expect(page).toHaveURL(/#\/acme\/widgets\?branch=main/);
    });
    await step('truncated', async () => {
      const sample = 'public/samples/mathiasbynens-dotfiles.json.gz';
      const { repo, tree } = JSON.parse(gunzipSync(readFileSync(sample)).toString());
      await serveRepo(page, 'acme/partial');
      await page.route(
        `https://api.github.com/repos/acme/partial/git/trees/${repo.default_branch}?recursive=1`,
        (r) => r.fulfill({ json: { ...tree, truncated: true } }),
      );
      await enter(page, 'acme/partial');
      await ready(page, 'acme/partial');
      await expect(page.locator('#status')).toContainText('Partial tree');
    });
    await step('unreachable', async () => {
      await enter(page, 'acme/offline');
      await expect(page.locator('#status [role="alert"]')).toContainText('Can’t reach GitHub');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme/partial');
    });
    await step('rate-limited', async () => {
      const reset = String(Math.floor(Date.now() / 1000) + 1800);
      await failRepo(page, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset });
      await enter(page, 'acme/limited');
      await expect(page.locator('#status [role="alert"]')).toContainText('rate limit is used up');
      await expect(page.locator('#status [role="alert"]')).toContainText('resets at');
    });
    await step('not-found', async () => {
      await failRepo(page, 404);
      await enter(page, 'acme/missing');
      await expect(page.locator('#status [role="alert"]')).toContainText('Can’t find acme/missing');
      await page.getByRole('button', { name: 'Add a token' }).click();
      await expect(page.getByLabel('GitHub token')).toBeFocused();
    });
  },

  explore: async ({ page, step }) => {
    let whole = 0;
    await step('open', async () => {
      await page.goto(`${base}#/vitejs/vite`);
      await ready(page, 'vitejs/vite');
      whole = (await settle(page)).distance;
    });
    let at = { x: 0, y: 0 };
    await step('hover', async () => {
      at = await limb(page);
      await page.mouse.move(at.x, at.y);
      await expect(page.locator('body')).toHaveAttribute('data-hovered', /.+/);
      await expect(page.getByRole('tooltip')).toBeVisible();
    });
    await step('pin', async () => {
      const hovered = await page.evaluate(() => window.__repoTree.hovered);
      await page.mouse.click(at.x, at.y);
      await expectPinned(page, `vite/${hovered}`);
      await expect(detail(page).getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
        'href',
        `https://github.com/vitejs/vite/tree/main/${hovered}`,
      );
      await expect(page).toHaveURL(new RegExp(`sel=${hovered}$`));
    });
    await step('crumb', async () => {
      // The root crumb: a folder under packages/vite has a second vite crumb, and lists it too.
      const crumbs = detail(page).getByRole('navigation', { name: 'Folder path' });
      await crumbs.getByRole('button', { name: 'vite', exact: true }).first().click();
      await expect(crumbs).toHaveText('vite');
    });
    await step('side-list', async () => {
      await page.locator('#folders button', { hasText: 'playground' }).first().click();
      await expectPinned(page, 'vite/playground');
      await settle(page);
    });
    await step('frame-whole', async () => {
      await page.keyboard.press('Escape');
      await expect(detail(page)).toBeHidden();
      await page.keyboard.press('f');
      expect((await settle(page)).distance).toBeCloseTo(whole, 3);
    });
  },

  search: async ({ page, step }) => {
    const box = () => page.getByRole('combobox', { name: 'Search folders and files' });
    await step('open', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await page.keyboard.press('/');
      await expect(box()).toBeFocused();
    });
    await step('match', async () => {
      await box().fill('node/server');
      await expect(page.getByRole('option').first()).toContainText(
        'packages/vite/src/node/server/',
      );
    });
    await step('choose', async () => {
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Search folders and files' })).toBeHidden();
      await expectPinned(page, 'vite/packages/vite/src/node/server');
      await expect(page).toHaveURL(/sel=packages\/vite\/src\/node\/server$/);
      await settle(page);
    });
    await step('file-hit', async () => {
      await page.locator('#search-open').click();
      await box().fill('packages/vite/package.json');
      await box().press('Enter');
      await expect(detail(page).locator('.file-card code')).toHaveText('package.json');
      await expectPinned(page, 'vite/packages/vite');
    });
    await step('no-match', async () => {
      await page.locator('#search-open').click();
      await box().fill('zzqqxx');
      await expect(page.getByRole('option')).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Search folders and files' })).toContainText(
        'No folder or file matches “zzqqxx”.',
      );
    });
  },

  settings: async ({ page, step }) => {
    const radio = (name) => page.locator('#settings').getByRole('radio', { name });
    await step('open', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    });
    await step('palette', async () => {
      await radio(/Winter/).click();
      await expect(page).toHaveURL(/palette=winter/);
    });
    await step('color-by', async () => {
      await page.locator('#color-pick').click();
      await radio('Folder').click();
      await expect(page).toHaveURL(/colorBy=folder/);
      await expect(page.locator('#legend-title')).toHaveText('Leaf colors by folder');
    });
    await step('quality', async () => {
      await regrow(page, () => radio('High').click());
      await expect(radio('High')).toHaveAttribute('aria-checked', 'true');
    });
    await step('hide-folder', async () => {
      await regrow(page, async () => {
        await page.getByLabel('Folder name to hide').fill('playground');
        await page.getByRole('button', { name: 'Hide', exact: true }).click();
      });
      const paths = await page.evaluate(() => window.__repoTree.tree.folders.path);
      expect(paths).not.toContain('playground');
    });
    await step('token', async () => {
      const sent = [];
      page.on('request', (r) => r.headers().authorization && sent.push(new URL(r.url()).host));
      await page.getByLabel('GitHub token').fill('ghp_verify_fake');
      await page.getByLabel('GitHub token').press('Enter');
      await expect(page.getByText('Token saved in this browser')).toBeVisible();
      await page.getByRole('button', { name: 'Close settings' }).click();
      await serveRepo(page, 'acme/widgets');
      await enter(page, 'acme/widgets');
      await ready(page, 'acme/widgets');
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set(['api.github.com']));
    });
    await step('reload', async () => {
      await page.reload();
      await ready(page, 'acme/widgets');
      const stored = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('repo-tree:settings')),
      );
      expect(stored).toMatchObject({
        palette: 'winter',
        colorBy: 'folder',
        quality: 'high',
        token: 'ghp_verify_fake',
      });
      expect(stored.hidden).toContain('playground');
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(radio(/Winter/)).toHaveAttribute('aria-checked', 'true');
    });
  },

  'share-and-export': async ({ page, context, step, out }) => {
    await step('open-link', async () => {
      await page.goto(`${base}#/vitejs/vite?palette=winter&sel=packages/vite`);
      await ready(page, 'vitejs/vite');
      await expectPinned(page, 'vite/packages/vite');
    });
    let link = '';
    await step('copy-link', async () => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.getByRole('button', { name: 'Copy link to this view' }).click();
      await expect(page.locator('#toast')).toHaveText('Link copied');
      link = await page.evaluate(() => navigator.clipboard.readText());
      expect(link).toMatch(
        /#\/vitejs\/vite\?branch=main&palette=winter&colorBy=language&sel=packages\/vite$/,
      );
    });
    await step('restore-link', async () => {
      await page.goto(link);
      await page.reload();
      await ready(page, 'vitejs/vite');
      await expectPinned(page, 'vite/packages/vite');
    });
    await step('export-png', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        chooseAction(page, 'Export PNG'),
      ]);
      expect(download.suggestedFilename()).toBe('vitejs-vite-tree.png');
      await download.saveAs(`${out}/vitejs-vite-tree.png`);
      expect(readFileSync(`${out}/vitejs-vite-tree.png`).subarray(1, 4).toString()).toBe('PNG');
      await expect(page.locator('#toast')).toHaveText('Saved vitejs-vite-tree.png');
    });
  },

  'phone-layout': async ({ page, step }) => {
    const sheet = page.locator('#sheet-toggle');
    await step('open', async () => {
      if (!viewport.startsWith('phone')) throw new Error('run with --viewport phone');
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await expect(sheet).toHaveAttribute('aria-expanded', 'false');
    });
    await step('tap-to-pin', async () => {
      const { x, y } = await branchNear(page, await label(page, 'playground'), 'playground');
      await page.touchscreen.tap(x, y);
      await expect(sheet).toContainText('playground');
      await expect(detail(page)).toBeHidden();
    });
    await step('sheet-open', async () => {
      await sheet.tap();
      await expect(sheet).toHaveAttribute('aria-expanded', 'true');
      await expect(detail(page).getByRole('navigation', { name: 'Folder path' })).toContainText(
        'playground',
      );
    });
    await step('clear', async () => {
      await page.getByRole('button', { name: 'Clear selection' }).first().tap();
      await expect(page.locator('#sheet-title')).toHaveText('Folders and leaf colors');
    });
    await step('settings-sheet', async () => {
      await sheet.tap();
      await expect(sheet).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('button', { name: 'Settings' }).tap();
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    });
  },

  'tree-sizes': async ({ page, step }) => {
    for (const repo of ['mathiasbynens/dotfiles', 'vitejs/vite', 'torvalds/linux']) {
      await step(repo.split('/')[1], async () => {
        await page.goto(`${base}?visit=${repo.split('/')[1]}#/${repo}?palette=autumn`);
        await ready(page, repo);
        await settle(page);
      });
    }
  },

  compare: async ({ page, step }) => {
    const besideReady = (...repos) =>
      expect(page.locator('#compare')).toHaveAttribute('data-ready', repos.join(' '), {
        timeout: 60_000,
      });
    const field = page.getByLabel('GitHub repository');
    // The card's add row, or Compare under More actions on a phone.
    const startAdding = async () => {
      const add = page.locator('#compare-add');
      if (await add.isVisible()) return add.click();
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('button', { name: 'Compare trees' }).click();
    };
    await serveRepo(page, 'acme/widgets');
    await step('adding', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await startAdding();
      await expect(page.locator('#repo-go')).toHaveText('Compare');
      await expect(page.locator('#suggest')).toBeVisible();
      await settle(page);
    });
    await step('open', async () => {
      await page.locator('#suggest button', { hasText: 'mathiasbynens/dotfiles' }).click();
      await besideReady('mathiasbynens/dotfiles');
      await expect(page).toHaveURL(/vs=mathiasbynens\/dotfiles/);
      await expect(page.locator('#repo-go')).toHaveText('Grow');
      await expect(page.locator('#compare-line')).toHaveText(/vite has \d+× the files of dotfiles/);
      await settle(page);
    });
    await step('three', async () => {
      await startAdding();
      await field.fill('acme/widgets');
      await field.press('Enter');
      await besideReady('mathiasbynens/dotfiles', 'acme/widgets');
      await expect(page).toHaveURL(/vs=mathiasbynens\/dotfiles&vs=acme\/widgets/);
      await settle(page);
    });
    await step('changes', async () => {
      // The side by side follows Color by: each tree's change levels and busiest files.
      await page.goto(`${base}#/vitejs/vite?vs=mathiasbynens/dotfiles&colorBy=changes`);
      await ready(page, 'vitejs/vite');
      await besideReady('mathiasbynens/dotfiles');
      const toggle = page.locator('#sheet-toggle');
      if ((await page.locator('#compare-panel').isHidden()) && (await toggle.isVisible()))
        await toggle.click();
      await expect(page.locator('#compare-panel .cmp-list')).toHaveCount(2);
      await settle(page);
      if (await toggle.isVisible()) await toggle.click();
    });
    await step('stop', async () => {
      await page
        .getByRole('button', { name: 'Remove mathiasbynens/dotfiles from the comparison' })
        .click();
      await expect(page.locator('#compare .cmp-row')).toHaveCount(0);
      await expect(page).not.toHaveURL(/vs=/);
      await settle(page);
    });
  },
  timeline: async ({ page, step, out }) => {
    const date = page.locator('#timeline-date');
    const files = page.locator('#timeline-files');
    const range = page.getByRole('slider', { name: 'Timeline position' });
    const scrubTo = async (at) => {
      const box = await range.boundingBox();
      await range.click({ position: { x: 9 + at * (box.width - 18), y: box.height / 2 } });
    };
    await step('open', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await page.locator('#timeline').click();
      await expect(page.getByRole('group', { name: 'Timeline' })).toBeVisible();
      await expect(files).toHaveText('2,898 files');
      await settle(page);
    });
    for (const [id, at] of [
      ['early', 0.05],
      ['quarter', 0.25],
      ['half', 0.5],
      ['three-quarters', 0.75],
    ]) {
      await step(id, async () => {
        await scrubTo(at);
        await expect(files).not.toHaveText('2,898 files');
        await expect(page).toHaveURL(/&t=\d{4}-\d\d-\d\d$/);
        await settle(page);
      });
    }
    await step('play-pause', async () => {
      const before = await date.textContent();
      await page.getByRole('button', { name: 'Play timeline' }).click();
      await expect(date).not.toHaveText(before);
      await page.getByRole('button', { name: 'Pause timeline' }).click();
      await settle(page);
    });
    await step('restore-link', async () => {
      await page.goto(`${base}?visit=t#/vitejs/vite?t=2022-06-15`);
      await ready(page, 'vitejs/vite');
      await expect(date).toHaveText('Jun 2022');
      await settle(page);
    });
    await step('export-png', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        chooseAction(page, 'Export PNG'),
      ]);
      expect(download.suggestedFilename()).toBe('vitejs-vite-tree-2022-06-15.png');
      await download.saveAs(`${out}/vitejs-vite-tree-2022-06-15.png`);
    });
    await step('unavailable', async () => {
      await serveRepo(page, 'acme/widgets');
      await enter(page, 'acme/widgets');
      await ready(page, 'acme/widgets');
      await expect(page.locator('#timeline')).toHaveAttribute('aria-disabled', 'true');
      await page.locator('#timeline').click({ force: true });
      await expect(page.locator('#toast')).toHaveText('History unavailable for this repo');
    });
  },

  weather: async ({ page, step }) => {
    const chip = page.locator('#weather');
    await step('sample-sunny', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await expect(chip).toHaveAttribute('aria-label', 'CI passing, 20 of 20 recent runs');
      await settle(page);
    });
    const live = [
      ['acme/cloudy', '..x' + '.'.repeat(17), 'cloudy'],
      ['acme/rain', 'x' + '.'.repeat(19), 'rain'],
      ['acme/storm', 'xxxx' + '.'.repeat(16), 'storm'],
    ];
    for (const [repo, runs] of live) {
      await serveRepo(page, repo);
      await serveRuns(page, repo, runs);
    }
    for (const [repo, , sky] of live) {
      await step(sky, async () => {
        await enter(page, repo);
        await ready(page, repo);
        await expect(chip).toHaveAttribute('data-sky', sky);
        await settle(page);
      });
    }
    await step('rate-limited', async () => {
      await serveRepo(page, 'acme/limited');
      await serveRuns(page, 'acme/limited', '', { status: 403 });
      await enter(page, 'acme/limited');
      await ready(page, 'acme/limited');
      await expect(chip).toHaveAttribute('data-sky', 'unknown');
      await expect(chip).toHaveAttribute('aria-label', 'CI unavailable, try again');
      await expect(page.locator('#status')).toBeEmpty();
    });
    await step('winter-preview', async () => {
      await page.goto(`${base}?visit=winter#/vitejs/vite?palette=winter&wx=storm`);
      await ready(page, 'vitejs/vite');
      await expect(chip).toHaveAttribute('aria-label', 'Weather preview, storm');
      await settle(page);
    });
    await step('off', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('switch', { name: /^Weather/ }).click();
      await expect(chip).toBeHidden();
      await page.getByRole('button', { name: 'Close settings' }).click();
      await settle(page);
    });
  },

  birds: async ({ page, step }) => {
    const phone = viewport.startsWith('phone');
    const birdsOnScreen = () => page.evaluate(() => window.__repoTree.view.birdsOnScreen());
    /** Points at (or taps) each bird until one answers: birds behind the crown are hidden by it. */
    const touchABird = async () => {
      const box = await page.locator('#view').boundingBox();
      for (const { x, y } of await birdsOnScreen()) {
        if (phone) {
          await page.touchscreen.tap(box.x + x, box.y + y);
          if (await page.locator('#pr-card').isVisible()) return;
        } else {
          await page.mouse.move(box.x + x, box.y + y);
          await page.waitForTimeout(300);
          if (/^#\d+/.test((await page.locator('#tip').textContent()) ?? '')) return { x, y };
        }
      }
      throw new Error('no bird answered');
    };
    await servePulls(page, 'vitejs/vite', VITE_PULLS);
    let point;
    await step('perched', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await expect.poll(async () => (await birdsOnScreen()).length).toBe(VITE_PULLS.length);
      await settle(page);
    });
    if (!phone) {
      await step('hover', async () => {
        point = await touchABird();
        await expect(page.locator('#tip')).toBeVisible();
      });
    }
    await step('card', async () => {
      if (phone) await touchABird();
      else {
        const box = await page.locator('#view').boundingBox();
        await page.mouse.click(box.x + point.x, box.y + point.y);
      }
      const card = page.locator('#pr-card');
      await expect(card).toBeVisible();
      await expect(card.getByRole('link', { name: 'Open pull request' })).toHaveAttribute(
        'href',
        /^https:\/\/github\.com\/vitejs\/vite\/pull\/\d+$/,
      );
    });
    await step('off', async () => {
      await page.locator('#pr-card').getByRole('button', { name: 'Not now' }).click();
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('switch', { name: /^Show PRs/ }).click();
      await expect.poll(async () => (await birdsOnScreen()).length).toBe(0);
      await page.getByRole('button', { name: 'Close settings' }).click();
      await settle(page);
    });
  },

  hover: async ({ page, step, out }) => {
    const view = page.locator('#view');
    const cursor = () => view.evaluate((el) => el.style.cursor);
    /**
     * Finds a point on what `kind` names, then shoots a close-up round it with the mouse away and
     * with it over the thing, so the pair shows the scene fading around it.
     */
    const closeUp = async (kind, at) => {
      const box = await view.boundingBox();
      const half = 90;
      const clip = {
        x: Math.max(0, box.x + at.x - half),
        y: Math.max(0, box.y + at.y - half),
        width: 2 * half,
        height: 2 * half,
      };
      await page.mouse.move(box.x + 4, box.y + box.height - 4);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/${kind}-off.png`, clip });
      await page.mouse.move(box.x + at.x, box.y + at.y);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/${kind}-on.png`, clip });
      await expect.poll(cursor, `${kind} takes a pointer`).toBe('pointer');
    };
    /** The first point on a coarse grid of the view where `test` holds, run in the page. */
    const scan = (test) =>
      page.evaluate((src) => {
        const t = new Function('view', 'x', 'y', `return (${src})(view, x, y)`);
        const view = window.__repoTree.view;
        const el = document.getElementById('view');
        for (let y = 4; y < el.clientHeight; y += 6)
          for (let x = 4; x < el.clientWidth; x += 6) if (t(view, x, y)) return { x, y };
        return null;
      }, test.toString());
    await servePulls(page, 'vitejs/vite', VITE_PULLS);
    await step('loaded', async () => {
      await page.goto(`${base}?visit=hover#/vitejs/vite?wx=cloudy`);
      await ready(page, 'vitejs/vite');
      await expect
        .poll(() => page.evaluate(() => window.__repoTree.view.birdsOnScreen().length))
        .toBe(VITE_PULLS.length);
      await settle(page);
    });
    await step('bird', async () => {
      const box = await view.boundingBox();
      const birds = await page.evaluate(() => window.__repoTree.view.birdsOnScreen());
      for (const b of birds) {
        await page.mouse.move(box.x + b.x, box.y + b.y);
        await page.waitForTimeout(300);
        if (/^#\d+/.test((await page.locator('#tip').textContent()) ?? '')) {
          return closeUp('bird', b);
        }
      }
      throw new Error('no bird answered');
    });
    await step('rock', async () => {
      const at = await scan((v, x, y) => v.pickAt(x, y)?.rock !== undefined);
      expect(at, 'a rock on screen').not.toBeNull();
      // Into the rock a little, off its edge.
      await closeUp('rock', { x: at.x + 3, y: at.y + 4 });
    });
    await step('cloud', async () => {
      const at = await scan(
        (v, x, y) => typeof v.skyTargetAt(x, y) === 'number' && !v.pickAt(x, y),
      );
      expect(at, 'a cloud on screen').not.toBeNull();
      await closeUp('cloud', { x: at.x + 30, y: at.y + 24 });
      await expect(page.locator('#tip')).toContainText('click for details');
    });
    await step('sun', async () => {
      const at = await scan((v, x, y) => v.skyTargetAt(x, y) === 'sun' && !v.pickAt(x, y));
      expect(at, 'the sun on screen').not.toBeNull();
      await closeUp('sun', { x: at.x + 18, y: at.y + 18 });
      await expect(page.locator('#tip')).toContainText('click for details');
    });
    await step('away', async () => {
      const box = await view.boundingBox();
      await page.mouse.move(box.x + 4, box.y + box.height - 4);
      await expect.poll(cursor).toBe('');
    });
    await step('night', async () => {
      // Dark mode is a stored setting; seed it as a returning visitor would have it.
      await page.evaluate(() =>
        localStorage.setItem(
          'repo-tree:settings',
          JSON.stringify({ quality: 'low', spin: false, theme: 'dark' }),
        ),
      );
      await page.reload();
      await ready(page, 'vitejs/vite');
      await settle(page);
      const at = await scan(
        (v, x, y) => typeof v.skyTargetAt(x, y) === 'number' && !v.pickAt(x, y),
      );
      await closeUp('night-cloud', { x: at.x + 30, y: at.y + 24 });
      const moon = await scan((v, x, y) => v.skyTargetAt(x, y) === 'sun' && !v.pickAt(x, y));
      await closeUp('night-moon', { x: moon.x + 18, y: moon.y + 18 });
    });
  },

  changes: async ({ page, step }) => {
    const sheet = page.locator('#sheet-toggle');
    /** On a phone the legend waits in the sheet: opens it for `check`, then closes it again. */
    const inLegend = async (check) => {
      const phone = await sheet.isVisible();
      if (phone) await sheet.click();
      await check();
      if (phone) await sheet.click();
    };
    const entry = (name) => page.locator('#legend').getByRole('button', { name });
    await step('language', async () => {
      await page.goto(`${base}#/vitejs/vite?colorBy=language`);
      await ready(page, 'vitejs/vite');
      await settle(page);
    });
    await step('changes', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.locator('#color-pick').click();
      await page.locator('#settings').getByRole('radio', { name: 'Changes' }).click();
      await expect(page).toHaveURL(/colorBy=changes/);
      await page.getByRole('button', { name: 'Close settings' }).click();
      await inLegend(async () => {
        await expect(page.locator('#legend-title')).toHaveText('Leaf colors by changes');
        await expect(page.locator('#legend-note')).toHaveText(
          /^How often each file changed, as of /,
        );
      });
      await settle(page);
    });
    await step('constantly', async () => {
      await inLegend(() => entry(/^Constantly/).click());
      await expect(page).toHaveURL(/hl=Constantly/);
      await settle(page);
    });
    await step('linux', async () => {
      await page.goto(`${base}#/torvalds/linux?colorBy=changes`);
      await ready(page, 'torvalds/linux');
      await inLegend(() =>
        expect(page.locator('#legend-title')).toHaveText('Leaf colors by changes'),
      );
      await settle(page);
    });
    await step('no-history', async () => {
      await serveRepo(page, 'acme/widgets');
      await enter(page, 'acme/widgets');
      await ready(page, 'acme/widgets');
      await inLegend(() =>
        expect(page.locator('#legend-note')).toHaveText('History is unavailable for this repo.'),
      );
    });
  },
  activity: async ({ page, step }) => {
    const sheet = page.locator('#sheet-toggle');
    /** On a phone the legend waits in the sheet: opens it for `check`, then closes it again. */
    const inLegend = async (check) => {
      const phone = await sheet.isVisible();
      if (phone) await sheet.click();
      await check();
      if (phone) await sheet.click();
    };
    const entry = (name) => page.locator('#legend').getByRole('button', { name });
    await step('language', async () => {
      await page.goto(`${base}#/torvalds/linux?colorBy=language`);
      await ready(page, 'torvalds/linux');
      await settle(page);
    });
    await step('activity', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.locator('#color-pick').click();
      await page.locator('#settings').getByRole('radio', { name: 'Activity' }).click();
      await page.getByRole('button', { name: 'Close settings' }).click();
      await inLegend(async () => {
        await expect(page.locator('#legend-title')).toHaveText('Leaf colors by activity');
        await expect(page.locator('#legend-note')).toHaveText(/^Last change, as of /);
      });
      await settle(page);
    });
    await step('dead-wood', async () => {
      await inLegend(() => entry(/^Dead wood/).click());
      await expect(page).toHaveURL(/hl=Dead%20wood/);
      await settle(page);
    });
    await step('vite', async () => {
      await page.goto(`${base}#/vitejs/vite?colorBy=activity`);
      await ready(page, 'vitejs/vite');
      await inLegend(() =>
        expect(page.locator('#legend-title')).toHaveText('Leaf colors by activity'),
      );
      await settle(page);
    });
    await step('no-history', async () => {
      await serveRepo(page, 'acme/widgets');
      await enter(page, 'acme/widgets');
      await ready(page, 'acme/widgets');
      await inLegend(() =>
        expect(page.locator('#legend-note')).toHaveText('History is unavailable for this repo.'),
      );
    });
  },

  busiest: async ({ page, step }) => {
    const sheet = page.locator('#sheet-toggle');
    /** On a phone the side panel waits in the sheet: opens it for `check`, then closes it again. */
    const inSide = async (check) => {
      const phone = await sheet.isVisible();
      if (phone) await sheet.click();
      await check();
      if (phone) await sheet.click();
    };
    const note = page.locator('#hot-note');
    const glowing = () => page.evaluate(() => window.__repoTree.view.stats().glowing);
    await step('vite', async () => {
      await page.goto(`${base}#/vitejs/vite`);
      await ready(page, 'vitejs/vite');
      await expect(page.locator('#hot')).toBeHidden();
      expect(await glowing()).toBe(0);
      await settle(page);
    });
    await step('changes', async () => {
      await page.goto(`${base}#/vitejs/vite?colorBy=changes`);
      await ready(page, 'vitejs/vite');
      await inSide(async () => {
        await expect(note).toHaveText(/^The [\d,]+ busiest files glow, from commit history\.$/);
        await expect(page.locator('#hot-files button').first()).toContainText(
          '…/vite/package.json',
        );
      });
      await expect.poll(glowing).toBeGreaterThan(0);
      await settle(page);
    });
    await step('pin-hot-file', async () => {
      const card = page.getByRole('article', { name: /Pinned folder/ });
      await inSide(async () => {
        await page.locator('#hot-files button').first().click();
        await expect(card.locator('.file-card code')).toHaveText('package.json');
      });
      await settle(page);
    });
    await step('with-activity', async () => {
      await page.goto(`${base}#/vitejs/vite?colorBy=activity`);
      await ready(page, 'vitejs/vite');
      await expect(page.locator('#hot')).toBeHidden();
      expect(await glowing()).toBe(0);
      await settle(page);
    });
    await step('linux', async () => {
      await page.goto(`${base}#/torvalds/linux?colorBy=changes`);
      await ready(page, 'torvalds/linux');
      await inSide(() => expect(note).toHaveText(/^The [\d,]+ busiest files glow/));
      await settle(page);
    });
    await step('no-history', async () => {
      await page.goto(`${base}#/vitejs/vite?colorBy=changes`);
      await serveRepo(page, 'acme/widgets');
      await enter(page, 'acme/widgets');
      await ready(page, 'acme/widgets');
      await inSide(() => expect(note).toHaveText('History is unavailable for this repo.'));
      expect(await glowing()).toBe(0);
    });
  },

  owner: async ({ page, step }) => {
    const sheet = page.locator('#sheet-toggle');
    /** On a phone the legend waits in the sheet: opens it for `check`, then closes it again. */
    const inLegend = async (check, close = true) => {
      const phone = await sheet.isVisible();
      if (phone && (await sheet.getAttribute('aria-expanded')) === 'false') await sheet.click();
      await check();
      if (phone && close) await sheet.click();
    };
    const entry = (name) => page.locator('#legend').getByRole('button', { name });
    await step('language', async () => {
      await page.goto(`${base}#/vitejs/vite?colorBy=language`);
      await ready(page, 'vitejs/vite');
      await settle(page);
    });
    await step('owner', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.locator('#color-pick').click();
      await page.locator('#settings').getByRole('radio', { name: 'Owner' }).click();
      await page.getByRole('button', { name: 'Close settings' }).click();
      await inLegend(async () => {
        await expect(page.locator('#legend-title')).toHaveText('Leaf colors by owner');
        await expect(page.locator('#legend-note')).toHaveText(/top commit author/);
      });
      await settle(page);
    });
    await step('highlight', async () => {
      await inLegend(() => entry(/^翠 \/ green/).click());
      await expect(page).toHaveURL(/hl=%E7%BF%A0%20\/%20green/);
      await settle(page);
    });
    await step('card', async () => {
      await inLegend(async () => {
        await page.locator('#folders button', { hasText: /^packages\// }).click();
        const card = page.getByRole('article', { name: 'Pinned folder packages' });
        await expect(card.getByRole('list', { name: 'Top authors' })).toBeVisible();
        await card.getByRole('list', { name: 'Top authors' }).scrollIntoViewIfNeeded();
      }, false);
      await settle(page);
    });
    await step('linux', async () => {
      await page.goto(`${base}#/torvalds/linux?colorBy=owner`);
      await ready(page, 'torvalds/linux');
      await inLegend(async () => {
        await expect(page.locator('#legend-title')).toHaveText('Leaf colors by owner');
        await expect(entry(/^Linus Torvalds/)).toBeVisible();
      }, false);
      // The pointer left over the folder list would preview a folder.
      await page.mouse.move(5, 5);
      await settle(page);
    });
    await step('linux-link', async () => {
      await page.goto(`${base}#/torvalds/linux?colorBy=owner&hl=Alexei%20Starovoitov`);
      await ready(page, 'torvalds/linux');
      await inLegend(() =>
        expect(entry(/^Alexei Starovoitov/)).toHaveAttribute('aria-pressed', 'true'),
      );
      await settle(page);
    });
    await step('no-history', async () => {
      await serveRepo(page, 'acme/widgets');
      await enter(page, 'acme/widgets');
      await ready(page, 'acme/widgets');
      await inLegend(() =>
        expect(page.locator('#legend-note')).toHaveText('History is unavailable for this repo.'),
      );
    });
  },

  'history-compute': async ({ page, context, step }) => {
    const up = await fetch(`${worker}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) throw new Error(`no history Worker on ${worker}; run launch --history first`);
    const phone = viewport.startsWith('phone');
    const dialog = page.getByRole('dialog', { name: /timeline|history/i });
    const scrubber = page.getByRole('group', { name: 'Timeline' });
    const authorized = new Set();
    context.on('request', (req) => {
      if (req.headers()['authorization']) authorized.add(new URL(req.url()).origin);
    });
    await serveRepo(page, 'acme/widgets');
    await serveRepo(page, 'acme/huge', 'torvalds-linux');
    const openTimeline = async (repo) => {
      await enter(page, repo);
      await ready(page, repo);
      await page.locator('#timeline').click();
      await expect(dialog).toBeVisible();
    };
    await step('offer', async () => {
      await page.goto(base);
      await ready(page, 'vitejs/vite');
      await openTimeline('acme/widgets');
      await expect(dialog).toContainText('No timeline yet for acme/widgets');
      await expect(dialog).toContainText('your own GitHub requests, under 1 MB to download');
      await expect(dialog).toContainText('everyone who opens acme/widgets gets it at once');
      if (phone) await expect(dialog).toContainText('This looks like a phone or a small device.');
    });
    await step('decline', async () => {
      await page.getByRole('button', { name: 'Not now' }).click();
      await expect(dialog).toBeHidden();
      await expect(scrubber).toBeHidden();
    });
    await step('big-repo', async () => {
      await openTimeline('acme/huge');
      await expect(dialog).toContainText('This is a big repo.');
      await expect(dialog).toContainText(/about \d+ MB to download/);
      await expect(page.getByRole('button', { name: 'Sign in and compute anyway' })).toBeVisible();
    });
    await step('progress', async () => {
      await page.getByRole('button', { name: 'Not now' }).click();
      await openTimeline('acme/widgets');
      const popup = page.waitForEvent('popup');
      await dialog.getByRole('button', { name: /^Sign in/ }).click();
      const signin = await popup;
      if (!signin.isClosed()) await signin.waitForEvent('close');
      await expect(dialog.locator('progress')).toHaveAttribute('value', /^[1-9]\d?$/);
      await expect(dialog).toContainText(/\d+% · /);
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    });
    await step('timeline', async () => {
      await expect(scrubber).toBeVisible({ timeout: 60_000 });
      await expect(dialog).toBeHidden();
      const res = await fetch(`${worker}/v1/history/acme/widgets?branch=main`);
      expect(res.status).toBe(200);
      const manifest = JSON.parse(res.headers.get('x-history-manifest'));
      expect(manifest).toMatchObject({ repo: 'acme/widgets', branch: 'main', by: 'visitor' });
      expect([...authorized].sort()).toEqual([fake, worker].sort());
      const stored = await page.evaluate(() => JSON.stringify(localStorage));
      expect(stored).not.toMatch(/gho_|token/i);
      await settle(page);
    });
    await step('shared', async () => {
      // Someone else, signed out, in a fresh browser: the Worker's copy, no prompt.
      const other = await context.browser().newContext({ reducedMotion: 'reduce' });
      try {
        const visitor = await other.newPage();
        await quietSettings(visitor);
        await serveRepo(visitor, 'acme/widgets');
        await visitor.goto(`${base}#/acme/widgets`);
        await ready(visitor, 'acme/widgets');
        await visitor.locator('#timeline').click();
        await expect(visitor.getByRole('group', { name: 'Timeline' })).toBeVisible();
        await expect(visitor.getByRole('dialog', { name: /timeline|history/i })).toBeHidden();
      } finally {
        await other.close();
      }
    });
    const storedHead = async () =>
      JSON.parse(
        (await fetch(`${worker}/v1/history/acme/widgets?branch=main`)).headers.get(
          'x-history-manifest',
        ),
      ).head;
    let before = '';
    await step('refresh-offer', async () => {
      // GitHub gets a new commit, and two days pass: the shared history is behind the branch.
      before = await storedHead();
      await fetch(`${fake}/__head`, {
        method: 'POST',
        body: JSON.stringify({ repo: 'acme/widgets', sha: null }),
      });
      await page.addInitScript(() => {
        // The debug flag: the run's breakdown shows in a toast.
        localStorage.setItem('repo-tree:debug', '1');
        const now = Date.now;
        Date.now = () => now() + 2 * 24 * 60 * 60 * 1000;
      });
      await page.goto(`${base}?visit=later#/acme/widgets`);
      await ready(page, 'acme/widgets');
      await page.locator('#timeline').click();
      await expect(dialog).toContainText('The timeline of acme/widgets is out of date');
      await expect(page.getByRole('button', { name: 'Use this one' })).toBeVisible();
    });
    await step('refreshed', async () => {
      await page.getByRole('button', { name: /^Refresh/ }).click();
      await expect(scrubber).toBeVisible({ timeout: 60_000 });
      expect(await storedHead()).not.toBe(before);
      // Brought up to date from the stored history, not computed again.
      await expect(page.locator('#toast')).toContainText(/refreshed: \d+ new, \d+ kept/);
      expect(await page.evaluate(() => window.__repoTree.computeTrace?.refreshed)).toBeTruthy();
      await settle(page);
    });
  },
};

async function journey(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = values.out ?? `.verify/${name}-${viewport}-${stamp}`;
  mkdirSync(out, { recursive: true });
  const { browser, context, page, errors } = await open();
  const steps = [];
  const step = async (id, act) => {
    if (steps.some((s) => !s.ok)) return;
    const shot = `${out}/${String(steps.length + 1).padStart(2, '0')}-${id}.png`;
    try {
      await act();
      steps.push({ id, ok: true, shot });
    } catch (e) {
      steps.push({ id, ok: false, shot, error: String(e).split('\n').slice(0, 6).join('\n') });
    }
    await page.screenshot({ path: shot }).catch(() => {});
    console.log(`${steps.at(-1).ok ? 'ok  ' : 'FAIL'} ${id} ${shot}`);
  };
  try {
    await JOURNEYS[name]({ page, context, step, out });
  } finally {
    await browser.close();
  }
  if (errors.length) steps.push({ id: 'no-page-errors', ok: false, error: errors.join('\n') });
  const report = { journey: name, viewport, url: base, at: new Date().toISOString(), steps };
  writeFileSync(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  for (const s of steps.filter((s) => !s.ok)) console.log(`${s.id}: ${s.error}`);
  console.log(`evidence ${out}`);
  if (steps.some((s) => !s.ok)) process.exitCode = 1;
}

if (command === 'launch') await launch();
else if (command === 'doctor') await doctor();
else if (command === 'cleanup') cleanup();
else if (command in JOURNEYS) await journey(command);
else {
  console.error(
    `unknown command "${command}"; use launch, doctor, cleanup, or ${Object.keys(JOURNEYS).join(', ')}`,
  );
  process.exitCode = 2;
}
