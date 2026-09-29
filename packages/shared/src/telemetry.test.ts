import { describe, expect, it } from 'vitest';

import { DeviceInfoSchema, DeviceKindSchema, RiderSlotSchema } from './devices.js';
import { RiderProfileSchema } from './profile.js';
import { TelemetrySampleSchema } from './telemetry.js';

type ParseCase = [label: string, data: unknown, expected: boolean];

function parseResult(schema: { safeParse(data: unknown): { success: boolean } }, data: unknown): boolean {
  return schema.safeParse(data).success;
}

describe('TelemetrySampleSchema', () => {
  const cases: ParseCase[] = [
    ['accepts a minimal sample', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, speedKmh: 32.4, distanceM: 1234.5 }, true],
    ['accepts a full sample', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 0, cadenceRpm: 0, hrBpm: 145, hrRrMs: [800, 812.5], speedKmh: 0, distanceM: 0, targetW: 210 }, true],
    ['rejects negative powerW', { riderId: 'r1', ts: 1_720_000_000_000, powerW: -1, cadenceRpm: 90, speedKmh: 32, distanceM: 0 }, false],
    ['rejects negative cadenceRpm', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: -1, speedKmh: 32, distanceM: 0 }, false],
    ['rejects hrBpm below 20', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, hrBpm: 15, speedKmh: 32, distanceM: 0 }, false],
    ['rejects hrBpm above 250', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, hrBpm: 251, speedKmh: 32, distanceM: 0 }, false],
    ['rejects negative speedKmh', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, speedKmh: -0.1, distanceM: 0 }, false],
    ['rejects negative distanceM', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, speedKmh: 32, distanceM: -1 }, false],
    ['rejects negative hrRrMs', { riderId: 'r1', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, hrRrMs: [-800], speedKmh: 32, distanceM: 0 }, false],
    ['rejects missing riderId', { ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, speedKmh: 32, distanceM: 0 }, false],
    ['rejects empty riderId', { riderId: '', ts: 1_720_000_000_000, powerW: 200, cadenceRpm: 90, speedKmh: 32, distanceM: 0 }, false],
    ['rejects ts of 0', { riderId: 'r1', ts: 0, powerW: 200, cadenceRpm: 90, speedKmh: 32, distanceM: 0 }, false],
    ['rejects negative ts', { riderId: 'r1', ts: -1_720_000_000_000, powerW: 200, cadenceRpm: 90, speedKmh: 32, distanceM: 0 }, false],
    ['rejects fractional ts', { riderId: 'r1', ts: 1_720_000_000_000.5, powerW: 200, cadenceRpm: 90, speedKmh: 32, distanceM: 0 }, false],
  ];

  it.each(cases)('%s', (_label, data, expected) => {
    expect(parseResult(TelemetrySampleSchema, data)).toBe(expected);
  });
});

describe('DeviceKindSchema', () => {
  const cases: ParseCase[] = [
    ['accepts trainer', 'trainer', true],
    ['accepts hrm', 'hrm', true],
    ['rejects unknown kind', 'bike', false],
    ['rejects non-string', 42, false],
  ];

  it.each(cases)('%s', (_label, data, expected) => {
    expect(parseResult(DeviceKindSchema, data)).toBe(expected);
  });
});

describe('DeviceInfoSchema', () => {
  const cases: ParseCase[] = [
    ['accepts a device', { id: 'A1B2C3D4', kind: 'trainer', name: 'KICKR CORE', lastSeen: 1_720_000_000_000 }, true],
    ['rejects empty id', { id: '', kind: 'trainer', name: 'KICKR CORE', lastSeen: 1_720_000_000_000 }, false],
    ['rejects unknown kind', { id: 'A1B2C3D4', kind: 'watch', name: 'KICKR CORE', lastSeen: 1_720_000_000_000 }, false],
    ['rejects missing lastSeen', { id: 'A1B2C3D4', kind: 'trainer', name: 'KICKR CORE' }, false],
    ['rejects negative lastSeen', { id: 'A1B2C3D4', kind: 'trainer', name: 'KICKR CORE', lastSeen: -1 }, false],
  ];

  it.each(cases)('%s', (_label, data, expected) => {
    expect(parseResult(DeviceInfoSchema, data)).toBe(expected);
  });
});

describe('RiderSlotSchema', () => {
  const cases: ParseCase[] = [
    ['accepts a rider with no devices', { riderId: 'p1' }, true],
    ['accepts a fully paired rider', { riderId: 'p1', trainerId: 'A1B2C3D4', hrmId: 'E5F6A7B8' }, true],
    ['rejects empty riderId', { riderId: '', trainerId: 'A1B2C3D4' }, false],
    ['rejects missing riderId', { trainerId: 'A1B2C3D4' }, false],
    ['rejects empty trainerId', { riderId: 'p1', trainerId: '' }, false],
    ['rejects empty hrmId', { riderId: 'p1', hrmId: '' }, false],
  ];

  it.each(cases)('%s', (_label, data, expected) => {
    expect(parseResult(RiderSlotSchema, data)).toBe(expected);
  });
});

describe('RiderProfileSchema', () => {
  const cases: ParseCase[] = [
    ['accepts a minimal profile', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75 }, true],
    ['accepts a full profile', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, restingHr: 48, maxHr: 186, garmin: { email: 'ryan@example.com' } }, true],
    ['accepts garmin autoUpload true', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, garmin: { email: 'ryan@example.com', autoUpload: true } }, true],
    ['accepts garmin autoUpload false', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, garmin: { email: 'ryan@example.com', autoUpload: false } }, true],
    ['rejects non-boolean autoUpload', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, garmin: { email: 'ryan@example.com', autoUpload: 'yes' } }, false],
    ['rejects empty id', { id: '', name: 'Ryan', ftpW: 250, weightKg: 75 }, false],
    ['rejects empty name', { id: 'p1', name: '', ftpW: 250, weightKg: 75 }, false],
    ['rejects ftpW below 50', { id: 'p1', name: 'Ryan', ftpW: 49, weightKg: 75 }, false],
    ['rejects ftpW above 600', { id: 'p1', name: 'Ryan', ftpW: 601, weightKg: 75 }, false],
    ['rejects fractional ftpW', { id: 'p1', name: 'Ryan', ftpW: 250.5, weightKg: 75 }, false],
    ['rejects weightKg below 30', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 29.9 }, false],
    ['rejects weightKg above 200', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 200.1 }, false],
    ['rejects restingHr below 25', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, restingHr: 24 }, false],
    ['rejects restingHr above 100', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, restingHr: 101 }, false],
    ['rejects fractional restingHr', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, restingHr: 48.5 }, false],
    ['rejects maxHr below 120', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, maxHr: 119 }, false],
    ['rejects maxHr above 230', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, maxHr: 231 }, false],
    ['rejects bad email', { id: 'p1', name: 'Ryan', ftpW: 250, weightKg: 75, garmin: { email: 'not-an-email' } }, false],
  ];

  it.each(cases)('%s', (_label, data, expected) => {
    expect(parseResult(RiderProfileSchema, data)).toBe(expected);
  });
});
