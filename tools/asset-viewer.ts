// Asset review sheet: /tools/asset-viewer.html?file=/assets-src/ai/operator/v01/raw.glb
// Renders the GLB from six angles under the game's HDRI and prints its stats (for AI asset picks).
import { Box3, Color, OrthographicCamera, EquirectangularReflectionMapping, Mesh, PerspectiveCamera, PMREMGenerator, Scene, SkinnedMesh, SRGBColorSpace, ACESFilmicToneMapping, Vector3, WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const params = new URLSearchParams(location.search);
const file = params.get('file')!;
const tile = Number(params.get('tile') ?? 420);
const views = [0, 45, 90, 180, 270, 315]; // yaw degrees around the model (0 = front, +Z)
const canvas = document.getElementById('sheet') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(tile * 3, tile * 2);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.setScissorTest(true);

const scene = new Scene();
scene.background = new Color('#2a2d33');
const hdr = await new HDRLoader().loadAsync('/hdri/sky_4k.hdr').catch(() => null);
if (hdr) {
  hdr.mapping = EquirectangularReflectionMapping;
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
}
const gltf = await new GLTFLoader().loadAsync(file);
const model = gltf.scene;
scene.add(model);
const box = new Box3().setFromObject(model);
const size = box.getSize(new Vector3());
const center = box.getCenter(new Vector3());

let tris = 0;
const materials = new Set<string>();
const bones = new Set<string>();
model.traverse((o) => {
  const mesh = o as Mesh;
  if (mesh.isMesh) {
    const g = mesh.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => materials.add(m.name || m.type));
  }
  if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).skeleton.bones.forEach((b) => bones.add(b.name));
});
const measure = params.get('measure');
if (measure) {
  // Orthographic measuring sheet in the weapon frame (meters): right side view (muzzle +Z to the
  // right, +Y up) on top, top view (+X up) below, with a 2 cm grid and 10 cm labels.
  const w = window.innerWidth;
  const half = 0.6;
  renderer.setSize(w, w);
  renderer.setScissorTest(false);
  const views: [string, Vector3, Vector3][] = [
    ['side', new Vector3(-5, 0, 0), new Vector3(0, 1, 0)],
    ['top', new Vector3(0, 5, 0), new Vector3(-1, 0, 0)],
  ];
  const cam = new OrthographicCamera(-half, half, half / 2, -half / 2, 0.01, 20);
  const overlay = document.createElement('canvas');
  overlay.width = overlay.height = w;
  Object.assign(overlay.style, { position: 'fixed', left: '0', top: '0' });
  document.body.appendChild(overlay);
  const g = overlay.getContext('2d')!;
  const ppm = w / (2 * half);
  views.forEach(([, pos, up], i) => {
    cam.position.copy(pos);
    cam.up.copy(up);
    cam.lookAt(0, 0, 0);
    renderer.setScissorTest(true);
    renderer.setViewport(0, (1 - i) * (w / 2), w, w / 2);
    renderer.setScissor(0, (1 - i) * (w / 2), w, w / 2);
    renderer.render(scene, cam);
    const top = i * (w / 2);
    for (let m = -half; m <= half + 1e-6; m += 0.02) {
      const x = w / 2 + m * ppm;
      const major = Math.abs(Math.round(m * 100) % 10) === 0;
      g.strokeStyle = major ? 'rgba(255,200,80,0.55)' : 'rgba(255,255,255,0.12)';
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + w / 2); g.stroke();
      if (major) { g.fillStyle = '#ffc850'; g.fillText(m.toFixed(1), x + 2, top + 12); }
    }
    for (let m = -half / 2; m <= half / 2 + 1e-6; m += 0.02) {
      const y = top + w / 4 - m * ppm;
      const major = Math.abs(Math.round(m * 100) % 10) === 0;
      g.strokeStyle = major ? 'rgba(255,200,80,0.55)' : 'rgba(255,255,255,0.12)';
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      if (major) { g.fillStyle = '#ffc850'; g.fillText(m.toFixed(1), 2, y - 2); }
    }
  });
  Object.assign(window, { __stats: { file, size: size.toArray(), center: center.toArray(), triangles: 0, materials: [], animations: [], bones: [] }, __ready: true });
  throw new Error('measure done'); // stop the regular sheet
}
const maxDim = Math.max(size.x, size.y, size.z);
const distance = (maxDim / 2 / Math.tan((15 * Math.PI) / 180)) * 1.12;
const camera = new PerspectiveCamera(30, 1, 0.01, 100);
views.forEach((yaw, i) => {
  const a = (yaw * Math.PI) / 180;
  camera.position.copy(center).add(new Vector3(Math.sin(a) * distance, maxDim * 0.12, Math.cos(a) * distance));
  camera.lookAt(center);
  const x = (i % 3) * tile;
  const y = (1 - Math.floor(i / 3)) * tile;
  renderer.setViewport(x, y, tile, tile);
  renderer.setScissor(x, y, tile, tile);
  renderer.render(scene, camera);
});
const stats = {
  file,
  size: size.toArray().map((v) => +v.toFixed(3)),
  center: center.toArray().map((v) => +v.toFixed(3)),
  triangles: Math.round(tris),
  materials: [...materials],
  animations: gltf.animations.map((a) => a.name),
  bones: [...bones],
};
document.getElementById('stats')!.textContent = `${file}  ${stats.size.join(' x ')} m  ${stats.triangles} tris  ${bones.size} bones`;
Object.assign(window, { __stats: stats, __ready: true });
