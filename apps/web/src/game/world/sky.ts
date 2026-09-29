import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

import { ANCHOR_GLSL, blackbody } from './anchor.js';
import type { Anchor } from './anchor.js';
import { NOISE_GLSL } from './glsl.js';
import { chaseDirection } from './composition.js';
import { seededRandom } from './math.js';

/**
 * The one light every lit module consumes (world space, linear colour), derived
 * from the anchor: `sunDir` points from the stage toward the anchor, `key` is
 * its blackbody colour, and the fills are a faint cool bounce from the sky, the
 * only ambient in the world. `rim` is a faint key-tinted silhouette rim.
 */
export interface Lighting {
  sunDir: THREE.Vector3;
  key: THREE.Color;
  fillSky: THREE.Color;
  fillGround: THREE.Color;
  rim: THREE.Color;
  /**
   * Sky irradiance as an ambient cube (+X, -X, +Y, -Y, +Z, -Z), measured from
   * the baked sky and scaled to FILL of the key: shade with `ocAmbient` from
   * glsl.ts. `fillSky` / `fillGround` carry its +Y / -Y faces.
   */
  ambient: THREE.Color[];
}

/** Baked cubemap face size: ~1.5 screen px per texel at 1440p / 42 deg. */
const BAKE_SIZE = 2048;
/** Each face bakes in this many row bands, one band per frame (~6 ms GPU each). */
const BAKE_BANDS = 16;
const FAINT_STARS = 60000;
const BRIGHT_STARS = 48;
const NEBULAE = 3;
const GALAXIES = 6;
/** Seconds the finished bake takes to fade in. */
const BAKE_FADE_S = 0.6;
/** Sky fill as a fraction of the key's luminance: blacks stay deep, not dead. */
const FILL = 0.035;
/** A quarter of every fill side takes this cool hue (luminance 1), so a starless side still has one. */
const FILL_BASE = new THREE.Color(0.1, 0.13, 0.22).multiplyScalar(1 / 0.1383);

const IRRADIANCE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Pixel i of a 6x1 target: cosine-weighted mean of the sky over axis i's hemisphere. */
const IRRADIANCE_FRAG = /* glsl */ `
uniform samplerCube uSky;
varying vec2 vUv;
void main() {
  int face = int(floor(vUv.x * 6.0));
  vec3 axis = vec3(0.0);
  axis[face / 2] = face % 2 == 0 ? 1.0 : -1.0;
  vec3 t1 = normalize(cross(axis, abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(axis, t1);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 2048; i++) {
    float u = (float(i) + 0.5) / 2048.0;
    float r = sqrt(u);
    float a = float(i) * 2.39996323;
    sum += textureCube(uSky, normalize(t1 * (r * cos(a)) + t2 * (r * sin(a)) + axis * sqrt(1.0 - u))).rgb;
  }
  gl_FragColor = vec4(sum / 2048.0, 1.0);
}`;

/** Galactic dust lanes: shared by the bake and the faint stars they swallow. */
const BAND_GLSL = /* glsl */ `
uniform vec3 uBandN;
uniform vec3 uBandC;
uniform vec3 uSeedOff;

// x: latitude from the (warped) mid-plane in band widths, y: longitude from
// the core, z: band half-width (rad), w: dust lane opacity.
vec4 ocBand(vec3 d) {
  float lat = asin(clamp(dot(d, uBandN), -1.0, 1.0));
  float lon = atan(dot(d, cross(uBandN, uBandC)), dot(d, uBandC));
  float bulge = exp(-lon * lon / 0.2);
  float width = 0.1 + 0.09 * bulge;
  float warp = (ocFbm(d * 1.9 + uSeedOff, 3.0) - 0.5) * 0.14;
  vec3 q = d * 4.2 + uSeedOff * 0.7;
  q += 0.8 * (vec3(ocFbm(q + 1.7, 3.0), ocFbm(q + 5.3, 3.0), ocFbm(q + 9.1, 3.0)) - 0.5);
  float dust = ocFbm(q * 2.1, 5.0);
  // Thick clouds where the field is high, thin dark filaments along one of
  // its level sets, all hugging the mid-plane.
  float ridge = clamp(1.0 - abs(dust - 0.56) * 22.0, 0.0, 1.0);
  float laneY = (lat + warp * 0.8 - 0.012) / (width * 0.58);
  float lane = max(smoothstep(0.55, 0.62, dust), ridge * ridge * 0.8) * exp(-laneY * laneY);
  return vec4((lat + warp) / width, lon, width, lane);
}
`;

const BAKE_VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * The static deep sky, raymarched once per destination seed: near-black base,
 * the galactic band with a warm core, knotted star clouds and dust lanes,
 * emission/reflection nebulae with dust in front, and distant galaxies.
 */
const BAKE_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec4 uNeb[${NEBULAE}];
uniform vec4 uNebMix[${NEBULAE}];
uniform vec4 uGal[${GALAXIES}];
uniform vec4 uGalShape[${GALAXIES}];
${NOISE_GLSL}
${BAND_GLSL}
varying vec3 vPos;

const vec3 H_ALPHA = vec3(0.578, 0.032, 0.045);
const vec3 O_III = vec3(0.05, 0.48, 0.43);
const vec3 REFLECTION = vec3(0.07, 0.2, 0.69);

vec3 ocGalaxyBand(vec3 d, vec4 b) {
  float y = b.x;
  float bulge = exp(-b.y * b.y / 0.2);
  float along = 0.22 + 0.78 * exp(-b.y * b.y / 1.4);
  float clouds = ocFbm(d * 8.0 + uSeedOff * 1.3, 5.0);
  float knots = smoothstep(0.5, 0.72, clouds);
  float mottle = ocFbm(d * 40.0 + uSeedOff, 3.0);
  // Unresolved stars: a fine grain, so clouds read as crowds of stars, not cotton.
  float grain = ocNoise(d * 420.0 + uSeedOff) * ocNoise(d * 260.0 - uSeedOff);
  // Golden-white star clouds with high local contrast; very little fog.
  float body = exp(-y * y) * (0.04 + 1.9 * knots) * (0.3 + 0.9 * mottle) * (0.25 + 2.2 * grain);
  float glow = exp(-y * y * 0.25) * 0.03;
  float core = bulge * exp(-y * y * 0.8) * (0.3 + 2.2 * knots) * (0.5 + 0.8 * mottle) * (0.45 + 1.6 * grain);
  vec3 arm = vec3(0.72, 0.82, 1.0);
  vec3 warm = vec3(1.0, 0.86, 0.66);
  vec3 col = mix(arm, warm, clamp(bulge * 0.9 + knots * 0.15, 0.0, 1.0)) * (along * (body + glow) + core);
  // Crisp dust lanes: a thin reddened edge, then near-total absorption.
  float lane = b.w;
  col *= mix(vec3(1.0), vec3(1.0, 0.84, 0.7), smoothstep(0.1, 0.4, lane) * (1.0 - lane));
  return col * (1.0 - 0.97 * lane) * 0.04;
}

// One nebula raymarched through a slab in its own tangent frame: H-alpha
// sheets on ridged, domain-warped FBM; an OIII-bright hot core; reflection
// wisps; dust in the front half swallowing what lies behind.
vec3 ocNebula(vec3 d, vec4 neb, vec4 mixw, float seed, inout float T) {
  float cd = dot(d, neb.xyz);
  if (cd < cos(neb.w * 1.6)) return vec3(0.0);
  vec3 t1 = normalize(cross(neb.xyz, abs(neb.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(neb.xyz, t1);
  vec2 uv = vec2(dot(d, t1), dot(d, t2)) / (cd * neb.w);
  vec3 L = vec3(0.0);
  float Tn = 1.0;
  const int N = 18;
  const float DZ = 2.0 / 18.0;
  for (int k = 0; k < N; k++) {
    float z = -1.0 + (float(k) + 0.5) * DZ;
    vec3 p = vec3(uv, z * 0.8);
    float r2 = dot(p, p);
    float env = exp(-r2 * 2.2);
    if (env < 0.02) continue;
    vec3 wp = p * 1.8 + seed;
    vec3 w = vec3(ocFbm(wp, 4.0), ocFbm(wp + 3.1, 4.0), ocFbm(wp + 7.7, 4.0)) - 0.5;
    float n = ocFbm(wp * 1.6 + w * 2.4, 5.0);
    float sheet = clamp(1.0 - abs(n - 0.54) * 9.0, 0.0, 1.0);
    float cloud = smoothstep(0.42, 0.72, n);
    float dens = env * (sheet * sheet * 1.3 + cloud * 0.3);
    float core = exp(-r2 * 6.0);
    float dust = env * smoothstep(0.56, 0.78, ocFbm(wp * 2.6 + w * 3.0 + 11.0, 4.0)) * step(z, 0.2);
    vec3 em = H_ALPHA * (mixw.x * dens * smoothstep(0.04, 0.45, r2))
      + O_III * (mixw.y * core * (0.2 + cloud) * env)
      + REFLECTION * (mixw.z * (cloud * 0.8 + sheet * 0.4) * env);
    L += Tn * em * DZ;
    Tn *= exp(-dust * mixw.w * 10.0 * DZ);
  }
  T *= Tn;
  return L * 0.4;
}

vec3 ocGalaxies(vec3 d) {
  vec3 col = vec3(0.0);
  for (int i = 0; i < ${GALAXIES}; i++) {
    vec4 g = uGal[i];
    float cd = dot(d, g.xyz);
    if (cd < cos(g.w * 3.0)) continue;
    vec4 s = uGalShape[i];
    vec3 t1 = normalize(cross(g.xyz, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(g.xyz, t1);
    vec2 p = vec2(dot(d, t1), dot(d, t2)) / (cd * g.w);
    p = mat2(cos(s.z), sin(s.z), -sin(s.z), cos(s.z)) * p;
    p.y /= s.y;
    float r = length(p);
    float I = exp(-r * 3.2) + 2.5 * exp(-r * r * 60.0);
    if (s.x > 0.5) {
      float a = atan(p.y, p.x + 1e-9);
      float arms = 0.5 + 0.5 * cos(2.0 * a - 5.5 * log(r + 0.05));
      I *= mix(1.0, arms * 1.6, smoothstep(0.08, 0.3, r));
    }
    vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.85, 0.62), exp(-r * 5.0));
    col += tint * I * s.w;
  }
  return col;
}

void main() {
  vec3 d = normalize(vPos);
  vec4 b = ocBand(d);
  float T = 1.0;
  vec3 neb = vec3(0.0);
  for (int i = 0; i < ${NEBULAE}; i++) neb += ocNebula(d, uNeb[i], uNebMix[i], float(i) * 17.3 + uSeedOff.x, T);
  vec3 col = (uBase + ocGalaxyBand(d, b) + ocGalaxies(d)) * T + neb;
  gl_FragColor = vec4(col, 1.0);
}`;

/** The faint star field as baked points: dimmed by the dust lanes they sit behind. */
const BAKE_STAR_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
varying vec3 vColor;
${NOISE_GLSL}
${BAND_GLSL}
void main() {
  vec4 b = ocBand(normalize(position));
  vColor = aColor * (1.0 - 0.9 * b.w);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize;
}`;

const BAKE_STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 16.0;
  gl_FragColor = vec4(vColor * exp(-r2 * 1.6), 1.0);
}`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 view = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vDir = (vec4(view.xyz / view.w, 0.0) * viewMatrix).xyz;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

/** Per frame: the anchor (lensing the baked sky for black holes) plus one cube lookup. */
const SKY_FRAG = /* glsl */ `
uniform samplerCube uSky;
uniform float uSkyGain;
uniform float uReveal;
${ANCHOR_GLSL}
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = vec3(0.0);
  float hole = 0.0;
  // Hidden under the jump: skip the anchor (and its orbit integration) outright.
  if (uReveal > 0.0) {
    vec3 skyDir;
    float skyT;
    col = ocAnchor(dir, skyDir, skyT, hole);
    col += textureCube(uSky, skyDir).rgb * (skyT * uSkyGain);
    col *= uReveal;
  }
  // Under the jump charge only a dim, unlensed star field remains.
  if (uReveal < 1.0) col += textureCube(uSky, dir).rgb * (uSkyGain * 0.3 * (1.0 - uReveal));
  // Alpha carries the bare shadow to the lens, which keeps it truly black.
  gl_FragColor = vec4(col, 1.0 - hole * uReveal);
}`;

/** Bright stars: one instanced draw of camera-facing quads with 4-point spikes. */
const STAR_VERT = /* glsl */ `
attribute vec3 aDir;
attribute vec4 aLight;
uniform vec2 uViewport;
uniform float uPxScale;
varying vec2 vPx;
varying vec4 vLight;
void main() {
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * aDir, 0.0);
  float half_ = aLight.w * uPxScale;
  vPx = position.xy * half_;
  vLight = vec4(aLight.rgb, half_);
  clip.xy += vPx * 2.0 / uViewport * clip.w;
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
}`;

const STAR_FRAG = /* glsl */ `
uniform float uPxScale;
uniform float uReveal;
varying vec2 vPx;
varying vec4 vLight;
void main() {
  vec2 p = vPx / uPxScale;
  float L = vLight.w / uPxScale;
  vec2 a = abs(p);
  float core = exp(-dot(p, p) * 0.9);
  float glow = exp(-length(p) * 0.55) * 0.05;
  float sx = exp(-a.y * 1.6) * pow(max(1.0 - a.x / L, 0.0), 3.0);
  float sy = exp(-a.x * 1.6) * pow(max(1.0 - a.y / L, 0.0), 3.0);
  float I = core * 2.4 + glow + (sx + sy) * 0.34;
  gl_FragColor = vec4(vLight.rgb * I * mix(0.35, 1.0, uReveal), 1.0);
}`;

/**
 * The deep field in two draws: one full-screen pass (the anchor, lensing the
 * baked cubemap for black holes) and one instanced draw of ~48 bright stars.
 * The expensive, static sky is baked per destination seed into a float cube
 * map, one face band per frame, and fades in when complete.
 */
export class Sky {
  readonly group = new THREE.Group();
  private readonly anchor: Anchor;
  private readonly cube: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeGeo: THREE.SphereGeometry;
  private readonly bakeMat: THREE.ShaderMaterial;
  private readonly bakeStarGeo: THREE.BufferGeometry;
  private readonly bakeStarMat: THREE.ShaderMaterial;
  private readonly skyGeo: THREE.BufferGeometry;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly starGeo: THREE.InstancedBufferGeometry;
  private readonly starMat: THREE.ShaderMaterial;
  private readonly starDir: THREE.InstancedBufferAttribute;
  private readonly starLight: THREE.InstancedBufferAttribute;
  private seed = '';
  /** Next band to bake (face * BAKE_BANDS + band); -1 when the cube is current. */
  private bakeCursor = 0;
  private fade = 0;
  private readonly irradiance = new THREE.WebGLRenderTarget(6, 1, { type: THREE.FloatType, depthBuffer: false });
  private readonly irradiancePixels = new Float32Array(24);
  private readonly irradianceQuad = new FullScreenQuad();
  private readonly irradianceMat: THREE.ShaderMaterial;

  constructor(anchor: Anchor) {
    this.anchor = anchor;
    this.cube = new THREE.WebGLCubeRenderTarget(BAKE_SIZE, {
      format: THREE.RGBFormat,
      type: THREE.UnsignedInt101111Type,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.cube);
    this.irradianceMat = new THREE.ShaderMaterial({
      uniforms: { uSky: { value: this.cube.texture } },
      vertexShader: IRRADIANCE_VERT,
      fragmentShader: IRRADIANCE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.irradianceQuad.material = this.irradianceMat;

    this.bakeGeo = new THREE.SphereGeometry(5, 64, 32);
    this.bakeMat = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Vector3(0.00022, 0.00032, 0.0008) },
        uBandN: { value: new THREE.Vector3(0, 1, 0) },
        uBandC: { value: new THREE.Vector3(1, 0, 0) },
        uSeedOff: { value: new THREE.Vector3() },
        uNeb: { value: Array.from({ length: NEBULAE }, () => new THREE.Vector4()) },
        uNebMix: { value: Array.from({ length: NEBULAE }, () => new THREE.Vector4()) },
        uGal: { value: Array.from({ length: GALAXIES }, () => new THREE.Vector4()) },
        uGalShape: { value: Array.from({ length: GALAXIES }, () => new THREE.Vector4()) },
      },
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const bakeSphere = new THREE.Mesh(this.bakeGeo, this.bakeMat);
    bakeSphere.renderOrder = 0;
    bakeSphere.frustumCulled = false;

    this.bakeStarGeo = new THREE.BufferGeometry();
    this.bakeStarGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FAINT_STARS * 3), 3));
    this.bakeStarGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(FAINT_STARS), 1));
    this.bakeStarGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(FAINT_STARS * 3), 3));
    this.bakeStarMat = new THREE.ShaderMaterial({
      uniforms: {
        uBandN: this.bakeMat.uniforms.uBandN!,
        uBandC: this.bakeMat.uniforms.uBandC!,
        uSeedOff: this.bakeMat.uniforms.uSeedOff!,
      },
      vertexShader: BAKE_STAR_VERT,
      fragmentShader: BAKE_STAR_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
    });
    const bakeStars = new THREE.Points(this.bakeStarGeo, this.bakeStarMat);
    bakeStars.renderOrder = 1;
    bakeStars.frustumCulled = false;
    this.bakeScene.add(bakeSphere, bakeStars);

    // Full-screen triangle; the vertex shader rebuilds each corner's view ray.
    this.skyGeo = new THREE.BufferGeometry();
    this.skyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        ...anchor.uniforms,
        uSky: { value: this.cube.texture },
        uSkyGain: { value: 0 },
        uReveal: { value: 1 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(this.skyGeo, this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;

    this.starGeo = new THREE.InstancedBufferGeometry();
    this.starGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.starGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.starDir = new THREE.InstancedBufferAttribute(new Float32Array(BRIGHT_STARS * 3), 3);
    this.starLight = new THREE.InstancedBufferAttribute(new Float32Array(BRIGHT_STARS * 4), 4);
    this.starGeo.setAttribute('aDir', this.starDir);
    this.starGeo.setAttribute('aLight', this.starLight);
    this.starGeo.instanceCount = BRIGHT_STARS;
    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        uViewport: { value: new THREE.Vector2(2560, 1440) },
        uPxScale: { value: 1 },
        uReveal: this.skyMat.uniforms.uReveal!,
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Mesh(this.starGeo, this.starMat);
    stars.frustumCulled = false;
    stars.renderOrder = -9;

    this.group.add(sky, stars);
    this.setSeed('idle');
  }

  /** Re-seed the sky layout and restart the bake. Cheap on the CPU. */
  setSeed(seed: string): void {
    if (seed === this.seed) return;
    this.seed = seed;
    const rnd = seededRandom(`${seed}:sky`);
    const u = this.bakeMat.uniforms;
    const axis = chaseDirection(0.5, 0.5, new THREE.Vector3());

    // Galactic plane through the chase frame at a seeded angle; its core sits
    // off to the side of the view away from the anchor, so the two never
    // compete for the eye.
    const across = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0)).normalize();
    const upV = new THREE.Vector3().crossVectors(across, axis).normalize();
    const tilt = (rnd() - 0.5) * 1.6 + (rnd() < 0.5 ? 0.5 : -0.5);
    const inPlane = across.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(upV, Math.sin(tilt));
    const pole = (u.uBandN!.value as THREE.Vector3).crossVectors(inPlane, axis).normalize();
    pole.applyAxisAngle(inPlane, (rnd() - 0.5) * 0.25);
    const coreAngle = 0.4 + rnd() * 0.5;
    const core = (u.uBandC!.value as THREE.Vector3).copy(axis).applyAxisAngle(pole, coreAngle);
    const mirrored = axis.clone().applyAxisAngle(pole, -coreAngle);
    if (mirrored.dot(this.anchor.direction) < core.dot(this.anchor.direction)) core.copy(mirrored);
    core.addScaledVector(pole, -core.dot(pole)).normalize();
    (u.uSeedOff!.value as THREE.Vector3).set(rnd() * 50, rnd() * 50, rnd() * 50);

    // Nebulae: the first sits in the chase frame's upper left, away from the
    // anchor; the rest anywhere. Each is emission (H-alpha sheets around an
    // OIII core), reflection (blue wisps) or dark, always with dust in front.
    const neb = u.uNeb!.value as THREE.Vector4[];
    const mixes = u.uNebMix!.value as THREE.Vector4[];
    const dir = new THREE.Vector3();
    for (let i = 0; i < NEBULAE; i++) {
      if (i === 0) chaseDirection(0.16 + rnd() * 0.2, 0.18 + rnd() * 0.3, dir);
      else randomDirection(rnd, dir);
      neb[i]!.set(dir.x, dir.y, dir.z, 0.14 + rnd() * 0.16);
      const style = rnd();
      if (style < 0.6) mixes[i]!.set(1 + rnd() * 0.4, 0.6 + rnd() * 0.6, 0.1, 0.5 + rnd() * 0.5);
      else if (style < 0.85) mixes[i]!.set(0.15, 0.1, 1 + rnd() * 0.4, 0.5 + rnd() * 0.4);
      else mixes[i]!.set(0.2, 0, 0.2, 1.4);
    }

    const gal = u.uGal!.value as THREE.Vector4[];
    const shape = u.uGalShape!.value as THREE.Vector4[];
    const galaxies = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < GALAXIES; i++) {
      randomDirection(rnd, dir);
      if (i < 2) dir.lerp(axis, 0.8).normalize();
      gal[i]!.set(dir.x, dir.y, dir.z, THREE.MathUtils.degToRad(0.12 + rnd() * 0.22));
      shape[i]!.set(rnd() < 0.55 ? 1 : 0, 0.3 + rnd() * 0.7, rnd() * Math.PI, i < galaxies ? 0.012 + rnd() * 0.02 : 0);
    }

    this.seedFaintStars(rnd, pole);
    this.seedBrightStars(rnd, axis);
    this.bakeCursor = 0;
    this.fade = 0;
    this.skyMat.uniforms.uSkyGain!.value = 0;
  }

  /** Faint field: 70% hug the galactic band; colours span M through B. */
  private seedFaintStars(rnd: () => number, pole: THREE.Vector3): void {
    const pos = this.bakeStarGeo.getAttribute('position') as THREE.BufferAttribute;
    const size = this.bakeStarGeo.getAttribute('aSize') as THREE.BufferAttribute;
    const color = this.bakeStarGeo.getAttribute('aColor') as THREE.BufferAttribute;
    const dir = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < FAINT_STARS; i++) {
      randomDirection(rnd, dir);
      if (rnd() < 0.7) {
        // Squash toward the plane: latitude shrinks to a ~9 deg gaussian band.
        const lat = dir.dot(pole);
        dir.addScaledVector(pole, -lat + lat * 0.16 * gaussian(rnd)).normalize();
      }
      pos.setXYZ(i, dir.x * 5, dir.y * 5, dir.z * 5);
      // Magnitude-like spread: most stars sit at the edge of visibility.
      const m = Math.pow(rnd(), 6);
      starColor(rnd, c).multiplyScalar(0.0035 * Math.pow(10, 2.3 * m));
      color.setXYZ(i, c.r, c.g, c.b);
      size.setX(i, 2.4 + 2.2 * m);
    }
    pos.needsUpdate = true;
    size.needsUpdate = true;
    color.needsUpdate = true;
  }

  /** ~48 bright stars, half of them around the chase view, none on the anchor. */
  private seedBrightStars(rnd: () => number, axis: THREE.Vector3): void {
    const dir = new THREE.Vector3();
    const c = new THREE.Color();
    const clear = Math.cos(this.anchor.extentRadius * 1.15);
    for (let i = 0; i < BRIGHT_STARS; i++) {
      for (let tries = 0; tries < 32; tries++) {
        randomDirection(rnd, dir);
        if (i % 2 === 0) dir.lerp(axis, 0.7).normalize();
        if (dir.dot(this.anchor.direction) < clear) break;
      }
      this.starDir.setXYZ(i, dir.x, dir.y, dir.z);
      const m = rnd();
      starColor(rnd, c).multiplyScalar(0.5 + 1.8 * m * m);
      this.starLight.setXYZW(i, c.r, c.g, c.b, 10 + 34 * m * m);
    }
    this.starDir.needsUpdate = true;
    this.starLight.needsUpdate = true;
  }

  /**
   * Bake one face band into the cube map (one per frame until done), then
   * fade the sky in. The previous seed shows black while a bake runs.
   */
  bake(renderer: THREE.WebGLRenderer, dtS: number): void {
    if (this.bakeCursor < 0) {
      if (this.fade < 1) {
        this.fade = Math.min(1, this.fade + dtS / BAKE_FADE_S);
        this.skyMat.uniforms.uSkyGain!.value = this.fade * this.fade;
      }
      return;
    }
    if (this.cubeCamera.coordinateSystem !== renderer.coordinateSystem) {
      this.cubeCamera.coordinateSystem = renderer.coordinateSystem;
      this.cubeCamera.updateCoordinateSystem();
    }
    const face = Math.floor(this.bakeCursor / BAKE_BANDS);
    const band = this.bakeCursor % BAKE_BANDS;
    const rows = BAKE_SIZE / BAKE_BANDS;
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.cube.scissor.set(0, band * rows, BAKE_SIZE, rows);
    this.cube.scissorTest = true;
    renderer.setRenderTarget(this.cube, face);
    renderer.render(this.bakeScene, this.cubeCamera.children[face] as THREE.PerspectiveCamera);
    this.cube.scissorTest = false;
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    this.bakeCursor += 1;
    if (this.bakeCursor >= 6 * BAKE_BANDS) {
      this.bakeCursor = -1;
      this.measureFill(renderer);
    }
  }

  /**
   * Integrate the finished sky over the six axis hemispheres (one 6x1 float
   * pass, one readback per seed) and publish it as the fill: FILL of the key's
   * luminance on average, keeping each side's own colour.
   */
  private measureFill(renderer: THREE.WebGLRenderer): void {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.irradiance);
    this.irradianceQuad.render(renderer);
    renderer.readRenderTargetPixels(this.irradiance, 0, 0, 6, 1, this.irradiancePixels);
    renderer.setRenderTarget(previous);
    const p = this.irradiancePixels;
    let mean = 0;
    for (let i = 0; i < 6; i++) mean += (0.2126 * p[i * 4]! + 0.7152 * p[i * 4 + 1]! + 0.0722 * p[i * 4 + 2]!) / 6;
    const L = this.anchor.lighting;
    const target = FILL * (0.2126 * L.key.r + 0.7152 * L.key.g + 0.0722 * L.key.b);
    const scale = target / Math.max(mean, 1e-6);
    const base = FILL_BASE.clone().multiplyScalar(target);
    for (let i = 0; i < 6; i++) {
      L.ambient[i]!.setRGB(p[i * 4]! * scale, p[i * 4 + 1]! * scale, p[i * 4 + 2]! * scale).lerp(base, 0.25);
    }
    L.fillSky.copy(L.ambient[2]!);
    L.fillGround.copy(L.ambient[3]!);
  }

  /** 0 hides the whole backdrop (sky, anchor, stars) under the hyperspace jump. */
  setReveal(k: number): void {
    this.skyMat.uniforms.uReveal!.value = Math.min(1, Math.max(0, k));
  }

  /** Internal drawing-buffer size, so star quads keep their 1080p pixel size. */
  setViewport(heightPx: number, aspect: number): void {
    (this.starMat.uniforms.uViewport!.value as THREE.Vector2).set(heightPx * aspect, heightPx);
    this.starMat.uniforms.uPxScale!.value = heightPx / 1080;
  }

  /** Rung 2+ uses the cheaper sky: cheap anchor, half the bright stars. */
  setRung(rung: number): void {
    this.anchor.setRung(rung);
    this.starGeo.instanceCount = rung >= 2 ? BRIGHT_STARS / 2 : BRIGHT_STARS;
  }

  dispose(): void {
    this.cube.dispose();
    this.irradiance.dispose();
    this.irradianceQuad.dispose();
    this.irradianceMat.dispose();
    this.bakeGeo.dispose();
    this.bakeMat.dispose();
    this.bakeStarGeo.dispose();
    this.bakeStarMat.dispose();
    this.skyGeo.dispose();
    this.skyMat.dispose();
    this.starGeo.dispose();
    this.starMat.dispose();
    this.bakeScene.clear();
    this.group.clear();
  }
}

function randomDirection(rnd: () => number, out: THREE.Vector3): THREE.Vector3 {
  const z = rnd() * 2 - 1;
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * r, z, Math.sin(a) * r);
}

/** Standard normal sample (Box-Muller). */
function gaussian(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-9))) * Math.cos(2 * Math.PI * rnd());
}

/** Stellar colour from a seeded spectral mix (M..B), a touch more saturated than physical. */
function starColor(rnd: () => number, out: THREE.Color): THREE.Color {
  const t = rnd();
  const kelvin =
    t < 0.12 ? 3200 + rnd() * 800 : t < 0.42 ? 4000 + rnd() * 1200 : t < 0.62 ? 5200 + rnd() * 800 : t < 0.8 ? 6000 + rnd() * 1500 : t < 0.92 ? 7500 + rnd() * 2500 : 10000 + rnd() * 14000;
  blackbody(kelvin, out);
  const luma = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  return out.setRGB(luma + (out.r - luma) * 1.35, luma + (out.g - luma) * 1.35, luma + (out.b - luma) * 1.35);
}
