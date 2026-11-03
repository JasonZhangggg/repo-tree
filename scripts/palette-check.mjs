#!/usr/bin/env node
// Usage: node scripts/palette-check.mjs [--render] [--port 4186]
// Prints, for each palette, the smallest CIEDE2000 difference between leaf colors as they show on
// a typical leaf (litColor in src/render/color.ts): among the first six slots, among all named
// slots, from the shared rest color, and from the bark and the sky. It also prints how far the
// per-leaf shade jitter moves a slot. With --render it grows torvalds/linux by folder on the dev
// server, reads back the pixels of each slot's leaves (diffing a frame against one with that slot
// blacked out), and prints the same table from the real pixels plus each slot's model error.
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

const { values } = parseArgs({
  options: {
    render: { type: 'boolean', default: false },
    port: { type: 'string', default: '4186' },
  },
});
process.chdir(new URL('..', import.meta.url).pathname);

const server = await createServer({
  server: { port: Number(values.port), strictPort: true },
  logLevel: 'error',
});
const { PALETTES } = /** @type {typeof import('../src/render/palette')} */ (
  await server.ssrLoadModule('/src/render/palette.ts')
);
const { deltaE, hexToLinear, linearToHex, litColor } =
  /** @type {typeof import('../src/render/color')} */ (
    await server.ssrLoadModule('/src/render/color.ts')
  );
const { SHADE } = /** @type {typeof import('../src/grow/grow')} */ (
  await server.ssrLoadModule('/src/grow/grow.ts')
);

/** @typedef {{ named: string[]; rest: string; bark: string }} Shown */

const fmt = (/** @type {number} */ n) => n.toFixed(1).padStart(5);

/** The smallest difference among `colors`, and which pair has it. */
function closest(/** @type {string[]} */ colors, /** @type {string[]} */ names) {
  let best = { de: Infinity, pair: '' };
  colors.forEach((a, i) =>
    colors.slice(i + 1).forEach((b, k) => {
      const de = deltaE(a, b);
      if (de < best.de) best = { de, pair: `${names[i]}~${names[i + 1 + k]}` };
    }),
  );
  return best;
}

/**
 * The shader's offsetHSL on a linear color, so the jitter spread is measured the way leaves
 * apply it.
 * @param {[number, number, number]} c
 */
function offsetHSL(c, /** @type {number} */ dh, /** @type {number} */ dl) {
  const hi = Math.max(...c);
  const lo = Math.min(...c);
  let l = (hi + lo) / 2;
  const d = hi - lo;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const [r, g, b] = c;
  const h =
    d === 0
      ? 0
      : hi === r
        ? (((g - b) / d + 6) % 6) / 6
        : hi === g
          ? ((b - r) / d + 2) / 6
          : ((r - g) / d + 4) / 6;
  l = Math.min(1, Math.max(0, l * (1 + dl)));
  const hue = (((h + dh) % 1) + 1) % 1;
  return /** @type {[number, number, number]} */ (
    [0, 4, 2].map((k) => {
      const ch = Math.min(1, Math.max(0, Math.abs(((hue * 6 + k) % 6) - 3) - 1));
      return l + s * (ch - 0.5) * (1 - Math.abs(2 * l - 1));
    })
  );
}

/** The furthest a leaf's shade jitter moves a slot's color. */
function jitter(
  /** @type {string} */ hex,
  /** @type {import('../src/render/palette').Palette} */ p,
) {
  const base = litColor(hex, p);
  let worst = 0;
  for (const dh of [-SHADE.hue, SHADE.hue])
    for (const dl of [-SHADE.light - SHADE.facet, SHADE.light + SHADE.facet]) {
      const moved = linearToHex(offsetHSL(hexToLinear(hex), dh, dl));
      worst = Math.max(worst, deltaE(base, litColor(moved, p)));
    }
  return worst;
}

/**
 * One table row per palette from the colors each slot shows as.
 * @param {string} label
 * @param {Record<import('../src/render/palette').PaletteId, Shown>} shown
 */
function report(label, shown) {
  console.log(`\n${label}`);
  console.log('palette   top6 (pair)            named (pair)           rest  bark   sky  jitter');
  for (const p of Object.values(PALETTES)) {
    const { named, rest, bark } = shown[p.id];
    const names = named.map((_, i) => String(i + 1));
    const top = closest(named.slice(0, 6), names);
    const all = closest(named, names);
    const vs = (/** @type {string} */ c) => Math.min(...named.map((s) => deltaE(s, c)));
    const sky = Math.min(
      ...[...named, rest].map((s) => Math.min(deltaE(s, p.sky.center), deltaE(s, p.sky.edge))),
    );
    const spread = Math.max(...[...p.leaves, p.rest].map((h) => jitter(h, p)));
    console.log(
      `${p.id.padEnd(8)} ${fmt(top.de)} ${top.pair.padEnd(6)}          ${fmt(all.de)} ${all.pair.padEnd(6)}         ${fmt(vs(rest))} ${fmt(vs(bark))} ${fmt(sky)} ${fmt(spread)}`,
    );
  }
}

/** @param {import('../src/render/palette').Palette} p */
const lit = (p) => ({
  named: p.leaves.map((hex) => litColor(hex, p)),
  rest: litColor(p.rest, p),
  bark: litColor(p.bark, p),
});
const model = {
  autumn: lit(PALETTES.autumn),
  spring: lit(PALETTES.spring),
  summer: lit(PALETTES.summer),
  winter: lit(PALETTES.winter),
};
report('model (litColor on a typical leaf)', model);

if (values.render) {
  await server.listen();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const rendered = { ...model };
  const errors = /** @type {string[]} */ ([]);
  try {
    for (const p of Object.values(PALETTES)) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() =>
        localStorage.setItem('repo-tree:settings', JSON.stringify({ spin: false, quality: 'low' })),
      );
      await page.route('https://api.github.com/**', (r) => r.abort());
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(
        `http://localhost:${values.port}/#/torvalds/linux?palette=${p.id}&colorBy=folder`,
      );
      await page.waitForSelector('body[data-ready="torvalds/linux"]', {
        state: 'attached',
        timeout: 120_000,
      });
      await page.addStyleTag({
        content: '.bar, .title, .side, .controls, #labels { display: none }',
      });
      await page.waitForTimeout(3000);
      const shot = async () => (await page.screenshot()).toString('base64');
      const before = await shot();
      /** Sunlit color of the pixels that change when `slot` turns black. */
      const sample = async (/** @type {number | 'bark'} */ slot) => {
        await page.evaluate(
          async ({ id, slot, url }) => {
            const { PALETTES } = await import(url);
            const p = /** @type {{ leaves: string[]; rest: string; bark: string }} */ (
              PALETTES[id]
            );
            const saved = { leaves: [...p.leaves], rest: p.rest, bark: p.bark };
            if (slot === 'bark') p.bark = '#000000';
            else if (slot === p.leaves.length) p.rest = '#000000';
            else p.leaves[slot] = '#000000';
            const { view } = /** @type {any} */ (window).__repoTree;
            view.setPalette(id);
            Object.assign(p, saved);
            const frame = () => new Promise((r) => requestAnimationFrame(r));
            for (let i = 0; i < 3; i++) await frame();
          },
          { id: p.id, slot, url: '/src/render/palette.ts' },
        );
        const after = await shot();
        const pixels = await page.evaluate(
          async ({ a, b }) => {
            const decode = async (/** @type {string} */ s) => {
              const img = new Image();
              img.src = `data:image/png;base64,${s}`;
              await img.decode();
              const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d');
              if (!ctx) throw new Error('no 2d context');
              ctx.drawImage(img, 0, 0);
              return ctx.getImageData(0, 0, img.width, img.height).data;
            };
            const [x, y] = /** @type {any[]} */ ([await decode(a), await decode(b)]);
            const out = [];
            for (let i = 0; i < x.length; i += 4) {
              const diff =
                Math.abs(x[i] - y[i]) +
                Math.abs(x[i + 1] - y[i + 1]) +
                Math.abs(x[i + 2] - y[i + 2]);
              if (diff > 60 && y[i] + y[i + 1] + y[i + 2] < 60)
                out.push([x[i], x[i + 1], x[i + 2]]);
            }
            return out;
          },
          { a: before, b: after },
        );
        if (pixels.length < 40) return null;
        const luma = (/** @type {number[]} */ [r = 0, g = 0, b = 0]) =>
          0.2126 * r + 0.7152 * g + 0.0722 * b;
        pixels.sort((u, v) => luma(u) - luma(v));
        const bright = pixels.slice(Math.floor(pixels.length / 2));
        const median = [0, 1, 2].map(
          (k) => bright.map((c) => c[k] ?? 0).sort((u, v) => u - v)[bright.length >> 1] ?? 0,
        );
        return `#${median.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      };
      const want = model[p.id];
      const named = [];
      for (const [k, hex] of want.named.entries()) named.push((await sample(k)) ?? hex);
      const rest = (await sample(named.length)) ?? want.rest;
      rendered[p.id] = { named, rest, bark: (await sample('bark')) ?? want.bark };
      const err = [...named, rest].map((s, k) => deltaE(s, [...want.named, want.rest][k] ?? s));
      errors.push(`${p.id.padEnd(8)} ${err.map(fmt).join('')}   ${[...named, rest].join(' ')}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  report(
    "rendered (median of the brighter half of each slot's leaf pixels, torvalds/linux)",
    rendered,
  );
  console.log('\nmodel error per slot (ΔE between litColor and the rendered pixels)');
  for (const line of errors) console.log(line);
}
await server.close();
