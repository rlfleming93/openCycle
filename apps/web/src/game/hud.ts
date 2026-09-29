import type {
  Leg,
  LegKind,
  SessionDestination,
  SessionEvent,
  SessionSnapshot,
  TelemetrySample,
} from '@opencycle/shared';

/**
 * Ride-HUD copy and derivations (plan Step 5). Pure module: no React, no DOM,
 * so every string the HUD shows is pinned by hud.test.ts. The world layer
 * never imports this file — WebGL draws ships, DOM draws words.
 */

/** On-target readout stays hidden until this many leg seconds were targeted. */
export const LEG_ON_TARGET_DISPLAY_S = 5;

const OBJECTIVE_COPY: Record<LegKind, string> = {
  burn: 'HOLD CADENCE TO FINISH THE BURN',
  cruise: 'HOLD STEADY',
  climb: 'FOLLOW THE RAMP',
  coast: 'SPIN EASY',
  launch: 'WARM UP',
  approach: 'COOL DOWN',
  free: 'RIDE FREE',
};

const KIND_LABEL: Record<LegKind, string> = {
  burn: 'BURN',
  cruise: 'CRUISE',
  climb: 'CLIMB',
  coast: 'COAST',
  launch: 'LAUNCH',
  approach: 'APPROACH',
  free: 'OPEN SPACE',
};

/** The one-line objective under the route strip. */
export function legObjective(leg: Leg): string {
  return OBJECTIVE_COPY[leg.kind];
}

/**
 * Leg label for a completed leg. The snapshot's own label carries `BURN n/N`;
 * the kind label is the fallback when the leg has scrolled out of the
 * snapshot (or a non-burn leg).
 */
export function legLabel(legKind: LegKind, leg: Leg | null): string {
  return leg?.label ?? KIND_LABEL[legKind];
}

/** Seconds left in the leg on the workout clock; null without a workout clock. */
export function legRemainingS(leg: Leg, workoutClockS: number | null): number | null {
  if (workoutClockS === null) return null;
  return Math.max(0, leg.endS - workoutClockS);
}

/** Objective legs in a leg list; 0 when the list is null. */
export function objectiveLegCount(legs: Leg[] | null): number {
  return legs === null ? 0 : legs.filter((leg) => leg.objective).length;
}

/** Rounding on-target share of a leg's targeted seconds; 0 before any target time. */
export function legOnTargetPct(targetedS: number, onTargetS: number): number {
  if (targetedS <= 0) return 0;
  return Math.round((onTargetS / targetedS) * 100);
}

/**
 * Burn-leg lock meter: the raider's lock is the on-target share of the live
 * leg. `LOCK 72%`, or `LOCK —` until the leg has enough targeted seconds to
 * read (the same 5 s floor the on-target readout uses).
 */
export function legLockLabel(targetedS: number, onTargetS: number): string {
  if (targetedS < LEG_ON_TARGET_DISPLAY_S) return 'LOCK —';
  return `LOCK ${legOnTargetPct(targetedS, onTargetS)}%`;
}

/** Lock bar fill, 0..1; 0 while the lock readout is still `—`. */
export function legLockFraction(targetedS: number, onTargetS: number): number {
  if (targetedS < LEG_ON_TARGET_DISPLAY_S) return 0;
  return Math.min(1, Math.max(0, onTargetS / targetedS));
}

/** 3 s trailing average power (samples arrive at 1 Hz, so the last 3 samples). */
export function trailingAvgPower(samples: readonly TelemetrySample[]): number {
  if (samples.length === 0) return 0;
  const tail = samples.slice(-3);
  return tail.reduce((sum, sample) => sum + sample.powerW, 0) / tail.length;
}

export interface RouteHeader {
  left: string;
  right: string;
}

/**
 * Route-strip header: the voyage leg number and destination, plus the arrival
 * countdown. After the lead rider's workout completes the strip reports the
 * arrival; a finished workout clock means the fleet is in the arrival orbit.
 */
export function routeHeader(
  destination: SessionDestination,
  workoutRemainingS: number | null,
  arrived = false,
): RouteHeader {
  return {
    left: arrived
      ? `LEG ${destination.voyageIndex + 1} · ARRIVED AT ${destination.name}`
      : `LEG ${destination.voyageIndex + 1} · BOUND FOR ${destination.name}`,
    right: arrived || workoutRemainingS === null ? 'IN ORBIT' : `ARRIVAL IN ${fmtClock(workoutRemainingS)}`,
  };
}

/** Post-arrival chip: the system and the surveys its features revealed. */
export function arrivalChip(name: string, clean: number, total: number): string {
  return `ARRIVED · ${name} · ${clean}/${total} SURVEYED`;
}

export interface LegToastInput {
  legKind: LegKind;
  /** The completed leg from the rider's snapshot, when it is still there. */
  leg: Leg | null;
  clean: boolean;
  targetedS: number;
  onTargetS: number;
}

export interface LegToast {
  text: string;
  tone: 'on' | 'neutral';
}

/**
 * Leg-complete toast; the rider name prefixes it in multi-rider sessions.
 * Burn legs are pursuits: a clean burn brings the raider down, anything else
 * lets it escape (the survey rules are unchanged — clean still locks).
 */
export function legToast(input: LegToastInput, riderName: string | null): LegToast {
  const label = legLabel(input.legKind, input.leg);
  const prefix = riderName === null ? '' : `${riderName} · `;
  const pct = legOnTargetPct(input.targetedS, input.onTargetS);
  if (input.legKind === 'burn') {
    return input.clean
      ? { text: `${prefix}${label} COMPLETE · RAIDER DOWN · SURVEY LOCKED`, tone: 'on' }
      : { text: `${prefix}${label} COMPLETE · RAIDER ESCAPED · ${pct}% ON TARGET`, tone: 'neutral' };
  }
  return input.clean
    ? { text: `${prefix}${label} COMPLETE · SURVEY LOCKED`, tone: 'on' }
    : { text: `${prefix}${label} COMPLETE · ${pct}% ON TARGET`, tone: 'neutral' };
}

/**
 * Arrival honor roll: one line per answered rescue, in the order the session
 * answered them, with rider names resolved from the snapshot.
 */
export function honorRoll(session: SessionSnapshot | null, events: SessionEvent[]): string[] {
  const nameOf = (riderId: string): string =>
    session?.riders.find((rider) => rider.riderId === riderId)?.name ?? riderId;
  const lines: string[] = [];
  for (const event of events) {
    if (event.kind !== 'rescue') continue;
    lines.push(`Rescue answered — ${nameOf(event.helperId)} covered ${nameOf(event.riderId)}`);
  }
  return lines;
}

/** m:ss, or h:mm:ss past an hour. Negative input clamps to 0:00. */
export function fmtClock(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}
