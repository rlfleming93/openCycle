// Smoke-load every fleet GLB through the actual three r185 GLTFLoader (the
// runtime consumer) to prove the named nodes, geometry and material maps parse.
// Textures are decoded through a headless ImageBitmap shim (Node has no DOM);
// this checks the scene graph + material wiring, not pixel decode (the Blender
// re-import in validate_glb.py covers pixels).
//
// Run: node assets/ships/smoke_three.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const THREE_DIR = new URL('../../apps/web/node_modules/three/', import.meta.url);
const THREE = await import(new URL('build/three.module.js', THREE_DIR).href);
const { GLTFLoader } = await import(new URL('examples/jsm/loaders/GLTFLoader.js', THREE_DIR).href);

// headless DOM shims for GLTFLoader's embedded-image path
globalThis.self = globalThis;
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
THREE.ImageBitmapLoader.prototype.load = function (url, onLoad) {
  const bmp = { width: 1024, height: 1024, close() {} };
  if (onLoad) queueMicrotask(() => onLoad(bmp));
  return bmp;
};

const HULLS = ['striker', 'challenger', 'zenith', 'insurgent'];
const REQUIRED = ['Ship', 'nozzleL', 'nozzleR', 'coreMount'];
const TRI_BUDGET = 60000;

const load = (id) =>
  new Promise((resolve, reject) => {
    const path = new URL(`../../apps/web/public/assets/ships/${id}.glb`, import.meta.url);
    const buf = readFileSync(fileURLToPath(path));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    new GLTFLoader().parse(ab, '', resolve, reject);
  });

let failures = 0;
console.log('three revision:', THREE.REVISION);

for (const id of HULLS) {
  let gltf;
  try {
    gltf = await load(id);
  } catch (err) {
    console.error(`FAIL ${id}: parse error`, err);
    failures += 1;
    continue;
  }
  const scene = gltf.scene;
  const missing = REQUIRED.filter((n) => !scene.getObjectByName(n));
  let tris = 0;
  const maps = new Set();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const m = o.material;
    ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'].forEach((k) => {
      if (m && m[k]) maps.add(k);
    });
  });
  const nozzle = scene.getObjectByName('nozzleR');
  const p = new THREE.Vector3();
  nozzle.getWorldPosition(p);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());

  const ok = !missing.length && tris <= TRI_BUDGET && maps.size >= 4;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(11)} tris=${String(tris).padStart(6)} ` +
      `len=${size.z.toFixed(2)} span=${size.x.toFixed(2)} up=${size.y.toFixed(2)} ` +
      `nozzleR=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) ` +
      `maps=[${[...maps].sort().join(',')}]${missing.length ? ` MISSING=${missing}` : ''}`,
  );
}

if (failures) {
  console.error(`FAIL: ${failures} hull(s) failed the smoke test`);
  process.exit(1);
}
console.log('SMOKE OK: all hulls load in three r185 with the required nodes and maps.');
