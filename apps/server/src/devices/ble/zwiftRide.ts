// Zwift Ride handlebar controller codec — pure helpers on Uint8Array.
// Layouts, button bits and sources per docs/ble-protocol.md (ground truth).
// No noble imports: this module is transport-agnostic.

/** Controller service since the Jan 2025 firmware; older firmware used the legacy one. */
export const ZWIFT_RIDE_SERVICE_UUID = 'fc82';
export const ZWIFT_LEGACY_SERVICE_UUID = '0000000119ca465186e5fa29dcdd09d1';
/** Notify: keypad, battery and idle messages. */
export const ZWIFT_ASYNC_UUID = '0000000219ca465186e5fa29dcdd09d1';
/** Write: commands to the controller. */
export const ZWIFT_SYNC_RX_UUID = '0000000319ca465186e5fa29dcdd09d1';
/** Indicate: replies to commands. */
export const ZWIFT_SYNC_TX_UUID = '0000000419ca465186e5fa29dcdd09d1';
export const DEVICE_INFO_SERVICE_UUID = '180a';
export const FIRMWARE_REVISION_UUID = '2a26';

/** Plain handshake (no encryption on the Ride): ASCII "RideOn", echoed back by the controller. */
export const RIDE_ON = Uint8Array.of(0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e);

const ZWIFT_COMPANY_ID = 0x094a;
/** Advert device type of the left controller (the right is 0x07); the left one carries both. */
const RIDE_LEFT_DEVICE_TYPE = 0x08;
const KEYPAD_MESSAGE = 0x23;
/** Paddle travel (0..100) that counts as a press, and the travel it must fall below to release. */
const PADDLE_PRESS = 50;
const PADDLE_RELEASE = 25;
/** A second press of the same button within this window of its last press is contact bounce. */
export const PRESS_DEBOUNCE_MS = 100;

export type RideButton =
  | 'dpadLeft'
  | 'dpadUp'
  | 'dpadRight'
  | 'dpadDown'
  | 'a'
  | 'b'
  | 'y'
  | 'z'
  | 'shiftUpLeft'
  | 'shiftDownLeft'
  | 'dropLeft'
  | 'powerLeft'
  | 'shiftUpRight'
  | 'shiftDownRight'
  | 'dropRight'
  | 'powerRight'
  | 'paddleLeft'
  | 'paddleRight';

/**
 * ButtonMap bits, active-low (a cleared bit is a held button), as measured on
 * a Ride (swiftcontrol#3; BikeControl RideButtonMask). Makinolo's 2024 .proto
 * puts Z at 0x100 and every later button one bit up: that table is wrong.
 */
const BUTTON_BITS: ReadonlyArray<readonly [RideButton, number]> = [
  ['dpadLeft', 0x0001],
  ['dpadUp', 0x0002],
  ['dpadRight', 0x0004],
  ['dpadDown', 0x0008],
  ['a', 0x0010],
  ['b', 0x0020],
  ['y', 0x0040],
  ['z', 0x0080],
  ['shiftUpLeft', 0x0100], // LS1, upper
  ['shiftDownLeft', 0x0200], // LS2, lower
  ['dropLeft', 0x0400], // LB
  ['powerLeft', 0x0800],
  ['shiftUpRight', 0x1000], // RS1, upper
  ['shiftDownRight', 0x2000], // RS2, lower
  ['dropRight', 0x4000], // RB
  ['powerRight', 0x8000],
];

/** Analog paddle location 0 is ZL, 1 is ZR; 2 and 3 are sent but unused. */
const PADDLES: ReadonlyArray<RideButton> = ['paddleLeft', 'paddleRight'];

export interface RidePaddle {
  location: number;
  /** -100..100; the sign is the push direction (steer vs brake). */
  value: number;
}

export interface RideKeypadFrame {
  /** Digital buttons held in this frame. */
  held: Set<RideButton>;
  paddles: RidePaddle[];
}

/** Left Ride controller advert: Zwift's company id (LE), then device type 0x08. */
export function isRideLeftAdvert(manufacturerData: Uint8Array | undefined): boolean {
  if (manufacturerData === undefined || manufacturerData.length < 3) return false;
  const company = manufacturerData[0]! | (manufacturerData[1]! << 8);
  return company === ZWIFT_COMPANY_ID && manufacturerData[2] === RIDE_LEFT_DEVICE_TYPE;
}

export function isRideOnReply(data: Uint8Array): boolean {
  return data.length >= RIDE_ON.length && RIDE_ON.every((byte, i) => data[i] === byte);
}

/** Decode a 0x23 RideKeyPadStatus message; null for other messages or one without a button map. */
export function decodeRideKeypad(data: Uint8Array): RideKeypadFrame | null {
  if (data[0] !== KEYPAD_MESSAGE) return null;
  let buttonMap: number | null = null;
  const paddles: RidePaddle[] = [];
  for (const field of protoFields(data.subarray(1))) {
    if (field.number === 1 && field.varint !== undefined) buttonMap = field.varint % 2 ** 32;
    else if ((field.number === 2 || field.number === 3) && field.bytes) collectPaddles(field.bytes, paddles);
  }
  if (buttonMap === null) return null;
  const held = new Set<RideButton>();
  for (const [button, bit] of BUTTON_BITS) if ((buttonMap & bit) === 0) held.add(button);
  return { held, paddles };
}

/**
 * Turns keypad frames into presses: one per rising edge. A held button keeps
 * arriving in every frame (repeats, paddle moves while it is held) and yields
 * nothing more; a re-press inside PRESS_DEBOUNCE_MS is dropped as bounce.
 */
export class RidePressDetector {
  private held = new Set<RideButton>();
  private readonly lastPress = new Map<RideButton, number>();

  update(frame: RideKeypadFrame, now: number): RideButton[] {
    const held = new Set(frame.held);
    // A frame without a paddle entry leaves that paddle as it was.
    for (const paddle of PADDLES) if (this.held.has(paddle)) held.add(paddle);
    for (const { location, value } of frame.paddles) {
      const paddle = PADDLES[location];
      if (paddle === undefined) continue;
      const travel = Math.abs(value);
      if (travel >= PADDLE_PRESS || (this.held.has(paddle) && travel >= PADDLE_RELEASE)) held.add(paddle);
      else held.delete(paddle);
    }
    const presses: RideButton[] = [];
    for (const button of held) {
      if (this.held.has(button)) continue;
      const last = this.lastPress.get(button);
      if (last !== undefined && now - last < PRESS_DEBOUNCE_MS) continue;
      this.lastPress.set(button, now);
      presses.push(button);
    }
    this.held = held;
    return presses;
  }

  /** Forget held buttons (new link): the next frame is compared against nothing held. */
  reset(): void {
    this.held = new Set();
  }
}

/**
 * Paddles come in three shapes: field 2 holding repeated field-1 presses
 * (Makinolo's capture), or field 2 / repeated field 3 holding one
 * {location, value} press each (BikeControl's proto, later firmware).
 */
function collectPaddles(message: Uint8Array, out: RidePaddle[]): void {
  const fields = protoFields(message);
  const nested = fields.filter((f) => f.number === 1 && f.bytes !== undefined);
  if (nested.length > 0) {
    for (const f of nested) collectPaddles(f.bytes!, out);
    return;
  }
  const location = fields.find((f) => f.number === 1)?.varint;
  if (location === undefined) return;
  const raw = fields.find((f) => f.number === 2)?.varint ?? 0;
  out.push({ location, value: raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2 }); // sint32 zigzag
}

interface ProtoField {
  number: number;
  varint?: number;
  bytes?: Uint8Array;
}

/** Protobuf fields of one message; stops at the first malformed or truncated field. */
function protoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < data.length) {
    const tag = readVarint(data, pos);
    if (tag === null) break;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    pos = tag.next;
    if (wire === 0) {
      const value = readVarint(data, pos);
      if (value === null) break;
      fields.push({ number, varint: value.value });
      pos = value.next;
    } else if (wire === 2) {
      const length = readVarint(data, pos);
      if (length === null || length.next + length.value > data.length) break;
      fields.push({ number, bytes: data.subarray(length.next, length.next + length.value) });
      pos = length.next + length.value;
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4; // fixed64 / fixed32: nothing we read
    } else {
      break;
    }
  }
  return fields;
}

/**
 * Varint up to 10 bytes, keeping only its low 35 bits: exact in a double, and
 * protobuf reads a uint32 from the low 32 bits of a wider (sign-extended) varint.
 */
function readVarint(data: Uint8Array, pos: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = pos, shift = 0; i < data.length && shift < 70; i++, shift += 7) {
    const byte = data[i]!;
    if (shift < 35) value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
  }
  return null;
}
