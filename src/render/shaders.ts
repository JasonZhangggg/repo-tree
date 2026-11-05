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
   * How strongly hot leaves (`aHeat` above 0) glow in their own color: 0 while none are hot,
   * steady under reduced motion, and a slow pulse otherwise.
   */
  uGlow: { value: 0 },
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
 * lightness shift scales rather than adds, so a dark slot varies as little as a light one. A
 * fractional `aSlot` blends the two slots either side of it: the Changes gradient.
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
 * A hot leaf keeps its color and lights up a little in it: its own color adds on as emission by
 * its heat times `uGlow`. It still fades with a highlight.
 */
const HOT_GLOW = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += vLeaf * (step(0.001, vHeat) * (0.55 + 0.45 * vHeat) * uGlow * SELF_LIT);
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
      `#define SLOTS ${slots}\n` +
      LEAF_VERTEX +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nint slot = int(aSlot);\nvLeaf = offsetHSL(mix(uSlots[slot], uSlots[min(slot + 1, SLOTS - 1)], fract(aSlot)), aShade.x, aShade.y);\nvSlot = aSlot;\nvHeat = aHeat;\n' +
          FALL,
      );
    shader.fragmentShader =
      LEAF_TUNING +
      FADE_UNIFORMS +
      'varying vec3 vLeaf;\nvarying float vSlot;\nvarying float vHeat;\n' +
      '#define SELF_LIT 0.5\nuniform float uGlow;\n' +
      HSL +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb *= vLeaf;',
        )
        .replace('#include <emissivemap_fragment>', HOT_GLOW)
        .replace(
          '#include <dithering_fragment>',
          fade(
            `${OTHER_CATEGORY} || ${OUTSIDE}`,
            `float(${OTHER_CATEGORY})`,
            `${OTHER_CATEGORY} ? FADE_OTHER : 0.78`,
          ) + POP,
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
 * The glow around each hot leaf: a second copy of the leaves where only hot leaves draw, each
 * SHELL times as large about its own heart (`aCenter`; hot leaves keep their size) and
 * pushed a little away from the camera, so its own leaf covers its middle and the light spills
 * past its edges. It is brightest at the leaf's heart (`aRim` 0) and fades to nothing at its
 * rim (`aRim` 1), as bright as its `aHeat` times the pulse `uGlow`. Leaves nearer the camera
 * still cover it. Its color is its leaf's, lifted bright (a vertex color). It grows, waits for
 * its birth and dims with a pin or highlight like the leaf.
 */
export const glowShader = <M extends Material>(m: M) =>
  hook(m, 'glow', (shader) => {
    shader.vertexShader =
      '#define SHELL 2.4\n#define PUSH 0.6\n' +
      'attribute float aHeat;\nattribute float aRim;\nattribute vec3 aCenter;\nuniform float uGlow;\nvarying float vGlow;\n' +
      shader.vertexShader
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
float reach = length(aCenter - aBase);
transformed = aHeat > 0.0 ? aCenter + (transformed - aCenter) * SHELL : vec3(0.0);
vGlow = aHeat > 0.0 ? (1.0 - aRim) * (0.55 + 0.45 * aHeat) * uGlow * GLOW_GAIN : 0.0;`,
        )
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nmvPosition.xyz += normalize(mvPosition.xyz) * reach * PUSH;\ngl_Position = projectionMatrix * mvPosition;',
        );
    shader.vertexShader = '#define GLOW_GAIN 1.2\n' + shader.vertexShader;
    shader.fragmentShader =
      'varying float vGlow;\nuniform vec2 uSel;\nuniform float uCategory;\n' +
      shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity * clamp(vGlow, 0.0, 1.0) );
if (${OUTSIDE} || uCategory >= 0.0) diffuseColor.a *= 0.25;`,
      );
  });
