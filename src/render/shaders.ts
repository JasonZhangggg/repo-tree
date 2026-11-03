import type { Material, WebGLProgramParametersWithUniforms } from 'three';

/**
 * Shader hooks shared by every tree material, ported from the approved mock. Each vertex moves
 * from `aBase` (the point it grows out of) to its position while `uGrow` crosses its `aT`
 * window. Fragments whose node id `aId` falls outside `uSel` fade toward `uFade`.
 */
export const treeUniforms = {
  uGrow: { value: 1 },
  uSel: { value: [-1, -1] as [number, number] },
  uFade: { value: [0.93, 0.92, 0.9] as [number, number, number] },
  uSlots: { value: [] as number[] },
};

const GROW_VERTEX = /* glsl */ `
attribute vec3 aBase;
attribute vec2 aT;
attribute float aId;
uniform float uGrow;
varying float vId;
`;
const GROW_BEGIN = /* glsl */ `
#include <begin_vertex>
transformed = mix(aBase, transformed, smoothstep(aT.x, max(aT.y, aT.x + 0.0001), uGrow));
vId = aId;
`;
export const FADE = /* glsl */ `
#include <dithering_fragment>
if (uSel.y >= 0.0 && (vId < uSel.x - 0.5 || vId > uSel.y + 0.5)) {
  float l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFade * (0.75 + 0.25 * l), 0.78);
}
`;

/**
 * Leaves take their color from a palette slot, then shift it by their own [hue, lightness]. The
 * lightness shift scales rather than adds, so a dark slot varies as little as a light one.
 */
const LEAF_VERTEX = /* glsl */ `
attribute float aSlot;
attribute vec2 aShade;
uniform vec3 uSlots[SLOTS];
varying vec3 vLeaf;
vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
vec3 offsetHSL(vec3 c, float dh, float dl) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  float l = (hi + lo) * 0.5;
  float d = hi - lo;
  float s = d == 0.0 ? 0.0 : d / (1.0 - abs(2.0 * l - 1.0));
  float h = d == 0.0 ? 0.0
    : hi == c.r ? mod((c.g - c.b) / d, 6.0) / 6.0
    : hi == c.g ? ((c.b - c.r) / d + 2.0) / 6.0
    : ((c.r - c.g) / d + 4.0) / 6.0;
  l = clamp(l * (1.0 + dl), 0.0, 1.0);
  return l + s * (hue2rgb(fract(h + dh)) - 0.5) * (1.0 - abs(2.0 * l - 1.0));
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

export const barkShader = <M extends Material>(m: M) =>
  hook(m, 'bark', (shader) => {
    shader.fragmentShader =
      'uniform vec2 uSel;\nuniform vec3 uFade;\n' +
      shader.fragmentShader.replace('#include <dithering_fragment>', FADE);
  });

export const leafShader = <M extends Material>(m: M, slots: number) =>
  hook(m, `leaf${slots}`, (shader) => {
    shader.vertexShader =
      `#define SLOTS ${slots}\n` +
      LEAF_VERTEX +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvLeaf = offsetHSL(uSlots[int(aSlot)], aShade.x, aShade.y);',
      );
    shader.fragmentShader =
      'uniform vec2 uSel;\nuniform vec3 uFade;\nvarying vec3 vLeaf;\n' +
      shader.fragmentShader
        .replace('#include <color_fragment>', 'diffuseColor.rgb *= vLeaf;')
        .replace('#include <dithering_fragment>', FADE);
  });

/** Writes node id + 1 as a 24-bit color, so 0 means no tree under the pixel. */
export const PICK_VERTEX = /* glsl */ `
${GROW_VERTEX}
void main() {
  vec3 transformed = mix(aBase, position, smoothstep(aT.x, max(aT.y, aT.x + 0.0001), uGrow));
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
