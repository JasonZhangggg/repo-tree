import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import { SPAN } from '../timeline/timeline';

/**
 * Shader hooks shared by every tree material, ported from the approved mock. Each vertex moves
 * from `aBase` (the point it grows out of) to its position while `uGrow` crosses its `aT`
 * window. On the timeline it also waits for its birth: it grows in as `uTime` crosses `aBorn`
 * plus its `aT` window scaled to `uSpan`, so a branch extends before its children and leaves.
 * Fragments whose node id `aId` falls outside `uSel` fade toward `uFade`, and so do bark and
 * every leaf outside color slot `uCategory` while it is not -1. Those leaves fade harder
 * and go grey, and the leaves inside that slot deepen, so any category stands out, pale or gold.
 */
export const ALWAYS = 1e6;
export const treeUniforms = {
  uGrow: { value: 1 },
  /** The timeline's cursor; far past any birth while the timeline is closed. */
  uTime: { value: ALWAYS },
  uSpan: { value: SPAN },
  uSel: { value: [-1, -1] as [number, number] },
  uFade: { value: [0.93, 0.92, 0.9] as [number, number, number] },
  uSlots: { value: [] as number[] },
  uCategory: { value: -1 },
  /** Bark of a dead-wood branch (`aDead` 1), in linear RGB. */
  uDeadBark: { value: [0.6, 0.6, 0.6] as [number, number, number] },
  /**
   * How strongly hot leaves (`aHeat` above 0) glow `uGlowColor`, in linear RGB: 0 with hotspots
   * off, steady under reduced motion, and a slow pulse otherwise.
   */
  uGlow: { value: 0 },
  uGlowColor: { value: [1, 0.36, 0.05] as [number, number, number] },
  /** 1 while some leaves glow: the others calm (drain and pale a little) so the glow reads. */
  uCalm: { value: 0 },
  /**
   * How far dead-wood leaves (`aFall` 1) have fallen, 0 to 1: each tumbles down to `uFloor`
   * after its own small delay and shrinks away as it lands.
   */
  uFall: { value: 0 },
  uFloor: { value: 0 },
};

const GROW_VERTEX = /* glsl */ `
attribute vec3 aBase;
attribute vec2 aT;
attribute float aId;
attribute float aBorn;
uniform float uGrow;
uniform float uTime;
uniform float uSpan;
varying float vId;
float grown() {
  float end = max(aT.y, aT.x + 0.0001);
  return smoothstep(aT.x, end, uGrow) * smoothstep(aBorn + uSpan * aT.x, aBorn + uSpan * end, uTime);
}
`;
const GROW_BEGIN = /* glsl */ `
#include <begin_vertex>
transformed = mix(aBase, transformed, grown());
vId = aId;
`;
const OUTSIDE = '(uSel.y >= 0.0 && (vId < uSel.x - 0.5 || vId > uSel.y + 0.5))';
const OTHER_CATEGORY = '(uCategory >= 0.0 && abs(vSlot - uCategory) > 0.5)';
/**
 * Mixes a `faded` fragment toward the sky by `amount`. `grey` (0 to 1) first drains its color, so
 * a leaf of another category goes the grey of faded bark.
 */
const fade = (faded: string, grey = '0.0', amount = '0.78') => /* glsl */ `
#include <dithering_fragment>
if (${faded}) {
  float l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  vec3 drained = mix(gl_FragColor.rgb, vec3(l), ${grey});
  gl_FragColor.rgb = mix(drained, uFade * (0.75 + 0.25 * l), ${amount});
}
`;
export const FADE = fade(OUTSIDE);
const FADE_UNIFORMS = 'uniform vec2 uSel;\nuniform vec3 uFade;\nuniform float uCategory;\n';

const HSL = /* glsl */ `
vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
vec3 toHSL(vec3 c) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  float l = (hi + lo) * 0.5;
  float d = hi - lo;
  float s = d == 0.0 ? 0.0 : d / (1.0 - abs(2.0 * l - 1.0));
  float h = d == 0.0 ? 0.0
    : hi == c.r ? mod((c.g - c.b) / d, 6.0) / 6.0
    : hi == c.g ? ((c.b - c.r) / d + 2.0) / 6.0
    : ((c.r - c.g) / d + 4.0) / 6.0;
  return vec3(h, s, l);
}
vec3 fromHSL(vec3 hsl) {
  return hsl.z + hsl.y * (hue2rgb(hsl.x) - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}
`;

/** How far a leaf of another category fades, and how the highlighted ones saturate and darken. */
const LEAF_TUNING = '#define FADE_OTHER 0.9\n#define POP_S 0.7\n#define POP_L 0.7\n';
/**
 * Leaves of the highlighted category deepen: more saturation and a little less lightness, so a
 * pale or gold one reads against the faded grey and the sky. Runs on the output color.
 */
const POP = /* glsl */ `
if (uCategory >= 0.0 && !${OTHER_CATEGORY}) {
  vec3 hsl = toHSL(clamp(gl_FragColor.rgb, 0.0, 1.0));
  gl_FragColor.rgb = fromHSL(vec3(hsl.x, mix(hsl.y, 1.0, POP_S), hsl.z * POP_L));
}
`;

/**
 * Leaves take their color from a palette slot, then shift it by their own [hue, lightness]. The
 * lightness shift scales rather than adds, so a dark slot varies as little as a light one.
 */
const LEAF_VERTEX = /* glsl */ `
attribute float aSlot;
attribute vec2 aShade;
attribute float aHeat;
attribute float aFall;
uniform float uFall;
uniform float uFloor;
uniform vec3 uSlots[SLOTS];
varying vec3 vLeaf;
varying float vSlot;
varying float vHeat;
${HSL}
vec3 offsetHSL(vec3 c, float dh, float dl) {
  vec3 hsl = toHSL(c);
  return fromHSL(vec3(fract(hsl.x + dh), hsl.y, clamp(hsl.z * (1.0 + dl), 0.0, 1.0)));
}
`;

/** A hot leaf stands HOT_SIZE times as large about its stem, so a few read in a big crown. */
const HOT_GROW = /* glsl */ `
transformed = aBase + (transformed - aBase) * (1.0 + (HOT_SIZE - 1.0) * step(0.001, aHeat));
`;
/** A falling leaf tumbles about its stem as it drops and drifts, then shrinks away on the ground. */
const FALL = /* glsl */ `
if (aFall > 0.5 && uFall > 0.0) {
  float r = fract(sin(dot(aBase.xz, vec2(12.9898, 78.233)) + aId) * 43758.5453);
  float f = clamp((uFall - r * 0.35) / 0.65, 0.0, 1.0);
  vec3 off = transformed - aBase;
  float a = f * (3.0 + 4.0 * r);
  vec3 ax = normalize(vec3(r - 0.5, 0.4, 0.7 - r));
  off = off * cos(a) + cross(ax, off) * sin(a) + ax * dot(ax, off) * (1.0 - cos(a));
  vec3 stem = aBase;
  stem.y = mix(aBase.y, uFloor, f * f);
  stem.x += sin(f * 6.0 + r * 6.28) * 0.12 * f;
  stem.z += cos(f * 5.0 + r * 6.28) * 0.12 * f;
  transformed = stem + off * (1.0 - smoothstep(0.85, 1.0, f));
}
`;
/**
 * A hot leaf glows: its color turns EMBER of the way to a dark `uGlowColor` (light brings it up to
 * a vivid amber), and `uGlowColor` adds on top by its heat times `uGlow`. Every other leaf calms by
 * CALM while `uCalm` is 1, keeping its hue, so the glow reads on any leaf color and palette,
 * autumn's own oranges too. Both still fade with a highlight.
 */
const HOT_COLOR = /* glsl */ `
diffuseColor.rgb *= vLeaf;
diffuseColor.rgb = mix(diffuseColor.rgb, uGlowColor * EMBER_ALBEDO, step(0.001, vHeat) * EMBER);
`;
const HOT_GLOW = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += uGlowColor * (vHeat * uGlow);
`;
const CALM = /* glsl */ `
if (uCalm > 0.5 && vHeat <= 0.0) {
  float l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(vec3(l), uFade, 0.35), CALM);
}
`;

type Hook = (shader: WebGLProgramParametersWithUniforms) => void;

function hook<M extends Material>(material: M, key: string, edit: Hook): M {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, treeUniforms);
    shader.vertexShader =
      GROW_VERTEX + shader.vertexShader.replace('#include <begin_vertex>', GROW_BEGIN);
    shader.fragmentShader = 'varying float vId;\n' + shader.fragmentShader;
    edit(shader);
  };
  material.customProgramCacheKey = () => key;
  return material;
}

export const growing = <M extends Material>(m: M) => hook(m, 'grow', () => {});

/** Bark weathers to `uDeadBark` where `aDead` is 1: a branch whose every leaf is dead wood. */
export const barkShader = <M extends Material>(m: M) =>
  hook(m, 'bark', (shader) => {
    shader.vertexShader =
      'attribute float aDead;\nvarying float vDead;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDead = aDead;',
      );
    shader.fragmentShader =
      FADE_UNIFORMS +
      'uniform vec3 uDeadBark;\nvarying float vDead;\n' +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uDeadBark, vDead);',
        )
        .replace('#include <dithering_fragment>', fade(`uCategory >= 0.0 || ${OUTSIDE}`));
  });

export const leafShader = <M extends Material>(m: M, slots: number) =>
  hook(m, `leaf${slots}`, (shader) => {
    shader.vertexShader =
      `#define SLOTS ${slots}\n#define HOT_SIZE 2.0\n` +
      LEAF_VERTEX +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvLeaf = offsetHSL(uSlots[int(aSlot)], aShade.x, aShade.y);\nvSlot = aSlot;\nvHeat = aHeat;\n' +
          HOT_GROW +
          FALL,
      );
    shader.fragmentShader =
      LEAF_TUNING +
      FADE_UNIFORMS +
      'varying vec3 vLeaf;\nvarying float vSlot;\nvarying float vHeat;\n' +
      '#define CALM 0.5\n#define EMBER 0.85\n#define EMBER_ALBEDO 0.26\nuniform float uGlow;\nuniform vec3 uGlowColor;\nuniform float uCalm;\n' +
      HSL +
      shader.fragmentShader
        .replace('#include <color_fragment>', HOT_COLOR)
        .replace('#include <emissivemap_fragment>', HOT_GLOW)
        .replace(
          '#include <dithering_fragment>',
          CALM +
            fade(
              `${OTHER_CATEGORY} || ${OUTSIDE}`,
              `float(${OTHER_CATEGORY})`,
              `${OTHER_CATEGORY} ? FADE_OTHER : 0.78`,
            ) +
            POP,
        );
  });

/** Writes node id + 1 as a 24-bit color, so 0 means no tree under the pixel. */
export const PICK_VERTEX = /* glsl */ `
${GROW_VERTEX}
void main() {
  vec3 transformed = mix(aBase, position, grown());
  vId = aId;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;
export const PICK_FRAGMENT = /* glsl */ `
varying float vId;
void main() {
  float id = floor(vId + 0.5) + 1.0;
  gl_FragColor = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), 255.0) / 255.0;
}
`;

/** CSS-style radial gradient, interpolated in sRGB and written without tone mapping. */
export const SKY_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;
export const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uCenter;
uniform vec3 uEdge;
varying vec2 vUv;
void main() {
  float d = length((vUv - vec2(0.5, 0.6)) / vec2(1.2, 0.9));
  vec3 mid = mix(uCenter, uEdge, 0.28);
  vec3 c = d < 0.45 ? mix(uCenter, mid, d / 0.45) : mix(mid, uEdge, (d - 0.45) / 0.55);
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(c + (noise - 0.5) / 255.0, 1.0);
}
`;

/**
 * The halo over each hot sprig: a soft additive disc `aSize` across (world units) at the sprig's
 * heart, as bright as its `aHeat` times the pulse `uGlow`. It grows in with its sprig, so it waits
 * for the sprig's birth on the timeline, and dims outside a pinned folder or a highlight.
 */
export const haloShader = <M extends Material>(m: M) =>
  hook(m, 'halo', (shader) => {
    shader.vertexShader =
      'attribute float aSize;\nattribute float aHeat;\nvarying float vHalo;\nuniform float uGlow;\n' +
      shader.vertexShader.replace(
        'gl_PointSize = size;',
        'gl_PointSize = size * aSize * grown();\nvHalo = aHeat * uGlow * HALO;',
      );
    shader.fragmentShader =
      'varying float vHalo;\nuniform vec2 uSel;\nuniform float uCategory;\n' +
      shader.fragmentShader.replace(
        '#include <map_particle_fragment>',
        /* glsl */ `
vec2 disc = gl_PointCoord * 2.0 - 1.0;
float r2 = dot(disc, disc);
if (r2 > 1.0) discard;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.97, 0.8), 0.8 * exp(-r2 * 10.0));
diffuseColor.a *= vHalo * (exp(-r2 * 4.5) - exp(-4.5)) / (1.0 - exp(-4.5));
if (${OUTSIDE} || uCategory >= 0.0) diffuseColor.a *= 0.25;
`,
      );
    shader.vertexShader = '#define HALO 1.6\n' + shader.vertexShader;
  });
