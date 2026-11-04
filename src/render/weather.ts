import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import type { Quality } from '../grow/grow';
import { ISLAND_RADIUS } from '../grow/size';
import type { Sky } from '../repo/ci';
import { FOV } from './framing';
import type { Palette } from './palette';

type RGB = [number, number, number];

/**
 * How each weather dresses the scene. `sky` mixes `tint` into the palette's sky center and edge
 * by those shares; `light` scales the key and hemisphere lights; `sun` is the sun's opacity;
 * `clouds` drift behind the tree; `fall` scales the rain or snow for the quality; `lightning`
 * flashes now and then while motion is allowed.
 */
type Look = {
  sky: { tint: string; center: number; edge: number };
  light: { key: number; sky: number };
  sun: number;
  clouds: { count: number; color: string; speed: number };
  fall: number;
  wind: number;
  lightning: boolean;
};

const LOOKS: Record<Sky, Look> = {
  clear: {
    sky: { tint: '#ffffff', center: 0, edge: 0 },
    light: { key: 1, sky: 1 },
    sun: 0,
    clouds: { count: 0, color: '#ffffff', speed: 0 },
    fall: 0,
    wind: 0,
    lightning: false,
  },
  sunny: {
    sky: { tint: '#ffe0a8', center: 0.1, edge: 0.2 },
    light: { key: 1.08, sky: 1 },
    sun: 1,
    clouds: { count: 0, color: '#ffffff', speed: 0 },
    fall: 0,
    wind: 0,
    lightning: false,
  },
  cloudy: {
    sky: { tint: '#c9d3de', center: 0.22, edge: 0.4 },
    light: { key: 0.95, sky: 0.97 },
    sun: 0.9,
    clouds: { count: 5, color: '#ffffff', speed: 0.03 },
    fall: 0,
    wind: 0,
    lightning: false,
  },
  rain: {
    sky: { tint: '#8e9aa8', center: 0.42, edge: 0.6 },
    light: { key: 0.72, sky: 0.9 },
    sun: 0,
    clouds: { count: 7, color: '#a9b1bb', speed: 0.045 },
    fall: 1,
    wind: 0.06,
    lightning: false,
  },
  storm: {
    sky: { tint: '#4d5664', center: 0.55, edge: 0.72 },
    light: { key: 0.55, sky: 0.82 },
    sun: 0,
    clouds: { count: 8, color: '#737b87', speed: 0.08 },
    fall: 1.5,
    wind: 0.22,
    lightning: true,
  },
};

/** Raindrops at fall 1 for each quality; snowflakes are fewer and slower. */
const DROPS: Record<Quality, number> = { low: 450, medium: 900, high: 1500 };
const FLAKES = 0.7;
const MAX_FALL = Math.max(...Object.values(LOOKS).map((l) => l.fall));
const MAX_CLOUDS = Math.max(...Object.values(LOOKS).map((l) => l.clouds.count));
/** Rain and snow fall through a cylinder this wide around the trunk, from TOP to BOTTOM. */
const FALL = { radius: 7, top: 8, bottom: -5, ground: 0.06 };
const RAIN = { speed: 9, length: 0.32, width: 0.008, color: '#5d6b7c', opacity: 0.38 };
const SNOW = { speed: 0.9, length: 0.08, width: 0.04, color: '#ffffff', opacity: 0.92 };
/** The backdrop (sun, clouds, lightning) hangs this far behind the camera's target. */
const BACKDROP = 60;
/** Seconds between lightning flashes, and how long one lasts. */
const FLASH = { gap: [3.5, 9] as const, length: 0.5 };
const FROZEN_AT = 37.3;

/** The palette's sky center and edge with the weather mixed in, as sRGB. */
export function weatherSky(palette: Palette, sky: Sky | null): { center: RGB; edge: RGB } {
  const look = LOOKS[sky ?? 'clear'];
  const tint = srgb(look.sky.tint);
  const mix = (hex: string, k: number) => srgb(hex).map((c, i) => c + (tint[i]! - c) * k) as RGB;
  return {
    center: mix(palette.sky.center, look.sky.center),
    edge: mix(palette.sky.edge, look.sky.edge),
  };
}

/** How much of the palette's key and hemisphere light the weather lets through. */
export const weatherLight = (sky: Sky | null) => LOOKS[sky ?? 'clear'].light;

/**
 * The weather's scene objects: rain or snow in world space around the island, and a backdrop
 * fixed to the camera far behind the tree (sun, clouds, lightning), so clouds never cover the
 * tree. Everything moves in vertex shaders from one time uniform; a frame costs three draws.
 */
export function createWeather(camera: PerspectiveCamera) {
  let sky: Sky | null = null;
  let palette: Palette | null = null;
  let quality: Quality = 'low';
  let still = false;
  let time = FROZEN_AT;
  let nextFlash = 2;
  let flashAt = -Infinity;
  const random = mulberry32(7);

  const backdrop = new Group();
  const time$ = { value: time };

  const sunMaterial = (opacity: number) =>
    new MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, toneMapped: false });
  const sun = new Group();
  const discs = [
    new Mesh(new CircleGeometry(0.2, 10), sunMaterial(0.18)),
    new Mesh(new CircleGeometry(0.135, 10), sunMaterial(0.35)),
    new Mesh(new CircleGeometry(0.09, 10), sunMaterial(1)),
  ];
  discs.forEach((d, i) => {
    d.position.z = i * 0.01;
    d.rotation.z = i * 0.16;
    sun.add(d);
  });

  const cloudMaterial = new ShaderMaterial({
    vertexShader: CLOUD_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    uniforms: {
      uTime: time$,
      uSpan: { value: [-2, 2] },
      uSpeed: { value: 0 },
      uSize: { value: 1 },
      uColor: { value: [1, 1, 1] },
      uFlash: { value: 0 },
    },
    depthWrite: false,
    toneMapped: false,
  });
  const clouds = new Mesh(cloudGeometry(random), cloudMaterial);
  clouds.frustumCulled = false;
  clouds.renderOrder = 1;

  const boltMaterial = new MeshBasicMaterial({
    color: 0xf4f6ff,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const bolt = new Mesh(new BufferGeometry(), boltMaterial);
  bolt.frustumCulled = false;
  bolt.renderOrder = 2;
  sun.renderOrder = 0;
  backdrop.add(sun, clouds, bolt);

  const fallMaterial = new ShaderMaterial({
    vertexShader: FALL_VERTEX,
    fragmentShader: FALL_FRAGMENT,
    uniforms: {
      uTime: time$,
      uSpeed: { value: RAIN.speed },
      uLength: { value: RAIN.length },
      uWidth: { value: RAIN.width },
      uWind: { value: 0 },
      uSnow: { value: 0 },
      uColor: { value: [0, 0, 0] },
      uOpacity: { value: 1 },
      uIsland: { value: ISLAND_RADIUS * 0.97 },
      uFall: { value: [FALL.top, FALL.ground, FALL.bottom] },
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const fall = new Mesh(fallGeometry(random, DROPS.high * MAX_FALL), fallMaterial);
  fall.frustumCulled = false;

  const look = () => LOOKS[sky ?? 'clear'];
  const snowing = () => palette?.precip === 'snow';

  const apply = () => {
    if (!palette) return;
    const l = look();
    const { center, edge } = weatherSky(palette, sky);
    const toward = (from: RGB, to: RGB, k: number) =>
      from.map((c, i) => c + (to[i]! - c) * k) as RGB;
    const sunColor = srgb('#ffe7a8');
    discs[0]!.material.color.setRGB(...toward(center, sunColor, 0.6), SRGBColorSpace);
    discs[1]!.material.color.setRGB(...toward(center, sunColor, 0.8), SRGBColorSpace);
    discs[2]!.material.color.setRGB(...sunColor, SRGBColorSpace);
    sun.visible = l.sun > 0;
    discs.forEach((d, i) => (d.material.opacity = [0.18, 0.35, 1][i]! * l.sun));

    clouds.visible = l.clouds.count > 0;
    clouds.geometry.setDrawRange(0, clouds.geometry.userData.ends[l.clouds.count] ?? 0);
    cloudMaterial.uniforms.uColor!.value = toward(srgb(l.clouds.color), edge, 0.18);
    cloudMaterial.uniforms.uSpeed!.value = l.clouds.speed;

    const snow = snowing();
    const kind = snow ? SNOW : RAIN;
    const u = fallMaterial.uniforms;
    u.uSpeed!.value = kind.speed * (snow ? 1 + l.wind * 2 : 1 + l.wind);
    u.uLength!.value = kind.length;
    u.uWidth!.value = kind.width;
    u.uWind!.value = snow ? l.wind * 1.6 : l.wind;
    u.uSnow!.value = snow ? 1 : 0;
    u.uColor!.value = snow ? srgb(kind.color) : toward(srgb(kind.color), edge, 0.25);
    u.uOpacity!.value = kind.opacity;
    const drops = Math.round(DROPS[quality] * l.fall * (snow ? FLAKES : 1));
    fall.visible = drops > 0;
    (fall.geometry as InstancedBufferGeometry).instanceCount = drops;
  };

  /** Lines the backdrop up behind the free region: one unit is half its height. */
  const place = (span: { left: number; right: number }) => {
    const scale = BACKDROP * Math.tan(((FOV / 2) * Math.PI) / 180);
    backdrop.position.copy(camera.position);
    backdrop.quaternion.copy(camera.quaternion);
    backdrop.translateZ(-BACKDROP);
    backdrop.scale.setScalar(scale);
    backdrop.updateMatrixWorld();
    const aspect = camera.aspect;
    sun.position.set(-0.62 * Math.min(aspect, 1.6), 0.62, -0.05);
    cloudMaterial.uniforms.uSpan!.value = [span.left - 0.7, span.right + 0.7];
    cloudMaterial.uniforms.uSize!.value = Math.min(1, Math.max(0.55, aspect));
  };

  /** A jagged bolt from the clouds to the horizon, somewhere across the free region. */
  const strike = (aspect: number) => {
    const points: number[] = [];
    let x = (random() * 1.4 - 0.7) * Math.min(aspect, 1.6);
    let y = 0.8;
    const width = 0.012;
    while (y > -0.15) {
      const nx = x + (random() - 0.5) * 0.16;
      const ny = y - 0.08 - random() * 0.1;
      const w = width * (0.5 + y * 0.6);
      points.push(x - w, y, 0.02, x + w, y, 0.02, nx + w, ny, 0.02);
      points.push(x - w, y, 0.02, nx + w, ny, 0.02, nx - w, ny, 0.02);
      x = nx;
      y = ny;
    }
    bolt.geometry.dispose();
    bolt.geometry = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(new Float32Array(points), 3),
    );
  };

  /** 0 to 1: two quick pulses, then a fade. */
  const flashLevel = () => {
    const t = (time - flashAt) / FLASH.length;
    if (t < 0 || t > 1) return 0;
    return Math.max(Math.exp(-((t - 0.06) ** 2) / 0.002), 0.8 * Math.exp(-((t - 0.3) ** 2) / 0.01));
  };

  const animated = () => !still && sky !== null && sky !== 'clear' && sky !== 'sunny';

  return {
    /** Objects to add to the scene; the backdrop follows the camera. */
    objects: [backdrop, fall],
    /** Whether the weather moves, so the view keeps rendering. */
    animated,
    set(next: { sky: Sky | null; palette: Palette; quality: Quality; still: boolean }) {
      sky = next.sky;
      palette = next.palette;
      quality = next.quality;
      still = next.still;
      if (still) {
        time = FROZEN_AT;
        flashAt = -Infinity;
      }
      time$.value = time;
      apply();
    },
    /**
     * Advances the weather by `dt` seconds, unless still, and follows the camera. Returns the
     * lightning flash level, 0 to 1, for the sky and lights.
     */
    tick(dt: number, span: { left: number; right: number }): number {
      if (!animated()) {
        bolt.visible = false;
        place(span);
        return 0;
      }
      time += dt;
      time$.value = time;
      if (look().lightning && time >= nextFlash) {
        flashAt = time;
        nextFlash = time + FLASH.gap[0] + random() * (FLASH.gap[1] - FLASH.gap[0]);
        strike(camera.aspect);
      }
      const flash = look().lightning ? flashLevel() : 0;
      bolt.visible = flash > 0.02;
      boltMaterial.opacity = Math.min(1, flash * 1.4);
      cloudMaterial.uniforms.uFlash!.value = flash;
      place(span);
      return flash;
    },
    dispose() {
      for (const mesh of [...discs, clouds, bolt, fall]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}

/**
 * Low-poly clouds of a few flattened icosahedron puffs, merged into one geometry with each
 * cloud's place and speed per vertex. Faces are shaded once from a light above and to the left,
 * so they read the same at any spin angle. `userData.ends[n]` is where the first n clouds end.
 */
function cloudGeometry(random: () => number): BufferGeometry {
  const puff = new IcosahedronGeometry(1, 1);
  const base = puff.getAttribute('position');
  const positions: number[] = [];
  const shades: number[] = [];
  const centers: number[] = [];
  const ends = [0];
  const light = new Vector3(-0.35, 0.85, 0.4).normalize();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let n = 0; n < MAX_CLOUDS; n++) {
    const width = 0.2 + random() * 0.14;
    const puffs = 4 + Math.floor(random() * 3);
    const cx = (n + random() * 0.6) / MAX_CLOUDS;
    const cy = 0.5 + ((n * 0.37) % 1) * 0.4;
    const speed = 0.7 + random() * 0.6;
    for (let p = 0; p < puffs; p++) {
      const t = puffs === 1 ? 0.5 : p / (puffs - 1);
      const r = width * (0.32 + 0.3 * Math.sin(Math.PI * t)) * (0.85 + random() * 0.3);
      const px = (t - 0.5) * width * 1.9;
      const py = r * 0.25 + random() * 0.04;
      for (let v = 0; v < base.count; v += 3) {
        const tri = [a, b, c].map((corner, k) => {
          corner.fromBufferAttribute(base, v + k);
          corner.y = Math.max(corner.y, -0.3);
          return corner.set(px + corner.x * r, py + corner.y * r * 0.85, corner.z * r * 0.6);
        });
        const normal = tri[1]!.clone().sub(tri[0]!).cross(tri[2]!.clone().sub(tri[0]!)).normalize();
        const shade = 0.88 + 0.12 * Math.max(0, normal.dot(light)) - (normal.y < -0.5 ? 0.05 : 0);
        for (const corner of tri) {
          positions.push(corner.x, corner.y, corner.z);
          shades.push(shade);
          centers.push(cx, cy, speed);
        }
      }
    }
    ends.push(positions.length / 3);
  }
  puff.dispose();
  const geometry = new BufferGeometry()
    .setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    .setAttribute('aShade', new BufferAttribute(new Float32Array(shades), 1))
    .setAttribute('aCloud', new BufferAttribute(new Float32Array(centers), 3));
  geometry.userData.ends = ends;
  return geometry;
}

/** One quad per drop: x across the streak (-1 to 1), y from its head (0) to its tail (1). */
function fallGeometry(random: () => number, count: number): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const drops = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = FALL.radius * Math.sqrt(random());
    const angle = random() * Math.PI * 2;
    drops.set([Math.cos(angle) * r, Math.sin(angle) * r, random(), random()], i * 4);
  }
  geometry.setAttribute('aDrop', new InstancedBufferAttribute(drops, 4));
  geometry.instanceCount = 0;
  return geometry;
}

const CLOUD_VERTEX = /* glsl */ `
attribute float aShade;
attribute vec3 aCloud;
uniform float uTime;
uniform vec2 uSpan;
uniform float uSpeed;
uniform float uSize;
varying float vShade;
void main() {
  float span = uSpan.y - uSpan.x;
  float x = uSpan.x + fract(aCloud.x + uTime * uSpeed * aCloud.z / span) * span;
  vShade = aShade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position * uSize + vec3(x, aCloud.y, 0.0), 1.0);
}
`;
const CLOUD_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uFlash;
varying float vShade;
void main() {
  vec3 c = uColor * vShade;
  gl_FragColor = vec4(mix(c, vec3(0.93, 0.95, 1.0), uFlash * 0.45), 1.0);
}
`;

const FALL_VERTEX = /* glsl */ `
attribute vec4 aDrop;
uniform float uTime;
uniform float uSpeed;
uniform float uLength;
uniform float uWidth;
uniform float uWind;
uniform float uSnow;
uniform float uIsland;
uniform vec3 uFall;
varying float vAlpha;
varying vec2 vCorner;
void main() {
  float bottom = length(aDrop.xy) < uIsland ? uFall.y : uFall.z;
  float height = uFall.x - bottom;
  float k = fract(aDrop.z + uTime * uSpeed * (0.8 + 0.4 * aDrop.w) / height);
  float drop = k * height;
  vec3 head = vec3(aDrop.x + uWind * drop, uFall.x - drop, aDrop.y);
  head.x += uSnow * 0.18 * sin(uTime * 1.1 + aDrop.z * 40.0);
  head.z += uSnow * 0.18 * cos(uTime * 0.9 + aDrop.w * 40.0);
  vec4 view = modelViewMatrix * vec4(head, 1.0);
  if (uSnow > 0.5) {
    float size = 0.6 + 0.8 * aDrop.w;
    view.xy += vec2(position.x * uWidth, (position.y - 0.5) * uLength) * size;
  } else {
    vec3 down = normalize((modelViewMatrix * vec4(uWind, -1.0, 0.0, 0.0)).xyz);
    vec2 across = normalize(vec2(-down.y, down.x));
    view.xyz -= down * position.y * uLength;
    view.xy += across * position.x * uWidth;
  }
  vAlpha = smoothstep(0.0, 0.06, k) * (1.0 - smoothstep(0.97, 1.0, k));
  vCorner = position.xy;
  gl_Position = projectionMatrix * view;
}
`;
const FALL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSnow;
varying float vAlpha;
varying vec2 vCorner;
void main() {
  if (uSnow > 0.5 && abs(vCorner.x) + abs(vCorner.y - 0.5) * 2.0 > 1.0) discard;
  float tail = mix(1.0 - vCorner.y * 0.7, 1.0, uSnow);
  gl_FragColor = vec4(uColor, uOpacity * vAlpha * tail);
}
`;

function srgb(hex: string): RGB {
  const c = new Color(hex);
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, SRGBColorSpace);
  return [out.r, out.g, out.b];
}

/** A small seeded generator, so the clouds and drops lie the same way on every visit. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
