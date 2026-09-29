import * as THREE from 'three';

import { hashSeed } from '@opencycle/shared';

import { UP, baseCameraPosition, PLANET_DIR, PLANET_DISTANCE } from './composition.js';
import { NOISE_GLSL } from './glsl.js';
import { easeInCubic, lerp, radians, radiusForFraction, seededRandom, smoothstep } from './math.js';
import type { Lighting } from './sky.js';
import { makeSphereMaterial } from './sphere.js';

/**
 * Destination system: the planet the voyage flies to and its survey features.
 * All of it is seeded — the palette comes from the destination seed.
 *
 * Everything is lit by the anchor alone (vision law 2). In the chase shot the
 * anchor sits behind the planet, so the planet reads as a deep night-side disc
 * with a lit crescent and a forward-scattering atmosphere ring, the ring glows
 * where it is backlit and carries the planet's shadow, and the moons are
 * crescents.
 *
 * The planet is an analytic sphere impostor (see sphere.ts): its limb stays
 * perfectly round at 4K and it writes true hit depth, so the ring's far side
 * and the moons sort against it.
 */
/** Disc radius as a fraction of the viewport height, against frame.progress. */
const FRACTION_NEAR = 0.015;
const FRACTION_MID = 0.12;
const FRACTION_FAR = 0.18;
/** Arrival push-in ends with the disc at 45% of the frame height (radius 22.5%). */
const FRACTION_ARRIVAL = 0.225;
/** Revealed features resolve on approach; outlines only once you are there. */
const FEATURE_REVEAL_PROGRESS = 0.55;
const SLOT_COUNT = 6;
/** Orbit radii in planet radii: outside 1.3 so no slot can project onto the disc. */
const MOON_ORBITS = [1.75, 2.05, 2.3, 2.4];
const MOON_SIZES = [0.15, 0.105, 0.185, 0.09];
const STATION_ORBIT = 1.5;
/** Orbit planes stay shallow so every slot stays beside the disc on screen. */
const MAX_PLANE_TILT = 0.25;
/**
 * Ring plane: the NORMAL sits 62 deg off the camera's line of sight, i.e. the
 * plane is open 28 deg from edge-on, so the ring projects as a classic Saturn
 * ellipse (minor/major = cos 62 deg = 0.47) crossing the planet.
 */
const RING_TILT_RAD = radians(62);
/** Atmosphere shell height in planet radii, and its minimum on-screen width. */
const ATMOSPHERE = 0.045;
const ATMOSPHERE_MIN_PX = 3;
const ATMOSPHERE_GAIN = 1.1;
/** How far out along the key direction the anchor hangs, for the system's own light angle. */
const ANCHOR_DISTANCE = 3800;

/** Planet palette families, seeded by the destination. */
const FAMILIES = [
  { sea: 0x122a52, land: 0x2f4470, cloud: 0x9fb2e0, accent: 0x7fd8ff },
  { sea: 0x0f3330, land: 0x2f6a52, cloud: 0xa7d8c8, accent: 0xffc38a },
  { sea: 0x241a44, land: 0x463263, cloud: 0xc0a8e0, accent: 0xffb0c8 },
  { sea: 0x14202e, land: 0x3b4a5c, cloud: 0xbcccda, accent: 0xf5d488 },
] as const;

interface Palette {
  family: number;
  sea: THREE.Color;
  land: THREE.Color;
  cloud: THREE.Color;
  accent: THREE.Color;
}

function planetPalette(seed: string): Palette {
  const family = hashSeed(`${seed}:palette`) % FAMILIES.length;
  const f = FAMILIES[family]!;
  return {
    family,
    sea: new THREE.Color(f.sea),
    land: new THREE.Color(f.land),
    cloud: new THREE.Color(f.cloud),
    accent: new THREE.Color(f.accent),
  };
}

interface FeatureSlot {
  group: THREE.Group;
  /** The lit object once the survey is clean. */
  lit: THREE.Object3D;
  outline: THREE.Line;
  /** Orbit radius in planet radii; 0 for the equatorial ring. */
  orbit: number;
  phase: number;
  speed: number;
}

/**
 * The body shading functions shared by the impostor and the moon meshes:
 * `ocSurface(dirObj, N, V, worldPos)` and the halo `ocAtmosphere(N, V, h)`.
 */
const SURFACE_SHADE_GLSL = /* glsl */ `
uniform vec3 uSea;
uniform vec3 uLand;
uniform vec3 uCloud;
uniform vec3 uAtmo;
uniform vec3 uKey;
uniform vec3 uSunDir;
uniform vec3 uFill;
uniform vec3 uSeedOffset;
uniform float uOctaves;
uniform float uBandFreq;
uniform float uBandMix;
uniform float uLandLevel;
uniform float uCloudAmount;
uniform float uAtmoGain;
uniform float uTime;
${NOISE_GLSL}

// Air lit from behind scatters forward: the limb blazes when you look toward
// the light, and the light that grazes through it is reddened.
vec3 ocAirGlow(vec3 N, vec3 V) {
  float ndl = dot(N, uSunDir);
  float c = max(dot(-uSunDir, V), 0.0);
  float forward = 0.06 + 0.9 * pow(c, 5.0) + 1.4 * pow(c, 60.0);
  float litAir = smoothstep(-0.35, 0.15, ndl);
  vec3 tint = mix(uAtmo, vec3(1.0, 0.42, 0.18), smoothstep(0.25, -0.25, ndl) * 0.75);
  return tint * uKey * litAir * forward;
}

vec3 ocSurface(vec3 dirObj, vec3 N, vec3 V, vec3 worldPos) {
  vec3 p = normalize(dirObj);
  float terrain = ocFbm(p * 2.4 + uSeedOffset, uOctaves);
  float warp = ocFbm(p * 1.7 + uSeedOffset * 0.5, min(uOctaves, 3.0)) - 0.5;
  float bands = sin(p.y * uBandFreq + warp * 3.2) * 0.5 + 0.5;
  float height = mix(terrain, bands * 0.6 + terrain * 0.4, uBandMix);

  float landMask = smoothstep(uLandLevel, uLandLevel + 0.06, height);
  vec3 surface = mix(uSea, uLand, landMask);

  float clouds = ocFbm(p * 3.1 + uSeedOffset * 1.7 + vec3(uTime * 0.02, 0.0, 0.0), min(uOctaves, 3.0));
  surface = mix(surface, uCloud, smoothstep(0.55, 0.82, clouds) * uCloudAmount);

  // One light: Lambert from the anchor with a short soft terminator; the
  // night side keeps only the faint cool sky bounce.
  float ndl = dot(N, uSunDir);
  float lit = smoothstep(-0.04, 0.2, ndl) * max(ndl, 0.0);
  vec3 col = surface * (uKey * lit + uFill);
  vec3 h = normalize(uSunDir + V);
  col += uKey * pow(max(dot(N, h), 0.0), 40.0) * 0.08 * (1.0 - landMask) * step(0.0, ndl);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += ocAirGlow(N, V) * fres * uAtmoGain;
  return col;
}

vec3 ocAtmosphere(vec3 N, vec3 V, float h) {
  return ocAirGlow(N, V) * uAtmoGain * exp(-h * 4.0) * (1.0 - h) * 0.8;
}`;

const MESH_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vObj = normalize(position);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const MESH_FRAG = /* glsl */ `
uniform float uReveal;
${SURFACE_SHADE_GLSL}
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  gl_FragColor = vec4(ocSurface(normalize(vObj), N, V, vWorldPos) * uReveal, 1.0);
}`;

const RING_VERT = /* glsl */ `
varying vec2 vLocal;
varying vec3 vWorldPos;
varying vec3 vNormalW;
void main() {
  vLocal = position.xy;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/**
 * Thin banded annulus: seeded gaps, palette tint, lit by the anchor. Seen from
 * the lit face it reflects; backlit it glows by forward scattering, brightest
 * in the thin gaps. The planet's shadow is carved out behind it (an analytic
 * cylinder along the light, no shadow map needed).
 */
const RING_FRAG = /* glsl */ `
uniform float uInner;
uniform float uOuter;
uniform vec3 uKey;
uniform vec3 uSunDir;
uniform vec3 uFill;
uniform vec3 uAccent;
uniform vec3 uCenter;
uniform float uPlanetR;
uniform float uNoiseSeed;
uniform float uReveal;
${NOISE_GLSL}
varying vec2 vLocal;
varying vec3 vWorldPos;
varying vec3 vNormalW;

void main() {
  float r = length(vLocal);
  float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
  // Seeded bands, a dark division and fine ringlets, so the annulus reads as
  // ring structure rather than a flat disc. tau is the optical depth.
  float gap = ocNoise(vec3(t * 5.0, uNoiseSeed, 0.0));
  float bands = smoothstep(0.38, 0.46, gap) * (1.0 - smoothstep(0.54, 0.62, gap));
  float band2 = smoothstep(0.72, 0.78, ocNoise(vec3(t * 11.0 + 3.1, uNoiseSeed * 1.7, 0.0)));
  float fine = ocNoise(vec3(t * 60.0, uNoiseSeed * 2.3, 0.0));
  float ringlets = ocNoise(vec3(t * 150.0, uNoiseSeed * 3.1, 0.0));
  float division = smoothstep(0.012, 0.03, abs(t - 0.58 - uNoiseSeed * 0.01));
  float edge = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.86, 1.0, t));
  float bandMix = max(bands, band2 * 0.7);
  float tau = edge * division * (0.12 + 0.55 * bandMix + 0.2 * fine) * (0.65 + 0.35 * ringlets);

  vec3 rel = vWorldPos - uCenter;
  float along = dot(rel, uSunDir);
  float perp = length(rel - uSunDir * along);
  // Umbra behind the planet, with a soft brightness gradient leading into it.
  float umbra = 1.0 - smoothstep(uPlanetR * 0.98, uPlanetR * 1.03, perp);
  float penumbra = 1.0 - smoothstep(uPlanetR * 1.03, uPlanetR * 1.5, perp);
  float behind = 1.0 - smoothstep(-uPlanetR * 0.2, 0.0, along);
  float shadow = 1.0 - behind * (0.97 * umbra + 0.4 * penumbra * (1.0 - umbra));

  // Lit face: diffuse reflection. Backlit: light diffusing through the ring,
  // strongest where it is thin and when looking toward the light.
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndl = dot(N, uSunDir);
  float ndv = dot(N, V);
  float sameSide = step(0.0, ndl * ndv);
  float c = max(dot(-uSunDir, V), 0.0);
  float reflected = abs(ndl) * sameSide;
  float forward = (1.0 - sameSide) * (0.08 + 0.55 * pow(c, 8.0)) * exp(-tau * 2.0);
  // Backlit ice glints: sparse bright grains that catch the forward lobe.
  float sparkle = pow(ocNoise(vec3(vLocal * 190.0, uNoiseSeed)), 9.0) * 7.0;
  forward *= 1.0 + sparkle * pow(c, 4.0);
  // Each band has its own albedo, so the lit face reads as ring structure.
  float albedo = 0.55 + 0.9 * ocNoise(vec3(t * 23.0, uNoiseSeed * 4.1, 0.0)) * (0.6 + 0.4 * bandMix);
  vec3 tint = mix(uAccent, vec3(1.0, 0.92, 0.82), 0.5);
  vec3 col = tint * (uKey * (reflected * 0.7 * albedo + forward) * shadow + uFill);
  float alpha = tau;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col * uReveal, alpha * uReveal);
}`;

/** One-light shading for the station: the anchor key plus the faint sky fill. */
const PROP_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uKey;
uniform vec3 uSunDir;
uniform vec3 uFill;
uniform float uRim;
uniform float uReveal;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndl = dot(N, uSunDir);
  vec3 col = uColor * (uKey * max(ndl, 0.0) + uFill);
  col += uColor * uKey * pow(1.0 - max(dot(N, V), 0.0), 3.5) * uRim * smoothstep(-0.2, 0.3, ndl);
  gl_FragColor = vec4(col * uReveal, 1.0);
}`;

/** The destination planet and one feature slot per survey (ring, moon, station, more moons). */
export class Destination {
  /** Planet + feature slots; positioned at `center` and scaled to the disc radius. */
  readonly group = new THREE.Group();
  /** World-space centre of the destination planet (fixed for the session). */
  readonly center = PLANET_DIR.clone().multiplyScalar(PLANET_DISTANCE);
  private readonly planetGeo: THREE.PlaneGeometry;
  private readonly planetMat: THREE.ShaderMaterial;
  private readonly propGeo: THREE.IcosahedronGeometry;
  private readonly moonMat: THREE.ShaderMaterial;
  private readonly stationMat: THREE.ShaderMaterial;
  private readonly ringGeo: THREE.RingGeometry;
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly outlineGeo: THREE.BufferGeometry;
  private readonly outlineMat: THREE.LineBasicMaterial;
  private readonly features: FeatureSlot[] = [];
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private seed = '';
  private worldRadius = 0;
  private elapsedS = 0;
  private reveal = 1;
  private readonly lightDir = new THREE.Vector3();

  constructor() {
    const palette = planetPalette('idle');

    this.planetGeo = new THREE.PlaneGeometry(2, 2);
    this.planetMat = makeSphereMaterial(SURFACE_SHADE_GLSL, surfaceUniforms(palette, 'planet'));
    const planet = new THREE.Mesh(this.planetGeo, this.planetMat);
    planet.frustumCulled = false;
    planet.renderOrder = 1;
    this.group.position.copy(this.center);
    this.group.add(planet);

    this.propGeo = new THREE.IcosahedronGeometry(1, 2);
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: { ...surfaceUniforms(palette, 'moon'), uReveal: { value: 1 } },
      vertexShader: MESH_VERT,
      fragmentShader: MESH_FRAG,
    });
    this.stationMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xc9d3e2) },
        uKey: { value: new THREE.Color(0xffffff) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uFill: { value: new THREE.Color() },
        uRim: { value: 0.35 },
        uReveal: { value: 1 },
      },
      vertexShader: MESH_VERT,
      fragmentShader: PROP_FRAG,
    });

    // Equatorial ring: thin annulus at 1.25-1.85 planet radii.
    this.ringGeo = new THREE.RingGeometry(1, 1.44, 128, 1);
    this.ringMat = makeRingMaterial(palette.accent, this.center);

    this.outlineGeo = circleGeometry(1, 72);
    this.outlineMat = new THREE.LineBasicMaterial({ color: 0x7f8ea6, transparent: true, opacity: 0.28 });

    for (let i = 0; i < SLOT_COUNT; i++) this.features.push(this.makeFeature(i));
    this.group.add(...this.features.map((f) => f.group));
    this.setSeed('idle');
  }

  private makeFeature(index: number): FeatureSlot {
    const group = new THREE.Group();
    const outline = new THREE.LineLoop(this.outlineGeo, this.outlineMat);
    outline.visible = false;
    group.add(outline);

    // Slot order is fixed by the plan: ring, moon, station, moon, moon, moons.
    let lit: THREE.Object3D;
    let orbit = 0;
    let speed = 0;
    let outlineScale = 1;
    if (index === 0) {
      const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
      ring.scale.setScalar(1.25);
      ring.rotation.x = -Math.PI / 2;
      outline.rotation.x = -Math.PI / 2;
      outlineScale = 1.52;
      lit = ring;
    } else if (index === 2) {
      const stationGeo = new THREE.TorusGeometry(0.09, 0.022, 8, 24);
      this.ownedGeos.push(stationGeo);
      const station = new THREE.Mesh(stationGeo, this.stationMat);
      orbit = STATION_ORBIT;
      speed = 0.05;
      outlineScale = 0.12;
      lit = station;
    } else {
      const moon = new THREE.Mesh(this.propGeo, this.moonMat);
      const k = Math.min(index === 1 ? 0 : index - 1, MOON_SIZES.length - 1);
      moon.scale.setScalar(MOON_SIZES[k]!);
      orbit = MOON_ORBITS[k]!;
      speed = 0.014 - k * 0.002;
      outlineScale = MOON_SIZES[k]! * 1.35;
      lit = moon;
    }
    lit.visible = false;
    group.add(lit);
    group.visible = false;
    outline.scale.setScalar(outlineScale);
    return { group, lit, outline, orbit, phase: 0, speed };
  }

  /** Re-bake palette and feature layout from the destination seed. */
  setSeed(seed: string): void {
    if (seed === this.seed) return;
    this.seed = seed;
    const palette = planetPalette(seed);
    const rnd = seededRandom(`${seed}:system`);

    applySurfaceUniforms(this.planetMat.uniforms, palette, 'planet');
    applySurfaceUniforms(this.moonMat.uniforms, palette, 'moon');
    (this.ringMat.uniforms.uAccent!.value as THREE.Color).copy(palette.accent);
    this.ringMat.uniforms.uNoiseSeed!.value = rnd() * 10;

    // Solved shot geometry: the ring's plane sits RING_TILT off the camera's
    // line of sight, so it always reads as an ellipse with visible bands.
    const base = baseCameraPosition(ZERO, new THREE.Vector3());
    const view = this.center.clone().sub(base).normalize();
    const tiltAxis = new THREE.Vector3().crossVectors(view, UP).normalize();
    if (tiltAxis.lengthSq() < 1e-6) tiltAxis.set(1, 0, 0);
    // Negative tilt tips the ring's near side DOWN the screen, so it passes in
    // front of the disc's lower part with the far side hidden behind the planet.
    const ringNormal = view.clone().applyAxisAngle(tiltAxis, -RING_TILT_RAD);

    for (const feature of this.features) {
      feature.phase = rnd() * Math.PI * 2;
    }
    const ring = this.features[0]!;
    ring.group.quaternion.setFromUnitVectors(UP, ringNormal);
    ring.group.rotateY(rnd() * Math.PI * 2);
    for (let i = 1; i < this.features.length; i++) {
      const feature = this.features[i]!;
      feature.group.rotation.set(
        (rnd() - 0.5) * 2 * MAX_PLANE_TILT,
        rnd() * Math.PI * 2,
        (rnd() - 0.5) * 2 * MAX_PLANE_TILT,
      );
    }
  }

  /**
   * The anchor's light for every surface in the system. The anchor hangs
   * ANCHOR_DISTANCE out along `sunDir`, beyond the planet, so the system sees
   * it from a wider angle than the fleet does: a readable crescent rather than
   * a sliver, still one light from one place.
   */
  setLighting(lighting: Lighting): void {
    this.lightDir.copy(lighting.sunDir).multiplyScalar(ANCHOR_DISTANCE).sub(this.center).normalize();
    for (const mat of [this.planetMat, this.moonMat, this.stationMat, this.ringMat]) {
      (mat.uniforms.uKey!.value as THREE.Color).copy(lighting.key);
      (mat.uniforms.uSunDir!.value as THREE.Vector3).copy(this.lightDir);
      // A world's night side stays deep: it takes a third of the sky fill.
      (mat.uniforms.uFill!.value as THREE.Color).copy(lighting.fillSky).multiplyScalar(0.3);
    }
  }

  /** 0 hides the system under the hyperspace jump; it fades up from black. */
  setReveal(k: number): void {
    this.reveal = Math.min(1, Math.max(0, k));
    for (const mat of [this.planetMat, this.moonMat, this.stationMat, this.ringMat]) {
      mat.uniforms.uReveal!.value = this.reveal;
    }
    this.outlineMat.opacity = 0.28 * this.reveal;
  }

  /**
   * Frame the planet at the current progress and reveal its survey features.
   * `arrivalT` is 0..1 across the 6 s push-in and stays 1 during the orbit.
   */
  update(u: {
    progress: number;
    revealed: number;
    total: number;
    arrivalT: number;
    rung: number;
    dtS: number;
    camera: THREE.PerspectiveCamera;
    viewportH: number;
  }): void {
    this.elapsedS += u.dtS;
    const distance = Math.max(1, u.camera.position.distanceTo(this.center));
    const fovY = (u.camera.fov * Math.PI) / 180;
    const nearFraction =
      u.progress <= 0.8
        ? lerp(FRACTION_NEAR, FRACTION_MID, u.progress / 0.8)
        : lerp(FRACTION_MID, FRACTION_FAR, easeInCubic((u.progress - 0.8) / 0.2));
    const arrivalFraction = lerp(FRACTION_FAR, FRACTION_ARRIVAL, easeInCubic(u.arrivalT));
    const fraction = u.arrivalT > 0 ? Math.max(nearFraction, arrivalFraction) : nearFraction;

    this.worldRadius = radiusForFraction(distance, fraction, fovY);
    // The impostor draws at the exact disc size; the group scale only carries
    // the feature slots, which are authored in planet radii.
    this.group.scale.setScalar(this.worldRadius);
    (this.planetMat.uniforms.uCenter!.value as THREE.Vector3).copy(this.center);
    this.planetMat.uniforms.uRadius!.value = this.worldRadius;
    // While the planet is still a point its air shell keeps a few pixels and
    // glows harder, so it reads as a bright point that grows into a world.
    const radiusPx = fraction * u.viewportH;
    this.planetMat.uniforms.uHalo!.value = 1 + Math.max(ATMOSPHERE, ATMOSPHERE_MIN_PX / Math.max(radiusPx, 1));
    this.planetMat.uniforms.uAtmoGain!.value = ATMOSPHERE_GAIN * (1 + 3 * (1 - smoothstep(10, 90, radiusPx)));
    // Perspective terms for the impostor's depth write (near/far are fixed).
    const proj = u.camera.projectionMatrix.elements;
    this.planetMat.uniforms.uProjA!.value = proj[10]!;
    this.planetMat.uniforms.uProjB!.value = proj[14]!;

    const octaves = u.rung >= 4 ? 3 : 7;
    this.planetMat.uniforms.uOctaves!.value = octaves;
    this.planetMat.uniforms.uTime!.value = this.elapsedS;
    this.moonMat.uniforms.uTime!.value = this.elapsedS;
    this.moonMat.uniforms.uOctaves!.value = Math.min(octaves, 4);
    this.ringMat.uniforms.uPlanetR!.value = this.worldRadius;

    const revealFeatures = u.progress > FEATURE_REVEAL_PROGRESS || u.arrivalT > 0;
    const outlines = u.arrivalT > 0;
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i]!;
      const slotExists = i < u.total;
      f.group.visible = slotExists && revealFeatures;
      const lit = i < u.revealed;
      f.lit.visible = lit;
      f.outline.visible = !lit && outlines;
      // Orbits always advance, visible or not: a parked slot at the origin
      // would draw its outline across the planet's face.
      if (f.orbit > 0) {
        f.phase += u.dtS * f.speed;
        f.lit.position.set(Math.cos(f.phase) * f.orbit, 0, Math.sin(f.phase) * f.orbit);
        f.outline.position.copy(f.lit.position);
        f.lit.rotation.y += u.dtS * 0.08;
      }
    }
  }

  /** Current world-space radius of the planet disc. */
  radius(): number {
    return this.worldRadius;
  }

  /** A point just above the surface toward `dir` (used by the probe flash). */
  surfacePoint(dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(dir)
      .normalize()
      .multiplyScalar(this.worldRadius * 1.02)
      .add(this.center);
  }

  dispose(): void {
    this.planetGeo.dispose();
    this.planetMat.dispose();
    this.propGeo.dispose();
    this.moonMat.dispose();
    this.stationMat.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.outlineGeo.dispose();
    this.outlineMat.dispose();
    for (const geo of this.ownedGeos) geo.dispose();
    this.group.clear();
  }
}

/**
 * The banded ring (RING_FRAG) for a body at `center`: the destination's
 * equatorial ring and the ringed flyby giants share it. Set `uPlanetR` to the
 * body radius (the shadow cylinder), `uKey`/`uSunDir`/`uFill` from the light.
 */
export function makeRingMaterial(accent: THREE.Color, center: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uInner: { value: 1 },
      uOuter: { value: 1.44 },
      uKey: { value: new THREE.Color(0xffffff) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFill: { value: new THREE.Color() },
      uAccent: { value: accent.clone() },
      uCenter: { value: center.clone() },
      uPlanetR: { value: 1 },
      uNoiseSeed: { value: 0 },
      uReveal: { value: 1 },
    },
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Circle outline geometry shared by every unrevealed feature slot. */
function circleGeometry(radius: number, segments: number): THREE.BufferGeometry {
  const points = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points[i * 3] = Math.cos(a) * radius;
    points[i * 3 + 1] = Math.sin(a) * radius;
    points[i * 3 + 2] = 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(points, 3));
  return geo;
}

type SurfaceKind = 'planet' | 'moon';

function surfaceUniforms(palette: Palette, kind: SurfaceKind): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {
    uSea: { value: new THREE.Color() },
    uLand: { value: new THREE.Color() },
    uCloud: { value: new THREE.Color() },
    uAtmo: { value: new THREE.Color() },
    uKey: { value: new THREE.Color(0xffffff) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uFill: { value: new THREE.Color() },
    uSeedOffset: { value: new THREE.Vector3() },
    uOctaves: { value: 7 },
    uBandFreq: { value: 9 },
    uBandMix: { value: 0.25 },
    uLandLevel: { value: 0.52 },
    uCloudAmount: { value: 0.85 },
    uAtmoGain: { value: 1.1 },
    uTime: { value: 0 },
  };
  applySurfaceUniforms(uniforms, palette, kind);
  return uniforms;
}

/** Fill the body uniforms from the palette; `u` is a material's uniform map. */
function applySurfaceUniforms(u: Record<string, THREE.IUniform>, palette: Palette, kind: SurfaceKind): void {
  (u.uSea!.value as THREE.Color).copy(palette.sea);
  (u.uLand!.value as THREE.Color).copy(palette.land);
  (u.uCloud!.value as THREE.Color).copy(palette.cloud);
  (u.uAtmo!.value as THREE.Color).copy(palette.accent);
  (u.uSeedOffset!.value as THREE.Vector3).set(
    palette.family * 13.7,
    palette.family * 7.1 + 2.3,
    palette.family * 3.3 + 5.9,
  );
  if (kind === 'planet') {
    u.uBandFreq!.value = 9;
    u.uBandMix!.value = 0.25;
    u.uLandLevel!.value = 0.52;
    u.uCloudAmount!.value = 0.85;
    u.uAtmoGain!.value = ATMOSPHERE_GAIN;
  } else {
    u.uBandFreq!.value = 0;
    u.uBandMix!.value = 0;
    u.uLandLevel!.value = -1;
    u.uCloudAmount!.value = 0;
    u.uAtmoGain!.value = 0.2;
    (u.uLand!.value as THREE.Color).copy(palette.land).lerp(palette.cloud, 0.25);
  }
}

const ZERO = new THREE.Vector3();
