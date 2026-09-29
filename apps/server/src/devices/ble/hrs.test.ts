import { describe, expect, it } from 'vitest';
import { HR_MEASUREMENT_UUID, HRS_SERVICE_UUID, parseHeartRateMeasurement } from './hrs.js';

function bytes(hex: string): Uint8Array {
  if (hex === '') return new Uint8Array(0);
  return new Uint8Array(hex.split(' ').map((b) => parseInt(b, 16)));
}

describe('HRS constants', () => {
  it('exposes the service + measurement UUIDs from the protocol reference', () => {
    expect(HRS_SERVICE_UUID).toBe('180d');
    expect(HR_MEASUREMENT_UUID).toBe('2a37');
  });
});

describe('parseHeartRateMeasurement', () => {
  const cases: Array<[string, string, { bpm: number; rrMs: number[] }]> = [
    ['uint8 bpm, no RR', '00 3C', { bpm: 60, rrMs: [] }],
    // Doc worked vector: 150 bpm, contact, RR 800/1024 s → 781.25 ms.
    ['doc worked vector 150 bpm + RR 800/1024 s', '16 96 20 03', { bpm: 150, rrMs: [781.25] }],
    ['uint16 bpm flavor', '01 96 00', { bpm: 150, rrMs: [] }],
    // Two RR intervals, oldest first; 0x0400 = 1024 → 1000 ms; 0x07D0 = 2000 → 1953.125 ms.
    ['two RR intervals, oldest first', '10 5A 00 04 D0 07', { bpm: 90, rrMs: [1000, 1953.125] }],
    // flags 0x18: energy-expended (skipped) + RR present; 0x0400 = 1024 → 1000 ms.
    ['energy-expended field skipped', '18 3C 10 00 00 04', { bpm: 60, rrMs: [1000] }],
  ];

  it.each(cases)('%s', (_name, hex, expected) => {
    expect(parseHeartRateMeasurement(bytes(hex))).toEqual(expected);
  });

  it('tolerates truncated buffers', () => {
    expect(parseHeartRateMeasurement(bytes('01'))).toEqual({ bpm: 0, rrMs: [] });
    expect(parseHeartRateMeasurement(bytes(''))).toEqual({ bpm: 0, rrMs: [] });
  });
});
