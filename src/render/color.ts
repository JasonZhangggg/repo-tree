import type { Palette } from './palette';

type RGB = [number, number, number];

/**
 * Light intensities the tree view uses. `sky` is the mock's hemisphere light plus its room
 * environment at 0.3. Generating that environment blocked the main thread for 0.4 to 1.7 s on a
 * software GL, so a stronger hemisphere stands in for its diffuse fill; the lumen tree's trunk
 * and leaf colors match the mock within 3%.
 */
export const LIGHT = {
  sky: 0.7 * Math.PI + 2.4,
  key: 2.1 * Math.PI,
  fill: 0.45 * Math.PI,
  fillColor: '#dfe8ff',
};

/**
 * The share of each light a typical visible leaf receives. Most of the crown sits in its own
 * shadow, so the hemisphere does most of the work. Fitted to leaf pixels read back from the
 * rendered tree by `scripts/palette-check.mjs --render`.
 */
const REACH = { key: 0.1, fill: 0.21, sky: 0.76 };

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSRGB = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToLinear(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [toLinear((n >> 16) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}

export function linearToHex(rgb: RGB): string {
  const byte = (c: number) => Math.round(Math.min(1, Math.max(0, toSRGB(c))) * 255);
  return `#${rgb.map((c) => byte(c).toString(16).padStart(2, '0')).join('')}`;
}

/** three.js's ACESFilmicToneMapping at exposure 1, on linear sRGB. */
function aces([r, g, b]: RGB): RGB {
  const s = 1 / 0.6;
  const x = s * (0.59719 * r + 0.35458 * g + 0.04823 * b);
  const y = s * (0.076 * r + 0.90834 * g + 0.01566 * b);
  const z = s * (0.0284 * r + 0.13383 * g + 0.83777 * b);
  const fit = (v: number) =>
    (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const [u, v, w] = [fit(x), fit(y), fit(z)];
  return [
    1.60475 * u - 0.53108 * v - 0.07367 * w,
    -0.10208 * u + 1.10813 * v - 0.00605 * w,
    -0.00327 * u - 0.07276 * v + 1.07602 * w,
  ];
}

/** The color a typical leaf of albedo `hex` shows on screen under `palette`'s lights. */
export function litColor(hex: string, palette: Palette): string {
  const albedo = hexToLinear(hex);
  const key = hexToLinear(palette.light.key);
  const fill = hexToLinear(LIGHT.fillColor);
  const sky = hexToLinear(palette.light.sky);
  const lit = albedo.map(
    (a, i) =>
      (a *
        (key[i]! * LIGHT.key * REACH.key +
          fill[i]! * LIGHT.fill * REACH.fill +
          sky[i]! * LIGHT.sky * REACH.sky)) /
      Math.PI,
  ) as RGB;
  return linearToHex(aces(lit));
}

function lab(hex: string): RGB {
  const [r, g, b] = hexToLinear(hex);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 color difference between two sRGB hex colors. About 2 is a just-noticeable step. */
export function deltaE(a: string, b: string): number {
  const [L1, a1, b1] = lab(a);
  const [L2, a2, b2] = lab(b);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + 25 ** 7)));
  const ap1 = a1 * (1 + G);
  const ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hue = (bb: number, ap: number) => {
    const h = Math.atan2(bb, ap) / rad;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lm = (L1 + L2) / 2;
  const Cm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hm /= 2;
    else hm = hp1 + hp2 < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Cm7p = Cm ** 7;
  const RC = 2 * Math.sqrt(Cm7p / (Cm7p + 25 ** 7));
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cm;
  const SH = 1 + 0.015 * Cm * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
