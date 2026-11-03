import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
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
import { fitDistance, FOV, frameTree } from './framing';
import { leafMapping, PALETTES, type ColorBy, type LegendEntry, type PaletteId } from './palette';
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

export type LabelPosition = { folder: number; x: number; y: number; visible: boolean };
export type FrameInfo = { growth: number; labels: LabelPosition[] };
export type ViewStats = {
  renders: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
};

export interface TreeView {
  /** Shows a new tree, framed whole, growing unless reduced motion is on. */
  setTree(model: TreeModel): void;
  setPalette(id: PaletteId): void;
  setColorBy(by: ColorBy): void;
  /** What each leaf color stands for under the current palette and color-by. */
  legend(): LegendEntry[];
  /** Fades every node outside [lo, hi]. */
  setHighlight(range: readonly [number, number] | null): void;
  /** Glides the camera to a folder; the root folder (0) frames the whole tree. */
  frameFolder(folder: number): void;
  /** The folder under a point in CSS pixels relative to the container, from a GPU id pass. */
  pickAt(x: number, y: number): number | null;
  setQuality(quality: Quality): void;
  setSpin(on: boolean): void;
  setReducedMotion(on: boolean): void;
  /** Called after every rendered frame with each top-level label's screen position. */
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
};

const QUALITY: Record<Quality, { pixelRatio: number; shadowMap: number; antialias: boolean }> = {
  low: { pixelRatio: 1, shadowMap: 1024, antialias: false },
  medium: { pixelRatio: 1.5, shadowMap: 2048, antialias: true },
  high: { pixelRatio: 2, shadowMap: 2048, antialias: true },
};

/**
 * The mock's hemisphere light plus its room environment at 0.3. Generating that environment
 * blocked the main thread for 0.4 to 1.7 s on a software GL, so a stronger hemisphere stands
 * in for its diffuse fill; the lumen tree's trunk and leaf colors match the mock within 3%.
 */
const SKY_LIGHT = 0.7 * Math.PI + 2.4;
const GROW_MS = 2600;
const BAKED = 1;
const LABELS_FROM = 0.55;
const SPIN_SPEED = 0.55;
/** The ramp every palette shares, plus the slot for the rest. */
const SLOTS = PALETTES.autumn.leaves.length + 1;

type Shown = {
  model: TreeModel;
  bark: Mesh<BufferGeometry, MeshStandardMaterial>;
  leaves: Mesh<BufferGeometry, MeshStandardMaterial>;
  /** Per node: [minX, minY, minZ, maxX, maxY, maxZ] of its geometry. */
  boxes: Float32Array;
};

export function createTreeView(container: HTMLElement, options: TreeViewOptions): TreeView {
  let quality = options.quality;
  let palette = PALETTES[options.palette];
  let colorBy = options.colorBy;
  let reducedMotion = options.reducedMotion;

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

  const hemi = new HemisphereLight(0xffffff, 0xffffff, SKY_LIGHT);
  const key = new DirectionalLight(0xffffff, 2.1 * Math.PI);
  key.castShadow = true;
  key.shadow.bias = -0.0006;
  key.shadow.radius = 4;
  const fill = new DirectionalLight(0xdfe8ff, 0.45 * Math.PI);
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
  /** True until the user moves the camera, so a resize re-frames the whole tree. */
  let homed = true;
  let glide: { target: Vector3; distance: number } | null = null;
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
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (shown && homed) home(false);
    requestRender();
  };

  const home = (smooth: boolean) => {
    if (!shown) return;
    const framing = frameTree(shown.model.bounds, camera.aspect);
    controls.minDistance = framing.minDistance;
    controls.maxDistance = framing.maxDistance;
    if (smooth) {
      glideTo(new Vector3(...framing.target), distanceOf(framing.position, framing.target));
      return;
    }
    glide = null;
    controls.target.set(...framing.target);
    camera.position.set(...framing.position);
    controls.update();
  };

  const glideTo = (target: Vector3, distance: number) => {
    glide = { target, distance };
    requestRender();
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
    if (glide) {
      const k = 1 - Math.exp(-dt * 5);
      const offset = camera.position.clone().sub(controls.target);
      controls.target.lerp(glide.target, k);
      const distance = offset.length() + (glide.distance - offset.length()) * k;
      camera.position.copy(controls.target).addScaledVector(offset.normalize(), distance);
      const settled =
        controls.target.distanceTo(glide.target) < 1e-3 &&
        Math.abs(distance - glide.distance) < 1e-3;
      if (settled) glide = null;
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
    const width = container.clientWidth;
    const height = container.clientHeight;
    const growth = treeUniforms.uGrow.value;
    const labels = shown.model.labels.map(({ folder, anchor: [x, y, z] }) => {
      anchor.set(x, y, z).project(camera);
      return {
        folder,
        x: ((anchor.x + 1) / 2) * width,
        y: ((1 - anchor.y) / 2) * height,
        visible: growth > LABELS_FROM && anchor.z < 1,
      };
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
    ground.material.color.set(palette.shadow);
    contact.material.color.set(palette.shadow);
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  };

  const categories = (): { slotOf: number[]; legend: LegendEntry[]; nodeCategory?: Int32Array } => {
    const model = shown!.model;
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
    homed = false;
    glide = null;
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
      shown = { model, bark, leaves, boxes: nodeBoxes(model) };
      applyColorBy();

      const { min, max } = model.bounds;
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
      treeUniforms.uSel.value = [-1, -1];
      homed = true;
      home(false);
      startGrowth();
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

    setHighlight(range) {
      treeUniforms.uSel.value = range ? [range[0], range[1]] : [-1, -1];
      requestRender();
    },

    frameFolder(folder) {
      if (!shown) return;
      if (folder === 0) {
        homed = true;
        home(true);
        return;
      }
      const { range } = shown.model.folders;
      const { center, radius } = folderSphere(
        shown.boxes,
        range[2 * folder]!,
        range[2 * folder + 1]!,
      );
      homed = false;
      glideTo(center, Math.max(controls.minDistance, fitDistance(radius, camera.aspect)));
    },

    pickAt(x, y) {
      if (!shown) return null;
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const hidden = [sky, baked];
      for (const mesh of hidden) mesh.visible = false;
      const shadowPending = renderer.shadowMap.needsUpdate;
      renderer.shadowMap.needsUpdate = false;
      scene.overrideMaterial = pickMaterial;
      camera.setViewOffset(width, height, Math.floor(x), Math.floor(y), 1, 1);
      renderer.setRenderTarget(pickTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel);
      renderer.setRenderTarget(null);
      camera.clearViewOffset();
      scene.overrideMaterial = null;
      renderer.shadowMap.needsUpdate = shadowPending;
      for (const mesh of hidden) mesh.visible = true;
      const id = pickPixel[0]! + pickPixel[1]! * 256 + pickPixel[2]! * 65536 - 1;
      return id < 0 ? null : shown.model.nodes.folder[id]!;
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
      renderer.render(scene, camera);
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

function geometry(mesh: MeshData): BufferGeometry {
  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(mesh.position, 3))
    .setAttribute('normal', new BufferAttribute(mesh.normal, 3))
    .setAttribute('aBase', new BufferAttribute(mesh.base, 3))
    .setAttribute('aT', new BufferAttribute(mesh.timing, 2))
    .setAttribute('aId', new BufferAttribute(mesh.nodeId, 1))
    .setIndex(new BufferAttribute(mesh.index, 1));
}

function nodeBoxes(model: TreeModel): Float32Array {
  const boxes = new Float32Array(model.nodes.folder.length * 6);
  for (let n = 0; n < boxes.length; n += 6)
    boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], n);
  for (const { position, nodeId } of [model.bark, model.leaves]) {
    for (let v = 0; v < nodeId.length; v++) {
      const b = nodeId[v]! * 6;
      for (let axis = 0; axis < 3; axis++) {
        const p = position[v * 3 + axis]!;
        if (p < boxes[b + axis]!) boxes[b + axis] = p;
        if (p > boxes[b + 3 + axis]!) boxes[b + 3 + axis] = p;
      }
    }
  }
  return boxes;
}

function folderSphere(
  boxes: Float32Array,
  lo: number,
  hi: number,
): { center: Vector3; radius: number } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const corner = new Vector3();
  for (let n = lo; n <= hi; n++) {
    min.min(corner.fromArray(boxes, n * 6));
    max.max(corner.fromArray(boxes, n * 6 + 3));
  }
  return { center: min.clone().add(max).multiplyScalar(0.5), radius: min.distanceTo(max) / 2 };
}

const distanceOf = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A soft round shadow under the trunk, white so the material color tints it. */
function radialTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d')!;
  const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 256, 256);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
