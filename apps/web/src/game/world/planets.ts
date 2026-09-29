import * as THREE from 'three';

import {
  CRUISE_DEST_SCREEN,
  GIANT_ANGULAR_RAD,
  GIANT_DISTANCE,
  GIANT_PITCH_REL_RAD,
  GIANT_YAW_REL_RAD,
  NOMINAL_FOV_Y_RAD,
  UP,
  axisPitch,
  axisYaw,
  baseCameraPosition,
  nominalFovX,
  PLANET_DIR,
  PLANET_DISTANCE,
} from './composition.js';
import { NOISE_GLSL } from './glsl.js';
import { easeInCubic, lerp, radians, radiusForFraction, seededRandom } from './math.js';
import { skyPalette } from './sky.js';
import type { SkyPalette } from './sky.js';
import { makeSphereMaterial } from './sphere.js';

/**
 * Destination system: the planet the voyage flies to, its survey features and
 * the decorative horizon giant. All of it is seeded — the palette comes from
 * the destination seed, so a system always looks like its own sky.
 *
 * The planet and the giant are analytic sphere impostors (see sphere.ts): their
 * limbs stay perfectly round at 4K and they write true hit depth, so the ring's
 * far side and the moons sort against them.
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
 * The body shading function shared by the impostors and the moon meshes:
 * `ocSurface(dirObj, N, V, worldPos)` returns linear colour.
 */
const SURFACE_SHADE_GLSL = /* glsl */ `
uniform vec3 uSea;
uniform vec3 uLand;
uniform vec3 uCloud;
uniform vec3 uAtmo;
uniform vec3 uKey;
uniform vec3 uSunDir;
uniform vec3 uSeedOffset;
uniform float uOctaves;
uniform float uBandFreq;
uniform float uBandMix;
uniform float uLandLevel;
uniform float uCloudAmount;
uniform float uAtmoGain;
uniform float uNightFloor;
uniform float uTime;
${NOISE_GLSL}

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

  float ndl = dot(N, uSunDir);
  // Wide, soft terminator: the destination stays a readable world.
  float lit = smoothstep(-0.30, 0.30, ndl);

  vec3 col = surface * uKey * (uNightFloor + (1.0 - uNightFloor) * lit);
  vec3 h = normalize(uSunDir + V);
  col += uKey * pow(max(dot(N, h), 0.0), 28.0) * 0.05 * (1.0 - landMask) * lit;
  // Atmosphere: a thin fresnel rim on the LIT limb only.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col += uAtmo * fres * uAtmoGain * lit;
  return col;
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
${SURFACE_SHADE_GLSL}
varying vec3 vObj;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  gl_FragColor = vec4(ocSurface(normalize(vObj), N, V, vWorldPos), 1.0);
}`;

const RING_VERT = /* glsl */ `
varying vec2 vLocal;
varying vec3 vWorldPos;
void main() {
  vLocal = position.xy;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/**
 * Thin banded annulus: seeded gaps, palette tint, sun-lit with the planet's
 * shadow carved out behind it (a self-shadow term, no shadow map needed).
 */
const RING_FRAG = /* glsl */ `
uniform float uInner;
uniform float uOuter;
uniform vec3 uKey;
uniform vec3 uSunDir;
uniform vec3 uAccent;
uniform vec3 uCenter;
uniform float uPlanetR;
uniform float uNoiseSeed;
${NOISE_GLSL}
varying vec2 vLocal;
varying vec3 vWorldPos;

void main() {
  float r = length(vLocal);
  float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);
  // Two seeded bands so the annulus reads as ring structure, not a flat disc.
  float gap = ocNoise(vec3(t * 5.0, uNoiseSeed, 0.0));
  float bands = smoothstep(0.38, 0.46, gap) * (1.0 - smoothstep(0.54, 0.62, gap));
  float band2 = smoothstep(0.72, 0.78, ocNoise(vec3(t * 11.0 + 3.1, uNoiseSeed * 1.7, 0.0)));
  float edge = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.86, 1.0, t));
  float bandMix = max(bands, band2 * 0.7);
  float alpha = edge * (0.35 + 0.4 * bandMix);

  // Planet shadow: an infinite cylinder along the sun direction through the
  // planet. Behind the planet (along < 0) AND inside its radius (perp < R).
  // Nothing else darkens: the rest of the ring is lit uniformly by the key.
  vec3 rel = vWorldPos - uCenter;
  float along = dot(rel, uSunDir);
  float perp = length(rel - uSunDir * along);
  float inCylinder = 1.0 - smoothstep(uPlanetR * 0.98, uPlanetR * 1.04, perp);
  float behind = 1.0 - smoothstep(-uPlanetR * 0.35, 0.0, along);
  float shadow = 1.0 - 0.85 * inCylinder * behind;

  vec3 col = mix(uAccent, uKey, 0.35) * shadow;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}`;

/** Simple one-light shading for moons, the station and horizon-scale props. */
const PROP_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uKey;
uniform vec3 uSunDir;
uniform float uRim;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float lit = smoothstep(-0.15, 0.35, dot(N, uSunDir));
  vec3 col = uColor * uKey * (0.08 + 0.92 * lit);
  col += uColor * pow(1.0 - max(dot(N, V), 0.0), 3.5) * uRim;
  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * The destination planet, one feature slot per survey (ring, moon, station,
 * more moons) and the horizon giant.
 */
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
  private readonly giant: THREE.Mesh;
  private readonly giantGeo: THREE.PlaneGeometry;
  private readonly giantMat: THREE.ShaderMaterial;
  private readonly giantCenter = new THREE.Vector3();
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private seed = '';
  private worldRadius = 0;
  private elapsedS = 0;

  constructor() {
    const palette = skyPalette('idle');

    this.planetGeo = new THREE.PlaneGeometry(2, 2);
    this.planetMat = makeSphereMaterial(SURFACE_SHADE_GLSL, surfaceUniforms(palette, 'planet'));
    const planet = new THREE.Mesh(this.planetGeo, this.planetMat);
    planet.frustumCulled = false;
    planet.renderOrder = 1;
    this.group.position.copy(this.center);
    this.group.add(planet);

    this.propGeo = new THREE.IcosahedronGeometry(1, 2);
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: surfaceUniforms(palette, 'moon'),
      vertexShader: MESH_VERT,
      fragmentShader: MESH_FRAG,
    });
    this.stationMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xc9d3e2) },
        uKey: { value: new THREE.Color(0xffffff) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uRim: { value: 0.35 },
      },
      vertexShader: MESH_VERT,
      fragmentShader: PROP_FRAG,
    });

    // Equatorial ring: thin annulus at 1.25-1.85 planet radii.
    this.ringGeo = new THREE.RingGeometry(1, 1.44, 128, 1);
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: {
        uInner: { value: 1 },
        uOuter: { value: 1.44 },
        uKey: { value: new THREE.Color(0xffffff) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uAccent: { value: palette.accent.clone() },
        uCenter: { value: this.center.clone() },
        uPlanetR: { value: 1 },
        uNoiseSeed: { value: 0 },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.outlineGeo = circleGeometry(1, 72);
    this.outlineMat = new THREE.LineBasicMaterial({ color: 0x7f8ea6, transparent: true, opacity: 0.28 });

    for (let i = 0; i < SLOT_COUNT; i++) this.features.push(this.makeFeature(i));

    this.giantMat = makeSphereMaterial(SURFACE_SHADE_GLSL, surfaceUniforms(palette, 'giant'));
    this.giantGeo = new THREE.PlaneGeometry(2, 2);
    this.giant = new THREE.Mesh(this.giantGeo, this.giantMat);
    this.giant.frustumCulled = false;
    this.group.add(...this.features.map((f) => f.group));
    // The giant hangs in the scene root (world-positioned, unscaled by the
    // destination's radius); GameWorld adds `horizonGiant` to the scene.
    this.setSeed('idle');
  }

  /** Horizon giant mesh; GameWorld adds it to the scene at world scale. */
  get horizonGiant(): THREE.Mesh {
    return this.giant;
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

  /** Re-bake palette, feature layout and the giant from the destination seed. */
  setSeed(seed: string): void {
    if (seed === this.seed) return;
    this.seed = seed;
    const palette = skyPalette(seed);
    const rnd = seededRandom(`${seed}:system`);

    applySurfaceUniforms(this.planetMat.uniforms, palette, 'planet');
    applySurfaceUniforms(this.moonMat.uniforms, palette, 'moon');
    applySurfaceUniforms(this.giantMat.uniforms, palette, 'giant');
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

    // Decorative horizon giant: solved from the shot so its upper-left limb
    // crosses the lower-right corner (58%,100%) -> (100%,52%), with a small
    // seeded jitter. Its face stays dark; the sun-facing limb carries the arc.
    const toPlanet = this.center.clone().sub(base);
    const planetYaw = Math.atan2(toPlanet.x, -toPlanet.z);
    const planetPitch = Math.atan2(toPlanet.y, Math.hypot(toPlanet.x, toPlanet.z));
    const fovX = nominalFovX();
    const yaw =
      axisYaw(planetYaw, fovX, CRUISE_DEST_SCREEN.x) + GIANT_YAW_REL_RAD + (rnd() - 0.5) * 0.04;
    const pitch =
      axisPitch(planetPitch, NOMINAL_FOV_Y_RAD, CRUISE_DEST_SCREEN.y) +
      GIANT_PITCH_REL_RAD +
      (rnd() - 0.5) * 0.03;
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );
    this.giantCenter.copy(base).addScaledVector(dir, GIANT_DISTANCE);
    (this.giantMat.uniforms.uCenter!.value as THREE.Vector3).copy(this.giantCenter);
    this.giantMat.uniforms.uRadius!.value = Math.sin(GIANT_ANGULAR_RAD) * GIANT_DISTANCE;
    this.giant.renderOrder = 0;
  }

  /** Key light + sun direction for every surface in the system. */
  setLighting(lighting: { sunDir: THREE.Vector3; key: THREE.Color }): void {
    for (const mat of [this.planetMat, this.moonMat, this.giantMat, this.stationMat]) {
      (mat.uniforms.uKey!.value as THREE.Color).copy(lighting.key);
      (mat.uniforms.uSunDir!.value as THREE.Vector3).copy(lighting.sunDir);
    }
    (this.ringMat.uniforms.uKey!.value as THREE.Color).copy(lighting.key);
    (this.ringMat.uniforms.uSunDir!.value as THREE.Vector3).copy(lighting.sunDir);
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
    // Perspective terms for the impostor's depth write (near/far are fixed).
    const proj = u.camera.projectionMatrix.elements;
    for (const mat of [this.planetMat, this.giantMat]) {
      mat.uniforms.uProjA!.value = proj[10]!;
      mat.uniforms.uProjB!.value = proj[14]!;
    }

    const octaves = u.rung >= 4 ? 3 : 7;
    this.planetMat.uniforms.uOctaves!.value = octaves;
    this.planetMat.uniforms.uTime!.value = this.elapsedS;
    this.moonMat.uniforms.uTime!.value = this.elapsedS;
    this.moonMat.uniforms.uOctaves!.value = Math.min(octaves, 4);
    this.giantMat.uniforms.uOctaves!.value = Math.min(octaves, 5);
    this.giantMat.uniforms.uTime!.value = this.elapsedS;
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
    this.giantGeo.dispose();
    this.giantMat.dispose();
    for (const geo of this.ownedGeos) geo.dispose();
    this.group.clear();
  }
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

type SurfaceKind = 'planet' | 'moon' | 'giant';

function surfaceUniforms(palette: SkyPalette, kind: SurfaceKind): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {
    uSea: { value: new THREE.Color() },
    uLand: { value: new THREE.Color() },
    uCloud: { value: new THREE.Color() },
    uAtmo: { value: new THREE.Color() },
    uKey: { value: new THREE.Color(0xffffff) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSeedOffset: { value: new THREE.Vector3() },
    uOctaves: { value: 7 },
    uBandFreq: { value: 9 },
    uBandMix: { value: 0.25 },
    uLandLevel: { value: 0.52 },
    uCloudAmount: { value: 0.85 },
    uAtmoGain: { value: 1.1 },
    uNightFloor: { value: 0.1 },
    uTime: { value: 0 },
  };
  applySurfaceUniforms(uniforms, palette, kind);
  return uniforms;
}

/** Fill the body uniforms from the palette; `u` is a material's uniform map. */
function applySurfaceUniforms(u: Record<string, THREE.IUniform>, palette: SkyPalette, kind: SurfaceKind): void {
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
    u.uAtmoGain!.value = 1.1;
    u.uNightFloor!.value = 0.1;
  } else if (kind === 'moon') {
    u.uBandFreq!.value = 0;
    u.uBandMix!.value = 0;
    u.uLandLevel!.value = -1;
    u.uCloudAmount!.value = 0;
    u.uAtmoGain!.value = 0.25;
    u.uNightFloor!.value = 0.06;
    (u.uLand!.value as THREE.Color).copy(palette.land).lerp(palette.cloud, 0.25);
  } else {
    // Gas giant: heavy banding, a dark face and a bright limb arc.
    u.uBandFreq!.value = 26;
    u.uBandMix!.value = 0.85;
    u.uLandLevel!.value = 1;
    u.uCloudAmount!.value = 0.25;
    u.uAtmoGain!.value = 2.2;
    u.uNightFloor!.value = 0.05;
  }
}

const ZERO = new THREE.Vector3();
