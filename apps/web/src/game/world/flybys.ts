import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { METAL_FRAG } from './belts.js';
import { KEEP_OUT, TRAVEL_DIR, UP, chaseDirection } from './composition.js';
import { REVEAL_CALM_S } from './flow.js';
import { NOISE_GLSL } from './glsl.js';
import { clamp01, damp, lerp, seededRandom, smoothstep } from './math.js';
import { makeRingMaterial } from './planets.js';
import type { Lighting } from './sky.js';
import { makeSphereMaterial } from './sphere.js';

/**
 * Passing bodies: the system around the voyage. Every body is world-anchored
 * a few hundred to a few thousand units off the travel line and drifts past at
 * the travel speed, so it emerges small near the vanishing point (behind the
 * destination, which occludes it by depth), grows and slides out of frame over
 * a couple of minutes: real parallax against the rocks.
 *
 * Two lanes are solved in the chase shot so a body never crosses the anchor
 * core, the destination or a HUD keep-out: one exits the right edge below the
 * anchor (moons, an ice moon, now and then a station), one sinks behind the
 * fleet and out the bottom (gas giants, sometimes ringed, or a big moon). Each
 * lane re-seeds its body every cycle from the destination seed. Once per ride
 * a big moon's limb slides past just below the fleet.
 *
 * Bodies are sphere impostors (one draw each, exact limbs), lit by the anchor.
 * A per-frame guard fades a body out while it would overlap a keep-out, the
 * anchor core or the destination (the side and wide shots move the frame).
 */
type Kind = 'giant' | 'ringed' | 'rocky' | 'ice' | 'station' | 'none';

interface Lane {
  /** Chase-frame screen point where the lane leaves the frame. */
  exit: { x: number; y: number };
  /** Travel per cycle (u) and phase offset, so the lanes interleave. */
  period: number;
  phase: number;
  /** Body menu: cumulative weights over kinds. */
  menu: ReadonlyArray<readonly [Kind, number]>;
  /** Angular radius (rad) a body has as it leaves the frame. */
  exitRadius: number;
}

const LANES: readonly Lane[] = [
  {
    exit: { x: 1.04, y: 0.51 },
    period: 11000,
    phase: 2600,
    menu: [
      ['rocky', 0.4],
      ['ice', 0.72],
      ['station', 0.88],
      ['none', 1],
    ],
    exitRadius: 0.045,
  },
  {
    exit: { x: 0.57, y: 1.06 },
    period: 13500,
    phase: 9000,
    menu: [
      ['giant', 0.45],
      ['ringed', 0.7],
      ['rocky', 0.85],
      ['none', 1],
    ],
    exitRadius: 0.22,
  },
];

/** A body appears this far off the travel line (rad), small and near the vanishing point. */
const START_ANGLE = 0.1;
/** Closest-approach distance range (u): sets how long a pass takes. */
const D_MIN = 450;
const D_MAX = 820;
/** Guard fade time constant (s). */
const GUARD_TAU_S = 0.8;
/** Bodies take their light from a point this far out along the anchor, not from infinity. */
const ANCHOR_REACH = 4500;

/** Limb pass: moon radius, the parabola its top follows below the fleet, travel span. */
const LIMB_R = 3200;
const LIMB_H_MIN = 120;
const LIMB_K = 1.9e-4;
const LIMB_AHEAD = 3800;
const LIMB_BEHIND = 1800;

const GIANT_PALETTES: ReadonlyArray<readonly [number, number, number, number]> = [
  // band light, band dark, storm/accent, air
  [0xcdb28a, 0x8a6441, 0xb8573a, 0xe6c79a],
  [0x7fa3d6, 0x3f5f9c, 0xd7e6f5, 0x8fb8ff],
  [0x8fbfb0, 0x4a7a72, 0xdfe9d8, 0x9fe0d0],
  [0xb7a0bd, 0x6d5577, 0xe8d6e0, 0xd4b8e8],
];

/**
 * Body shading for the impostor: banded gas giants, cratered rocky moons and
 * cracked ice moons, relief-lit by the anchor with a soft terminator; gas
 * giants and ice carry a forward-scattering air rim.
 */
const BODY_GLSL = /* glsl */ `
uniform float uKind;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uAir;
uniform vec3 uKey;
uniform vec3 uSunDir;
uniform vec3 uFill;
uniform mat3 uRot;
uniform vec3 uSeedOff;
uniform float uDetail;
uniform float uBands;
uniform float uAtmo;
${NOISE_GLSL}

// Bowl craters with raised rims, one per lattice cell per octave, and their
// gradient (object space) for the relief.
float ocCraters(vec3 p, float octaves, out vec3 grad) {
  float h = 0.0;
  grad = vec3(0.0);
  float f = 3.0;
  float amp = 1.0;
  for (int i = 0; i < 7; i++) {
    if (float(i) >= octaves) break;
    vec3 q = p * f + uSeedOff * (1.0 + float(i) * 0.37);
    vec3 cell = floor(q);
    vec3 c = cell + 0.3 + 0.4 * vec3(ocHash(cell), ocHash(cell + 17.1), ocHash(cell + 31.7));
    float r = 0.16 + 0.2 * ocHash(cell + 5.3);
    vec3 dv = q - c;
    float len = max(length(dv), 1e-4);
    float d = len / r;
    if (ocHash(cell + 11.0) < 0.6 && d < 1.8) {
      float rim = 0.35 * exp(-pow((d - 1.0) / 0.3, 2.0));
      float bowl = d < 1.0 ? d * d - 1.0 : 0.0;
      h += amp * (0.6 * bowl + rim);
      float slope = (d < 1.0 ? 1.2 * d : 0.0) + rim * (-2.0 * (d - 1.0) / 0.09);
      grad += amp * slope * dv / (len * r) * f;
    }
    f *= 2.3;
    amp *= 0.42;
  }
  return h;
}

vec3 ocAir(vec3 N, vec3 V) {
  float c = max(dot(-uSunDir, V), 0.0);
  float forward = 0.08 + 0.9 * pow(c, 5.0) + 1.2 * pow(c, 40.0);
  return uAir * uKey * smoothstep(-0.3, 0.2, dot(N, uSunDir)) * forward;
}

vec3 ocSurface(vec3 dirObj, vec3 N, vec3 V, vec3 worldPos) {
  vec3 p = uRot * N;
  vec3 n = p;
  vec3 albedo;
  float spec = 0.0;
  vec3 g;
  if (uKind < 0.5) {
    float warp = ocFbm(p * 2.2 + uSeedOff, 4.0) - 0.5;
    float lat = p.y + warp * 0.16;
    float band = sin(lat * uBands + (ocFbm(vec3(p.x * 1.5, lat * 11.0, p.z * 1.5) + uSeedOff, 3.0) - 0.5) * 3.0);
    float fine = ocFbm(vec3(p.x * 3.0, lat * 55.0, p.z * 3.0) + uSeedOff, 3.0);
    albedo = mix(uColB, uColA, smoothstep(-0.7, 0.7, band)) * (0.85 + 0.3 * fine);
    vec3 storm = (p - normalize(vec3(0.55, -0.28, 0.79))) * vec3(1.0, 2.4, 1.0);
    albedo = mix(albedo, uColC, smoothstep(0.17, 0.06, length(storm)) * 0.85);
    albedo *= 0.62 + 0.38 * sqrt(max(dot(N, V), 0.0));
  } else if (uKind < 1.5) {
    float h = ocCraters(p, uDetail, g);
    float maria = smoothstep(0.42, 0.6, ocFbm(p * 1.4 + uSeedOff, 4.0));
    albedo = mix(uColA, uColB, maria) * (0.8 + 0.4 * ocFbm(p * 9.0 + uSeedOff, 3.0)) * (1.0 + 0.3 * h);
    n = normalize(p - 0.05 * (g - p * dot(g, p)));
  } else {
    float h = ocCraters(p, max(uDetail - 2.0, 1.0), g);
    float crack = 1.0 - smoothstep(0.0, 0.03, abs(ocFbm(p * 2.6 + uSeedOff, 4.0) - 0.5));
    albedo = mix(uColA, uColB, crack * 0.75) * (0.9 + 0.2 * ocFbm(p * 7.0 + uSeedOff, 2.0)) * (1.0 + 0.15 * h);
    n = normalize(p - 0.015 * (g - p * dot(g, p)));
    spec = 0.25;
  }
  vec3 Nw = transpose(uRot) * n;
  float ndl = dot(Nw, uSunDir);
  float lit = smoothstep(-0.03, 0.12, dot(N, uSunDir)) * max(ndl, 0.0);
  vec3 col = albedo * (uKey * lit + uFill);
  col += uKey * spec * pow(max(dot(Nw, normalize(uSunDir + V)), 0.0), 30.0) * step(0.0, ndl);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += ocAir(N, V) * fres * uAtmo;
  // Backlit dust on the limb, so an airless body's night side still reads as a disc.
  col += uKey * albedo * max(dot(-V, uSunDir), 0.0) * fres * (0.3 + 0.7 * smoothstep(-0.4, 0.3, dot(N, uSunDir))) * 0.9;
  return col;
}

vec3 ocAtmosphere(vec3 N, vec3 V, float h) {
  return ocAir(N, V) * uAtmo * exp(-h * 4.0) * (1.0 - h) * 0.8;
}`;

const STATION_VERT = /* glsl */ `
attribute float aGlow;
varying vec3 vN;
varying vec3 vW;
varying vec3 vObj;
varying vec4 vTint;
varying float vGlow;
void main() {
  vObj = position * 2.0;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vTint = vec4(0.0);
  vGlow = aGlow;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

interface Body {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  kind: Kind;
  cycle: number;
  /** Lateral unit direction (world) and closest-approach distance. */
  dir: THREE.Vector3;
  d: number;
  r: number;
  /** Along-travel coordinate where the body appears. */
  start: number;
  /** Guard visibility, 0..1. */
  vis: number;
  center: THREE.Vector3;
}

export class Flybys {
  readonly group = new THREE.Group();
  private readonly quad = new THREE.PlaneGeometry(2, 2);
  private readonly bodies: Body[] = [];
  private readonly limb: Body;
  private readonly ringGeo = new THREE.RingGeometry(1, 1.44, 128, 1);
  private readonly ringMat = makeRingMaterial(new THREE.Color(0xd8c4a0), new THREE.Vector3());
  private readonly ring: THREE.Mesh;
  private readonly stationGeo: THREE.BufferGeometry;
  private readonly stationMat: THREE.ShaderMaterial;
  private readonly station: THREE.Mesh;
  private readonly laneDirs: THREE.Vector3[] = [];
  private readonly laneExit: number[] = [];
  private readonly lightUniforms: Record<string, THREE.IUniform> = {
    uKey: { value: new THREE.Color() },
    uFill: { value: new THREE.Color() },
  };
  private readonly anchorDir = new THREE.Vector3(0, 0, -1);
  private anchorCore = 0.07;
  private seed = '';
  private reveal = 1;
  private elapsedS = 0;
  /** Bodies stay out until this time (s): the first seconds after the reveal belong to the system. */
  private calmUntilS = REVEAL_CALM_S;
  /** Travel at which this ride's limb pass began (null before it). */
  private limbStart: number | null = null;
  private limbAt = 0.45;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly light = new THREE.Vector3();

  constructor() {
    // Lane directions: the lateral heading that carries a body from the
    // vanishing point out through the lane's exit in the chase frame.
    for (const lane of LANES) {
      const exit = chaseDirection(lane.exit.x, lane.exit.y, new THREE.Vector3());
      this.laneExit.push(exit.angleTo(TRAVEL_DIR));
      this.laneDirs.push(exit.addScaledVector(TRAVEL_DIR, -exit.dot(TRAVEL_DIR)).normalize());
    }
    for (let i = 0; i < LANES.length; i++) this.bodies.push(this.makeBody(0));
    this.limb = this.makeBody(-1);

    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ringMat.uniforms.uKey = this.lightUniforms.uKey!;
    this.ringMat.uniforms.uFill = this.lightUniforms.uFill!;

    this.stationGeo = stationGeometry();
    this.stationMat = new THREE.ShaderMaterial({
      uniforms: {
        uKeyColor: this.lightUniforms.uKey!,
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uAmbient: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
        uRimColor: { value: new THREE.Color() },
        uBack: { value: 0.5 },
        uFlowTime: { value: 0 },
      },
      defines: { GLOW: '' },
      vertexShader: STATION_VERT,
      fragmentShader: METAL_FRAG,
    });
    this.station = new THREE.Mesh(this.stationGeo, this.stationMat);
    this.station.frustumCulled = false;
    this.station.visible = false;
    this.group.add(this.ring, this.station);
  }

  private makeBody(order: number): Body {
    const mat = makeSphereMaterial(BODY_GLSL, {
      ...this.lightUniforms,
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uKind: { value: 0 },
      uColA: { value: new THREE.Color() },
      uColB: { value: new THREE.Color() },
      uColC: { value: new THREE.Color() },
      uAir: { value: new THREE.Color() },
      uRot: { value: new THREE.Matrix3() },
      uSeedOff: { value: new THREE.Vector3() },
      uDetail: { value: 4 },
      uBands: { value: 14 },
      uAtmo: { value: 0 },
    });
    const mesh = new THREE.Mesh(this.quad, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    // Before the destination (renderOrder 1): it occludes bodies behind it by
    // depth and its additive air halo lands on top of them.
    mesh.renderOrder = order;
    this.group.add(mesh);
    return { mesh, mat, kind: 'none', cycle: -1, dir: new THREE.Vector3(), d: 1, r: 1, start: 0, vis: 0, center: new THREE.Vector3() };
  }

  setSeed(seed: string): void {
    if (seed === this.seed) return;
    this.seed = seed;
    for (const body of this.bodies) body.cycle = -1;
    this.limbStart = null;
    this.calmUntilS = this.elapsedS + REVEAL_CALM_S;
    this.limbAt = lerp(0.3, 0.6, seededRandom(`${seed}:limb`)());
    this.dress(this.limb, seededRandom(`${seed}:limb:body`), seededRandom(`${seed}:limb:kind`)() < 0.7 ? 'rocky' : 'ice', LIMB_R);
    this.limb.mat.uniforms.uDetail!.value = 6;
  }

  /**
   * The anchor's key (shared by reference) and sky fill. Each body takes its
   * own light direction from a point ANCHOR_REACH out along the anchor, so it
   * turns from a fat crescent into a thin one as it passes.
   */
  setLighting(lighting: Lighting, anchorCore: number): void {
    this.lightUniforms.uKey!.value = lighting.key;
    (this.lightUniforms.uFill!.value as THREE.Color).copy(lighting.fillSky).multiplyScalar(0.6);
    this.stationMat.uniforms.uAmbient!.value = lighting.ambient;
    this.stationMat.uniforms.uRimColor!.value = lighting.rim;
    this.anchorDir.copy(lighting.sunDir);
    this.anchorCore = anchorCore;
  }

  /** 0 hides every body under the hyperspace jump; they return REVEAL_CALM_S after the reveal. */
  setReveal(k: number): void {
    this.reveal = clamp01(k);
    if (this.reveal < 1) this.calmUntilS = this.elapsedS + REVEAL_CALM_S;
  }

  /**
   * Place every body for this frame's travel and camera; `progress` starts
   * the limb pass once, `arrivalT` fades everything out as the destination
   * takes over, `destination` (null without one) is kept clear.
   */
  update(
    travel: number,
    dtS: number,
    camera: THREE.PerspectiveCamera,
    progress: number,
    arrivalT: number,
    rung: number,
    destination: THREE.Vector3 | null,
    destinationRadius: number,
  ): void {
    this.elapsedS += dtS;
    this.stationMat.uniforms.uFlowTime!.value = this.elapsedS;
    const proj = camera.projectionMatrix.elements;
    const calm = smoothstep(this.calmUntilS, this.calmUntilS + 1.5, this.elapsedS);
    const quiet = (1 - smoothstep(0, 0.3, arrivalT)) * this.reveal * calm;
    const octaves = rung >= 4 ? 2 : 4;
    this.ring.visible = false;
    this.station.visible = false;

    if (this.limbStart === null && calm >= 1 && arrivalT === 0 && progress >= this.limbAt && progress < 0.95) this.limbStart = travel;
    const limbA = this.limbStart === null ? Infinity : LIMB_AHEAD - (travel - this.limbStart);
    const limbOn = limbA > -LIMB_BEHIND && limbA < LIMB_AHEAD;

    for (let i = 0; i < LANES.length; i++) {
      const lane = LANES[i]!;
      const body = this.bodies[i]!;
      const t = travel + lane.phase;
      const cycle = Math.floor(t / lane.period);
      if (cycle !== body.cycle) this.seedLane(body, i, cycle);
      const along = body.start - (t - cycle * lane.period);
      body.center.copy(body.dir).multiplyScalar(body.d).addScaledVector(TRAVEL_DIR, along);
      // Fade in as it appears, and hold the down lane while the limb passes.
      const appear = smoothstep(0, 900, body.start - along);
      const clear = i === 1 && limbOn ? 0 : 1;
      this.place(body, camera, dtS, appear * clear * quiet, destination, destinationRadius, proj, octaves);
    }

    if (limbOn) {
      const h = LIMB_H_MIN + LIMB_K * limbA * limbA;
      this.limb.center.copy(UP).multiplyScalar(-(LIMB_R + h)).addScaledVector(TRAVEL_DIR, limbA);
      const appear = smoothstep(LIMB_AHEAD, LIMB_AHEAD - 700, limbA);
      this.place(this.limb, camera, dtS, appear * quiet, null, 0, proj, octaves + 2);
    } else {
      this.limb.mesh.visible = false;
    }
  }

  /** Re-seed a lane's body for a new cycle: kind, size, palette, heading. */
  private seedLane(body: Body, lane: number, cycle: number): void {
    const rnd = seededRandom(`${this.seed}:flyby:${lane}:${cycle}`);
    const menu = LANES[lane]!.menu;
    const roll = rnd();
    const kind = menu.find(([, w]) => roll < w)?.[0] ?? 'none';
    body.cycle = cycle;
    body.d = lerp(D_MIN, D_MAX, rnd());
    // Jitter the heading a little around the lane (never toward the anchor).
    body.dir.copy(this.laneDirs[lane]!).applyAxisAngle(TRAVEL_DIR, (rnd() - 0.5) * 0.18);
    body.start = body.d / Math.tan(START_ANGLE);
    const exit = this.laneExit[lane]!;
    // Radius from the angular size it should have leaving the frame.
    const exitDist = body.d / Math.sin(exit);
    const r = exitDist * Math.sin(LANES[lane]!.exitRadius) * lerp(0.7, 1.1, rnd());
    this.dress(body, rnd, kind, kind === 'station' ? r * 0.8 : r);
  }

  /** Surface parameters for a body of `kind` and radius `r`. */
  private dress(body: Body, rnd: () => number, kind: Kind, r: number): void {
    body.kind = kind;
    body.r = r;
    const u = body.mat.uniforms;
    (u.uSeedOff!.value as THREE.Vector3).set(rnd() * 40, rnd() * 40, rnd() * 40);
    // Tilted spin axis for the body frame.
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.9, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.6));
    (u.uRot!.value as THREE.Matrix3).setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q).invert());
    u.uDetail!.value = 4;
    if (kind === 'giant' || kind === 'ringed') {
      const pal = GIANT_PALETTES[Math.floor(rnd() * GIANT_PALETTES.length)]!;
      (u.uColA!.value as THREE.Color).setHex(pal[0]).multiplyScalar(0.6);
      (u.uColB!.value as THREE.Color).setHex(pal[1]).multiplyScalar(0.6);
      (u.uColC!.value as THREE.Color).setHex(pal[2]).multiplyScalar(0.6);
      (u.uAir!.value as THREE.Color).setHex(pal[3]);
      u.uKind!.value = 0;
      u.uBands!.value = lerp(10, 22, rnd());
      u.uAtmo!.value = 0.9;
      u.uHalo!.value = 1.035;
      (this.ringMat.uniforms.uAccent!.value as THREE.Color).setHex(pal[2]);
      this.ringMat.uniforms.uNoiseSeed!.value = rnd() * 10;
    } else if (kind === 'ice') {
      (u.uColA!.value as THREE.Color).setRGB(0.55, 0.62, 0.68);
      (u.uColB!.value as THREE.Color).setRGB(0.32, 0.22, 0.18);
      (u.uAir!.value as THREE.Color).setRGB(0.6, 0.8, 1);
      u.uKind!.value = 2;
      u.uAtmo!.value = 0.25;
      u.uHalo!.value = 1.012;
    } else {
      const warm = rnd();
      (u.uColA!.value as THREE.Color).setRGB(0.21 + 0.04 * warm, 0.2, 0.18 - 0.03 * warm);
      (u.uColB!.value as THREE.Color).setRGB(0.085, 0.08, 0.075);
      u.uKind!.value = 1;
      u.uAtmo!.value = 0;
      u.uHalo!.value = 1;
    }
  }

  /**
   * Position a body for the camera, run the guard (keep-outs, anchor core,
   * destination) and draw it: impostor, ring or station.
   */
  private place(
    body: Body,
    camera: THREE.PerspectiveCamera,
    dtS: number,
    fade: number,
    destination: THREE.Vector3 | null,
    destinationRadius: number,
    proj: number[],
    octaves: number,
  ): void {
    const ringed = body.kind === 'ringed';
    const reach = body.r * (ringed ? 1.8 : 1);
    const dist = Math.max(1, camera.position.distanceTo(body.center));
    const rho = Math.asin(Math.min(1, reach / dist));
    // The limb pass is meant to sit under the cards: only the others are guarded.
    const clear = body === this.limb || this.clearOf(body.center, rho, camera, destination, destinationRadius);
    const target = body.kind === 'none' || fade <= 0 || !clear ? 0 : 1;
    body.vis = damp(body.vis, target, GUARD_TAU_S, dtS);
    const show = body.vis * fade;
    const behind = this.tmp.copy(body.center).sub(camera.position).dot(camera.getWorldDirection(this.tmp2)) < -reach;
    if (show < 0.004 || behind) {
      body.mesh.visible = false;
      return;
    }

    // Light from a point far out along the anchor (see setLighting); the limb
    // moon is so close that the true, grazing direction carves its craters.
    const light =
      body === this.limb ? this.light.copy(this.anchorDir) : this.light.copy(this.anchorDir).multiplyScalar(ANCHOR_REACH).sub(body.center).normalize();
    if (body.kind === 'station') {
      body.mesh.visible = false;
      this.station.visible = true;
      this.station.position.copy(body.center);
      this.station.scale.setScalar(body.r * show);
      this.quat.setFromUnitVectors(UP, this.tmp2.copy(body.dir).negate());
      this.station.quaternion.setFromAxisAngle(this.tmp.set(0.3, 1, 0.2).normalize(), this.elapsedS * 0.05).premultiply(this.quat);
      (this.stationMat.uniforms.uSunDir!.value as THREE.Vector3).copy(light);
      return;
    }

    body.mesh.visible = true;
    const u = body.mat.uniforms;
    (u.uSunDir!.value as THREE.Vector3).copy(light);
    (u.uCenter!.value as THREE.Vector3).copy(body.center);
    u.uRadius!.value = body.r;
    u.uReveal!.value = show;
    u.uProjA!.value = proj[10]!;
    u.uProjB!.value = proj[14]!;
    u.uDetail!.value = Math.min(body === this.limb ? 6 : 4, octaves);

    if (ringed) {
      this.ring.visible = true;
      this.ring.position.copy(body.center);
      this.ring.scale.setScalar(body.r * 1.25);
      // A ring opened ~25 deg to the travel line reads as a Saturn ellipse.
      this.ring.quaternion.setFromUnitVectors(this.tmp.set(0, 0, 1), this.tmp2.copy(UP).multiplyScalar(0.9).addScaledVector(TRAVEL_DIR, -0.42).normalize());
      const ru = this.ringMat.uniforms;
      (ru.uCenter!.value as THREE.Vector3).copy(body.center);
      ru.uPlanetR!.value = body.r;
      ru.uReveal!.value = show;
      (ru.uSunDir!.value as THREE.Vector3).copy(light);
    }
  }

  /** True when the body's disc (angular radius `rho`) is clear of every protected zone. */
  private clearOf(
    center: THREE.Vector3,
    rho: number,
    camera: THREE.PerspectiveCamera,
    destination: THREE.Vector3 | null,
    destinationRadius: number,
  ): boolean {
    const dir = this.tmp.copy(center).sub(camera.position).normalize();
    if (dir.angleTo(this.anchorDir) < rho + this.anchorCore * 1.3) return false;
    if (destination !== null) {
      // The disc plus 0.05 of the frame height, in front of it or behind.
      const dd = camera.position.distanceTo(destination);
      const toD = this.tmp2.copy(destination).sub(camera.position).normalize();
      const margin = 0.1 * Math.tan((camera.fov * Math.PI) / 360);
      if (dir.angleTo(toD) < rho + Math.asin(Math.min(1, destinationRadius / dd)) + margin) return false;
    }
    const p = this.tmp.copy(center).project(camera);
    if (p.z > 1) return true;
    const sx = p.x * 0.5 + 0.5;
    const sy = 0.5 - p.y * 0.5;
    const rh = Math.tan(rho) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const rw = rh / camera.aspect;
    const k = KEEP_OUT;
    if (sy - rh < k.top) return false;
    if (sx - rw < k.sideRight && sy + rh > k.sideTop && sy - rh < k.sideBottom) return false;
    if (sy + rh > k.cards && (sx - rw < k.cardsLeft || sx + rw > k.cardsRight)) return false;
    return true;
  }

  dispose(): void {
    this.quad.dispose();
    for (const body of [...this.bodies, this.limb]) body.mat.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.stationGeo.dispose();
    this.stationMat.dispose();
    this.group.clear();
  }
}

/** A ring station: hab ring, hub, spokes, two solar wings and blinking beacons. */
function stationGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const glow: number[] = [];
  const add = (g: THREE.BufferGeometry, lit: number): void => {
    g.deleteAttribute('uv');
    const flat = g.index === null ? g : g.toNonIndexed();
    parts.push(flat);
    glow.push(...new Array<number>(flat.getAttribute('position').count).fill(lit));
  };
  add(new THREE.TorusGeometry(1, 0.08, 8, 48), 0);
  add(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 12).rotateX(Math.PI / 2), 0);
  for (let i = 0; i < 4; i++) add(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6).translate(0, 0.52, 0).rotateZ((i * Math.PI) / 2), 0);
  for (const z of [-0.75, 0.75]) add(new THREE.BoxGeometry(1.5, 0.02, 0.42).translate(0, 0, z), 0);
  for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.06, 0.06, 0.06).translate(Math.cos(i * 1.57 + 0.4), Math.sin(i * 1.57 + 0.4), 0.09), 1);
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  if (merged === null) throw new Error('flybys: station parts differ');
  merged.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  return merged;
}
