import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelemetrySampleSchema, virtualSpeed } from '@opencycle/shared';
import type { SessionEvent, SessionSnapshot, TelemetrySample, Workout } from '@opencycle/shared';

import { HrmDriver, TrainerDriver } from '../devices/driver.js';
import type { HrmSample, TrainerSample, TrainerStatus } from '../devices/driver.js';
import type { RideSummary } from './recorder.js';
import { SessionEngine } from './engine.js';
import type { RecorderLike, RiderConfig } from './engine.js';

class FakeTrainer extends TrainerDriver {
  readonly id: string;
  readonly name: string;
  readonly calls: number[] = [];
  rejecting = false;

  constructor(id: string) {
    super();
    this.id = id;
    this.name = `trainer-${id}`;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async setTargetPower(watts: number): Promise<void> {
    this.calls.push(watts);
    if (this.rejecting) throw new Error('control not acquired');
  }

  sample(powerW: number, cadenceRpm: number): void {
    this.emit('sample', { powerW, cadenceRpm, ts: Date.now() } satisfies TrainerSample);
  }

  status(kind: TrainerStatus['kind']): void {
    this.emit('status', { kind });
  }
}

class FakeHrm extends HrmDriver {
  readonly id: string;
  readonly name: string;

  constructor(id: string) {
    super();
    this.id = id;
    this.name = `hrm-${id}`;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  beat(bpm: number): void {
    this.emit('hr', { bpm, rrMs: [], ts: Date.now() } satisfies HrmSample);
  }
}

class FakeRecorder implements RecorderLike {
  readonly startCalls: Array<{
    sessionId: string;
    riderId: string;
    workoutId?: string;
    workoutName?: string;
    startedAt: number;
  }> = [];
  readonly appended: TelemetrySample[] = [];
  readonly finalizeCalls: Array<{
    rideId: string;
    endedAt: number;
    elapsedS?: number;
    ftpW?: number;
    laps?: Array<{ startTs: number; endTs: number; ridingS: number }>;
  }> = [];
  readonly sessionStartedCalls: Array<{ sessionId: string; startedAt: number }> = [];
  readonly sessionEndedCalls: Array<{ sessionId: string; endedAt: number }> = [];
  readonly discardCalls: string[] = [];
  /** When set, startRide throws for that riderId (simulates a recorder failure). */
  failStartOn: string | null = null;
  /** When set to a rideId, finalizeRide throws for it (simulates a finalize failure). */
  failFinalizeOn: string | null = null;

  startRide(opts: {
    sessionId: string;
    riderId: string;
    workoutId?: string;
    workoutName?: string;
    startedAt: number;
  }): string {
    this.startCalls.push(opts);
    if (this.failStartOn !== null && opts.riderId === this.failStartOn) {
      throw new Error(`cannot start ride for ${opts.riderId}`);
    }
    return `ride-${opts.riderId}`;
  }

  append(rideId: string, sample: TelemetrySample): void {
    this.appended.push(sample);
  }

  async finalizeRide(
    rideId: string,
    opts: { endedAt: number; elapsedS?: number; laps?: Array<{ startTs: number; endTs: number; ridingS: number }> },
  ): Promise<{ fitPath: string; summary: RideSummary }> {
    this.finalizeCalls.push({ rideId, ...opts });
    if (this.failFinalizeOn === rideId) {
      throw new Error(`cannot finalize ${rideId}`);
    }
    return {
      fitPath: `fit/${rideId}.fit`,
      summary: {
        durationS: 0,
        distanceM: 0,
        avgPowerW: 0,
        weightedPowerW: 0,
        avgHrBpm: null,
        trainingLoad: null,
      },
    };
  }

  discardRide(rideId: string): void {
    this.discardCalls.push(rideId);
  }

  sessionStarted(sessionId: string, startedAt: number): void {
    this.sessionStartedCalls.push({ sessionId, startedAt });
  }

  sessionEnded(sessionId: string, endedAt: number): void {
    this.sessionEndedCalls.push({ sessionId, endedAt });
  }

  async flush(): Promise<void> {}
}

interface Harness {
  engine: SessionEngine;
  recorder: FakeRecorder;
  trainers: Map<string, FakeTrainer>;
  hrms: Map<string, FakeHrm>;
  events: SessionEvent[];
  telemetryBatches: TelemetrySample[][];
  states: SessionSnapshot[];
  /** Count of engine 'ended' emissions (session cleared: stop or rollback). */
  endedCount: number;
}

function makeHarness(): Harness {
  const trainers = new Map<string, FakeTrainer>();
  const hrms = new Map<string, FakeHrm>();
  const findDriver = (id: string): TrainerDriver | HrmDriver | undefined => trainers.get(id) ?? hrms.get(id);
  const recorder = new FakeRecorder();
  const engine = new SessionEngine({ findDriver, recorder, tickMs: 1000, now: () => Date.now() });
  const events: SessionEvent[] = [];
  const telemetryBatches: TelemetrySample[][] = [];
  const states: SessionSnapshot[] = [];
  let endedCount = 0;
  engine.on('event', (e) => events.push(e));
  engine.on('telemetry', (samples) => telemetryBatches.push(samples));
  engine.on('state', (s) => states.push(s));
  engine.on('ended', () => {
    endedCount += 1;
  });
  return { engine, recorder, trainers, hrms, events, telemetryBatches, states, get endedCount() { return endedCount; } };
}

type TestStep =
  | { kind: 'steady'; seconds: number; targetPctFtp: number }
  | { kind: 'ramp'; seconds: number; fromPctFtp: number; toPctFtp: number }
  | {
      kind: 'interval';
      repeats: number;
      on: { seconds: number; targetPctFtp: number };
      off: { seconds: number; targetPctFtp: number };
    }
  | { kind: 'free'; seconds: number };

function steady(seconds: number, targetPctFtp: number): TestStep {
  return { kind: 'steady', seconds, targetPctFtp };
}

function workout(id: string, steps: TestStep[]): Workout {
  return { id, name: id, description: '', tags: [], steps };
}

function riderCfg(id: string, ftpW: number, w: Workout, trainerId?: string, hrmId?: string): RiderConfig {
  return {
    profile: { id, name: id, ftpW, weightKg: 75 },
    trainerId: trainerId ?? `t-${id}`,
    hrmId,
    workout: w,
  };
}

/** Emit one sample per trainer, then advance one tick; repeat n times. */
async function ticks(n: number, ...emitters: Array<() => void>): Promise<void> {
  for (let i = 0; i < n; i++) {
    for (const emit of emitters) emit();
    await vi.advanceTimersByTimeAsync(1000);
  }
}

const stepEvents = (events: SessionEvent[]): Array<Extract<SessionEvent, { kind: 'stepCompleted' }>> =>
  events.filter((e): e is Extract<SessionEvent, { kind: 'stepCompleted' }> => e.kind === 'stepCompleted');

const rescueEvents = (events: SessionEvent[]): Array<Extract<SessionEvent, { kind: 'rescue' }>> =>
  events.filter((e): e is Extract<SessionEvent, { kind: 'rescue' }> => e.kind === 'rescue');

const legEvents = (events: SessionEvent[]): Array<Extract<SessionEvent, { kind: 'legCompleted' }>> =>
  events.filter((e): e is Extract<SessionEvent, { kind: 'legCompleted' }> => e.kind === 'legCompleted');

async function startRescuePair(h: Harness): Promise<{ t1: FakeTrainer; t2: FakeTrainer }> {
  const t1 = new FakeTrainer('t-r1');
  const t2 = new FakeTrainer('t-r2');
  h.trainers.set('t-r1', t1);
  h.trainers.set('t-r2', t2);
  await h.engine.startSession([
    riderCfg('r1', 200, workout('w1', [steady(600, 1.0)])),
    riderCfg('r2', 250, workout('w2', [steady(600, 1.0)])),
  ]);
  return { t1, t2 };
}

/** r1 death-spirals into ergGuard; r2 holds the given watts. */
async function engageDistress(t1: FakeTrainer, t2: FakeTrainer, helperPowerW: number): Promise<void> {
  await ticks(5, () => t1.sample(100, 30), () => t2.sample(helperPowerW, 90));
}


describe('SessionEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drives two riders to divergent ERG targets with change-only pushes', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    const t2 = new FakeTrainer('t-r2');
    h.trainers.set('t-r1', t1);
    h.trainers.set('t-r2', t2);
    const hrm = new FakeHrm('h-r1');
    h.hrms.set('h-r1', hrm);
    const w1 = workout('w1', [steady(100, 0.5), steady(100, 1.0)]);
    const w2 = workout('w2', [steady(200, 0.8)]);
    await h.engine.startSession([
      riderCfg('r1', 200, w1, 't-r1', 'h-r1'),
      riderCfg('r2', 250, w2, 't-r2'),
    ]);

    await ticks(
      150,
      () => t1.sample(150, 90),
      () => hrm.beat(140),
      () => t2.sample(150, 90),
    );

    const snap = h.engine.session!;
    expect(snap.riders[0]!.targetW).toBe(200); // step 2 of r1: 1.0 × 200, bias 0
    expect(snap.riders[0]!.stepIndex).toBe(1);
    expect(snap.riders[1]!.targetW).toBe(200); // r2: 0.8 × 250
    expect(snap.riders[1]!.stepIndex).toBe(0);
    expect(snap.riders[0]!.biasPct).toBe(0);
    // change-only: one push per target change, not per tick
    expect(t1.calls).toEqual([100, 200]);
    expect(t2.calls).toEqual([200]);
    // HRM merge + co-op roster events
    expect(h.recorder.appended.filter((s) => s.riderId === 'r1')[0]!.hrBpm).toBe(140);
    expect(h.events.filter((e) => e.kind === 'riderJoined').map((e) => e.riderId)).toEqual(['r1', 'r2']);
    expect(stepEvents(h.events)).toEqual([
      { kind: 'stepCompleted', riderId: 'r1', stepIndex: 0, ts: expect.any(Number) },
    ]);
  });

  it('pause freezes the clock, pushes and telemetry; resume continues', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(100, 0.5), steady(100, 1.0)]))]);

    await ticks(5, () => t1.sample(150, 90));
    const appendedAtPause = h.recorder.appended.length;
    const batchesAtPause = h.telemetryBatches.length;

    h.engine.pause('r1');
    await ticks(10, () => t1.sample(150, 90));

    // frozen: no telemetry, no pushes, no step progress, elapsedS not counted
    expect(h.recorder.appended.length).toBe(appendedAtPause);
    expect(h.telemetryBatches.length).toBe(batchesAtPause);
    expect(t1.calls).toEqual([100]);
    expect(stepEvents(h.events)).toHaveLength(0);
    expect(h.engine.session!.riders[0]!.state).toBe('paused');
    expect(h.engine.session!.riders[0]!.elapsedS).toBe(5);

    h.engine.resume('r1');
    await ticks(5, () => t1.sample(150, 90));
    expect(h.engine.session!.riders[0]!.state).toBe('riding');
    expect(h.engine.session!.riders[0]!.elapsedS).toBe(10); // paused seconds excluded
    expect(t1.calls).toEqual([100]); // unchanged target → no push after resume

    // step 1 still needs its remaining 95 riding seconds
    await ticks(95, () => t1.sample(150, 90));
    expect(stepEvents(h.events)).toHaveLength(1);
    expect(t1.calls).toEqual([100, 200]);
  });

  it('skipStep jumps to the step boundary and fires stepCompleted', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(100, 0.5), steady(100, 1.0)]))]);

    await ticks(3, () => t1.sample(150, 90));
    h.engine.skipStep('r1');
    await ticks(1, () => t1.sample(150, 90));

    expect(stepEvents(h.events)).toEqual([
      { kind: 'stepCompleted', riderId: 'r1', stepIndex: 0, ts: expect.any(Number) },
    ]);
    const snap = h.engine.session!;
    expect(snap.riders[0]!.stepIndex).toBe(1);
    expect(snap.riders[0]!.stepRemainingS).toBe(99); // step 1 ends at 200 s; clock at 101 s
    expect(t1.calls).toEqual([100, 200]); // new step target pushed
  });

  it('workoutRemainingS spans the whole remaining workout and nulls on completion', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([
      riderCfg('r1', 200, workout('w1', [steady(100, 0.5), steady(200, 1.0), steady(300, 0.8)])),
    ]);

    // Mid second step, clock 150 of a 600 s workout: the TOTAL remaining is
    // 450 s across all steps — not the current step's 150 s. Progress must
    // not saturate on the last step's tail.
    await ticks(150, () => t1.sample(150, 90));
    const snap = h.engine.session!;
    expect(snap.riders[0]!.stepIndex).toBe(1);
    expect(snap.riders[0]!.stepRemainingS).toBe(150); // current flat step spans 100–300 s
    expect(snap.riders[0]!.workoutRemainingS).toBe(450); // 600 − 150 across ALL steps

    // skipStep jumps the clock to the end of the current SOURCE step (300 s);
    // the total remaining tracks the jump, still spanning the unridden tail.
    h.engine.skipStep('r1');
    expect(h.engine.session!.riders[0]!.workoutRemainingS).toBe(300); // 600 − 300

    // The boundary tick opens the last step; remaining keeps shrinking.
    await ticks(1, () => t1.sample(150, 90));
    expect(h.engine.session!.riders[0]!.stepIndex).toBe(2);
    expect(h.engine.session!.riders[0]!.workoutRemainingS).toBe(299); // 600 − 301

    // Ride the last step out: the workout completes and remaining goes null.
    await ticks(300, () => t1.sample(150, 90));
    expect(h.events.filter((e) => e.kind === 'workoutCompleted')).toHaveLength(1);
    expect(h.engine.session!.riders[0]!.workoutRemainingS).toBeNull();
  });

  it('reports steady and interval cue boundaries', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([
      riderCfg('r1', 200, workout('w1', [
        steady(10, 0.5),
        { kind: 'interval', repeats: 1,
          on: { seconds: 5, targetPctFtp: 1 },
          off: { seconds: 5, targetPctFtp: 0.5 } },
      ])),
    ]);

    expect(h.engine.session!.riders[0]).toMatchObject({
      stepKind: 'steady',
      stepCueRemainingS: 10,
      nextTargetW: 200,
    });

    await ticks(10, () => t1.sample(100, 90));
    expect(h.engine.session!.riders[0]).toMatchObject({
      stepKind: 'interval',
      stepCueRemainingS: 5,
      nextTargetW: 100,
    });
  });

  it('reports ramp endpoint, biased future target, free cue, and completion', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([
      riderCfg('r1', 200, workout('w1', [
        { kind: 'ramp', seconds: 20, fromPctFtp: 0.5, toPctFtp: 1 },
        { kind: 'free', seconds: 10 },
        steady(10, 0.6),
      ])),
    ]);

    expect(h.engine.session!.riders[0]).toMatchObject({
      stepKind: 'ramp',
      stepCueRemainingS: 20,
      nextTargetW: 200,
    });

    h.engine.setBias('r1', 10);
    expect(h.engine.session!.riders[0]!.nextTargetW).toBe(220);

    await ticks(20, () => t1.sample(150, 90));
    expect(h.engine.session!.riders[0]).toMatchObject({
      stepKind: 'free',
      stepCueRemainingS: 10,
      nextTargetW: 132,
    });

    await ticks(20, () => t1.sample(120, 90));
    expect(h.engine.session!.riders[0]).toMatchObject({
      stepKind: null,
      stepCueRemainingS: null,
      nextTargetW: null,
    });
  });

  it('workoutCompleted fires once and the rider keeps riding free', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(100, 0.5), steady(100, 1.0)]))]);

    await ticks(200, () => t1.sample(150, 90));

    expect(h.events.filter((e) => e.kind === 'workoutCompleted')).toHaveLength(1);
    expect(stepEvents(h.events)).toHaveLength(2);
    expect(h.engine.session!.riders[0]!.stepIndex).toBe(2);
    expect(h.engine.session!.riders[0]!.targetW).toBeNull();
    expect(h.engine.session!.riders[0]!.stepRemainingS).toBeNull();

    // keeps riding free: telemetry continues, one floor push (50 % FTP), no more events
    const appended = h.recorder.appended.length;
    const distanceAtEnd = h.engine.session!.riders[0]!.distanceM;
    await ticks(50, () => t1.sample(150, 90));
    expect(h.recorder.appended.length).toBe(appended + 50);
    expect(h.recorder.appended.at(-1)!.targetW).toBeUndefined(); // snapshot/telemetry target stays null (free)
    expect(h.recorder.appended.at(-1)!.distanceM).toBeGreaterThan(distanceAtEnd);
    expect(t1.calls).toEqual([100, 200, 100]); // floor = 0.5 × 200 W FTP, pushed exactly once
    expect(h.events.filter((e) => e.kind === 'workoutCompleted')).toHaveLength(1);
    expect(stepEvents(h.events)).toHaveLength(2);
  });

  it('setBias moves the target by 1% FTP steps and clamps at ±15', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(200, 0.8)]))]);

    await ticks(2, () => t1.sample(150, 90));
    expect(t1.calls).toEqual([160]);

    h.engine.setBias('r1', 1);
    await ticks(1, () => t1.sample(150, 90));
    expect(t1.calls).toEqual([160, 162]); // round(160 × 1.01)
    expect(h.engine.session!.riders[0]!.biasPct).toBe(1);
    expect(h.engine.session!.riders[0]!.targetW).toBe(162);

    h.engine.setBias('r1', -1);
    await ticks(1, () => t1.sample(150, 90));
    expect(t1.calls).toEqual([160, 162, 160]);
    expect(h.engine.session!.riders[0]!.biasPct).toBe(0);

    for (let i = 0; i < 20; i++) {
      h.engine.setBias('r1', 1);
      await ticks(1, () => t1.sample(150, 90));
    }
    expect(h.engine.session!.riders[0]!.biasPct).toBe(15);
    expect(h.engine.session!.riders[0]!.targetW).toBe(184); // 160 × 1.15
    h.engine.setBias('r1', 1);
    await ticks(1, () => t1.sample(150, 90));
    expect(h.engine.session!.riders[0]!.biasPct).toBe(15); // clamped
    expect(t1.calls.at(-1)).toBe(184); // no push when clamped target is unchanged
  });

  it('death-spiral guard engages at 50% FTP and restores on cadence recovery', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(200, 1.0)]))]);

    const spin = () => t1.sample(100, 30); // power < 90 % of 200 W, cadence < 40
    await ticks(4, spin);
    expect(h.events.filter((e) => e.kind === 'ergGuard')).toHaveLength(0);

    await ticks(1, spin); // 5th consecutive second
    expect(h.events.filter((e) => e.kind === 'ergGuard' && e.engaged)).toHaveLength(1);
    expect(t1.calls).toEqual([200, 100]); // driven at 50 % FTP
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(true);
    expect(h.engine.session!.riders[0]!.targetW).toBe(100);
    expect(h.engine.session!.riders[0]).toMatchObject({
      stepKind: 'steady',
      targetW: 100,
    });

    await ticks(3, spin); // stays engaged, no re-push
    expect(t1.calls).toEqual([200, 100]);

    await ticks(1, () => t1.sample(150, 65)); // cadence ≥ 60 → release
    expect(h.events.filter((e) => e.kind === 'ergGuard' && !e.engaged)).toHaveLength(1);
    expect(t1.calls).toEqual([200, 100, 200]); // step target restored
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(false);
    expect(h.engine.session!.riders[0]!.targetW).toBe(200);
  });

  it('bothInZone emits every 30 s with a cumulative streak and resets when a rider leaves the zone', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    const t2 = new FakeTrainer('t-r2');
    h.trainers.set('t-r1', t1);
    h.trainers.set('t-r2', t2);
    await h.engine.startSession([
      riderCfg('r1', 200, workout('w1', [steady(600, 1.0)])),
      riderCfg('r2', 250, workout('w2', [steady(600, 1.0)])),
    ]);

    const zoneEvents = () => h.events.filter((e) => e.kind === 'bothInZone');

    await ticks(30, () => t1.sample(200, 90), () => t2.sample(250, 90));
    expect(zoneEvents()).toHaveLength(1);
    expect(zoneEvents()[0]!.streakS).toBe(30);

    // Cumulative: the streak keeps counting through emissions — no re-arm.
    await ticks(30, () => t1.sample(200, 90), () => t2.sample(250, 90));
    expect(zoneEvents()).toHaveLength(2);
    expect(zoneEvents()[1]!.streakS).toBe(60);

    await ticks(5, () => t1.sample(100, 90), () => t2.sample(250, 90)); // r1 leaves zone
    expect(zoneEvents()).toHaveLength(2);

    await ticks(30, () => t1.sample(200, 90), () => t2.sample(250, 90)); // 30 fresh seconds together
    expect(zoneEvents()).toHaveLength(3);
    expect(zoneEvents()[2]!.streakS).toBe(30);
  });

  it('never emits bothInZone with fewer than 2 in-zone riders', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(600, 1.0)]))]);

    await ticks(40, () => t1.sample(200, 90));
    expect(h.events.filter((e) => e.kind === 'bothInZone')).toHaveLength(0);
  });

  it('addRider joins mid-session and stopRider finalizes only that ride', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    const t3 = new FakeTrainer('t-r3');
    h.trainers.set('t-r1', t1);
    h.trainers.set('t-r3', t3);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(200, 0.8)]))]);
    await ticks(5, () => t1.sample(150, 90));

    await h.engine.addRider(riderCfg('r3', 250, workout('w3', [steady(100, 0.5)]), 't-r3'));
    expect(h.events.filter((e) => e.kind === 'riderJoined').map((e) => e.riderId)).toEqual(['r1', 'r3']);

    await ticks(3, () => t1.sample(150, 90), () => t3.sample(125, 90));
    expect(t3.calls).toEqual([125]); // 0.5 × 250 — ticks independently
    expect(h.recorder.startCalls.map((c) => c.riderId)).toEqual(['r1', 'r3']);
    expect(h.recorder.appended.filter((s) => s.riderId === 'r3')).toHaveLength(3);

    await h.engine.stopRider('r1');
    expect(h.recorder.finalizeCalls).toHaveLength(1);
    expect(h.recorder.finalizeCalls[0]!.rideId).toBe('ride-r1');
    expect(h.recorder.finalizeCalls[0]!.elapsedS).toBe(8);
    // trainingLoad depends on the rider's FTP reaching the recorder.
    expect(h.recorder.finalizeCalls[0]!.ftpW).toBe(200);
    // stopped inside the first step: only the partial tail lap, 8 riding seconds
    expect(h.recorder.finalizeCalls[0]!.laps).toEqual([
      { startTs: expect.any(Number), endTs: expect.any(Number), ridingS: 8 },
    ]);
    expect(h.events.filter((e) => e.kind === 'riderLeft').map((e) => e.riderId)).toEqual(['r1']);
    expect(h.engine.session!.riders[0]!.state).toBe('stopped');
    expect(h.engine.session!.riders[0]!.targetW).toBeNull();

    const r1Appended = h.recorder.appended.filter((s) => s.riderId === 'r1').length;
    await ticks(3, () => t1.sample(150, 90), () => t3.sample(125, 90));
    expect(h.recorder.appended.filter((s) => s.riderId === 'r1')).toHaveLength(r1Appended);
    expect(h.recorder.finalizeCalls).toHaveLength(1); // finalized exactly once
    expect(h.engine.session!.riders[1]!.state).toBe('riding'); // session continues

    // r3 finishes its workout: one source-step lap (100 riding s) + free-ride tail lap
    await ticks(105, () => t3.sample(125, 90));
    expect(h.events.filter((e) => e.kind === 'workoutCompleted' && e.riderId === 'r3')).toHaveLength(1);
    await h.engine.stopRider('r3');
    expect(h.recorder.finalizeCalls).toHaveLength(2);
    expect(h.recorder.finalizeCalls[1]!.rideId).toBe('ride-r3');
    expect(h.recorder.finalizeCalls[1]!.laps).toEqual([
      { startTs: expect.any(Number), endTs: expect.any(Number), ridingS: 100 },
      { startTs: expect.any(Number), endTs: expect.any(Number), ridingS: 11 },
    ]);
  });

  it('integrates distance from physics speed at constant power', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(600, 1.0)]))]);

    const speedMps = virtualSpeed(200, 75);
    expect(speedMps).toBeGreaterThan(9.3); // ~9.4 m/s ≈ 34 km/h at 200 W / 75 kg
    expect(speedMps).toBeLessThan(9.5);

    await ticks(10, () => t1.sample(200, 90));
    const snap = h.engine.session!.riders[0]!;
    expect(snap.elapsedS).toBe(10);
    expect(snap.distanceM).toBeCloseTo(speedMps * 10, 1);
    expect(h.recorder.appended[0]!.speedKmh).toBeCloseTo(speedMps * 3.6, 2);
  });

  it('swallows setTargetPower rejections and retries the pending target', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(200, 0.8)]))]);

    t1.rejecting = true;
    await ticks(3, () => t1.sample(150, 90));
    expect(t1.calls).toEqual([160, 160, 160]); // rejected push retried each tick, never fatal

    t1.rejecting = false;
    await ticks(1, () => t1.sample(150, 90));
    expect(t1.calls).toEqual([160, 160, 160, 160]);
    await ticks(2, () => t1.sample(150, 90));
    expect(t1.calls).toEqual([160, 160, 160, 160]); // change-only resumes after success
  });

  it('stopSession finalizes every ride, emits riderLeft, and clears the session', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    const t2 = new FakeTrainer('t-r2');
    h.trainers.set('t-r1', t1);
    h.trainers.set('t-r2', t2);
    await h.engine.startSession([
      riderCfg('r1', 200, workout('w1', [steady(200, 0.8)])),
      riderCfg('r2', 250, workout('w2', [steady(200, 0.8)])),
    ]);
    await ticks(5, () => t1.sample(150, 90), () => t2.sample(150, 90));

    await h.engine.stopSession();
    expect(h.engine.session).toBeNull();
    expect(h.endedCount).toBe(1); // terminal 'ended' fires once the session is cleared
    expect(h.recorder.finalizeCalls).toHaveLength(2);
    expect(h.recorder.finalizeCalls.map((c) => c.rideId).sort()).toEqual(['ride-r1', 'ride-r2']);
    // session lifecycle: one started, one ended; each ride got a tail lap + elapsedS
    expect(h.recorder.sessionStartedCalls).toEqual([
      { sessionId: expect.any(String), startedAt: expect.any(Number) },
    ]);
    expect(h.recorder.sessionEndedCalls).toEqual([
      { sessionId: expect.any(String), endedAt: expect.any(Number) },
    ]);
    expect(h.recorder.finalizeCalls[0]!.laps).toHaveLength(1); // tail lap only (no boundary crossed)
    expect(h.recorder.finalizeCalls[0]!.elapsedS).toBe(5);
    expect(h.events.filter((e) => e.kind === 'riderLeft').map((e) => e.riderId).sort()).toEqual([
      'r1',
      'r2',
    ]);

    const statesBefore = h.states.length;
    const batchesBefore = h.telemetryBatches.length;
    await ticks(3, () => t1.sample(150, 90), () => t2.sample(150, 90));
    expect(h.states.length).toBe(statesBefore); // tick loop is dead
    expect(h.telemetryBatches.length).toBe(batchesBefore);
  });

  it('pushes one floor target (50% FTP) when the target goes null (interval to free)', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    const w = workout('w1', [
      {
        kind: 'interval',
        repeats: 2,
        on: { seconds: 10, targetPctFtp: 1.0 },
        off: { seconds: 10, targetPctFtp: 0.8 },
      },
      { kind: 'free', seconds: 60 },
    ]);
    await h.engine.startSession([riderCfg('r1', 200, w)]);

    await ticks(40, () => t1.sample(150, 90)); // interval ends at 40 s, free begins
    // two on/off rounds (200 / 160 each), then the floor = 0.5 × 200 FTP
    expect(t1.calls).toEqual([200, 160, 200, 160, 100]);
    expect(h.engine.session!.riders[0]!.targetW).toBeNull(); // UI still shows free
    // one stepCompleted for the whole interval source step, not per repeat
    expect(stepEvents(h.events)).toEqual([
      { kind: 'stepCompleted', riderId: 'r1', stepIndex: 0, ts: expect.any(Number) },
    ]);

    // floor is pushed exactly once: no re-pushes while the free step runs
    await ticks(30, () => t1.sample(150, 90));
    expect(t1.calls).toEqual([200, 160, 200, 160, 100]);
    expect(stepEvents(h.events)).toHaveLength(1);

    // free step completes: source step 1 finished, workout over
    await ticks(30, () => t1.sample(150, 90));
    expect(stepEvents(h.events).map((e) => e.stepIndex)).toEqual([0, 1]);
    expect(h.events.filter((e) => e.kind === 'workoutCompleted')).toHaveLength(1);
    expect(t1.calls).toEqual([200, 160, 200, 160, 100]); // floor unchanged
  });

  it('death-spiral guard release restores the biased step target', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(200, 1.0)]))]);

    h.engine.setBias('r1', 5); // step target becomes 210
    await ticks(1, () => t1.sample(200, 90));
    expect(t1.calls).toEqual([210]);

    const spin = () => t1.sample(100, 30); // power < 90 % of 210 W, cadence < 40
    await ticks(5, spin);
    expect(t1.calls).toEqual([210, 100]); // guard engaged at 50 % FTP
    expect(h.engine.session!.riders[0]!.targetW).toBe(100);

    await ticks(1, () => t1.sample(150, 65)); // cadence ≥ 60 → release
    expect(t1.calls).toEqual([210, 100, 210]); // biased target restored, not the raw 200
    expect(h.engine.session!.riders[0]!.targetW).toBe(210);
  });

  it('startSession rolls back and stays startable when a rider fails to start', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    const t2 = new FakeTrainer('t-r2');
    h.trainers.set('t-r1', t1);
    h.trainers.set('t-r2', t2);
    h.recorder.failStartOn = 'r2';

    await expect(
      h.engine.startSession([
        riderCfg('r1', 200, workout('w1', [steady(200, 0.8)])),
        riderCfg('r2', 200, workout('w2', [steady(200, 0.8)]), 't-r2'),
      ]),
    ).rejects.toThrow('cannot start ride for r2');

    expect(h.engine.session).toBeNull(); // rollback: no half-started session
    expect(h.endedCount).toBe(1); // rollback also emits the terminal 'ended'
    // Rollback residue cleaned: r1's started ride was discarded, and the final
    // state event mirrors stopSession's terminal snapshot (riders stopped).
    expect(h.recorder.discardCalls).toEqual(['ride-r1']);
    expect(h.states.at(-1)!.riders[0]!.state).toBe('stopped');
    // r1's partially attached listeners were detached: emitting samples does nothing
    await ticks(2, () => t1.sample(150, 90));
    expect(h.recorder.appended).toHaveLength(0);
    expect(h.telemetryBatches).toHaveLength(0);

    h.recorder.failStartOn = null;
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(200, 0.8)]))]);
    await ticks(2, () => t1.sample(150, 90));
    expect(h.recorder.appended).toHaveLength(2);
    expect(t1.calls).toEqual([160]);
  });

  it('treats stale trainer samples as 0 W / 0 rpm so distance stops accruing', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(600, 1.0)]))]);

    // Samples are emitted before each tick, so the last sample (t = 4 s) is
    // consumed by the tick at t = 5 s; the 3 s staleness window covers ticks
    // through t = 7 s, and the t = 8 s tick reads it as stale.
    await ticks(5, () => t1.sample(200, 90));
    await ticks(2); // t = 6..7 s: still within the window → live
    const lastLive = h.recorder.appended.at(-1)!;
    expect(lastLive.powerW).toBe(200);
    expect(lastLive.cadenceRpm).toBe(90);

    await ticks(1); // t = 8 s: sample is 4 s old → stale
    const stale = h.recorder.appended.at(-1)!;
    expect(stale.powerW).toBe(0);
    expect(stale.cadenceRpm).toBe(0);
    expect(stale.distanceM).toBe(lastLive.distanceM); // no distance accrual

    await ticks(2);
    expect(h.recorder.appended.at(-1)!.distanceM).toBe(lastLive.distanceM);
    expect(h.recorder.appended.at(-1)!.powerW).toBe(0);
  });

  it('treats a stale trainer sample as out of the zone: no bothInZone while a rider is silent', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    const t2 = new FakeTrainer('t-r2');
    h.trainers.set('t-r1', t1);
    h.trainers.set('t-r2', t2);
    await h.engine.startSession([
      riderCfg('r1', 200, workout('w1', [steady(600, 1.0)])),
      riderCfg('r2', 250, workout('w2', [steady(600, 1.0)])),
    ]);

    const zoneEvents = () => h.events.filter((e) => e.kind === 'bothInZone');

    await ticks(5, () => t1.sample(200, 90), () => t2.sample(250, 90)); // both at target
    expect(zoneEvents()).toHaveLength(0);

    // t2's trainer goes silent: its last sample (at target, 250 W) goes stale
    // and must count as out of zone — the streak dies instead of banking on
    // the frozen sample.
    await ticks(40, () => t1.sample(200, 90));
    expect(zoneEvents()).toHaveLength(0);

    // Fresh samples again: a full 30 s together are required from zero — the
    // silent stretch reset the streak rather than only pausing it.
    await ticks(30, () => t1.sample(200, 90), () => t2.sample(250, 90));
    expect(zoneEvents()).toHaveLength(1);
    expect(zoneEvents()[0]!.streakS).toBe(30);
  });

  it('emits schema-valid samples: negative trainer values are clamped and out-of-range HR is dropped', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    const hrm = new FakeHrm('h-r1');
    h.hrms.set('h-r1', hrm);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(600, 1.0)]), 't-r1', 'h-r1')]);

    // FTMS sint16 coast-down negatives + garbage HRM readings (contact lost):
    // every merged sample must still satisfy TelemetrySampleSchema.
    await ticks(2, () => t1.sample(-20, -5), () => hrm.beat(0));
    const sample = h.recorder.appended.at(-1)!;
    expect(sample.powerW).toBe(0);
    expect(sample.cadenceRpm).toBe(0);
    expect(sample.hrBpm).toBeUndefined(); // 0 bpm is contact loss, not a heartbeat
    expect(sample.distanceM).toBe(0); // no distance accrual from clamped 0 W

    await ticks(1, () => t1.sample(-20, -5), () => hrm.beat(300)); // above 250 → dropped too
    expect(h.recorder.appended.at(-1)!.hrBpm).toBeUndefined();

    for (const batch of h.telemetryBatches) {
      for (const s of batch) {
        expect(TelemetrySampleSchema.safeParse(s).success).toBe(true);
      }
    }
  });

  it('skipStep jumps to the end of the whole source step (interval block) and repeat presses are no-ops', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    const w = workout('w1', [
      {
        kind: 'interval',
        repeats: 2,
        on: { seconds: 10, targetPctFtp: 1.0 },
        off: { seconds: 10, targetPctFtp: 0.8 },
      },
      steady(100, 0.6),
    ]);
    await h.engine.startSession([riderCfg('r1', 200, w)]);

    await ticks(3, () => t1.sample(150, 90)); // mid-block: inside the first on repeat
    h.engine.skipStep('r1'); // jumps to the block end (40 s), not the repeat end
    const statesAfterSkip = h.states.length;
    h.engine.skipStep('r1'); // repeat press before any tick: no-op (no state emit)
    expect(h.states.length).toBe(statesAfterSkip);
    await ticks(1, () => t1.sample(150, 90));

    // The whole block coalesces into one stepCompleted for source step 0.
    expect(stepEvents(h.events)).toEqual([
      { kind: 'stepCompleted', riderId: 'r1', stepIndex: 0, ts: expect.any(Number) },
    ]);
    const snap = h.engine.session!;
    expect(snap.riders[0]!.stepIndex).toBe(4); // past the whole 4-flat block
    expect(snap.riders[0]!.stepRemainingS).toBe(99); // steady ends at 140 s; clock at 41 s
    expect(t1.calls).toEqual([200, 120]); // on (200 W) → block end → steady 0.6 × 200
  });

  it('stopRider reverts the state and stays retryable when finalize fails once', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(200, 0.8)]))]);
    await ticks(5, () => t1.sample(150, 90));

    h.recorder.failFinalizeOn = 'ride-r1';
    await expect(h.engine.stopRider('r1')).rejects.toThrow('cannot finalize ride-r1');

    // State reverted: still riding, listeners intact, samples keep flowing.
    expect(h.engine.session!.riders[0]!.state).toBe('riding');
    const appendedAtFailure = h.recorder.appended.length;
    await ticks(2, () => t1.sample(150, 90));
    expect(h.recorder.appended.length).toBe(appendedAtFailure + 2);
    expect(h.events.filter((e) => e.kind === 'riderLeft')).toHaveLength(0); // nothing emitted on failure

    h.recorder.failFinalizeOn = null;
    await h.engine.stopRider('r1'); // retry succeeds
    expect(h.recorder.finalizeCalls).toHaveLength(2);
    expect(h.recorder.finalizeCalls[1]!.rideId).toBe('ride-r1');
    expect(h.engine.session!.riders[0]!.state).toBe('stopped');
    expect(h.events.filter((e) => e.kind === 'riderLeft')).toHaveLength(1); // riderLeft only on success
  });

  it('stopSession clears the session and finalizes healthy riders when one finalize fails', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    const t2 = new FakeTrainer('t-r2');
    h.trainers.set('t-r1', t1);
    h.trainers.set('t-r2', t2);
    await h.engine.startSession([
      riderCfg('r1', 200, workout('w1', [steady(200, 0.8)])),
      riderCfg('r2', 250, workout('w2', [steady(200, 0.8)])),
    ]);
    await ticks(5, () => t1.sample(150, 90), () => t2.sample(150, 90));

    h.recorder.failFinalizeOn = 'ride-r1';
    await expect(h.engine.stopSession()).rejects.toBeInstanceOf(AggregateError);

    // The healthy rider was finalized; the failing one was attempted once.
    expect(h.recorder.finalizeCalls.map((c) => c.rideId).sort()).toEqual(['ride-r1', 'ride-r2']);
    expect(h.events.filter((e) => e.kind === 'riderLeft').map((e) => e.riderId)).toEqual(['r2']);
    // Session fully cleared: no session, session ended, listeners detached.
    expect(h.engine.session).toBeNull();
    expect(h.endedCount).toBe(1); // terminal 'ended' even when a finalize failed
    expect(h.recorder.sessionEndedCalls).toHaveLength(1);
    const appendedAtStop = h.recorder.appended.length;
    await ticks(2, () => t1.sample(150, 90), () => t2.sample(150, 90));
    expect(h.recorder.appended.length).toBe(appendedAtStop);
    expect(h.telemetryBatches).toHaveLength(5); // tick loop is dead
  });

  it('emits rescue once when a partner surges 15 s through an active distress', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await engageDistress(t1, t2, 250); // helper on-target during the engage window
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(true);
    expect(rescueEvents(h.events)).toHaveLength(0);

    const distanceBefore = h.engine.session!.riders[0]!.distanceM;
    await ticks(15, () => t1.sample(80, 25), () => t2.sample(275, 90)); // 1.10 × 250 W
    expect(rescueEvents(h.events)).toEqual([
      { kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: expect.any(Number) },
    ]);
    // Distressed workout / ERG is untouched; helper target is their own.
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(true);
    expect(h.engine.session!.riders[0]!.targetW).toBe(100);
    expect(h.engine.session!.riders[1]!.targetW).toBe(250);
    expect(t1.calls).toEqual([200, 100]);
    expect(t2.calls).toEqual([250]);
    expect(h.engine.session!.riders[0]!.distanceM).toBeGreaterThan(distanceBefore);

    await ticks(10, () => t1.sample(80, 25), () => t2.sample(300, 90));
    expect(rescueEvents(h.events)).toHaveLength(1);
  });

  it('does not emit rescue before 15 consecutive surge seconds', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await engageDistress(t1, t2, 250);
    await ticks(14, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(0);
    await ticks(1, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(1);
  });

  it('does not emit rescue when no partner is in distress', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await ticks(20, () => t1.sample(200, 90), () => t2.sample(300, 90));
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(false);
    expect(rescueEvents(h.events)).toHaveLength(0);
  });

  it('resets the rescue latch when distress ends so a later episode can fire', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await engageDistress(t1, t2, 250);
    await ticks(15, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(1);

    await ticks(1, () => t1.sample(150, 65), () => t2.sample(250, 90)); // cadence recovers
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(false);

    await engageDistress(t1, t2, 250);
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(true);
    await ticks(15, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(2);
    expect(rescueEvents(h.events).map((e) => e.helperId)).toEqual(['r2', 'r2']);
  });

  it('never lets a paused helper rescue', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await engageDistress(t1, t2, 250);
    h.engine.pause('r2');
    await ticks(20, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(0);
    expect(h.engine.session!.riders[1]!.state).toBe('paused');
  });

  it('never emits rescue in a single-rider session', async () => {
    const h = makeHarness();
    const t1 = new FakeTrainer('t-r1');
    h.trainers.set('t-r1', t1);
    await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(600, 1.0)]))]);
    await ticks(5, () => t1.sample(100, 30));
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(true);
    await ticks(20, () => t1.sample(80, 25));
    expect(rescueEvents(h.events)).toHaveLength(0);
  });

  it('breaks a mid-distress surge streak when the helper drops below 1.10', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await engageDistress(t1, t2, 250);
    await ticks(10, () => t1.sample(80, 25), () => t2.sample(275, 90));
    await ticks(1, () => t1.sample(80, 25), () => t2.sample(250, 90)); // drop below 1.10
    await ticks(14, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(0);
    await ticks(1, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(1);
  });

  it('keeps the rescue latch armed when the distressed rider pauses mid-episode', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await engageDistress(t1, t2, 250);
    await ticks(15, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(1);

    // Pause freezes the distressed rider: guard stays engaged (episode
    // alive), so the rescueEmitted latch must NOT re-arm.
    h.engine.pause('r1');
    await ticks(10, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(1);
    expect(h.engine.session!.riders[0]!.state).toBe('paused');
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(true);

    // Resume: the helper keeps surging, but no second emission fires for
    // this episode.
    h.engine.resume('r1');
    await ticks(30, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(1);

    // Guard recovery closes the episode; a later distress can fire again.
    await ticks(1, () => t1.sample(150, 65), () => t2.sample(250, 90));
    expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(false);
    await engageDistress(t1, t2, 250);
    await ticks(15, () => t1.sample(80, 25), () => t2.sample(275, 90));
    expect(rescueEvents(h.events)).toHaveLength(2);
  });

  it('never emits rescue once the helper itself enters ergGuard (guarded helpers never rescue)', async () => {
    const h = makeHarness();
    const { t1, t2 } = await startRescuePair(h);
    await engageDistress(t1, t2, 250);
    await ticks(10, () => t1.sample(80, 25), () => t2.sample(275, 90)); // helper surges, < 15 s
    expect(rescueEvents(h.events)).toHaveLength(0);

    // The helper death-spirals into their own guard: 5 s at low cadence
    // under 90 % of their target.
    await ticks(5, () => t1.sample(80, 25), () => t2.sample(80, 25));
    expect(h.engine.session!.riders[1]!.ergGuardActive).toBe(true);

    // A guarded helper can never rescue, even surging hard at low cadence
    // (275 W against their 125 W guard target ≈ 2.2× — cadence 25 keeps the
    // guard engaged, and guard.active excludes them regardless of ratio).
    await ticks(30, () => t1.sample(80, 25), () => t2.sample(275, 25));
    expect(h.engine.session!.riders[1]!.ergGuardActive).toBe(true);
    expect(rescueEvents(h.events)).toHaveLength(0);
  });

  describe('legs', () => {
    it('scores a 60 s burn ridden on target as a clean survey', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(60, 1.0)]))]);

      await ticks(60, () => t1.sample(200, 90));

      // 60 s leg: the 5 s ERG settle window and the closing tick (consumed by
      // advanceLegs before the tick's accounting) leave 54 counted seconds.
      expect(legEvents(h.events)).toEqual([
        {
          kind: 'legCompleted',
          riderId: 'r1',
          legIndex: 0,
          legKind: 'burn',
          objective: true,
          targetedS: 54,
          onTargetS: 54,
          clean: true,
          ts: expect.any(Number),
        },
      ]);
    });

    it('never scores power above target as on target', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(60, 1.0)]))]);

      await ticks(60, () => t1.sample(240, 90)); // 1.2 × target

      const leg = legEvents(h.events)[0]!;
      expect(leg).toMatchObject({ targetedS: 54, onTargetS: 0, clean: false });
    });

    it('counts guard seconds as targeted but never on target', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([
        riderCfg('r1', 200, workout('w1', [
          {
            kind: 'interval',
            repeats: 1,
            on: { seconds: 60, targetPctFtp: 1.0 },
            off: { seconds: 30, targetPctFtp: 0.5 },
          },
        ])),
      ]);

      // 100 W at 30 rpm engages the death-spiral guard on tick 5 and holds it.
      await ticks(60, () => t1.sample(100, 30));

      const leg = legEvents(h.events)[0]!;
      expect(leg).toMatchObject({ legKind: 'burn', targetedS: 54, onTargetS: 0, clean: false });
      expect(h.engine.session!.riders[0]!.ergGuardActive).toBe(true);
    });

    it('accrues no leg seconds while paused', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(60, 1.0)]))]);

      await ticks(10, () => t1.sample(200, 90));
      h.engine.pause('r1');
      await ticks(20); // 20 wall-clock seconds frozen: the workout clock does not move

      const paused = h.engine.session!.riders[0]!;
      expect(paused.state).toBe('paused');
      expect(paused.workoutClockS).toBe(10);
      expect(paused.legTargetedS).toBe(5); // ticks 6-10: after settle, before pause
      expect(legEvents(h.events)).toHaveLength(0);

      h.engine.resume('r1');
      await ticks(50, () => t1.sample(200, 90));
      expect(legEvents(h.events)[0]).toMatchObject({ targetedS: 54, onTargetS: 54, clean: true });
    });

    it('emits skipped legs with their small counters and never clean', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([
        riderCfg('r1', 200, workout('w1', [steady(60, 1.0), steady(60, 1.0)])),
      ]);

      await ticks(10, () => t1.sample(200, 90)); // 5 targeted seconds in leg 0
      h.engine.skipStep('r1'); // clock jumps to the end of source step 0 (60 s)
      await ticks(1, () => t1.sample(200, 90));

      const leg = legEvents(h.events)[0]!;
      expect(leg).toMatchObject({ legIndex: 0, targetedS: 5, onTargetS: 5, clean: false });
      expect(h.engine.session!.riders[0]!.legIndex).toBe(1);
    });

    it('emits legCompleted before the workoutCompleted of the same tick', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([riderCfg('r1', 200, workout('w1', [steady(60, 1.0)]))]);

      await ticks(60, () => t1.sample(200, 90));

      expect(h.events.map((e) => e.kind)).toEqual([
        'riderJoined',
        'legCompleted',
        'stepCompleted',
        'workoutCompleted',
      ]);
    });

    it('exposes legIndex, workoutClockS and surveysClean in the snapshot', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([
        riderCfg('r1', 200, workout('w1', [steady(60, 1.0), steady(60, 0.6)])),
      ]);

      await ticks(60, () => t1.sample(200, 90));

      const rider = h.engine.session!.riders[0]!;
      expect(rider.legs?.map((leg) => leg.kind)).toEqual(['burn', 'approach']);
      expect(rider.workoutClockS).toBe(60);
      expect(rider.legIndex).toBe(1);
      expect(rider.surveysClean).toBe(1);
      expect(rider.legTargetedS).toBe(0); // counters reset for the new leg
      expect(rider.legOnTargetS).toBe(0);

      // Riding the approach leg out finishes the workout: the legs stay, the
      // cursor and clock go null.
      await ticks(60, () => t1.sample(120, 90));
      const done = h.engine.session!.riders[0]!;
      expect(done.legs).toHaveLength(2);
      expect(done.legIndex).toBeNull();
      expect(done.workoutClockS).toBeNull();
      expect(done.surveysClean).toBe(1);
    });

    it('has no legs, legIndex or workout clock without a workout', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      await h.engine.startSession([
        { profile: { id: 'r1', name: 'r1', ftpW: 200, weightKg: 75 }, trainerId: 't-r1' },
      ]);

      const rider = h.engine.session!.riders[0]!;
      expect(rider.legs).toBeNull();
      expect(rider.legIndex).toBeNull();
      expect(rider.workoutClockS).toBeNull();

      await ticks(30, () => t1.sample(150, 90));
      expect(legEvents(h.events)).toHaveLength(0);
    });

    it('carries the session destination through to the snapshot', async () => {
      const h = makeHarness();
      const t1 = new FakeTrainer('t-r1');
      h.trainers.set('t-r1', t1);
      const destination = { seed: 'r1:voyage:0', name: 'Keinora', voyageIndex: 0, leadRiderId: 'r1' };

      const snapshot = await h.engine.startSession(
        [riderCfg('r1', 200, workout('w1', [steady(60, 1.0)]))],
        { destination },
      );
      expect(snapshot.destination).toEqual(destination);
      expect(h.engine.session!.destination).toEqual(destination);

      // A session started without one is a free-space cruise.
      await h.engine.stopSession();
      const free = await h.engine.startSession([riderCfg('r1', 200, workout('w2', [steady(60, 1.0)]))]);
      expect(free.destination).toBeNull();
    });
  });
});
