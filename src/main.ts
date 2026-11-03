import {
  CircleGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.append(renderer.domElement);

const scene = new Scene();
scene.background = new Color('#f6f4f0');

const ground = new Mesh(new CircleGeometry(6, 64), new MeshBasicMaterial({ color: '#d9cfbf' }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 6, 14);
camera.lookAt(0, 0, 0);

renderer.render(scene, camera);
