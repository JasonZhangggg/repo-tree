import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  Object3D,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  ACESFilmicToneMapping,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import type { MeshData, Quality, TreeModel, Vec3 } from '../grow/grow';
import type { Sky } from '../repo/ci';
import {
  distanceOf,
  FOV,
  frameFolder,
  frameGrove,
  type Grove,
  frameTree,
  SKY_LIFT,
  skyTop,
  stage,
  VIEW_DIRECTION,
} from './framing';
import { LIGHT, litColor } from './color';
import { AGES, ageBand, CHANGES, changeBand, DEAD, type Facts } from '../timeline/facts';
import { ownerCategories } from '../timeline/owners';
import type { Births } from '../timeline/timeline';
import { DIFF, diffLeaves } from './diff';
import { groveSpots } from './grove';
import { birdGeometry, BIRD_SIZE, perchOnCrown, type Perched } from './birds';
import { createGround } from './ground';
import { MomentumControls } from './momentum-controls';
import {
  DEAD_BLEACH,
  leafMapping,
  PALETTES,
  slotColors,
  type ColorBy,
  type LegendEntry,
  type Palette,
  type PaletteId,
} from './palette';
import {
  ALWAYS,
  barkShader,
  birdShader,
  birdUniforms,
  growing,
  glowShader,
  focusFading,
  leafShader,
  PICK_FRAGMENT,
  PICK_VERTEX,
  SKY_FRAGMENT,
  SKY_VERTEX,
  treeUniforms,
} from './shaders';
import {
  createWeather,
  MOONLIGHT,
  type SkyTarget,
  SUN_BEARING,
  weatherLight,
  weatherSky,
} from './weather';

/**
 * What a pixel shows: a folder's branch, a rock lying for some of the root folder's files, or a
 * bird (an index into what setBirds was given) perched on a folder. `companion` marks a branch
 * of a compared tree (its index in setCompanions order), its folder that tree's own.
 */
export type Picked = { folder: number; rock?: number; bird?: number; companion?: number };
/** What the mouse is over: a rock or a bird as pickAt found it, or the sun or a cloud. */
export type Hover = Picked | { sky: SkyTarget['which'] };
/** A bird to perch on a folder's twig, in a plumage. */
export type BirdPerch = { folder: number; color: string };
/**
 * `front`: the anchor is nearer the camera than the trunk, not on the far side of the crown.
 * `depth` eases from 0, facing the camera, to 1, straight behind the trunk, as the tree turns.
 */
export type LabelPosition = {
  folder: number;
  x: number;
  y: number;
  visible: boolean;
  front: boolean;
  depth: number;
};
/**
 * `crown` is the crown's outline on screen, as an ellipse, which labels sit outside of.
 * `islands` is where the foot of each island shows, the tree on show's and, while others stand
 * beside it, each companion's in setCompanions order: the middle of the island's underside, in
 * CSS pixels relative to the container, for name tags to hang under.
 */
export type FrameInfo = {
  growth: number;
  labels: LabelPosition[];
  crown: Ellipse;
  islands: { main: IslandFoot; companions: IslandFoot[] };
};
export type IslandFoot = { x: number; y: number; visible: boolean };
export type Ellipse = { x: number; y: number; rx: number; ry: number };
/** CSS pixels along each edge of the container that panels cover. */
export type Insets = { top: number; right: number; bottom: number; left: number };
/** The sky to show, and whether it must hold still (reduced motion): no drift, fall or flashes. */
export type Weather = { sky: Sky; still: boolean };
/** What stands out while the rest fades: a run of node ids, or the leaves of one legend entry. */
/** A range of node ids, on the tree on show or on a compared one (setCompanions order). */
export type Highlight =
  { range: readonly [number, number]; companion?: number } | { category: string };
export type ViewStats = {
  renders: number;
  /** How far the camera stands from the point it orbits. */
  distance: number;
  /** The point the camera orbits, in world space. */
  target: [number, number, number];
  /** The camera's bearing round that point, in radians, as OrbitControls reads it. */
  azimuth: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** Sprigs glowing as hotspots on the tree on show. */
  glowing: number;
};

export interface TreeView {
  /** Shows a new tree, framed whole, growing unless reduced motion is on. */
  setTree(model: TreeModel): void;
  /** Replays the growth of the tree on show, or shows it grown under reduced motion. */
  grow(): void;
  /**
   * Gives each node and sprig of the tree on show the timeline progress it appears at
   * (Timeline.nodes and Timeline.sprigs), or null to show the whole tree again.
   */
  setTimeline(births: { nodes: Float32Array; sprigs: Float32Array } | null): void;
  /** Moves the timeline's cursor: what was born by then shows, and nothing after. */
  setTime(cursor: number): void;
  /**
   * Gives each companion tree (by its model) the cursor progress its nodes and sprigs appear at,
   * on the tree on show's timeline axis, so the grove replays together; one missing, or null,
   * stands whole.
   */
  setCompanionBirths(births: ReadonlyMap<TreeModel, Births> | null): void;
  setPalette(id: PaletteId): void;
  /** Leaf colors by language, top-level folder or, once `setFacts` gave the history, activity or owner. */
  setColorBy(by: ColorBy): void;
  /**
   * Ranks languages for leaf colors by these file counts (any language missing counts 0) instead
   * of the tree's own, so trees shown together give each language one color; null restores.
   */
  setLanguageRank(rank: ReadonlyMap<string, number> | null): void;
  /**
   * Grows other trees each on its own island beside this one in a small grove (grove.ts) in the default
   * view, in the same world, the camera framing and orbiting them all. `scale` shrinks any tree
   * (not its island) from its own height, so they can show their sizes against each other; all
   * are 1 unless told, and none puts the tree on show back at 1. Their leaves follow `setColorBy`
   * like this tree's, from their own history once `setCompanionFacts` gives it (languages until
   * then, ranked by `setLanguageRank` while set); they are not picked, labeled or highlighted.
   * An empty list removes them.
   */
  setCompanions(
    models: readonly TreeModel[],
    scale?: { main: number; companions: readonly number[] },
  ): void;
  /**
   * What the repo's history says about the tree on show (timeline/facts.ts), or null; a new
   * tree clears it. Activity colors need it; without it they fall back to language.
   */
  setFacts(facts: Facts | null): void;
  /** Each companion's history (setCompanions order), so they take the history colors too. */
  setCompanionFacts(facts: readonly (Facts | null)[]): void;
  /** What each leaf color stands for under the current palette and color-by. */
  legend(): LegendEntry[];
  /**
   * Fades every node outside a range, or the bark and every leaf outside the legend entry
   * labelled `category`. A label the legend lacks highlights nothing.
   */
  setHighlight(highlight: Highlight | null): void;
  /** Glides the camera to a folder in context; the root folder (0) frames the whole tree. */
  frameFolder(folder: number): void;
  /**
   * Whether the camera frames the whole tree: aimed at it, or left within a few percent of where
   * that aim puts it. Orbiting alone keeps it home; a zoom, a pan or a pinned folder's glide
   * takes it away.
   */
  atHome(): boolean;
  /** Frames the tree into the part of the container the insets leave free, easing there. */
  setInsets(insets: Insets): void;
  /** The stage the whole view frames: one island's room, or the grove of them while comparing. */
  room(): TreeModel['bounds'];
  /** How far the camera stands back to frame the whole view in a region of this aspect. */
  wholeDistance(aspect: number): number;
  /** The folder or rock under a point in CSS pixels relative to the container, from a GPU id pass. */
  pickAt(x: number, y: number): Picked | null;
  /** Whether a point in CSS pixels relative to the container lands on the sun or a cloud. */
  skyAt(x: number, y: number): boolean;
  /** The sun (or moon) or the cloud under a point, as `Hover` names it, or null. */
  skyTargetAt(x: number, y: number): SkyTarget['which'] | null;
  /**
   * Fades everything but what the mouse is over, when a click on it opens something: a rock, a
   * bird, the sun or a cloud. A bird's perch folder stays too, through setHighlight; a folder's
   * branch alone fades nothing here (its preview is setHighlight).
   */
  setHover(hover: Hover | null): void;
  /**
   * Lights the leaves of the files marked in `files` (by RepoIndex.files id, nonzero to light)
   * and fades the rest of the crown and the bark, as a legend highlight does; or none. While
   * comparing, `others` marks each compared tree's own files the same way (setCompanions order);
   * a tree with none there fades whole while matches show.
   */
  setMatches(files: Uint8Array | null, others?: readonly (Uint8Array | null)[]): void;
  /**
   * Shows a compared branch on the tree on show, by RepoIndex.files id (DIFF): leaves of changed
   * files light, of new files light bright, and of deleted files wither, fall and lie on the
   * island; the rest of the crown and the bark fade, as with matches. A sprig falls only when
   * every file it stands for is deleted; one deleted among others lights as changed. Matches,
   * while set, show instead. Null shows the tree plainly; setTree clears it.
   */
  setDiff(files: Uint8Array | null): void;
  /**
   * Keeps a rock lit while the rest fades, untinted, once a click pinned its file, as a pinned
   * folder's leaves stay; or none. What the mouse is over still takes over while it is there.
   */
  keepRock(rock: number | null): void;
  /**
   * Perches birds on folders of the tree on show, or none; a new tree keeps them, on its own
   * folders. They grow in at the end of the tree's growth and hide while the timeline is open.
   */
  setBirds(birds: readonly BirdPerch[] | null): void;
  /** Where each bird shows on screen, in CSS pixels relative to the container, in setBirds order. */
  birdsOnScreen(): { x: number; y: number }[];
  /** Shows the mound, its rocks and its grass under the tree, or the bare shadow. */
  setGround(on: boolean): void;
  /**
   * Dresses the scene for a weather (sky, light, sun, clouds, rain or snow, lightning), or
   * shows the palette's plain sky. Moving weather keeps the view rendering unless still.
   */
  setWeather(weather: Weather | null): void;
  /**
   * Dark mode: a night sky with stars, the moon in the sun's place and dimmer light of the same
   * hue, so leaf colors keep their palette and glowing leaves stand out.
   */
  setNight(on: boolean): void;
  setQuality(quality: Quality): void;
  setSpin(on: boolean): void;
  setReducedMotion(on: boolean): void;
  /** The folders whose anchors onFrame reports, or null for the top-level folders. */
  setLabelFolders(folders: readonly number[] | null): void;
  /**
   * Called after every rendered frame with each labeled folder's screen position; a label is
   * visible once grown, in front of the camera and inside the free region.
   */
  onFrame(listener: (info: FrameInfo) => void): () => void;
  snapshotPNG(scale: number): Promise<Blob>;
  stats(): ViewStats;
  dispose(): void;
}

export type TreeViewOptions = {
  quality: Quality;
  palette: PaletteId;
  colorBy: ColorBy;
  spin: boolean;
  reducedMotion: boolean;
  ground: boolean;
  night: boolean;
};

const QUALITY: Record<Quality, { pixelRatio: number; shadowMap: number; antialias: boolean }> = {
  low: { pixelRatio: 1, shadowMap: 1024, antialias: false },
  medium: { pixelRatio: 1.5, shadowMap: 2048, antialias: true },
  high: { pixelRatio: 2, shadowMap: 2048, antialias: true },
};

/** uFocus while the mouse is over the sun or a cloud: the whole tree and ground fade. */
const SKY_FOCUS = -2;
const GROW_MS = 2600;
const BAKED = 1;
const LABELS_FROM = 0.55;
/**
 * A label counts as behind the crown once its anchor's bearing turns more than about 105 degrees
 * from the camera's, unless the anchor sits within `near` of the trunk.
 */
const BACK = { facing: 0.25, near: 0.15 };
/** Over which share of facing the camera, toward to away, a label's depth eases from 0 to 1. */
const DEPTH = { near: 0.2, far: -0.7 };
/** How much of the tree's reach, and from what share of its height up, the crown's outline covers. */
const CROWN = { reach: 0.8, from: 0.4 };
const SPIN_SPEED = 0.55;
/**
 * With trees side by side, spin sways the camera this far either side of the front instead of
 * going round, so the grove never shows backwards; it slows toward each end.
 */
const SWAY = 0.5;
const FRONT = Math.atan2(VIEW_DIRECTION[0], VIEW_DIRECTION[2]);
/** How far above level the camera looks on its own, and on a grove of three or more. */
const LEVEL = Math.atan2(VIEW_DIRECTION[1], Math.hypot(VIEW_DIRECTION[0], VIEW_DIRECTION[2]));
/**
 * A grove with a back row is seen from higher up, so the back row stands clear above the front
 * one on screen instead of hiding behind it.
 */
const GROVE_LEVEL = 0.45;
/**
 * Added to the first companion's node ids, past any real tree's; each next one's lie
 * COMPANION_STRIDE further on, all still exact in a float and in the 24-bit pick id.
 */
const COMPANION_IDS = 4_000_000;
const COMPANION_STRIDE = 2_000_000;
const companionIds = (k: number) => COMPANION_IDS + k * COMPANION_STRIDE;
/** The open ground between a tree's island and its companion's. */
const COMPANION_GAP = 0.35;
/** Screen right in the default view, on the ground (x, z): across VIEW_DIRECTION. */
const SIDEWAYS = (() => {
  const [x, , z] = VIEW_DIRECTION;
  const length = Math.hypot(x, z);
  return [z / length, -x / length] as const;
})();
/** Toward the camera in the default view, on the ground (x, z). */
const TOWARD = (() => {
  const [x, , z] = VIEW_DIRECTION;
  const length = Math.hypot(x, z);
  return [x / length, z / length] as const;
})();
/** Spring rates: the camera settles in about a second, the free region in about a third. */
const GLIDE_RATE = 6.5;
const INSET_RATE = 16;
/** The free region keeps at least this share of the container on each axis. */
const MIN_FREE = 0.2;
/** The ramp every palette shares, plus the slot for the rest. */
const SLOTS = PALETTES.autumn.leaves.length + 1;
/** The hottest leaf's glow, and how it breathes: down to PULSE_LOW of it over PULSE_MS. */
const GLOW = 0.7;
/** At night the glow shines this much brighter, against the dark. */
const NIGHT_GLOW = 1.25;
const PULSE_LOW = 0.6;
const PULSE_MS = 2800;
/** While only the pulse moves, frames come this far apart: a slow glow needs few. */
const PULSE_FRAME_MS = 70;
/**
 * While nothing else moves, the breeze and the birds draw at about 30 fps: they move slowly, and
 * a scene that is only swaying should not cost a full frame rate.
 */
const ALIVE_FRAME_MS = 33;
/** How long dead-wood leaves take to fall when they drop. */
const FALL_MS = 2600;
/** A leaf is six triangles of its own three vertices each (grow.ts `leaf`). */
const LEAF_VERTICES = 18;
/** A deleted file's fallen leaf. */
const WITHERED = '#5e4630';
/** A glow takes its leaf's hue, this saturated and at least this light, so it reads as light. */
const GLOW_SATURATION = 0.9;
const GLOW_LIGHTNESS = 0.62;
/** A birth past any cursor: the element never shows. */
const NEVER = ALWAYS * 4;

type Shown = {
  model: TreeModel;
  bark: Mesh<BufferGeometry, MeshStandardMaterial>;
  leaves: Mesh<BufferGeometry, MeshStandardMaterial>;
  /**
   * Per node: [minX, minY, minZ, maxX, maxY, maxZ] of its leaves, and of its bark. A twig's
   * bark runs back to the fork it grew from, so a folder is framed on its leaves.
   */
  boxes: { leaves: Float32Array; bark: Float32Array };
  /** The tree's bounds, with the ground's while it shows. */
  bounds: TreeModel['bounds'];
  groundBounds: TreeModel['bounds'];
};

export function createTreeView(container: HTMLElement, options: TreeViewOptions): TreeView {
  let quality = options.quality;
  let palette = PALETTES[options.palette];
  let colorBy = options.colorBy;
  let facts: Facts | null = null;
  let reducedMotion = options.reducedMotion;
  /** Leaf colors rank languages by these file counts instead of the tree's own, while set. */
  let rank: ReadonlyMap<string, number> | null = null;
  birdUniforms.uBirdMotion.value = reducedMotion ? 0 : 1;
  treeUniforms.uWind.value = reducedMotion ? 0 : 1;
  birdUniforms.uBirdSize.value = BIRD_SIZE;
  /** Sprigs glowing now; the pulse runs only while some do. */
  let glowing = 0;
  let pulseTimer = 0;
  let highlight: Highlight | null = null;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 200);

  const sky = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: { uCenter: { value: [1, 1, 1] }, uEdge: { value: [1, 1, 1] } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  /**
   * The container's CSS background shows the same gradient behind a transparent canvas; the sky
   * quad only draws into PNG snapshots. Filling every pixel on a software GL cost about a fifth
   * of each spin frame, and the browser rasters a CSS gradient once.
   */
  sky.visible = false;

  const hemi = new HemisphereLight(0xffffff, 0xffffff, LIGHT.sky);
  const key = new DirectionalLight(0xffffff, LIGHT.key);
  key.castShadow = true;
  key.shadow.bias = -0.0006;
  key.shadow.radius = 4;
  const fill = new DirectionalLight(LIGHT.fillColor, LIGHT.fill);
  fill.position.set(6, 3, 2);

  const ground = new Mesh(
    new PlaneGeometry(60, 60),
    new ShadowMaterial({ opacity: 0.13, color: 0x000000 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;

  const contactTexture = radialTexture();
  const contact = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false }),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.002;

  /**
   * The ground shadow only changes with the shadow map, so the shadow plane and the contact
   * shadow render once into a texture from above (layer BAKED) and a plain textured quad shows
   * it. Sampling the shadow map across half the screen cost a quarter of each spin frame.
   */
  const groundTarget = new WebGLRenderTarget(1, 1);
  const bakeCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 40);
  bakeCamera.layers.set(BAKED);
  const baked = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({
      map: groundTarget.texture,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
    }),
  );
  baked.rotation.x = -Math.PI / 2;
  baked.position.y = 0.001;
  for (const object of [ground, contact]) object.layers.set(BAKED);
  key.layers.enable(BAKED);
  scene.add(sky, hemi, key, key.target, fill, ground, contact, baked);
  const terrain = createGround();
  scene.add(terrain.land, terrain.cover);
  /** Each companion's history facts (setCompanionFacts), for its colors. */
  let companionFacts: readonly (Facts | null)[] = [];
  /** How much setCompanions shrank the tree on show, 1 when alone; its island keeps its size. */
  let mainScale = 1;
  /** Other trees beside the first (setCompanions), each on its own island, moved by its group. */
  let companions: {
    model: TreeModel;
    group: Group;
    bark: Mesh<BufferGeometry, MeshStandardMaterial>;
    leaves: Mesh<BufferGeometry, MeshStandardMaterial>;
    terrain: ReturnType<typeof createGround>;
    groundBounds: TreeModel['bounds'];
  }[] = [];
  let groundOn = options.ground;
  let night = options.night;
  const moonlight = () => (night ? MOONLIGHT : { key: 1, sky: 1, fill: 1 });
  const glowPeak = () => GLOW * (night ? NIGHT_GLOW : 1);
  const weather = createWeather(camera);
  scene.add(...weather.objects);
  let weatherShown: Weather | null = null;
  /** The weather's sky, before a lightning flash brightens it. */
  let skyColors = weatherSky(palette, null, night);

  const barkMaterial = barkShader(new MeshStandardMaterial({ roughness: 0.92, flatShading: true }));
  const leafMaterial = leafShader(
    new MeshStandardMaterial({ roughness: 0.8, side: DoubleSide }),
    SLOTS,
  );
  const depthMaterial = growing(new MeshDepthMaterial());
  const glowMaterial = glowShader(
    new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
  );
  const birdMaterial = focusFading(
    birdShader(
      new MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.75,
        side: DoubleSide,
      }),
    ),
  );
  const birdMesh = new Mesh(new BufferGeometry(), birdMaterial);
  // Birds move every frame and the shadow map is drawn only when the tree changes, so they cast none.
  birdMesh.frustumCulled = false;
  birdMesh.visible = false;
  scene.add(birdMesh);
  let birdPerches: readonly BirdPerch[] | null = null;
  /** Each bird's perch in the world, in setBirds order, while some show. */
  let birdSpots: Vec3[] = [];
  /** Light spilling past each hot leaf's edges: the leaves again, where only hot ones draw. */
  let glow: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  const pickMaterial = new ShaderMaterial({
    vertexShader: PICK_VERTEX,
    fragmentShader: PICK_FRAGMENT,
    uniforms: {
      uGrow: treeUniforms.uGrow,
      uTime: treeUniforms.uTime,
      uSpan: treeUniforms.uSpan,
      uWindTime: treeUniforms.uWindTime,
      uWind: treeUniforms.uWind,
      uWindHeight: treeUniforms.uWindHeight,
    },
    side: DoubleSide,
    toneMapped: false,
  });
  const pickTarget = new WebGLRenderTarget(1, 1);
  const pickPixel = new Uint8Array(4);

  let renderer: WebGLRenderer;
  // A drag turns the tree 1:1 and a release throws it; zoom and tilt give at their limits.
  const controls = new MomentumControls(camera, container);
  controls.momentum = !reducedMotion;
  controls.enablePan = false;
  // A pinch or the wheel zooms toward what is under the fingers or the pointer, not the middle;
  // reaim keeps the point the camera turns about within reach of the tree (controls.cursor).
  controls.zoomToCursor = true;
  controls.maxPolarAngle = Math.PI * 0.53;
  controls.autoRotate = options.spin;
  controls.autoRotateSpeed = SPIN_SPEED;

  let shown: Shown | null = null;
  /** Per node, the timeline progress it appears at, while the timeline is open. */
  let births: Float32Array | null = null;
  let growStart = 0;
  let growingNow = false;
  /**
   * What the camera keeps framed as the free region changes: the whole tree, a folder's
   * bounding sphere, or nothing once the user has moved the camera.
   */
  let aim: { kind: 'tree' } | { kind: 'folder'; center: Vec3; radius: number } | null = {
    kind: 'tree',
  };
  const look = spring([0, 0, 0, 1]);
  let gliding = false;
  const insets = spring([0, 0, 0, 0]);
  let raf = 0;
  let lastFrame = 0;
  let renders = 0;
  /**
   * Objects held back from the first tree frames, one more drawn per frame, so a frame waits on
   * at most one new program: a software GL links each in 100 to 250 ms, and the first tree frame
   * waited on all of them at once. A growing tree starts collapsed, so the hold does not show.
   */
  let staged: Object3D[] = [];
  let linked = false;
  const listeners = new Set<(info: FrameInfo) => void>();

  const mountRenderer = () => {
    const { antialias, pixelRatio, shadowMap } = QUALITY[quality];
    const next = new WebGLRenderer({ antialias, alpha: true, powerPreference: 'high-performance' });
    next.setPixelRatio(Math.min(pixelRatio, window.devicePixelRatio || 1));
    next.toneMapping = ACESFilmicToneMapping;
    next.shadowMap.enabled = true;
    next.shadowMap.type = PCFShadowMap;
    next.shadowMap.autoUpdate = false;
    next.shadowMap.needsUpdate = true;
    next.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    if (renderer) {
      renderer.domElement.replaceWith(next.domElement);
      key.shadow.map?.dispose();
      key.shadow.map = null;
      renderer.dispose();
      renderer.forceContextLoss();
    } else {
      container.append(next.domElement);
    }
    renderer = next;
    linked = false;
    key.shadow.mapSize.set(shadowMap, shadowMap);
    groundTarget.setSize(shadowMap, shadowMap);
    renderer.setClearColor(0x000000, 0);
    resize();
  };

  const resize = () => {
    renderer.setSize(
      Math.max(1, container.clientWidth),
      Math.max(1, container.clientHeight),
      false,
    );
    applyView();
    reaim(!gliding);
    requestRender();
  };

  /** The free region in container pixels, never squeezed below MIN_FREE of either axis. */
  const freeRegion = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const [top, right, bottom, left] = insets.value as [number, number, number, number];
    const w = Math.max(width * MIN_FREE, width - left - right);
    const h = Math.max(height * MIN_FREE, height - top - bottom);
    return {
      width,
      height,
      x: Math.min(left, width - w),
      y: Math.min(top, height - h),
      w,
      h,
    };
  };

  /**
   * Projects as if the free region were the whole view, and lets the canvas show the
   * margins around it: the camera's aspect is the region's, and its center is the region's.
   */
  const applyView = () => {
    const { width, height, x, y, w, h } = freeRegion();
    camera.setViewOffset(w, h, -x, -y, width, height);
  };

  /**
   * The stage the whole view frames. One tree is framed by the room the tallest tree would take,
   * so a bigger repo shows as a bigger tree. A grove already sizes its trees against each other
   * (`sizeScales`), so it is framed by what stands there, fully grown: snug, and the same all
   * through a timeline. It sways about its middle.
   */
  const roomOf = () => {
    if (companions.length && shown) return shown.bounds;
    const one = stage(groundOn);
    let room = one;
    for (const { group } of companions) {
      const at = group.position;
      room = union(room, {
        min: [one.min[0] + at.x, one.min[1] + at.y, one.min[2] + at.z],
        max: [one.max[0] + at.x, one.max[1] + at.y, one.max[2] + at.z],
      });
    }
    return room;
  };

  /** What a grove covers, seen from the front (placeScene). */
  let grove: Grove | null = null;
  /** How the whole view frames a room: one tree as the tallest would stand, a grove snugly. */
  const frameWhole = (room: TreeModel['bounds'], aspect = camera.aspect) =>
    companions.length && grove
      ? frameGrove(grove, aspect, SKY_LIFT, companions.length >= 2 ? GROVE_LEVEL : LEVEL)
      : frameTree(room, aspect, SKY_LIFT);

  /**
   * Points the camera springs at what `aim` frames; `snap` jumps there. The whole view frames
   * the stage, the tallest tree on the island, not the tree on show, so every repo is seen at
   * one scale and a bigger repo shows as a bigger tree.
   */
  const reaim = (snap: boolean) => {
    if (!shown) return;
    const room = roomOf();
    const whole = frameWhole(room);
    weather.setStage(shown.model.bounds, { eye: whole.position[1], top: skyTop(whole) }, groundOn);
    // Zooming toward a point moves what the camera turns about; it stays inside the stage's
    // bounding sphere, so no zoom leaves the tree behind.
    const reach = union(room, shown.bounds);
    const half = [0, 1, 2].map((i) => (reach.max[i]! - reach.min[i]!) / 2);
    controls.cursor.set(...([0, 1, 2].map((i) => reach.min[i]! + half[i]!) as Vec3));
    controls.maxTargetRadius = Math.hypot(...half);
    if (!aim) return;
    controls.stop();
    controls.minDistance = whole.minDistance;
    controls.maxDistance = whole.maxDistance;
    const goal =
      aim.kind === 'tree'
        ? { target: whole.target, distance: distanceOf(whole.position, whole.target) }
        : frameFolder(aim, shown.bounds, camera.aspect, room);
    if (!gliding) {
      look.value = [...controls.target.toArray(), camera.position.distanceTo(controls.target)];
      look.velocity.fill(0);
    }
    look.goal = [...goal.target, goal.distance];
    if (snap) look.value = [...look.goal];
    gliding = !snap;
    placeCamera();
    requestRender();
  };

  /** Whether the last grove had a back row, so the view only tilts when that changes. */
  let rowsBefore: boolean | null = null;
  /** Turns the camera to look down at `level` above the horizon, keeping its bearing and reach. */
  const tilt = (level: number) => {
    const direction = camera.position.clone().sub(controls.target);
    const reach = direction.length();
    const flat = Math.hypot(direction.x, direction.z);
    if (reach < 1e-9) return;
    const [x, z] =
      flat < 1e-9 ? [VIEW_DIRECTION[0], VIEW_DIRECTION[2]] : [direction.x, direction.z];
    const across = Math.hypot(x, z);
    direction.set((x / across) * Math.cos(level), Math.sin(level), (z / across) * Math.cos(level));
    camera.position.copy(controls.target).addScaledVector(direction, reach);
  };

  /** Moves the camera to the spring's target and distance along its current direction. */
  const placeCamera = () => {
    const [x, y, z, distance] = look.value as [number, number, number, number];
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(...VIEW_DIRECTION);
    controls.target.set(x, y, z);
    camera.position.copy(controls.target).addScaledVector(direction.normalize(), distance);
  };

  /** The sun or the cloud under a point in CSS pixels relative to the container. */
  let skyHovered: SkyTarget['which'] | null = null;
  const skyTargetAt = (x: number, y: number): SkyTarget['which'] | null => {
    if (!shown) return null;
    const { width, height } = freeRegion();
    const center = new Vector3();
    const edge = new Vector3();
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const hit = weather.targets().find((t) => {
      center.set(t.x, t.y, t.z).project(camera);
      if (center.z > 1) return false;
      edge.set(t.x, t.y, t.z).addScaledVector(right, t.r).project(camera);
      const cx = ((center.x + 1) / 2) * width;
      const cy = ((1 - center.y) / 2) * height;
      const ex = ((edge.x + 1) / 2) * width;
      const ey = ((1 - edge.y) / 2) * height;
      // A finger needs room even round a far, small cloud.
      const r = Math.max(Math.hypot(ex - cx, ey - cy), 22);
      return Math.hypot(x - cx, y - cy) <= r;
    });
    return hit ? hit.which : null;
  };

  let matches: Uint8Array | null = null;
  /** The compared branch's mark per leaf of the tree on show (DIFF), or null. */
  let diff: Uint8Array | null = null;
  /** When deleted files' leaves began to fall, or -1. */
  let dropStart = -1;
  /** Each compared tree's matches, in setCompanions order. */
  let companionMatches: readonly (Uint8Array | null)[] = [];
  /** Each leaf's `aMatch` for a tree: 1 where its sprig stands for any matched file. */
  const litOf = ({ leaves, sprigs }: TreeModel, files: Uint8Array | null) => {
    const lit = new Float32Array(leaves.nodeId.length);
    if (!files) return lit;
    for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
      for (let k = sprigs.file[s]!; k < sprigs.file[s + 1]!; k++) {
        if (!files[sprigs.files[k]!]) continue;
        lit.fill(1, sprigs.vertex[s]!, sprigs.vertex[s + 1]!);
        break;
      }
    }
    return lit;
  };
  /** Each leaf vertex's `aMatch` for the compared branch: its leaf's DIFF mark. */
  const diffLit = ({ leaves }: TreeModel, marks: Uint8Array) => {
    const lit = new Float32Array(leaves.nodeId.length);
    marks.forEach((mark, i) => {
      if (mark) lit.fill(mark, i * LEAF_VERTICES, (i + 1) * LEAF_VERTICES);
    });
    return lit;
  };
  const applyMatches = () => {
    const on = !!matches || !!diff || companionMatches.some((m) => !!m);
    treeUniforms.uMatch.value = on && shown ? 1 : 0;
    if (!shown) return;
    shown.leaves.geometry.setAttribute(
      'aMatch',
      new BufferAttribute(
        !matches && diff ? diffLit(shown.model, diff) : litOf(shown.model, matches),
        1,
      ),
    );
    companions.forEach((c, i) => {
      const lit = litOf(c.model, companionMatches[i] ?? null);
      c.leaves.geometry.setAttribute('aMatch', new BufferAttribute(lit, 1));
    });
    requestRender();
  };

  let hovering: Hover | null = null;
  let keptRock: number | null = null;
  /** What stays while the rest fades: what the mouse is over, else a pinned rock, untinted. */
  const applyFocus = () => {
    const hover = hovering;
    const nodes = shown?.model.nodes.folder.length ?? 0;
    const rocks = shown?.model.rocks.length ?? 0;
    const sky = hover && 'sky' in hover ? hover.sky : null;
    const hovered =
      sky !== null
        ? SKY_FOCUS
        : hover && 'bird' in hover && hover.bird !== undefined
          ? nodes + rocks + hover.bird
          : hover && 'rock' in hover && hover.rock !== undefined
            ? nodes + hover.rock
            : -1;
    const kept = keptRock !== null && keptRock < rocks ? nodes + keptRock : -1;
    const focus = hovered !== -1 ? hovered : kept;
    const tint = hovered !== -1 ? 1 : 0;
    if (
      focus === treeUniforms.uFocus.value &&
      tint === treeUniforms.uFocusTint.value &&
      sky === skyHovered
    ) {
      return;
    }
    skyHovered = sky;
    weather.setFocus(sky, hovered !== -1);
    treeUniforms.uFocus.value = focus;
    treeUniforms.uFocusTint.value = tint;
    requestRender();
  };

  /** Which way spin sways the grove, +1 toward a larger azimuth. */
  let swayWay = 1;
  /** Spin goes round one tree; beside others it sways about the front (SWAY). */
  const sway = () => {
    if (!companions.length) {
      controls.autoRotateSpeed = SPIN_SPEED;
      return;
    }
    const off = Math.atan2(
      Math.sin(controls.getAzimuthalAngle() - FRONT),
      Math.cos(controls.getAzimuthalAngle() - FRONT),
    );
    if (off >= SWAY) swayWay = -1;
    else if (off <= -SWAY) swayWay = 1;
    const ease = Math.abs(off) >= SWAY ? 1 : Math.max(0.2, Math.cos((off / SWAY) * (Math.PI / 2)));
    // OrbitControls turns a positive speed toward a smaller azimuth.
    controls.autoRotateSpeed = -swayWay * SPIN_SPEED * 1.6 * ease;
  };

  const requestRender = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const frame = (now: number) => {
    raf = 0;
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    let busy = false;

    if (growingNow) {
      const k = Math.min(1, (now - growStart) / GROW_MS);
      treeUniforms.uGrow.value = 1 - (1 - k) ** 2.2;
      growingNow = k < 1;
      renderer.shadowMap.needsUpdate = true;
      busy = true;
    }
    if (step(insets, dt, INSET_RATE, 0.25)) busy = true;
    if (insets.moved) {
      applyView();
      reaim(!gliding);
    }
    if (gliding) {
      gliding = step(look, dt, GLIDE_RATE, 1e-4);
      placeCamera();
      busy = true;
    }
    if (controls.autoRotate) sway();
    if (controls.update(dt)) busy = true;
    if (fallStart >= 0) {
      const k = (now - fallStart) / FALL_MS;
      treeUniforms.uFall.value = Math.min(1, k);
      busy = true;
      if (k >= 1) {
        fallStart = -1;
        applyBirths(timelineBirths);
      }
    }
    if (dropStart >= 0) {
      const k = (now - dropStart) / FALL_MS;
      treeUniforms.uDrop.value = Math.min(1, Math.max(0, k));
      busy = true;
      if (k >= 1) {
        dropStart = -1;
        renderer.shadowMap.needsUpdate = true;
      }
    }
    const pulsing = glowing > 0 && !reducedMotion;
    if (pulsing) treeUniforms.uGlow.value = glowAt(now);
    // The breeze and the birds keep the scene alive while motion is allowed.
    const alive = !!shown && !reducedMotion;
    if (alive) {
      treeUniforms.uWindTime.value = now / 1000;
      birdUniforms.uBirdTime.value = now / 1000;
    }
    showFlash(weather.tick(dt));
    if (weather.animated()) busy = true;

    const shadowChanged = renderer.shadowMap.needsUpdate;
    const held = staged.filter((mesh) => mesh.visible);
    for (const mesh of held) mesh.visible = false;
    renderer.render(scene, camera);
    if (shadowChanged) {
      bakeGround();
      busy = true;
    }
    for (const mesh of held) mesh.visible = true;
    if (staged.shift()) {
      renderer.shadowMap.needsUpdate = true;
      busy = true;
    }
    renders++;
    emitLabels();
    if (busy) requestRender();
    else {
      lastFrame = 0;
      if (pulsing || alive) {
        clearTimeout(pulseTimer);
        pulseTimer = window.setTimeout(requestRender, alive ? ALIVE_FRAME_MS : PULSE_FRAME_MS);
      }
    }
  };

  const glowAt = (now: number) =>
    glowPeak() *
    (PULSE_LOW + (1 - PULSE_LOW) * (0.5 + 0.5 * Math.cos((now / PULSE_MS) * 2 * Math.PI)));

  /**
   * Writes each leaf's heat (`aHeat`): its sprig's, while the leaves show Changes. The busiest few
   * (Facts.hot) glow a little in their own color, pulsing gently unless reduced motion is on.
   */
  const applyHeat = () => {
    if (!shown) return;
    const { leaves, sprigs } = shown.model;
    const heat = new Float32Array(leaves.nodeId.length);
    glowing = 0;
    if (byChanges()) {
      for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
        const h = facts!.sprigHeat[s]!;
        if (h <= 0) continue;
        heat.fill(h, sprigs.vertex[s]!, sprigs.vertex[s + 1]!);
        glowing++;
      }
    }
    shown.leaves.geometry.setAttribute('aHeat', new BufferAttribute(heat, 1));
    placeGlow();
    treeUniforms.uGlow.value =
      glowing === 0 ? 0 : reducedMotion ? glowPeak() : glowAt(performance.now());
    requestRender();
  };

  /**
   * Builds the glow copy of the hot leaves only: each hot leaf's vertices with its heart
   * (`aCenter`, the mean of its LEAF_VERTICES vertices) and whether each is on the leaf's rim
   * (`aRim`: the third of each triangle is the heart), plus its timing, node and current birth,
   * so it grows in, pins and drops with its leaf. Shown while any leaf is hot.
   */
  const placeGlow = () => {
    glow?.geometry.dispose();
    if (glow) glow.visible = false;
    if (!shown || glowing === 0) return;
    const { leaves, sprigs } = shown.model;
    const heat = shown.leaves.geometry.getAttribute('aHeat')?.array as Float32Array | undefined;
    const born = shown.leaves.geometry.getAttribute('aBorn')?.array as Float32Array | undefined;
    if (!heat) return;
    const runs: [number, number][] = [];
    let count = 0;
    for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
      const [from, to] = [sprigs.vertex[s]!, sprigs.vertex[s + 1]!];
      if (to > from && heat[from]! > 0) {
        runs.push([from, to]);
        count += to - from;
      }
    }
    const position = new Float32Array(3 * count);
    const base = new Float32Array(3 * count);
    const center = new Float32Array(3 * count);
    const timing = new Float32Array(2 * count);
    const id = new Float32Array(count);
    const births = new Float32Array(count);
    const heats = new Float32Array(count);
    const colors = new Float32Array(3 * count);
    const slotOf = shown.leaves.geometry.getAttribute('aSlot')?.array as Float32Array | undefined;
    const slots = treeUniforms.uSlots.value;
    const tint = new Color();
    const next = new Color();
    const hsl = { h: 0, s: 0, l: 0 };
    const rim = new Float32Array(count);
    const p = leaves.position;
    let w = 0;
    for (const [start, end] of runs) {
      for (let from = start; from < end; from += LEAF_VERTICES) {
        const to = Math.min(end, from + LEAF_VERTICES);
        const c = [0, 0, 0];
        for (let v = from; v < to; v++) for (let i = 0; i < 3; i++) c[i]! += p[3 * v + i]!;
        // The leaf's own color on the gradient, lifted bright so its glow reads as light.
        const at = slotOf?.[from] ?? 0;
        const lo = Math.min(Math.floor(at), SLOTS - 1);
        const hi = Math.min(lo + 1, SLOTS - 1);
        tint.fromArray(slots, 3 * lo).lerp(next.fromArray(slots, 3 * hi), at - Math.floor(at));
        tint.getHSL(hsl);
        tint.setHSL(hsl.h, Math.max(hsl.s, GLOW_SATURATION), Math.max(hsl.l, GLOW_LIGHTNESS));
        for (let v = from; v < to; v++, w++) {
          for (let i = 0; i < 3; i++) {
            position[3 * w + i] = p[3 * v + i]!;
            base[3 * w + i] = leaves.base[3 * v + i]!;
            center[3 * w + i] = c[i]! / (to - from);
          }
          timing[2 * w] = leaves.timing[2 * v]!;
          timing[2 * w + 1] = leaves.timing[2 * v + 1]!;
          id[w] = leaves.nodeId[v]!;
          births[w] = born?.[v] ?? 0;
          heats[w] = heat[v]!;
          tint.toArray(colors, 3 * w);
          rim[w] = (v - from) % 3 === 2 ? 0 : 1;
        }
      }
    }
    const geometry = new BufferGeometry()
      .setAttribute('position', new BufferAttribute(position, 3))
      .setAttribute('aBase', new BufferAttribute(base, 3))
      .setAttribute('aCenter', new BufferAttribute(center, 3))
      .setAttribute('aT', new BufferAttribute(timing, 2))
      .setAttribute('aId', new BufferAttribute(id, 1))
      .setAttribute('aBorn', new BufferAttribute(births, 1))
      .setAttribute('aHeat', new BufferAttribute(heats, 1))
      .setAttribute('aRim', new BufferAttribute(rim, 1))
      .setAttribute('color', new BufferAttribute(colors, 3));
    if (!glow) {
      glow = new Mesh(geometry, glowMaterial);
      glow.frustumCulled = false;
      glow.renderOrder = 1;
      scene.add(glow);
    }
    glow.geometry = geometry;
    // The glow sits on the tree's own leaves, so it takes their scale in a grove.
    glow.scale.setScalar(mainScale);
    glow.visible = count > 0;
  };

  /**
   * Rebuilds the birds on the tree on show: each standing on top of the crown, on a leaf of its
   * folder nearest the folder's anchor (perchOnCrown). Hidden while the timeline shows the past.
   */
  const perchBirds = () => {
    birdMesh.geometry.dispose();
    birdMesh.geometry = new BufferGeometry();
    birdSpots = [];
    birdMesh.visible = false;
    if (!shown || !birdPerches || birdPerches.length === 0) return requestRender();
    const { anchors, nodes, rocks, folders, leaves } = shown.model;
    const spots = perchOnCrown(
      birdPerches.map(({ folder }) => ({
        anchor: [anchors[3 * folder]!, anchors[3 * folder + 1]!, anchors[3 * folder + 2]!] as Vec3,
        range: [folders.range[2 * folder]!, folders.range[2 * folder + 1]!] as const,
      })),
      leaves,
    );
    const perches: Perched[] = spots.map((spot, i) => ({ ...spot, color: birdPerches![i]!.color }));
    birdMesh.geometry = birdGeometry(perches, nodes.folder.length + rocks.length);
    birdSpots = spots.map(({ at }) => at);
    birdMesh.visible = births === null;
    requestRender();
  };

  const bakeGround = () => {
    renderer.setRenderTarget(groundTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, bakeCamera);
    renderer.setRenderTarget(null);
  };

  const anchor = new Vector3();
  const axis = new Vector3();
  let labelFolders: readonly number[] | null = null;
  /**
   * The crown's outline on screen: the box around a ring of points at its widest reach, at the
   * height leaves start and at the top, shrunk because the crown is rounder than that cylinder.
   */
  const crownOnScreen = ({ min, max }: TreeModel['bounds']): Ellipse => {
    const { width, height } = freeRegion();
    const reach = Math.max(-min[0], max[0], -min[2], max[2]) * CROWN.reach;
    const low = min[1] + (max[1] - min[1]) * CROWN.from;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let k = 0; k < 16; k++) {
      const turn = (k / 8) * Math.PI;
      axis
        .set(Math.cos(turn) * reach, k % 2 ? low : max[1], Math.sin(turn) * reach)
        .project(camera);
      const x = ((axis.x + 1) / 2) * width;
      const y = ((1 - axis.y) / 2) * height;
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2 };
  };

  const emitLabels = () => {
    if (!shown || listeners.size === 0) return;
    const { width, height, x: left, y: top, w, h } = freeRegion();
    const growth = treeUniforms.uGrow.value;
    const { range } = shown.model.folders;
    const { anchors, bounds } = shown.model;
    const born = (folder: number) =>
      !births || births[range[2 * folder]!]! + treeUniforms.uSpan.value <= treeUniforms.uTime.value;
    const screen = (v: Vector3) => {
      v.project(camera);
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height, z: v.z };
    };
    const folders = labelFolders ?? shown.model.labels.map((l) => l.folder);
    const labels = folders.map((folder) => {
      const [ax, ay, az] = [
        anchors[folder * 3]! * mainScale,
        anchors[folder * 3 + 1]! * mainScale,
        anchors[folder * 3 + 2]! * mainScale,
      ];
      const reach = Math.hypot(ax, az);
      const facing = (ax * camera.position.x + az * camera.position.z) / (reach || 1);
      const toward = facing / (Math.hypot(camera.position.x, camera.position.z) || 1);
      const front = reach < BACK.near || toward > -BACK.facing;
      const t = Math.min(1, Math.max(0, (DEPTH.near - toward) / (DEPTH.near - DEPTH.far)));
      const depth = reach < BACK.near ? 0 : t * t * (3 - 2 * t);
      const { x, y, z } = screen(anchor.set(ax, ay, az));
      const free = x >= left && x <= left + w && y >= top && y <= top + h;
      return {
        folder,
        x,
        y,
        front,
        depth,
        visible: growth > LABELS_FROM && z < 1 && free && born(folder),
      };
    });
    // The underside of each island, or the foot of the trunk with the ground off.
    const foot = (
      bounds: TreeModel['bounds'],
      at: { x: number; y: number; z: number },
    ): IslandFoot => {
      const { x, y, z } = screen(anchor.set(at.x, at.y + (groundOn ? bounds.min[1] : 0), at.z));
      return { x, y, visible: z < 1 && x >= left && x <= left + w && y >= top && y <= top + h };
    };
    const islands = {
      main: foot(shown.groundBounds, { x: 0, y: 0, z: 0 }),
      companions: companions.map((c) => foot(c.groundBounds, c.group.position)),
    };
    const crown = crownOnScreen(scaled(bounds, mainScale));
    for (const listener of listeners) listener({ growth, labels, crown, islands });
  };

  /** The sky, the light and the weather's own objects for the palette, weather and quality. */
  const applyWeather = () => {
    const kind = weatherShown?.sky ?? null;
    skyColors = weatherSky(palette, kind, night);
    const { center, edge } = skyColors;
    showFlash(0);
    treeUniforms.uFade.value = [0, 1, 2].map((i) => (center[i]! + edge[i]!) / 2) as Vec3;
    key.intensity = LIGHT.key * weatherLight(kind).key * moonlight().key;
    fill.intensity = LIGHT.fill * moonlight().fill;
    weather.set({ sky: kind, palette, quality, still: weatherShown?.still ?? true, night });
    requestRender();
  };

  const applyPalette = () => {
    applyWeather();
    applySlots();
    barkMaterial.color.set(palette.bark);
    hemi.color.set(palette.light.sky);
    hemi.groundColor.set(palette.light.ground);
    key.color.set(palette.light.key);
    terrain.setPalette(palette);
    for (const c of companions) c.terrain.setPalette(palette);
    ground.material.color.set(palette.shadow);
    contact.material.color.set(palette.shadow);
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  };

  /**
   * Paints the sky (the container's CSS gradient, and the quad PNG snapshots draw), brightened
   * with the hemisphere light by a lightning flash, 0 to 1.
   */
  let painted = '';
  const showFlash = (flash: number) => {
    const bright = (c: readonly number[]) => c.map((v) => v + (0.95 - v) * flash * 0.5);
    const center = bright(skyColors.center);
    const edge = bright(skyColors.edge);
    sky.material.uniforms.uCenter!.value = center;
    sky.material.uniforms.uEdge!.value = edge;
    const css = (c: number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;
    const [c, e] = [css(center), css(edge)];
    const background = `radial-gradient(120% 90% at 50% 40%, ${c}, color-mix(in srgb, ${c}, ${e} 28%) 45%, ${e})`;
    if (background !== painted) container.style.background = painted = background;
    hemi.intensity =
      LIGHT.sky * weatherLight(weatherShown?.sky ?? null).sky * moonlight().sky * (1 + flash * 0.6);
  };

  const categories = () => leafCategories(shown!.model, colorBy, palette, facts, rank);
  /** Activity colors show only once the history is in; until then leaves keep their language. */
  const byActivity = () => colorBy === 'activity' && facts !== null;
  /** Changes colors likewise wait for the history. */
  const byChanges = () => colorBy === 'changes' && facts !== null;
  /** Dead wood drops its leaves, unless its legend entry is highlighted to show which they were. */
  const bare = () =>
    byActivity() &&
    !(highlight && 'category' in highlight && highlight.category === AGES[DEAD]!.label);

  const showHighlight = () => {
    const h = highlight;
    if (shown && bare() !== barren) applyBirths(timelineBirths);
    const offset = h && 'range' in h && h.companion !== undefined ? companionIds(h.companion) : 0;
    treeUniforms.uSel.value =
      h && 'range' in h ? [h.range[0] + offset, h.range[1] + offset] : [-1, -1];
    treeUniforms.uCategory.value =
      h && 'category' in h && shown
        ? categories().legend.findIndex((e) => e.label === h.category)
        : -1;
    requestRender();
  };

  /** The colors behind the slots: the palette's ramp, or the activity bands. */
  const applySlots = () => {
    const slots: number[] = [];
    const ramp = byActivity()
      ? palette.ages
      : byChanges()
        ? palette.changes
        : [...palette.leaves, palette.rest];
    for (let i = 0; i < SLOTS; i++) {
      const c = new Color(ramp[Math.min(i, ramp.length - 1)]);
      slots.push(c.r, c.g, c.b);
    }
    treeUniforms.uSlots.value = slots;
    treeUniforms.uDeadBark.value = new Color(palette.bark)
      .lerp(new Color(palette.sky.edge), DEAD_BLEACH)
      .toArray() as [number, number, number];
    // A deleted file's fallen leaf is a dry brown leaf, the same in every season, so it reads
    // against grass and the island's own fallen leaves alike.
    treeUniforms.uWither.value = new Color(WITHERED).toArray() as [number, number, number];
  };

  /**
   * Each leaf vertex's color slot and each bark vertex's dead flag for a tree, by the color-by
   * and that tree's own history facts. `ramp` is the slots' ramp the shared uniforms hold.
   */
  const slotsOf = (model: TreeModel, own: Facts | null, ramp: 'ages' | 'changes' | 'leaves') => {
    const { lang, nodeId } = model.leaves;
    const slot = new Float32Array(lang.length);
    const dead = new Float32Array(model.bark.nodeId.length);
    if (ramp === 'changes' && own) {
      const { vertex } = model.sprigs;
      for (let s = 0; s + 1 < vertex.length; s++) {
        slot.fill(CHANGES.length - 1 - own.sprigChangeLevel[s]!, vertex[s]!, vertex[s + 1]!);
      }
    } else if (ramp === 'ages' && own) {
      const { vertex } = model.sprigs;
      for (let s = 0; s + 1 < vertex.length; s++) {
        slot.fill(own.sprigBand[s]!, vertex[s]!, vertex[s + 1]!);
      }
      const barkNode = model.bark.nodeId;
      for (let v = 0; v < dead.length; v++) {
        dead[v] = ageBand(own.asOf, own.nodeChanged[barkNode[v]!]!) === DEAD ? 1 : 0;
      }
    } else {
      // Without its own history a tree keeps language colors, on whatever ramp is showing.
      const history = colorBy === 'activity' || colorBy === 'changes';
      const by = ramp === 'leaves' && !history ? colorBy : 'language';
      const { slotOf, nodeCategory } = leafCategories(model, by, palette, own, rank);
      for (let v = 0; v < slot.length; v++) {
        slot[v] = slotOf[nodeCategory ? nodeCategory[nodeId[v]!]! : lang[v]!]!;
      }
    }
    return { slot, dead };
  };

  const applyColorBy = () => {
    if (!shown) return;
    const ramp = byActivity() ? 'ages' : byChanges() ? 'changes' : 'leaves';
    const { slot, dead } = slotsOf(shown.model, facts, ramp);
    shown.leaves.geometry.setAttribute('aSlot', new BufferAttribute(slot, 1));
    shown.bark.geometry.setAttribute('aDead', new BufferAttribute(dead, 1));
    companions.forEach((c, i) => {
      // The same colors from its own history; until that is in, languages.
      const own = slotsOf(c.model, companionFacts[i] ?? null, ramp);
      c.leaves.geometry.setAttribute('aSlot', new BufferAttribute(own.slot, 1));
      c.bark.geometry.setAttribute('aDead', new BufferAttribute(own.dead, 1));
    });
    applySlots();
    applyBirths(timelineBirths);
    applyHeat();
    showHighlight();
  };

  /** Sizes the light, its shadow and the floor to the tree and, while it shows, its ground. */
  const placeScene = () => {
    if (!shown) return;
    const { model, groundBounds } = shown;
    const tree = scaled(model.bounds, mainScale);
    shown.bounds = groundOn ? union(tree, groundBounds) : tree;
    terrain.land.visible = terrain.cover.visible = groundOn;
    // In a small grove (grove.ts): a row of two, a triangle, a square, or two rows, one island's
    // width apart from trunk to trunk, the tree on show where it always stands.
    const reachOf = (b: TreeModel['bounds']) => Math.max(-b.min[0], b.max[0], -b.min[2], b.max[2]);
    const islands = companions.map((c) => {
      const own = scaled(c.model.bounds, c.bark.scale.x);
      return { own, other: groundOn ? union(own, c.groundBounds) : own };
    });
    const pitch =
      2 * Math.max(reachOf(shown.bounds), ...islands.map((i) => reachOf(i.other))) + COMPANION_GAP;
    const spots = groveSpots([tree.max[1], ...islands.map((i) => i.own.max[1])]);
    // What the grove covers as seen from the front: across the view and toward the camera.
    const main = reachOf(shown.bounds);
    const span = { across: [-main, main], toward: [-main, main] };
    companions.forEach((c, k) => {
      const { across, toward } = spots[k + 1]!;
      const reach = reachOf(islands[k]!.other);
      span.across = [
        Math.min(span.across[0]!, across * pitch - reach),
        Math.max(span.across[1]!, across * pitch + reach),
      ];
      span.toward = [
        Math.min(span.toward[0]!, toward * pitch - reach),
        Math.max(span.toward[1]!, toward * pitch + reach),
      ];
      c.group.position.set(
        (SIDEWAYS[0] * across + TOWARD[0] * toward) * pitch,
        0,
        (SIDEWAYS[1] * across + TOWARD[1] * toward) * pitch,
      );
      c.terrain.land.visible = c.terrain.cover.visible = groundOn;
      const { x, y, z } = c.group.position;
      const { other } = islands[k]!;
      shown!.bounds = union(shown!.bounds, {
        min: [other.min[0] + x, other.min[1] + y, other.min[2] + z],
        max: [other.max[0] + x, other.max[1] + y, other.max[2] + z],
      });
    });
    {
      const a = (span.across[0]! + span.across[1]!) / 2;
      const t = (span.toward[0]! + span.toward[1]!) / 2;
      const { min: low, max: high } = shown.bounds;
      grove = {
        center: [
          SIDEWAYS[0] * a + TOWARD[0] * t,
          (low[1] + high[1]) / 2,
          SIDEWAYS[1] * a + TOWARD[1] * t,
        ],
        across: span.across[1]! - span.across[0]!,
        deep: span.toward[1]! - span.toward[0]!,
        tall: high[1] - low[1],
      };
    }
    for (const mesh of [ground, contact, baked]) mesh.visible = !groundOn;
    const { min, max } = shown.bounds;
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = Math.max(max[0] - min[0], max[1] - min[1]);
    const toSun = Math.hypot(3, 5);
    key.position.set(center[0] + SUN_BEARING[0] * toSun, 12, center[2] + SUN_BEARING[1] * toSun);
    key.target.position.set(...center);
    Object.assign(key.shadow.camera, {
      left: -size * 0.9,
      right: size * 0.9,
      top: size * 0.9,
      bottom: -size * 0.9,
      near: 0.1,
      far: 40,
    });
    key.shadow.camera.updateProjectionMatrix();
    contact.scale.setScalar(Math.max(1.6, (max[0] - min[0]) * 0.55));
    const reach = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1.5;
    baked.position.x = bakeCamera.position.x = center[0];
    baked.position.z = bakeCamera.position.z = center[2];
    baked.scale.setScalar(reach * 2);
    bakeCamera.position.y = 20;
    bakeCamera.lookAt(center[0], 0, center[2]);
    Object.assign(bakeCamera, { left: -reach, right: reach, top: reach, bottom: -reach });
    bakeCamera.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  };

  /**
   * Writes each vertex's birth: its node's for bark, its sprig's for leaves. Dropped dead-wood
   * leaves are born never, so no pass (color, shadow, pick) draws them.
   */
  let timelineBirths: { nodes: Float32Array; sprigs: Float32Array } | null = null;
  /** The companions' births while the timeline replays them with this tree (setCompanionBirths). */
  let companionBirths: ReadonlyMap<TreeModel, Births> | null = null;
  const applyCompanionBirths = () => {
    for (const c of companions) {
      const births = companionBirths?.get(c.model);
      const { bark, leaves, sprigs } = c.model;
      const barkBorn = new Float32Array(bark.nodeId.length);
      const leafBorn = new Float32Array(leaves.nodeId.length);
      if (births) {
        for (let v = 0; v < barkBorn.length; v++) barkBorn[v] = births.nodes[bark.nodeId[v]!]!;
        for (let k = 0; k + 1 < sprigs.vertex.length; k++) {
          leafBorn.fill(births.sprigs[k]!, sprigs.vertex[k]!, sprigs.vertex[k + 1]!);
        }
      }
      c.bark.geometry.setAttribute('aBorn', new BufferAttribute(barkBorn, 1));
      c.leaves.geometry.setAttribute('aBorn', new BufferAttribute(leafBorn, 1));
    }
  };
  let barren = false;
  /** When dead-wood leaves began to fall, or -1: they fall as they drop, unless motion is reduced. */
  let fallStart = -1;
  const applyBirths = (next: { nodes: Float32Array; sprigs: Float32Array } | null) => {
    if (!shown) return;
    timelineBirths = next;
    const wasBarren = barren;
    barren = bare();
    if (!barren || reducedMotion) fallStart = -1;
    else if (!wasBarren) fallStart = performance.now();
    const falling = fallStart >= 0;
    treeUniforms.uFall.value = falling ? treeUniforms.uFall.value : 0;
    const fall = new Float32Array(falling ? shown.model.leaves.nodeId.length : 0);
    const { bark, leaves, sprigs } = shown.model;
    const barkBorn = new Float32Array(bark.nodeId.length);
    const leafBorn = new Float32Array(leaves.nodeId.length);
    if (next) {
      for (let v = 0; v < barkBorn.length; v++) barkBorn[v] = next.nodes[bark.nodeId[v]!]!;
    }
    for (let s = 0; s + 1 < sprigs.vertex.length; s++) {
      const dropped = barren && facts!.sprigBand[s] === DEAD;
      if (dropped && falling) fall.fill(1, sprigs.vertex[s]!, sprigs.vertex[s + 1]!);
      const born = dropped && !falling ? NEVER : next ? next.sprigs[s]! : 0;
      if (born) leafBorn.fill(born, sprigs.vertex[s]!, sprigs.vertex[s + 1]!);
    }
    shown.bark.geometry.setAttribute('aBorn', new BufferAttribute(barkBorn, 1));
    shown.leaves.geometry.setAttribute('aBorn', new BufferAttribute(leafBorn, 1));
    if (glowing > 0) placeGlow();
    shown.leaves.geometry.setAttribute(
      'aFall',
      new BufferAttribute(withDrops(falling ? fall : new Float32Array(leafBorn.length)), 1),
    );
    births = next?.nodes ?? null;
    birdMesh.visible = births === null && birdSpots.length > 0;
    if (!next) treeUniforms.uTime.value = ALWAYS;
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  };

  /** Marks the leaves of files a compared branch deletes to fall and stay (2). */
  const withDrops = (fall: Float32Array) => {
    if (!diff) return fall;
    diff.forEach((mark, i) => {
      if (mark !== DIFF.removed) return;
      for (let v = i * LEAF_VERTICES; v < (i + 1) * LEAF_VERTICES && v < fall.length; v++) {
        if (!fall[v]) fall[v] = 2;
      }
    });
    return fall;
  };
  /** Writes the drops into `aFall` beside any dead wood falling, and lets them fall. */
  const applyDrops = () => {
    if (!shown) return;
    const attr = shown.leaves.geometry.getAttribute('aFall');
    const fall = new Float32Array(shown.model.leaves.nodeId.length);
    const was = attr?.array as Float32Array | undefined;
    if (was && was.length === fall.length)
      for (let v = 0; v < fall.length; v++) if (was[v] === 1) fall[v] = 1;
    shown.leaves.geometry.setAttribute('aFall', new BufferAttribute(withDrops(fall), 1));
    const any = !!diff && diff.includes(DIFF.removed);
    // They fall once the tree has grown in, so the fall reads on its own.
    const grown = growingNow ? growStart + GROW_MS : 0;
    dropStart = any && !reducedMotion ? Math.max(performance.now(), grown) : -1;
    treeUniforms.uDrop.value = any && reducedMotion ? 1 : 0;
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  };

  const releaseCompanions = () => {
    for (const c of companions) {
      scene.remove(c.group);
      c.bark.geometry.dispose();
      c.leaves.geometry.dispose();
      c.terrain.dispose();
    }
    companions = [];
  };

  const releaseTree = () => {
    if (!shown) return;
    scene.remove(shown.bark, shown.leaves);
    if (glow) glow.visible = false;
    shown.bark.geometry.dispose();
    shown.leaves.geometry.dispose();
    shown = null;
  };

  const startGrowth = () => {
    growingNow = !reducedMotion;
    growStart = performance.now();
    treeUniforms.uGrow.value = reducedMotion ? 1 : 0;
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  };

  const onStart = () => {
    aim = null;
    gliding = false;
  };
  controls.addEventListener('start', onStart);
  controls.addEventListener('change', requestRender);
  const observer = new ResizeObserver(() => resize());
  observer.observe(container);
  mountRenderer();
  applyPalette();

  const api: TreeView = {
    setTree(model) {
      releaseTree();
      treeUniforms.uFocus.value = -1;
      keptRock = null;
      labelFolders = null;
      const bark = new Mesh(geometry(model.bark), barkMaterial);
      const leafGeometry = geometry(model.leaves).setAttribute(
        'aShade',
        new BufferAttribute(model.leaves.shade, 2),
      );
      const leaves = new Mesh(leafGeometry, leafMaterial);
      for (const mesh of [bark, leaves]) {
        mesh.customDepthMaterial = depthMaterial;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
      }
      for (const mesh of [bark, leaves]) mesh.scale.setScalar(mainScale);
      scene.add(bark, leaves);
      if (!linked) staged = [terrain.cover, bark, leaves, ...weather.objects];
      linked = true;
      const nodes = model.nodes.folder.length;
      shown = {
        model,
        bark,
        leaves,
        boxes: { leaves: nodeBoxes(model.leaves, nodes), bark: nodeBoxes(model.bark, nodes) },
        bounds: model.bounds,
        groundBounds: terrain.setTree(model, quality),
      };
      highlight = null;
      facts = null;
      barren = false;
      fallStart = -1;
      treeUniforms.uFloor.value = model.bounds.min[1];
      treeUniforms.uWindHeight.value = Math.max(1, model.bounds.max[1]);
      applyBirths(null);
      // Matches and a compared branch name the last tree's files: the caller gives this tree's.
      matches = null;
      diff = null;
      dropStart = -1;
      treeUniforms.uDrop.value = 0;
      companionMatches = [];
      applyMatches();
      // Perches name the last tree's folders: the caller gives this tree's.
      birdPerches = null;
      perchBirds();
      applyColorBy();
      placeScene();
      aim = { kind: 'tree' };
      gliding = false;
      camera.position.copy(controls.target).add(new Vector3(...VIEW_DIRECTION));
      reaim(true);
      controls.update();
      startGrowth();
    },

    setNight(on) {
      if (on === night) return;
      night = on;
      applyWeather();
      if (glowing > 0) {
        treeUniforms.uGlow.value = reducedMotion ? glowPeak() : glowAt(performance.now());
      }
    },
    setGround(on) {
      groundOn = on;
      if (!shown) return;
      placeScene();
      reaim(false);
    },

    grow() {
      if (shown) startGrowth();
    },

    setBirds(next) {
      if (next === birdPerches) return;
      birdPerches = next;
      perchBirds();
    },

    birdsOnScreen() {
      const { width, height } = freeRegion();
      return birdSpots.map(([x, y, z]) => {
        const p = anchor.set(x, y + BIRD_SIZE * 0.25, z).project(camera);
        return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
      });
    },

    setTimeline(next) {
      applyBirths(next);
    },

    setCompanionBirths(next) {
      companionBirths = next;
      applyCompanionBirths();
      renderer.shadowMap.needsUpdate = true;
      requestRender();
    },

    setTime(cursor) {
      if (treeUniforms.uTime.value === cursor) return;
      treeUniforms.uTime.value = cursor;
      renderer.shadowMap.needsUpdate = true;
      requestRender();
    },

    setWeather(next) {
      weatherShown = next;
      applyWeather();
    },

    setPalette(id) {
      palette = PALETTES[id];
      applyPalette();
      applyColorBy();
    },

    setColorBy(by) {
      colorBy = by;
      applyColorBy();
    },

    setLanguageRank(next) {
      rank = next;
      applyColorBy();
    },

    setCompanions(models, scale) {
      releaseCompanions();
      mainScale = models.length ? (scale?.main ?? 1) : 1;
      if (shown) for (const mesh of [shown.bark, shown.leaves]) mesh.scale.setScalar(mainScale);
      glow?.scale.setScalar(mainScale);
      models.forEach((model, i) => {
        const bark = new Mesh(geometry(model.bark), barkMaterial);
        const leafGeometry = geometry(model.leaves).setAttribute(
          'aShade',
          new BufferAttribute(model.leaves.shade, 2),
        );
        // It never dies back, glows or waits on a timeline.
        const leafCount = model.leaves.nodeId.length;
        for (const name of ['aBorn', 'aFall', 'aHeat']) {
          leafGeometry.setAttribute(name, new BufferAttribute(new Float32Array(leafCount), 1));
        }
        const barkCount = model.bark.nodeId.length;
        for (const name of ['aBorn', 'aDead']) {
          bark.geometry.setAttribute(name, new BufferAttribute(new Float32Array(barkCount), 1));
        }
        const leaves = new Mesh(leafGeometry, leafMaterial);
        for (const mesh of [bark, leaves]) {
          mesh.customDepthMaterial = depthMaterial;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          // Its node ids lie past any of the first tree's, so a pin there fades all of it, and
          // past the other companions', so picking tells them apart.
          const ids = Float32Array.from(
            mesh.geometry.getAttribute('aId').array,
            (id) => id + companionIds(i),
          );
          mesh.geometry.setAttribute('aId', new BufferAttribute(ids, 1));
          mesh.scale.setScalar(scale?.companions[i] ?? 1);
        }
        const ground = createGround();
        const groundBounds = ground.setTree(model, quality);
        ground.setPalette(palette);
        const group = new Group();
        group.add(bark, leaves, ground.land, ground.cover);
        scene.add(group);
        companions.push({ model, group, bark, leaves, terrain: ground, groundBounds });
      });
      applyCompanionBirths();
      // Matches name the last grove's files: the caller lights this one's again.
      companionMatches = [];
      applyMatches();
      if (!shown) return;
      applyColorBy();
      placeScene();
      // Rows need a higher view; a lone tree or a pair goes back to the usual one.
      const rows = models.length >= 2;
      if (rows !== (rowsBefore ?? false)) tilt(rows ? GROVE_LEVEL : LEVEL);
      rowsBefore = rows;
      aim = { kind: 'tree' };
      reaim(false);
      startGrowth();
    },

    setFacts(next) {
      facts = next;
      applyColorBy();
    },

    setCompanionFacts(next) {
      companionFacts = next;
      applyColorBy();
    },

    legend() {
      return shown ? categories().legend : [];
    },

    setHighlight(next) {
      highlight = next;
      showHighlight();
    },

    atHome() {
      if (!shown || aim?.kind === 'tree') return true;
      if (aim) return false;
      const whole = frameWhole(roomOf());
      const far = distanceOf(whole.position, whole.target);
      const t = controls.target;
      const off = Math.hypot(t.x - whole.target[0], t.y - whole.target[1], t.z - whole.target[2]);
      return off < far * 0.03 && Math.abs(camera.position.distanceTo(t) - far) < far * 0.04;
    },

    frameFolder(folder) {
      if (!shown) return;
      const { range } = shown.model.folders;
      aim =
        folder === 0
          ? { kind: 'tree' }
          : {
              kind: 'folder',
              ...scaledSphere(
                folderSphere(shown.boxes, range[2 * folder]!, range[2 * folder + 1]!),
                mainScale,
              ),
            };
      reaim(false);
    },

    room() {
      return roomOf();
    },

    wholeDistance(aspect) {
      const { position, target } = frameWhole(roomOf(), aspect);
      return distanceOf(position, target);
    },

    setInsets({ top, right, bottom, left }) {
      insets.goal = [top, right, bottom, left];
      if (!shown) {
        insets.value = [...insets.goal];
        applyView();
      }
      requestRender();
    },

    skyAt(x, y) {
      return skyTargetAt(x, y) !== null;
    },

    skyTargetAt,

    setHover(hover) {
      hovering = hover;
      applyFocus();
    },

    keepRock(rock) {
      keptRock = rock;
      applyFocus();
    },

    setMatches(files, others = []) {
      matches = files;
      companionMatches = others;
      applyMatches();
    },

    setDiff(files) {
      diff = files && shown ? diffLeaves(shown.model, files, LEAF_VERTICES) : null;
      applyMatches();
      applyDrops();
    },

    pickAt(x, y) {
      if (!shown) return null;
      const { width, height, x: left, y: top, w, h } = freeRegion();
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const hidden = [
        sky,
        baked,
        glow,
        terrain.cover,
        // A compared tree's branches pick; its island does not.
        ...companions.flatMap((c) => [c.terrain.land, c.terrain.cover]),
        ...weather.objects,
      ].filter((o): o is NonNullable<typeof o> => !!o?.visible);
      for (const mesh of hidden) mesh.visible = false;
      const shadowPending = renderer.shadowMap.needsUpdate;
      renderer.shadowMap.needsUpdate = false;
      scene.overrideMaterial = pickMaterial;
      camera.setViewOffset(w, h, Math.floor(x) - left, Math.floor(y) - top, 1, 1);
      renderer.setRenderTarget(pickTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel);
      renderer.setRenderTarget(null);
      applyView();
      scene.overrideMaterial = null;
      renderer.shadowMap.needsUpdate = shadowPending;
      for (const mesh of hidden) mesh.visible = true;
      const id = pickPixel[0]! + pickPixel[1]! * 256 + pickPixel[2]! * 65536 - 1;
      const nodes = shown.model.nodes.folder.length;
      const rocks = shown.model.rocks.length;
      if (id < 0) return null;
      if (id >= COMPANION_IDS) {
        const k = Math.floor((id - COMPANION_IDS) / COMPANION_STRIDE);
        const folder = companions[k]?.model.nodes.folder[id - companionIds(k)];
        return folder === undefined ? null : { folder, companion: k };
      }
      if (id < nodes) return { folder: shown.model.nodes.folder[id]! };
      if (id < nodes + rocks) return { folder: 0, rock: id - nodes };
      const bird = id - nodes - rocks;
      const perch = birdPerches?.[bird];
      return perch ? { folder: perch.folder, bird } : null;
    },

    setQuality(next) {
      const antialiasChanged = QUALITY[next].antialias !== QUALITY[quality].antialias;
      quality = next;
      if (antialiasChanged) {
        mountRenderer();
        applyPalette();
        return;
      }
      const { pixelRatio, shadowMap } = QUALITY[quality];
      renderer.setPixelRatio(Math.min(pixelRatio, window.devicePixelRatio || 1));
      key.shadow.mapSize.set(shadowMap, shadowMap);
      groundTarget.setSize(shadowMap, shadowMap);
      key.shadow.map?.dispose();
      key.shadow.map = null;
      resize();
      renderer.shadowMap.needsUpdate = true;
      applyWeather();
    },

    setSpin(on) {
      controls.autoRotate = on;
      requestRender();
    },

    setReducedMotion(on) {
      reducedMotion = on;
      controls.momentum = !on;
      if (on) controls.stop();
      birdUniforms.uBirdMotion.value = on ? 0 : 1;
      treeUniforms.uWind.value = on ? 0 : 1;
      requestRender();
      if (glowing > 0) {
        treeUniforms.uGlow.value = on ? glowPeak() : glowAt(performance.now());
        requestRender();
      }
      if (on && growingNow) {
        growingNow = false;
        treeUniforms.uGrow.value = 1;
        renderer.shadowMap.needsUpdate = true;
        requestRender();
      }
    },

    setLabelFolders(folders) {
      labelFolders = folders;
      requestRender();
    },

    onFrame(listener) {
      listeners.add(listener);
      requestRender();
      return () => listeners.delete(listener);
    },

    async snapshotPNG(scale) {
      const ratio = renderer.getPixelRatio();
      renderer.setPixelRatio(scale);
      const { width, height } = freeRegion();
      camera.setViewOffset(width, height, 0, 0, width, height);
      sky.visible = true;
      renderer.render(scene, camera);
      sky.visible = false;
      applyView();
      const blob = await new Promise<Blob | null>((resolve) =>
        renderer.domElement.toBlob(resolve, 'image/png'),
      );
      renderer.setPixelRatio(ratio);
      requestRender();
      if (!blob) throw new Error('the canvas could not be encoded as PNG');
      return blob;
    },

    stats() {
      const { render, memory } = renderer.info;
      return {
        renders,
        distance: camera.position.distanceTo(controls.target),
        target: controls.target.toArray(),
        azimuth: controls.getAzimuthalAngle(),
        calls: render.calls,
        triangles: render.triangles,
        geometries: memory.geometries,
        textures: memory.textures,
        glowing,
      };
    },

    dispose() {
      cancelAnimationFrame(raf);
      clearTimeout(pulseTimer);
      observer.disconnect();
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      releaseTree();
      releaseCompanions();
      birdMesh.geometry.dispose();
      for (const mesh of [sky, ground, contact, baked]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      for (const material of [
        barkMaterial,
        leafMaterial,
        depthMaterial,
        pickMaterial,
        glowMaterial,
        birdMaterial,
      ]) {
        material.dispose();
      }
      terrain.dispose();
      weather.dispose();
      contactTexture.dispose();
      groundTarget.dispose();
      pickTarget.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      listeners.clear();
    },
  };
  return api;
}

/**
 * What each leaf color stands for: languages, top-level folders plus the files at the root,
 * activity bands, or the owners of those folders (timeline/owners.ts) once the facts are in.
 * `nodeCategory` (folder and owner colors) is each node's category; a leaf takes its language's.
 */
export function leafCategories(
  model: TreeModel,
  colorBy: ColorBy,
  palette: Palette,
  facts: Facts | null = null,
  rank: ReadonlyMap<string, number> | null = null,
): { slotOf: number[]; legend: LegendEntry[]; nodeCategory?: Int32Array } {
  if (colorBy === 'changes' && facts) {
    const files = CHANGES.map(() => 0);
    for (const churn of facts.fileChurn) files[changeBand(churn)]! += 1;
    return {
      slotOf: CHANGES.map((_, i) => i),
      legend: CHANGES.map((c, i) => ({
        color: litColor(palette.changes[i]!, palette),
        label: c.label,
        files: files[i]!,
      })),
    };
  }
  if (colorBy === 'activity' && facts) {
    // Bands keep their order and their slot, so legend index, slot and band agree.
    const files = AGES.map(() => 0);
    for (const ms of facts.fileChanged) files[ageBand(facts.asOf, ms)]! += 1;
    return {
      slotOf: AGES.map((_, i) => i),
      legend: AGES.map((a, i) => ({
        color: litColor(palette.ages[i]!, palette),
        label: a.label,
        files: files[i]!,
      })),
    };
  }
  if (colorBy !== 'folder' && !(colorBy === 'owner' && facts)) {
    if (!rank) {
      return leafMapping(
        model.langs.map((l) => ({ label: l.lang, files: l.files })),
        palette,
      );
    }
    // Slots follow the shared ranking, so a language takes the same slot in every tree ranked
    // by it. The legend lists every shared slot (its index is the slot), with this tree's own
    // files, which are 0 for a language only the other trees have.
    const ramp = palette.leaves.length;
    const order = [...rank]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([label]) => label);
    const at = new Map(order.map((label, i) => [label, i]));
    const slotOf = model.langs.map((l) => Math.min(at.get(l.lang) ?? ramp, ramp));
    const own = new Map<string, number>(model.langs.map((l) => [l.lang, l.files]));
    const shown = slotColors(palette);
    const legend = order
      .slice(0, ramp)
      .map((label, i) => ({ color: shown[i]!, label, files: own.get(label) ?? 0 }));
    const rest = model.langs.filter((_, i) => slotOf[i] === ramp);
    if (rest.length > 0 || order.length > ramp) {
      legend.push({
        color: shown[ramp]!,
        label: `${Math.max(order.length - ramp, rest.length)} more`,
        files: rest.reduce((sum, l) => sum + l.files, 0),
      });
    }
    return { slotOf, legend };
  }
  const tops = model.labels.map((l) => ({
    label: model.folders.path[l.folder]!,
    files: l.files,
  }));
  const total = model.nodes.files.reduce((sum, n) => sum + n, 0);
  const atRoot = total - tops.reduce((sum, t) => sum + t.files, 0);
  const withRoot = atRoot > 0 ? [...tops, { label: 'top-level files', files: atRoot }] : tops;
  const nodeCategory = new Int32Array(model.nodes.folder.length).fill(tops.length);
  model.labels.forEach(({ folder }, i) => {
    nodeCategory.fill(
      i,
      model.folders.range[2 * folder]!,
      model.folders.range[2 * folder + 1]! + 1,
    );
  });
  if (colorBy === 'owner' && facts) {
    // Each top-level folder (the root's own files last) takes its owner's category.
    const { categories, categoryOf } = ownerCategories(
      withRoot.map((t, i) => ({ folder: i < tops.length ? t.label : '', files: t.files })),
      facts.owners,
    );
    for (let n = 0; n < nodeCategory.length; n++) nodeCategory[n] = categoryOf[nodeCategory[n]!]!;
    return { ...leafMapping(categories, palette), nodeCategory };
  }
  return { ...leafMapping(withRoot, palette), nodeCategory };
}

function geometry(mesh: MeshData): BufferGeometry {
  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(mesh.position, 3))
    .setAttribute('normal', new BufferAttribute(mesh.normal, 3))
    .setAttribute('aBase', new BufferAttribute(mesh.base, 3))
    .setAttribute('aT', new BufferAttribute(mesh.timing, 2))
    .setAttribute('aId', new BufferAttribute(mesh.nodeId, 1))
    .setIndex(new BufferAttribute(mesh.index, 1));
}

/** Bounds grown or shrunk about the foot of the trunk. */
function scaled(b: TreeModel['bounds'], by: number): TreeModel['bounds'] {
  if (by === 1) return b;
  return { min: b.min.map((v) => v * by) as Vec3, max: b.max.map((v) => v * by) as Vec3 };
}
function scaledSphere(s: { center: Vec3; radius: number }, by: number) {
  return { center: s.center.map((v) => v * by) as Vec3, radius: s.radius * by };
}

function union(a: TreeModel['bounds'], b: TreeModel['bounds']): TreeModel['bounds'] {
  return {
    min: [0, 1, 2].map((i) => Math.min(a.min[i]!, b.min[i]!)) as Vec3,
    max: [0, 1, 2].map((i) => Math.max(a.max[i]!, b.max[i]!)) as Vec3,
  };
}

function nodeBoxes({ position, nodeId }: MeshData, nodes: number): Float32Array {
  const boxes = new Float32Array(nodes * 6);
  for (let n = 0; n < boxes.length; n += 6)
    boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], n);
  for (let v = 0; v < nodeId.length; v++) {
    const b = nodeId[v]! * 6;
    for (let axis = 0; axis < 3; axis++) {
      const p = position[v * 3 + axis]!;
      if (p < boxes[b + axis]!) boxes[b + axis] = p;
      if (p > boxes[b + 3 + axis]!) boxes[b + 3 + axis] = p;
    }
  }
  return boxes;
}

/** The sphere around the leaves of nodes lo..hi, or around their bark if they bear none. */
function folderSphere(
  boxes: Shown['boxes'],
  lo: number,
  hi: number,
): { center: Vec3; radius: number } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const corner = new Vector3();
  for (const kind of [boxes.leaves, boxes.bark]) {
    for (let n = lo; n <= hi; n++) {
      min.min(corner.fromArray(kind, n * 6));
      max.max(corner.fromArray(kind, n * 6 + 3));
    }
    if (min.x !== Infinity) break;
  }
  return {
    center: min.clone().add(max).multiplyScalar(0.5).toArray(),
    radius: min.distanceTo(max) / 2,
  };
}

type Spring = { value: number[]; velocity: number[]; goal: number[]; moved: boolean };

const spring = (value: number[]): Spring => ({
  value: [...value],
  velocity: value.map(() => 0),
  goal: [...value],
  moved: false,
});

/**
 * Advances a critically damped spring by `dt` seconds in closed form, so it eases out of rest
 * and into its goal at any frame rate and can be retargeted mid-flight without a jolt.
 * Returns whether it is still moving; `moved` says whether this step changed its value.
 */
function step(s: Spring, dt: number, rate: number, epsilon: number): boolean {
  const decay = Math.exp(-rate * dt);
  let moving = false;
  s.moved = false;
  for (let i = 0; i < s.value.length; i++) {
    const offset = s.value[i]! - s.goal[i]!;
    const v = s.velocity[i]!;
    if (offset === 0 && v === 0) continue;
    s.moved = true;
    const k = v + rate * offset;
    const next = (offset + k * dt) * decay;
    const velocity = (v - rate * k * dt) * decay;
    if (Math.abs(next) < epsilon && Math.abs(velocity) < epsilon * rate) {
      s.value[i] = s.goal[i]!;
      s.velocity[i] = 0;
    } else {
      s.value[i] = s.goal[i]! + next;
      s.velocity[i] = velocity;
      moving = true;
    }
  }
  return moving;
}

/**
 * A soft round shadow under the trunk, white so the material color tints it. Filled in JS: a
 * 2D canvas for it started a second GPU context, a 130 to 180 ms wait at startup.
 */
function radialTexture(): DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      data[(y * size + x) * 4 + 3] = Math.round(255 * 0.28 * Math.max(0, 1 - t));
    }
  }
  const texture = new DataTexture(data, size, size);
  Object.assign(texture, {
    colorSpace: SRGBColorSpace,
    magFilter: LinearFilter,
    minFilter: LinearMipmapLinearFilter,
    generateMipmaps: true,
    needsUpdate: true,
  });
  return texture;
}
