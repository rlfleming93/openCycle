// FTMS (Fitness Machine Service) codec — pure parse/encode helpers on Uint8Array.
// Byte layouts, flag bits, and errata per docs/ble-protocol.md (ground truth).
// No noble imports: this module is transport-agnostic.

export const FTMS_SERVICE_UUID = '1826';
export const FEATURE = '2acc';
export const INDOOR_BIKE_DATA = '2ad2';
export const SUPPORTED_POWER_RANGE = '2ad8';
export const CONTROL_POINT = '2ad9';
export const MACHINE_STATUS = '2ada';

export const RESULT_SUCCESS = 0x01;
export const RESULT_CONTROL_NOT_PERMITTED = 0x05;
export const STATUS_CONTROL_LOST = 0xff;

export interface IndoorBikeData {
  speedKmh?: number;
  cadenceRpm?: number;
  powerW?: number;
  distanceM?: number;
  heartRateBpm?: number;
}

type ReadFn = (data: Uint8Array, offset: number) => number | null;

interface IbdField {
  flag: number;
  /** true → present when the bit is CLEAR (bit0 More-Data is inverted) */
  presentWhenClear: boolean;
  size: number;
  read: ReadFn;
  assign?: (out: IndoorBikeData, value: number) => void;
}

// Field order is fixed by the spec; non-contract fields are skipped so later ones parse.
const IBD_FIELDS: readonly IbdField[] = [
  {
    flag: 0x0001,
    presentWhenClear: true,
    size: 2,
    read: u16,
    assign: (o, v) => {
      o.speedKmh = v / 100;
    },
  },
  { flag: 0x0002, presentWhenClear: false, size: 2, read: u16 },
  {
    flag: 0x0004,
    presentWhenClear: false,
    size: 2,
    read: u16,
    assign: (o, v) => {
      o.cadenceRpm = v / 2;
    },
  },
  { flag: 0x0008, presentWhenClear: false, size: 2, read: u16 },
  {
    flag: 0x0010,
    presentWhenClear: false,
    size: 3,
    read: u24,
    assign: (o, v) => {
      o.distanceM = v;
    },
  },
  { flag: 0x0020, presentWhenClear: false, size: 2, read: s16 },
  {
    flag: 0x0040,
    presentWhenClear: false,
    size: 2,
    read: s16,
    assign: (o, v) => {
      o.powerW = v;
    },
  },
  { flag: 0x0080, presentWhenClear: false, size: 2, read: s16 },
  // Energy: kcal total (u16) + per-hr (u16) + per-min (u8) — not in the contract, skipped.
  { flag: 0x0100, presentWhenClear: false, size: 5, read: () => 0 },
  {
    flag: 0x0200,
    presentWhenClear: false,
    size: 1,
    read: u8,
    assign: (o, v) => {
      o.heartRateBpm = v;
    },
  },
  { flag: 0x0400, presentWhenClear: false, size: 1, read: u8 },
  { flag: 0x0800, presentWhenClear: false, size: 2, read: u16 },
  { flag: 0x1000, presentWhenClear: false, size: 2, read: u16 },
];

export function parseIndoorBikeData(data: Uint8Array): IndoorBikeData {
  const flags = u16(data, 0) ?? 0;
  const out: IndoorBikeData = {};
  let offset = 2;
  for (const field of IBD_FIELDS) {
    const present = field.presentWhenClear
      ? (flags & field.flag) === 0
      : (flags & field.flag) !== 0;
    if (!present) continue;
    if (offset + field.size > data.length) break; // truncated frame: keep what parsed
    const value = field.read(data, offset);
    field.assign?.(out, value ?? 0);
    offset += field.size;
  }
  return out;
}

export function parseFeature(data: Uint8Array): {
  cadenceSupported: boolean;
  powerMeasurementSupported: boolean;
  powerTargetSupported: boolean;
} {
  const features = u32(data, 0) ?? 0;
  const targetSetting = u32(data, 4) ?? 0;
  return {
    cadenceSupported: (features & 0x0002) !== 0, // features bit1
    powerMeasurementSupported: (features & 0x4000) !== 0, // features bit14
    powerTargetSupported: (targetSetting & 0x0008) !== 0, // target-setting bit3
  };
}

export function parseSupportedPowerRange(data: Uint8Array): {
  minW: number;
  maxW: number;
  incrementW: number;
} {
  return {
    minW: s16(data, 0) ?? 0,
    maxW: s16(data, 2) ?? 0,
    incrementW: u16(data, 4) ?? 0,
  };
}

export function encodeRequestControl(): Uint8Array {
  return new Uint8Array([0x00]);
}

export function encodeReset(): Uint8Array {
  return new Uint8Array([0x01]);
}

export function encodeSetTargetPower(watts: number): Uint8Array {
  const out = new Uint8Array(3);
  out[0] = 0x05;
  out[1] = watts & 0xff;
  out[2] = (watts >> 8) & 0xff;
  return out;
}

export function encodeStart(): Uint8Array {
  return new Uint8Array([0x07]);
}

export function encodeStop(): Uint8Array {
  return new Uint8Array([0x08, 0x01]);
}

export function parseControlResponse(
  data: Uint8Array,
): { requestOp: number; result: number } | null {
  if (data.length < 3 || data[0] !== 0x80) return null;
  return { requestOp: data[1] ?? 0, result: data[2] ?? 0 };
}

export function parseMachineStatus(data: Uint8Array): { op: number; controlLost: boolean } {
  const op = data[0] ?? 0;
  return { op, controlLost: op === STATUS_CONTROL_LOST };
}

function u8(data: Uint8Array, offset: number): number | null {
  return offset < data.length ? data[offset]! : null;
}

function u16(data: Uint8Array, offset: number): number | null {
  if (offset + 2 > data.length) return null;
  return data[offset]! | (data[offset + 1]! << 8);
}

function u24(data: Uint8Array, offset: number): number | null {
  if (offset + 3 > data.length) return null;
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

function u32(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function s16(data: Uint8Array, offset: number): number | null {
  const value = u16(data, offset);
  return value === null ? null : (value << 16) >> 16;
}
