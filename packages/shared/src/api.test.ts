import { describe, expect, it } from 'vitest';

import {
  RiderStartSchema,
  SessionSnapshotSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from './api.js';
import { SessionEventSchema } from './events.js';
import { TelemetrySampleSchema } from './telemetry.js';

type ParseCase = [label: string, data: unknown, expected: boolean];

function parseResult(schema: { safeParse(data: unknown): { success: boolean } }, data: unknown): boolean {
  return schema.safeParse(data).success;
}

function rider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    riderId: 'r1',
    name: 'Ryan',
    ftpW: 250,
    trainerId: 't1',
    hrmId: 'h1',
    workoutId: 'w1',
    workoutName: 'Sweet Spot',
    state: 'riding',
    stepIndex: 2,
    stepRemainingS: 600,
    workoutRemainingS: 480,
    stepKind: 'interval',
    stepCueRemainingS: 120,
    nextTargetW: 138,
    targetW: 225,
    biasPct: 0,
    elapsedS: 120,
    distanceM: 1200,
    ergGuardActive: false,
    workoutClockS: 300,
    legs: [
      { index: 0, kind: 'launch', label: 'LAUNCH', startS: 0, endS: 300, startPctFtp: 0.5, endPctFtp: 0.7, objective: false },
      { index: 1, kind: 'burn', label: 'BURN 1/1', startS: 300, endS: 540, startPctFtp: 1.15, endPctFtp: 1.15, objective: true },
    ],
    legIndex: 1,
    legTargetedS: 0,
    legOnTargetS: 0,
    surveysClean: 0,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    startedAt: 1_700_000_000_000,
    riders: [rider()],
    destination: { seed: 'r1:voyage:0', name: 'Cyphel', voyageIndex: 0, leadRiderId: 'r1' },
    ...overrides,
  };
}

describe('WsServerMessageSchema', () => {
  const sample = {
    riderId: 'r1',
    ts: 1_700_000_000_000,
    powerW: 200,
    cadenceRpm: 90,
    hrBpm: 150,
    speedKmh: 35.2,
    distanceM: 100.5,
    targetW: 225,
  };

  it.each([
    ['accepts a telemetry batch', { type: 'telemetry', samples: [sample, { ...sample, ts: sample.ts + 1 }] }, true],
    ['accepts an empty telemetry batch', { type: 'telemetry', samples: [] }, true],
    ['rejects a telemetry batch with a missing riderId', { type: 'telemetry', samples: [{ ...sample, riderId: undefined }] }, false],
    ['rejects a telemetry batch that is not an array', { type: 'telemetry', samples: sample }, false],

    ['accepts stepCompleted', { type: 'sessionEvent', event: { kind: 'stepCompleted', riderId: 'r1', stepIndex: 0, ts: 1000 } }, true],
    ['accepts workoutCompleted', { type: 'sessionEvent', event: { kind: 'workoutCompleted', riderId: 'r1', ts: 1000 } }, true],
    ['accepts bothInZone', { type: 'sessionEvent', event: { kind: 'bothInZone', ts: 1000, streakS: 30 } }, true],
    ['accepts ergGuard engaged', { type: 'sessionEvent', event: { kind: 'ergGuard', riderId: 'r1', engaged: true, ts: 1000 } }, true],
    ['accepts riderJoined', { type: 'sessionEvent', event: { kind: 'riderJoined', riderId: 'r1', ts: 1000 } }, true],
    ['accepts riderLeft', { type: 'sessionEvent', event: { kind: 'riderLeft', riderId: 'r1', ts: 1000 } }, true],
    ['accepts rescue', { type: 'sessionEvent', event: { kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 } }, true],
    ['rejects rescue missing helperId', { type: 'sessionEvent', event: { kind: 'rescue', riderId: 'r1', ts: 1000 } }, false],
    ['rejects a sessionEvent missing riderId', { type: 'sessionEvent', event: { kind: 'stepCompleted', stepIndex: 0, ts: 1000 } }, false],
    ['rejects a sessionEvent missing stepIndex', { type: 'sessionEvent', event: { kind: 'stepCompleted', riderId: 'r1', ts: 1000 } }, false],
    ['rejects a sessionEvent with unknown kind', { type: 'sessionEvent', event: { kind: 'danceParty', ts: 1000 } }, false],

    ['accepts deviceStatus', { type: 'deviceStatus', deviceId: 't1', kind: 'trainer', status: 'ok' }, true],
    ['rejects deviceStatus with unknown kind', { type: 'deviceStatus', deviceId: 't1', kind: 'bike', status: 'ok' }, false],
    ['rejects deviceStatus missing status', { type: 'deviceStatus', deviceId: 't1', kind: 'hrm' }, false],

    ['accepts a sessionState with null targetW, stepRemainingS and workoutRemainingS', { type: 'sessionState', session: snapshot({ riders: [rider({ targetW: null, stepRemainingS: null, workoutRemainingS: null })] }) }, true],
    ['accepts a sessionState with a free-ride rider (no workout fields)', { type: 'sessionState', session: snapshot({ riders: [rider({ workoutId: undefined, workoutName: undefined, targetW: null, stepRemainingS: null, workoutRemainingS: null, stepKind: null, stepCueRemainingS: null, nextTargetW: null })] }) }, true],
    ['accepts a sessionState with a null session (terminal frame)', { type: 'sessionState', session: null }, true],
    ['rejects a sessionState without a session', { type: 'sessionState' }, false],
    ['rejects a sessionState with biasPct out of range', { type: 'sessionState', session: snapshot({ riders: [rider({ biasPct: 16 })] }) }, false],
    ['rejects a sessionState with unknown rider state', { type: 'sessionState', session: snapshot({ riders: [rider({ state: 'jumping' })] }) }, false],
    ['rejects a sessionState with negative distance', { type: 'sessionState', session: snapshot({ riders: [rider({ distanceM: -1 })] }) }, false],
    ['rejects a sessionState with ftpW below range', { type: 'sessionState', session: snapshot({ riders: [rider({ ftpW: 10 })] }) }, false],

    ['accepts an error frame', { type: 'error', message: 'session already active' }, true],
    ['rejects an error frame without a message', { type: 'error' }, false],
    ['rejects an error frame with an empty message', { type: 'error', message: '' }, false],

    ['rejects an unknown message type', { type: 'restart' }, false],
  ] satisfies ParseCase[])('%s', (_label, data, expected) => {
    expect(parseResult(WsServerMessageSchema, data)).toBe(expected);
  });
});

describe('WsClientMessageSchema', () => {
  it.each([
    ['accepts startSession', { type: 'startSession', riders: [{ profileId: 'p1', trainerId: 't1', hrmId: 'h1', workoutId: 'w1' }] }, true],
    ['accepts startSession with optional fields omitted', { type: 'startSession', riders: [{ profileId: 'p1', trainerId: 't1' }] }, true],
    ['rejects startSession rider missing trainerId', { type: 'startSession', riders: [{ profileId: 'p1' }] }, false],
    ['rejects startSession with an empty riders array', { type: 'startSession', riders: [] }, false],

    ['accepts setBias', { type: 'setBias', riderId: 'r1', deltaPct: 1 }, true],
    ['rejects setBias with deltaPct above clamp range', { type: 'setBias', riderId: 'r1', deltaPct: 16 }, false],
    ['rejects setBias missing riderId', { type: 'setBias', deltaPct: 1 }, false],

    ['accepts pause', { type: 'pause', riderId: 'r1' }, true],
    ['accepts resume', { type: 'resume', riderId: 'r1' }, true],
    ['accepts skipStep', { type: 'skipStep', riderId: 'r1' }, true],
    ['accepts stopRider', { type: 'stopRider', riderId: 'r1' }, true],
    ['rejects pause missing riderId', { type: 'pause' }, false],
    ['rejects stopRider missing riderId', { type: 'stopRider', riderId: '' }, false],

    ['accepts stopSession', { type: 'stopSession' }, true],

    ['rejects an unknown message type', { type: 'start' }, false],
    ['rejects a server message sent client-side', { type: 'sessionState', session: snapshot() }, false],
  ] satisfies ParseCase[])('%s', (_label, data, expected) => {
    expect(parseResult(WsClientMessageSchema, data)).toBe(expected);
  });
});

describe('SessionSnapshotSchema', () => {
  it.each([
    ['accepts a full snapshot', snapshot(), true],
    ['accepts nullable cue fields', snapshot({ riders: [rider({
      stepKind: null,
      stepCueRemainingS: null,
      nextTargetW: null,
    })] }), true],
    ['rejects an unknown step kind', snapshot({ riders: [rider({ stepKind: 'sprint' })] }), false],
    ['rejects negative cue remaining', snapshot({ riders: [rider({ stepCueRemainingS: -1 })] }), false],
    ['rejects negative next target', snapshot({ riders: [rider({ nextTargetW: -1 })] }), false],
    ['rejects a missing step kind', snapshot({ riders: [rider({ stepKind: undefined })] }), false],
    ['accepts null targetW, stepRemainingS and workoutRemainingS', snapshot({ riders: [rider({ targetW: null, stepRemainingS: null, workoutRemainingS: null })] }), true],
    ['rejects a rider with negative workoutRemainingS', snapshot({ riders: [rider({ workoutRemainingS: -1 })] }), false],
    ['rejects a rider missing ergGuardActive', snapshot({ riders: [rider({ ergGuardActive: undefined })] }), false],
    ['rejects a snapshot missing startedAt', snapshot({ startedAt: undefined }), false],
    ['accepts a free-ride rider and no destination', snapshot({
      destination: null,
      riders: [rider({ workoutClockS: null, legs: null, legIndex: null })],
    }), true],
    ['rejects a snapshot missing destination', snapshot({ destination: undefined }), false],
    ['rejects a destination with a negative voyageIndex', snapshot({
      destination: { seed: 's', name: 'N', voyageIndex: -1, leadRiderId: 'r1' },
    }), false],
    ['rejects a leg with an unknown kind', snapshot({ riders: [rider({
      legs: [{ index: 0, kind: 'warp', label: 'WARP', startS: 0, endS: 10, startPctFtp: null, endPctFtp: null, objective: false }],
    })] }), false],
    ['rejects a fractional surveysClean', snapshot({ riders: [rider({ surveysClean: 1.5 })] }), false],
    ['rejects a rider missing legOnTargetS', snapshot({ riders: [rider({ legOnTargetS: undefined })] }), false],
  ] satisfies ParseCase[])('%s', (_label, data, expected) => {
    expect(parseResult(SessionSnapshotSchema, data)).toBe(expected);
  });
});

describe('RiderStartSchema', () => {
  it.each([
    ['accepts a full rider start', { profileId: 'p1', trainerId: 't1', hrmId: 'h1', workoutId: 'w1' }, true],
    ['accepts hrmId and workoutId omitted', { profileId: 'p1', trainerId: 't1' }, true],
    ['rejects a rider start missing profileId', { trainerId: 't1' }, false],
  ] satisfies ParseCase[])('%s', (_label, data, expected) => {
    expect(parseResult(RiderStartSchema, data)).toBe(expected);
  });
});

describe('SessionEventSchema', () => {
  it.each([
    ['accepts stepCompleted', { kind: 'stepCompleted', riderId: 'r1', stepIndex: 0, ts: 1000 }, true],
    ['accepts workoutCompleted', { kind: 'workoutCompleted', riderId: 'r1', ts: 1000 }, true],
    ['accepts bothInZone', { kind: 'bothInZone', ts: 1000, streakS: 30 }, true],
    ['accepts ergGuard', { kind: 'ergGuard', riderId: 'r1', engaged: false, ts: 1000 }, true],
    ['accepts riderJoined', { kind: 'riderJoined', riderId: 'r1', ts: 1000 }, true],
    ['accepts riderLeft', { kind: 'riderLeft', riderId: 'r1', ts: 1000 }, true],
    ['accepts rescue', { kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 }, true],
    ['accepts legCompleted', {
      kind: 'legCompleted', riderId: 'r1', legIndex: 2, legKind: 'burn', objective: true,
      targetedS: 235, onTargetS: 220, clean: true, ts: 1000,
    }, true],
    ['rejects legCompleted with fractional targetedS', {
      kind: 'legCompleted', riderId: 'r1', legIndex: 2, legKind: 'burn', objective: true,
      targetedS: 235.5, onTargetS: 220, clean: true, ts: 1000,
    }, false],
    ['rejects rescue missing riderId', { kind: 'rescue', helperId: 'r2', ts: 1000 }, false],
    ['rejects bothInZone with non-positive streakS', { kind: 'bothInZone', ts: 1000, streakS: 0 }, false],
    ['rejects stepCompleted with negative stepIndex', { kind: 'stepCompleted', riderId: 'r1', stepIndex: -1, ts: 1000 }, false],
    ['rejects an event with an unknown kind', { kind: 'crash', ts: 1000 }, false],
  ] satisfies ParseCase[])('%s', (_label, data, expected) => {
    expect(parseResult(SessionEventSchema, data)).toBe(expected);
  });
});

describe('TelemetrySampleSchema', () => {
  it.each([
    ['accepts a full sample', { riderId: 'r1', ts: 1000, powerW: 200, cadenceRpm: 90, hrBpm: 150, speedKmh: 35.2, distanceM: 100, targetW: 225 }, true],
    ['accepts optional fields omitted', { riderId: 'r1', ts: 1000, powerW: 0, cadenceRpm: 0, speedKmh: 0, distanceM: 0 }, true],
    ['rejects negative power', { riderId: 'r1', ts: 1000, powerW: -5, cadenceRpm: 90, speedKmh: 35.2, distanceM: 100 }, false],
  ] satisfies ParseCase[])('%s', (_label, data, expected) => {
    expect(parseResult(TelemetrySampleSchema, data)).toBe(expected);
  });
});
