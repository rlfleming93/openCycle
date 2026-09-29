import { describe, expect, it } from 'vitest';

import {
  bestWindowAvg,
  ftpFrom20Min,
  ftpFromHistory,
  ftpFromRamp,
  type ActivityWithPower,
} from './ftp.js';

describe('bestWindowAvg', () => {
  const cases = [
    { name: 'empty array -> 0', input: [] as number[], windowS: 60, expected: 0 },
    {
      name: 'array shorter than window -> whole-array average',
      input: [200, 400],
      windowS: 60,
      expected: 300,
    },
    {
      name: 'window equal to array length',
      input: [200, 200, 200],
      windowS: 3,
      expected: 200,
    },
    {
      name: 'max average over contiguous windows',
      input: [100, 100, 300, 300],
      windowS: 2,
      expected: 300,
    },
    {
      name: 'sliding window picks the peak',
      input: [200, 200, 200, 500, 500, 100],
      windowS: 3,
      expected: 400,
    },
  ];

  it.each(cases)('$name', ({ input, windowS, expected }) => {
    expect(bestWindowAvg(input, windowS)).toBeCloseTo(expected, 12);
  });
});

describe('ftpFromRamp', () => {
  // Ramp-like vector: 60 s @ 200 W warmup then 60 s @ 320 W; best 60 s avg = 320 W.
  const ramp = [...Array<number>(60).fill(200), ...Array<number>(60).fill(320)];

  const cases = [
    { name: 'best 60 s average of 320 W -> 240', input: ramp, expected: 240 },
    { name: 'empty array -> 0', input: [] as number[], expected: 0 },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(ftpFromRamp(input)).toBeCloseTo(expected, 12);
  });
});

describe('ftpFrom20Min', () => {
  // 600 s @ 200 W then 1200 s @ 250 W; best 20-min avg = 250 W.
  const vector = [...Array<number>(600).fill(200), ...Array<number>(1200).fill(250)];

  const cases = [
    { name: 'best 20-min average of 250 W -> 237.5', input: vector, expected: 237.5 },
    {
      name: 'exactly 20 min of constant power',
      input: Array<number>(1200).fill(250),
      expected: 237.5,
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(ftpFrom20Min(input)).toBeCloseTo(expected, 12);
  });
});

describe('ftpFromHistory', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  // Best 20-min avg 250 W -> 0.95 x 250 = 237.5 -> rounds to 238.
  const recentPower = Array<number>(1200).fill(250);

  const cases: Array<{
    name: string;
    activities: ActivityWithPower[];
    sinceMonths?: number;
    now?: Date;
    expected: number | null;
  }> = [
    {
      name: 'uses qualifying rides, skips null/empty power, excludes old rides, rounds to int',
      activities: [
        { startedAt: '2026-07-25T12:00:00Z', power1Hz: recentPower }, // 1 month ago
        { startedAt: '2026-01-25T12:00:00Z', power1Hz: Array<number>(1200).fill(400) }, // 7 months ago
        { startedAt: '2026-07-24T12:00:00Z', power1Hz: null },
        { startedAt: '2026-07-23T12:00:00Z', power1Hz: [] },
      ],
      sinceMonths: 6,
      now,
      expected: 238,
    },
    {
      name: 'returns the best across qualifying rides',
      activities: [
        { startedAt: '2026-07-25T12:00:00Z', power1Hz: Array<number>(1200).fill(200) },
        { startedAt: '2026-07-20T12:00:00Z', power1Hz: recentPower },
      ],
      sinceMonths: 6,
      now,
      expected: 238,
    },
    {
      name: 'skips activities shorter than 20 minutes',
      activities: [
        { startedAt: '2026-07-25T12:00:00Z', power1Hz: Array<number>(600).fill(300) }, // 10 min @ 300 W
        { startedAt: '2026-07-20T12:00:00Z', power1Hz: recentPower },
      ],
      sinceMonths: 6,
      now,
      expected: 238,
    },
    {
      name: 'only short activities -> null (no whole-array fallback inflation)',
      activities: [{ startedAt: '2026-07-25T12:00:00Z', power1Hz: Array<number>(600).fill(300) }],
      sinceMonths: 6,
      now,
      expected: null,
    },
    {
      name: 'no qualifying power data -> null',
      activities: [
        { startedAt: '2026-07-25T12:00:00Z', power1Hz: null },
        { startedAt: '2026-07-25T12:00:00Z', power1Hz: [] },
        { startedAt: '2026-01-25T12:00:00Z', power1Hz: Array<number>(1200).fill(400) },
      ],
      sinceMonths: 6,
      now,
      expected: null,
    },
    {
      name: 'empty activity list -> null',
      activities: [],
      sinceMonths: 6,
      now,
      expected: null,
    },
    {
      name: 'uses default sinceMonths and now',
      activities: [
        {
          startedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
          power1Hz: recentPower,
        },
      ],
      expected: 238,
    },
  ];

  it.each(cases)('$name', ({ activities, sinceMonths, now, expected }) => {
    expect(ftpFromHistory(activities, sinceMonths, now)).toBe(expected);
  });
});
