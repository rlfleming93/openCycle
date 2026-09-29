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

export interface LegTargetInput {
  /** Riders in the session: one rider reads watts, two or more read %FTP. */
  riders: number;
  ftpW: number;
  biasPct: number;
}

/**
 * The target column of a sidebar step row. A single rider reads the watts the
 * engine would hold (`pct × ftpW × (1 + bias)`, the same arithmetic as the
 * server's biasedTarget); two or more riders read %FTP instead, because each
 * rider card already carries its own watts. Ramps read `150→220 W` / `75→88%`;
 * a leg with no %FTP at all (free) has no target to state.
 */
export function legTargetLabel(leg: Leg, input: LegTargetInput): string {
  const start = leg.startPctFtp ?? leg.endPctFtp;
  const end = leg.endPctFtp ?? leg.startPctFtp;
  if (start === null || end === null) return 'FREE';
  if (input.riders > 1) {
    const a = String(Math.round(start * 100));
    const b = String(Math.round(end * 100));
    return a === b ? `${a}%` : `${a}→${b}%`;
  }
  const watts = (pct: number): number => Math.round(pct * input.ftpW * (1 + input.biasPct / 100));
  const a = watts(start);
  const b = watts(end);
  return a === b ? `${a} W` : `${a}→${b} W`;
}

/** Seconds left in the leg on the workout clock; null without a workout clock. */
export function legRemainingS(leg: Leg, workoutClockS: number | null): number | null {
  if (workoutClockS === null) return null;
  return Math.max(0, leg.endS - workoutClockS);
}

/** How far the leg has run on the workout clock, 0..1; 0 without a clock. */
export function legFillFraction(leg: Leg, workoutClockS: number | null): number {
  const span = leg.endS - leg.startS;
  if (workoutClockS === null || span <= 0) return 0;
  return Math.min(1, Math.max(0, (workoutClockS - leg.startS) / span));
}

/** Objective legs in a leg list; 0 when the list is null. */
export function objectiveLegCount(legs: Leg[] | null): number {
  return legs === null ? 0 : legs.filter((leg) => leg.objective).length;
}

/**
 * Sidebar step rows: how many whole rows the list window shows at once. Six
 * rows at label-sized type is the floor for reading the list from 3 m on a
 * 1080p TV; more rows would drop the type back under that.
 */
export const STEP_WINDOW_ROWS = 6;
/** The current row reads taller than the rest, in plain-row units. */
export const STEP_CURRENT_SPAN = 1.4;
/**
 * List viewport height in the same units: seven rows, one of them the current
 * row. Sizing the viewport to this (rather than to seven plain rows) is what
 * keeps every row whole at the window's edges.
 */
export const STEP_WINDOW_UNITS = STEP_WINDOW_ROWS + STEP_CURRENT_SPAN - 1;

/** Free legs carry no %FTP; the profile draws them as a low stub of the track. */
const FREE_LEG_HEIGHT = 0.12;

export interface ProfileBar {
  /** Leg index in the leg list. */
  index: number;
  kind: LegKind;
  /** Left edge as a fraction of the workout's duration, 0..1. */
  x: number;
  /** Width as a fraction of the workout's duration, 0..1. */
  width: number;
  /** Bar top at the left edge, as a fraction measured down from the track top. */
  top: number;
  /** Bar top at the right edge; differs from `top` only on ramp legs. */
  topRight: number;
  /** True when the leg's target moves across it (a sloped bar). */
  ramp: boolean;
}

export interface WorkoutProfile {
  bars: ProfileBar[];
  /** Whole-workout seconds: the last leg's end on the workout clock. */
  totalS: number;
  /**
   * %FTP at the top of the track, as a fraction: the workout's peak, but never
   * below 1 so the FTP gridlines sit at the same reading in every workout.
   */
  scale: number;
}

/**
 * Geometry of the sidebar's mini profile: one bar per leg, width proportional
 * to its share of the workout and top proportional to its %FTP against the
 * whole workout's peak. Ramps come back sloped (a trapezoid: `top` at the left
 * edge, `topRight` at the right). Free legs have no %FTP target, so they draw
 * a low stub of the track rather than a claimed effort.
 */
export function workoutProfile(legs: readonly Leg[] | null): WorkoutProfile {
  if (legs === null || legs.length === 0) return { bars: [], totalS: 0, scale: 1 };
  let totalS = 0;
  let peak = 0;
  for (const leg of legs) {
    totalS = Math.max(totalS, leg.endS);
    for (const pct of [leg.startPctFtp, leg.endPctFtp]) if (pct !== null) peak = Math.max(peak, pct);
  }
  const scale = Math.max(1, peak);
  const bars = legs.map((leg) => {
    const heightAt = (pct: number | null): number => (pct === null ? FREE_LEG_HEIGHT : Math.min(1, pct / scale));
    const top = 1 - heightAt(leg.startPctFtp);
    const topRight = 1 - heightAt(leg.endPctFtp);
    return {
      index: leg.index,
      kind: leg.kind,
      x: totalS <= 0 ? 0 : leg.startS / totalS,
      width: totalS <= 0 ? 0 : (leg.endS - leg.startS) / totalS,
      top,
      topRight,
      ramp: Math.abs(top - topRight) > 1e-9,
    };
  });
  return { bars, totalS, scale };
}

/** Playhead position across the profile track, 0..1; 0 with no clock or legs. */
export function profilePlayhead(legs: readonly Leg[] | null, workoutClockS: number | null): number {
  if (legs === null || legs.length === 0 || workoutClockS === null) return 0;
  const totalS = workoutProfile(legs).totalS;
  if (totalS <= 0) return 0;
  return Math.min(1, Math.max(0, workoutClockS / totalS));
}

export interface StepWindow {
  /**
   * Row units hidden above the list viewport (what the list translates by).
   * One unit is one plain row; the current row spans `currentSpan` of them.
   */
  offset: number;
  /** Rows sit above / below the window (the edge fades). */
  moreAbove: boolean;
  moreBelow: boolean;
}

/**
 * Scroll window over the step list: the current row sits one row down from the
 * top whenever there is room, and the window stops at the workout's end (so the
 * current row drifts down near the last legs). `visibleUnits` is the list
 * viewport's height in plain-row units and `currentSpan` the current row's, so
 * the tail clamp lands on a row boundary and never leaves half a row showing.
 */
export function stepWindow(
  count: number,
  currentIndex: number | null,
  visibleUnits = STEP_WINDOW_UNITS,
  currentSpan = STEP_CURRENT_SPAN,
): StepWindow {
  if (count <= 0 || visibleUnits <= 0) return { offset: 0, moreAbove: false, moreBelow: false };
  const totalUnits = count + Math.max(0, currentSpan - 1);
  const anchor = currentIndex ?? 0;
  const offset = Math.min(Math.max(anchor - 1, 0), Math.max(0, totalUnits - visibleUnits));
  return { offset, moreAbove: offset > 0, moreBelow: offset + visibleUnits < totalUnits - 1e-9 };
}

/**
 * Clean (`true`) / not clean (`false`) survey per completed objective leg,
 * from the received legCompleted events. Same source of truth the route strip
 * used: a leg shows its survey marker only when that leg reported one, and a
 * rider's own events only.
 */
export function surveyMarks(events: readonly SessionEvent[], riderId: string): Record<number, boolean> {
  const marks: Record<number, boolean> = {};
  for (const event of events) {
    if (event.kind !== 'legCompleted' || !event.objective || event.riderId !== riderId) continue;
    marks[event.legIndex] = event.clean;
  }
  return marks;
}

export interface SurveyMarker {
  glyph: string;
  /** Spoken form: the glyph is decorative next to it. */
  title: string;
  clean: boolean;
}

/** Glyph + label for a done row's survey: ✓ clean, · not clean, null for none. */
export function surveyMarker(clean: boolean | undefined): SurveyMarker | null {
  if (clean === undefined) return null;
  return clean
    ? { glyph: '✓', title: 'Survey locked — clean leg', clean: true }
    : { glyph: '·', title: 'No survey — leg not clean', clean: false };
}

export interface WorkoutHeader {
  name: string;
  /** `12:30 / 30:00` on the workout clock. */
  clock: string;
  /** `17:30 LEFT`, or `COMPLETE` once the workout clock is gone. */
  remaining: string;
}

/**
 * Sidebar header: which workout, how far in, and how much is left. `totalS` is
 * the workout's own length (last leg end), so the readout stays whole after the
 * last leg, when the snapshot's clock and remaining fields are both null.
 */
export function workoutHeader(
  name: string | undefined,
  clockS: number | null,
  totalS: number,
  remainingS: number | null,
): WorkoutHeader {
  const clock = `${fmtClock(clockS ?? totalS)} / ${fmtClock(totalS)}`;
  if (remainingS === null || remainingS <= 0) return { name: name ?? 'WORKOUT', clock, remaining: 'COMPLETE' };
  return { name: name ?? 'WORKOUT', clock, remaining: `${fmtClock(remainingS)} LEFT` };
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
