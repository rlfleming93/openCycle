import type { LegKind } from '@opencycle/shared';
import * as THREE from 'three';

import { clamp, clamp01, lerp, radians } from './math.js';

/**
 * Flight model ("Motion: the fleet flies", "Flight feel"). Pure helpers: fleet.ts
 * and raiders.ts own the per-ship state and call these.
 *
 * - Translation: flight assist is a spring-damper toward a moving target with a
 *   damping ratio under 1, so every settle overshoots slightly, and its thrust is
 *   clamped, so hulls carry momentum and swing wide through hard turns before
 *   the thrusters catch them.
 * - Attitude: the nose follows velocity (yaw, pitch) and the bank follows the
 *   lateral acceleration, which leads velocity by a quarter period. A turn
 *   therefore rolls in first, pulls through, then rolls out. Every angle runs
 *   through its own second-order spring, so nothing snaps.
 */

/** Per-leg flight character: weave size and tempo, thrust and bank limits. */
export interface LegFlight {
  /** Lateral weave amplitude (world units); vertical and fore-aft scale off it. */
  lateral: number;
  /** Dominant weave period (s). */
  periodS: number;
  /** Flight-assist thrust limit (u/s²). */
  accel: number;
  /** Bank limit (rad). */
  bank: number;
}

/**
 * Seeded weave by leg kind. `pick` in 0..1 places the amplitude inside the
 * spec's band: burns 6-10 u, climb/cruise 3-5 u, coast/launch/approach 1-2 u.
 */
export function legFlight(legKind: LegKind | null, pick: number): LegFlight {
  const k = clamp01(pick);
  switch (legKind) {
    case 'burn':
      return { lateral: lerp(6, 10, k), periodS: lerp(5, 7, k), accel: 16, bank: radians(62) };
    case 'climb':
    case 'cruise':
      return { lateral: lerp(3, 5, k), periodS: lerp(8, 11, k), accel: 9, bank: radians(40) };
    case 'coast':
    case 'launch':
    case 'approach':
      return { lateral: lerp(1, 2, k), periodS: lerp(11, 15, k), accel: 6, bank: radians(24) };
    default:
      // Open space flies like a loose cruise.
      return { lateral: lerp(3, 4, k), periodS: lerp(9, 12, k), accel: 8, bank: radians(34) };
  }
}

/**
 * Smooth seeded weave in about [-1, 1]: three incommensurate sines around
 * `periodS`, so the line never visibly repeats. `seed` picks the phases.
 */
export function weave(seed: number, tS: number, periodS: number): number {
  const w = (2 * Math.PI) / periodS;
  return (
    0.55 * Math.sin(tS * w + seed * 2.399) +
    0.3 * Math.sin(tS * w * 1.73 + seed * 4.117 + 1.3) +
    0.15 * Math.sin(tS * w * 2.91 + seed * 6.271 + 2.9)
  );
}

const pull = new THREE.Vector3();

/**
 * Flight assist: accelerate toward `target` as a spring-damper with the thrust
 * clamped to `maxAccel`, in fixed substeps so a long frame stays stable.
 * `acc` receives the acceleration of the last substep (bank and RCS read it).
 */
export function flyToward(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  acc: THREE.Vector3,
  target: THREE.Vector3,
  omega: number,
  zeta: number,
  maxAccel: number,
  dtS: number,
): void {
  const dt = clamp(dtS, 0, 0.25);
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    pull.copy(target).sub(pos).multiplyScalar(omega * omega).addScaledVector(vel, -2 * zeta * omega);
    pull.clampLength(0, maxAccel);
    vel.addScaledVector(pull, h);
    pos.addScaledVector(vel, h);
  }
  acc.copy(pull);
}

/** One attitude axis: angle plus rate, driven by a second-order spring. */
export interface AngleState {
  angle: number;
  rate: number;
}

/**
 * Step one attitude axis toward `target`. The angular acceleration is clamped
 * to `maxAccel` (rad/s²); the return value is that acceleration, which is what
 * fires the RCS thrusters.
 */
export function stepAngle(
  state: AngleState,
  target: number,
  omega: number,
  zeta: number,
  maxAccel: number,
  dtS: number,
): number {
  const dt = clamp(dtS, 0, 0.25);
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  let a = 0;
  for (let i = 0; i < steps; i++) {
    a = clamp(omega * omega * (target - state.angle) - 2 * zeta * omega * state.rate, -maxAccel, maxAccel);
    state.rate += a * h;
    state.angle += state.rate * h;
  }
  return a;
}

/** Nose travel speed that turns lateral velocity into a heading (u/s). */
export const HEADING_SPEED = 32;
/** Lateral acceleration that banks a hull 45 degrees (u/s²). */
const BANK_G = 9;
const MAX_YAW = radians(24);
const MAX_PITCH = radians(14);

/** Attitude targets: yaw/pitch from velocity, bank from lateral acceleration. */
export interface Attitude {
  yaw: number;
  pitch: number;
  roll: number;
}

export function attitudeTargets(vel: THREE.Vector3, acc: THREE.Vector3, bankLimit: number, out: Attitude): Attitude {
  // Nose is -Z: travelling +X is a negative yaw, climbing is a positive pitch.
  out.yaw = clamp(-Math.atan2(vel.x, HEADING_SPEED), -MAX_YAW, MAX_YAW);
  out.pitch = clamp(Math.atan2(vel.y, HEADING_SPEED), -MAX_PITCH, MAX_PITCH);
  // Bank into the turn: accelerating to starboard drops the starboard wing.
  out.roll = clamp(-Math.atan2(acc.x, BANK_G), -bankLimit, bankLimit);
  return out;
}

/** Quintic ease: zero velocity and acceleration at both ends. */
export function smootherstep(t: number): number {
  const u = clamp01(t);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/**
 * Barrel roll at progress 0..1: a full roll while the hull flies a helix of
 * `radius` around its flight line, canopy toward the helix axis. `dir` ±1
 * picks the side. Writes the helix offset into `offset`, returns the roll.
 */
export function barrelRoll(progress: number, radius: number, dir: number, offset: THREE.Vector3): number {
  const turn = 2 * Math.PI * smootherstep(progress);
  offset.set(dir * radius * Math.sin(turn), radius * (1 - Math.cos(turn)), 0);
  return dir * turn;
}
