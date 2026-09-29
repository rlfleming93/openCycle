import type { LegKind } from '@opencycle/shared';
import * as THREE from 'three';

import type { GameFrame } from '../director.js';
import { TRAVEL_DIR } from './composition.js';
import { clamp01, damp, easeOutCubic, smoothstep } from './math.js';

/**
 * Frame Shift Drive ("Flight feel"): the session-start jump, the arrival drop
 * from supercruise and the supercruise edge streaks.
 *
 * Jump timeline (seconds from the lead's mission clock 0):
 *   0-3     charge: engines climb, a blue shimmer crawls over the hulls;
 *   3-6.6   hyperspace: a swirling blue-white conduit with a star at its end;
 *   6.6     exit flash: the system (sky, anchor, destination) is revealed and
 *           the camera eases from the jump pose into the chase.
 * `reveal` feeds the sky and destination (0 hides them), `supercruise` feeds
 * the post chain's edge warp, `jump`/`fovAdd` feed the camera rig and
 * `charge`/`tunnel` feed the fleet.
 *
 * Draws: one full-screen quad for the tunnel or the edge streaks (never both),
 * one flash quad and one shock ring, each only while it shows.
 */
const WINDOW_S = 10;
const CHARGE_S = 3;
const EXIT_S = 6.6;
const POSE_OUT_S = 1.8;
const DONE_S = EXIT_S + 2.2;
/** Depth of the full-screen quads in NDC: behind every hull and the raider,
 *  in front of the destination and the sky shell. */
const BACKDROP_NDC_Z = 0.999;
/** Every flash (jump-in, exit, arrival drop): a 0.15 s peak, then a 0.4 s linear fade. */
const FLASH_HOLD_S = 0.15;
const FLASH_FADE_S = 0.4;
const RING_S = 1.5;

const QUAD_VERT = /* glsl */ `
uniform float uDepth;
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, uDepth, 1.0);
}`;

const HASH_GLSL = /* glsl */ `
float fsdHash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float fsdNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fsdHash(i.x + i.y * 57.0);
  float b = fsdHash(i.x + 1.0 + i.y * 57.0);
  float c = fsdHash(i.x + (i.y + 1.0) * 57.0);
  float d = fsdHash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`;

/**
 * Hyperspace: the frame is the inside of four nested cylindrical shells.
 * Depth down each runs as 1/r, so the walls race outward and stretch; each
 * shell is a dark indigo noise sheet with thin electric filaments along its
 * level set, spiral streak lanes rush past, and a hot star waits at the
 * vanishing point. The noise wraps around the axis, so there is no seam.
 */
const TUNNEL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uAspect;
uniform float uProgress;
uniform vec2 uCenter;
varying vec2 vNdc;
${HASH_GLSL}
float fsdNoiseWrap(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  float a = fsdHash(x0 + i.y * 57.0);
  float b = fsdHash(x1 + i.y * 57.0);
  float c = fsdHash(x0 + (i.y + 1.0) * 57.0);
  float d = fsdHash(x1 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fsdFbmWrap(vec2 p, float period) {
  return fsdNoiseWrap(p, period) * 0.55
    + fsdNoiseWrap(p * 2.0 + vec2(0.0, 5.2), period * 2.0) * 0.3
    + fsdNoiseWrap(p * 4.0 + vec2(0.0, 1.7), period * 4.0) * 0.15;
}
void main() {
  vec2 p = vNdc - uCenter;
  p.x *= uAspect;
  float r = max(length(p), 0.0015);
  float ang = atan(p.y, p.x) / 6.2831853;
  // Near walls (outer frame) are close and bright; the far end is a glow.
  float near = smoothstep(0.04, 0.8, r);
  vec3 col = vec3(0.002, 0.004, 0.016);
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float depth = (0.25 + 0.35 * fk) / r;
    float twist = ang + depth * 0.3 + uTime * (0.03 + 0.02 * fk);
    float n = fsdFbmWrap(vec2(twist * 12.0, depth * 0.6 - uTime * (1.5 + fk)), 12.0);
    // Dark indigo wall; the cube keeps most of it near black with brighter wisps.
    col += vec3(0.012, 0.016, 0.07) * n * n * n * (0.25 + near);
    // Electric filaments: a pixel-thin level set of the nearer walls, where a
    // slow gate opens, with charge pulses racing along them.
    float edge = abs(n - 0.5) / max(fwidth(n), 1e-4);
    if (k < 2) {
      float gate = smoothstep(0.55, 0.75, fsdNoiseWrap(vec2(twist * 4.0, depth * 0.25 - uTime * 0.8), 4.0));
      float charge = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(depth * 9.0 - uTime * 14.0 + fk * 2.1), 3.0);
      col += vec3(0.5, 0.85, 1.0) * exp(-edge * edge * 0.6) * gate * charge * near * 0.9;
    }
  }
  // Streak lanes spiralling past with the walls.
  float depth0 = 0.25 / r;
  float lane = (ang + depth0 * 0.3) * 40.0;
  float h = fsdHash(mod(floor(lane), 40.0) + 3.0);
  float dash = fract(depth0 * (0.2 + 0.35 * h) - uTime * (2.2 + 3.0 * h) + h * 17.0);
  float streak = step(0.5, h) * smoothstep(0.05, 0.0, abs(fract(lane) - 0.5));
  streak *= smoothstep(0.0, 0.04, dash) * smoothstep(0.85, 0.15, dash);
  col += vec3(0.7, 0.85, 1.0) * streak * (0.1 + 0.6 * near);
  // The star at the end swells as the jump runs.
  float grow = 1.0 + 2.5 * uProgress;
  col += vec3(0.88, 0.94, 1.0) * (exp(-r * r * 1400.0 / grow) * 7.0 + exp(-r * 11.0 / grow) * 0.35);
  col += vec3(0.2, 0.35, 1.0) * exp(-r * 4.0) * 0.12;
  // The mouth of the conduit falls off toward the frame corners.
  col *= 1.0 - 0.85 * smoothstep(0.45, 1.5, r);
  gl_FragColor = vec4(col * uLevel, 1.0);
}`;

/**
 * Supercruise edge dust: long streaks racing out from the travel vanishing
 * point, only in the right-hand band between the route strip and the rider
 * card (the workout sidebar holds the left edge; the destination sits well
 * inside the band). Post adds the edge warp.
 */
const EDGE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uAspect;
uniform vec2 uCenter;
varying vec2 vNdc;
${HASH_GLSL}
void main() {
  float sx = vNdc.x * 0.5 + 0.5;
  float sy = 0.5 - vNdc.y * 0.5;
  float band = smoothstep(0.83, 0.97, sx) * smoothstep(0.16, 0.23, sy) * smoothstep(0.57, 0.49, sy);
  if (band < 0.001) discard;
  vec2 p = vNdc - uCenter;
  p.x *= uAspect;
  float r = length(p);
  float lanes = 360.0;
  float fl = atan(p.y, p.x) / 6.2831853 * lanes;
  float lane = floor(fl);
  float h = fsdHash(lane);
  float speed = 0.35 + 0.6 * fract(h * 7.13);
  float s = fract(log(r) * 0.8 - uTime * speed + h * 13.0);
  float streak = step(0.6, h) * smoothstep(0.16, 0.0, abs(fract(fl) - 0.5)) * smoothstep(0.0, 0.03, s) * smoothstep(0.55, 0.0, s);
  gl_FragColor = vec4(vec3(0.62, 0.8, 1.0) * streak * 0.7 * uLevel * band, 1.0);
}`;

/**
 * Every flash (jump-in, exit, arrival drop): a white-hot glare on the jump
 * point, bright only in the middle of the frame. `r` runs in half frame
 * heights. The glow falls off exponentially, which the filmic curve turns into
 * an even fade on screen, and is windowed out by 0.82, inside the nearest frame
 * edge (0.8-0.84 from the exit and drop centres), so the edges and the HUD
 * never wash out; the peak stays under the lens's streak threshold.
 */
const FLASH_FRAG = /* glsl */ `
uniform float uLevel;
uniform float uAspect;
uniform vec2 uCenter;
varying vec2 vNdc;
void main() {
  vec2 p = vNdc - uCenter;
  p.x *= uAspect;
  float r = length(p);
  float glow = 2.6 * exp(-r * 7.7) * (1.0 - smoothstep(0.5, 0.82, r));
  gl_FragColor = vec4(vec3(0.8, 0.9, 1.0) * uLevel * glow, 1.0);
}`;

const RING_FRAG = /* glsl */ `
uniform float uLevel;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float band = exp(-pow((r - 0.93) * 22.0, 2.0)) + 0.25 * smoothstep(0.6, 0.93, r) * step(r, 0.93);
  vec3 col = mix(vec3(0.45, 0.65, 1.0), vec3(1.0), exp(-pow((r - 0.95) * 40.0, 2.0)));
  gl_FragColor = vec4(col * band * uLevel * 2.2, 1.0);
}`;

const RING_VERT = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

function quadMaterial(fragmentShader: string, opaque: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uAspect: { value: 16 / 9 },
      uCenter: { value: new THREE.Vector2() },
      uDepth: { value: BACKDROP_NDC_Z },
      uProgress: { value: 0 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader,
    transparent: !opaque,
    depthWrite: opaque,
    depthTest: true,
    blending: opaque ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
}

/** Flash level `s` seconds after it fires: held at full, then a linear fade (0 before and after). */
function flashLevel(s: number): number {
  return s < 0 ? 0 : s < FLASH_HOLD_S ? 1 : Math.max(0, 1 - (s - FLASH_HOLD_S) / FLASH_FADE_S);
}

/** Legs flown in supercruise. */
const SUPERCRUISE: Partial<Record<LegKind, true>> = { cruise: true, climb: true, coast: true };

export class Fsd {
  readonly group = new THREE.Group();
  /** 0 hides the system (sky, anchor, destination), 1 shows it. */
  reveal = 1;
  /** Supercruise level for the post edge warp and the edge dust. */
  supercruise = 0;
  /** Camera: weight of the jump pose and extra FOV in degrees. */
  jump = 0;
  fovAdd = 0;
  /** Fleet: drive charge and tunnel level, 0..1. */
  charge = 0;
  tunnel = 0;
  private readonly quad = new THREE.PlaneGeometry(2, 2);
  private readonly tunnelMat = quadMaterial(TUNNEL_FRAG, true);
  private readonly edgeMat = quadMaterial(EDGE_FRAG, false);
  private readonly flashMat = quadMaterial(FLASH_FRAG, false);
  private readonly tunnelMesh: THREE.Mesh;
  private readonly edgeMesh: THREE.Mesh;
  private readonly flashMesh: THREE.Mesh;
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly ring: THREE.Mesh;
  private seed = '';
  /** Jump start on the render clock; -1 when none is playing. */
  private startMs = -1;
  private decided = false;
  private dropMs = -1;
  private timeS = 0;
  private readonly center = new THREE.Vector3();
  private readonly vp = new THREE.Vector3();

  constructor() {
    const mesh = (mat: THREE.ShaderMaterial, order: number): THREE.Mesh => {
      const m = new THREE.Mesh(this.quad, mat);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = order;
      return m;
    };
    this.tunnelMesh = mesh(this.tunnelMat, -10);
    this.edgeMesh = mesh(this.edgeMat, 1);
    this.flashMesh = mesh(this.flashMat, 100);
    this.flashMat.depthTest = false;
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uLevel: { value: 0 } },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 128, 1), this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ring.renderOrder = 8;
    this.group.add(this.tunnelMesh, this.edgeMesh, this.flashMesh, this.ring);
  }

  /** Arrival: drop from supercruise with a flash and a shock ring at `center`. */
  drop(nowMs: number, center: THREE.Vector3): void {
    this.dropMs = nowMs;
    this.center.copy(center);
  }

  /**
   * @param ready the fleet has hulls to show (the jump waits for them).
   * @param arrived the arrival push has started (supercruise is over).
   */
  update(frame: GameFrame, nowMs: number, dtS: number, ready: boolean, arrived: boolean, camera: THREE.PerspectiveCamera): void {
    this.timeS += dtS;
    if (frame.seed !== this.seed) {
      this.seed = frame.seed;
      this.startMs = -1;
      this.decided = false;
      this.dropMs = -1;
    }
    // Decide once per session: play the jump only inside the first ~10 s of
    // the mission clock, aligned to it, and only once there are hulls to fly.
    const age = frame.sessionAgeS;
    if (!this.decided && age !== null) {
      if (age >= WINDOW_S) this.decided = true;
      else if (ready) {
        this.decided = true;
        this.startMs = nowMs - age * 1000;
      }
    }
    const pending = !this.decided && age !== null && age < WINDOW_S;
    const t = this.startMs < 0 ? Infinity : (nowMs - this.startMs) / 1000;
    if (t >= DONE_S) this.startMs = -1;
    const playing = t < DONE_S;

    this.charge = playing && t < EXIT_S ? smoothstep(0, CHARGE_S, t) : 0;
    this.tunnel = playing && t >= CHARGE_S && t < EXIT_S ? smoothstep(CHARGE_S, CHARGE_S + 0.25, t) : 0;
    this.reveal = pending ? 0 : playing ? smoothstep(EXIT_S, EXIT_S + 0.25, t) : 1;
    this.jump = playing ? (t < EXIT_S ? 1 : 1 - smoothstep(EXIT_S, EXIT_S + POSE_OUT_S, t)) : 0;
    const fovJump = playing
      ? t < CHARGE_S
        ? -3 * this.charge
        : t < EXIT_S
          ? 14 * smoothstep(CHARGE_S, CHARGE_S + 0.4, t)
          : 14 * (1 - easeOutCubic((t - EXIT_S) / 1.2))
      : 0;
    const dropS = this.dropMs < 0 ? Infinity : (nowMs - this.dropMs) / 1000;
    const fovDrop = dropS < 1.4 ? 7 * (1 - easeOutCubic(dropS / 1.4)) : 0;
    this.fovAdd = fovJump + fovDrop;

    const wantCruise = !playing && !pending && !arrived && frame.legKind !== null && SUPERCRUISE[frame.legKind] === true;
    this.supercruise = damp(this.supercruise, wantCruise ? 1 : 0, 1.2, dtS);

    // Flash: the jump in (small) and the exit (big), or the arrival drop.
    const jumpIn = playing && t >= CHARGE_S ? flashLevel(t - CHARGE_S) * 0.6 : 0;
    const exit = playing && t >= EXIT_S ? flashLevel(t - EXIT_S) : 0;
    const dropFlash = flashLevel(dropS);
    const flash = Math.max(jumpIn, exit, dropFlash);

    const aspect = camera.aspect;
    for (const mat of [this.tunnelMat, this.edgeMat, this.flashMat]) {
      mat.uniforms.uTime!.value = this.timeS;
      mat.uniforms.uAspect!.value = aspect;
    }
    this.tunnelMesh.visible = this.tunnel > 0;
    this.tunnelMat.uniforms.uLevel!.value = this.tunnel;
    this.tunnelMat.uniforms.uProgress!.value = clamp01((t - CHARGE_S) / (EXIT_S - CHARGE_S));
    this.tunnelMat.uniforms.uCenter!.value.set(0, 0.16);
    this.edgeMesh.visible = !this.tunnelMesh.visible && this.supercruise > 0.01;
    this.edgeMat.uniforms.uLevel!.value = this.supercruise;
    this.vp.copy(camera.position).addScaledVector(TRAVEL_DIR, 1e4).project(camera);
    this.edgeMat.uniforms.uCenter!.value.set(this.vp.x, this.vp.y);
    this.flashMesh.visible = flash > 0.005;
    this.flashMat.uniforms.uLevel!.value = flash;
    this.flashMat.uniforms.uCenter!.value.set(0, dropFlash > 0 ? -0.2 : 0.16);

    // Arrival shock ring: expands around the fleet, perpendicular to travel.
    const ringT = dropS / RING_S;
    this.ring.visible = ringT < 1;
    if (this.ring.visible) {
      this.ring.position.copy(this.center);
      this.ring.quaternion.copy(camera.quaternion);
      this.ring.scale.setScalar(6 + 150 * easeOutCubic(ringT));
      this.ringMat.uniforms.uLevel!.value = (1 - ringT) * (1 - ringT) * clamp01(dropS / 0.08);
    }
  }

  dispose(): void {
    this.quad.dispose();
    this.tunnelMat.dispose();
    this.edgeMat.dispose();
    this.flashMat.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.group.clear();
  }
}
