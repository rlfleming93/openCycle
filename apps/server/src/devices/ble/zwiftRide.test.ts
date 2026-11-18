import { describe, expect, it } from 'vitest';
import {
  RidePressDetector,
  decodeRideKeypad,
  isRideLeftAdvert,
  isRideOnReply,
  type RideButton,
} from './zwiftRide.js';

function bytes(hex: string): Uint8Array {
  if (hex === '') return new Uint8Array(0);
  return new Uint8Array(hex.split(' ').map((b) => parseInt(b, 16)));
}

function held(hex: string): RideButton[] {
  return [...(decodeRideKeypad(bytes(hex))?.held ?? [])];
}

describe('decodeRideKeypad', () => {
  it('decodes the published capture: D-pad left held, four paddles at rest', () => {
    // makinolo.com/blog/2024/07/26/zwift-ride-protocol (field 2 → repeated field-1 presses).
    const frame = decodeRideKeypad(
      bytes('23 08 fe ff ff ff 0f 12 18 0a 04 08 00 10 00 0a 04 08 01 10 00 0a 04 08 02 10 00 0a 04 08 03 10 00'),
    );
    expect(frame && [...frame.held]).toEqual(['dpadLeft']);
    expect(frame?.paddles).toEqual([
      { location: 0, value: 0 },
      { location: 1, value: 0 },
      { location: 2, value: 0 },
      { location: 3, value: 0 },
    ]);
  });

  it('reads the all-released map as nothing held', () => {
    // BikeControl controller_keep_alive.dart kZwiftControllerReleasedState.
    expect(held('23 08 ff ff ff ff 0f')).toEqual([]);
  });

  // Bits measured on a Ride (OpenBikeControl/bikecontrol#3, 2025-03-30); hex frames from
  // Custodia-Admin/velo rideProtocol.test.ts REAL_FRAMES. The low byte (D-pad, A, B, Y)
  // is the same in every source.
  it.each<[string, RideButton[]]>([
    ['23 08 fd ff ff ff 0f', ['dpadUp']],
    ['23 08 fb ff ff ff 0f', ['dpadRight']],
    ['23 08 f7 ff ff ff 0f', ['dpadDown']],
    ['23 08 ef ff ff ff 0f', ['a']],
    ['23 08 df ff ff ff 0f', ['b']],
    ['23 08 bf ff ff ff 0f', ['y']],
    ['23 08 ff fe ff ff 0f', ['z']],
    ['23 08 ff fd ff ff 0f', ['shiftUpLeft']],
    ['23 08 ff fb ff ff 0f', ['shiftDownLeft']],
    ['23 08 ff f7 ff ff 0f', ['dropLeft']],
    ['23 08 ff ef ff ff 0f', ['powerLeft']],
    ['23 08 ff df ff ff 0f', ['shiftUpRight']],
    ['23 08 ff bf ff ff 0f', ['shiftDownRight']],
    ['23 08 ff ff fe ff 0f', ['dropRight']],
    ['23 08 ff ff fd ff 0f', ['powerRight']],
    // Makinolo's ONOFF_R bit 0x10000: no Ride sends it, so it names nothing.
    ['23 08 ff ff fb ff 0f', []],
    ['23 08 ff cd ff ff 0f', ['shiftUpLeft', 'powerLeft', 'shiftUpRight']],
    // A sign-extended (10-byte) varint still reads as its low 32 bits.
    ['23 08 fe ff ff ff ff ff ff ff ff 01', ['dpadLeft']],
  ])('[%s] holds %j', (hex, buttons) => {
    expect(held(hex)).toEqual(buttons);
  });

  it.each<[string, string, Array<{ location: number; value: number }>]>([
    ['nested group (Makinolo shape)', '23 08 ff ff ff ff 0f 12 07 0a 05 08 00 10 c7 01', [{ location: 0, value: -100 }]],
    ['flat field 2', '23 08 ff ff ff ff 0f 12 04 08 01 10 64', [{ location: 1, value: 50 }]],
    [
      'repeated field 3 (BikeControl proto)',
      '23 08 ff ff ff ff 0f 1a 05 08 00 10 c7 01 1a 04 08 01 10 00',
      [
        { location: 0, value: -100 },
        { location: 1, value: 0 },
      ],
    ],
  ])('reads paddles in the %s layout', (_layout, hex, paddles) => {
    expect(decodeRideKeypad(bytes(hex))?.paddles).toEqual(paddles);
  });

  it.each([
    ['battery', '19 08 55'],
    ['idle', '15'],
    ['RideOn echo', '52 69 64 65 4f 6e'],
    ['truncated button map', '23 08 fe ff'],
    ['empty', ''],
  ])('ignores a %s message', (_name, hex) => {
    expect(decodeRideKeypad(bytes(hex))).toBeNull();
  });
});

describe('RidePressDetector', () => {
  const LS1 = '23 08 ff fd ff ff 0f';
  const RELEASED = '23 08 ff ff ff ff 0f';

  function run(frames: Array<[number, string]>): RideButton[] {
    const detector = new RidePressDetector();
    return frames.flatMap(([ts, hex]) => detector.update(decodeRideKeypad(bytes(hex))!, ts));
  }

  it('fires once per press however many frames arrive while held', () => {
    const presses = run([
      [0, RELEASED],
      [30, LS1],
      [60, `${LS1} 1a 04 08 00 10 28`], // ZL at 20: below press travel
      [90, `${LS1} 1a 04 08 01 10 3b`], // ZR at -30
      [120, LS1],
      [400, RELEASED],
      [600, LS1],
    ]);
    expect(presses).toEqual(['shiftUpLeft', 'shiftUpLeft']);
  });

  it('drops a re-press inside the bounce window', () => {
    expect(run([[0, LS1], [20, RELEASED], [40, LS1], [200, RELEASED], [260, LS1]])).toEqual([
      'shiftUpLeft',
      'shiftUpLeft',
    ]);
  });

  it('presses a paddle past half travel and releases it below a quarter', () => {
    const presses = run([
      [0, `${RELEASED} 1a 04 08 00 10 64`], // ZL 50: press
      [100, `${RELEASED} 1a 04 08 00 10 3c`], // 30: still held
      [200, RELEASED], // no paddle entry: unchanged
      [300, `${RELEASED} 1a 04 08 00 10 28`], // 20: released
      [400, `${RELEASED} 1a 04 08 00 10 63`], // -50: press again
    ]);
    expect(presses).toEqual(['paddleLeft', 'paddleLeft']);
  });
});

describe('adverts and handshake', () => {
  // Manufacturer data = company 0x094A (LE) + device type + address tail. The tails are
  // real adverts logged in Custodia-Admin/velo rideProtocol.test.ts (left 08 db f4, right 07 f7 0e).
  it.each([
    ['left controller', '4a 09 08 db f4', true],
    ['right controller', '4a 09 07 f7 0e', false],
    ['Zwift Click', '4a 09 09 00 00', false],
    ['other company', '4c 00 08 db f4', false],
    ['empty (KICKR CORE)', '', false],
  ])('%s → %s', (_name, hex, expected) => {
    expect(isRideLeftAdvert(bytes(hex))).toBe(expected);
  });

  it('recognizes the RideOn echo, with or without a suffix', () => {
    expect(isRideOnReply(bytes('52 69 64 65 4f 6e'))).toBe(true);
    expect(isRideOnReply(bytes('52 69 64 65 4f 6e 01 03'))).toBe(true);
    expect(isRideOnReply(bytes('52 69 64 65'))).toBe(false);
  });
});
