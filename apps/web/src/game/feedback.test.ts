import type { SessionSnapshot } from '@opencycle/shared';
import { describe, expect, it } from 'vitest';

import {
  getEffortCue,
  getWorkoutCommand,
  type EffortCue,
  type EffortCueInput,
  type EffortCueState,
} from './feedback.js';

type RiderSnapshot = SessionSnapshot['riders'][number];
type InputOverrides =
  & Partial<Omit<EffortCueInput, 'rider'>>
  & Partial<RiderSnapshot>;

function rider(overrides: Partial<RiderSnapshot> = {}): RiderSnapshot {
  return {
    riderId: 'r1',
    name: 'Ryan',
    ftpW: 200,
    trainerId: 't1',
    workoutId: 'w1',
    workoutName: 'Endurance',
    state: 'riding',
    stepIndex: 0,
    stepRemainingS: 38,
    workoutRemainingS: 300,
    stepKind: 'steady',
    stepCueRemainingS: 38,
    nextTargetW: 240,
    targetW: 200,
    biasPct: 0,
    elapsedS: 100,
    distanceM: 1000,
    ergGuardActive: false,
    workoutClockS: 100,
    legs: null,
    legIndex: null,
    legTargetedS: 0,
    legOnTargetS: 0,
    surveysClean: 0,
    ...overrides,
  };
}

function input(overrides: InputOverrides = {}): EffortCueInput {
  const {
    trainerStatus,
    avgPowerW = 200,
    cadenceRpm = 90,
    ...riderOverrides
  } = overrides;
  return {
    rider: rider(riderOverrides),
    trainerStatus,
    avgPowerW,
    cadenceRpm,
  };
}

describe('getEffortCue', () => {
  it.each([
    ['offline overrides all', { trainerStatus: 'disconnected', avgPowerW: 200, cadenceRpm: 90 }, 'unavailable', 'WAITING FOR TRAINER'],
    ['control loss overrides all', { trainerStatus: 'controlLost', avgPowerW: 200, cadenceRpm: 90 }, 'unavailable', 'WAITING FOR TRAINER'],
    ['error overrides all', { trainerStatus: 'error', avgPowerW: 200, cadenceRpm: 90 }, 'unavailable', 'WAITING FOR TRAINER'],
    ['connected trainer uses ratio', { trainerStatus: 'connected', avgPowerW: 179, cadenceRpm: 90 }, 'under', 'ADD 21 W'],
    ['stopped rider', { state: 'stopped', avgPowerW: 200, cadenceRpm: 90 }, 'stopped', 'PEDAL TO RESTART'],
    ['paused rider', { state: 'paused', avgPowerW: 200, cadenceRpm: 90 }, 'paused', 'PAUSED'],
    ['guard overrides ratio', { ergGuardActive: true, avgPowerW: 200, cadenceRpm: 90 }, 'guard', 'RECOVERY MODE'],
    ['missing telemetry', { avgPowerW: null, cadenceRpm: null }, 'unavailable', 'WAITING FOR TRAINER'],
    ['missing power telemetry', { avgPowerW: null, cadenceRpm: 90 }, 'unavailable', 'WAITING FOR TRAINER'],
    ['missing cadence telemetry', { avgPowerW: 200, cadenceRpm: null }, 'unavailable', 'WAITING FOR TRAINER'],
    ['zero cadence before free ride', { targetW: null, avgPowerW: 100, cadenceRpm: 5 }, 'stopped', 'PEDAL TO RESTART'],
    ['free ride', { targetW: null, avgPowerW: 100, cadenceRpm: 90 }, 'free', 'RIDE FREE'],
    ['under target', { avgPowerW: 179, cadenceRpm: 90 }, 'under', 'ADD 21 W'],
    ['lower edge locked', { avgPowerW: 180, cadenceRpm: 90 }, 'locked', 'ON TARGET'],
    ['upper edge locked', { avgPowerW: 220, cadenceRpm: 90 }, 'locked', 'ON TARGET'],
    ['over target', { avgPowerW: 221, cadenceRpm: 90 }, 'over', 'EASE 21 W'],
  ] satisfies Array<[string, InputOverrides, EffortCueState, string]>)('%s', (_label, overrides, state, instruction) => {
    const cue = getEffortCue(input(overrides));
    expect(cue).toMatchObject({ state, instruction });
  });

  it.each([
    ['unavailable', { trainerStatus: 'error' }, 'neutral'],
    ['under', { avgPowerW: 179 }, 'cool'],
    ['locked', { avgPowerW: 200 }, 'emerald'],
    ['over', { avgPowerW: 221 }, 'amber'],
    ['guard', { ergGuardActive: true }, 'amber'],
  ] satisfies Array<[string, InputOverrides, EffortCue['tone']]>)('%s uses the expected tone', (_state, overrides, tone) => {
    expect(getEffortCue(input(overrides)).tone).toBe(tone);
  });

  it('reports signed delta differences', () => {
    expect(getEffortCue(input({ avgPowerW: 179, cadenceRpm: 90 })).deltaW).toBe(21);
    expect(getEffortCue(input({ avgPowerW: 221, cadenceRpm: 90 })).deltaW).toBe(-21);
  });

  it('keeps signed delta inside the locked band', () => {
    expect(getEffortCue(input({ avgPowerW: 196, cadenceRpm: 90 }))).toMatchObject({
      state: 'locked',
      instruction: 'ON TARGET',
      deltaW: 4,
      tone: 'emerald',
    });
  });

  it('uses guard before the reduced active target ratio', () => {
    expect(getEffortCue(input({
      ergGuardActive: true,
      targetW: 100,
      avgPowerW: 100,
      cadenceRpm: 30,
    }))).toMatchObject({ state: 'guard', instruction: 'RECOVERY MODE' });
  });
});

describe('getWorkoutCommand', () => {
  it.each([
    ['steady', { stepKind: 'steady', targetW: 200, stepCueRemainingS: 38, nextTargetW: 240 }, 'HOLD 200 W', 'NEXT 240 W', 38],
    ['interval', { stepKind: 'interval', targetW: 240, stepCueRemainingS: 20, nextTargetW: 120 }, 'HOLD 240 W', 'NEXT 120 W', 20],
    ['ramp', { stepKind: 'ramp', targetW: 180, stepCueRemainingS: 60, nextTargetW: 240 }, 'RAMP TO 240 W', null, 60],
    ['free step', { stepKind: 'free', targetW: null, stepCueRemainingS: 45, nextTargetW: 160 }, 'RIDE FREE', 'NEXT 160 W', 45],
    ['paused overrides active step', { state: 'paused', stepKind: 'steady', targetW: 200, stepCueRemainingS: 38, nextTargetW: 240 }, 'PAUSED', null, null],
    ['stopped overrides active step', { state: 'stopped', stepKind: 'steady', targetW: 200, stepCueRemainingS: 38, nextTargetW: 240 }, 'STOPPED', null, null],
    ['completed workout', { workoutId: 'w1', stepKind: null, targetW: null, stepCueRemainingS: null, nextTargetW: null }, 'MISSION COMPLETE', null, null],
    ['unstructured free ride', { workoutId: undefined, stepKind: null, targetW: null, stepCueRemainingS: null, nextTargetW: null }, 'RIDE FREE', null, null],
  ] satisfies Array<[string, Partial<RiderSnapshot>, string, string | null, number | null]>)(
    '%s',
    (_label, overrides, primary, secondary, remainingS) => {
      expect(getWorkoutCommand(rider(overrides))).toEqual({ primary, secondary, remainingS });
    },
  );
});
