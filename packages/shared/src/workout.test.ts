import { describe, expect, it } from 'vitest';
import { resolveSteps, workoutDurationS, WorkoutSchema } from './workout.js';
import type { Step, Workout } from './workout.js';

function mkWorkout(steps: Step[]): Workout {
  return { id: 'test-workout', name: 'Test', description: '', tags: [], steps };
}

describe('resolveSteps', () => {
  it('flattens steady steps with cumulative absolute times', () => {
    const result = resolveSteps(
      mkWorkout([
        { kind: 'steady', seconds: 300, targetPctFtp: 0.7 },
        { kind: 'steady', seconds: 600, targetPctFtp: 0.9 },
      ]),
    );
    expect(result).toEqual([
      { startS: 0, endS: 300, targetPctFtp: 0.7, sourceStepIndex: 0 },
      { startS: 300, endS: 900, targetPctFtp: 0.9, sourceStepIndex: 1 },
    ]);
  });

  it.each([
    {
      name: 'single repeat',
      repeats: 1,
      expected: [
        { startS: 0, endS: 60, targetPctFtp: 1.1, sourceStepIndex: 0 },
        { startS: 60, endS: 90, targetPctFtp: 0.5, sourceStepIndex: 0 },
      ],
    },
    {
      name: 'two repeats',
      repeats: 2,
      expected: [
        { startS: 0, endS: 60, targetPctFtp: 1.1, sourceStepIndex: 0 },
        { startS: 60, endS: 90, targetPctFtp: 0.5, sourceStepIndex: 0 },
        { startS: 90, endS: 150, targetPctFtp: 1.1, sourceStepIndex: 0 },
        { startS: 150, endS: 180, targetPctFtp: 0.5, sourceStepIndex: 0 },
      ],
    },
    {
      name: 'three repeats',
      repeats: 3,
      expected: [
        { startS: 0, endS: 300, targetPctFtp: 1.05, sourceStepIndex: 0 },
        { startS: 300, endS: 600, targetPctFtp: 0.55, sourceStepIndex: 0 },
        { startS: 600, endS: 900, targetPctFtp: 1.05, sourceStepIndex: 0 },
        { startS: 900, endS: 1200, targetPctFtp: 0.55, sourceStepIndex: 0 },
        { startS: 1200, endS: 1500, targetPctFtp: 1.05, sourceStepIndex: 0 },
        { startS: 1500, endS: 1800, targetPctFtp: 0.55, sourceStepIndex: 0 },
      ],
    },
  ])('expands intervals into repeats x (on, off) pairs: $name', ({ repeats, expected }) => {
    const result = resolveSteps(
      mkWorkout([
        {
          kind: 'interval',
          repeats,
          on: { seconds: repeats === 3 ? 300 : 60, targetPctFtp: repeats === 3 ? 1.05 : 1.1 },
          off: { seconds: repeats === 3 ? 300 : 30, targetPctFtp: repeats === 3 ? 0.55 : 0.5 },
        },
      ]),
    );
    expect(result).toEqual(expected);
  });

  it('keeps interval times cumulative across surrounding steps', () => {
    const result = resolveSteps(
      mkWorkout([
        { kind: 'steady', seconds: 100, targetPctFtp: 0.5 },
        {
          kind: 'interval',
          repeats: 3,
          on: { seconds: 300, targetPctFtp: 1.05 },
          off: { seconds: 300, targetPctFtp: 0.55 },
        },
        { kind: 'steady', seconds: 50, targetPctFtp: 0.5 },
      ]),
    );
    expect(result.map((s) => s.startS)).toEqual([0, 100, 400, 700, 1000, 1300, 1600, 1900]);
    expect(result.map((s) => s.endS)).toEqual([100, 400, 700, 1000, 1300, 1600, 1900, 1950]);
    expect(result.map((s) => s.targetPctFtp)).toEqual([0.5, 1.05, 0.55, 1.05, 0.55, 1.05, 0.55, 0.5]);
    // interval repeats and ramp sub-steps share their source step's index
    expect(result.map((s) => s.sourceStepIndex)).toEqual([0, 1, 1, 1, 1, 1, 1, 2]);
  });

  it('splits a 600 s ramp into 40 15 s sub-steps with midpoint interpolation', () => {
    const result = resolveSteps(mkWorkout([{ kind: 'ramp', seconds: 600, fromPctFtp: 0.4, toPctFtp: 0.8 }]));
    expect(result).toHaveLength(40);
    expect(result.every((s) => s.endS - s.startS === 15)).toBe(true);
    expect(result.map((s) => s.startS)).toEqual(Array.from({ length: 40 }, (_, i) => i * 15));
    expect(result.every((s) => s.sourceStepIndex === 0)).toBe(true);
    expect(result.at(-1)!.endS).toBe(600);
    // Midpoint interpolation: chunk i midpoint fraction = (i*15 + 7.5) / 600.
    expect(result[0]!.targetPctFtp).toBeCloseTo(0.405, 6);
    expect(result[19]!.targetPctFtp).toBeCloseTo(0.595, 6);
    expect(result[39]!.targetPctFtp).toBeCloseTo(0.795, 6);
  });

  it('splits a 100 s ramp into 7 chunks with a 10 s final chunk', () => {
    const result = resolveSteps(mkWorkout([{ kind: 'ramp', seconds: 100, fromPctFtp: 0.5, toPctFtp: 1 }]));
    expect(result).toHaveLength(7);
    expect(result.map((s) => s.endS - s.startS)).toEqual([15, 15, 15, 15, 15, 15, 10]);
    expect(result[0]!.targetPctFtp).toBeCloseTo(0.5375, 6); // mid 7.5/100
    expect(result[5]!.targetPctFtp).toBeCloseTo(0.9125, 6); // mid 82.5/100
    expect(result[6]!.targetPctFtp).toBeCloseTo(0.975, 6); // mid 95/100
    expect(result[6]!.startS).toBe(90);
    expect(result[6]!.endS).toBe(100);
  });

  it('emits free ride with null target', () => {
    expect(resolveSteps(mkWorkout([{ kind: 'free', seconds: 1200 }]))).toEqual([
      { startS: 0, endS: 1200, targetPctFtp: null, sourceStepIndex: 0 },
    ]);
  });

  it('ends at the total workout duration', () => {
    const workout = mkWorkout([
      { kind: 'steady', seconds: 600, targetPctFtp: 0.75 },
      {
        kind: 'interval',
        repeats: 3,
        on: { seconds: 300, targetPctFtp: 1.05 },
        off: { seconds: 300, targetPctFtp: 0.55 },
      },
      { kind: 'ramp', seconds: 300, fromPctFtp: 0.75, toPctFtp: 0.4 },
    ]);
    const result = resolveSteps(workout);
    expect(result.at(-1)!.endS).toBe(2700);
    expect(result.at(-1)!.endS).toBe(workoutDurationS(workout));
  });
});

describe('workoutDurationS', () => {
  it.each([
    {
      name: 'steady',
      steps: [{ kind: 'steady', seconds: 600, targetPctFtp: 0.8 } as Step],
      expected: 600,
    },
    {
      name: 'interval counts repeats x (on + off)',
      steps: [
        {
          kind: 'interval',
          repeats: 3,
          on: { seconds: 300, targetPctFtp: 1.05 },
          off: { seconds: 300, targetPctFtp: 0.55 },
        } as Step,
      ],
      expected: 1800,
    },
    {
      name: 'free ride',
      steps: [{ kind: 'free', seconds: 1200 } as Step],
      expected: 1200,
    },
    {
      name: 'ramp',
      steps: [{ kind: 'ramp', seconds: 600, fromPctFtp: 0.4, toPctFtp: 0.75 } as Step],
      expected: 600,
    },
    {
      name: 'mixed workout',
      steps: [
        { kind: 'steady', seconds: 600, targetPctFtp: 0.75 } as Step,
        {
          kind: 'interval',
          repeats: 2,
          on: { seconds: 300, targetPctFtp: 1.05 },
          off: { seconds: 300, targetPctFtp: 0.55 },
        } as Step,
        { kind: 'free', seconds: 1200 } as Step,
        { kind: 'ramp', seconds: 300, fromPctFtp: 0.75, toPctFtp: 0.4 } as Step,
        { kind: 'steady', seconds: 600, targetPctFtp: 0.5 } as Step,
      ],
      expected: 600 + 1200 + 1200 + 300 + 600,
    },
  ])('computes $name duration', ({ steps, expected }) => {
    expect(workoutDurationS(mkWorkout(steps))).toBe(expected);
  });
});

describe('WorkoutSchema', () => {
  it('accepts a valid workout', () => {
    expect(() => WorkoutSchema.parse(mkWorkout([{ kind: 'steady', seconds: 60, targetPctFtp: 0.5 }]))).not.toThrow();
  });

  it('rejects an empty steps array', () => {
    expect(() => WorkoutSchema.parse(mkWorkout([]))).toThrow();
  });

  it('rejects an unknown step kind', () => {
    expect(() =>
      WorkoutSchema.parse({ id: 'x', name: 'x', description: '', tags: [], steps: [{ kind: 'bogus', seconds: 60 }] }),
    ).toThrow();
  });

  it('rejects non-positive integer seconds', () => {
    expect(() =>
      WorkoutSchema.parse({
        id: 'x',
        name: 'x',
        description: '',
        tags: [],
        steps: [{ kind: 'steady', seconds: 0, targetPctFtp: 0.5 }],
      }),
    ).toThrow();
    expect(() =>
      WorkoutSchema.parse({
        id: 'x',
        name: 'x',
        description: '',
        tags: [],
        steps: [{ kind: 'steady', seconds: 60.5, targetPctFtp: 0.5 }],
      }),
    ).toThrow();
  });

  it('rejects out-of-range targetPctFtp', () => {
    expect(() =>
      WorkoutSchema.parse({
        id: 'x',
        name: 'x',
        description: '',
        tags: [],
        steps: [{ kind: 'steady', seconds: 60, targetPctFtp: 5.5 }],
      }),
    ).toThrow();
  });
});
