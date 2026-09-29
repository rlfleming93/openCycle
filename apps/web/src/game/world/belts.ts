import type { LegKind } from '@opencycle/shared';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import { FLOW_GLSL, flowLayer } from './flow.js';
import type { Flow, FlowLayer } from './flow.js';
import { AMBIENT_GLSL, NOISE_GLSL } from './glsl.js';
import { clamp, seededRandom } from './math.js';
import type { Lighting } from './sky.js';

/**
 * The solid things the fleet flies through, every one of them placed on the
 * GPU by the shared flow (flow.ts), one draw per class:
 *
 *  - near rocks: small, fast chunks just outside the corridor (3 shapes);
 *  - mid rocks: the body of the belt out to ~900 u (the same 3 shapes);
 *  - far rocks: lit sprite impostors out to ~2,600 u, the belt's texture;
 *  - hero rocks: a few cratered giants (10-40 u) that tumble past right
 *    outside the corridor, so the fleet visibly threads between them;
 *  - wreckage: dark metal plates, girders and crushed sections now and then;
 *  - a derelict hull section every few minutes, beacons still blinking.
 *
 * Every body is lit by the anchor alone: key Lambert, the sky's ambient cube,
 * and the key-tinted rim plus back light, so backlit rocks read as rims
 * rather than cut-outs.
 */
const NEAR_COUNT = 150;
const MID_COUNT = 230;
const FAR_COUNT = 700;
const HERO_COUNT = 10;
const CHUNK_COUNT = 24;

/** Density by leg kind: burn dense, climb medium, cruise sparse, coast open. */
const NEAR_DENSITY: Record<LegKind, number> = { burn: 1, climb: 0.5, cruise: 0.2, coast: 0.04, launch: 0.12, approach: 0.12, free: 0.25 };
const MID_DENSITY: Record<LegKind, number> = { burn: 1, climb: 0.6, cruise: 0.28, coast: 0.08, launch: 0.2, approach: 0.2, free: 0.3 };
const FAR_DENSITY: Record<LegKind, number> = { burn: 1, climb: 0.8, cruise: 0.5, coast: 0.25, launch: 0.35, approach: 0.35, free: 0.45 };
const HERO_DENSITY: Record<LegKind, number> = { burn: 1, climb: 0.6, cruise: 0.4, coast: 0.1, launch: 0.3, approach: 0.25, free: 0.35 };
const CHUNK_DENSITY: Record<LegKind, number> = { burn: 0.5, climb: 0.4, cruise: 0.35, coast: 0.25, launch: 0.3, approach: 0.3, free: 0.3 };
const ALWAYS: Record<LegKind, number> = { burn: 1, climb: 1, cruise: 1, coast: 1, launch: 1, approach: 1, free: 1 };

/** Hidden vertex: outside the clip volume, so its triangles are clipped away. */
const CLIPPED = 'gl_Position = vec4(0.0, 0.0, 2.0, 1.0);';

/**
 * Instanced solid: `aSeed` = (along phase, salt, size draw, spin draw) per
 * instance, `aVariant` per vertex. A vertex whose variant isn't the
 * instance's is clipped, so several shapes share one draw.
 */
const SOLID_VERT = /* glsl */ `
${FLOW_GLSL}
attribute vec4 aSeed;
attribute float aVariant;
uniform vec4 uLat;
uniform vec4 uSize;
uniform float uVariants;
uniform vec4 uAxis;
uniform float uFamilies;
uniform vec2 uGuard;
uniform vec4 uSector;
varying vec3 vN;
varying vec3 vW;
varying vec3 vObj;
varying vec4 vTint;
varying float vSize;
#ifdef GLOW
attribute float aGlow;
varying float vGlow;
#endif

// Lateral position: anywhere in the belt's annulus, or (uSector.z on) on the
// solved clear headings around the camera's lateral point (Flow.solveSector).
vec2 ocDisc(vec2 h) {
  float r = sqrt(mix(uLat.x * uLat.x, uLat.y * uLat.y, pow(h.x, uLat.z)));
  bool steered = uSector.z > 0.5;
  float a = steered ? mix(uSector.x, uSector.y, h.y) : h.y * 6.2831853;
  return (steered ? uFlowCapA.xy : vec2(0.0)) + vec2(cos(a), sin(a)) * r;
}

void main() {
  float cycle;
  float u = ocFlowU(aSeed.x, cycle);
  vec4 h = ocHash41(aSeed.y * 1.37 + cycle * 7.13);
  if (abs(aVariant - floor(h.w * uVariants)) > 0.5) { ${CLIPPED} return; }
  float size = mix(uSize.x, uSize.y, pow(aSeed.z, uSize.z));
  vec2 lat = ocDisc(h.xy);
  if (ocCorridor(lat) < size + uLat.w) lat = ocDisc(ocHash41(aSeed.y * 2.91 + cycle * 3.71 + 5.0).xy);
  float show = step(h.z, ocFlowDensity(u)) * step(size + uLat.w, ocCorridor(lat)) * ocFlowEnds(u);
  vec3 center = ocFlowPoint(lat, u);
  show *= ocDestClear(center, size) * ocScreenGuard(center, size, uGuard);
  if (show < 0.002) { ${CLIPPED} return; }
  vec4 k = ocHash41(aSeed.y * 0.73 + 19.0);
  // Rocks tumble about a random axis; the derelict rolls about its own keel.
  vec3 axis = uAxis.w > 0.5 ? uAxis.xyz : normalize(k.xyz - 0.5);
  float angle = uFlowTime * (aSeed.w - 0.5) * 2.0 * uSize.w + k.w * 6.2831853;
  vec3 p = ocRotate(position, axis, angle);
  vObj = position;
  vN = ocRotate(normal, axis, angle);
  vW = center + p * size * show;
  vSize = size * show;
  // Albedo families: carbonaceous, silicate, metal-rich, ice (alpha = gloss).
  // uFamilies < 1 keeps a class to the dark end.
  vec4 m = ocHash41(aSeed.y * 3.3 + cycle * 1.9 + 2.0);
  float fam = m.x * uFamilies;
  vTint = fam < 0.4 ? vec4(0.055, 0.05, 0.045, 0.05)
    : fam < 0.78 ? vec4(0.13, 0.115, 0.1, 0.12)
    : fam < 0.9 ? vec4(0.15, 0.145, 0.14, 0.55)
    : vec4(0.14, 0.17, 0.2, 0.8);
  vTint.rgb *= 0.8 + 0.4 * m.y;
#ifdef GLOW
  vGlow = aGlow;
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

const LIGHT_GLSL = /* glsl */ `
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uAmbient[6];
uniform vec3 uRimColor;
uniform float uBack;
${AMBIENT_GLSL}

// Anchor key, sky fill, gloss, and the key-tinted rim plus back light. The
// rim reads the smooth normal Ng: a bumped normal turned away from the eye
// would light the whole face as rim.
vec3 ocLight(vec3 albedo, float gloss, vec3 N, vec3 Ng, vec3 V) {
  float ndl = dot(N, uSunDir);
  vec3 col = albedo * (uKeyColor * max(ndl, 0.0) + ocAmbient(N, uAmbient));
  vec3 H = normalize(uSunDir + V);
  col += uKeyColor * gloss * pow(max(dot(N, H), 0.0), 8.0 + 72.0 * gloss) * 0.5 * step(0.0, ndl);
  float fres = pow(1.0 - max(dot(Ng, V), 0.0), 4.0);
  float back = max(dot(-V, uSunDir), 0.0) * (0.3 + 0.7 * smoothstep(-0.4, 0.4, dot(Ng, uSunDir)));
  return col + (uRimColor + uKeyColor * back * uBack) * fres;
}

// Bump from a scalar field through screen derivatives (three's perturbNormalArb).
vec3 ocBump(vec3 N, vec3 wp, float hgt, float scale) {
  vec3 dpx = dFdx(wp);
  vec3 dpy = dFdy(wp);
  vec3 r1 = cross(dpy, N);
  vec3 r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2);
  return normalize(abs(det) * N - scale * grad);
}
`;

const ROCK_FRAG = /* glsl */ `
${LIGHT_GLSL}
${NOISE_GLSL}
uniform float uOctaves;
uniform float uBumpScale;
uniform float uNoiseFreq;
varying vec3 vN;
varying vec3 vW;
varying vec3 vObj;
varying vec4 vTint;
varying float vSize;
void main() {
  // Octaves stop where a cycle would span under ~4 px, so small rocks never
  // shimmer and hero rocks get their full detail up close.
  float fw = max(length(fwidth(vObj)) * uNoiseFreq, 1e-5);
  float octaves = clamp(1.0 + log2(0.25 / fw), 1.0, uOctaves);
  float hgt = ocFbm(vObj * uNoiseFreq + vTint.rgb * 40.0, octaves);
  // The bump is authored per unit of the rock's own radius, so a hero rock is
  // as rugged as a pebble.
  vec3 Ng = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  // Facet normal from screen derivatives: the fallback wherever the smooth
  // normal is degenerate or turned from the facet, so a face never reads as rim.
  vec3 Nf = normalize(cross(dFdx(vW), dFdy(vW)));
  Nf *= sign(dot(Nf, V) + 1e-6);
  Ng = length(vN) > 0.5 && dot(vN, Nf) > 0.0 ? Ng : Nf;
  vec3 N = ocBump(Ng, vW, hgt, uBumpScale * vSize);
  // A wide albedo spread: in full sun a rock reads as texture, not plaster.
  vec3 albedo = vTint.rgb * (0.3 + 1.0 * hgt * hgt);
  gl_FragColor = vec4(ocLight(albedo, vTint.a * smoothstep(0.35, 0.7, hgt), N, Ng, V), 1.0);
}`;

/**
 * Dark metal: panel seams, a hard key glint, rim; with GLOW, beacons blink.
 * The derelict and the flyby station share it (varyings vN, vW, vObj, vTint).
 */
export const METAL_FRAG = /* glsl */ `
${LIGHT_GLSL}
uniform float uFlowTime;
varying vec3 vN;
varying vec3 vW;
varying vec3 vObj;
varying vec4 vTint;
#ifdef GLOW
varying float vGlow;
#endif
void main() {
  vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 V = normalize(cameraPosition - vW);
  vec3 q = abs(fract(vObj * vec3(3.0, 3.0, 1.6)) - 0.5);
  float seam = smoothstep(0.47, 0.5, max(max(q.x, q.y), q.z));
  vec3 albedo = mix(vec3(0.07, 0.072, 0.078), vec3(0.11, 0.1, 0.09), step(0.5, fract(floor(vObj.z * 1.6) * 0.37)));
  // Low gloss: a flat plate at mirror angle to the anchor must not read as a lamp.
  vec3 col = ocLight(albedo * (1.0 - 0.6 * seam), 0.2, N, N, V);
#ifdef GLOW
  float blink = step(0.82, fract(uFlowTime * 0.45 + vObj.x * 0.13));
  col += vec3(1.0, 0.18, 0.08) * vGlow * (0.6 + 6.0 * blink);
#endif
  gl_FragColor = vec4(col, 1.0);
}`;

/** Far rocks: round lit sprites with a lumpy outline, sized in world units. */
const FAR_VERT = /* glsl */ `
${FLOW_GLSL}
attribute vec4 aSeed;
uniform vec4 uLat;
uniform vec4 uSize;
uniform float uPxScale;
varying vec4 vTint;
varying float vSeed;
varying float vCover;
void main() {
  float cycle;
  float u = ocFlowU(aSeed.x, cycle);
  vec4 h = ocHash41(aSeed.y * 1.37 + cycle * 7.13);
  float size = mix(uSize.x, uSize.y, pow(aSeed.z, uSize.z));
  float r = sqrt(mix(uLat.x * uLat.x, uLat.y * uLat.y, h.x));
  vec2 lat = vec2(cos(h.y * 6.2831853), sin(h.y * 6.2831853)) * r;
  float show = step(h.z, ocFlowDensity(u)) * smoothstep(1.0, 0.85, u) * smoothstep(0.0, 0.25, u);
  vec3 center = ocFlowPoint(lat, u);
  show *= ocDestClear(center, size);
  vec4 mv = viewMatrix * vec4(center, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = 2.0 * size * show * uPxScale / max(-mv.z, 1.0);
  if (px < 0.35) { ${CLIPPED} return; }
  // Sub-2 px sprites keep 2 px and fade by coverage instead of aliasing.
  gl_PointSize = max(px, 2.0);
  vCover = min(1.0, px * px / 4.0);
  vSeed = aSeed.y;
  vec4 m = ocHash41(aSeed.y * 3.3 + cycle * 1.9 + 2.0);
  vTint = m.x < 0.45 ? vec4(0.06, 0.055, 0.05, 0.0) : m.x < 0.88 ? vec4(0.14, 0.125, 0.11, 0.0) : vec4(0.22, 0.26, 0.3, 1.0);
}`;

const FAR_FRAG = /* glsl */ `
${LIGHT_GLSL}
varying vec4 vTint;
varying float vSeed;
varying float vCover;
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  pc.y = -pc.y;
  float r2 = dot(pc, pc);
  float a = atan(pc.y, pc.x);
  float edge = 0.8 + 0.12 * sin(a * 3.0 + vSeed * 7.0) + 0.08 * sin(a * 5.0 + vSeed * 3.0);
  if (r2 > edge * edge) discard;
  vec3 nV = vec3(pc / edge, 0.0);
  nV.z = sqrt(max(1.0 - dot(nV.xy, nV.xy), 0.0));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 N = normalize(right * nV.x + up * nV.y + back * nV.z);
  gl_FragColor = vec4(ocLight(vTint.rgb, vTint.a, N, N, back) * vCover, 1.0);
}`;

interface SolidClass {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  count: number;
}

export class Belts {
  readonly group = new THREE.Group();
  /** The big classes (heroes, wreckage, derelict): empty during the reveal calm. */
  readonly big: FlowLayer[];
  private readonly flow: Flow;
  /** Steered classes: their sector uniform and the body the solve plans for. */
  private readonly steered: Array<{ sector: THREE.Vector4; size: number; dist: number }> = [];
  private readonly rockGeo: THREE.BufferGeometry;
  private readonly heroGeo: THREE.BufferGeometry;
  private readonly chunkGeo: THREE.BufferGeometry;
  private readonly derelictGeo: THREE.BufferGeometry;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly solids: SolidClass[] = [];
  private readonly farGeo: THREE.BufferGeometry;
  private readonly farMat: THREE.ShaderMaterial;
  private readonly lightUniforms: Record<string, THREE.IUniform> = {
    uKeyColor: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uAmbient: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
    uRimColor: { value: new THREE.Color() },
    uBack: { value: 0.25 },
  };

  constructor(flow: Flow) {
    this.flow = flow;
    this.rockGeo = rockGeometry('opencycle:rocks', 3, 2, 0.26, 3, 3);
    this.heroGeo = rockGeometry('opencycle:heroes', 2, 4, 0.2, 9, 4);
    this.chunkGeo = wreckGeometry();
    this.derelictGeo = derelictGeometry();

    const near = flow.add(flowLayer(320, 30, NEAR_DENSITY));
    const mid = flow.add(flowLayer(950, 40, MID_DENSITY));
    const hero = flow.add(flowLayer(3000, 90, HERO_DENSITY));
    const chunks = flow.add(flowLayer(1400, 40, CHUNK_DENSITY));
    const derelict = flow.add(flowLayer(9000, 200, ALWAYS));
    const far = flow.add(flowLayer(2000, -600, FAR_DENSITY));
    this.big = [hero, chunks, derelict];

    // Screen guard (keep-outs, destination + anchor): off for the small fast
    // near rocks, the system only for the mid belt, everything for the big ones.
    const guard = (hud: number, system: number) => ({ uGuard: { value: new THREE.Vector2(hud, system) } });
    const rock = (layer: FlowLayer, lat: number[], size: number[], variants: number, octaves: number, freq: number, families: number, hud: number, system: number) =>
      this.material(flow, layer, ROCK_FRAG, lat, size, variants, {
        uOctaves: { value: octaves },
        uBumpScale: { value: 0.035 },
        uNoiseFreq: { value: freq },
        uFamilies: { value: families },
        ...guard(hud, system),
      });
    this.solid(this.rockGeo, NEAR_COUNT, rock(near, [0, 110, 1, 1.5], [0.5, 3.4, 1.8, 0.9], 3, 2, 4.3, 1, 0, 0), 11);
    this.solid(this.rockGeo, MID_COUNT, rock(mid, [0, 460, 1, 2], [1.5, 8, 1.7, 0.5], 3, 3, 4.3, 1, 0, 1), 23);
    // Heroes stay dark (no ice or bright metal): they are masses, not lamps.
    // They and the derelict fly the solved clear headings around the camera.
    const heroMat = rock(hero, [60, 170, 1, 4], [10, 40, 1.7, 0.06], 2, 5, 6.5, 0.78, 1, 1);
    this.steered.push({ sector: heroMat.uniforms.uSector!.value as THREE.Vector4, size: 24, dist: 100 });
    this.solid(this.heroGeo, HERO_COUNT, heroMat, 37);
    this.solid(this.chunkGeo, CHUNK_COUNT, this.material(flow, chunks, METAL_FRAG, [0, 200, 1, 1.5], [0.8, 3.6, 1.5, 0.7], 3, guard(1, 1)), 41);
    // The derelict lies along the travel line and only rolls about its keel.
    const derelictMat = this.material(
      flow,
      derelict,
      METAL_FRAG,
      [90, 180, 1, 6],
      [55, 55, 1, 0.02],
      1,
      { uAxis: { value: new THREE.Vector4(0, 0, 1, 1) }, ...guard(1, 1) },
      true,
    );
    derelictMat.side = THREE.DoubleSide;
    this.steered.push({ sector: derelictMat.uniforms.uSector!.value as THREE.Vector4, size: 55, dist: 130 });
    this.solid(this.derelictGeo, 1, derelictMat, 53);

    // Far rocks: one point per rock.
    this.farGeo = new THREE.BufferGeometry();
    this.farGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FAR_COUNT * 3), 3));
    this.farGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds(FAR_COUNT, 67), 4));
    this.farMat = new THREE.ShaderMaterial({
      uniforms: {
        ...flow.uniforms,
        ...far.uniforms,
        ...this.lightUniforms,
        uLat: { value: new THREE.Vector4(0, 1300, 1, 0) },
        uSize: { value: new THREE.Vector4(2.5, 16, 2.2, 0) },
        uPxScale: { value: 1000 },
      },
      vertexShader: FAR_VERT,
      fragmentShader: FAR_FRAG,
    });
    this.materials.push(this.farMat);
    const farPoints = new THREE.Points(this.farGeo, this.farMat);
    farPoints.frustumCulled = false;
    this.group.add(farPoints);
  }

  private material(
    flow: Flow,
    layer: FlowLayer,
    fragmentShader: string,
    lat: number[],
    size: number[],
    variants: number,
    extra: Record<string, THREE.IUniform>,
    glow = false,
  ): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...flow.uniforms,
        ...layer.uniforms,
        ...this.lightUniforms,
        uLat: { value: new THREE.Vector4().fromArray(lat) },
        uSize: { value: new THREE.Vector4().fromArray(size) },
        uVariants: { value: variants },
        uAxis: { value: new THREE.Vector4() },
        uFamilies: { value: 1 },
        uGuard: { value: new THREE.Vector2() },
        uSector: { value: new THREE.Vector4() },
        ...extra,
      },
      defines: glow ? { GLOW: '' } : {},
      vertexShader: SOLID_VERT,
      fragmentShader,
    });
    this.materials.push(mat);
    return mat;
  }

  private solid(base: THREE.BufferGeometry, count: number, material: THREE.ShaderMaterial, salt: number): void {
    // Shapes are shared between classes: only the per-instance seeds differ.
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    for (const name of Object.keys(base.attributes)) geo.setAttribute(name, base.getAttribute(name));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(count, salt), 4));
    geo.instanceCount = count;
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.solids.push({ mesh, geo, count });
  }

  /** Re-steer the heroes and the derelict for this camera, right after a corridor solve. */
  solveSectors(camera: THREE.PerspectiveCamera): void {
    for (const s of this.steered) this.flow.solveSector(camera, s.size, s.dist, s.sector);
  }

  /** Key, sky fill and rim, bound by reference (they update in place). */
  setLighting(lighting: Lighting): void {
    const u = this.lightUniforms;
    u.uKeyColor!.value = lighting.key;
    u.uSunDir!.value = lighting.sunDir;
    u.uAmbient!.value = lighting.ambient;
    u.uRimColor!.value = lighting.rim;
  }

  /** Rung 2+ halves every class (the prefix of a golden-ratio sequence stays even). */
  setRung(rung: number): void {
    const k = rung >= 2 ? 0.5 : 1;
    for (const s of this.solids) s.geo.instanceCount = Math.max(1, Math.round(s.count * k));
    this.farGeo.setDrawRange(0, Math.round(FAR_COUNT * k));
  }

  /** Sprite scale: device px per unit at unit depth. */
  update(pxScale: number): void {
    this.farMat.uniforms.uPxScale!.value = pxScale;
  }

  dispose(): void {
    for (const s of this.solids) s.geo.dispose();
    for (const m of this.materials) m.dispose();
    this.rockGeo.dispose();
    this.heroGeo.dispose();
    this.chunkGeo.dispose();
    this.derelictGeo.dispose();
    this.farGeo.dispose();
    this.group.clear();
  }
}

/**
 * Per-instance seeds: along-window phase on a golden-ratio sequence (so any
 * prefix, e.g. rung 2's half, stays evenly spread), a salt, a size draw and a
 * spin draw.
 */
function seeds(count: number, salt: number): Float32Array {
  const rnd = seededRandom(`opencycle:flow:${salt}`);
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    out[i * 4] = (i * 0.6180339887 + rnd() * 0.05) % 1;
    out[i * 4 + 1] = salt + i * 1.618 + rnd() * 0.5;
    out[i * 4 + 2] = rnd();
    out[i * 4 + 3] = rnd();
  }
  return out;
}

/** Integer lattice hash to [0, 1). */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0, 1]. */
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  let out = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1;
    const dy = (c >> 1) & 1;
    const dz = (c >> 2) & 1;
    const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
    out += w * hash3(ix + dx, iy + dy, iz + dz);
  }
  return out;
}

function fbm3(x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise3(x, y, z);
    norm += amp;
    x *= 2.07;
    y *= 2.07;
    z *= 2.07;
    amp *= 0.5;
  }
  return sum / norm;
}

function randomUnit(rnd: () => number, out = new THREE.Vector3()): THREE.Vector3 {
  const z = rnd() * 2 - 1;
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * r, z, Math.sin(a) * r);
}

/** Tag every vertex with its shape index, merge, and scale to a unit bounding radius. */
function mergeVariants(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  parts.forEach((g, v) => g.setAttribute('aVariant', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(v), 1)));
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  if (merged === null) throw new Error('belts: shape attributes differ');
  const pos = merged.getAttribute('position');
  let r = 0;
  for (let i = 0; i < pos.count; i++) r = Math.max(r, Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
  merged.scale(1 / r, 1 / r, 1 / r);
  return merged;
}

/**
 * Lumpy, cratered asteroid shapes: a welded icosphere pushed out by FBM,
 * pitted by bowl craters with raised rims, then squashed on three axes.
 */
function rockGeometry(seed: string, variants: number, detail: number, bumps: number, craters: number, octaves: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const p = new THREE.Vector3();
  for (let v = 0; v < variants; v++) {
    const rnd = seededRandom(`${seed}:${v}`);
    const ico = new THREE.IcosahedronGeometry(1, detail);
    ico.deleteAttribute('normal');
    ico.deleteAttribute('uv');
    const geo = mergeVertices(ico);
    ico.dispose();
    const pos = geo.getAttribute('position');
    const o = [rnd() * 60, rnd() * 60, rnd() * 60];
    const stretch = [0.8 + rnd() * 0.55, 0.6 + rnd() * 0.3, 0.85 + rnd() * 0.4];
    const holes = Array.from({ length: craters }, () => ({ c: randomUnit(rnd), a: 0.2 + rnd() * 0.45, d: 0.05 + rnd() * 0.12 }));
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).normalize();
      let r = 1 + bumps * (fbm3(p.x * 1.6 + o[0]!, p.y * 1.6 + o[1]!, p.z * 1.6 + o[2]!, octaves) - 0.5) * 2;
      for (const h of holes) {
        const t = Math.acos(clamp(p.dot(h.c), -1, 1)) / h.a;
        if (t < 1) r -= h.d * (1 - t * t);
        r += h.d * 0.35 * Math.exp(-(((t - 1) / 0.22) ** 2));
      }
      pos.setXYZ(i, p.x * r * stretch[0]!, p.y * r * stretch[1]!, p.z * r * stretch[2]!);
    }
    geo.computeVertexNormals();
    parts.push(geo);
  }
  return mergeVariants(parts);
}

/** Moves coincident corners together, so a crushed box stays closed. */
function crush(geo: THREE.BufferGeometry, amount: number, seed: number): void {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const kx = Math.round(x * 100);
    const ky = Math.round(y * 100);
    const kz = Math.round(z * 100);
    pos.setXYZ(
      i,
      x + (hash3(kx, ky, kz + seed) - 0.5) * amount,
      y + (hash3(kx + 7, ky, kz + seed) - 0.5) * amount,
      z + (hash3(kx, ky + 13, kz + seed) - 0.5) * amount,
    );
  }
}

function plain(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  return geo;
}

/** Wreckage: a buckled hull plate, an I-beam girder and a crushed box section. */
function wreckGeometry(): THREE.BufferGeometry {
  const plate = plain(new THREE.BoxGeometry(2.6, 0.08, 1.6, 10, 1, 6));
  const pos = plate.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, pos.getY(i) + 0.22 * x * x - 0.12 * z * z + 0.08 * Math.sin(x * 4.1 + z * 3.3));
  }
  crush(plate, 0.05, 3);
  const flangeA = plain(new THREE.BoxGeometry(3.4, 0.08, 0.7)).translate(0, 0.46, 0);
  const flangeB = plain(new THREE.BoxGeometry(3.4, 0.08, 0.7)).translate(0, -0.46, 0);
  const web = plain(new THREE.BoxGeometry(3.4, 0.9, 0.08));
  const girder = mergeGeometries([flangeA, web, flangeB])!;
  for (const g of [flangeA, web, flangeB]) g.dispose();
  girder.rotateZ(0.12);
  const box = plain(new THREE.BoxGeometry(1.7, 1.1, 1.3, 3, 2, 3));
  crush(box, 0.35, 11);
  for (const g of [plate, girder, box]) g.computeVertexNormals();
  return mergeVariants([plate, girder, box]);
}

/**
 * A derelict hull section: a cracked-open pressure hull (a partial cylinder
 * with ragged ends and missing plates), ribs, a keel pair and three beacons.
 */
function derelictGeometry(): THREE.BufferGeometry {
  const rnd = seededRandom('opencycle:derelict');
  const parts: THREE.BufferGeometry[] = [];
  // A faceted pressure hull: few, flat plates read as a ship, not a barrel.
  const cols = 12;
  const rows = 18;
  const arc = Math.PI * 1.35;
  const length = 3.6;
  const positions: number[] = [];
  const colLen = Array.from({ length: cols }, () => 0.6 + rnd() * 0.4);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      // Missing plates come in clusters (blast damage), plus a ragged broken end.
      const hole = noise3(c * 0.55, r * 0.35, 7.3) > 0.68;
      if (r / rows > colLen[c]! || hole) continue;
      const a0 = -arc / 2 + (c / cols) * arc;
      const a1 = -arc / 2 + ((c + 1) / cols) * arc;
      const z0 = -length / 2 + (r / rows) * length;
      const z1 = -length / 2 + ((r + 1) / rows) * length;
      // Buckled plates: every corner pushed in or out a little.
      const k = (a: number, z: number) => 1 + (hash3(Math.round(a * 100), Math.round(z * 100), 5) - 0.5) * 0.06;
      const q = [
        [Math.sin(a0) * k(a0, z0), -Math.cos(a0) * k(a0, z0), z0],
        [Math.sin(a1) * k(a1, z0), -Math.cos(a1) * k(a1, z0), z0],
        [Math.sin(a1) * k(a1, z1), -Math.cos(a1) * k(a1, z1), z1],
        [Math.sin(a0) * k(a0, z1), -Math.cos(a0) * k(a0, z1), z1],
      ];
      for (const idx of [0, 1, 2, 0, 2, 3]) positions.push(...q[idx]!);
    }
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  shell.computeVertexNormals();
  parts.push(shell);
  for (let i = 0; i < 7; i++) {
    const rib = plain(new THREE.TorusGeometry(1.02, 0.05, 4, cols, arc)).toNonIndexed();
    rib.rotateZ(-Math.PI / 2 - arc / 2);
    rib.translate(0, 0, -length / 2 + ((i + 0.3) / 7) * length * 0.85);
    parts.push(rib);
  }
  // An inner deck, a keel pair, and girders sticking out of the broken end.
  parts.push(plain(new THREE.BoxGeometry(1.5, 0.04, length * 0.7)).translate(0, -0.35, -length * 0.12).toNonIndexed());
  for (const side of [-1, 1]) parts.push(plain(new THREE.BoxGeometry(0.12, 0.18, length * 1.05)).translate(side * 0.35, -1.05, 0).toNonIndexed());
  for (let i = 0; i < 4; i++) {
    const a = -arc / 2 + rnd() * arc;
    const g = plain(new THREE.BoxGeometry(0.07, 0.07, 0.5 + rnd() * 0.7)).toNonIndexed();
    g.rotateX((rnd() - 0.5) * 0.6).rotateY((rnd() - 0.5) * 0.6);
    g.translate(Math.sin(a) * 0.95, -Math.cos(a) * 0.95, length * 0.28 + rnd() * 0.3);
    parts.push(g);
  }
  const glow: number[] = [];
  for (const g of parts) glow.push(...new Array<number>(g.getAttribute('position').count).fill(0));
  for (const at of [
    [0.9, -0.45, -1.2],
    [-0.95, -0.3, 0.4],
    [0, -1.12, 1.5],
  ]) {
    const beacon = plain(new THREE.BoxGeometry(0.07, 0.07, 0.07)).toNonIndexed();
    beacon.translate(at[0]!, at[1]!, at[2]!);
    parts.push(beacon);
    glow.push(...new Array<number>(beacon.getAttribute('position').count).fill(1));
  }
  const merged = mergeVariants(parts);
  // mergeVariants tagged each part with its own index; the derelict is one shape.
  (merged.getAttribute('aVariant') as THREE.BufferAttribute).array.fill(0);
  merged.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  return merged;
}
