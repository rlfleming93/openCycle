import { hashSeed, mulberry32 } from '@opencycle/shared';

/** Scalar helpers shared by every world module (no three.js types here). */

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** GLSL-style smoothstep (Hermite) over x ∈ [e0, e1]; outside, 0/1. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function easeOutCubic(t: number): number {
  const u = clamp01(t);
  return 1 - Math.pow(1 - u, 3);
}

/** Slow start: the arrival swell holds its promise until the last quarter. */
export function easeInCubic(t: number): number {
  const u = clamp01(t);
  return u * u * u;
}

/** Frame-rate independent exponential approach with time constant tauS. */
export function damp(current: number, target: number, tauS: number, dtS: number): number {
  if (tauS <= 0 || dtS <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dtS / tauS));
}

/** Deterministic PRNG bound to a seed string (shared mulberry32). */
export function seededRandom(seed: string): () => number {
  return mulberry32(hashSeed(seed));
}

/**
 * World radius whose disc covers `fraction` of the viewport height when seen
 * from `distance` through a vertical FOV of `fovYRad` (pinhole approximation,
 * exact for a sphere near the axis).
 */
export function radiusForFraction(distance: number, fraction: number, fovYRad: number): number {
  return fraction * 2 * Math.tan(fovYRad / 2) * distance;
}

/** Degrees → radians (camera FOV math reads better in degrees). */
export function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}
