import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  Vector4,
  type PerspectiveCamera,
} from 'three';
import type { Quality } from '../grow/grow';
import { surfaceAt } from '../grow/ground';
import { ISLAND_RADIUS } from '../grow/size';
import type { Sky } from '../repo/ci';
import type { Box } from './framing';
import type { Palette } from './palette';

type RGB = [number, number, number];

/**
 * How each weather dresses the scene. `sky` mixes `tint` into the palette's sky center and edge
 * by those shares; `light` scales the key and hemisphere lights; `sun` is the sun's opacity;
 * `clouds` float over the island, `size` times their own size, drifting round it at `speed`
 * radians a second; `fall` scales the rain or snow under them for the quality; `lightning`
 * strikes from a cloud now and then while motion is allowed.
 */
type Look = {
  sky: { tint: string; center: number; edge: number };
  light: { key: number; sky: number };
  sun: number;
  clouds: { count: number; color: string; size: number; speed: number };
  fall: number;
  wind: number;
  lightning: boolean;
};

const LOOKS: Record<Sky, Look> = {
  clear: {
    sky: { tint: '#ffffff', center: 0, edge: 0 },
    light: { key: 1, sky: 1 },
    sun: 0,
    clouds: { count: 0, color: '#ffffff', size: 1, speed: 0 },
    fall: 0,
    wind: 0,
    lightning: false,
  },
  sunny: {
    sky: { tint: '#ffe0a8', center: 0.1, edge: 0.2 },
    light: { key: 1.08, sky: 1 },
    sun: 1,
    clouds: { count: 2, color: '#ffffff', size: 0.85, speed: 0.025 },
    fall: 0,
    wind: 0,
    lightning: false,
  },
  cloudy: {
    sky: { tint: '#c9d3de', center: 0.22, edge: 0.4 },
    light: { key: 0.95, sky: 0.97 },
    sun: 0.9,
    clouds: { count: 4, color: '#ffffff', size: 0.95, speed: 0.03 },
    fall: 0,
    wind: 0,
    lightning: false,
  },
  rain: {
    sky: { tint: '#8e9aa8', center: 0.42, edge: 0.6 },
    light: { key: 0.72, sky: 0.9 },
    sun: 0,
    clouds: { count: 5, color: '#9aa3ae', size: 1.05, speed: 0.04 },
    fall: 1,
    wind: 0.04,
    lightning: false,
  },
  storm: {
    sky: { tint: '#4d5664', center: 0.55, edge: 0.72 },
    light: { key: 0.55, sky: 0.82 },
    sun: 0,
    clouds: { count: 6, color: '#646c78', size: 1.15, speed: 0.06 },
    fall: 2.2,
    wind: 0.12,
    lightning: true,
  },
};

/** Raindrops at fall 1 for each quality; snowflakes are fewer and slower. */
const DROPS: Record<Quality, number> = { low: 60, medium: 140, high: 260 };
const FLAKES = 0.7;
/** Puffs in a cloud for each quality, the first always the big middle one. */
const PUFFS: Record<Quality, number> = { low: 4, medium: 6, high: 6 };
const MAX_FALL = Math.max(...Object.values(LOOKS).map((l) => l.fall));
export const MAX_CLOUDS = Math.max(...Object.values(LOOKS).map((l) => l.clouds.count));
/**
 * Rain and snow fall from a cloud's underside, under a disc `footprint` times its size wide,
 * and only where they land within `rim` of the island's radius, inside its wobbly edge: nothing
 * falls past the island. A drop ends `sink` under the island's smooth surface (`surfaceAt`),
 * fading out as it lands, so the grass hides its end; with the ground off it ends at `floor`.
 */
const FALL = { footprint: 0.5, rim: 0.85, sink: 0.05, floor: 0.02 };
const RAIN = { speed: 6.5, length: 0.26, width: 0.008, color: '#5d6b7c', opacity: 0.5 };
const SNOW = { speed: 0.75, length: 0.06, width: 0.03, color: '#ffffff', opacity: 0.95 };
/**
 * The cloud deck. Clouds float `gap` over the crown and `eye` over the camera of the whole
 * view, but no higher than `room` under the top of the view, so they stay in frame; however
 * tall the tree, they stay at least `least` over both the crown and the eye, so seen from the
 * whole view none passes in front of the crown. They bob up to `bob`, stack up to `layers`, and
 * drift within `island` of the island's radius, so rain under them lands on it.
 */
export const DECK = {
  gap: 1,
  eye: 0.6,
  least: 0.32,
  room: 1.05,
  bob: 0.06,
  island: 0.9,
  layers: 0.25,
};
/**
 * Which way the key light and the sun stand from the trunk, in x and z: front left of the
 * approved view, so shadows fall back and right.
 */
export const SUN_BEARING = [-3 / Math.hypot(3, 5), 5 / Math.hypot(3, 5)] as const;
/** Seconds between lightning flashes, and how long one lasts. */
const FLASH = { gap: [3.5, 9] as const, length: 0.5 };
const FROZEN_AT = 37.3;
/** How fast the deck eases to a new height when the tree or the view changes, per second. */
const DECK_RATE = 2.5;

/**
 * The night sky in dark mode, the same for every palette: deep blue behind the crown fading to
 * near black at the corners. A weather's tint darkens `dim` of the way to `edge` at night.
 */
export const NIGHT = { center: '#141c30', edge: '#04060c', dim: 0.85 };

/**
 * The palette's sky center and edge with the weather mixed in, as sRGB; at `night` the night
 * sky's instead, so leaf colors stay the palette's whatever the mode.
 */
export function weatherSky(
  palette: Palette,
  sky: Sky | null,
  night = false,
): { center: RGB; edge: RGB } {
  const look = LOOKS[sky ?? 'clear'];
  const toward = (from: RGB, to: RGB, k: number) => from.map((c, i) => c + (to[i]! - c) * k) as RGB;
  const base = night ? NIGHT : palette.sky;
  let tint = srgb(look.sky.tint);
  if (night) tint = toward(tint, srgb(NIGHT.edge), NIGHT.dim);
  return {
    center: toward(srgb(base.center), tint, look.sky.center),
    edge: toward(srgb(base.edge), tint, look.sky.edge),
  };
}

/**
 * How much of each light the scene keeps at night: moonlight, dim enough that leaves, bark and
 * ground fall into shadow, but the same hue so leaf colors stay the palette's. Glowing leaves
 * light themselves, so they stand out.
 */
export const MOONLIGHT = { key: 0.14, sky: 0.2, fill: 0.25 };

/** How much of the palette's key and hemisphere light the weather lets through. */
export const weatherLight = (sky: Sky | null) => LOOKS[sky ?? 'clear'].light;

/** How many clouds float over the island in a weather. */
export const cloudCount = (sky: Sky | null) => LOOKS[sky ?? 'clear'].clouds.count;

/**
 * Where the clouds float for a tree: `base` is the underside of the lowest cloud and `reach`
 * how far from the trunk they may drift. `view` is the camera that frames the whole view: its
 * height (`eye`) and the height of the view's top edge over the trunk (`top`). A cloud whose
 * underside is above both the crown's top and the eye can never sit between the camera and the
 * crown, so it never hides the tree or its labels.
 */
export function cloudDeck(
  tree: Box,
  view: { eye: number; top: number },
): { base: number; reach: number } {
  const crown = tree.max[1];
  const wanted = Math.max(crown + DECK.gap, view.eye + DECK.eye);
  const floor = Math.max(crown, view.eye) + DECK.least;
  return {
    base: Math.max(floor, Math.min(wanted, view.top - DECK.room)),
    reach: ISLAND_RADIUS * DECK.island,
  };
}

/**
 * Each cloud's resting place on the deck, from the trunk: its angle, how far out as a share of
 * the reach, how far over the base, its size and its drift speed. Spread by the golden angle so
 * any first few are spread round the island.
 */
const SPOTS = (() => {
  const random = mulberry32(11);
  return Array.from({ length: MAX_CLOUDS }, (_, n) => ({
    angle: n * 2.39996 + random() * 0.5,
    out: 0.35 + 0.6 * ((n * 0.618 + 0.25) % 1),
    up: random() * DECK.layers,
    size: 0.8 + random() * 0.45,
    speed: 0.7 + random() * 0.6,
    phase: random() * Math.PI * 2,
  }));
})();

/**
 * The weather's scene objects: the sun, clouds, the rain or snow under them and lightning, all
 * in world space over the island, so they turn with it as the camera orbits and the sun stays
 * where the key light shines from. Drift, fall and the sun's motion run in vertex shaders from
 * one time uniform and a few cloud positions a frame; a frame costs four draws.
 */
export function createWeather(camera: PerspectiveCamera) {
  let sky: Sky | null = null;
  let palette: Palette | null = null;
  let quality: Quality = 'low';
  let builtFor: Quality | null = null;
  let still = false;
  let night = false;
  let time = FROZEN_AT;
  let nextFlash = 2;
  let flashAt = -Infinity;
  let deck = { base: 4, reach: ISLAND_RADIUS };
  let deckGoal = deck;
  let island = true;
  const random = mulberry32(7);

  const time$ = { value: time };

  const sunMaterial = new ShaderMaterial({
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
    uniforms: {
      uTime: time$,
      uScale: { value: SUN.scale },
      uColor: { value: SUN_LAYERS.flatMap(() => [1, 1, 1]) },
      uAlpha: { value: SUN_LAYERS.map((l) => l.alpha) },
      uMoon: { value: 0 },
      uShade: { value: [0, 0, 0] },
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const sun = new Mesh(sunGeometry(), sunMaterial);
  sun.frustumCulled = false;

  const starMaterial = new PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const stars = new Points(starGeometry(), starMaterial);
  stars.frustumCulled = false;
  stars.renderOrder = -1;

  /** Per cloud: x, y (its underside), z and size, or size 0 while it is not out. */
  const clouds$ = { value: Array.from({ length: MAX_CLOUDS }, () => new Vector4()) };
  const cloudMaterial = new MeshStandardMaterial({
    flatShading: true,
    roughness: 1,
    metalness: 0,
  });
  cloudMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uClouds = clouds$;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute float aCloud;\nuniform vec4 uClouds[${MAX_CLOUDS}];`,
      )
      .replace(
        '#include <begin_vertex>',
        'vec4 cloud = uClouds[int(aCloud + 0.5)];\nvec3 transformed = position * cloud.w + cloud.xyz;',
      );
  };
  const clouds = new Mesh(new BufferGeometry(), cloudMaterial);
  clouds.frustumCulled = false;

  const boltMaterial = new MeshBasicMaterial({
    color: 0xf4f6ff,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const bolt = new Mesh(new BufferGeometry(), boltMaterial);
  bolt.frustumCulled = false;
  bolt.renderOrder = 2;

  const fallMaterial = new ShaderMaterial({
    vertexShader: FALL_VERTEX,
    fragmentShader: FALL_FRAGMENT,
    uniforms: {
      uTime: time$,
      uClouds: clouds$,
      uCount: { value: 1 },
      uSpeed: { value: RAIN.speed },
      uLength: { value: RAIN.length },
      uWidth: { value: RAIN.width },
      uWind: { value: 0 },
      uSnow: { value: 0 },
      uColor: { value: [0, 0, 0] },
      uOpacity: { value: 1 },
      uFootprint: { value: FALL.footprint },
      uRadius: { value: ISLAND_RADIUS },
      uRim: { value: ISLAND_RADIUS * FALL.rim },
      uGround: { value: [-FALL.sink, -surfaceAt(ISLAND_RADIUS)] },
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const fall = new Mesh(fallGeometry(random, DROPS.high * MAX_FALL), fallMaterial);
  fall.frustumCulled = false;

  const look = () => LOOKS[sky ?? 'clear'];
  const snowing = () => palette?.precip === 'snow';

  /** Hangs the sun over the deck, toward the key light. */
  const place = () => {
    sun.position.set(SUN_BEARING[0] * SUN.out, deck.base + SUN.up, SUN_BEARING[1] * SUN.out);
  };

  /** Moves each cloud to where it has drifted by now; clouds not out shrink to nothing. */
  const drift = () => {
    place();
    const l = look().clouds;
    clouds$.value.forEach((cloud, n) => {
      const spot = SPOTS[n]!;
      if (n >= l.count) return cloud.set(0, 0, 0, 0);
      const angle = spot.angle + time * l.speed * spot.speed;
      const out = deck.reach * (spot.out + 0.06 * Math.sin(time * 0.13 + spot.phase));
      const up = spot.up + DECK.bob * (0.5 + 0.5 * Math.sin(time * 0.45 + spot.phase));
      cloud.set(Math.cos(angle) * out, deck.base + up, Math.sin(angle) * out, spot.size * l.size);
    });
  };

  const apply = () => {
    if (!palette) return;
    const l = look();
    const toward = (from: RGB, to: RGB, k: number) =>
      from.map((c, i) => c + (to[i]! - c) * k) as RGB;
    const { center, edge } = weatherSky(palette, sky, night);
    const layers = night ? MOON_LAYERS : SUN_LAYERS;
    const glow = srgb(night ? MOON.color : '#ffd45c');
    const u$ = sunMaterial.uniforms;
    u$.uColor!.value = layers.flatMap((s) => toward(center, glow, s.tone));
    u$.uAlpha!.value = layers.map((s) => s.alpha * l.sun);
    u$.uMoon!.value = night ? 1 : 0;
    u$.uShade!.value = toward(center, glow, MOON.shade);
    sun.visible = l.sun > 0;
    stars.visible = night;
    starMaterial.opacity = STARS.through[sky ?? 'clear'];

    if (builtFor !== quality) {
      clouds.geometry.dispose();
      clouds.geometry = cloudGeometry(PUFFS[quality]);
      builtFor = quality;
    }
    clouds.visible = l.clouds.count > 0;
    clouds.geometry.setDrawRange(0, clouds.geometry.userData.ends[l.clouds.count] ?? 0);
    cloudMaterial.color.setRGB(
      ...toward(srgb(l.clouds.color), edge, night ? MOON.clouds : 0.15),
      SRGBColorSpace,
    );

    const snow = snowing();
    const kind = snow ? SNOW : RAIN;
    const u = fallMaterial.uniforms;
    u.uCount!.value = Math.max(1, l.clouds.count);
    u.uSpeed!.value = kind.speed * (snow ? 1 + l.wind * 2 : 1 + l.wind);
    u.uLength!.value = kind.length;
    u.uWidth!.value = kind.width;
    u.uWind!.value = snow ? l.wind * 1.6 : l.wind;
    u.uSnow!.value = snow ? 1 : 0;
    u.uColor!.value = snow ? srgb(kind.color) : toward(srgb(kind.color), edge, 0.25);
    u.uOpacity!.value = kind.opacity;
    const drops =
      l.clouds.count > 0 ? Math.round(DROPS[quality] * l.fall * (snow ? FLAKES : 1)) : 0;
    fall.visible = drops > 0;
    (fall.geometry as InstancedBufferGeometry).instanceCount = drops;
    drift();
  };

  /**
   * A jagged bolt from under a cloud to the ground, drawn as a ribbon facing the camera. It
   * strikes from one of the two clouds furthest to the side, so it seldom crosses the crown.
   */
  const strike = () => {
    const count = look().clouds.count;
    if (count === 0) return;
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const side = clouds$.value
      .slice(0, count)
      .map((c, n) => ({ n, away: Math.abs(c.x * right.x + c.z * right.z) }))
      .sort((a, b) => b.away - a.away);
    const from = clouds$.value[side[Math.min(side.length - 1, Math.floor(random() * 2))]!.n]!;
    const start = new Vector3(from.x, from.y + 0.05, from.z);
    const out = Math.hypot(from.x, from.z);
    const k = Math.min(0.85, (ISLAND_RADIUS * FALL.rim * 0.9) / Math.max(out, 1e-6));
    const end = new Vector3(from.x * k, 0, from.z * k);
    end.y = island ? surfaceAt(out * k) : FALL.floor;
    const steps = 11;
    const points: Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = start.clone().lerp(end, t);
      if (i > 0 && i < steps) p.addScaledVector(right, (random() - 0.5) * 0.32);
      points.push(p);
    }
    const positions: number[] = [];
    for (let i = 0; i < steps; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const wa = 0.04 * (1 - (i / steps) * 0.6);
      const wb = 0.04 * (1 - ((i + 1) / steps) * 0.6);
      const corners = [
        a.clone().addScaledVector(right, -wa),
        a.clone().addScaledVector(right, wa),
        b.clone().addScaledVector(right, wb),
        b.clone().addScaledVector(right, -wb),
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) positions.push(...corners[k]!.toArray());
    }
    bolt.geometry.dispose();
    bolt.geometry = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(new Float32Array(positions), 3),
    );
  };

  /** 0 to 1: two quick pulses, then a fade. */
  const flashLevel = () => {
    const t = (time - flashAt) / FLASH.length;
    if (t < 0 || t > 1) return 0;
    return Math.max(Math.exp(-((t - 0.06) ** 2) / 0.002), 0.8 * Math.exp(-((t - 0.3) ** 2) / 0.01));
  };

  const animated = () => {
    const l = look();
    return !still && (l.sun > 0 || l.clouds.count > 0 || l.fall > 0);
  };

  const showFlash = (flash: number) => {
    bolt.visible = flash > 0.02;
    boltMaterial.opacity = Math.min(1, flash * 1.4);
    cloudMaterial.emissive.setRGB(0.55 * flash, 0.58 * flash, 0.68 * flash);
  };

  return {
    /** Objects to add to the scene, all in world space over the island. */
    objects: [stars, sun, clouds, fall, bolt],
    /**
     * The sun and each cloud out now, as a center and radius in world space, for telling a
     * tap on the sky: the sun to its halo, a cloud to its puffs.
     */
    targets(): { x: number; y: number; z: number; r: number }[] {
      const out: { x: number; y: number; z: number; r: number }[] = [];
      if (sun.visible) {
        const { x, y, z } = sun.position;
        out.push({ x, y, z, r: SUN_DISCS[0]! * SUN.scale });
      }
      if (clouds.visible) {
        for (const c of clouds$.value) {
          if (c.w > 0) out.push({ x: c.x, y: c.y + 0.25 * c.w, z: c.z, r: 0.85 * c.w });
        }
      }
      return out;
    },
    /** Whether the weather moves, so the view keeps rendering. */
    animated,
    set(next: {
      sky: Sky | null;
      palette: Palette;
      quality: Quality;
      still: boolean;
      night: boolean;
    }) {
      sky = next.sky;
      night = next.night;
      palette = next.palette;
      quality = next.quality;
      still = next.still;
      if (still) {
        time = FROZEN_AT;
        flashAt = -Infinity;
        deck = deckGoal;
      }
      time$.value = time;
      showFlash(0);
      apply();
    },
    /**
     * Floats the clouds over a tree (`tree` its bounds), seen by the whole view's camera at
     * height `eye` under a view whose top edge passes over the trunk at `top`, with the island
     * under it or not. They ease there unless the weather holds still.
     */
    setStage(tree: Box, view: { eye: number; top: number }, ground: boolean) {
      deckGoal = cloudDeck(tree, view);
      if (still || !animated()) deck = deckGoal;
      island = ground;
      fallMaterial.uniforms.uGround!.value = ground
        ? [-FALL.sink, -surfaceAt(ISLAND_RADIUS)]
        : [FALL.floor, 0];
      drift();
    },
    /**
     * Advances the weather by `dt` seconds, unless still, and follows the camera. Returns the
     * lightning flash level, 0 to 1, for the sky and lights.
     */
    tick(dt: number): number {
      if (!animated()) {
        deck = deckGoal;
        drift();
        showFlash(0);
        return 0;
      }
      time += dt;
      time$.value = time;
      const k = 1 - Math.exp(-DECK_RATE * dt);
      deck = {
        base: deck.base + (deckGoal.base - deck.base) * k,
        reach: deck.reach + (deckGoal.reach - deck.reach) * k,
      };
      drift();
      if (look().lightning && time >= nextFlash) {
        flashAt = time;
        nextFlash = time + FLASH.gap[0] + random() * (FLASH.gap[1] - FLASH.gap[0]);
        strike();
      }
      const flash = look().lightning ? flashLevel() : 0;
      showFlash(flash);
      return flash;
    },
    dispose() {
      for (const mesh of [sun, stars, clouds, bolt, fall]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}

/**
 * The sun's layers, back to front: turning rays, a breathing halo, a glow that turns the other
 * way, and a faceted core that slowly rolls. `tone` mixes the sky toward the sun's color.
 */
const SUN_LAYERS = [
  { alpha: 0.42, tone: 0.75 },
  { alpha: 0.2, tone: 0.6 },
  { alpha: 0.4, tone: 0.8 },
  { alpha: 1, tone: 1 },
];
/**
 * The moon in dark mode takes the sun's place: no rays, a faint cool halo and glow, and a pale
 * core lit from one side, `shade` of the way from the sky to its `color` on the dark side, so it
 * reads as a fat crescent. Clouds turn `clouds` of the way to the night sky's edge.
 */
const MOON_LAYERS = [
  { alpha: 0, tone: 0 },
  { alpha: 0.08, tone: 0.5 },
  { alpha: 0.1, tone: 0.65 },
  { alpha: 1, tone: 1 },
];
const MOON = { color: '#eef1fa', shade: 0.16, clouds: 0.6 };
/**
 * Stars in dark mode: `count` points on a dome `radius` round the island, from `low` to `high`
 * radians over the horizon, more of them low; `through` is how much of them each weather lets
 * show past its clouds.
 */
const STARS = {
  count: 360,
  radius: 60,
  low: 0.02,
  high: 1.2,
  through: { clear: 1, sunny: 1, cloudy: 0.75, rain: 0.35, storm: 0.2 } as Record<Sky, number>,
};

function starGeometry(): BufferGeometry {
  const random = mulberry32(29);
  const positions: number[] = [];
  const colors: number[] = [];
  for (let n = 0; n < STARS.count; n++) {
    const around = random() * Math.PI * 2;
    const up = STARS.low + (STARS.high - STARS.low) * random() ** 1.6;
    const r = STARS.radius;
    positions.push(
      Math.cos(around) * Math.cos(up) * r,
      Math.sin(up) * r,
      Math.sin(around) * Math.cos(up) * r,
    );
    const bright = 0.35 + 0.65 * random() ** 2;
    const warm = random() * 0.12;
    colors.push(bright, bright * (1 - warm * 0.3), bright * (1 - warm));
  }
  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    .setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
}

const SUN_RAYS = 12;
/** The halo's and glow's radii, and the core's, in sun units. */
const SUN_DISCS = [0.2, 0.135];
const SUN_CORE = 0.098;
/**
 * World units per sun unit, and where the sun hangs: `out` from the trunk toward the key light,
 * so shadows fall away from it, and `up` over the cloud deck's base.
 */
export const SUN = { scale: 3, out: 1.8, up: 0.75 };

/**
 * The whole sun as one mesh, so it costs one draw. The rays, halo and glow are flat and face
 * the camera; the core is a low-poly ball in world space, shaded per facet. Each vertex carries
 * its layer, a phase for its ray's shimmer and whether it is a ray's tip, and the core its
 * facet's normal.
 */
function sunGeometry(): BufferGeometry {
  const positions: number[] = [];
  const sun: number[] = [];
  const normals: number[] = [];
  const push = (x: number, y: number, z: number, layer: number, phase: number, tip: number) => {
    positions.push(x, y, z);
    sun.push(layer, phase, tip);
  };
  for (let r = 0; r < SUN_RAYS; r++) {
    const a = (r / SUN_RAYS) * Math.PI * 2;
    const spread = Math.PI / SUN_RAYS / 2.2;
    const reach = r % 2 ? 0.215 : 0.285;
    const phase = r * 2.39;
    push(Math.cos(a - spread) * 0.12, Math.sin(a - spread) * 0.12, 0, 0, phase, 0);
    push(Math.cos(a) * reach, Math.sin(a) * reach, 0, 0, phase, 1);
    push(Math.cos(a + spread) * 0.12, Math.sin(a + spread) * 0.12, 0, 0, phase, 0);
  }
  SUN_DISCS.forEach((radius, d) => {
    const sides = 10;
    const turn = d * 0.16;
    for (let s = 0; s < sides; s++) {
      const a0 = turn + (s / sides) * Math.PI * 2;
      const a1 = turn + ((s + 1) / sides) * Math.PI * 2;
      push(0, 0, 0, d + 1, 0, 0);
      push(Math.cos(a0) * radius, Math.sin(a0) * radius, 0, d + 1, 0, 0);
      push(Math.cos(a1) * radius, Math.sin(a1) * radius, 0, d + 1, 0, 0);
    }
  });
  for (let i = 0; i < positions.length / 3; i++) normals.push(0, 0, 0);
  const ball = new IcosahedronGeometry(SUN_CORE, 1);
  const corners = ball.getAttribute('position');
  const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
  for (let v = 0; v < corners.count; v += 3) {
    a.fromBufferAttribute(corners, v);
    b.fromBufferAttribute(corners, v + 1);
    c.fromBufferAttribute(corners, v + 2);
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    for (const p of [a, b, c]) {
      push(p.x, p.y, p.z, 3, 0, 0);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  ball.dispose();
  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    .setAttribute('aSun', new BufferAttribute(new Float32Array(sun), 3))
    .setAttribute('aFacet', new BufferAttribute(new Float32Array(normals), 3));
}

const SUN_VERTEX = /* glsl */ `
attribute vec3 aSun;
attribute vec3 aFacet;
uniform float uTime;
uniform float uScale;
uniform vec3 uColor[4];
uniform float uAlpha[4];
uniform float uMoon;
uniform vec3 uShade;
varying vec3 vColor;
varying float vAlpha;
vec2 turn(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
void main() {
  int layer = int(aSun.x + 0.5);
  float alpha = uAlpha[layer];
  vec4 view;
  if (layer == 3) {
    // The core rolls on a tilted axis about once a minute, so its facets catch the light in turn.
    vec3 p = position;
    vec3 n = aFacet;
    float roll = uTime * 0.1;
    p.xz = turn(p.xz, roll);
    n.xz = turn(n.xz, roll);
    p.yz = turn(p.yz, 0.5);
    n.yz = turn(n.yz, 0.5);
    view = modelViewMatrix * vec4(p * uScale, 1.0);
    vec3 facing = normalize(mat3(modelViewMatrix) * n);
    float lit = clamp(0.55 + 0.45 * facing.z + 0.25 * facing.y - 0.15 * facing.x, 0.0, 1.0);
    vColor = uColor[3] * mix(0.86, 1.06, lit);
    if (uMoon > 0.5) {
      // The moon is lit from its upper left, toward the camera: a fat crescent of facets.
      float side = clamp(0.5 - facing.x * 1.25 + facing.y * 0.35 + facing.z * 0.2, 0.0, 1.0);
      vColor = mix(uShade, uColor[3] * mix(0.9, 1.04, lit), smoothstep(0.25, 0.6, side));
    }
  } else {
    vec2 p = position.xy;
    if (layer == 0) {
      // Rays turn about once every 30 s, and each reaches out and pulls back in its own rhythm.
      p = turn(p, uTime * 0.21);
      p *= 1.0 + aSun.z * 0.22 * sin(uTime * 1.6 + aSun.y);
      alpha *= 0.75 + 0.25 * sin(uTime * 1.1 + aSun.y);
    } else if (layer == 1) {
      float breath = sin(uTime * 0.9);
      p = turn(p, -uTime * 0.12) * (1.0 + 0.12 * breath);
      alpha *= 0.8 + 0.35 * breath;
    } else {
      p = turn(p, uTime * 0.15);
    }
    // Flat layers face the camera and sit just behind the core.
    view = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    view.xyz += vec3(p * uScale, -(SUN_CORE + 0.01 * (3.0 - float(layer))) * uScale);
    vColor = uColor[layer];
  }
  vAlpha = alpha;
  gl_Position = projectionMatrix * view;
}
`.replace('SUN_CORE', SUN_CORE.toFixed(3));
const SUN_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

/**
 * Where a cloud's puffs sit around its middle, flat bottomed at y 0, x and z in its own units:
 * a big middle puff, one each side, one in front and behind so it reads round from any spin
 * angle, and a bump on top. Low quality keeps the first four.
 */
const PUFF_LAYOUT = [
  { x: 0, z: 0, r: 0.42 },
  { x: 0.44, z: 0.04, r: 0.31 },
  { x: -0.42, z: -0.05, r: 0.3 },
  { x: 0.1, z: 0.27, r: 0.28 },
  { x: -0.14, z: -0.27, r: 0.27 },
  { x: 0.16, z: -0.06, r: 0.26, y: 0.2 },
];

/**
 * Low-poly clouds: flattened, flat-bottomed icosahedron puffs with their corners nudged so the
 * facets catch the light unevenly, like the island's rocks. All clouds merge into one geometry;
 * `aCloud` names each vertex's cloud, which the material moves to its place. Lit by the scene's
 * lights with flat shading, they share the tree's and the island's look. `userData.ends[n]` is
 * where the first n clouds end.
 */
function cloudGeometry(puffs: number): BufferGeometry {
  const random = mulberry32(23);
  const ball = new IcosahedronGeometry(1, 1);
  const base = ball.getAttribute('position');
  const positions: number[] = [];
  const which: number[] = [];
  const ends = [0];
  const corner = new Vector3();
  const nudge = (v: Vector3) => {
    const h = Math.sin(v.x * 127.1 + v.y * 311.7 + v.z * 74.7) * 43758.5453;
    return 0.9 + 0.2 * (h - Math.floor(h));
  };
  for (let n = 0; n < MAX_CLOUDS; n++) {
    const yaw = random() * Math.PI * 2;
    const stretch = 1 + random() * 0.35;
    const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
    for (const puff of PUFF_LAYOUT.slice(0, puffs)) {
      const r = puff.r * (0.88 + random() * 0.24);
      const px = puff.x * stretch + (random() - 0.5) * 0.06;
      const pz = puff.z + (random() - 0.5) * 0.06;
      const py = (puff.y ?? 0) + r * 0.42;
      for (let v = 0; v < base.count; v++) {
        corner.fromBufferAttribute(base, v);
        corner.multiplyScalar(nudge(corner));
        const x = px + corner.x * r;
        const z = pz + corner.z * r * 0.9;
        positions.push(x * c - z * s, Math.max(0, py + corner.y * r * 0.78), x * s + z * c);
        which.push(n);
      }
    }
    ends.push(positions.length / 3);
  }
  ball.dispose();
  const geometry = new BufferGeometry()
    .setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    .setAttribute('aCloud', new BufferAttribute(new Float32Array(which), 1));
  geometry.computeVertexNormals();
  geometry.userData.ends = ends;
  return geometry;
}

/**
 * One quad per drop: x across the streak (-1 to 1), y from its head (0) to its tail (1). Each
 * drop has a place under its cloud in a unit disc, a phase and a speed, and `aWhich` picks its
 * cloud among however many are out.
 */
function fallGeometry(random: () => number, count: number): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const drops = new Float32Array(count * 4);
  const which = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(random());
    const angle = random() * Math.PI * 2;
    drops.set([Math.cos(angle) * r, Math.sin(angle) * r, random(), random()], i * 4);
    which[i] = random();
  }
  geometry.setAttribute('aDrop', new InstancedBufferAttribute(drops, 4));
  geometry.setAttribute('aWhich', new InstancedBufferAttribute(which, 1));
  geometry.instanceCount = 0;
  return geometry;
}

const FALL_VERTEX = /* glsl */ `
attribute vec4 aDrop;
attribute float aWhich;
uniform vec4 uClouds[${MAX_CLOUDS}];
uniform float uCount;
uniform float uTime;
uniform float uSpeed;
uniform float uLength;
uniform float uWidth;
uniform float uWind;
uniform float uSnow;
uniform float uFootprint;
uniform float uRadius;
uniform float uRim;
uniform vec2 uGround;
varying float vAlpha;
varying vec2 vCorner;
void main() {
  vCorner = position.xy;
  vec4 cloud = uClouds[int(min(floor(aWhich * uCount), uCount - 1.0))];
  vec2 at = cloud.xz + aDrop.xy * uFootprint * cloud.w;
  float top = cloud.y + 0.05 * cloud.w;
  // Where it lands, blown by the wind: past the rim it never falls at all.
  vec2 land = at + vec2(uWind * (top - uGround.x), 0.0);
  float r = length(land);
  if (r > uRim || cloud.w < 0.001) {
    vAlpha = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float ground = uGround.x - uGround.y * pow(min(1.0, r / uRadius), 2.0);
  float height = top - ground;
  float k = fract(aDrop.z + uTime * uSpeed * (0.8 + 0.4 * aDrop.w) / height);
  float drop = k * height;
  vec3 head = vec3(at.x + uWind * drop, top - drop, at.y);
  head.x += uSnow * 0.12 * sin(uTime * 1.1 + aDrop.z * 40.0);
  head.z += uSnow * 0.12 * cos(uTime * 0.9 + aDrop.w * 40.0);
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
  vAlpha = smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(0.92, 1.0, k));
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
