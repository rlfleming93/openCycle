import type { Leg, SessionEvent, SessionSnapshot, TelemetrySample } from '@opencycle/shared';
import { describe, expect, it } from 'vitest';

import type { AppState } from '../store.js';
import { IDENTITY_COLORS } from '../lib/identity.js';
import { createGameDirector, rawGameProgress } from './director.js';

// ---------------------------------------------------------------------------
// Fixtures (fake AppState — the director only reads session/latest/events)
// ---------------------------------------------------------------------------

function makeState(over: Partial<AppState> = {}): AppState {
  return {
    wsStatus: 'connecting',
    session: null,
    telemetry: {},
    latest: {},
    events: [],
    deviceStatus: {},
    lastError: null,
    hydrated: false,
    spaceGame: true,
    applyServer: () => {},
    setWsStatus: () => {},
    setSpaceGame: () => {},
    clearSession: () => {},
    ...over,
  };
}

function leg(over: Partial<Leg> = {}): Leg {
  return {
    index: 0,
    kind: 'burn',
    label: 'BURN 1/1',
    startS: 0,
    endS: 60,
    startPctFtp: 1,
    endPctFtp: 1,
    objective: true,
    ...over,
  };
}

function rider(over: Partial<SessionSnapshot['riders'][number]> = {}): SessionSnapshot['riders'][number] {
  return {
    riderId: 'r1',
    name: 'R1',
    ftpW: 200,
    trainerId: 't1',
    state: 'riding',
    stepIndex: 0,
    stepRemainingS: null,
    workoutRemainingS: null,
    stepKind: null,
    stepCueRemainingS: null,
    nextTargetW: null,
    targetW: null,
    biasPct: 0,
    elapsedS: 0,
    distanceM: 0,
    ergGuardActive: false,
    workoutClockS: null,
    legs: null,
    legIndex: null,
    legTargetedS: 0,
    legOnTargetS: 0,
    surveysClean: 0,
    ...over,
  };
}

function sample(over: Partial<TelemetrySample> = {}): TelemetrySample {
  return { riderId: 'r1', ts: 1000, powerW: 0, cadenceRpm: 85, speedKmh: 0, distanceM: 0, ...over };
}

function session(riders: SessionSnapshot['riders'], over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { id: 's1', startedAt: 1000, riders, destination: null, ...over };
}

/** Objective leg-completion event (the only kind that reaches the frame). */
function legEvent(
  riderId: string,
  ts: number,
  over: Partial<Extract<SessionEvent, { kind: 'legCompleted' }>> = {},
): SessionEvent {
  return {
    kind: 'legCompleted',
    riderId,
    legIndex: 0,
    legKind: 'burn',
    objective: true,
    targetedS: 60,
    onTargetS: 58,
    clean: true,
    ts,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('ratio smoothing', () => {
  it('snaps to raw on first sample, then converges with τ≈2 s', () => {
    const state = makeState({
      session: session([rider({ targetW: 200 })]),
      latest: { r1: sample({ powerW: 200, cadenceRpm: 85 }) },
    });
    const dir = createGameDirector(() => state);
    let frame = dir.sample(0);
    expect(frame.riders[0]!.ratio).toBe(1);
    state.latest = { r1: sample({ powerW: 100, cadenceRpm: 85 }) }; // raw 0.5
    const dtMs = 100;
    for (let k = 1; k <= 20; k++) frame = dir.sample(k * dtMs); // t = 2 s
    expect(frame.riders[0]!.ratio).toBeCloseTo(0.5 + 0.5 * Math.exp(-1), 3); // ≈0.684
    for (let k = 21; k <= 100; k++) frame = dir.sample(k * dtMs); // t = 10 s
    expect(frame.riders[0]!.ratio).toBeCloseTo(0.5, 2);
  });
});

describe('cruise deadband', () => {
  it.each([
    [0.95, 85, 1.0], // deadband
    [0.9, 85, 1.0], // deadband lower edge, inclusive
    [1.1, 85, 1.0], // deadband upper edge, inclusive
    [1.2, 85, 1.0], // over-target never pays
    [1.5, 85, 1.0],
    [0.7, 85, 0.775], // lerp between 0.5→0.55 and 0.9→1.0
    [0.5, 85, 0.55], // floor at ratio 0.5
    [0.4, 85, 0.55], // clamped at floor below ratio 0.5
    [0.4, 0, 0], // cadence ≈ 0 → dead stop
    [1.0, 0, 0], // cadence stop overrides deadband
  ])('ratio %s @ %s rpm → cruise %s', (ratio, rpm, expected) => {
    const state = makeState({
      session: session([rider({ targetW: 200 })]),
      latest: { r1: sample({ powerW: 200 * ratio, cadenceRpm: rpm }) },
    });
    const frame = createGameDirector(() => state).sample(1000);
    expect(frame.riders[0]!.cruise).toBeCloseTo(expected, 5);
  });
});

describe('free ride', () => {
  it('uses 0.65×ftpW as the target', () => {
    const mk = (powerW: number, targetW: number | null) =>
      makeState({
        session: session([rider({ ftpW: 200, targetW })]),
        latest: { r1: sample({ powerW, cadenceRpm: 85 }) },
      });
    // 130 W = 65% of ftp 200 → ratio 1 → cruise 1
    let frame = createGameDirector(() => mk(130, null)).sample(1000);
    expect(frame.riders[0]!.ratio).toBe(1);
    expect(frame.riders[0]!.cruise).toBe(1);
    // 65 W → ratio 0.5
    frame = createGameDirector(() => mk(65, null)).sample(1000);
    expect(frame.riders[0]!.ratio).toBeCloseTo(0.5, 5);
    // zero target falls back to the free formula too
    frame = createGameDirector(() => mk(130, 0)).sample(1000);
    expect(frame.riders[0]!.ratio).toBe(1);
  });
});

describe('shipSpeed', () => {
  it('averages only riding riders; 0 when none', () => {
    const mk = (riders: SessionSnapshot['riders'], latest: Record<string, TelemetrySample>) =>
      makeState({ session: session(riders), latest });
    // paused rider excluded
    let frame = createGameDirector(() =>
      mk(
        [rider({ riderId: 'r1', targetW: 200 }), rider({ riderId: 'r2', targetW: 200, state: 'paused' })],
        {
          r1: sample({ riderId: 'r1', powerW: 200, cadenceRpm: 85 }),
          r2: sample({ riderId: 'r2', powerW: 200, cadenceRpm: 85 }),
        },
      ),
    ).sample(1000);
    expect(frame.shipSpeed).toBe(1);
    expect(frame.riders[1]!.state).toBe('paused');
    // both riding: mean of cruise 1.0 and cruise 0.775 (ratio 0.7)
    frame = createGameDirector(() =>
      mk(
        [rider({ riderId: 'r1', targetW: 200 }), rider({ riderId: 'r2', targetW: 200 })],
        {
          r1: sample({ riderId: 'r1', powerW: 200, cadenceRpm: 85 }),
          r2: sample({ riderId: 'r2', powerW: 140, cadenceRpm: 85 }),
        },
      ),
    ).sample(1000);
    expect(frame.shipSpeed).toBeCloseTo(0.8875, 5);
    // none riding → 0
    frame = createGameDirector(() =>
      mk(
        [rider({ riderId: 'r1', targetW: 200, state: 'stopped' }), rider({ riderId: 'r2', targetW: 200, state: 'paused' })],
        {
          r1: sample({ riderId: 'r1', powerW: 200, cadenceRpm: 85 }),
          r2: sample({ riderId: 'r2', powerW: 200, cadenceRpm: 85 }),
        },
      ),
    ).sample(1000);
    expect(frame.shipSpeed).toBe(0);
  });
});

describe('weather', () => {
  it('averages riding riders’ zone intensity', () => {
    const both = makeState({
      session: session([rider({ riderId: 'r1', targetW: 200 }), rider({ riderId: 'r2', targetW: 100 })]),
      latest: {
        r1: sample({ riderId: 'r1', powerW: 200, cadenceRpm: 85 }),
        r2: sample({ riderId: 'r2', powerW: 100, cadenceRpm: 85 }),
      },
    });
    expect(createGameDirector(() => both).sample(0).weather).toBe(0.75); // (100 + 50)/2 /100
    // paused rider excluded
    const paused = makeState({
      session: session([rider({ riderId: 'r1', targetW: 200 }), rider({ riderId: 'r2', targetW: 100, state: 'paused' })]),
      latest: {
        r1: sample({ riderId: 'r1', powerW: 200, cadenceRpm: 85 }),
        r2: sample({ riderId: 'r2', powerW: 100, cadenceRpm: 85 }),
      },
    });
    expect(createGameDirector(() => paused).sample(0).weather).toBe(1);
    // free rider contributes 65%
    const free = makeState({
      session: session([rider({ riderId: 'r1', targetW: null })]),
      latest: { r1: sample({ riderId: 'r1', powerW: 130, cadenceRpm: 85 }) },
    });
    expect(createGameDirector(() => free).sample(0).weather).toBe(0.65);
  });

  it('low-pass (τ≈8 s) moves slower than ratio smoothing (τ≈2 s)', () => {
    const state = makeState({
      session: session([rider({ targetW: 200 })]),
      latest: { r1: sample({ powerW: 200, cadenceRpm: 85 }) },
    });
    const dir = createGameDirector(() => state);
    let frame = dir.sample(0);
    expect(frame.weather).toBe(1);
    // Target halves → weather raw 0.5, ratio raw 2.0 (power unchanged)
    state.session = session([rider({ targetW: 100 })]);
    for (let k = 1; k <= 20; k++) frame = dir.sample(k * 100); // t = 2 s
    expect(frame.riders[0]!.ratio).toBeCloseTo(2 - Math.exp(-1), 3); // ≈1.368
    expect(frame.weather).toBeCloseTo(0.5 + 0.5 * Math.exp(-2 / 8), 3); // ≈0.889
    // Ratio is closer to its target than weather is to its own
    expect(2 - frame.riders[0]!.ratio).toBeGreaterThan(1 - frame.weather);
    for (let k = 21; k <= 400; k++) frame = dir.sample(k * 100); // t = 40 s
    expect(frame.weather).toBeCloseTo(0.5, 2);
  });
});

describe('rawGameProgress', () => {
  it('uses the minimum active workout completion', () => {
    expect(rawGameProgress(session([
      rider({ riderId: 'r1', workoutId: 'w1', elapsedS: 300, workoutClockS: 300, workoutRemainingS: 300 }),
      rider({ riderId: 'r2', workoutId: 'w2', elapsedS: 100, workoutClockS: 100, workoutRemainingS: 300 }),
    ]))).toBeCloseTo(0.25, 5);
  });

  it('follows the mission (workout) clock, so skipped steps advance the approach', () => {
    // 900 s launch skipped after 20 s of riding: the workout clock jumps to
    // 920 s while elapsedS barely moves. Progress must follow the clock.
    const skipped = session([
      rider({ workoutId: 'w1', elapsedS: 20, workoutClockS: 920, workoutRemainingS: 480 }),
    ]);
    expect(rawGameProgress(skipped)).toBeCloseTo(920 / 1400, 5); // ≈0.657, not 20/500
    // Without a workout clock the old elapsed-based fraction still applies.
    const noClock = session([
      rider({ workoutId: 'w1', elapsedS: 300, workoutClockS: null, workoutRemainingS: 300 }),
    ]);
    expect(rawGameProgress(noClock)).toBeCloseTo(0.5, 5);
  });

  it('returns null when workout riders exist but none are advancing', () => {
    expect(rawGameProgress(session([
      rider({ workoutId: 'w1', state: 'paused', elapsedS: 150, workoutClockS: 150, workoutRemainingS: 450 }),
    ]))).toBeNull();
  });

  it('keeps the existing free-ride midpoint', () => {
    expect(rawGameProgress(session([rider({ workoutId: undefined })]))).toBe(0.5);
  });
});

describe('progress', () => {
  it('grows continuously across a multi-step workout and reaches 1 when finished', () => {
    const state = makeState({
      session: session([rider({ targetW: 200, workoutId: 'w1', workoutRemainingS: 450, elapsedS: 150 })]),
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(0).progress).toBeCloseTo(0.25, 5); // 150/600 — clock 25%
    // Mid-workout: total remaining shrinks continuously — no boundary jump
    state.session = session([rider({ targetW: 200, workoutId: 'w1', workoutRemainingS: 300, elapsedS: 300 })]);
    expect(dir.sample(1000).progress).toBeCloseTo(0.5, 5); // 300/600
    // Snapshot regression (stale remaining) cannot rewind the ratchet
    state.session = session([rider({ targetW: 200, workoutId: 'w1', workoutRemainingS: 500, elapsedS: 250 })]);
    expect(dir.sample(2000).progress).toBeCloseTo(0.5, 5); // raw 250/750 ≈ 0.333 → clamped
    // Nearly done, then finished (null remaining) → 1
    state.session = session([rider({ targetW: 200, workoutId: 'w1', workoutRemainingS: 1, elapsedS: 599 })]);
    expect(dir.sample(3000).progress).toBeCloseTo(0.9983, 3); // 599/600
    state.session = session([rider({ targetW: 200, workoutId: 'w1', workoutRemainingS: null, elapsedS: 600 })]);
    expect(dir.sample(4000).progress).toBe(1);
  });

  it('the slowest rider paces the approach (minimum completion)', () => {
    const state = makeState({
      session: session([
        rider({ riderId: 'r1', targetW: 200, workoutId: 'w1', workoutRemainingS: 300, elapsedS: 300 }),
        rider({ riderId: 'r2', targetW: 200, workoutId: 'w2', workoutRemainingS: 300, elapsedS: 100 }),
      ]),
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(0).progress).toBeCloseTo(0.25, 5); // r2: 100/400 — not r1's 0.5
    // r2 finishes its workout (null remaining → counts as 1): r1 paces alone
    state.session = session([
      rider({ riderId: 'r1', targetW: 200, workoutId: 'w1', workoutRemainingS: 300, elapsedS: 300 }),
      rider({ riderId: 'r2', targetW: 200, workoutId: 'w2', workoutRemainingS: null, elapsedS: 400 }),
    ]);
    expect(dir.sample(1000).progress).toBeCloseTo(0.5, 5); // min(0.5, 1)
  });

  it('ramp sub-steps no longer saturate early progress', () => {
    // Old bug: current-step remaining (a 15 s ramp sub-step) made progress
    // saturate ≈0.8 in the first minute. The TOTAL remaining paces progress.
    const state = makeState({
      session: session([
        rider({ targetW: 200, workoutId: 'w1', stepRemainingS: 7, workoutRemainingS: 900, elapsedS: 300 }),
      ]),
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(0).progress).toBeCloseTo(0.25, 5); // 300/1200 — not 300/307 ≈ 0.98
    // The sub-step boundary (stepRemainingS refresh) does not move progress
    state.session = session([
      rider({ targetW: 200, workoutId: 'w1', stepRemainingS: 15, workoutRemainingS: 899, elapsedS: 301 }),
    ]);
    expect(dir.sample(1000).progress).toBeCloseTo(0.2508, 3); // 301/1200, ratchet keeps it smooth
  });

  it('freezes when no rider is advancing', () => {
    const state = makeState({
      session: session([rider({ targetW: 200, workoutId: 'w1', workoutRemainingS: 450, elapsedS: 150 })]),
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(0).progress).toBeCloseTo(0.25, 5);
    for (const s of ['paused', 'stopped'] as const) {
      state.session = session([rider({ targetW: 200, workoutId: 'w1', workoutRemainingS: 450, elapsedS: 150, state: s })]);
      expect(dir.sample(1000).progress).toBeCloseTo(0.25, 5);
    }
  });

  it('pins free-only sessions at 0.5', () => {
    const state = makeState({ session: session([rider({ targetW: null })]) });
    const dir = createGameDirector(() => state);
    expect(dir.sample(0).progress).toBe(0.5);
    state.session = session([rider({ targetW: null, elapsedS: 600 })]);
    expect(dir.sample(1000).progress).toBe(0.5);
    state.session = session([]);
    expect(dir.sample(2000).progress).toBe(0.5);
  });
});

describe('destination, surveys and legKind', () => {
  const destination = {
    seed: 'r1:voyage:0',
    name: 'Keinora',
    voyageIndex: 0,
    leadRiderId: 'r1',
  };

  it('passes the session destination through', () => {
    const none = makeState({ session: session([rider()]) });
    expect(createGameDirector(() => none).sample(0).destination).toBeNull();
    const state = makeState({ session: session([rider()], { destination }) });
    expect(createGameDirector(() => state).sample(0).destination).toEqual(destination);
  });

  it('counts objective legs as survey slots and takes the best rider', () => {
    const legs = [
      leg({ index: 0, kind: 'launch', objective: false }),
      leg({ index: 1, kind: 'burn', objective: true }),
      leg({ index: 2, kind: 'coast', objective: false }),
      leg({ index: 3, kind: 'burn', objective: true }),
      leg({ index: 4, kind: 'climb', objective: true }),
    ];
    const state = makeState({
      session: session(
        [
          rider({ riderId: 'r1', legs, legIndex: 1, surveysClean: 2 }),
          rider({ riderId: 'r2', legs, legIndex: 3, surveysClean: 1 }),
        ],
        { destination: { ...destination, leadRiderId: 'r2' } },
      ),
    });
    const frame = createGameDirector(() => state).sample(0);
    expect(frame.surveys).toEqual({ total: 3, revealed: 2 });
  });

  it('reads the current leg of the lead rider, else rider 0', () => {
    const legs = [
      leg({ index: 0, kind: 'launch', objective: false }),
      leg({ index: 1, kind: 'climb', objective: true }),
    ];
    const leadIsSecond = makeState({
      session: session(
        [
          rider({ riderId: 'r1', legs, legIndex: 0 }),
          rider({ riderId: 'r2', legs, legIndex: 1 }),
        ],
        { destination: { ...destination, leadRiderId: 'r2' } },
      ),
    });
    expect(createGameDirector(() => leadIsSecond).sample(0).legKind).toBe('climb');

    // No destination: rider 0 leads the read.
    const freeOnly = makeState({
      session: session([
        rider({ riderId: 'r1', legs, legIndex: 0 }),
        rider({ riderId: 'r2', legs, legIndex: 1 }),
      ]),
    });
    expect(createGameDirector(() => freeOnly).sample(0).legKind).toBe('launch');

    // Without a workout there is no leg at all.
    const noWorkout = makeState({ session: session([rider({ legs: null, legIndex: null })]) });
    expect(createGameDirector(() => noWorkout).sample(0).legKind).toBeNull();
  });

  it('returns legIndex null after the last leg', () => {
    const legs = [leg({ index: 0, kind: 'burn' })];
    const state = makeState({ session: session([rider({ legs, legIndex: null })]) });
    expect(createGameDirector(() => state).sample(0).legKind).toBeNull();
  });
});

describe('event drain', () => {
  it('maps objective legCompleted events, and only those', () => {
    const state = makeState({
      session: session([rider()]),
      events: [
        legEvent('r1', 1000, { legKind: 'burn', clean: true }),
        legEvent('r1', 2000, { legKind: 'coast', objective: false, clean: false }),
        legEvent('r2', 3000, { legKind: 'climb', clean: false }),
      ],
    });
    expect(createGameDirector(() => state).sample(5000).events).toEqual([
      { kind: 'legComplete', riderId: 'r1', clean: true, legKind: 'burn' },
      { kind: 'legComplete', riderId: 'r2', clean: false, legKind: 'climb' },
    ]);
  });

  it('crosses beacon thresholds by cumulative streak', () => {
    const state = makeState({ session: session([rider()]), events: [] });
    const dir = createGameDirector(() => state);
    // 0 → 90 crosses 30 AND 90
    state.events.push({ kind: 'bothInZone', ts: 1000, streakS: 90 });
    expect(dir.sample(5000).events).toEqual([
      { kind: 'beacon', streakS: 30 },
      { kind: 'beacon', streakS: 90 },
    ]);
    // 90 → 300 crosses 180 and 300 (60 is never a beacon)
    state.events.push({ kind: 'bothInZone', ts: 2000, streakS: 300 });
    expect(dir.sample(6000).events).toEqual([
      { kind: 'beacon', streakS: 180 },
      { kind: 'beacon', streakS: 300 },
    ]);
    // streak reset: nothing above the 300 high-water mark
    state.events.push({ kind: 'bothInZone', ts: 3000, streakS: 60 });
    state.events.push({ kind: 'bothInZone', ts: 4000, streakS: 150 });
    expect(dir.sample(7000).events).toEqual([]);
    // next tier: 600
    state.events.push({ kind: 'bothInZone', ts: 5000, streakS: 600 });
    expect(dir.sample(8000).events).toEqual([{ kind: 'beacon', streakS: 600 }]);
    // fresh session: 0 → 60 crosses only 30
    const fresh = makeState({
      session: session([rider()]),
      events: [{ kind: 'bothInZone', ts: 1000, streakS: 60 }],
    });
    expect(createGameDirector(() => fresh).sample(5000).events).toEqual([{ kind: 'beacon', streakS: 30 }]);
  });

  it('arrival counts finishers cumulatively', () => {
    const state = makeState({ session: session([rider()]), events: [] });
    const dir = createGameDirector(() => state);
    state.events.push({ kind: 'workoutCompleted', riderId: 'r1', ts: 1000 });
    expect(dir.sample(5000).events).toEqual([{ kind: 'arrival', finishers: 1 }]);
    state.events.push({ kind: 'workoutCompleted', riderId: 'r2', ts: 2000 });
    expect(dir.sample(6000).events).toEqual([{ kind: 'arrival', finishers: 2 }]);
  });

  it('passes guards through and preserves event order', () => {
    const state = makeState({
      session: session([rider()]),
      events: [
        { kind: 'ergGuard', riderId: 'r1', engaged: true, ts: 1000 },
        legEvent('r1', 2000),
        { kind: 'ergGuard', riderId: 'r1', engaged: false, ts: 3000 },
      ],
    });
    const frame = createGameDirector(() => state).sample(5000);
    expect(frame.events).toEqual([
      { kind: 'guard', riderId: 'r1', engaged: true },
      { kind: 'legComplete', riderId: 'r1', clean: true, legKind: 'burn' },
      { kind: 'guard', riderId: 'r1', engaged: false },
    ]);
  });

  it('drains each event exactly once across samples', () => {
    const state = makeState({ session: session([rider()]), events: [] });
    const dir = createGameDirector(() => state);
    for (let i = 1; i <= 5; i++) state.events.push(legEvent('r1', i * 1000));
    expect(dir.sample(10_000).events).toHaveLength(5);
    expect(dir.sample(11_000).events).toHaveLength(0);
  });

  it('survives the events cap shifting the array', () => {
    const state = makeState({ session: session([rider()]), events: [] });
    const dir = createGameDirector(() => state);
    // Same slice-and-append the store performs at EVENTS_CAP = 200
    const push = (ev: SessionEvent) => {
      state.events =
        state.events.length >= 200
          ? [...state.events.slice(state.events.length - 199), ev]
          : [...state.events, ev];
    };
    for (let i = 1; i <= 210; i++) push(legEvent(`r${i}`, i * 1000));
    expect(dir.sample(500_000).events).toHaveLength(200); // first drain: all present
    // 10 more push the oldest 10 out of the array
    for (let i = 211; i <= 220; i++) push(legEvent(`r${i}`, i * 1000));
    const frame = dir.sample(600_000);
    expect(frame.events.map((e) => e.kind === 'legComplete' && e.riderId)).toEqual(
      Array.from({ length: 10 }, (_, k) => `r${211 + k}`),
    );
    expect(dir.sample(700_000).events).toHaveLength(0); // no re-drain of survivors
  });

  it('tracks same-ts batches by count', () => {
    const state = makeState({
      session: session([rider()]),
      events: [
        legEvent('r1', 1000),
        { kind: 'ergGuard', riderId: 'r1', engaged: true, ts: 1000 },
        legEvent('r2', 1000),
      ],
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(5000).events).toHaveLength(3);
    // More events arrive with the same ts after the first drain
    state.events.push(legEvent('r3', 1000));
    state.events.push({ kind: 'workoutCompleted', riderId: 'r4', ts: 1000 });
    expect(dir.sample(6000).events).toEqual([
      { kind: 'legComplete', riderId: 'r3', clean: true, legKind: 'burn' },
      { kind: 'arrival', finishers: 1 },
    ]);
    expect(dir.sample(7000).events).toHaveLength(0);
  });

  it('resets streak/finisher/cursor state on seed change', () => {
    const state = makeState({ session: session([rider()]), events: [] });
    const dir = createGameDirector(() => state);
    state.events.push({ kind: 'bothInZone', ts: 1000, streakS: 90 });
    state.events.push({ kind: 'workoutCompleted', riderId: 'r1', ts: 2000 });
    expect(dir.sample(5000).events).toEqual([
      { kind: 'beacon', streakS: 30 },
      { kind: 'beacon', streakS: 90 },
      { kind: 'arrival', finishers: 1 },
    ]);
    // New session (store clears events; cursor + high-water reset)
    state.session = session([rider()], { id: 's2' });
    state.events = [{ kind: 'bothInZone', ts: 3000, streakS: 30 }];
    expect(dir.sample(6000).events).toEqual([{ kind: 'beacon', streakS: 30 }]);
    expect(dir.sample(7000).events).toHaveLength(0);
  });
});

describe('syncLit', () => {
  it('holds for 35 s from the latest bothInZone (injected now)', () => {
    // Numeric target present: the 35 s window is what expires the core here.
    const state = makeState({ session: session([rider({ targetW: 200 })]), events: [{ kind: 'bothInZone', ts: 10_000, streakS: 30 }] });
    const dir = createGameDirector(() => state);
    expect(dir.sample(10_000).syncLit).toBe(true);
    expect(dir.sample(44_999).syncLit).toBe(true);
    expect(dir.sample(45_000).syncLit).toBe(true); // exactly 35 s: inclusive
    expect(dir.sample(45_001).syncLit).toBe(false);
  });

  it('is false with no bothInZone and re-lights only on a fresh drain', () => {
    const none = makeState({ session: session([rider({ targetW: 200 })]), events: [] });
    expect(createGameDirector(() => none).sample(0).syncLit).toBe(false);
    const state = makeState({ session: session([rider({ targetW: 200 })]), events: [] });
    const dir = createGameDirector(() => state);
    state.events.push({ kind: 'bothInZone', ts: 1000, streakS: 30 });
    state.events.push({ kind: 'bothInZone', ts: 2000, streakS: 60 });
    expect(dir.sample(3000).syncLit).toBe(true); // lit at drain (sample clock 3000)
    expect(dir.sample(37_999).syncLit).toBe(true); // 34 999 ms after drain
    expect(dir.sample(38_001).syncLit).toBe(false); // 35 001 ms after drain
  });

  it('measures the window on the sample clock, not the server event ts (clock-domain fix)', () => {
    // ev.ts is server epoch ms (1.7e12); nowMs is the render/RAF clock (small
    // values). The old code stored ev.ts and compared against nowMs — the
    // negative delta kept the emerald core lit forever after the first streak.
    const state = makeState({
      session: session([rider({ targetW: 200 })]),
      events: [{ kind: 'bothInZone', ts: 1_700_000_000_000, streakS: 30 }],
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(1000).syncLit).toBe(true); // lit at drain
    expect(dir.sample(35_999).syncLit).toBe(true); // 34 999 ms after drain
    expect(dir.sample(37_000).syncLit).toBe(false); // 36 s after drain, no new event
  });

  it('goes dark on the first sample when no rider has a numeric target (round-3 finding 1)', () => {
    const state = makeState({
      session: session([rider({ targetW: 200 })]),
      events: [{ kind: 'bothInZone', ts: 1000, streakS: 30 }],
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(0).syncLit).toBe(true); // lit during the steady step
    // Workout completes: every rider's target goes null. The bothInZone was
    // only 5 s ago — still inside the 35 s window — so only the target check
    // can (and must) put the core out.
    state.session = session([rider({ targetW: null })]);
    expect(dir.sample(5000).syncLit).toBe(false);
    // A FRESH bothInZone while targets stay null cannot relight the core.
    state.events.push({ kind: 'bothInZone', ts: 6000, streakS: 60 });
    expect(dir.sample(6000).syncLit).toBe(false);
    expect(dir.sample(10_000).syncLit).toBe(false);
  });
});

describe('rider lifecycle and frame shape', () => {
  it('drops smoothing state for departed riders', () => {
    const state = makeState({
      session: session([rider({ targetW: 200 })]),
      latest: { r1: sample({ powerW: 200, cadenceRpm: 85 }) },
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(0).riders[0]!.ratio).toBe(1);
    // r1 leaves, r2 joins: r2 starts fresh (no state bleed)
    state.session = session([rider({ riderId: 'r2', name: 'R2', targetW: 200 })]);
    state.latest = { r2: sample({ riderId: 'r2', powerW: 100, cadenceRpm: 85 }) };
    let frame = dir.sample(1000);
    expect(frame.riders.map((r) => r.riderId)).toEqual(['r2']);
    expect(frame.riders[0]!.ratio).toBe(0.5);
    // r2 leaves, r1 rejoins: r1's old smoothing state is gone too
    state.session = session([rider({ targetW: 200 })]);
    state.latest = { r1: sample({ powerW: 100, cadenceRpm: 85 }) };
    frame = dir.sample(2000);
    expect(frame.riders[0]!.ratio).toBe(0.5); // leaked prev 1.0 would give ≈0.803
  });

  it('reports seed, zonePct and idle frames', () => {
    const state = makeState({
      session: session([rider({ ftpW: 200, targetW: 150 })], { id: 'abc' }),
      latest: { r1: sample({ powerW: 150, cadenceRpm: 85 }) },
    });
    let frame = createGameDirector(() => state).sample(0);
    expect(frame.seed).toBe('abc');
    expect(frame.riders[0]!.zonePct).toBe(75);
    state.session = null;
    frame = createGameDirector(() => state).sample(0);
    expect(frame.seed).toBe('idle');
    expect(frame.riders).toEqual([]);
    expect(frame.shipSpeed).toBe(0);
    expect(frame.weather).toBe(0);
    expect(frame.events).toEqual([]);
    expect(frame.progress).toBe(0.5);
    expect(frame.rescue).toBeNull();
    expect(frame.destination).toBeNull();
    expect(frame.surveys).toEqual({ total: 0, revealed: 0 });
    expect(frame.legKind).toBeNull();
    expect(frame.syncLit).toBe(false);
  });
});

describe('rescue', () => {
  const distressed = rider({
    riderId: 'r1',
    name: 'Ada',
    targetW: 100,
    ergGuardActive: true,
    workoutId: 'w1',
    elapsedS: 80,
    workoutRemainingS: 120,
  });
  const helper = rider({
    riderId: 'r2',
    name: 'Bob',
    targetW: 250,
    workoutId: 'w2',
    elapsedS: 80,
    workoutRemainingS: 120,
  });

  it('holds a rescue vis in the helper identity hue until distress clears', () => {
    const state = makeState({
      session: session([distressed, helper]),
      events: [{ kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 }],
    });
    const dir = createGameDirector(() => state);
    const frame = dir.sample(5000);
    expect(frame.rescue).toEqual({
      helperId: 'r2',
      riderId: 'r1',
      helperName: 'Bob',
      riderName: 'Ada',
      hue: IDENTITY_COLORS[1],
    });
    expect(frame.events).toEqual([]);

    state.session = session([rider({ ...distressed, ergGuardActive: false }), helper]);
    expect(dir.sample(6000).rescue).toBeNull();
  });

  it('does not change shipSpeed or progress when a rescue is active', () => {
    const latest = {
      r1: sample({ riderId: 'r1', powerW: 100, cadenceRpm: 30 }),
      r2: sample({ riderId: 'r2', powerW: 275, cadenceRpm: 90 }),
    };
    const riders = [distressed, helper];
    const base = createGameDirector(() => makeState({ session: session(riders), latest })).sample(1000);
    const rescued = createGameDirector(() =>
      makeState({
        session: session(riders),
        latest,
        events: [{ kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 }],
      }),
    ).sample(1000);
    expect(rescued.shipSpeed).toBe(base.shipSpeed);
    expect(rescued.progress).toBe(base.progress);
    expect(rescued.rescue).not.toBeNull();
  });

  it('drops the vis after the max hold even if distress remains', () => {
    const state = makeState({
      session: session([distressed, helper]),
      events: [{ kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 }],
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(5_000).rescue).not.toBeNull();
    expect(dir.sample(5_000 + 90_000).rescue).not.toBeNull();
    expect(dir.sample(5_000 + 90_001).rescue).toBeNull();
  });

  it('resets rescue state on a new session seed', () => {
    const state = makeState({
      session: session([distressed, helper]),
      events: [{ kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 }],
    });
    const dir = createGameDirector(() => state);
    expect(dir.sample(5000).rescue).not.toBeNull();
    state.session = session([distressed, helper], { id: 's2' });
    state.events = [];
    expect(dir.sample(6000).rescue).toBeNull();
  });

  it('skips the shield when the helper is absent from the snapshot', () => {
    const state = makeState({
      // The helper already left the session; only the distressed rider remains.
      session: session([distressed]),
      events: [{ kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 }],
    });
    expect(createGameDirector(() => state).sample(5000).rescue).toBeNull();
  });
});
