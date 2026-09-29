import * as THREE from 'three';

import { hashSeed, mulberry32 } from '@opencycle/shared';

import { NOISE_GLSL } from './glsl.js';
import { seededRandom } from './math.js';
import { NOMINAL_FOV_Y_RAD, UP, nominalAxisDirection, nominalFovX } from './composition.js';

/** Warm key light: the sun every surface in the world keys off. */
export const KEY_INTENSITY = 1.6;
/** Nebula bands never outshine a quarter of the key light (plan §4 sky). */
export const NEBULA_MAX = 0.25 * KEY_INTENSITY;

const SKY_RADIUS = 9000;
const STAR_RADIUS = 6000;
const STAR_COUNT = 7000;
/** Sun direction lives inside 35° of upper-left. */
const SUN_CONE_RAD = (35 * Math.PI) / 180;

/** Palette shared by the sky, the destination system and the horizon giant. */
export interface SkyPalette {
  family: number;
  nebulaA: THREE.Color;
  nebulaB: THREE.Color;
  star: THREE.Color;
  sea: THREE.Color;
  land: THREE.Color;
  cloud: THREE.Color;
  accent: THREE.Color;
}

/** Lighting the hull, asteroid and route shaders consume (world space). */
export interface Lighting {
  sunDir: THREE.Vector3;
  key: THREE.Color;
  fillSky: THREE.Color;
  fillGround: THREE.Color;
  rim: THREE.Color;
}

const FAMILIES = [
  // blue / magenta — the concept's blue haze, magenta kept as a minority wisp
  { nebulaA: 0x3d5cb8, nebulaB: 0x8f4270, star: 0xcdd8ff, sea: 0x122a52, land: 0x2f4470, cloud: 0x9fb2e0, accent: 0x7fd8ff },
  // teal / amber
  { nebulaA: 0x1f7d86, nebulaB: 0xc98a3a, star: 0xd8f0ea, sea: 0x0f3330, land: 0x2f6a52, cloud: 0xa7d8c8, accent: 0xffc38a },
  // violet / rose
  { nebulaA: 0x5a3a9a, nebulaB: 0xd1777f, star: 0xf2d9ff, sea: 0x241a44, land: 0x463263, cloud: 0xc0a8e0, accent: 0xffb0c8 },
  // steel / gold
  { nebulaA: 0x35597d, nebulaB: 0xc9a94a, star: 0xfff0cf, sea: 0x14202e, land: 0x3b4a5c, cloud: 0xbcccda, accent: 0xf5d488 },
] as const;

export function skyPalette(seed: string): SkyPalette {
  const family = hashSeed(`${seed}:palette`) % FAMILIES.length;
  const f = FAMILIES[family]!;
  return {
    family,
    nebulaA: new THREE.Color(f.nebulaA),
    nebulaB: new THREE.Color(f.nebulaB),
    star: new THREE.Color(f.star),
    sea: new THREE.Color(f.sea),
    land: new THREE.Color(f.land),
    cloud: new THREE.Color(f.cloud),
    accent: new THREE.Color(f.accent),
  };
}

/**
 * The sun disc + glow are drawn in this direction, and it is the scene's key
 * light. Staging note: it sits upper-left and *behind* the chase camera. A sun
 * in front of the camera would back-light the destination system — the arrival
 * payoff is one surveyed feature per clean leg, and a night-side crescent makes
 * the moons, ring and station unreadable. Behind-left instead lights the fleet
 * and the whole destination system, which is what the shot needs.
 */
export function seededSunDir(seed: string): THREE.Vector3 {
  const rnd = seededRandom(`${seed}:sun`);
  const base = new THREE.Vector3(-0.62, 0.66, 0.42).normalize();
  const t1 = new THREE.Vector3().crossVectors(base, new THREE.Vector3(0, 1, 0)).normalize();
  const t2 = new THREE.Vector3().crossVectors(base, t1).normalize();
  const radius = SUN_CONE_RAD * Math.sqrt(rnd());
  const phi = rnd() * Math.PI * 2;
  return base
    .clone()
    .multiplyScalar(Math.cos(radius))
    .addScaledVector(t1, Math.sin(radius) * Math.cos(phi))
    .addScaledVector(t2, Math.sin(radius) * Math.sin(phi))
    .normalize();
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Void base, one restrained nebula band, the sun as a disc plus halo. Every
 * term is authored from the seeded palette; the band is clamped to
 * NEBULA_MAX so the sky can never compete with the key light.
 */
const SKY_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uNebulaA;
uniform vec3 uNebulaB;
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uBandNormal;
uniform vec3 uSeedOffset;
uniform float uNebulaMax;
${NOISE_GLSL}
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = uBase;

  // One soft haze band across the frame diagonal (upper-left to lower-right),
  // broken up by slow FBM so it reads as cloud rather than a stripe. The band
  // normal is solved on the CPU from the shot, so it always crosses the frame.
  float bandDot = dot(dir, uBandNormal);
  float band = exp(-bandDot * bandDot * 18.0);
  float n = ocFbm(dir * 2.6 + uSeedOffset, 3.0);
  float wisp = smoothstep(0.28, 0.88, n);
  // Blue-dominant haze: the minority colour only tints the wisps.
  vec3 nebula = mix(uNebulaA, uNebulaB, wisp * 0.5) * band * (0.6 + 0.45 * wisp);
  col += min(nebula, vec3(uNebulaMax));

  // Sun: hard disc plus two halo terms, in the seeded direction.
  float sd = max(dot(dir, uSunDir), 0.0);
  float disc = smoothstep(0.99955, 0.99986, sd);
  float halo = pow(sd, 220.0) * 0.55 + pow(sd, 18.0) * 0.06;
  col += uKeyColor * (disc * 7.0 + halo);

  gl_FragColor = vec4(col, 1.0);
}`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uSize;
varying float vTwinkle;
void main() {
  vTwinkle = 0.72 + 0.28 * sin(uTime * 0.6 + aPhase * 6.2831853);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, uSize * aSize);
}`;

const STAR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uBrightness;
varying float vTwinkle;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.05, r) * vTwinkle * uBrightness;
  gl_FragColor = vec4(uColor * a, a);
}`;

/**
 * The whole sky in two draws: one back-side sphere (base + nebula + sun) and
 * one point cloud for the 7,000 stars. Both are camera-independent (radius
 * 6,000 / 9,000 against a ~120 unit stage) so they never need repositioning.
 */
export class Sky {
  readonly group = new THREE.Group();
  readonly lighting: Lighting;
  private readonly sphereGeo: THREE.SphereGeometry;
  private readonly sphereMat: THREE.ShaderMaterial;
  private readonly starGeo: THREE.BufferGeometry;
  private readonly starMat: THREE.ShaderMaterial;
  private readonly starColors: Float32Array;
  private seed = '';
  private elapsedS = 0;

  constructor() {
    this.lighting = {
      sunDir: new THREE.Vector3(-0.62, 0.66, 0.42).normalize(),
      key: new THREE.Color(0xfff1dc).multiplyScalar(KEY_INTENSITY),
      fillSky: new THREE.Color(0x39496e),
      fillGround: new THREE.Color(0x090c14),
      rim: new THREE.Color(0x9fb6ff),
    };

    this.sphereGeo = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);
    this.sphereMat = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Color(0x02040a) },
        uNebulaA: { value: new THREE.Color(FAMILIES[0].nebulaA) },
        uNebulaB: { value: new THREE.Color(FAMILIES[0].nebulaB) },
        uKeyColor: { value: this.lighting.key.clone() },
        uSunDir: { value: this.lighting.sunDir.clone() },
        uBandNormal: { value: new THREE.Vector3(0.2, 0.45, 0.87).normalize() },
        uSeedOffset: { value: new THREE.Vector3() },
        uNebulaMax: { value: NEBULA_MAX },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(this.sphereGeo, this.sphereMat);
    sphere.frustumCulled = false;
    sphere.renderOrder = -2;

    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes = new Float32Array(STAR_COUNT);
    const phases = new Float32Array(STAR_COUNT);
    this.starColors = new Float32Array(STAR_COUNT * 3);
    const rnd = mulberry32(hashSeed('opencycle:stars'));
    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform on the sphere; sizes skewed small so a handful read as bright.
      const u = rnd() * 2 - 1;
      const theta = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * r * STAR_RADIUS;
      positions[i * 3 + 1] = u * STAR_RADIUS;
      positions[i * 3 + 2] = Math.sin(theta) * r * STAR_RADIUS;
      sizes[i] = 0.4 + Math.pow(rnd(), 2.6) * 1.6;
      phases[i] = rnd();
    }
    this.starGeo = new THREE.BufferGeometry();
    this.starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    this.starGeo.setAttribute('color', new THREE.BufferAttribute(this.starColors, 3));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 2.4 },
        uColor: { value: new THREE.Color(0xffffff) },
        uBrightness: { value: 0.9 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(this.starGeo, this.starMat);
    stars.frustumCulled = false;
    stars.renderOrder = -1;

    this.group.add(sphere, stars);
    this.setSeed('idle');
  }

  /** Re-bake the palette, sun and star tint. Cheap; only runs on seed change. */
  setSeed(seed: string): void {
    if (seed === this.seed) return;
    this.seed = seed;
    const palette = skyPalette(seed);
    const rnd = seededRandom(`${seed}:sky`);
    const u = this.sphereMat.uniforms;

    (u.uNebulaA!.value as THREE.Color).copy(palette.nebulaA);
    (u.uNebulaB!.value as THREE.Color).copy(palette.nebulaB);
    // Band normal: the plane through the frame's upper-left and lower-right
    // corners, so the haze crosses the view diagonally by construction, with a
    // seeded roll so systems differ.
    const axis = nominalAxisDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(axis, UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, axis).normalize();
    const halfX = nominalFovX() / 2;
    const halfY = NOMINAL_FOV_Y_RAD / 2;
    const upperLeft = axis
      .clone()
      .addScaledVector(right, -Math.tan(halfX) * 1.02)
      .addScaledVector(up, Math.tan(halfY) * 1.02);
    const lowerRight = axis
      .clone()
      .addScaledVector(right, Math.tan(halfX) * 1.02)
      .addScaledVector(up, -Math.tan(halfY) * 1.02);
    const band = (u.uBandNormal!.value as THREE.Vector3)
      .crossVectors(upperLeft, lowerRight)
      .normalize();
    band.applyAxisAngle(axis, (rnd() - 0.5) * 0.5);
    (u.uSeedOffset!.value as THREE.Vector3).set(rnd() * 40, rnd() * 40, rnd() * 40);

    this.lighting.sunDir.copy(seededSunDir(seed));
    (u.uSunDir!.value as THREE.Vector3).copy(this.lighting.sunDir);
    (u.uKeyColor!.value as THREE.Color).copy(this.lighting.key);
    // Hulls read as light steel: a neutral, reasonably bright hemisphere fill
    // (shadow side stays legible) and a restrained accent rim.
    this.lighting.fillSky
      .copy(palette.nebulaA)
      .lerp(new THREE.Color(0x93a2b8), 0.65)
      .multiplyScalar(0.6);
    this.lighting.fillGround.copy(palette.sea).multiplyScalar(0.25);
    this.lighting.rim.copy(palette.accent).lerp(new THREE.Color(0xc8d4e8), 0.5).multiplyScalar(0.3);

    const star = palette.star;
    for (let i = 0; i < STAR_COUNT; i++) {
      const t = rnd();
      this.starColors[i * 3] = star.r * (0.55 + 0.45 * t);
      this.starColors[i * 3 + 1] = star.g * (0.55 + 0.45 * t);
      this.starColors[i * 3 + 2] = star.b * (0.55 + 0.45 * t);
    }
    this.starGeo.getAttribute('color').needsUpdate = true;
    (this.starMat.uniforms.uColor!.value as THREE.Color).copy(star).lerp(new THREE.Color(0xffffff), 0.3);
  }

  /** Device pixels per CSS pixel, so star size survives the internal render size. */
  setPixelRatio(pixelRatio: number): void {
    this.starMat.uniforms.uSize!.value = 2.4 * Math.max(1, pixelRatio);
  }

  update(dtS: number): void {
    this.elapsedS += dtS;
    this.starMat.uniforms.uTime!.value = this.elapsedS;
  }

  /** Rung 2+ halves the star count. */
  setRung(rung: number): void {
    this.starGeo.setDrawRange(0, rung >= 2 ? Math.floor(STAR_COUNT / 2) : STAR_COUNT);
  }

  dispose(): void {
    this.sphereGeo.dispose();
    this.sphereMat.dispose();
    this.starGeo.dispose();
    this.starMat.dispose();
    this.group.clear();
  }
}
