import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import type { MeshData } from './grow/grow';
import { growInWorker } from './grow/grow-in-worker';
import { loadSample } from './repo/github';
import { DEFAULT_FILTERS } from './repo/hierarchy';

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.append(renderer.domElement);

const scene = new Scene();
scene.background = new Color('#f6f4f0');
scene.add(new HemisphereLight(0xffffff, 0xb9b2a8, 2.2));
const key = new DirectionalLight(0xfff3e6, 6.6);
key.position.set(-3, 12, 5);
scene.add(key);

const ground = new Mesh(new CircleGeometry(6, 64), new MeshBasicMaterial({ color: '#d9cfbf' }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const camera = new PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 6, 14);
camera.lookAt(0, 0, 0);
renderer.render(scene, camera);

const snapshot = await loadSample('vitejs-vite');
if ('kind' in snapshot) throw new Error(`sample did not load: ${snapshot.kind}`);
const tree = await growInWorker({
  snapshot,
  filters: DEFAULT_FILTERS,
  params: { seed: 42, quality: 'medium' },
});

const geometry = ({ position, normal, index }: MeshData) =>
  new BufferGeometry()
    .setAttribute('position', new BufferAttribute(position, 3))
    .setAttribute('normal', new BufferAttribute(normal, 3))
    .setIndex(new BufferAttribute(index, 1));
scene.add(
  new Mesh(geometry(tree.bark), new MeshStandardMaterial({ color: '#6b5d53', flatShading: true })),
  new Mesh(geometry(tree.leaves), new MeshStandardMaterial({ color: '#e5512c', side: DoubleSide })),
);

const [minX, minY, minZ] = tree.bounds.min;
const [maxX, maxY, maxZ] = tree.bounds.max;
const height = maxY - minY;
camera.position.set((minX + maxX) / 2, height * 0.6, (minZ + maxZ) / 2 + height * 3.2);
camera.lookAt((minX + maxX) / 2, height * 0.5, (minZ + maxZ) / 2);
renderer.render(scene, camera);
