import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { settle } from './view';

const SAMPLES = {
  dotfiles: 'mathiasbynens-dotfiles',
  vite: 'vitejs-vite',
  linux: 'torvalds-linux',
} as const;
const REPOS = { dotfiles: 'mathiasbynens/dotfiles', vite: 'vitejs/vite', linux: 'torvalds/linux' };
type Sample = keyof typeof SAMPLES;
type Label = { path: string; x: number; y: number };

test.use({ reducedMotion: 'reduce' });

function foldersOf(sample: Sample): Set<string> {
  const fixture = JSON.parse(
    gunzipSync(readFileSync(`public/samples/${SAMPLES[sample]}.json.gz`)).toString(),
  ) as { tree: { tree: { path: string; type: string }[] } };
  const folders = new Set(['']);
  for (const { path, type } of fixture.tree.tree) {
    if (type !== 'blob') continue;
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      folders.add(path.slice(0, i));
    }
  }
  return folders;
}

async function open(page: Page, sample: Sample, errors: string[]) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() =>
    localStorage.setItem('repo-tree:settings', JSON.stringify({ spin: false, quality: 'high' })),
  );
  await page.goto(`./#/${REPOS[sample]}`);
  await page.waitForSelector(`body[data-ready="${REPOS[sample]}"]`, {
    state: 'attached',
    timeout: 60_000,
  });
  await page.addStyleTag({ content: '.bar, .title, .side, .controls, #labels { display: none }' });
  await settle(page);
}

/**
 * Shares of the frame that are tree (dark bark or saturated leaves) and vivid leaves, and the
 * first and last rows that hold any of it: the crown's top and the island's underside.
 */
async function measure(page: Page) {
  const png = await page.screenshot();
  return page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
    let tree = 0;
    let vivid = 0;
    let atSides = 0;
    let top = height;
    let bottom = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;
      const hi = Math.max(r, g, b);
      const saturation = hi === 0 ? 0 : (hi - Math.min(r, g, b)) / hi;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const isVivid = saturation > 0.35;
      if (!isVivid && luma > 0.6) continue;
      tree++;
      if (isVivid) vivid++;
      const x = (i / 4) % width;
      if (x < width * 0.01 || x >= width * 0.99) atSides++;
      const y = Math.floor(i / 4 / width);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    const pixels = width * height;
    return { tree: tree / pixels, vivid: vivid / pixels, atSides, top, bottom };
  }, png.toString('base64'));
}

const labelsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __repoTree: { labels: Label[] } }).__repoTree.labels);
const hovered = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __repoTree: { hovered: string | null } }).__repoTree.hovered,
  );

/**
 * Hovers the label's anchor, then the pixels around it. The anchor is a twig tip, a few pixels
 * wide on screen, and the island sits just below the lowest limbs, so rasterization differences
 * between GPUs can put the exact point a pixel off the twig.
 */
async function hoverNear(page: Page, at: { x: number; y: number }): Promise<string | null> {
  const offsets = [
    [0, 0],
    [0, -4],
    [-4, 0],
    [4, 0],
    [0, 4],
    [-4, -4],
    [4, -4],
    [-4, 4],
    [4, 4],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.move(at.x + dx!, at.y + dy!);
    try {
      await expect.poll(() => hovered(page), { timeout: 1_500 }).not.toBeNull();
      return hovered(page);
    } catch {
      // Missed the twig: try the next pixel over.
    }
  }
  return null;
}

for (const sample of Object.keys(SAMPLES) as Sample[]) {
  test(`grows the ${sample} tree in frame`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    await open(page, sample, errors);

    const path = testInfo.outputPath(`${sample}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`${sample}.png`, { path, contentType: 'image/png' });
    const { tree, atSides } = await measure(page);
    expect(tree, 'share of the frame covered by the tree').toBeGreaterThan(0.03);
    expect(atSides, 'tree pixels touching the left or right edge').toBe(0);
    expect(errors).toEqual([]);
  });
}

test('hovering a limb reports a real folder of the sample', async ({ page }) => {
  const errors: string[] = [];
  await open(page, 'vite', errors);
  const folders = foldersOf('vite');

  const picked: string[] = [];
  for (const label of await labelsOf(page)) {
    const path = await hoverNear(page, label);
    if (path === null) throw new Error(`no limb within a few pixels of the ${label.path} label`);
    expect(folders, `hovered ${path}`).toContain(path);
    if (path === label.path || path.startsWith(`${label.path}/`)) picked.push(label.path);
  }
  expect(picked.length, 'labels whose own limb was picked').toBeGreaterThan(0);

  await page.mouse.move(2, 2);
  await expect.poll(() => hovered(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('a repo with more files grows a taller tree on the same island', async ({ page }) => {
  // Two samples load in turn, one WebGL page at a time; a busy software GL needs the room.
  test.setTimeout(90_000);
  const errors: string[] = [];
  const shown = async (sample: Sample) => {
    await open(page, sample, errors);
    return measure(page);
  };
  const small = await shown('dotfiles');
  const big = await shown('linux');
  const height = page.viewportSize()!.height;
  expect(Math.abs(big.bottom - small.bottom), 'the island stays put').toBeLessThan(height * 0.02);
  expect(big.bottom - big.top, 'linux stands taller than dotfiles').toBeGreaterThan(
    (small.bottom - small.top) * 1.2,
  );
  expect(errors).toEqual([]);
});

test('hovering a folder fades the rest of the tree', async ({ page }) => {
  const errors: string[] = [];
  await open(page, 'linux', errors);
  const before = await measure(page);

  const drivers = (await labelsOf(page)).find((l) => l.path === 'drivers')!;
  await page.mouse.move(drivers.x, drivers.y);
  await expect.poll(() => hovered(page)).not.toBeNull();
  const during = await measure(page);
  expect(during.vivid, 'vivid share while a folder is hovered').toBeLessThan(before.vivid * 0.6);
  expect(during.vivid, 'the hovered folder stays vivid').toBeGreaterThan(0);

  await page.mouse.move(2, 2);
  await expect.poll(() => hovered(page)).toBeNull();
  const after = await measure(page);
  expect(after.vivid).toBeCloseTo(before.vivid, 3);
  expect(errors).toEqual([]);
});
