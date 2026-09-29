import { describe, expect, it } from 'vitest';
import type { IndoorBikeData } from './ftms.js';
import {
  CONTROL_POINT,
  FEATURE,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA,
  MACHINE_STATUS,
  RESULT_CONTROL_NOT_PERMITTED,
  RESULT_SUCCESS,
  STATUS_CONTROL_LOST,
  SUPPORTED_POWER_RANGE,
  encodeRequestControl,
  encodeReset,
  encodeSetTargetPower,
  encodeStart,
  encodeStop,
  parseControlResponse,
  parseFeature,
  parseIndoorBikeData,
  parseMachineStatus,
  parseSupportedPowerRange,
} from './ftms.js';

function bytes(hex: string): Uint8Array {
  if (hex === '') return new Uint8Array(0);
  return new Uint8Array(hex.split(' ').map((b) => parseInt(b, 16)));
}

describe('FTMS constants', () => {
  it('exposes the service + characteristic UUIDs from the protocol reference', () => {
    expect(FTMS_SERVICE_UUID).toBe('1826');
    expect(FEATURE).toBe('2acc');
    expect(INDOOR_BIKE_DATA).toBe('2ad2');
    expect(SUPPORTED_POWER_RANGE).toBe('2ad8');
    expect(CONTROL_POINT).toBe('2ad9');
    expect(MACHINE_STATUS).toBe('2ada');
  });

  it('exposes the result/status constants from the protocol reference', () => {
    expect(RESULT_SUCCESS).toBe(0x01);
    expect(RESULT_CONTROL_NOT_PERMITTED).toBe(0x05);
    expect(STATUS_CONTROL_LOST).toBe(0xff);
  });
});

describe('control point encoders', () => {
  const cases: Array<{ name: string; encode: () => Uint8Array; hex: string }> = [
    { name: 'request control', encode: () => encodeRequestControl(), hex: '00' },
    { name: 'reset', encode: () => encodeReset(), hex: '01' },
    { name: 'start', encode: () => encodeStart(), hex: '07' },
    { name: 'stop', encode: () => encodeStop(), hex: '08 01' },
    { name: 'set target power 200 W', encode: () => encodeSetTargetPower(200), hex: '05 C8 00' },
    { name: 'set target power 0 W', encode: () => encodeSetTargetPower(0), hex: '05 00 00' },
    { name: 'set target power -50 W (sint16 two\'s complement)', encode: () => encodeSetTargetPower(-50), hex: '05 CE FF' },
  ];

  it.each(cases)('$name → $hex', ({ encode, hex }) => {
    expect([...encode()]).toEqual([...bytes(hex)]);
  });
});

describe('parseIndoorBikeData', () => {
  const cases: Array<[string, string, Partial<IndoorBikeData>]> = [
    // Doc worked vector: 30.00 km/h, 90.0 rpm, 200 W (flags 0x0044 = bit2|bit6, bit0=0 ⇒ speed present).
    ['doc worked vector 30.00 km/h / 90 rpm / 200 W', '44 00 B8 0B B4 00 C8 00', { speedKmh: 30, cadenceRpm: 90, powerW: 200 }],
    // bit0=1 (More Data set) ⇒ instantaneous speed absent.
    ['bit0 set ⇒ speed absent', '45 00 B4 00 C8 00', { cadenceRpm: 90, powerW: 200 }],
    ['negative power (sint16)', '41 00 CE FF', { powerW: -50 }],
    ['uint24 total distance', '10 00 E8 03 40 E2 01', { speedKmh: 10, distanceM: 123456 }],
    ['distance only (bit0 set)', '11 00 40 E2 01', { distanceM: 123456 }],
    ['heart rate only (bit9)', '01 02 5A', { heartRateBpm: 90 }],
    // Skip non-contract fields in order to reach later ones.
    ['average speed skipped before power', '42 00 E8 03 D0 07 C8 00', { speedKmh: 10, powerW: 200 }],
    ['resistance skipped before power', '60 00 E8 03 32 00 C8 00', { speedKmh: 10, powerW: 200 }],
    [
      'all optional fields present (energy/MET/times skipped)',
      'FF 1F E8 03 B4 00 B4 00 40 E2 01 32 00 C8 00 C8 00 64 00 64 00 05 5A 0A 00 3C 00 1E',
      { cadenceRpm: 90, powerW: 200, distanceM: 123456, heartRateBpm: 90 },
    ],
    ['truncated frame returns what parsed', '44 00 B8 0B', { speedKmh: 30 }],
    ['empty frame', '', {}],
  ];

  it.each(cases)('%s', (_name, hex, expected) => {
    expect(parseIndoorBikeData(bytes(hex))).toEqual(expected);
  });
});

describe('parseFeature', () => {
  const cases: Array<[string, string, { cadenceSupported: boolean; powerMeasurementSupported: boolean; powerTargetSupported: boolean }]> = [
    // features 0x4002 = bit1 (cadence) + bit14 (power); target-setting 0x0008 = bit3 (power target).
    ['cadence + power measurement + power target', '02 40 00 00 08 00 00 00', { cadenceSupported: true, powerMeasurementSupported: true, powerTargetSupported: true }],
    ['power measurement only', '00 40 00 00 00 00 00 00', { cadenceSupported: false, powerMeasurementSupported: true, powerTargetSupported: false }],
    ['cadence + power target, no power measurement', '02 00 00 00 08 00 00 00', { cadenceSupported: true, powerMeasurementSupported: false, powerTargetSupported: true }],
    ['no bits set', '00 00 00 00 00 00 00 00', { cadenceSupported: false, powerMeasurementSupported: false, powerTargetSupported: false }],
    ['short buffer → missing target-setting reads as clear', '02 40 00 00', { cadenceSupported: true, powerMeasurementSupported: true, powerTargetSupported: false }],
  ];

  it.each(cases)('%s', (_name, hex, expected) => {
    expect(parseFeature(bytes(hex))).toEqual(expected);
  });
});

describe('parseSupportedPowerRange', () => {
  it.each([
    ['typical trainer range 0–2000 W in 5 W steps', '00 00 D0 07 05 00', { minW: 0, maxW: 2000, incrementW: 5 }],
    ['negative minimum (sint16)', '9C FF D0 07 01 00', { minW: -100, maxW: 2000, incrementW: 1 }],
  ] as Array<[string, string, { minW: number; maxW: number; incrementW: number }]>)('%s', (_name, hex, expected) => {
    expect(parseSupportedPowerRange(bytes(hex))).toEqual(expected);
  });
});

describe('parseControlResponse', () => {
  it.each([
    ['request-control success', '80 00 01', { requestOp: 0x00, result: 0x01 }],
    ['set-target-power success', '80 05 01', { requestOp: 0x05, result: 0x01 }],
    ['control not permitted', '80 00 05', { requestOp: 0x00, result: 0x05 }],
    ['start op not supported', '80 07 02', { requestOp: 0x07, result: 0x02 }],
  ] as Array<[string, string, { requestOp: number; result: number }]>)('%s', (_name, hex, expected) => {
    expect(parseControlResponse(bytes(hex))).toEqual(expected);
  });

  it('returns null for anything that is not a 0x80 response indication', () => {
    expect(parseControlResponse(bytes('05 C8 00'))).toBeNull();
    expect(parseControlResponse(bytes('80 05'))).toBeNull();
    expect(parseControlResponse(bytes(''))).toBeNull();
  });
});

describe('parseMachineStatus', () => {
  it.each([
    ['control permission lost', 'FF', { op: 0xff, controlLost: true }],
    ['reset', '01', { op: 0x01, controlLost: false }],
    ['started by user', '04', { op: 0x04, controlLost: false }],
    ['target power changed (500 W)', '08 F4 01', { op: 0x08, controlLost: false }],
    ['stopped/paused by user', '02 01', { op: 0x02, controlLost: false }],
  ] as Array<[string, string, { op: number; controlLost: boolean }]>)('%s', (_name, hex, expected) => {
    expect(parseMachineStatus(bytes(hex))).toEqual(expected);
  });
});
