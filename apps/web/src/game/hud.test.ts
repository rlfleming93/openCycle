import type { Leg, SessionSnapshot } from '@opencycle/shared';
import { describe, expect, it } from 'vitest';

import {
  STEP_WINDOW_ROWS,
  STEP_WINDOW_UNITS,
  arrivalChip,
  fmtClock,
  honorRoll,
  legFillFraction,
  legLabel,
  legLockFraction,
  legLockLabel,
  legObjective,
  legOnTargetPct,
  legRemainingS,
  legTargetLabel,
  legToast,
  objectiveLegCount,
  profilePlayhead,
  routeHeader,
  stepWindow,
  surveyMarker,
  surveyMarks,
  workoutHeader,
  workoutProfile,
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
  it('brings the raider down on a clean burn', () => {
    expect(
      legToast({ legKind: 'burn', leg: leg(), clean: true, targetedS: 55, onTargetS: 55 }, null),
    ).toEqual({ text: 'BURN 1/4 COMPLETE · RAIDER DOWN · SURVEY LOCKED', tone: 'on' });
  });

  it('lets the raider escape on an unclean burn', () => {
    expect(
      legToast({ legKind: 'burn', leg: leg(), clean: false, targetedS: 55, onTargetS: 40 }, null),
    ).toEqual({ text: 'BURN 1/4 COMPLETE · RAIDER ESCAPED · 73% ON TARGET', tone: 'neutral' });
  });

  it('keeps the plain copy on a clean non-burn leg', () => {
    expect(
      legToast({ legKind: 'cruise', leg: null, clean: true, targetedS: 600, onTargetS: 600 }, null),
    ).toEqual({ text: 'CRUISE COMPLETE · SURVEY LOCKED', tone: 'on' });
  });

  it('keeps the plain copy on an unclean non-burn leg', () => {
    expect(
      legToast({ legKind: 'climb', leg: null, clean: false, targetedS: 120, onTargetS: 60 }, null),
    ).toEqual({ text: 'CLIMB COMPLETE · 50% ON TARGET', tone: 'neutral' });
  });

  it('prefixes the rider name in multi-rider sessions', () => {
    expect(
      legToast({ legKind: 'cruise', leg: null, clean: true, targetedS: 600, onTargetS: 600 }, 'Rider Two'),
    ).toEqual({ text: 'Rider Two · CRUISE COMPLETE · SURVEY LOCKED', tone: 'on' });
  });

  it('prefixes the rider name on a pursuit too', () => {
    expect(
      legToast({ legKind: 'burn', leg: leg(), clean: false, targetedS: 55, onTargetS: 40 }, 'Rider Two'),
    ).toEqual({ text: 'Rider Two · BURN 1/4 COMPLETE · RAIDER ESCAPED · 73% ON TARGET', tone: 'neutral' });
  });

  it('reports 0% when the leg never targeted', () => {
    expect(
      legToast({ legKind: 'coast', leg: null, clean: false, targetedS: 0, onTargetS: 0 }, null).text,
    ).toBe('COAST COMPLETE · 0% ON TARGET');
  });
});

describe('legLockLabel', () => {
  it('rounds the lock share', () => {
    expect(legLockLabel(55, 55)).toBe('LOCK 100%');
    expect(legLockLabel(120, 86)).toBe('LOCK 72%');
    expect(legLockLabel(120, 119)).toBe('LOCK 99%');
  });

  it('reads as a dash until the leg has enough targeted seconds', () => {
    expect(legLockLabel(0, 0)).toBe('LOCK —');
    expect(legLockLabel(4.9, 4.9)).toBe('LOCK —');
    expect(legLockLabel(5, 2)).toBe('LOCK 40%');
  });
});

describe('legLockFraction', () => {
  it('is the raw on-target share once the lock reads', () => {
    expect(legLockFraction(120, 86)).toBeCloseTo(0.7167, 3);
    expect(legLockFraction(60, 60)).toBe(1);
  });

  it('is 0 while the lock is still a dash, and clamps above 1', () => {
    expect(legLockFraction(4, 4)).toBe(0);
    expect(legLockFraction(60, 90)).toBe(1);
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

describe('legTargetLabel', () => {
  const solo = { riders: 1, ftpW: 250, biasPct: 0 };

  it('reads watts the engine would hold for a single rider', () => {
    expect(legTargetLabel(leg({ startPctFtp: 0.88, endPctFtp: 0.88 }), solo)).toBe('220 W');
  });

  it('carries the ERG bias, like the server target', () => {
    expect(legTargetLabel(leg({ startPctFtp: 0.88, endPctFtp: 0.88 }), { ...solo, biasPct: 10 })).toBe('242 W');
    expect(legTargetLabel(leg({ startPctFtp: 0.88, endPctFtp: 0.88 }), { ...solo, biasPct: -15 })).toBe('187 W');
  });

  it('reads a ramp as a slope in watts', () => {
    expect(
      legTargetLabel(leg({ kind: 'climb', startPctFtp: 0.6, endPctFtp: 0.88 }), solo),
    ).toBe('150→220 W');
  });

  it('collapses a ramp whose ends land on the same watt', () => {
    expect(legTargetLabel(leg({ startPctFtp: 0.6, endPctFtp: 0.601 }), solo)).toBe('150 W');
  });

  it('reads %FTP once a session has two or more riders', () => {
    const fleet = { riders: 3, ftpW: 250, biasPct: 10 };
    expect(legTargetLabel(leg({ startPctFtp: 0.88, endPctFtp: 0.88 }), fleet)).toBe('88%');
    expect(legTargetLabel(leg({ kind: 'climb', startPctFtp: 0.75, endPctFtp: 0.88 }), fleet)).toBe('75→88%');
  });

  it('has no target to state on a free leg', () => {
    expect(legTargetLabel(leg({ kind: 'free', startPctFtp: null, endPctFtp: null }), solo)).toBe('FREE');
  });
});

describe('legFillFraction', () => {
  it('measures the leg on the workout clock', () => {
    expect(legFillFraction(leg({ startS: 100, endS: 300 }), 150)).toBe(0.25);
  });

  it('clamps outside the leg and without a clock', () => {
    expect(legFillFraction(leg({ startS: 100, endS: 300 }), 900)).toBe(1);
    expect(legFillFraction(leg({ startS: 100, endS: 300 }), 10)).toBe(0);
    expect(legFillFraction(leg(), null)).toBe(0);
  });
});

describe('workoutProfile', () => {
  // 5:00 warm-up at 50%, 4:00 burn at 120%, 5:00 coast at 50% — 14:00 total.
  const legs = [
    leg({ index: 0, kind: 'launch', startS: 0, endS: 300, startPctFtp: 0.5, endPctFtp: 0.5, objective: false }),
    leg({ index: 1, kind: 'burn', startS: 300, endS: 540, startPctFtp: 1.2, endPctFtp: 1.2 }),
    leg({ index: 2, kind: 'coast', startS: 540, endS: 840, startPctFtp: 0.5, endPctFtp: 0.5, objective: false }),
  ];

  it('sizes bars by duration share across the whole workout', () => {
    const profile = workoutProfile(legs);
    expect(profile.totalS).toBe(840);
    expect(profile.scale).toBe(1.2);
    expect(
      profile.bars.map((bar) => ({
        x: Number(bar.x.toFixed(4)),
        width: Number(bar.width.toFixed(4)),
        height: Number((1 - bar.top).toFixed(4)),
      })),
    ).toEqual([
      { x: 0, width: 0.3571, height: 0.4167 },
      { x: 0.3571, width: 0.2857, height: 1 },
      { x: 0.6429, width: 0.3571, height: 0.4167 },
    ]);
  });

  it('slopes ramp legs from the left edge top to the right edge top', () => {
    const [bar] = workoutProfile([
      leg({ kind: 'climb', startS: 0, endS: 600, startPctFtp: 0.5, endPctFtp: 1 }),
    ]).bars;
    expect(bar).toMatchObject({ ramp: true, top: 0.5, topRight: 0 });
  });

  it('keeps a flat leg unclipped', () => {
    expect(workoutProfile([leg({ startPctFtp: 0.9, endPctFtp: 0.9 })]).bars[0]?.ramp).toBe(false);
  });

  it('draws a free leg as a low stub rather than a claimed target', () => {
    const profile = workoutProfile([leg({ kind: 'free', startPctFtp: null, endPctFtp: null })]);
    expect(profile.scale).toBe(1);
    expect(profile.bars[0]?.top).toBeCloseTo(0.88);
  });

  it('keeps the scale at FTP when nothing reaches it', () => {
    expect(workoutProfile([leg({ startPctFtp: 0.6, endPctFtp: 0.6 })]).scale).toBe(1);
  });

  it('is empty without legs', () => {
    expect(workoutProfile(null)).toEqual({ bars: [], totalS: 0, scale: 1 });
  });
});

describe('profilePlayhead', () => {
  const legs = [leg({ index: 0, startS: 0, endS: 600 }), leg({ index: 1, startS: 600, endS: 1200 })];

  it('places the playhead by workout clock over the whole workout', () => {
    expect(profilePlayhead(legs, 300)).toBe(0.25);
    expect(profilePlayhead(legs, 1200)).toBe(1);
  });

  it('clamps and reads zero without a clock', () => {
    expect(profilePlayhead(legs, 5000)).toBe(1);
    expect(profilePlayhead(legs, null)).toBe(0);
    expect(profilePlayhead(null, 300)).toBe(0);
  });
});

describe('stepWindow', () => {
  it('holds the current row one plain row below the top', () => {
    expect(stepWindow(11, 4)).toEqual({ offset: 3, moreAbove: true, moreBelow: true });
  });

  it('does not scroll past the first row', () => {
    expect(stepWindow(11, 0)).toEqual({ offset: 0, moreAbove: false, moreBelow: true });
  });

  it('stops at the last row so the tail stays whole', () => {
    expect(stepWindow(11, 10)).toEqual({ offset: 5, moreAbove: true, moreBelow: false });
  });

  it('reserves the taller current row at the end of a long workout', () => {
    // A viewport of seven plain rows would cut 0.4 of a row off the bottom.
    const tail = stepWindow(13, 12, 7, 1.4);
    expect(tail.offset).toBeCloseTo(6.4);
    expect(tail).toMatchObject({ moreAbove: true, moreBelow: false });
    expect(stepWindow(13, 1, 7, 1.4)).toEqual({ offset: 0, moreAbove: false, moreBelow: true });
  });

  it('lands the tail on a row boundary for the sidebar viewport', () => {
    expect(stepWindow(13, 12)).toEqual({ offset: 7, moreAbove: true, moreBelow: false });
    expect(stepWindow(13, 11)).toEqual({ offset: 7, moreAbove: true, moreBelow: false });
  });

  it('sizes that viewport as whole rows plus the taller current row', () => {
    expect(STEP_WINDOW_UNITS).toBeCloseTo(6.4);
    expect(STEP_WINDOW_ROWS).toBe(6);
  });

  it('never scrolls a list shorter than the window', () => {
    expect(stepWindow(4, 3)).toEqual({ offset: 0, moreAbove: false, moreBelow: false });
    expect(stepWindow(0, null).offset).toBe(0);
  });
});

describe('surveyMarks', () => {
  it('maps a rider’s own completed objective legs', () => {
    const marks = surveyMarks(
      [
        { kind: 'legCompleted', riderId: 'r1', legIndex: 2, legKind: 'burn', objective: true, targetedS: 200, onTargetS: 180, clean: true, ts: 1 },
        { kind: 'legCompleted', riderId: 'r1', legIndex: 3, legKind: 'coast', objective: false, targetedS: 0, onTargetS: 0, clean: true, ts: 2 },
        { kind: 'legCompleted', riderId: 'r2', legIndex: 4, legKind: 'burn', objective: true, targetedS: 200, onTargetS: 90, clean: false, ts: 3 },
        { kind: 'legCompleted', riderId: 'r1', legIndex: 5, legKind: 'climb', objective: true, targetedS: 200, onTargetS: 90, clean: false, ts: 4 },
      ],
      'r1',
    );
    expect(marks).toEqual({ 2: true, 5: false });
  });

  it('ignores legs that never reported', () => {
    expect(surveyMarks([{ kind: 'workoutCompleted', riderId: 'r1', ts: 9 }], 'r1')).toEqual({});
  });
});

describe('surveyMarker', () => {
  it('reads a clean leg and a missed one apart', () => {
    expect(surveyMarker(true)).toEqual({ glyph: '✓', title: 'Survey locked — clean leg', clean: true });
    expect(surveyMarker(false)).toEqual({ glyph: '·', title: 'No survey — leg not clean', clean: false });
  });

  it('is null for a leg with no survey to show', () => {
    expect(surveyMarker(undefined)).toBeNull();
  });
});

describe('workoutHeader', () => {
  it('pairs the workout clock with the whole workout', () => {
    expect(workoutHeader('VO2max 4x4', 750, 1800, 1050)).toEqual({
      name: 'VO2max 4x4',
      clock: '12:30 / 30:00',
      remaining: '17:30 LEFT',
    });
  });

  it('reads complete once the workout clock is gone', () => {
    expect(workoutHeader('VO2max 4x4', null, 1800, null)).toEqual({
      name: 'VO2max 4x4',
      clock: '30:00 / 30:00',
      remaining: 'COMPLETE',
    });
  });

  it('falls back to WORKOUT without a name', () => {
    expect(workoutHeader(undefined, 0, 1800, 1800).name).toBe('WORKOUT');
  });
});
