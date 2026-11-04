#!/usr/bin/env node
// Usage: node scripts/perf.mjs [sample] [quality] [weather]   (defaults: linux low, the sample's own)
//        PERF_PORT=<port> picks the preview port (default 4174).
// Builds, serves the production preview, and loads the sample in Chromium on the software
// renderer. Prints the longest main-thread task during load, the average fps over 5 s of
// spin, and the time from navigation to the first tree frame and to the fully grown tree. Then it
// opens the timeline: the longest task while it opens, fps while it plays (spinning), and spin
// fps paused halfway, to set against the full tree's. A weather
// (clear, sunny, cloudy, rain or storm) previews that sky with the link's wx.
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const [sample = 'linux', quality = 'low', weather] = process.argv.slice(2);
/** PERF_PORT keeps parallel worktrees off each other's preview. */
const PORT = Number(process.env.PERF_PORT ?? 4174);
const SPIN_MS = 5000;
/** Inside the 2.6 s grow animation, which redraws the shadow every frame as playback does. */
const GROW_SAMPLE_MS = 2400;

const build = spawnSync('npx', ['vite', 'build'], { stdio: 'ignore' });
if (build.status !== 0) throw new Error('vite build failed');
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  detached: true,
});
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript((q) => {
    localStorage.setItem('repo-tree:settings', JSON.stringify({ quality: q }));
    /** @type {{ start: number; duration: number }[]} */
    const tasks = [];
    Object.assign(window, { __longTasks: tasks });
    new PerformanceObserver((list) => {
      for (const { startTime, duration } of list.getEntries()) {
        tasks.push({ start: startTime, duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  }, quality);
  const repos = {
    dotfiles: 'mathiasbynens/dotfiles',
    vite: 'vitejs/vite',
    linux: 'torvalds/linux',
  };
  const repo = repos[/** @type {keyof typeof repos} */ (sample)];
  const url = `http://localhost:${PORT}/#/${repo}${weather ? `?wx=${weather}` : ''}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url);
      break;
    } catch (error) {
      if (attempt > 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await page.waitForSelector('body[data-ready]', { state: 'attached', timeout: 120_000 });
  const load = await page.evaluate(() => {
    const { __longTasks: tasks, __repoTree: debug } = /** @type {any} */ (window);
    return { tasks, ...debug.timings };
  });

  const spin = await page.evaluate(async (ms) => {
    const { view } = /** @type {any} */ (window).__repoTree;
    const before = view.stats().renders;
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const stats = view.stats();
    return {
      fps: ((stats.renders - before) * 1000) / (performance.now() - start),
      calls: stats.calls,
      triangles: stats.triangles,
    };
  }, SPIN_MS);

  const regrow = await page.evaluate(async (ms) => {
    const { view } = /** @type {any} */ (window).__repoTree;
    view.grow();
    const before = view.stats().renders;
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    return ((view.stats().renders - before) * 1000) / (performance.now() - start);
  }, GROW_SAMPLE_MS);
  await page.waitForTimeout(1000);
  const timeline = await measureTimeline(page);

  const ms = (/** @type {number} */ n) => `${Math.round(n)} ms`;
  console.log(
    `sample ${sample}, quality ${quality}${weather ? `, weather ${weather}` : ''}, 1280x720, Chromium software renderer`,
  );
  const longest = Math.max(0, ...load.tasks.map((/** @type {any} */ t) => t.duration));
  const list = load.tasks.map((/** @type {any} */ t) => `${ms(t.duration)} at ${ms(t.start)}`);
  console.log(`longest main-thread task during load: ${ms(longest)}`);
  console.log(`  every task over 50 ms: ${list.join(', ')}`);
  console.log(`average fps over ${SPIN_MS / 1000} s of spin: ${spin.fps.toFixed(1)}`);
  console.log(`per frame while spinning: ${spin.calls} draw calls, ${spin.triangles} triangles`);
  console.log(
    `average fps while the whole tree regrows (shadow every frame): ${regrow.toFixed(1)}`,
  );
  console.log(`navigation to snapshot loaded: ${ms(load.loaded)}`);
  console.log(`navigation to first tree frame: ${ms(load.grown)}`);
  console.log(`navigation to fully grown tree: ${ms(load.ready)}`);
  if (timeline) {
    console.log(
      `timeline: click to playing ${ms(timeline.open)}, longest task ${ms(timeline.longest)}`,
    );
    console.log(
      `timeline: average fps over ${SPIN_MS / 1000} s of playback: ${timeline.play.toFixed(1)}`,
    );
    console.log(
      `timeline: average fps over ${SPIN_MS / 1000} s of spin halfway: ${timeline.mid.fps.toFixed(1)}, ${timeline.mid.calls} draw calls, ${timeline.mid.triangles} triangles`,
    );
  } else {
    console.log('timeline: none on this build');
  }
} finally {
  await browser.close();
  process.kill(-(preview.pid ?? 0));
}

/**
 * Opens the timeline through its button, which plays from the first commit, and measures it.
 * Null when the build has no timeline.
 * @param {import('playwright').Page} page
 */
async function measureTimeline(page) {
  const button = page.locator('#timeline');
  if ((await button.count()) === 0 || (await button.getAttribute('aria-disabled')) === 'true') {
    return null;
  }
  const clicked = await page.evaluate(() => performance.now());
  await button.click();
  await page.getByRole('button', { name: 'Pause timeline' }).waitFor();
  const opened = await page.evaluate(() => performance.now());
  const longest = await page.evaluate(
    (since) =>
      Math.max(
        0,
        .../** @type {any} */ (window).__longTasks
          .filter((/** @type {any} */ t) => t.start >= since)
          .map((/** @type {any} */ t) => t.duration),
      ),
    clicked,
  );
  const fpsOver = (/** @type {number} */ ms) =>
    page.evaluate(async (ms) => {
      const { view } = /** @type {any} */ (window).__repoTree;
      const before = view.stats().renders;
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, ms));
      const stats = view.stats();
      return {
        fps: ((stats.renders - before) * 1000) / (performance.now() - start),
        calls: stats.calls,
        triangles: stats.triangles,
      };
    }, ms);
  const play = await fpsOver(SPIN_MS);
  await page.getByRole('button', { name: 'Pause timeline' }).click();
  const range = page.getByRole('slider', { name: 'Timeline position' });
  const box = /** @type {{ width: number; height: number }} */ (await range.boundingBox());
  await range.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForTimeout(500);
  const mid = await fpsOver(SPIN_MS);
  return { open: opened - clicked, longest, play: play.fps, mid };
}
