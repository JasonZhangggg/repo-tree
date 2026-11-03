#!/usr/bin/env node
// @ts-nocheck: walks untyped Chrome trace JSON; types would be casts on every line.
// Usage: node scripts/trace.mjs [--runs 3] [--out dir] [--port 4176] [--no-build]
//          [--spin-ms 5000] [--all-traces] [sample:quality ...]          (default: linux:low)
// Builds the production preview with source maps, then for each sample:quality and run opens a
// fresh Chromium on the software renderer, records a Chrome performance trace (with the V8
// sampling profiler) from navigation through the grown tree and a spin, and attributes time:
//   - every main-thread task over 50 ms during load, split by trace event (self time) and by
//     JS function (sampled self time, mapped through the source maps to src/ lines);
//   - the spin window: renders per second, how busy each thread was, and where the renderer
//     main thread and the GPU process spent their time.
// Writes <out>/<sample>-<quality>-0.json (the first run's raw trace; --all-traces keeps every
// run's) and <out>/summary.json, and prints
// medians per sample:quality. The longtask PerformanceObserver figure matches scripts/perf.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { SourceMapConsumer } from 'source-map-js';

process.chdir(new URL('../', import.meta.url).pathname);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string', default: '3' },
    out: { type: 'string', default: `.verify/trace-${new Date().toISOString().slice(0, 19)}` },
    port: { type: 'string', default: '4176' },
    'no-build': { type: 'boolean', default: false },
    'spin-ms': { type: 'string', default: '5000' },
    'all-traces': { type: 'boolean', default: false },
  },
});
const configs = (positionals.length ? positionals : ['linux:low']).map((c) => {
  const [sample = 'linux', quality = 'low'] = c.split(':');
  return { sample, quality };
});
const RUNS = Number(values.runs);
const SPIN_MS = Number(values['spin-ms']);
const PORT = Number(values.port);
const OUT = values.out;
mkdirSync(OUT, { recursive: true });
const REPOS = {
  dotfiles: 'mathiasbynens/dotfiles',
  vite: 'vitejs/vite',
  linux: 'torvalds/linux',
};
const CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'loading',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'gpu',
  'cc',
  'viz',
];

if (!values['no-build']) {
  const build = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build', '--sourcemap'], {
    stdio: 'ignore',
  });
  if (build.status !== 0) throw new Error('vite build failed');
}
const preview = spawn(
  'node',
  ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore', detached: true },
);

/** Maps a profiler frame in dist/assets to `src/file.ts:line`, when a source map is there. */
const maps = new Map();
function where(frame) {
  const { url, lineNumber, columnNumber, functionName } = frame;
  const name = functionName || '(anonymous)';
  if (!url) return name;
  const file = url.replace(/^https?:\/\/[^/]+\//, '');
  const local = `dist/${file}`;
  if (!maps.has(local)) {
    maps.set(
      local,
      existsSync(`${local}.map`)
        ? new SourceMapConsumer(JSON.parse(readFileSync(`${local}.map`, 'utf8')))
        : null,
    );
  }
  const map = maps.get(local);
  if (!map || lineNumber < 0) return `${name} ${file}:${lineNumber + 1}`;
  const pos = map.originalPositionFor({ line: lineNumber + 1, column: columnNumber });
  if (!pos.source) return `${name} ${file}:${lineNumber + 1}`;
  const source = pos.source.replace(/^.*node_modules\//, '').replace(/^(\.\.\/)+/, '');
  return `${pos.name ?? name} ${source}:${pos.line}`;
}

const round = (n) => Math.round(n * 10) / 10;
const top = (record, n) =>
  Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => [k, round(v)]);

function analyze(trace) {
  const events = trace.traceEvents ?? trace;
  const threadNames = new Map();
  const processNames = new Map();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args.name);
    if (e.name === 'process_name') processNames.set(e.pid, e.args.name);
  }
  const byThread = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    const key = `${e.pid}:${e.tid}`;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(e);
  }
  const busiest = (name) => {
    let best = null;
    let most = -1;
    for (const [key, list] of byThread) {
      if (threadNames.get(key) !== name) continue;
      const total = list.reduce((s, e) => s + (e.name === 'RunTask' ? e.dur : 0), 0);
      if (total > most) [best, most] = [key, total];
    }
    return best;
  };
  const main = busiest('CrRendererMain');
  const gpu = busiest('CrGpuMain');
  const [mainPid, mainTid] = main.split(':').map(Number);

  const marks = {};
  for (const e of events) {
    if (e.pid !== mainPid) continue;
    if (
      e.name === 'navigationStart' &&
      String(e.args?.data?.documentLoaderURL).includes('localhost')
    )
      marks.nav ??= e.ts;
    if (
      e.name?.startsWith('trace:') &&
      (e.ph === 'R' || e.ph === 'I' || e.ph === 'n' || e.ph === 'b')
    )
      marks[e.name.slice(6)] ??= e.ts;
  }
  const nav = marks.nav ?? Math.min(...byThread.get(main).map((e) => e.ts));

  // Self time per event name inside [start, end) on a thread, nesting by containment.
  const selfByName = (key, start, end) => {
    const list = (byThread.get(key) ?? [])
      .filter((e) => e.ts >= start && e.ts < end)
      .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const self = {};
    const stack = [];
    for (const e of list) {
      while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
      const parent = stack.at(-1);
      if (parent) self[parent.name] -= Math.min(e.dur, parent.ts + parent.dur - e.ts) / 1000;
      self[e.name] = (self[e.name] ?? 0) + e.dur / 1000;
      stack.push(e);
    }
    return self;
  };
  const busy = (key, start, end) =>
    (byThread.get(key) ?? [])
      .filter((e) => e.name === 'RunTask' && e.ts >= start && e.ts < end)
      .reduce((s, e) => s + e.dur, 0) / 1000;

  // CPU profile samples on the main thread, with absolute timestamps.
  const nodes = new Map();
  const samples = [];
  const starts = new Map();
  for (const e of events) {
    if (e.name === 'Profile' && e.pid === mainPid && e.tid === mainTid) starts.set(e.id, e.args.data.startTime);
  }
  for (const e of events) {
    if (e.name !== 'ProfileChunk' || e.pid !== mainPid || !starts.has(e.id)) continue;
    const profile = e.args.data.cpuProfile ?? {};
    for (const n of profile.nodes ?? [])
      nodes.set(`${e.id}:${n.id}`, { ...n, key: `${e.id}:${n.id}` });
    let t = starts.get(e.id);
    const deltas = e.args.data.timeDeltas ?? [];
    (profile.samples ?? []).forEach((id, i) => {
      t += deltas[i] ?? 0;
      samples.push({ ts: t, node: `${e.id}:${id}` });
    });
    starts.set(e.id, t);
  }
  samples.sort((a, b) => a.ts - b.ts);
  const parentOf = new Map();
  for (const n of nodes.values()) {
    for (const c of n.children ?? []) parentOf.set(n.key.replace(/:\d+$/, `:${c}`), n.key);
    if (n.parent !== undefined) parentOf.set(n.key, n.key.replace(/:\d+$/, `:${n.parent}`));
  }
  const IDLE = new Set(['(idle)', '(program)', '(root)', '(garbage collector)']);
  const jsByFunction = (start, end) => {
    const self = {};
    const inclusive = {};
    const inWindow = samples.filter((s) => s.ts >= start && s.ts < end);
    for (let i = 0; i < inWindow.length; i++) {
      const s = inWindow[i];
      const next = inWindow[i + 1]?.ts ?? s.ts;
      const ms = Math.min(next - s.ts, 2000) / 1000;
      const node = nodes.get(s.node);
      if (!node) continue;
      const fn = node.callFrame.functionName;
      if (fn === '(idle)') continue;
      const label = IDLE.has(fn) ? fn : where(node.callFrame);
      self[label] = (self[label] ?? 0) + ms;
      const seen = new Set();
      for (let k = s.node; k; k = parentOf.get(k)) {
        const n = nodes.get(k);
        if (!n || IDLE.has(n.callFrame.functionName)) continue;
        const l = where(n.callFrame);
        if (seen.has(l)) continue;
        seen.add(l);
        inclusive[l] = (inclusive[l] ?? 0) + ms;
      }
    }
    return { self: top(self, 12), inclusive: top(inclusive, 12) };
  };

  const end = marks.ready ?? Infinity;
  const longTasks = byThread
    .get(main)
    .filter((e) => e.name === 'RunTask' && e.dur > 50_000 && e.ts >= nav && e.ts <= end)
    .map((e) => ({
      start: round((e.ts - nav) / 1000),
      duration: round(e.dur / 1000),
      events: top(selfByName(main, e.ts, e.ts + e.dur), 10),
      js: jsByFunction(e.ts, e.ts + e.dur),
    }));

  let spin = null;
  if (marks['spin-start'] && marks['spin-end']) {
    const [s, t] = [marks['spin-start'], marks['spin-end']];
    const ms = (t - s) / 1000;
    const threads = {};
    for (const [key, name] of threadNames) {
      const b = busy(key, s, t);
      if (b > ms * 0.02) {
        const pid = Number(key.split(':')[0]);
        threads[`${processNames.get(pid) ?? pid}/${name}`] = round((100 * b) / ms);
      }
    }
    const frames = byThread
      .get(main)
      .filter((e) => e.name === 'FireAnimationFrame' && e.ts >= s && e.ts < t).length;
    spin = {
      windowMs: round(ms),
      animationFrames: frames,
      busyPercent: threads,
      mainEvents: top(selfByName(main, s, t), 12).map(([k, v]) => [k, round(v / frames)]),
      mainJs: jsByFunction(s, t).self.map(([k, v]) => [k, round(v / frames)]),
      gpuEvents: gpu ? top(selfByName(gpu, s, t), 12).map(([k, v]) => [k, round(v / frames)]) : [],
    };
  }
  return { mainThread: main, longTasks, spin };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
};

async function runOnce({ sample, quality }, i) {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript((q) => {
      localStorage.setItem('repo-tree:settings', JSON.stringify({ quality: q }));
      const tasks = [];
      Object.assign(window, { __longTasks: tasks });
      new PerformanceObserver((list) => {
        for (const { startTime, duration } of list.getEntries()) {
          tasks.push({ start: startTime, duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    }, quality);
    const url = `http://localhost:${PORT}/#/${REPOS[sample]}`;
    for (let attempt = 0; ; attempt++) {
      const up = await fetch(`http://localhost:${PORT}/`).then(
        (r) => r.ok,
        () => false,
      );
      if (up) break;
      if (attempt > 100) throw new Error('preview did not answer');
      await new Promise((r) => setTimeout(r, 200));
    }
    await browser.startTracing(page, { categories: CATEGORIES });
    await page.goto(url);
    await page.waitForSelector('body[data-ready]', { state: 'attached', timeout: 120_000 });
    const load = await page.evaluate(() => {
      performance.mark('trace:ready');
      const { __longTasks: tasks, __repoTree: debug } = window;
      return { tasks, ...debug.timings };
    });
    const spin = await page.evaluate(async (ms) => {
      const { view } = window.__repoTree;
      performance.mark('trace:spin-start');
      const before = view.stats().renders;
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, ms));
      const stats = view.stats();
      performance.mark('trace:spin-end');
      return {
        fps: ((stats.renders - before) * 1000) / (performance.now() - start),
        calls: stats.calls,
        triangles: stats.triangles,
      };
    }, SPIN_MS);
    const buffer = await browser.stopTracing();
    const trace = JSON.parse(buffer.toString());
    const name = `${OUT}/${sample}-${quality}-${i}.json`;
    if (i === 0 || values['all-traces']) writeFileSync(name, buffer);
    const longest = Math.max(0, ...load.tasks.map((t) => t.duration));
    return {
      sample,
      quality,
      run: i,
      trace: name,
      longestTask: round(longest),
      tasksOver50: load.tasks.map((t) => [round(t.start), round(t.duration)]),
      spinFps: round(spin.fps),
      calls: spin.calls,
      triangles: spin.triangles,
      loaded: round(load.loaded),
      firstFrame: round(load.grown),
      ready: round(load.ready),
      ...analyze(trace),
    };
  } finally {
    await browser.close();
  }
}

const results = [];
try {
  for (const config of configs) {
    for (let i = 0; i < RUNS; i++) {
      const r = await runOnce(config, i);
      results.push(r);
      console.error(
        `${r.sample} ${r.quality} #${i}: longest ${r.longestTask} ms, spin ${r.spinFps} fps`,
      );
    }
  }
} finally {
  process.kill(-(preview.pid ?? 0));
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 2));
console.log(`runs per config: ${RUNS}; raw traces and summary.json in ${OUT}`);
console.log('sample   quality  longest task (median, runs)        spin fps (median, runs)');
for (const { sample, quality } of configs) {
  const rs = results.filter((r) => r.sample === sample && r.quality === quality);
  const lt = rs.map((r) => r.longestTask);
  const fps = rs.map((r) => r.spinFps);
  console.log(
    `${sample.padEnd(8)} ${quality.padEnd(8)} ${String(median(lt)).padStart(6)} ms [${lt.join(', ')}]`.padEnd(
      52,
    ) + `${median(fps).toFixed(1)} [${fps.join(', ')}]`,
  );
}
const brief = (pairs, n) =>
  pairs
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
for (const r of results) {
  console.log(
    `\n${r.sample} ${r.quality} #${r.run}: longest ${r.longestTask} ms, spin ${r.spinFps} fps`,
  );
  for (const t of r.longTasks) {
    console.log(`  task ${t.duration} ms at ${t.start} ms`);
    console.log(`    events: ${brief(t.events, 3)}`);
    console.log(`    js self: ${brief(t.js.self, 3)}`);
    console.log(
      `    js incl: ${brief(
        t.js.inclusive.filter(([k]) => k.includes('src/')),
        3,
      )}`,
    );
  }
  if (r.spin) {
    const busy = Object.entries(r.spin.busyPercent).map(([k, v]) => `${k} ${v}%`);
    console.log(`  spin busy: ${busy.join(', ')}`);
    console.log(`  spin main ms/frame: ${brief(r.spin.mainEvents, 4)}`);
  }
}
