import type { Leg, SessionSnapshot } from '@opencycle/shared';
import { describe, expect, it } from 'vitest';

import {
  arrivalChip,
  fmtClock,
  honorRoll,
  legLabel,
  legObjective,
  legOnTargetPct,
  legRemainingS,
  legToast,
  objectiveLegCount,
  routeHeader,
} from './hud.js';

type RiderSnapshot = SessionSnapshot['riders'][number];

function leg(overrides: Partial<Leg> = {}): Leg {
  return {
    index: 0,
    kind: 'burn',
    label: 'BURN 1/4',
    startS: 0,
    endS: 240,
    startPctFtp: 1,
    endPctFtp: 1,
    objective: true,
    ...overrides,
  };
}

function rider(overrides: Partial<RiderSnapshot> = {}): RiderSnapshot {
  return {
    riderId: 'r1',
    name: 'Rider One',
    ftpW: 250,
    trainerId: 't1',
    workoutId: 'w1',
    workoutName: 'VO2max 4x4',
    state: 'riding',
    stepIndex: 0,
    stepRemainingS: 100,
    workoutRemainingS: 1220,
    stepKind: 'interval',
    stepCueRemainingS: 100,
    nextTargetW: 120,
    targetW: 250,
    biasPct: 0,
    elapsedS: 100,
    distanceM: 1200,
    ergGuardActive: false,
    workoutClockS: 100,
    legs: [leg()],
    legIndex: 0,
    legTargetedS: 55,
    legOnTargetS: 50,
    surveysClean: 0,
    ...overrides,
  };
}

function session(riders: RiderSnapshot[]): SessionSnapshot {
  return {
    id: 's1',
    startedAt: 1,
    riders,
    destination: { seed: 'r1:voyage:0', name: 'Kepler Tau', voyageIndex: 0, leadRiderId: 'r1' },
  };
}

describe('legObjective', () => {
  it.each([
    ['burn', 'HOLD CADENCE TO FINISH THE BURN'],
    ['cruise', 'HOLD STEADY'],
    ['climb', 'FOLLOW THE RAMP'],
    ['coast', 'SPIN EASY'],
    ['launch', 'WARM UP'],
    ['approach', 'COOL DOWN'],
    ['free', 'RIDE FREE'],
  ] as const)('%s', (kind, copy) => {
    expect(legObjective(leg({ kind, objective: kind === 'burn' }))).toBe(copy);
  });
});

describe('legLabel', () => {
  it('prefers the snapshot label (burn numbering)', () => {
    expect(legLabel('burn', leg({ label: 'BURN 3/4' }))).toBe('BURN 3/4');
  });

  it('falls back to the kind label without a leg', () => {
    expect(legLabel('cruise', null)).toBe('CRUISE');
    expect(legLabel('free', null)).toBe('OPEN SPACE');
  });
});

describe('legRemainingS', () => {
  it('counts down the leg on the workout clock', () => {
    expect(legRemainingS(leg({ startS: 450, endS: 690 }), 500)).toBe(190);
  });

  it('clamps at zero once the leg has ended', () => {
    expect(legRemainingS(leg({ startS: 450, endS: 690 }), 800)).toBe(0);
  });

  it('is null without a workout clock', () => {
    expect(legRemainingS(leg(), null)).toBeNull();
  });
});

describe('objectiveLegCount', () => {
  it('counts objective legs only', () => {
    expect(
      objectiveLegCount([
        leg({ index: 0, kind: 'launch', objective: false }),
        leg({ index: 1, objective: true }),
        leg({ index: 2, kind: 'coast', objective: false }),
        leg({ index: 3, objective: true }),
      ]),
    ).toBe(2);
  });

  it('is 0 without legs', () => {
    expect(objectiveLegCount(null)).toBe(0);
  });
});

describe('legOnTargetPct', () => {
  it('rounds the on-target share', () => {
    expect(legOnTargetPct(55, 55)).toBe(100);
    expect(legOnTargetPct(55, 40)).toBe(73);
  });

  it('is 0 when nothing was targeted', () => {
    expect(legOnTargetPct(0, 0)).toBe(0);
  });
});

describe('routeHeader', () => {
  it('numbers the leg and names the destination', () => {
    expect(routeHeader({ seed: 's', name: 'Kepler Tau', voyageIndex: 23, leadRiderId: 'r1' }, 1220)).toEqual({
      left: 'LEG 24 · BOUND FOR Kepler Tau',
      right: 'ARRIVAL IN 20:20',
    });
  });

  it('reports orbit once the workout clock is gone', () => {
    expect(routeHeader({ seed: 's', name: 'Oris', voyageIndex: 0, leadRiderId: 'r1' }, null)).toEqual({
      left: 'LEG 1 · BOUND FOR Oris',
      right: 'IN ORBIT',
    });
  });

  it('reports the arrival once the lead rider has finished', () => {
    expect(routeHeader({ seed: 's', name: 'Anoris', voyageIndex: 0, leadRiderId: 'r1' }, null, true)).toEqual({
      left: 'LEG 1 · ARRIVED AT Anoris',
      right: 'IN ORBIT',
    });
  });

  it('drops the countdown the moment the arrival lands, clock or not', () => {
    expect(routeHeader({ seed: 's', name: 'Anoris', voyageIndex: 3, leadRiderId: 'r1' }, 620, true)).toEqual({
      left: 'LEG 4 · ARRIVED AT Anoris',
      right: 'IN ORBIT',
    });
  });
});

describe('arrivalChip', () => {
  it('names the system and the surveys it revealed', () => {
    expect(arrivalChip('Anoris', 1, 4)).toBe('ARRIVED · Anoris · 1/4 SURVEYED');
  });

  it('reports a clean sweep', () => {
    expect(arrivalChip('Hydune', 4, 4)).toBe('ARRIVED · Hydune · 4/4 SURVEYED');
  });
});

describe('legToast', () => {
  it('locks the survey on a clean leg', () => {
    expect(
      legToast({ legKind: 'burn', leg: leg(), clean: true, targetedS: 55, onTargetS: 55 }, null),
    ).toEqual({ text: 'BURN 1/4 COMPLETE · SURVEY LOCKED', tone: 'on' });
  });

  it('reports the on-target share on an unclean leg', () => {
    expect(
      legToast({ legKind: 'burn', leg: leg(), clean: false, targetedS: 55, onTargetS: 40 }, null),
    ).toEqual({ text: 'BURN 1/4 COMPLETE · 73% ON TARGET', tone: 'neutral' });
  });

  it('prefixes the rider name in multi-rider sessions', () => {
    expect(
      legToast({ legKind: 'cruise', leg: null, clean: true, targetedS: 600, onTargetS: 600 }, 'Rider Two'),
    ).toEqual({ text: 'Rider Two · CRUISE COMPLETE · SURVEY LOCKED', tone: 'on' });
  });

  it('reports 0% when the leg never targeted', () => {
    expect(
      legToast({ legKind: 'coast', leg: null, clean: false, targetedS: 0, onTargetS: 0 }, null).text,
    ).toBe('COAST COMPLETE · 0% ON TARGET');
  });
});

describe('honorRoll', () => {
  it('lists answered rescues in order with rider names', () => {
    const s = session([rider({ riderId: 'r1', name: 'Rider One' }), rider({ riderId: 'r2', name: 'Rider Two' })]);
    expect(
      honorRoll(s, [
        { kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1 },
        { kind: 'rescue', helperId: 'r1', riderId: 'r2', ts: 2 },
      ]),
    ).toEqual([
      'Rescue answered — Rider Two covered Rider One',
      'Rescue answered — Rider One covered Rider Two',
    ]);
  });

  it('falls back to the rider id when the snapshot no longer has them', () => {
    expect(honorRoll(session([]), [{ kind: 'rescue', helperId: 'r9', riderId: 'r8', ts: 1 }])).toEqual([
      'Rescue answered — r9 covered r8',
    ]);
  });

  it('is empty without rescue events', () => {
    expect(honorRoll(session([rider()]), [{ kind: 'workoutCompleted', riderId: 'r1', ts: 1 }])).toEqual([]);
  });
});

describe('fmtClock', () => {
  it.each([
    [0, '0:00'],
    [80, '1:20'],
    [1259, '20:59'],
    [3725, '1:02:05'],
  ] as const)('%i seconds is %s', (seconds, expected) => {
    expect(fmtClock(seconds)).toBe(expected);
  });

  it('rounds to the nearest second and clamps negatives', () => {
    expect(fmtClock(59.6)).toBe('1:00');
    expect(fmtClock(-5)).toBe('0:00');
  });
});
