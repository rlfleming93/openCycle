import { describe, expect, it } from 'vitest';

import {
  fitnessFatigue,
  FORM_RAMP_THRESHOLD,
  FORM_RECOVERY_THRESHOLD,
  intensity,
  trainingLoad,
  weightedPower,
} from './load.js';

/** Independent naive weighted power: slice-based rolling windows, not windowed sums. */
function naiveWeightedPower(power1Hz: number[]): number {
  const rolling: number[] = [];
  for (let i = 0; i < power1Hz.length; i++) {
    const window = power1Hz.slice(Math.max(0, i - 29), i + 1);
    rolling.push(window.reduce((a, b) => a + b, 0) / window.length);
  }
  const fourthMean = rolling.reduce((a, b) => a + b ** 4, 0) / rolling.length;
  return fourthMean ** 0.25;
}

/** Alternating lowW/highW blocks of blockS seconds, totalS samples long. */
function alternatingBlocks(totalS: number, blockS: number, lowW: number, highW: number): number[] {
  return Array.from({ length: totalS }, (_, t) =>
    Math.floor(t / blockS) % 2 === 0 ? lowW : highW,
  );
}

describe('weightedPower', () => {
  const alternating = alternatingBlocks(300, 30, 100, 300);

  const cases = [
    { name: 'empty array -> 0', input: [] as number[], expected: 0 },
    {
      name: 'constant 200 W for 120 s -> 200',
      input: Array<number>(120).fill(200),
      expected: 200,
    },
    {
      name: 'alternating 100/300 W in 30 s blocks for 300 s',
      input: alternating,
      expected: naiveWeightedPower(alternating),
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    const result = weightedPower(input);
    if (expected === 0) {
      expect(result).toBe(0);
    } else {
      // Constant input is exactly 200 mathematically; only FP noise (~1e-13) remains.
      expect(result).toBeCloseTo(expected, 9);
    }
  });

  it('hand-computed vector: 100 W x 30 then 300 W x 30', () => {
    // Derived by hand (not from the in-test mirror):
    // Rolling 30 s windows over [100^30, 300^30]:
    //  - i = 0..29: partial/full windows are all 100 W (30 values).
    //  - i = 30..59: the window slides 29x100+1x300 .. 30x300, i.e. averages
    //    100 + (200/30)*k for k = 1..30.
    // Mean of 4th powers = (30*100^4 + sum_{k=1..30} (100 + 200k/30)^4) / 60
    //                    = 1327629596.7078...
    // 4th root = 190.8838700146 -> hardcoded to 190.8839.
    const input = [...Array<number>(30).fill(100), ...Array<number>(30).fill(300)];
    expect(weightedPower(input)).toBeCloseTo(190.8839, 3);
  });
});

describe('intensity', () => {
  const cases = [
    { name: '200 W at 200 W FTP -> 1.0', wp: 200, ftpW: 200, expected: 1 },
    { name: '160 W at 200 W FTP -> 0.8', wp: 160, ftpW: 200, expected: 0.8 },
    { name: 'zero FTP -> 0', wp: 200, ftpW: 0, expected: 0 },
    { name: 'negative FTP -> 0', wp: 200, ftpW: -10, expected: 0 },
  ];

  it.each(cases)('$name', ({ wp, ftpW, expected }) => {
    expect(intensity(wp, ftpW)).toBeCloseTo(expected, 12);
  });
});

describe('trainingLoad', () => {
  const cases = [
    {
      name: '1 h at intensity 1.0 -> 100',
      durationS: 3600,
      wp: 200,
      ftpW: 200,
      expected: 100,
    },
    {
      name: '30 min at intensity 0.8 -> 32',
      durationS: 1800,
      wp: 160,
      ftpW: 200,
      expected: 32,
    },
    { name: 'zero duration -> 0', durationS: 0, wp: 200, ftpW: 200, expected: 0 },
  ];

  it.each(cases)('$name', ({ durationS, wp, ftpW, expected }) => {
    expect(trainingLoad(durationS, intensity(wp, ftpW))).toBeCloseTo(expected, 12);
  });
});

describe('fitnessFatigue', () => {
  // Day 0 gets a single load of 100; days 1..13 are zero-load.
  const singleLoad = [100, ...Array<number>(13).fill(0)];

  const decayCases = [
    {
      name: 'day 0',
      day: 0,
      expectedFitness: 100 * (1 - Math.exp(-1 / 42)),
      expectedFatigue: 100 * (1 - Math.exp(-1 / 7)),
    },
    {
      name: 'day 13',
      day: 13,
      expectedFitness: 100 * (1 - Math.exp(-1 / 42)) * Math.exp(-13 / 42),
      expectedFatigue: 100 * (1 - Math.exp(-1 / 7)) * Math.exp(-13 / 7),
    },
  ];

  it.each(decayCases)(
    'single load 100 then 13 zero days: $name (decays by e^(-1/tau) daily)',
    ({ day, expectedFitness, expectedFatigue }) => {
      const result = fitnessFatigue(singleLoad);
      expect(result.fitness[day]).toBeCloseTo(expectedFitness, 9);
      expect(result.fatigue[day]).toBeCloseTo(expectedFatigue, 9);
      expect(result.form[day]).toBeCloseTo(expectedFitness - expectedFatigue, 9);
    },
  );

  it('constant 100/day for 100 days approaches 100 monotonically', () => {
    const { fitness } = fitnessFatigue(Array<number>(100).fill(100));
    for (let i = 1; i < fitness.length; i++) {
      expect(fitness[i]).toBeGreaterThan(fitness[i - 1]!);
    }
    expect(fitness[99]).toBeLessThan(100);
    expect(fitness[99]).toBeCloseTo(100 * (1 - Math.exp(-100 / 42)), 9);
  });
});

describe('form thresholds', () => {
  it('exposes the dashboard thresholds', () => {
    expect(FORM_RECOVERY_THRESHOLD).toBe(-25);
    expect(FORM_RAMP_THRESHOLD).toBe(15);
  });
});
