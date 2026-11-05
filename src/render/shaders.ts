import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import { SPAN } from '../timeline/timeline';

/**
 * Shader hooks shared by every tree material, ported from the approved mock. Each vertex moves
 * from `aBase` (the point it grows out of) to its position while `uGrow` crosses its `aT`
 * window. On the timeline it also waits for its birth: it grows in as `uTime` crosses `aBorn`
 * plus its `aT` window scaled to `uSpan`, so a branch extends before its children and leaves.
 * Fragments whose node id `aId` falls outside `uSel` fade toward `uFade`, and so do bark and
 * every leaf outside color slot `uCategory` while it is not -1. Those leaves fade harder
 * and go grey, and the leaves inside that slot pop away from the sky, so any category stands out,
 * pale or gold by day and dark by night.
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
  /** The breeze's clock (seconds). */
  uWindTime: { value: 0 },
  /** How hard the breeze blows: 1 a gentle sway, 0 holds the scene still. */
  uWind: { value: 0 },
  /** The tree's height, so a tree of any size bends by the same share of it. */
  uWindHeight: { value: 1 },
  /**
   * What the mouse is over, which stays while the rest fades: a rock's or a bird's pick id, -2
   * for the sun or a cloud (the whole tree and ground fade), or -1 for nothing.
   */
  uFocus: { value: -1 },
};

/** Whether an element with pick id `id` fades because the mouse is over something else. */
export const focusOut = (id: string) => `(uFocus != -1.0 && abs(${id} - uFocus) > 0.5)`;

/**
 * Fades every bird but the one under the mouse while it is over a rock, a bird, the sun or a
 * cloud. Wraps the bird's own shader hook, so its motion is untouched.
 */
export function focusFading<M extends Material>(material: M): M {
  const own = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    own(shader, renderer);
    shader.fragmentShader =
      'uniform float uFocus;\nuniform vec3 uFade;\n' +
      shader.fragmentShader.replace('#include <dithering_fragment>', fade(focusOut('vId')));
  };
  material.customProgramCacheKey = () => `${key()}-focus`;
  return material;
}

/**
 * A breeze: every point of the tree bends sideways by the square of its height, so the trunk
 * barely moves and the crown's top sways by about a hundredth of the tree's height. Two slow waves
 * that roll across the crown keep it from swaying as one stiff piece. `swayAt` is the offset at
 * a point; the leaves, the birds and the grass all read it, so a bird rides its perch.
 */
const SWAY = /* glsl */ `
uniform float uWindTime;
uniform float uWind;
uniform float uWindHeight;
vec2 gust(vec3 p, float t) {
  float s = 1.0 / uWindHeight;
  return vec2(
    0.8 * sin(t * 0.7 + (p.x * 1.8 + p.z * 1.1) * s) + 0.35 * sin(t * 1.55 + (p.z * 2.6 - p.y * 1.4) * s),
    0.5 * sin(t * 0.53 + 1.7 + (p.z * 1.6 - p.x * 0.9) * s) + 0.3 * sin(t * 1.9 + (p.x * 3.1 + p.y) * s)
  );
}
vec3 swayAt(vec3 p) {
  float h = clamp(p.y / uWindHeight, 0.0, 1.5);
  vec2 g = gust(p, uWindTime) * (uWind * 0.011 * uWindHeight * h * h);
  return vec3(g.x, 0.0, g.y);
}
`;
/**
 * Grass and flowers sway too, each point by its height above its root (`aSway`, render/ground.ts):
 * quicker than the tree, as small things do.
 */
export const GROUND_SWAY = {
  head: SWAY + 'attribute float aSway;\n',
  body: /* glsl */ `
transformed.xz += aSway * uWind * 0.18 * gust(transformed * 3.0, uWindTime * 1.7);
`,
};
const GROW_VERTEX = /* glsl */ `
${SWAY}
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
transformed += swayAt(transformed);
vId = aId;
`;
const SELECTED_OUT = '(uSel.y >= 0.0 && (vId < uSel.x - 0.5 || vId > uSel.y + 0.5))';
/** Outside the highlighted range, or, with none, not what the mouse is over. */
const OUTSIDE = `(${SELECTED_OUT} || (uSel.y < 0.0 && ${focusOut('vId')}))`;
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
/** The ground's fade: its rocks and grass read `vId` as the root folder, and `vPick` as their pick id. */
export const GROUND_FADE = fade(`${SELECTED_OUT} || ${focusOut('vPick')}`);
const FADE_UNIFORMS =
  'uniform vec2 uSel;\nuniform vec3 uFade;\nuniform float uCategory;\nuniform float uFocus;\n';

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

/**
 * How far a leaf of another category fades, how the highlighted ones saturate, how much they
 * darken against a light sky, and how far they lift toward POP_LIGHT against a dark one.
 */
const LEAF_TUNING =
  '#define FADE_OTHER 0.9\n#define POP_S 0.7\n#define POP_L 0.7\n#define POP_LIFT 0.7\n#define POP_LIGHT 0.5\n';
/**
 * Leaves of the highlighted category stand apart from the sky they fade others toward: more
 * saturation, and lightness pushed away from the sky. Under a light sky they darken, so a pale or
 * gold one reads; under a dark (night) sky they lift, so the darkest one (Constantly) still shows.
 * Runs on the output color.
 */
const POP = /* glsl */ `
if (uCategory >= 0.0 && !${OTHER_CATEGORY}) {
  vec3 hsl = toHSL(clamp(gl_FragColor.rgb, 0.0, 1.0));
  bool night = dot(uFade, vec3(0.299, 0.587, 0.114)) < 0.4;
  float l = night ? mix(hsl.z, POP_LIGHT, POP_LIFT) : hsl.z * POP_L;
  gl_FragColor.rgb = fromHSL(vec3(hsl.x, mix(hsl.y, 1.0, POP_S), l));
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
/** Each leaf flutters on its stem (`aBase`): its far edge bobs, on a beat of its own. */
const FLUTTER = /* glsl */ `
float flutter = sin(uWindTime * 3.1 + dot(aBase, vec3(9.1, 5.3, 7.7)));
transformed.y += uWind * 0.05 * flutter * distance(transformed.xz, aBase.xz);
`;
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
          FLUTTER +
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
  transformed += swayAt(transformed);
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
      'varying float vGlow;\nuniform vec2 uSel;\nuniform float uCategory;\nuniform float uFocus;\n' +
      shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity * clamp(vGlow, 0.0, 1.0) );
if (${OUTSIDE} || uCategory >= 0.0) diffuseColor.a *= 0.25;`,
      );
  });

/** The birds' clock (seconds) and whether they move at all: 0 holds every bird at rest. */
export const birdUniforms = {
  uBirdTime: { value: 0 },
  uBirdMotion: { value: 1 },
  uBirdSize: { value: 0.27 },
};

/**
 * Birds alive on their perches, all from one clock and each bird's own `aPhase`: every few
 * seconds a bird pecks or glances about, flicks its tail or ruffles its wings, and every
 * half minute or so it flies a short hop out from the crown, flapping, and lands where it
 * took off. Each vertex moves with its part (`aMove`, render/birds.ts) in the bird's own frame
 * (`aLocal`), which then turns to face where it is going and stands at its feet (`aBase`).
 * The pick pass reads `position`, the bird at rest.
 */
const BIRD_VERTEX = /* glsl */ `
attribute vec3 aLocal;
attribute vec2 aLook;
attribute vec2 aOut;
attribute float aMove;
attribute float aPhase;
uniform float uBirdTime;
uniform float uBirdMotion;
uniform float uBirdSize;
vec2 turn(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}
float burst(float x, float sharp) {
  return pow(max(0.0, sin(x)), sharp);
}
`;
const BIRD_BEGIN = /* glsl */ `
vec3 l = aLocal;
float t = uBirdTime + aPhase * 97.0;
float period = 26.0 + aPhase * 16.0;
float u = mod(t + aPhase * period, period);
const float FLIGHT = 2.8;
float flying = uBirdMotion * step(u, FLIGHT);
float k = clamp(u / FLIGHT, 0.0, 1.0);
float idle = uBirdMotion * (1.0 - flying);
if (aMove > 0.5 && aMove < 1.5) {
  // Pecks, then glances about.
  vec2 neck = vec2(0.16, 0.3);
  l.xy = neck + turn(l.xy - neck, -1.0 * idle * burst(t * 1.1, 24.0));
  vec2 head = vec2(0.28, 0.0);
  l.xz = head + turn(l.xz - head, 0.55 * idle * sin(t * 0.8) * step(0.2, sin(t * 0.31 + 1.0)));
}
if (aMove > 1.5 && aMove < 3.5) {
  // Wings flap in flight and now and then ruffle at rest, rolling about the shoulder.
  float side = aMove < 2.5 ? 1.0 : -1.0;
  float ruffle = idle * burst(t * 0.45 + 2.0, 40.0) * (0.5 + 0.5 * sin(t * 30.0));
  float beat = flying * (0.5 + 0.9 * sin(t * 24.0));
  vec2 shoulder = vec2(0.3, 0.1 * side);
  l.yz = shoulder + turn(l.yz - shoulder, side * (beat + ruffle * 0.8));
}
if (aMove > 3.5) {
  vec2 rump = vec2(-0.24, 0.24);
  l.xy = rump + turn(l.xy - rump, 0.35 * idle * burst(t * 0.9 + 4.0, 16.0));
}
// In flight the body streamlines, easing in after take-off and out before landing: the belly
// tucks up under it, it stretches out long, and the head drops forward in line with the back.
float sleek = flying * smoothstep(0.0, 0.12, k) * smoothstep(1.0, 0.88, k);
if (l.y < 0.2) l.y = mix(l.y, 0.2 - (0.2 - l.y) * 0.25, sleek);
l.x *= 1.0 + 0.14 * sleek;
if (aMove > 0.5 && aMove < 1.5) l.xy += vec2(0.05, -0.07) * sleek;
// A small hop now and then, and in flight a loop out from the crown and back.
float hop = idle * burst(t * 0.37 + 3.0, 60.0) * 0.25;
vec3 f0 = vec3(aLook.x, 0.0, aLook.y);
vec3 o0 = vec3(aOut.x, 0.0, aOut.y);
float a = k * 6.2831853;
float reach = 1.6 * uBirdSize;
vec3 path = flying * (reach * (o0 * (1.0 - cos(a)) + f0 * sin(a)) + vec3(0.0, sin(3.1415927 * k) * 1.4 * uBirdSize, 0.0));
vec3 f = normalize(mix(f0, o0 * sin(a) + f0 * cos(a), flying));
vec3 r = vec3(-f.z, 0.0, f.x);
vec3 transformed = aBase + path + (f * l.x + vec3(0.0, l.y + hop, 0.0) + r * l.z) * uBirdSize;
transformed = mix(aBase, transformed, grown());
// The bird rides its perch as the crown sways.
transformed += swayAt(aBase);
vId = aId;
`;

export const birdShader = <M extends Material>(m: M) =>
  hook(m, 'bird', (shader) => {
    Object.assign(shader.uniforms, birdUniforms);
    shader.vertexShader = BIRD_VERTEX + shader.vertexShader.replace(GROW_BEGIN, BIRD_BEGIN);
  });
