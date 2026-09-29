import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { isCleanLeg, LEG_SETTLE_S, resolveLegs, resolveSteps, virtualSpeed } from '@opencycle/shared';
import type {
  FlatStep,
  Leg,
  RiderProfile,
  SessionDestination,
  SessionEvent,
  SessionSnapshot,
  TelemetrySample,
  Workout,
} from '@opencycle/shared';

import { HrmDriver, TrainerDriver } from '../devices/driver.js';
import type { HrmSample, TrainerSample, TrainerStatus } from '../devices/driver.js';
import type { FinalizeRideOptions, RideSummary, StartRideOptions } from './recorder.js';

/**
 * Structural recorder dependency: the engine needs only these six methods,
 * and tests substitute fakes without carrying the real class's privates.
 */
export interface RecorderLike {
  startRide(opts: StartRideOptions): string;
  append(rideId: string, sample: TelemetrySample): void;
  finalizeRide(rideId: string, opts: FinalizeRideOptions): Promise<{ fitPath: string; summary: RideSummary }>;
  /** Removes a started-but-never-finalized ride (session rollback). */
  discardRide(rideId: string): void;
  sessionStarted(sessionId: string, startedAt: number): void;
  sessionEnded(sessionId: string, endedAt: number): void;
}

/**
 * Session engine: owns the 1 Hz per-rider tick loop, change-only ERG dispatch,
 * physics speed/distance, co-op events and the ERG death-spiral guard.
 *
 * The engine never connects or disconnects drivers: the caller owns device
 * lifecycle and hands live driver instances over through `findDriver`. The
 * engine only subscribes to driver samples/status and calls `setTargetPower`.
 */
export interface RiderConfig {
  profile: RiderProfile;
  trainerId: string;
  hrmId?: string;
  workout?: Workout;
  workoutId?: string;
}

export type EngineEvents = {
  telemetry: [TelemetrySample[]];
  event: [SessionEvent];
  state: [SessionSnapshot];
  /** Fires once the session is fully cleared (stopSession done / startSession rolled back). */
  ended: [];
};

const DEFAULT_TICK_MS = 1000;
/** Stale telemetry: samples older than 3 ticks (min 3 s) read as 0 W / 0 rpm. */
const STALE_SAMPLE_TICKS = 3;
const STALE_SAMPLE_MIN_MS = 3000;
/** Bias clamp, in percent-FTP steps. */
const BIAS_CLAMP_PCT = 15;
/** bothInZone: every eligible rider within ±10 % of their step target. */
const ZONE_TOLERANCE = 0.1;
const ZONE_STREAK_S = 30;
/** Death-spiral guard: cadence below this for 5 consecutive seconds … */
const GUARD_LOW_CADENCE_RPM = 40;
const GUARD_LOW_CADENCE_S = 5;
/** …while power is below this fraction of the target → engage. */
const GUARD_POWER_FRACTION = 0.9;
/** Guard releases once cadence reaches this. */
const GUARD_RELEASE_CADENCE_RPM = 60;
/** While engaged the trainer is driven at this fraction of FTP. */
const GUARD_TARGET_FTP_FRACTION = 0.5;
/** Rescue: helper power/target must hold this ratio for RESCUE_SURGE_S. */
const RESCUE_RATIO = 1.1;
const RESCUE_SURGE_S = 15;

function rescuePairKey(helperId: string, riderId: string): string {
  return `${helperId}\0${riderId}`;
}

type RiderState = 'riding' | 'paused' | 'stopped';

interface RiderSession {
  cfg: RiderConfig;
  /** Resolved workout steps; null = no workout or workout finished (free ride). */
  flat: FlatStep[] | null;
  /** Workout clock in seconds; advances only while riding. */
  clockS: number;
  /** Index of the current step; one past the end after the workout finishes. */
  stepIndex: number;
  /** Flight legs of this rider's workout; null without one (kept after it finishes). */
  legs: Leg[] | null;
  /** Index of the current leg; one past the end after the last leg completes. */
  legIndex: number;
  /** Survey accounting for the current leg: seconds targeted and on target. */
  legTargetedS: number;
  legOnTargetS: number;
  /** Objective legs surveyed clean so far this ride. */
  surveysClean: number;
  biasPct: number;
  state: RiderState;
  startedAt: number;
  /** Seconds actually riding (pauses excluded — matches the recorded ride). */
  elapsedS: number;
  distanceM: number;
  rideId: string;
  /** Completed source-step laps as wall-clock ranges, for FIT lap encoding. */
  laps: Array<{ startTs: number; endTs: number; ridingS: number }>;
  /** Wall-clock ts at which the current (open) lap began; startedAt initially. */
  lapStartTs: number;
  /** Riding seconds accumulated in the current lap (pauses excluded). */
  lapRidingS: number;
  lastTrainerSample: TrainerSample | undefined;
  lastHrmSample: HrmSample | undefined;
  /** Last ERG watts accepted by the trainer; null = nothing accepted yet. */
  lastSentTargetW: number | null;
  guard: { lowCadenceS: number; active: boolean };
  onSample: (sample: TrainerSample) => void;
  onStatus: (status: TrainerStatus) => void;
  onHr: (sample: HrmSample) => void;
}

type RiderCue = Pick<
  SessionSnapshot['riders'][number],
  'stepKind' | 'stepCueRemainingS' | 'nextTargetW'
>;

function biasedTarget(rider: RiderSession, pctFtp: number | null): number | null {
  if (pctFtp === null) return null;
  return Math.round(pctFtp * rider.cfg.profile.ftpW * (1 + rider.biasPct / 100));
}

function workoutCue(rider: RiderSession): RiderCue {
  const flat = rider.flat;
  const current = flat?.[rider.stepIndex];
  const source = current === undefined
    ? undefined
    : rider.cfg.workout?.steps[current.sourceStepIndex];
  if (flat === null || current === undefined || source === undefined) {
    return { stepKind: null, stepCueRemainingS: null, nextTargetW: null };
  }

  if (source.kind === 'interval') {
    return {
      stepKind: source.kind,
      stepCueRemainingS: Math.max(0, current.endS - rider.clockS),
      nextTargetW: biasedTarget(rider, flat[rider.stepIndex + 1]?.targetPctFtp ?? null),
    };
  }

  let sourceEndIndex = rider.stepIndex;
  while (
    sourceEndIndex + 1 < flat.length &&
    flat[sourceEndIndex + 1]!.sourceStepIndex === current.sourceStepIndex
  ) {
    sourceEndIndex += 1;
  }
  const sourceEnd = flat[sourceEndIndex]!;
  const nextPct = source.kind === 'ramp'
    ? source.toPctFtp
    : flat[sourceEndIndex + 1]?.targetPctFtp ?? null;
  return {
    stepKind: source.kind,
    stepCueRemainingS: Math.max(0, sourceEnd.endS - rider.clockS),
    nextTargetW: biasedTarget(rider, nextPct),
  };
}

interface SessionState {
  id: string;
  startedAt: number;
  riders: RiderSession[];
  /** Where this session's voyage flies (the lead rider's next system); null for free-only sessions. */
  destination: SessionDestination | null;
  /** Co-op streak: seconds every eligible rider has stayed in zone together. */
  zoneStreakS: number;
  /** Zone-streak value at the last bothInZone emission (emit cadence: every 30 s). */
  lastZoneEmitS: number;
  /** Consecutive surge seconds per helper/distressed pair while distress is active. */
  rescueSurgeS: Map<string, number>;
  /** Pairs that already emitted rescue this distress episode. */
  rescueEmitted: Set<string>;
}

export class SessionEngine extends EventEmitter<EngineEvents> {
  private readonly findDriver: (id: string) => TrainerDriver | HrmDriver | undefined;
  private readonly recorder: RecorderLike;
  private readonly tickMs: number;
  private readonly now: () => number;
  private current: SessionState | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: {
    findDriver: (id: string) => TrainerDriver | HrmDriver | undefined;
    recorder: RecorderLike;
    tickMs?: number;
    now?: () => number;
  }) {
    super();
    this.findDriver = opts.findDriver;
    this.recorder = opts.recorder;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Point-in-time snapshot of the active session, or null after stopSession. */
  get session(): SessionSnapshot | null {
    return this.current ? this.toSnapshot(this.current) : null;
  }

  /**
   * Start a session with the given riders; each rider's clock starts at t=now.
   * `destination` is the voyage target the whole fleet flies to (null for
   * free-only sessions).
   */
  async startSession(
    riders: RiderConfig[],
    opts: { destination: SessionDestination | null } = { destination: null },
  ): Promise<SessionSnapshot> {
    if (this.current) throw new Error('session already active');
    const session: SessionState = {
      id: randomUUID(),
      startedAt: this.now(),
      riders: [],
      destination: opts.destination,
      zoneStreakS: 0,
      lastZoneEmitS: 0,
      rescueSurgeS: new Map(),
      rescueEmitted: new Set(),
    };
    this.current = session;
    try {
      for (const cfg of riders) this.startRider(session, cfg);
      this.recorder.sessionStarted(session.id, session.startedAt);
    } catch (err) {
      // Atomic start: any rider failure rolls the whole session back — detach
      // listeners attached by the riders that did start, discard their recorder
      // rides, and rethrow so the caller sees the failure. The final state
      // event mirrors stopSession's terminal snapshot: every rider reads as
      // stopped so state consumers see a cleared session.
      for (const rider of session.riders) {
        this.detachListeners(rider);
        this.recorder.discardRide(rider.rideId);
      }
      for (const rider of session.riders) rider.state = 'stopped';
      this.emitState();
      this.current = null;
      this.emit('ended');
      throw err;
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
    return this.toSnapshot(session);
  }

  /** Join mid-session; the new rider's clock starts at t=now. */
  async addRider(cfg: RiderConfig): Promise<void> {
    if (!this.current) throw new Error('no active session');
    this.startRider(this.current, cfg);
  }

  /** Finalize this rider's ride only; the session (and other riders) continue. */
  async stopRider(riderId: string): Promise<void> {
    const rider = this.findRider(riderId);
    if (!rider || rider.state === 'stopped') return;
    const priorState = rider.state;
    const endedAt = this.now();
    // The rider only counts as stopped once the ride is safely finalized: a
    // failed finalize reverts the state (listeners stay attached, samples keep
    // flowing) and rethrows, so the caller can retry.
    try {
      await this.recorder.finalizeRide(rider.rideId, {
        endedAt,
        elapsedS: rider.elapsedS,
        ftpW: rider.cfg.profile.ftpW,
        laps: this.withTailLap(rider, endedAt),
      });
    } catch (err) {
      rider.state = priorState;
      throw err;
    }
    rider.state = 'stopped';
    this.detachListeners(rider);
    this.emit('event', { kind: 'riderLeft', riderId, ts: endedAt });
    this.emitState();
  }

  pause(riderId: string): void {
    const rider = this.findRider(riderId);
    if (!rider || rider.state !== 'riding') return;
    rider.state = 'paused';
    // NOTE: the trainer keeps its last ERG target while paused — no push is
    // issued — and the rider emits no telemetry: their state is frozen, the
    // client holds the last sample until resume.
    this.emitState();
  }

  resume(riderId: string): void {
    const rider = this.findRider(riderId);
    if (!rider || rider.state !== 'paused') return;
    rider.state = 'riding';
    this.emitState();
  }

  /**
   * Jump the workout clock to the end of the current SOURCE step — the last
   * contiguous flat sharing its sourceStepIndex, i.e. the whole interval block
   * or ramp, not the current repeat. The boundary is processed on the next
   * tick; pressing again before that tick is a no-op (the clock already sits
   * at the source step's end).
   */
  skipStep(riderId: string): void {
    const rider = this.findRider(riderId);
    if (!rider || rider.state === 'stopped' || !rider.flat) return;
    const step = rider.flat[rider.stepIndex];
    if (!step) return;
    let sourceEndS = step.endS;
    for (let i = rider.stepIndex + 1; i < rider.flat.length; i++) {
      if (rider.flat[i]!.sourceStepIndex !== step.sourceStepIndex) break;
      sourceEndS = rider.flat[i]!.endS;
    }
    if (rider.clockS >= sourceEndS) return; // repeat press within the same tick
    rider.clockS = sourceEndS;
    this.emitState();
  }

  /** Adjust ERG bias by percent-FTP steps, clamped to ±15. */
  setBias(riderId: string, deltaPct: number): void {
    const rider = this.findRider(riderId);
    if (!rider || rider.state === 'stopped') return;
    const next = Math.min(BIAS_CLAMP_PCT, Math.max(-BIAS_CLAMP_PCT, rider.biasPct + deltaPct));
    rider.biasPct = Math.round(next);
    this.emitState();
  }

  /** Stop every rider (finalizing each ride) and clear the session. */
  async stopSession(): Promise<void> {
    const session = this.current;
    if (!session) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Each rider is stopped independently: one failing finalize must not
    // strand the others. Errors are collected and rethrown as an
    // AggregateError only after the session is fully cleared.
    const errors: unknown[] = [];
    for (const rider of session.riders) {
      if (rider.state === 'stopped') continue;
      try {
        await this.stopRider(rider.cfg.profile.id);
      } catch (err) {
        errors.push(err);
      }
    }
    // Always release: failed riders were left live by stopRider, so detach
    // their listeners here alongside the successful ones.
    for (const rider of session.riders) this.detachListeners(rider);
    this.recorder.sessionEnded(session.id, this.now());
    this.emitState();
    this.current = null;
    this.emit('ended');
    if (errors.length > 0) {
      throw new AggregateError(errors, 'stopSession: some rides failed to finalize');
    }
  }

  private startRider(session: SessionState, cfg: RiderConfig): void {
    const trainer = this.lookupTrainer(cfg.trainerId);
    const hrm = cfg.hrmId ? this.lookupHrm(cfg.hrmId) : undefined;
    const startedAt = this.now();
    let rider: RiderSession;
    rider = {
      cfg,
      flat: cfg.workout ? resolveSteps(cfg.workout) : null,
      clockS: 0,
      stepIndex: 0,
      legs: cfg.workout ? resolveLegs(cfg.workout) : null,
      legIndex: 0,
      legTargetedS: 0,
      legOnTargetS: 0,
      surveysClean: 0,
      biasPct: 0,
      state: 'riding',
      startedAt,
      elapsedS: 0,
      distanceM: 0,
      rideId: this.recorder.startRide({
        sessionId: session.id,
        riderId: cfg.profile.id,
        workoutId: cfg.workoutId,
        workoutName: cfg.workout?.name,
        startedAt,
      }),
      laps: [],
      lapStartTs: startedAt,
      lapRidingS: 0,
      lastTrainerSample: undefined,
      lastHrmSample: undefined,
      lastSentTargetW: null,
      guard: { lowCadenceS: 0, active: false },
      onSample: (sample) => {
        rider.lastTrainerSample = sample;
      },
      // A lost/erroring trainer may not have applied the last target: forget
      // it so the next tick re-pushes (the driver layer re-acquires control).
      onStatus: (status) => {
        if (status.kind === 'controlLost' || status.kind === 'error') rider.lastSentTargetW = null;
      },
      onHr: (sample) => {
        rider.lastHrmSample = sample;
      },
    };
    trainer?.on('sample', rider.onSample);
    trainer?.on('status', rider.onStatus);
    hrm?.on('hr', rider.onHr);
    session.riders.push(rider);
    // riderJoined fires for session-start riders too, so event-only consumers
    // (the co-op game) can build the roster from events alone.
    this.emit('event', { kind: 'riderJoined', riderId: cfg.profile.id, ts: this.now() });
    this.emitState();
  }

  private detachListeners(rider: RiderSession): void {
    this.lookupTrainer(rider.cfg.trainerId)?.off('sample', rider.onSample);
    this.lookupTrainer(rider.cfg.trainerId)?.off('status', rider.onStatus);
    if (rider.cfg.hrmId) this.lookupHrm(rider.cfg.hrmId)?.off('hr', rider.onHr);
  }

  private tick(): void {
    const session = this.current;
    if (!session) return;
    const nowTs = this.now();
    const dt = this.tickMs / 1000;
    const samples: TelemetrySample[] = [];
    const events: SessionEvent[] = [];
    for (const rider of session.riders) {
      if (rider.state !== 'riding') continue;
      this.advanceRider(rider, dt, nowTs, samples, events);
    }
    this.updateBothInZone(session, dt, nowTs, events);
    this.updateRescue(session, dt, nowTs, events);
    if (samples.length > 0) this.emit('telemetry', samples);
    for (const event of events) this.emit('event', event);
    this.emitState();
  }

  private advanceRider(
    rider: RiderSession,
    dt: number,
    nowTs: number,
    samples: TelemetrySample[],
    events: SessionEvent[],
  ): void {
    rider.elapsedS += dt;
    rider.lapRidingS += dt;
    rider.clockS += dt;
    // Legs close BEFORE steps: every legCompleted of this tick is emitted
    // before the stepCompleted/workoutCompleted boundary it may coincide with.
    this.advanceLegs(rider, nowTs, events);
    this.advanceSteps(rider, nowTs, events);
    const stepTarget = this.currentStepTarget(rider);
    // A trainer that stopped emitting reads as 0 W / 0 rpm (and accrues no
    // distance): stale samples older than 3 ticks are ignored.
    const live = this.isSampleLive(rider, nowTs);
    // Root clamps: FTMS power is a signed int16 (coast-down reads negative)
    // and cadence/HRM values can decode to garbage on contact loss — every
    // emitted sample must satisfy TelemetrySampleSchema.
    const power = Math.max(0, live ? rider.lastTrainerSample!.powerW : 0);
    const cadence = Math.max(0, live ? rider.lastTrainerSample!.cadenceRpm : 0);
    const target = this.applyGuard(rider, stepTarget, power, cadence, dt, nowTs, events);
    // Survey accounting: leg seconds count only after the ERG settle window,
    // and on-target seconds additionally need a live sample, an inactive
    // guard and power within ±10 % of the (bias-adjusted) step target.
    const leg = rider.legs?.[rider.legIndex];
    if (leg !== undefined && rider.clockS - leg.startS > LEG_SETTLE_S && stepTarget !== null) {
      rider.legTargetedS += dt;
      if (live && !rider.guard.active && Math.abs(power - stepTarget) <= ZONE_TOLERANCE * stepTarget) {
        rider.legOnTargetS += dt;
      }
    }
    this.pushTarget(rider, target);
    const speedMps = virtualSpeed(power, rider.cfg.profile.weightKg);
    rider.distanceM += speedMps * dt;
    const hrBpm = rider.lastHrmSample && rider.lastHrmSample.bpm >= 20 && rider.lastHrmSample.bpm <= 250
      ? rider.lastHrmSample.bpm
      : undefined; // contact lost: drop the sample, never forward a garbage value
    const sample: TelemetrySample = {
      riderId: rider.cfg.profile.id,
      ts: nowTs,
      powerW: power,
      cadenceRpm: cadence,
      hrBpm,
      hrRrMs:
        rider.lastHrmSample && rider.lastHrmSample.rrMs.length > 0 ? rider.lastHrmSample.rrMs : undefined,
      speedKmh: speedMps * 3.6,
      distanceM: rider.distanceM,
      targetW: target ?? undefined,
    };
    this.recorder.append(rider.rideId, sample);
    samples.push(sample);
  }

  /** Whether the rider's last trainer sample is fresh (same 3-tick window advanceRider uses). */
  private isSampleLive(rider: RiderSession, nowTs: number): boolean {
    const lastSample = rider.lastTrainerSample;
    if (lastSample === undefined) return false;
    const staleMs = Math.max(STALE_SAMPLE_TICKS * this.tickMs, STALE_SAMPLE_MIN_MS);
    return nowTs - lastSample.ts <= staleMs;
  }

  /**
   * Closes every flight leg whose end the rider's workout clock has passed:
   * emits `legCompleted` with the leg's whole-second counters, scores the
   * survey (clean legs increment surveysClean) and moves to the next leg.
   * Skipped legs flow through here too — skipStep jumps the clock, so they
   * emit with whatever small counters accrued and never count as clean.
   */
  private advanceLegs(rider: RiderSession, nowTs: number, events: SessionEvent[]): void {
    const legs = rider.legs;
    if (!legs) return;
    while (rider.legIndex < legs.length && rider.clockS >= legs[rider.legIndex]!.endS) {
      const leg = legs[rider.legIndex]!;
      const targetedS = Math.round(rider.legTargetedS);
      const onTargetS = Math.round(rider.legOnTargetS);
      const clean = isCleanLeg(leg.objective, targetedS, onTargetS);
      if (clean) rider.surveysClean += 1;
      events.push({
        kind: 'legCompleted',
        riderId: rider.cfg.profile.id,
        legIndex: leg.index,
        legKind: leg.kind,
        objective: leg.objective,
        targetedS,
        onTargetS,
        clean,
        ts: nowTs,
      });
      rider.legTargetedS = 0;
      rider.legOnTargetS = 0;
      rider.legIndex += 1;
    }
  }

  /**
   * Fires stepCompleted once per SOURCE step (workout.steps index): when the
   * source step's last flat crosses its boundary (equivalently, when the next
   * flat has a different sourceStepIndex) or when the workout finishes.
   * Contiguous flat steps sharing a sourceStepIndex (ramp sub-steps, interval
   * repeats) coalesce into one lap, closed at the boundary crossing and
   * reopened for the next source step. rider.stepIndex keeps counting FLAT
   * steps — the dashboard progress cursor needs that granularity.
   */
  private advanceSteps(rider: RiderSession, nowTs: number, events: SessionEvent[]): void {
    if (!rider.flat) return;
    while (rider.stepIndex < rider.flat.length && rider.clockS >= rider.flat[rider.stepIndex]!.endS) {
      const source = rider.flat[rider.stepIndex]!.sourceStepIndex;
      rider.stepIndex += 1;
      const nextSource = rider.stepIndex < rider.flat.length ? rider.flat[rider.stepIndex]!.sourceStepIndex : null;
      if (nextSource === source) continue; // mid-source step (ramp sub-step / interval repeat)
      // The last flat of this source step just crossed: close its lap, emit
      // stepCompleted, and open the next source step's lap.
      this.closeLap(rider, nowTs);
      if (rider.stepIndex >= rider.flat.length) {
        // Workout finished: the free-ride tail lap begins here.
        this.openLap(rider, nowTs);
        events.push({
          kind: 'stepCompleted',
          riderId: rider.cfg.profile.id,
          stepIndex: source,
          ts: nowTs,
        });
        events.push({ kind: 'workoutCompleted', riderId: rider.cfg.profile.id, ts: nowTs });
        rider.flat = null;
        break;
      }
      events.push({
        kind: 'stepCompleted',
        riderId: rider.cfg.profile.id,
        stepIndex: source,
        ts: nowTs,
      });
      this.openLap(rider, nowTs);
    }
  }

  /** Close the open lap at endTs, appending it to the completed laps. */
  private closeLap(rider: RiderSession, endTs: number): void {
    rider.laps.push({ startTs: rider.lapStartTs, endTs, ridingS: rider.lapRidingS });
  }

  /** Begin a new open lap at ts (used at source-step boundaries). */
  private openLap(rider: RiderSession, ts: number): void {
    rider.lapStartTs = ts;
    rider.lapRidingS = 0;
  }

  /** Completed laps plus the final partial tail lap through endedAt. */
  private withTailLap(rider: RiderSession, endedAt: number): Array<{ startTs: number; endTs: number; ridingS: number }> {
    return [...rider.laps, { startTs: rider.lapStartTs, endTs: endedAt, ridingS: rider.lapRidingS }];
  }

  /** Watts the current step demands (bias applied); null = free step / no workout. */
  private currentStepTarget(rider: RiderSession): number | null {
    if (!rider.flat) return null;
    const step = rider.flat[rider.stepIndex];
    if (!step || step.targetPctFtp === null) return null;
    return Math.round(step.targetPctFtp * rider.cfg.profile.ftpW * (1 + rider.biasPct / 100));
  }

  /** Watts the trainer is being asked to deliver (guard-adjusted). */
  private drivenTarget(rider: RiderSession): number | null {
    const stepTarget = this.currentStepTarget(rider);
    if (stepTarget === null) return null;
    return rider.guard.active
      ? Math.round(GUARD_TARGET_FTP_FRACTION * rider.cfg.profile.ftpW)
      : stepTarget;
  }

  /**
   * Death-spiral guard: cadence < 40 rpm for 5 consecutive seconds while power
   * is below 90 % of the step target → drive 50 % FTP; release (restoring the
   * step target) once cadence reaches 60 rpm. A free step ends the guard.
   */
  private applyGuard(
    rider: RiderSession,
    stepTarget: number | null,
    power: number,
    cadence: number,
    dt: number,
    nowTs: number,
    events: SessionEvent[],
  ): number | null {
    const guard = rider.guard;
    if (stepTarget === null) {
      if (guard.active) {
        guard.active = false;
        guard.lowCadenceS = 0;
        events.push({ kind: 'ergGuard', riderId: rider.cfg.profile.id, engaged: false, ts: nowTs });
      }
      return null;
    }
    if (guard.active) {
      if (cadence >= GUARD_RELEASE_CADENCE_RPM) {
        guard.active = false;
        guard.lowCadenceS = 0;
        events.push({ kind: 'ergGuard', riderId: rider.cfg.profile.id, engaged: false, ts: nowTs });
        return stepTarget;
      }
      return Math.round(GUARD_TARGET_FTP_FRACTION * rider.cfg.profile.ftpW);
    }
    if (cadence < GUARD_LOW_CADENCE_RPM && power < GUARD_POWER_FRACTION * stepTarget) {
      guard.lowCadenceS += dt;
    } else {
      guard.lowCadenceS = 0;
    }
    if (guard.lowCadenceS >= GUARD_LOW_CADENCE_S) {
      guard.active = true;
      guard.lowCadenceS = 0;
      events.push({ kind: 'ergGuard', riderId: rider.cfg.profile.id, engaged: true, ts: nowTs });
      return Math.round(GUARD_TARGET_FTP_FRACTION * rider.cfg.profile.ftpW);
    }
    return stepTarget;
  }

  /**
   * Change-only ERG dispatch. A null step target (free step, workout end, no
   * workout) pushes ONE floor target at 50 % FTP so resistance never
   * collapses — change-only still applies, and snapshots keep targetW null so
   * the UI shows free. The target is recorded optimistically so an in-flight
   * push never re-fires on later ticks; a rejected push clears it so the
   * pending target is retried on the next tick. Rejections are otherwise
   * swallowed — the driver surfaces its own deviceStatus — and never fatal.
   */
  private pushTarget(rider: RiderSession, target: number | null): void {
    if (rider.state === 'stopped') return;
    const watts = target ?? Math.round(GUARD_TARGET_FTP_FRACTION * rider.cfg.profile.ftpW);
    if (watts === rider.lastSentTargetW) return;
    const trainer = this.lookupTrainer(rider.cfg.trainerId);
    if (!trainer) {
      rider.lastSentTargetW = watts; // misconfigured device: never retry-spam
      return;
    }
    rider.lastSentTargetW = watts;
    try {
      trainer.setTargetPower(watts).catch(() => {
        rider.lastSentTargetW = null;
      });
    } catch {
      rider.lastSentTargetW = null;
    }
  }

  /**
   * Co-op streak: every rider who is riding with a numeric step target must be
   * within ±10 % of it for 30 consecutive seconds. The streak counter keeps
   * running while everyone stays in zone — emissions never reset it — and
   * `bothInZone` fires every 30 s with the CUMULATIVE streak seconds (30, 60,
   * 90…). Only leaving the zone, pausing, stopping, or dropping below 2
   * eligible riders resets it. Fewer than 2 eligible riders never emit
   * (co-op needs company). Zone checks use the unguarded step target — a
   * rider in the death-spiral guard is failing.
   */
  private updateBothInZone(session: SessionState, dt: number, nowTs: number, events: SessionEvent[]): void {
    const eligible = session.riders.filter(
      (r) => r.state === 'riding' && this.currentStepTarget(r) !== null,
    );
    const resetStreak = (): void => {
      session.zoneStreakS = 0;
      session.lastZoneEmitS = 0;
    };
    if (eligible.length < 2) {
      resetStreak(); // solo stretch never counts
      return;
    }
    // A silent trainer is out of the zone: a stale lastTrainerSample (same
    // window as advanceRider) reads as 0 W and resets the streak.
    let allInZone = true;
    for (const rider of eligible) {
      const target = this.currentStepTarget(rider) as number; // filter guarantees non-null
      const power = this.isSampleLive(rider, nowTs) ? rider.lastTrainerSample!.powerW : 0;
      if (Math.abs(power - target) > ZONE_TOLERANCE * target) {
        allInZone = false;
        break;
      }
    }
    if (!allInZone) {
      resetStreak();
      return;
    }
    session.zoneStreakS += dt;
    // Emit every 30 s while the streak holds, carrying the cumulative seconds.
    if (session.zoneStreakS >= ZONE_STREAK_S && session.zoneStreakS - session.lastZoneEmitS >= ZONE_STREAK_S) {
      events.push({ kind: 'bothInZone', ts: nowTs, streakS: Math.round(session.zoneStreakS) });
      session.lastZoneEmitS = session.zoneStreakS;
    }
  }

  /**
   * Co-op rescue: a different riding rider holding power/target ≥ 1.10 for
   * 15 consecutive seconds while a partner's ergGuard is active emits one
   * `rescue` per (helper, distressed) pair per distress episode. Does not
   * touch ERG, workout clocks, or physics. An episode ends only when the
   * distressed rider stops or their guard releases (cadence recovery) — a
   * pause freezes the episode and keeps the emitted latch armed.
   */
  private updateRescue(session: SessionState, dt: number, nowTs: number, events: SessionEvent[]): void {
    // Episode membership (state !== 'stopped' && guard.active) keys the
    // latch cleanup: pause() leaves guard.active set, so a paused distressed
    // rider keeps their episode — and the rescueEmitted latch — alive.
    // Surge accrual/emission stays riding-only: a paused rider is not
    // rescued, but the helper's partial surge count survives the pause.
    const episodeDistressed = new Set<string>();
    const distressedIds = new Set<string>();
    for (const rider of session.riders) {
      if (rider.state !== 'stopped' && rider.guard.active) episodeDistressed.add(rider.cfg.profile.id);
      if (rider.state === 'riding' && rider.guard.active) distressedIds.add(rider.cfg.profile.id);
    }
    for (const key of session.rescueEmitted) {
      if (!episodeDistressed.has(key.slice(key.indexOf('\0') + 1))) session.rescueEmitted.delete(key);
    }
    for (const key of session.rescueSurgeS.keys()) {
      if (!episodeDistressed.has(key.slice(key.indexOf('\0') + 1))) session.rescueSurgeS.delete(key);
    }
    if (distressedIds.size === 0 || session.riders.length < 2) return;

    for (const helper of session.riders) {
      const helperId = helper.cfg.profile.id;
      const target = this.drivenTarget(helper);
      const live = this.isSampleLive(helper, nowTs);
      const power = live ? Math.max(0, helper.lastTrainerSample!.powerW) : 0;
      const eligible =
        helper.state === 'riding' &&
        !helper.guard.active &&
        target !== null &&
        target > 0 &&
        power / target >= RESCUE_RATIO;
      for (const riderId of distressedIds) {
        if (riderId === helperId) continue;
        const key = rescuePairKey(helperId, riderId);
        if (!eligible) {
          session.rescueSurgeS.set(key, 0);
          continue;
        }
        const next = (session.rescueSurgeS.get(key) ?? 0) + dt;
        session.rescueSurgeS.set(key, next);
        if (next >= RESCUE_SURGE_S && !session.rescueEmitted.has(key)) {
          session.rescueEmitted.add(key);
          events.push({ kind: 'rescue', helperId, riderId, ts: nowTs });
        }
      }
    }
  }


  private toSnapshot(session: SessionState): SessionSnapshot {
    return {
      id: session.id,
      startedAt: session.startedAt,
      riders: session.riders.map((rider) => {
        const step = rider.flat ? rider.flat[rider.stepIndex] : undefined;
        const cue = workoutCue(rider);
        return {
          riderId: rider.cfg.profile.id,
          name: rider.cfg.profile.name,
          ftpW: rider.cfg.profile.ftpW,
          trainerId: rider.cfg.trainerId,
          hrmId: rider.cfg.hrmId,
          workoutId: rider.cfg.workoutId,
          workoutName: rider.cfg.workout?.name,
          state: rider.state,
          stepIndex: rider.stepIndex,
          stepRemainingS: step ? Math.max(0, step.endS - rider.clockS) : null,
          workoutRemainingS: rider.flat
            ? Math.max(0, rider.flat[rider.flat.length - 1]!.endS - rider.clockS)
            : null,
          ...cue,
          targetW: rider.state === 'stopped' ? null : this.drivenTarget(rider),
          biasPct: rider.biasPct,
          elapsedS: rider.elapsedS,
          distanceM: rider.distanceM,
          ergGuardActive: rider.state === 'stopped' ? false : rider.guard.active,
          workoutClockS: rider.flat ? rider.clockS : null,
          legs: rider.legs,
          legIndex: rider.legs !== null && rider.legIndex < rider.legs.length ? rider.legIndex : null,
          legTargetedS: rider.legTargetedS,
          legOnTargetS: rider.legOnTargetS,
          surveysClean: rider.surveysClean,
        };
      }),
      destination: session.destination,
    };
  }

  private emitState(): void {
    if (this.current) this.emit('state', this.toSnapshot(this.current));
  }

  private findRider(riderId: string): RiderSession | undefined {
    return this.current?.riders.find((r) => r.cfg.profile.id === riderId);
  }

  private lookupTrainer(id: string): TrainerDriver | undefined {
    const driver = this.findDriver(id);
    return driver instanceof TrainerDriver ? driver : undefined;
  }

  private lookupHrm(id: string): HrmDriver | undefined {
    const driver = this.findDriver(id);
    return driver instanceof HrmDriver ? driver : undefined;
  }
}
