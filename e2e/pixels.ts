import type { Page } from '@playwright/test';

export type Box = { x: number; y: number; width: number; height: number };

/**
 * Where the tree shows in a screenshot of `clip` (the whole page if omitted): its share of the
 * pixels, and the page-pixel boxes it reaches into among `probes`. Tree pixels are dark bark
 * or saturated leaves; the pale sky, the soft ground shadow and white panels are not.
 */
export async function treePixels(page: Page, clip?: Box, probes: Box[] = []) {
  const png = await page.screenshot(clip ? { clip } : {});
  const origin = clip ?? { x: 0, y: 0 };
  return page.evaluate(
    async ({ base64, origin, probes }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      const scale = devicePixelRatio;
      const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const { data, width } = ctx.getImageData(0, 0, img.width, img.height);
      let tree = 0;
      const hits = probes.map(() => 0);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]! / 255;
        const g = data[i + 1]! / 255;
        const b = data[i + 2]! / 255;
        const hi = Math.max(r, g, b);
        const saturation = hi === 0 ? 0 : (hi - Math.min(r, g, b)) / hi;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (saturation <= 0.35 && luma > 0.6) continue;
        tree++;
        const x = origin.x + ((i / 4) % width) / scale;
        const y = origin.y + Math.floor(i / 4 / width) / scale;
        probes.forEach((p, k) => {
          if (x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height) hits[k]!++;
        });
      }
      return { share: tree / (data.length / 4), hits };
    },
    { base64: png.toString('base64'), origin, probes },
  );
}
