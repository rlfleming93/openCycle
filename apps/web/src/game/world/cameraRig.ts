import { hashSeed } from '@opencycle/shared';
import type { LegKind } from '@opencycle/shared';
import * as THREE from 'three';

import type { GameFrame } from '../director.js';
import { ARRIVAL_DEST_SCREEN, CRUISE_DEST_SCREEN, PLANET_DIR } from './composition.js';
import type { Attitude } from './flight.js';
import type { ShipBounds } from './fleet.js';
import { clamp, clamp01, damp, easeInCubic, radians, smoothstep } from './math.js';

/**
 * Elite-style external camera. Every setup is solved the same way: an aim
 * direction lands on its screen mark, the smoothed fleet centre lands on the
 * fleet mark, and the camera sits `distance` from the fleet along that line.
 * The camera never copies the ships' attitude: it lags their mean heading a
 * little (and rolls at most 3 deg), so the hulls visibly roll and yaw inside
 * the frame before the camera catches up.
 *
 * Setups (hard cuts only at leg boundaries):
 *  - chase: aims at the destination; always on the first leg, on every burn
 *    (the pursuit reads first) and from arrival on;
 *  - side: a low track across the fleet with the anchor behind it;
 *  - wide: pulled far back and high, the fleet tiny against the anchor.
 * Side and wide rotate in on cruise, climb, coast and approach legs only,
 * backed off so no hull spans more than about a fifth of the frame width.
 * The session-start frame shift flies a `jump` pose straight down the travel
 * axis and eases into the chase under the exit flash.
 *
 * No shake: the only rotation impulses are the boost and raider-kill kicks,
 * each under 0.4 deg for 0.3 s. A keep-out guard slides the camera so no hull
 * enters the HUD zones (top 16 %, and x < 25 % or x > 75 % below y = 57 %).
 */
export type ShotSetup = 'chase' | 'side' | 'wide';

interface Setup {
  /** Where the aim direction lands on screen. */
  aim: { x: number; y: number };
  /** Where the smoothed fleet centre lands on screen. */
  fleet: { x: number; y: number };
  distance: number;
  /** How much of the fleet's mean yaw the camera follows. */
  yawFollow: number;
}

const SETUPS: Record<ShotSetup, Setup> = {
  chase: { aim: CRUISE_DEST_SCREEN, fleet: { x: 0.47, y: 0.57 }, distance: 30, yawFollow: 0.3 },
  side: { aim: { x: 0.34, y: 0.44 }, fleet: { x: 0.58, y: 0.42 }, distance: 34, yawFollow: 0.15 },
  wide: { aim: { x: 0.6, y: 0.34 }, fleet: { x: 0.42, y: 0.66 }, distance: 150, yawFollow: 0 },
};
/** Setup order for cruise, climb, coast and approach legs after the first. */
const ROTATION: readonly ShotSetup[] = ['side', 'chase', 'wide', 'chase'];
/** Legs that may leave the chase shot; every other leg (burns above all) stays on it. */
const FREE_SHOTS: Partial<Record<LegKind, true>> = { cruise: true, climb: true, coast: true, approach: true };
/**
 * Side and wide keep every hull's bounding sphere within this fraction of the
 * frame width (the sphere over-reads the hull, so hulls stay under 22 %).
 */
const MAX_SHIP_WIDTH = 0.2;

/** Fleet-centre follow time constant. */
const CENTER_TAU_S = 0.45;
/** Heading lag: the camera trails the fleet's mean attitude by this much. */
const ATTITUDE_TAU_S = 0.9;
const MAX_ROLL = radians(3);
const ROLL_FOLLOW = 0.07;

const ARRIVAL_PUSH_S = 6;
const ORBIT_SWING_RAD = 0.05;
const ORBIT_RATE = 0.12;

/** Boost: FOV kick up in 0.12 s, eased back over 1.5 s. */
const FOV_KICK_DEG = 5;
const FOV_ATTACK_S = 0.12;
const FOV_RELEASE_S = 1.5;
/** Rotation kicks: 0.3 s, amplitude in radians (≤ 0.4 deg). */
const KICK_S = 0.3;
const BOOST_KICK = radians(0.22);
const KILL_KICK = radians(0.4);
/** A raider kill holds the current shot this long, so the explosion plays out where it was framed. */
const KILL_HOLD_MS = 3000;

/** HUD keep-out (screen fractions from the top-left) plus a safety margin. */
const TOP_KEEP = 0.16;
const BAND_Y = 0.57;
const BAND_LEFT = 0.25;
const BAND_RIGHT = 0.75;
const MARGIN = 0.02;
const GUARD_TAU_S = 0.25;
/** Bounding radius fraction a hull covers on screen (broadside wings reach it). */
const SILHOUETTE = 1;

/** Frame shift pose: straight down the travel axis, the fleet low centre. */
const JUMP_AIM = new THREE.Vector3(0, 0.02, -1).normalize();
const JUMP: Setup = { aim: { x: 0.5, y: 0.42 }, fleet: { x: 0.5, y: 0.6 }, distance: 30, yawFollow: 0 };

export class CameraRig {
  /** 0..1 across the 6 s arrival push-in; stays 1 during the orbit hold. */
  arrivalT = 0;
  /** True once the push-in has finished (the field drops to a slow drift). */
  orbiting = false;
  /** Current setup; changes only at leg boundaries. */
  setup: ShotSetup = 'chase';
  /** True on the frame of a hard cut (the field respawns its volume). */
  cut = false;
  private arrivalMs = -1;
  private legKey = '';
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly aimDir = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  private readonly fleetDir = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly jumpPos = new THREE.Vector3();
  private readonly jumpAxis = new THREE.Vector3();
  private readonly guard = new THREE.Vector3();
  private readonly guardTarget = new THREE.Vector3();
  private readonly rel = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private hasCenter = false;
  private lagYaw = 0;
  private lagRoll = 0;
  private boostMs = -1;
  private kickMs = -1;
  private kickAmp = 0;
  /** Leg-boundary cuts wait until this render time (a kill holds the shot). */
  private holdUntilMs = -1;

  /** Boost at a burn start: FOV kick plus a gentle rotation kick. */
  boost(nowMs: number): void {
    this.boostMs = nowMs;
    this.kick(nowMs, BOOST_KICK);
  }

  /** Raider kill: the strongest kick the camera ever takes. */
  kill(nowMs: number): void {
    this.kick(nowMs, KILL_KICK);
  }

  private kick(nowMs: number, amp: number): void {
    this.kickMs = nowMs;
    this.kickAmp = amp;
  }

  /**
   * @param jump 0..1 weight of the frame shift pose (1 in the tunnel).
   * @param fovAdd extra FOV in degrees from the frame shift sequence.
   */
  update(
    frame: GameFrame,
    nowMs: number,
    dtS: number,
    camera: THREE.PerspectiveCamera,
    fleetCenter: THREE.Vector3 | null,
    attitude: Attitude,
    bounds: readonly ShipBounds[],
    destinationCenter: THREE.Vector3 | null,
    anchorDir: THREE.Vector3,
    jump: number,
    fovAdd: number,
  ): void {
    if (this.arrivalMs < 0 && frame.events.some((e) => e.kind === 'arrival')) this.arrivalMs = nowMs;
    const t = this.arrivalMs < 0 ? 0 : clamp01((nowMs - this.arrivalMs) / (ARRIVAL_PUSH_S * 1000));
    this.arrivalT = t;
    this.orbiting = this.arrivalMs >= 0 && t >= 1;
    const push = easeInCubic(t);
    const sinceArrivalS = this.arrivalMs < 0 ? 0 : (nowMs - this.arrivalMs) / 1000;

    // Hard cuts at leg boundaries only, deferred while a kill plays out.
    const legIndex = frame.legIndex ?? -1;
    const key = `${legIndex}:${frame.legKind ?? 'none'}:${this.arrivalMs >= 0 ? 'arrival' : 'cruise'}`;
    this.cut = false;
    if (frame.events.some((e) => e.kind === 'raider' && e.outcome === 'down')) this.holdUntilMs = nowMs + KILL_HOLD_MS;
    if (key !== this.legKey && nowMs >= this.holdUntilMs) {
      const first = this.legKey === '';
      this.legKey = key;
      const next = this.pickSetup(frame, legIndex);
      if (next !== this.setup || first) {
        this.setup = next;
        this.cut = true;
      }
    }
    const setup = SETUPS[this.setup];

    // Follow the smoothed fleet centre.
    if (fleetCenter !== null) {
      if (!this.hasCenter || this.cut) {
        this.center.copy(fleetCenter);
        this.hasCenter = true;
      } else {
        this.center.lerp(fleetCenter, dtS <= 0 ? 1 : 1 - Math.exp(-dtS / CENTER_TAU_S));
      }
    }
    // Lag the fleet's heading; follow only part of it.
    if (this.cut) {
      this.lagYaw = attitude.yaw;
      this.lagRoll = attitude.roll;
    } else {
      this.lagYaw = damp(this.lagYaw, attitude.yaw, ATTITUDE_TAU_S, dtS);
      this.lagRoll = damp(this.lagRoll, attitude.roll, ATTITUDE_TAU_S, dtS);
    }

    // FOV: weather breath, the boost kick, the frame shift, the arrival push.
    const boostS = this.boostMs < 0 ? Infinity : (nowMs - this.boostMs) / 1000;
    const kickFov =
      boostS < FOV_ATTACK_S
        ? smoothstep(0, 1, boostS / FOV_ATTACK_S)
        : boostS < FOV_ATTACK_S + FOV_RELEASE_S
          ? 1 - smoothstep(0, 1, (boostS - FOV_ATTACK_S) / FOV_RELEASE_S)
          : 0;
    camera.fov = (42 + clamp(frame.weather, 0, 1.5) * 2) * (1 - 0.02 * push) + FOV_KICK_DEG * kickFov + fovAdd;
    const fovY = radians(camera.fov);
    const tanY = Math.tan(fovY / 2);
    const tanX = tanY * camera.aspect;

    // Aim: the destination on chase (walking to its arrival mark with the
    // push), the anchor on side and wide.
    const aimMark = this.setup === 'chase' ? this.chaseMark(push) : setup.aim;
    if (this.setup !== 'chase') this.aimDir.copy(anchorDir);
    else if (destinationCenter !== null) this.aimDir.copy(destinationCenter).sub(this.center).normalize();
    else this.aimDir.copy(PLANET_DIR);
    this.solve(this.aimDir, aimMark, setup, tanX, tanY, this.axis, this.pos);
    // The camera trails the fleet's turn a little (yaw), orbits on arrival.
    const swing = setup.yawFollow * this.lagYaw + (this.arrivalMs < 0 ? 0 : Math.sin(sinceArrivalS * ORBIT_RATE) * ORBIT_SWING_RAD);
    if (swing !== 0) {
      this.rel.copy(this.pos).sub(this.center).applyAxisAngle(this.up, swing);
      this.pos.copy(this.center).add(this.rel);
      this.axis.applyAxisAngle(this.up, swing);
    }
    // Side and wide never let a hull fill the frame.
    if (this.setup !== 'chase') this.backOff(bounds, tanX);

    // Frame shift pose, blended in by the jump weight (a move, not a cut).
    if (jump > 0) {
      this.solve(JUMP_AIM, JUMP.aim, JUMP, tanX, tanY, this.jumpAxis, this.jumpPos);
      const w = smoothstep(0, 1, jump);
      this.pos.lerp(this.jumpPos, w);
      this.axis.lerp(this.jumpAxis, w).normalize();
    }

    this.applyGuard(bounds, tanX, tanY, dtS);
    camera.position.copy(this.pos).add(this.guard);
    camera.up.set(0, 1, 0);
    this.target.copy(camera.position).add(this.axis);
    camera.lookAt(this.target);

    // Roll: a hint of the fleet's bank, never past 3 deg; plus the kicks.
    const roll = clamp(this.lagRoll * ROLL_FOLLOW, -MAX_ROLL, MAX_ROLL) * (1 - jump);
    camera.rotateZ(roll + push * 0.012);
    const kickS = this.kickMs < 0 ? Infinity : (nowMs - this.kickMs) / 1000;
    if (kickS < KICK_S) {
      const k = kickS / KICK_S;
      const a = this.kickAmp * Math.sin(k * Math.PI * 2) * (1 - k) * (1 - k);
      camera.rotateX(a);
      camera.rotateY(a * 0.35);
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  private chaseMark(push: number): { x: number; y: number } {
    this.markTmp.x = CRUISE_DEST_SCREEN.x + (ARRIVAL_DEST_SCREEN.x - CRUISE_DEST_SCREEN.x) * push;
    this.markTmp.y = CRUISE_DEST_SCREEN.y + (ARRIVAL_DEST_SCREEN.y - CRUISE_DEST_SCREEN.y) * push;
    return this.markTmp;
  }

  private readonly markTmp = { x: 0, y: 0 };

  /** Slide back along the line to the fleet centre until every hull spans at most MAX_SHIP_WIDTH of the frame. */
  private backOff(bounds: readonly ShipBounds[], tanX: number): void {
    this.rel.copy(this.pos).sub(this.center).normalize();
    const along = -this.rel.dot(this.axis);
    if (along < 0.1) return;
    let extra = 0;
    for (const b of bounds) {
      const depth = this.target.copy(b.position).sub(this.pos).dot(this.axis);
      extra = Math.max(extra, b.radius / (MAX_SHIP_WIDTH * tanX) - depth);
    }
    if (extra > 0) this.pos.addScaledVector(this.rel, extra / along);
  }

  /** Chase on the first leg, on every burn and from arrival on; else rotate. */
  private pickSetup(frame: GameFrame, legIndex: number): ShotSetup {
    if (this.arrivalMs >= 0 || legIndex <= 0) return 'chase';
    if (frame.legKind === null || FREE_SHOTS[frame.legKind] !== true) return 'chase';
    const roll = hashSeed(`${frame.seed}:shot:${legIndex}`) % 100;
    return ROTATION[roll % ROTATION.length]!;
  }

  /**
   * Put `aim` on `aimMark` (zero roll), then place the camera so the fleet
   * centre lands on the setup's fleet mark at its distance.
   */
  private solve(
    aim: THREE.Vector3,
    aimMark: { x: number; y: number },
    setup: Setup,
    tanX: number,
    tanY: number,
    outAxis: THREE.Vector3,
    outPos: THREE.Vector3,
  ): void {
    // Exact pinhole framing: a point at NDC (nx, ny) sits at the view-space
    // direction (nx·tanX, ny·tanY, −1), so back the axis off by that offset.
    this.right.crossVectors(aim, this.up).normalize();
    this.camUp.crossVectors(this.right, aim).normalize();
    outAxis
      .copy(aim)
      .addScaledVector(this.right, -(2 * aimMark.x - 1) * tanX)
      .addScaledVector(this.camUp, -(1 - 2 * aimMark.y) * tanY)
      .normalize();
    this.right.crossVectors(outAxis, this.up).normalize();
    this.camUp.crossVectors(this.right, outAxis).normalize();
    this.fleetDir
      .copy(outAxis)
      .addScaledVector(this.right, (2 * setup.fleet.x - 1) * tanX)
      .addScaledVector(this.camUp, (1 - 2 * setup.fleet.y) * tanY)
      .normalize();
    outPos.copy(this.center).addScaledVector(this.fleetDir, -setup.distance);
  }

  /**
   * Keep-out guard: from the unguarded pose, find the smallest camera slide
   * that keeps every hull out of the HUD zones, then ease toward it.
   */
  private applyGuard(bounds: readonly ShipBounds[], tanX: number, tanY: number, dtS: number): void {
    this.right.crossVectors(this.axis, this.up).normalize();
    this.camUp.crossVectors(this.right, this.axis).normalize();
    let pushRight = 0;
    let pushLeft = 0;
    let pushDown = 0;
    let depthX = 1;
    let depthY = 1;
    for (const b of bounds) {
      this.rel.copy(b.position).sub(this.pos);
      const z = this.rel.dot(this.axis);
      if (z < 1) continue;
      const sx = 0.5 + (0.5 * this.rel.dot(this.right)) / (z * tanX);
      const sy = 0.5 - (0.5 * this.rel.dot(this.camUp)) / (z * tanY);
      const rx = (0.5 * b.radius * SILHOUETTE) / (z * tanX);
      const ry = (0.5 * b.radius * SILHOUETTE) / (z * tanY);
      const top = TOP_KEEP + MARGIN - (sy - ry);
      if (top > pushDown) {
        pushDown = top;
        depthY = z;
      }
      if (sy + ry > BAND_Y) {
        const left = BAND_LEFT + MARGIN - (sx - rx);
        const right = sx + rx - (BAND_RIGHT - MARGIN);
        if (left > pushRight) {
          pushRight = left;
          depthX = z;
        }
        if (right > pushLeft) {
          pushLeft = right;
          depthX = z;
        }
      }
    }
    // Screen fractions to world: moving the camera left slides content right.
    const shiftX = (pushRight > 0 && pushLeft > 0 ? (pushRight - pushLeft) / 2 : pushRight - pushLeft) * 2 * depthX * tanX;
    const shiftY = pushDown * 2 * depthY * tanY;
    this.guardTarget.copy(this.right).multiplyScalar(-shiftX).addScaledVector(this.camUp, shiftY);
    if (this.cut) this.guard.copy(this.guardTarget);
    else this.guard.lerp(this.guardTarget, dtS <= 0 ? 1 : 1 - Math.exp(-dtS / GUARD_TAU_S));
  }
}
