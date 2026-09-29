import { describe, expect, it } from 'vitest';

import { DEFAULT_PHYSICS, integrateDistance, virtualSpeed } from './physics.js';

const G = 9.8067;

/** Independent mirror of the power balance: watts consumed at speed v. */
function resistanceWatts(v: number, riderKg: number): number {
  const m = riderKg + DEFAULT_PHYSICS.bikeKg;
  const theta = Math.atan(DEFAULT_PHYSICS.gradePct / 100);
  return (
    (DEFAULT_PHYSICS.crr * m * G * Math.cos(theta) +
      m * G * Math.sin(theta)) *
      v +
    0.5 * DEFAULT_PHYSICS.airDensityKgM3 * DEFAULT_PHYSICS.cda * v ** 3
  );
}

describe('virtualSpeed', () => {
  const riderKg = 75;

  it.each([[100], [150], [200], [250], [300], [400]])(
    'round-trips the power balance at %d W within 1e-3',
    (powerW) => {
      const v = virtualSpeed(powerW, riderKg);
      const consumed = resistanceWatts(v, riderKg);
      expect(Math.abs(consumed - powerW * DEFAULT_PHYSICS.efficiency)).toBeLessThan(1e-3);
    },
  );

  it('solves ~32-34 km/h for 200 W at 75 kg on defaults', () => {
    const kmh = virtualSpeed(200, riderKg) * 3.6;
    expect(kmh).toBeGreaterThanOrEqual(32);
    expect(kmh).toBeLessThanOrEqual(34);
  });

  it.each([[0], [-1], [-250]])('returns 0 for %d W', (powerW) => {
    expect(virtualSpeed(powerW, riderKg)).toBe(0);
  });

  it('is strictly slower with higher rolling resistance', () => {
    const base = virtualSpeed(200, riderKg);
    expect(virtualSpeed(200, riderKg, { crr: 0.006 })).toBeLessThan(base);
  });

  it('is strictly slower with higher drag area', () => {
    const base = virtualSpeed(200, riderKg);
    expect(virtualSpeed(200, riderKg, { cda: 0.5 })).toBeLessThan(base);
  });

  it('is strictly slower with higher air density', () => {
    const base = virtualSpeed(200, riderKg);
    expect(virtualSpeed(200, riderKg, { airDensityKgM3: 1.5 })).toBeLessThan(base);
  });

  it('is strictly slower on an uphill grade', () => {
    const base = virtualSpeed(200, riderKg);
    expect(virtualSpeed(200, riderKg, { gradePct: 2 })).toBeLessThan(base);
  });

  it('clamps negative grade to flat (downhill deferred)', () => {
    expect(virtualSpeed(200, riderKg, { gradePct: -5 })).toBe(
      virtualSpeed(200, riderKg, { gradePct: 0 }),
    );
  });

  it('is strictly slower for a heavier rider', () => {
    const base = virtualSpeed(200, riderKg);
    expect(virtualSpeed(200, riderKg + 40)).toBeLessThan(base);
  });
});

describe('integrateDistance', () => {
  const at = (ts: number, speedMps: number) => ({ ts, speedMps });

  it('trapezoids constant 10 m/s over 9 one-second intervals to ~90 m', () => {
    const samples = Array.from({ length: 10 }, (_, i) => at(i * 1000, 10));
    expect(integrateDistance(samples)).toBeCloseTo(90, 6);
  });

  it('trapezoids a linear 0-9 m/s ramp to 40.5 m', () => {
    const samples = Array.from({ length: 10 }, (_, i) => at(i * 1000, i));
    expect(integrateDistance(samples)).toBeCloseTo(40.5, 6);
  });

  it('anchors at the maximum timestamp so backward pairs are not double-counted', () => {
    // 0->1000 counts 10 m; 1000->500 is backward and ignored; 2000 is measured
    // from the anchored 1000 sample, not from 500, so the total is 20 m.
    const samples = [at(0, 10), at(1000, 10), at(500, 10), at(2000, 10)];
    expect(integrateDistance(samples)).toBeCloseTo(20, 6);
  });

  it('returns 0 for empty samples', () => {
    expect(integrateDistance([])).toBe(0);
  });

  it('returns 0 for a single sample', () => {
    expect(integrateDistance([at(0, 10)])).toBe(0);
  });
});
