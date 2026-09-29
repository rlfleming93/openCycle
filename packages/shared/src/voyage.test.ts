import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isCleanLeg, nameFromSeed, resolveLegs, voyageSeed } from './voyage.js';
import { resolveSteps, WorkoutSchema, type Workout } from './workout.js';

function library(id: string): Workout {
  const url = new URL(`../../../data/plans/${id}.json`, import.meta.url);
  return WorkoutSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

function workout(steps: Workout['steps']): Workout {
  return { id: 'w', name: 'W', description: '', tags: [], steps };
}

describe('resolveLegs', () => {
  it('flies VO2max 4x4 as two launch legs, four burn/coast pairs and an approach', () => {
    const legs = resolveLegs(library('vo2max-4x4'));
    expect(legs.map((l) => [l.kind, l.endS - l.startS])).toEqual([
      ['launch', 450],
      ['launch', 450],
      ['burn', 240], ['coast', 180],
      ['burn', 240], ['coast', 180],
      ['burn', 240], ['coast', 180],
      ['burn', 240], ['coast', 180],
      ['approach', 600],
    ]);
    expect(legs.filter((l) => l.kind === 'burn').map((l) => l.label)).toEqual([
      'BURN 1/4', 'BURN 2/4', 'BURN 3/4', 'BURN 4/4',
    ]);
    expect(legs.filter((l) => l.objective).map((l) => l.kind)).toEqual(['burn', 'burn', 'burn', 'burn']);
  });

  it('shares the resolveSteps clock: legs tile the workout with no gaps', () => {
    const w = library('vo2max-4x4');
    const legs = resolveLegs(w);
    const steps = resolveSteps(w);
    expect(legs[0]?.startS).toBe(0);
    for (let i = 1; i < legs.length; i++) expect(legs[i]?.startS).toBe(legs[i - 1]?.endS);
    expect(legs.at(-1)?.endS).toBe(steps.at(-1)?.endS);
    expect(legs.map((l) => l.index)).toEqual(legs.map((_, i) => i));
  });

  it('splits a long endurance cruise into 600 s legs', () => {
    const legs = resolveLegs(library('endurance-z2-120'));
    const cruise = legs.filter((l) => l.kind === 'cruise');
    expect(cruise).toHaveLength(11);
    expect(cruise.every((l) => l.endS - l.startS === 600 && l.label === 'CRUISE' && l.objective)).toBe(true);
    expect(legs[0]?.kind).toBe('launch');
    expect(legs.at(-1)?.kind).toBe('approach');
  });

  it('interpolates %FTP across split ramp legs and gives the remainder to the last leg', () => {
    const legs = resolveLegs(
      workout([
        { kind: 'steady', seconds: 60, targetPctFtp: 0.8 },
        { kind: 'ramp', seconds: 1300, fromPctFtp: 0.6, toPctFtp: 1.25 },
        { kind: 'steady', seconds: 60, targetPctFtp: 0.8 },
      ]),
    );
    const ramp = legs.filter((l) => l.kind === 'climb');
    expect(ramp.map((l) => l.endS - l.startS)).toEqual([433, 433, 434]);
    expect(ramp[0]?.startPctFtp).toBeCloseTo(0.6);
    expect(ramp[0]?.endPctFtp).toBeCloseTo(0.6 + 0.65 * (433 / 1300));
    expect(ramp[1]?.startPctFtp).toBeCloseTo(ramp[0]!.endPctFtp!);
    expect(ramp[2]?.endPctFtp).toBeCloseTo(1.25);
    expect(ramp.every((l) => l.label === 'CLIMB' && l.objective)).toBe(true);
  });

  it('classifies steady steps by position and intensity', () => {
    const kinds = resolveLegs(
      workout([
        { kind: 'steady', seconds: 60, targetPctFtp: 0.5 },
        { kind: 'steady', seconds: 60, targetPctFtp: 0.5 },
        { kind: 'steady', seconds: 60, targetPctFtp: 0.75 },
        { kind: 'steady', seconds: 60, targetPctFtp: 0.88 },
        { kind: 'ramp', seconds: 60, fromPctFtp: 0.9, toPctFtp: 0.6 },
        { kind: 'steady', seconds: 60, targetPctFtp: 0.9 },
      ]),
    ).map((l) => l.kind);
    expect(kinds).toEqual(['launch', 'coast', 'cruise', 'burn', 'coast', 'burn']);
  });

  it('flies a free step as OPEN SPACE with no target', () => {
    const [leg] = resolveLegs(workout([{ kind: 'free', seconds: 300 }]));
    expect(leg).toMatchObject({ kind: 'free', label: 'OPEN SPACE', startPctFtp: null, endPctFtp: null, objective: false });
  });
});

describe('isCleanLeg', () => {
  it('is clean at exactly 85% on target with exactly 20 targeted seconds', () => {
    expect(isCleanLeg(true, 20, 17)).toBe(true);
    expect(isCleanLeg(true, 20, 16.99)).toBe(false);
    expect(isCleanLeg(true, 19.99, 19.99)).toBe(false);
  });

  it('is never clean on a non-objective leg', () => {
    expect(isCleanLeg(false, 200, 200)).toBe(false);
  });
});

describe('nameFromSeed', () => {
  it('keeps the name the old client planetName produced for the same seed', () => {
    expect(nameFromSeed('abc')).toBe('Cyphel');
  });

  it('names voyage destinations from the rider id and index', () => {
    expect(voyageSeed('rider-1', 0)).toBe('rider-1:voyage:0');
    expect(nameFromSeed(voyageSeed('rider-1', 0))).toBe('Ormara');
  });
});
