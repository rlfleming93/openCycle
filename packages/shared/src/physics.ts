/**
 * Physics: virtual speed from rider power, and distance integration.
 *
 * Pure math, no I/O, no dependencies — shared by the server (session engine)
 * and the web client (ride dashboard, history).
 */

export interface PhysicsOpts {
  /** Drivetrain efficiency (0-1): mechanical watts delivered to the wheel. */
  efficiency: number;
  /** Coefficient of rolling resistance. */
  crr: number;
  /** Drag area (m^2). */
  cda: number;
  /** Air density (kg/m^3). */
  airDensityKgM3: number;
  /** Bike mass (kg), added to the rider's weight. */
  bikeKg: number;
  /**
   * Grade in percent. Negative grades are clamped to 0 — downhill is
   * deferred until virtual terrain exists — so -5 behaves exactly like 0.
   * The parameter is present now so terrain later is parameter-only.
   */
  gradePct: number;
}

export const DEFAULT_PHYSICS: PhysicsOpts = {
  efficiency: 0.976,
  crr: 0.004,
  cda: 0.324,
  airDensityKgM3: 1.225,
  bikeKg: 8,
  gradePct: 0,
};

/** Standard gravity (m/s^2). */
const G = 9.8067;

/** Newton's-method initial speed guess (m/s). */
const START_V = 8;

/** Maximum Newton iterations before accepting the current estimate. */
const MAX_ITERS = 50;

/** Convergence threshold on the speed step (m/s). */
const EPS = 1e-6;

/**
 * Steady-state virtual speed (m/s) for the given rider power output.
 *
 * Solves P·η = Crr·m·g·cos(θ)·v + m·g·sin(θ)·v + 0.5·ρ·CdA·v³ for v, with
 * θ = atan(gradePct / 100) and m = riderKg + bikeKg, via Newton's method.
 * Non-positive power yields 0 m/s. gradePct is clamped to >= 0.
 */
export function virtualSpeed(
  powerW: number,
  riderKg: number,
  opts?: Partial<PhysicsOpts>,
): number {
  if (powerW <= 0) return 0;
  const p: PhysicsOpts = { ...DEFAULT_PHYSICS, ...opts };
  const gradePct = Math.max(0, p.gradePct);
  const m = riderKg + p.bikeKg;
  const theta = Math.atan(gradePct / 100);
  const rolling = p.crr * m * G * Math.cos(theta);
  const climbing = m * G * Math.sin(theta);
  const aero = 0.5 * p.airDensityKgM3 * p.cda;
  const drive = powerW * p.efficiency;

  let v = START_V;
  for (let i = 0; i < MAX_ITERS; i++) {
    const f = (rolling + climbing) * v + aero * v ** 3 - drive;
    const fp = rolling + climbing + 3 * aero * v ** 2;
    const dv = f / fp;
    v -= dv;
    if (v < 0) v = 0; // keep the iteration on the physical branch
    if (Math.abs(dv) < EPS) break;
  }
  return v;
}

/**
 * Distance (m) covered across samples via the trapezoidal rule over
 * epoch-ms timestamps. Each sample is paired with the latest strictly
 * earlier sample; out-of-order samples are ignored without advancing the
 * anchor, so a backward pair is never double-counted. Empty or
 * single-sample input yields 0.
 */
export function integrateDistance(
  samples: Array<{ ts: number; speedMps: number }>,
): number {
  if (samples.length < 2) return 0;
  let distance = 0;
  let prev = samples[0]!;
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i]!;
    if (cur.ts > prev.ts) {
      distance += ((prev.speedMps + cur.speedMps) / 2) * ((cur.ts - prev.ts) / 1000);
      prev = cur;
    }
  }
  return distance;
}
