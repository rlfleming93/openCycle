import type { LegKind } from '@opencycle/shared';
import * as THREE from 'three';

import type { GameFrame } from '../director.js';
import { KEEP_OUT, TRAVEL_DIR, UP } from './composition.js';
import type { ShipBounds } from './fleet.js';
import { clamp01, damp, lerp } from './math.js';

/**
 * The flow every streaming layer shares: the fleet flies along TRAVEL_DIR, so
 * the world streams past along -TRAVEL_DIR. Nothing here moves per instance on
 * the CPU. Each instance carries a seed; its position is a pure function of
 * that seed, the integrated travel distance and a few uniforms, evaluated in
 * the vertex shader (FLOW_GLSL):
 *
 *  - lateral positions are fixed in the world (the fleet stays near the
 *    origin), so the camera sliding with the fleet's weave reads as parallax;
 *  - the along-travel coordinate wraps inside a window that starts just
 *    behind the camera, and every wrap is a new cycle with a fresh hash, so a
 *    rock re-enters far ahead in a new place;
 *  - density follows the leg kind through a per-layer ramp keyed to travel, so
 *    a change only ever spawns (or thins) at the far end and the field ahead
 *    thickens as you fly into it: nothing pops near the camera;
 *  - a static corridor (two capsules in the lateral plane, re-solved at hard
 *    cuts) keeps every solid object off the camera's sightlines to the fleet
 *    and the raider;
 *  - a screen guard (ocScreenGuard) shrinks the big solids away while they
 *    would overlap a HUD keep-out, the destination disc plus a margin or the
 *    anchor core, and `solveSector` steers them onto the headings that stream
 *    out through the free parts of the frame, so they rarely need it.
 */

/** A streaming class: one window along the travel axis and its own density by leg kind. */
export interface FlowLayer {
  /** Window length along the travel axis (u). */
  length: number;
  /** How far behind the camera the window starts (u). */
  behind: number;
  /** Travel multiplier: streaks outrun the world as a pure speed cue. */
  rate: number;
  density: Record<LegKind, number>;
  /** Travel at which the layer's current density ramp starts at the far end. */
  rampStart: number;
  /**
   * Per-layer uniforms: bind into the layer's material alongside
   * `Flow.uniforms`. uFlowDens = (from, to, ramp position, ramp length).
   */
  uniforms: { uFlowWin: THREE.IUniform<THREE.Vector4>; uFlowDens: THREE.IUniform<THREE.Vector4> };
}

export function flowLayer(length: number, behind: number, density: Record<LegKind, number>, rate = 1): FlowLayer {
  return {
    length,
    behind,
    rate,
    density,
    rampStart: 0,
    uniforms: { uFlowWin: { value: new THREE.Vector4(length, 0, 0, 0) }, uFlowDens: { value: new THREE.Vector4(0, 0, RAMP * 4, RAMP) } },
  };
}

/** Travel over which a new leg's density sweeps in from the far end. */
const RAMP = 120;
/** Seconds after the system reveal before the big classes may sweep back in. */
export const REVEAL_CALM_S = 3;
/** Camera and fleet sway after a cut, covered by the corridor. */
const SWAY = 6;
/** Minimum corridor radius around the fleet before any hull has loaded. */
const FLEET_MIN_RADIUS = 14;
/** Clear margin around the destination disc (frame heights). */
const DEST_MARGIN = 0.05;
/** Headings the sector solve tries, and the on-screen radius (frame heights) below which a body may cross a guarded zone. */
const SECTOR_STEPS = 90;
const SECTOR_MIN_R = 0.012;

const f3 = (v: number): string => v.toFixed(3);

/** GLSL placement helpers; every flow material starts its vertex shader with this. */
export const FLOW_GLSL = /* glsl */ `
uniform vec3 uFlowR;
uniform vec3 uFlowU;
uniform vec3 uFlowT;
uniform vec4 uFlowCapA;
uniform vec4 uFlowCapB;
uniform vec2 uFlowCapR;
uniform vec4 uFlowDest;
uniform vec4 uFlowAnchor;
uniform float uFlowTime;
uniform vec4 uFlowWin;
uniform vec4 uFlowDens;

// Hash without sine (Hoskins): stable for the small inputs used here.
vec4 ocHash41(float p) {
  vec4 p4 = fract(vec4(p) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

// Window fraction of an instance's along-travel phase: 0 at the near end (just
// behind the camera), 1 at the far end. The out parameter counts wraps.
float ocFlowU(float phase, out float cycle) {
  float x = phase - uFlowWin.z / uFlowWin.x;
  cycle = uFlowWin.w + 1.0 - step(0.0, x);
  return fract(x);
}

// Density this instance spawned under (the layer's ramp, keyed to travel).
float ocFlowDensity(float u) {
  float t = (uFlowDens.z - uFlowWin.x * (1.0 - u)) / uFlowDens.w;
  return mix(uFlowDens.x, uFlowDens.y, clamp(t, 0.0, 1.0));
}

float ocCapsule(vec2 p, vec4 seg, float r) {
  vec2 pa = p - seg.xy;
  vec2 ba = seg.zw - seg.xy;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Signed clearance of a lateral point from the corridor.
float ocCorridor(vec2 lat) {
  return min(ocCapsule(lat, uFlowCapA, uFlowCapR.x), ocCapsule(lat, uFlowCapB, uFlowCapR.y));
}

vec3 ocFlowPoint(vec2 lat, float u) {
  return uFlowR * lat.x + uFlowU * lat.y + uFlowT * (uFlowWin.y + u * uFlowWin.x);
}

// 0..1 visibility at the window ends: grows in far ahead, shrinks out behind the camera.
float ocFlowEnds(float u) {
  return smoothstep(1.0, 0.86, u) * smoothstep(0.0, 0.02, u);
}

// Far objects in front of the destination shrink away while they overlap its
// disc, so the planet stays legible; near ones may cross it.
float ocDestClear(vec3 p, float radius) {
  if (uFlowDest.w <= 0.0) return 1.0;
  vec3 toP = p - cameraPosition;
  vec3 toD = uFlowDest.xyz - cameraPosition;
  float dp = length(toP);
  float dd = length(toD);
  float disc = asin(min(1.0, uFlowDest.w / dd)) + 0.02;
  float gap = acos(clamp(dot(toP, toD) / max(dp * dd, 1e-4), -1.0, 1.0)) - radius / max(dp, 1.0);
  float far = smoothstep(140.0, 320.0, dp) * step(dp, dd);
  return 1.0 - far * (1.0 - smoothstep(disc, disc * 1.3 + 0.012, gap));
}

// Signed distance from p to an axis-aligned box (negative inside).
float ocRectGap(vec2 p, vec2 lo, vec2 hi) {
  vec2 d = max(lo - p, p - hi);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Screen point of a clip position: x in frame heights from the left, y down.
vec2 ocScreen(vec4 c, float aspect) {
  return vec2((c.x / c.w * 0.5 + 0.5) * aspect, 0.5 - c.y / c.w * 0.5);
}

// 0..1 visibility of a sphere on screen: it shrinks away while it would
// overlap a HUD keep-out (mask.x), or the destination disc plus its margin or
// the anchor core (mask.y). Mirrors Flow.solveSector.
float ocScreenGuard(vec3 center, float radius, vec2 mask) {
  if (mask.x + mask.y < 0.5) return 1.0;
  vec4 c = projectionMatrix * viewMatrix * vec4(center, 1.0);
  if (c.w < 0.5) return 1.0;
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  float k = 0.5 * projectionMatrix[1][1];
  vec2 p = ocScreen(c, aspect);
  float gap = 1e3;
  if (mask.x > 0.5) {
    gap = min(gap, p.y - ${f3(KEEP_OUT.top)});
    gap = min(gap, ocRectGap(p, vec2(-1e3, ${f3(KEEP_OUT.sideTop)}), vec2(${f3(KEEP_OUT.sideRight)} * aspect, ${f3(KEEP_OUT.sideBottom)})));
    gap = min(gap, ocRectGap(p, vec2(-1e3, ${f3(KEEP_OUT.cards)}), vec2(${f3(KEEP_OUT.cardsLeft)} * aspect, 1e3)));
    gap = min(gap, ocRectGap(p, vec2(${f3(KEEP_OUT.cardsRight)} * aspect, ${f3(KEEP_OUT.cards)}), vec2(1e3)));
  }
  if (mask.y > 0.5) {
    vec4 d = projectionMatrix * viewMatrix * vec4(uFlowDest.xyz, 1.0);
    if (uFlowDest.w > 0.0 && d.w > 0.0) gap = min(gap, length(p - ocScreen(d, aspect)) - uFlowDest.w * k / d.w - ${f3(DEST_MARGIN)});
    vec4 a = projectionMatrix * viewMatrix * vec4(uFlowAnchor.xyz, 0.0);
    if (a.w > 0.0) gap = min(gap, length(p - ocScreen(a, aspect)) - tan(uFlowAnchor.w) * k);
  }
  return smoothstep(0.0, 0.04, gap - radius * k / c.w);
}

// Axis-angle rotation (Rodrigues).
vec3 ocRotate(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;

export class Flow {
  /** Integrated travel distance (u); only its wrap per layer reaches the GPU. */
  travel = 0;
  /** Current travel speed (u/s). */
  speed = 0;
  /** Burst of the burn-start boost, 0..1 (the dust and streaks flare with it). */
  burst = 0;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly layers: FlowLayer[] = [];
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly capA = new THREE.Vector4();
  private readonly capB = new THREE.Vector4();
  private readonly capR = new THREE.Vector2();
  /** Destination centre and world radius (w <= 0 without one). */
  private readonly dest = new THREE.Vector4(0, 0, 0, -1);
  /** Anchor direction and the angular radius kept clear around it. */
  private readonly anchor = new THREE.Vector4(0, 0, -1, 0);
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly clip = new THREE.Vector4();
  private readonly sp = new THREE.Vector3();
  private readonly sd = new THREE.Vector3();
  private readonly sa = new THREE.Vector3();
  private legKind: LegKind | null | undefined = undefined;
  private burn = 0;
  private boostMs = -1;
  private elapsedS = 0;

  constructor() {
    this.right.crossVectors(TRAVEL_DIR, UP).normalize();
    this.up.crossVectors(this.right, TRAVEL_DIR).normalize();
    this.uniforms = {
      uFlowR: { value: this.right },
      uFlowU: { value: this.up },
      uFlowT: { value: TRAVEL_DIR },
      uFlowCapA: { value: this.capA },
      uFlowCapB: { value: this.capB },
      uFlowCapR: { value: this.capR },
      uFlowDest: { value: this.dest },
      uFlowAnchor: { value: this.anchor },
      uFlowTime: { value: 0 },
    };
  }

  /** Register a layer; its uniforms update every frame from here on. */
  add(layer: FlowLayer): FlowLayer {
    this.layers.push(layer);
    return layer;
  }

  /** Burn-start boost: a short surge of speed. */
  boost(nowMs: number): void {
    this.boostMs = nowMs;
  }

  /** The anchor's direction and the angular radius the screen guard keeps clear around it. */
  setAnchor(direction: THREE.Vector3, radius: number): void {
    this.anchor.set(direction.x, direction.y, direction.z, radius);
  }

  /**
   * Integrate travel from the frame's speed (faster on burns, a drift in the
   * arrival orbit), sweep the leg density in, and track the destination disc.
   */
  update(
    frame: GameFrame,
    nowMs: number,
    dtS: number,
    camera: THREE.PerspectiveCamera,
    orbit: boolean,
    destination: THREE.Vector3 | null,
    destinationRadius: number,
  ): void {
    this.elapsedS += dtS;
    this.uniforms.uFlowTime!.value = this.elapsedS;
    const burstS = this.boostMs < 0 ? Infinity : (nowMs - this.boostMs) / 1000;
    this.burst = burstS < 1.4 ? (1 - burstS / 1.4) * (1 - burstS / 1.4) : 0;
    this.burn = damp(this.burn, frame.legKind === 'burn' ? 1 : 0, 2, dtS);
    this.speed =
      lerp(7, 34, clamp01(frame.shipSpeed)) *
      (0.8 + 0.4 * frame.weather) *
      (1 + 0.45 * this.burn) *
      (orbit ? 0.1 : 1) *
      (1 + 2.5 * this.burst);
    this.travel += this.speed * dtS;

    // Leg change: every layer ramps from what its far end spawns right now to the new table.
    if (frame.legKind !== this.legKind) {
      const first = this.legKind === undefined;
      for (const layer of this.layers) {
        const d = layer.uniforms.uFlowDens.value;
        const next = layer.density[frame.legKind ?? 'free'];
        d.x = first ? next : lerp(d.x, d.y, clamp01(d.z / d.w));
        d.y = next;
        layer.rampStart = this.travel;
      }
      this.legKind = frame.legKind;
    }

    const along = camera.position.dot(TRAVEL_DIR);
    for (const layer of this.layers) {
      const w0 = along - layer.behind;
      const s = this.travel * layer.rate + w0;
      const base = Math.floor(s / layer.length);
      layer.uniforms.uFlowWin.value.set(layer.length, w0, s - base * layer.length, base);
      layer.uniforms.uFlowDens.value.z = (this.travel - layer.rampStart) * layer.rate;
    }

    if (destination === null) this.dest.w = -1;
    else this.dest.set(destination.x, destination.y, destination.z, destinationRadius);
  }

  /**
   * Empty `layer` and let its leg density sweep back in from the far end once
   * `delay` more travel has passed: nothing already in the window reappears.
   */
  hold(layer: FlowLayer, delay: number): void {
    const d = layer.uniforms.uFlowDens.value;
    d.x = 0;
    d.y = layer.density[this.legKind ?? 'free'];
    d.z = -delay * layer.rate;
    layer.rampStart = this.travel + delay;
  }

  /** Lateral (right, up) coordinates of a world point. */
  lateral(p: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 {
    return out.set(p.dot(this.right), p.dot(this.up));
  }

  /**
   * Corridor A runs from the camera to the fleet centre and covers every hull;
   * corridor B runs from the camera through the raider's readable box (or
   * repeats A without one). Both are lateral capsules, so they hold along the
   * whole window. Call it on hard cuts: between cuts the corridor must stay
   * put, or rocks would pop at its edge.
   */
  solveCorridor(camera: THREE.PerspectiveCamera, bounds: readonly ShipBounds[], raiderBox: readonly THREE.Vector3[] | null): void {
    const c = this.lateral(camera.position, new THREE.Vector2());
    const center = this.tmp.set(0, 0, 0);
    for (const b of bounds) center.add(b.position);
    if (bounds.length > 0) center.multiplyScalar(1 / bounds.length);
    const f = this.lateral(center, new THREE.Vector2());
    this.capA.set(c.x, c.y, f.x, f.y);
    let ra = FLEET_MIN_RADIUS;
    const p = new THREE.Vector2();
    for (const b of bounds) ra = Math.max(ra, segmentDistance(this.lateral(b.position, p), this.capA) + b.radius * 0.6);
    this.capR.x = ra + SWAY;

    if (raiderBox === null || raiderBox.length === 0) {
      this.capB.copy(this.capA);
      this.capR.y = this.capR.x;
      return;
    }
    // Raider: a capsule from the camera to the box's lateral centroid, wide
    // enough for every corner (the box is sampled at both depths).
    const mid = this.tmp2.set(0, 0, 0);
    for (const q of raiderBox) mid.add(q);
    mid.multiplyScalar(1 / raiderBox.length);
    const m = this.lateral(mid, new THREE.Vector2());
    this.capB.set(c.x, c.y, m.x, m.y);
    let rb = 0;
    for (const q of raiderBox) rb = Math.max(rb, segmentDistance(this.lateral(q, p), this.capB));
    this.capR.y = rb + SWAY;
  }

  /**
   * Steer a class onto the headings that stream cleanly past this camera: the
   * widest run of lateral headings around the camera's lateral point along
   * which a body of `size` at lateral distance `dist` leaves the frame without
   * overlapping a keep-out, the destination disc plus margin or the anchor
   * core while it is big enough to see. `out` = (start, end, on); off (the
   * class samples every heading) when no run is wide enough. Mirrors
   * ocScreenGuard; call it right after solveCorridor, with the same camera.
   */
  solveSector(camera: THREE.PerspectiveCamera, size: number, dist: number, out: THREE.Vector4): void {
    const k = 0.5 * camera.projectionMatrix.elements[5]!;
    const aspect = camera.projectionMatrix.elements[5]! / camera.projectionMatrix.elements[0]!;
    const d = this.dest.w > 0 ? this.screen(camera, this.tmp.set(this.dest.x, this.dest.y, this.dest.z), 1, this.sd) : null;
    const a = this.screen(camera, this.tmp.set(this.anchor.x, this.anchor.y, this.anchor.z), 0, this.sa);
    const destR = d === null ? 0 : (this.dest.w * k) / d.z + DEST_MARGIN;
    const anchorR = Math.tan(this.anchor.w) * k;
    const c = this.lateral(camera.position, new THREE.Vector2());
    const along = camera.position.dot(TRAVEL_DIR);
    const K = KEEP_OUT;
    const ok: boolean[] = [];
    for (let i = 0; i < SECTOR_STEPS; i++) {
      const heading = (i / SECTOR_STEPS) * Math.PI * 2;
      const lx = c.x + Math.cos(heading) * dist;
      const ly = c.y + Math.sin(heading) * dist;
      let clear = true;
      // March the body from far ahead until it leaves the frame or passes the camera.
      for (let j = 0; j <= 32 && clear; j++) {
        const s = 3000 * Math.pow(10 / 3000, j / 32);
        this.tmp.copy(this.right).multiplyScalar(lx).addScaledVector(this.up, ly).addScaledVector(TRAVEL_DIR, along + s);
        const p = this.screen(camera, this.tmp, 1, this.sp);
        if (p === null) break;
        const r = (size * k) / p.z;
        if (p.x < -r || p.x > aspect + r || p.y < -r || p.y > 1 + r) break;
        if (r < SECTOR_MIN_R) continue;
        let gap = Math.min(
          p.y - K.top,
          rectGap(p.x, p.y, -1e3, K.sideTop, K.sideRight * aspect, K.sideBottom),
          rectGap(p.x, p.y, -1e3, K.cards, K.cardsLeft * aspect, 1e3),
          rectGap(p.x, p.y, K.cardsRight * aspect, K.cards, 1e3, 1e3),
        );
        if (d !== null) gap = Math.min(gap, Math.hypot(p.x - d.x, p.y - d.y) - destR);
        if (a !== null) gap = Math.min(gap, Math.hypot(p.x - a.x, p.y - a.y) - anchorR);
        clear = gap > r;
      }
      ok.push(clear);
    }
    if (ok.every(Boolean)) {
      out.set(0, Math.PI * 2, 1, 0);
      return;
    }
    // Widest circular run of clear headings, trimmed a step each side for sway.
    let best = 0;
    let start = 0;
    for (let i = 0; i < SECTOR_STEPS; i++) {
      if (!ok[i] || ok[(i + SECTOR_STEPS - 1) % SECTOR_STEPS]) continue;
      let n = 0;
      while (ok[(i + n) % SECTOR_STEPS]) n++;
      if (n > best) {
        best = n;
        start = i;
      }
    }
    const step = (Math.PI * 2) / SECTOR_STEPS;
    out.set((start + 1) * step, (start + best - 1) * step, best >= 4 ? 1 : 0, 0);
  }

  /** Screen point of `p` (x in frame heights, y down) with its clip w in z; `w` 0 reads p as a direction. Null behind the camera. */
  private screen(camera: THREE.PerspectiveCamera, p: THREE.Vector3, w: number, out: THREE.Vector3): THREE.Vector3 | null {
    const c = this.clip.set(p.x, p.y, p.z, w).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    if (c.w <= (w > 0 ? 0.5 : 0)) return null;
    const aspect = camera.projectionMatrix.elements[5]! / camera.projectionMatrix.elements[0]!;
    return out.set((c.x / c.w * 0.5 + 0.5) * aspect, 0.5 - (c.y / c.w) * 0.5, c.w);
  }
}

/** Distance from a lateral point to the segment (x, y) -> (z, w). */
function segmentDistance(p: THREE.Vector2, seg: THREE.Vector4): number {
  const bx = seg.z - seg.x;
  const by = seg.w - seg.y;
  const h = clamp01(((p.x - seg.x) * bx + (p.y - seg.y) * by) / Math.max(bx * bx + by * by, 1e-6));
  return Math.hypot(p.x - seg.x - bx * h, p.y - seg.y - by * h);
}

/** Signed distance from (px, py) to an axis-aligned box, negative inside (ocRectGap). */
function rectGap(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.max(x0 - px, px - x1);
  const dy = Math.max(y0 - py, py - y1);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}
