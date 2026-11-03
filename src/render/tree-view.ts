import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData, Quality, TreeModel, Vec3 } from '../grow/grow';
import { distanceOf, FOV, frameFolder, frameTree, stage, VIEW_DIRECTION } from './framing';
import { LIGHT } from './color';
import { createGround } from './ground';
import {
  leafMapping,
  PALETTES,
  type ColorBy,
  type LegendEntry,
  type Palette,
  type PaletteId,
} from './palette';
import {
  barkShader,
  growing,
  leafShader,
  PICK_FRAGMENT,
  PICK_VERTEX,
  SKY_FRAGMENT,
  SKY_VERTEX,
  treeUniforms,
} from './shaders';

/** What a pixel shows: a folder's branch, or a rock lying for some of the root folder's files. */
export type Picked = { folder: number; rock?: number };
export type LabelPosition = { folder: number; x: number; y: number; visible: boolean };
export type FrameInfo = { growth: number; labels: LabelPosition[] };
/** CSS pixels along each edge of the container that panels cover. */
export type Insets = { top: number; right: number; bottom: number; left: number };
/** What stands out while the rest fades: a run of node ids, or the leaves of one legend entry. */
export type Highlight = { range: readonly [number, number] } | { category: string };
export type ViewStats = {
  renders: number;
  /** How far the camera stands from the point it orbits. */
  distance: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
};

export interface TreeView {
  /** Shows a new tree, framed whole, growing unless reduced motion is on. */
  setTree(model: TreeModel): void;
  /** Replays the growth of the tree on show, or shows it grown under reduced motion. */
  grow(): void;
  setPalette(id: PaletteId): void;
  setColorBy(by: ColorBy): void;
  /** What each leaf color stands for under the current palette and color-by. */
  legend(): LegendEntry[];
  /**
   * Fades every node outside a range, or the bark and every leaf outside the legend entry
   * labelled `category`. A label the legend lacks highlights nothing.
   */
  setHighlight(highlight: Highlight | null): void;
  /** Glides the camera to a folder in context; the root folder (0) frames the whole tree. */
  frameFolder(folder: number): void;
  /** Frames the tree into the part of the container the insets leave free, easing there. */
  setInsets(insets: Insets): void;
  /** The folder or rock under a point in CSS pixels relative to the container, from a GPU id pass. */
  pickAt(x: number, y: number): Picked | null;
  /** Shows the mound, its rocks and its grass under the tree, or the bare shadow. */
  setGround(on: boolean): void;
  setQuality(quality: Quality): void;
  setSpin(on: boolean): void;
  setReducedMotion(on: boolean): void;
  /**
   * Called after every rendered frame with each top-level label's screen position; a label is
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
};

const QUALITY: Record<Quality, { pixelRatio: number; shadowMap: number; antialias: boolean }> = {
  low: { pixelRatio: 1, shadowMap: 1024, antialias: false },
  medium: { pixelRatio: 1.5, shadowMap: 2048, antialias: true },
  high: { pixelRatio: 2, shadowMap: 2048, antialias: true },
};

const GROW_MS = 2600;
const BAKED = 1;
const LABELS_FROM = 0.55;
const SPIN_SPEED = 0.55;
/** Spring rates: the camera settles in about a second, the free region in about a third. */
const GLIDE_RATE = 6.5;
const INSET_RATE = 16;
/** The free region keeps at least this share of the container on each axis. */
const MIN_FREE = 0.2;
/** The ramp every palette shares, plus the slot for the rest. */
const SLOTS = PALETTES.autumn.leaves.length + 1;

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
  let reducedMotion = options.reducedMotion;
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
  let groundOn = options.ground;

  const barkMaterial = barkShader(new MeshStandardMaterial({ roughness: 0.92, flatShading: true }));
  const leafMaterial = leafShader(
    new MeshStandardMaterial({ roughness: 0.8, side: DoubleSide }),
    SLOTS,
  );
  const depthMaterial = growing(new MeshDepthMaterial());
  const pickMaterial = new ShaderMaterial({
    vertexShader: PICK_VERTEX,
    fragmentShader: PICK_FRAGMENT,
    uniforms: { uGrow: treeUniforms.uGrow },
    side: DoubleSide,
    toneMapped: false,
  });
  const pickTarget = new WebGLRenderTarget(1, 1);
  const pickPixel = new Uint8Array(4);

  let renderer: WebGLRenderer;
  const controls = new OrbitControls(camera, container);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.maxPolarAngle = Math.PI * 0.53;
  controls.autoRotate = options.spin;
  controls.autoRotateSpeed = SPIN_SPEED;

  let shown: Shown | null = null;
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
  const listeners = new Set<(info: FrameInfo) => void>();

  const mountRenderer = () => {
    const { antialias, pixelRatio, shadowMap } = QUALITY[quality];
    const next = new WebGLRenderer({ antialias, powerPreference: 'high-performance' });
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
    key.shadow.mapSize.set(shadowMap, shadowMap);
    groundTarget.setSize(shadowMap, shadowMap);
    renderer.autoClearColor = false;
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
   * Points the camera springs at what `aim` frames; `snap` jumps there. The whole view frames
   * the stage, the tallest tree on the island, not the tree on show, so every repo is seen at
   * one scale and a bigger repo shows as a bigger tree.
   */
  const reaim = (snap: boolean) => {
    if (!shown || !aim) return;
    const room = stage(groundOn);
    const whole = frameTree(room, camera.aspect);
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

  /** Moves the camera to the spring's target and distance along its current direction. */
  const placeCamera = () => {
    const [x, y, z, distance] = look.value as [number, number, number, number];
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-12) direction.set(...VIEW_DIRECTION);
    controls.target.set(x, y, z);
    camera.position.copy(controls.target).addScaledVector(direction.normalize(), distance);
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
    if (controls.update(dt)) busy = true;

    const shadowChanged = renderer.shadowMap.needsUpdate;
    renderer.render(scene, camera);
    if (shadowChanged) {
      bakeGround();
      busy = true;
    }
    renders++;
    emitLabels();
    if (busy) requestRender();
    else lastFrame = 0;
  };

  const bakeGround = () => {
    renderer.setRenderTarget(groundTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, bakeCamera);
    renderer.setRenderTarget(null);
  };

  const anchor = new Vector3();
  const emitLabels = () => {
    if (!shown || listeners.size === 0) return;
    const { width, height, x: left, y: top, w, h } = freeRegion();
    const growth = treeUniforms.uGrow.value;
    const labels = shown.model.labels.map(({ folder, anchor: [ax, ay, az] }) => {
      anchor.set(ax, ay, az).project(camera);
      const x = ((anchor.x + 1) / 2) * width;
      const y = ((1 - anchor.y) / 2) * height;
      const free = x >= left && x <= left + w && y >= top && y <= top + h;
      return { folder, x, y, visible: growth > LABELS_FROM && anchor.z < 1 && free };
    });
    for (const listener of listeners) listener({ growth, labels });
  };

  const applyPalette = () => {
    const srgb = (hex: string): [number, number, number] => {
      const c = new Color(hex);
      const out = { r: 0, g: 0, b: 0 };
      c.getRGB(out, SRGBColorSpace);
      return [out.r, out.g, out.b];
    };
    const center = srgb(palette.sky.center);
    const edge = srgb(palette.sky.edge);
    sky.material.uniforms.uCenter!.value = center;
    sky.material.uniforms.uEdge!.value = edge;
    treeUniforms.uFade.value = [0, 1, 2].map((i) => (center[i]! + edge[i]!) / 2) as Vec3;
    const slots: number[] = [];
    for (const hex of [...palette.leaves, palette.rest]) {
      const c = new Color(hex);
      slots.push(c.r, c.g, c.b);
    }
    treeUniforms.uSlots.value = slots;
    barkMaterial.color.set(palette.bark);
    hemi.color.set(palette.light.sky);
    hemi.groundColor.set(palette.light.ground);
    key.color.set(palette.light.key);
    terrain.setPalette(palette);
    ground.material.color.set(palette.shadow);
    contact.material.color.set(palette.shadow);
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  };

  const categories = () => leafCategories(shown!.model, colorBy, palette);

  const showHighlight = () => {
    const h = highlight;
    treeUniforms.uSel.value = h && 'range' in h ? [h.range[0], h.range[1]] : [-1, -1];
    treeUniforms.uCategory.value =
      h && 'category' in h && shown
        ? categories().legend.findIndex((e) => e.label === h.category)
        : -1;
    requestRender();
  };

  const applyColorBy = () => {
    if (!shown) return;
    const { lang, nodeId } = shown.model.leaves;
    const { slotOf, nodeCategory } = categories();
    const slot = new Float32Array(lang.length);
    for (let v = 0; v < slot.length; v++) {
      slot[v] = slotOf[nodeCategory ? nodeCategory[nodeId[v]!]! : lang[v]!]!;
    }
    shown.leaves.geometry.setAttribute('aSlot', new BufferAttribute(slot, 1));
    renderer.shadowMap.needsUpdate = true;
    showHighlight();
  };

  /** Sizes the light, its shadow and the floor to the tree and, while it shows, its ground. */
  const placeScene = () => {
    if (!shown) return;
    const { model, groundBounds } = shown;
    shown.bounds = groundOn ? union(model.bounds, groundBounds) : model.bounds;
    terrain.land.visible = terrain.cover.visible = groundOn;
    for (const mesh of [ground, contact, baked]) mesh.visible = !groundOn;
    const { min, max } = shown.bounds;
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = Math.max(max[0] - min[0], max[1] - min[1]);
    key.position.set(center[0] - 3, 12, center[2] + 5);
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

  const releaseTree = () => {
    if (!shown) return;
    scene.remove(shown.bark, shown.leaves);
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

  return {
    setTree(model) {
      releaseTree();
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
      scene.add(bark, leaves);
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
      applyColorBy();
      placeScene();
      aim = { kind: 'tree' };
      gliding = false;
      camera.position.copy(controls.target).add(new Vector3(...VIEW_DIRECTION));
      reaim(true);
      controls.update();
      startGrowth();
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

    setPalette(id) {
      palette = PALETTES[id];
      applyPalette();
      applyColorBy();
    },

    setColorBy(by) {
      colorBy = by;
      applyColorBy();
    },

    legend() {
      return shown ? categories().legend : [];
    },

    setHighlight(next) {
      highlight = next;
      showHighlight();
    },

    frameFolder(folder) {
      if (!shown) return;
      const { range } = shown.model.folders;
      aim =
        folder === 0
          ? { kind: 'tree' }
          : {
              kind: 'folder',
              ...folderSphere(shown.boxes, range[2 * folder]!, range[2 * folder + 1]!),
            };
      reaim(false);
    },

    setInsets({ top, right, bottom, left }) {
      insets.goal = [top, right, bottom, left];
      if (!shown) {
        insets.value = [...insets.goal];
        applyView();
      }
      requestRender();
    },

    pickAt(x, y) {
      if (!shown) return null;
      const { width, height, x: left, y: top, w, h } = freeRegion();
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const hidden = [sky, baked, terrain.cover].filter((mesh) => mesh.visible);
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
      if (id < 0) return null;
      return id < nodes
        ? { folder: shown.model.nodes.folder[id]! }
        : { folder: 0, rock: id - nodes };
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
    },

    setSpin(on) {
      controls.autoRotate = on;
      requestRender();
    },

    setReducedMotion(on) {
      reducedMotion = on;
      if (on && growingNow) {
        growingNow = false;
        treeUniforms.uGrow.value = 1;
        renderer.shadowMap.needsUpdate = true;
        requestRender();
      }
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
      renderer.render(scene, camera);
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
        calls: render.calls,
        triangles: render.triangles,
        geometries: memory.geometries,
        textures: memory.textures,
      };
    },

    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      releaseTree();
      for (const mesh of [sky, ground, contact, baked]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      for (const material of [barkMaterial, leafMaterial, depthMaterial, pickMaterial]) {
        material.dispose();
      }
      terrain.dispose();
      contactTexture.dispose();
      groundTarget.dispose();
      pickTarget.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      listeners.clear();
    },
  };
}

/**
 * What each leaf color stands for: languages, or top-level folders plus the files at the root.
 * `nodeCategory` (folder colors only) is each node's category; a leaf takes its language's.
 */
export function leafCategories(
  model: TreeModel,
  colorBy: ColorBy,
  palette: Palette,
): { slotOf: number[]; legend: LegendEntry[]; nodeCategory?: Int32Array } {
  if (colorBy === 'language') {
    return leafMapping(
      model.langs.map((l) => ({ label: l.lang, files: l.files })),
      palette,
    );
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
