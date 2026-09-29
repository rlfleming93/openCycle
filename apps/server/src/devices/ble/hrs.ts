// Heart Rate Service codec — pure parse helper on Uint8Array.
// Byte layout per docs/ble-protocol.md (ground truth). No noble imports.

export const HRS_SERVICE_UUID = '180d';
export const HR_MEASUREMENT_UUID = '2a37';

export interface HeartRateMeasurement {
  bpm: number;
  rrMs: number[];
}

export function parseHeartRateMeasurement(data: Uint8Array): HeartRateMeasurement {
  const flags = data[0] ?? 0;
  let offset = 1;
  let bpm = 0;
  if ((flags & 0x01) !== 0) {
    const value = u16(data, offset);
    if (value !== null) {
      bpm = value;
      offset += 2;
    }
  } else {
    const value = data[offset];
    if (value !== undefined) {
      bpm = value;
      offset += 1;
    }
  }
  if ((flags & 0x08) !== 0) offset += 2; // energy expended (kJ) — not in the contract
  const rrMs: number[] = [];
  if ((flags & 0x10) !== 0) {
    while (offset + 2 <= data.length) {
      rrMs.push((u16(data, offset)! * 1000) / 1024);
      offset += 2;
    }
  }
  return { bpm, rrMs };
}

function u16(data: Uint8Array, offset: number): number | null {
  if (offset + 2 > data.length) return null;
  return data[offset]! | (data[offset + 1]! << 8);
}
