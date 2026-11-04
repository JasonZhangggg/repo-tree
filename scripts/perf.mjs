#!/usr/bin/env node
// Usage: node scripts/perf.mjs [sample] [quality] [weather]   (defaults: linux low, the sample's own)
// Builds, serves the production preview, and loads the sample in Chromium on the software
// renderer. Prints the longest main-thread task during load, the average fps over 5 s of
// spin, and the time from navigation to the first tree frame and to the fully grown tree. A weather
// (clear, sunny, cloudy, rain or storm) previews that sky with the link's wx.
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const [sample = 'linux', quality = 'low', weather] = process.argv.slice(2);
const PORT = 4174;
const SPIN_MS = 5000;

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
  console.log(`navigation to snapshot loaded: ${ms(load.loaded)}`);
  console.log(`navigation to first tree frame: ${ms(load.grown)}`);
  console.log(`navigation to fully grown tree: ${ms(load.ready)}`);
} finally {
  await browser.close();
  process.kill(-(preview.pid ?? 0));
}
