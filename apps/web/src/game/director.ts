import type { LegKind, SessionSnapshot } from '@opencycle/shared';

import { identityColor } from '../lib/identity.js';
import type { AppState } from '../store.js';

/**
 * Voyage game director (docs/game-design.md). Pure logic: turns the
 * WS-derived store (snapshot + latest telemetry + event stream) into a render
 * frame for the three.js layer. No three.js imports, no I/O.
 *
 * Conventions:
 * - `sample(nowMs)` is called at render rate (≈60 Hz); `nowMs` is the only
 *   time input, so tests can inject a fake clock.
 * - `frame.riders` is a fresh array per sample but its `RiderVis` objects are
 *   reused and identity-stable per riderId (safe React keys); `frame.events`
 *   is a fresh array per sample. Consume synchronously.
 * - Event consumption is a cursor over `state.events` (newest last, capped at
 *   200 in the store). A raw index is unsafe because the cap shift evicts
 *   consumed events, so the cursor tracks the last-seen event `ts` plus how
 *   many events with exactly that `ts` were consumed. Events older than
 *   `lastTs` are skipped; events with `ts === lastTs` are skipped only up to
 *   the consumed count, so a same-millisecond batch split across two samples
 *   is drained exactly once. Bounded limitation: if a same-ms batch straddles
 *   a 200-event cap shift after a long suspension (>200 events between
 *   samples), stragglers of that batch may be treated as consumed; this
 *   requires ≥12 kHz event rate at 60 Hz sampling and self-heals (beacon
 *   writes are idempotent server-side). Events are assumed strictly
 *   non-decreasing in `ts` per the server's single-threaded tick.
 */

export interface RiderVis {
  riderId: string;
  name: string;
  /** Smoothed (τ≈2 s) power/target ratio; free ride targets 0.65×ftpW. */
  ratio: number;
  /** 0 (cadence stop) .. 1; 1 in the 0.90–1.10 deadband, never above 1. */
  cruise: number;
  state: 'riding' | 'paused' | 'stopped';
  guardActive: boolean;
  /** Step intensity in %FTP (target-based); 65 for free ride. */
  zonePct: number;
  /**
   * Trigger discipline for the pursuit: riding with a live sample, no ERG guard
   * and power inside 0.9-1.1x target. Only these ships fire.
   */
  inBand: boolean;
}

export type GameEvent =
  | { kind: 'legComplete'; riderId: string; clean: boolean; legKind: LegKind }
  | { kind: 'raider'; outcome: 'down' | 'escaped'; legIndex: number }
  | { kind: 'beacon'; streakS: number }
  | { kind: 'arrival'; finishers: number }
  | { kind: 'guard'; riderId: string; engaged: boolean };

export interface RescueVis {
  helperId: string;
  riderId: string;
  helperName: string;
  riderName: string;
  /** Helper identity hue (blue / coral / gold / teal). */
  hue: string;
}

export interface GameFrame {
  riders: RiderVis[];
  /** Mean cruise of riding riders; 0 when none. */
  shipSpeed: number;
  /** Mean %FTP of riding riders, low-passed τ≈8 s, clamped 0–1.5. */
  weather: number;
  /** 0..1, monotone non-decreasing; 0.5 pinned for free-only sessions. */
  progress: number;
  /** This session's voyage destination; null for free-only sessions. */
  destination: SessionSnapshot['destination'];
  /** Survey slots on the destination and how many clean legs have lit them. */
  surveys: { total: number; revealed: number };
  /** Current leg kind of the lead rider (else rider 0); null without a workout. */
  legKind: LegKind | null;
  /** Current leg index of the lead rider; null without a workout. */
  legIndex: number | null;
  /** True while a bothInZone event occurred within the last 35 s AND at least
   *  one rider still has an active numeric target. */
  syncLit: boolean;
  /** Drained once per event; empty when nothing new arrived. */
  events: GameEvent[];
  /** session.id, or 'idle' with no session. */
  seed: string;
  /** Active shield vis, or null when no rescue is covering the ship. */
  rescue: RescueVis | null;
  /**
   * Pursuit state for the lead rider's burn legs: null without a destination
   * or whenever the lead is not burning. `lock` is the lead's on-target
   * fraction (0 until the leg has at least LEG_SETTLE-ish 5 s targeted).
   */
  pursuit: { active: boolean; legIndex: number; lock: number } | null;
  /**
   * Seconds on the lead rider's workout (mission) clock, else the lead's
   * elapsed riding time; null without a session. The world plays the
   * session-start frame shift jump while this is under ~10 s.
   */
  sessionAgeS: number | null;
}

const RATIO_TAU_S = 2;
const WEATHER_TAU_S = 8;
const SYNC_LIT_WINDOW_MS = 35_000;
const CRUISE_FLOOR = 0.55;
const CRUISE_AT_RATIO = 0.9; // deadband lower edge
const CRUISE_DEADBAND_HIGH = 1.1;
const FREE_RIDE_FRACTION = 0.65;
const CADENCE_STOP_RPM = 5;
const MAX_DT_S = 0.5; // clamp render-gap dt so a suspended tab doesn't snap smoothing
/** Trigger discipline window (power / target) for the pursuit. */
const IN_BAND_LOW = 0.9;
const IN_BAND_HIGH = 1.1;
/** Lock meter stays 0 until the leg has this much targeted time. */
const LOCK_MIN_TARGETED_S = 5;
const RESCUE_MAX_HOLD_MS = 90_000;

/** Cruise factor from a smoothed ratio; dead stop only at cadence ≈ 0. */
function cruise(ratio: number, cadenceRpm: number): number {
  if (cadenceRpm < CADENCE_STOP_RPM) return 0;
  if (ratio >= CRUISE_AT_RATIO && ratio <= CRUISE_DEADBAND_HIGH) return 1;
  if (ratio > CRUISE_DEADBAND_HIGH) return 1; // over-target never pays
  // ratio < 0.9: lerp floor 0.55 (at ratio 0.5) up to 1.0 (at ratio 0.9).
  const t = Math.min(1, Math.max(0, (ratio - 0.5) / (CRUISE_AT_RATIO - 0.5)));
  return CRUISE_FLOOR + t * (1 - CRUISE_FLOOR);
}

/**
 * Next survey-beacon threshold strictly above `after`: 30, 90, 180, then
 * every 300 (300, 600, 900, …).
 */
function nextBeaconThreshold(after: number): number {
  if (after < 30) return 30;
  if (after < 90) return 90;
  if (after < 180) return 180;
  return 300 * (Math.floor(after / 300) + 1);
}

/**
 * World progress from the snapshot: the MINIMUM completion fraction
 * workoutClockS / (workoutClockS + workoutRemainingS) among riding workout
 * riders — the slowest rider (most workout time left) paces the approach.
 *
 * The workout clock is the mission clock: it advances when a step is skipped,
 * so skipping to the end of a long leg moves the approach exactly as far as the
 * engine's own clock does. `elapsedS` is only a fallback for snapshots without
 * a workout clock. A rider whose workout finished (null/0 remaining) counts as
 * 1. Returns null when nobody is advancing (all workout riders paused/stopped)
 * so the caller freezes progress; 0.5 when the session has no workouts at all.
 */
export function rawGameProgress(session: SessionSnapshot | null): number | null {
  if (!session) return 0.5;
  let sessionHasWorkout = false;
  let ridingWithWorkout = false;
  let minProgress = 1;
  for (const r of session.riders) {
    if (r.workoutId !== undefined) sessionHasWorkout = true;
    if (r.state !== 'riding' || r.workoutId === undefined) continue;
    ridingWithWorkout = true;
    const remaining = r.workoutRemainingS;
    if (remaining === null || remaining === 0) continue; // finished workout → progress 1
    const elapsed = r.workoutClockS ?? r.elapsedS;
    minProgress = Math.min(minProgress, elapsed / (elapsed + remaining));
  }
  if (!sessionHasWorkout) return 0.5;
  if (!ridingWithWorkout) return null;
  return minProgress;
}

/**
 * Survey totals for the frame: every objective leg is a chance, and the
 * fleet-wide figure is the best rider's (a survey only needs one clean leg).
 */
function surveyTotals(session: SessionSnapshot | null): { total: number; revealed: number } {
  let total = 0;
  let revealed = 0;
  if (session === null) return { total, revealed };
  for (const r of session.riders) {
    if (r.legs !== null) {
      let objectives = 0;
      for (const leg of r.legs) if (leg.objective) objectives += 1;
      total = Math.max(total, objectives);
    }
    revealed = Math.max(revealed, r.surveysClean);
  }
  return { total, revealed };
}

/** The director's public contract: one pure sample per rendered frame. */
export interface GameDirector {
  sample(nowMs: number): GameFrame;
}

export function createGameDirector(getState: () => AppState): GameDirector {
  const visById = new Map<string, RiderVis>();
  const smoothedRatio = new Map<string, number>();
  let lastNowMs = -1;
  let lastWeather = 0;
  let lastProgress = -1; // -1 = unset (first sample of the current seed)
  let lastSeed = '';
  // Event cursor: last consumed event ts + how many events with that ts were consumed.
  let cursorTs = -1;
  let cursorTsCount = 0;
  let streakHighS = 0; // cumulative-streak high-water mark for beacon thresholds
  let finishers = 0;
  let lastBothInZoneTs: number | null = null;
  let rescueVis: RescueVis | null = null;
  let rescueStartedMs = -1;

  const sample = (nowMs: number): GameFrame => {
    const state = getState();
    const session = state.session;
    const seed = session?.id ?? 'idle';
    if (seed !== lastSeed) {
      // Fresh session: nothing carries over (store also clears events on the
      // sessionState null frame, so the cursor reset below starts clean).
      visById.clear();
      smoothedRatio.clear();
      lastWeather = 0;
      lastProgress = -1;
      cursorTs = -1;
      cursorTsCount = 0;
      streakHighS = 0;
      finishers = 0;
      lastBothInZoneTs = null;
      rescueVis = null;
      rescueStartedMs = -1;
      lastNowMs = nowMs;
      lastSeed = seed;
    }

    const dt = lastNowMs < 0 ? 0 : Math.min(Math.max((nowMs - lastNowMs) / 1000, 0), MAX_DT_S);
    lastNowMs = nowMs;
    const alphaRatio = dt <= 0 ? 1 : 1 - Math.exp(-dt / RATIO_TAU_S);
    const alphaWeather = dt <= 0 ? 1 : 1 - Math.exp(-dt / WEATHER_TAU_S);

    const snapshot = session?.riders ?? [];
    const riders: RiderVis[] = new Array(snapshot.length);
    let ridingCount = 0;
    let cruiseSum = 0;
    let zoneSum = 0;

    for (let i = 0; i < snapshot.length; i++) {
      const r = snapshot[i]!;
      let vis = visById.get(r.riderId);
      if (vis === undefined) {
        vis = {
          riderId: r.riderId,
          name: r.name,
          ratio: 0,
          cruise: 0,
          state: r.state,
          guardActive: r.ergGuardActive,
          zonePct: 0,
          inBand: false,
        };
        visById.set(r.riderId, vis);
      }
      const latest = state.latest[r.riderId];
      const cadence = latest === undefined ? 0 : latest.cadenceRpm;
      const target = r.targetW;
      // Free ride / null-or-zero target: cruise at endurance effort (0.65×ftpW).
      const raw =
        latest === undefined
          ? 0
          : target !== null && target > 0
            ? latest.powerW / target
            : latest.powerW / (FREE_RIDE_FRACTION * r.ftpW);
      const prev = smoothedRatio.get(r.riderId);
      const ratio = prev === undefined ? raw : prev + alphaRatio * (raw - prev);
      smoothedRatio.set(r.riderId, ratio);
      const zonePct = target !== null && target > 0 ? (target / r.ftpW) * 100 : FREE_RIDE_FRACTION * 100;
      vis.name = r.name;
      vis.ratio = ratio;
      vis.cruise = cruise(ratio, cadence);
      vis.state = r.state;
      vis.guardActive = r.ergGuardActive;
      vis.zonePct = zonePct;
      vis.inBand =
        r.state === 'riding' &&
        latest !== undefined &&
        !r.ergGuardActive &&
        target !== null &&
        target > 0 &&
        ratio >= IN_BAND_LOW &&
        ratio <= IN_BAND_HIGH;
      riders[i] = vis;
      if (r.state === 'riding') {
        ridingCount++;
        cruiseSum += vis.cruise;
        zoneSum += zonePct;
      }
    }

    // Drop smoothing/vis state for riders no longer in the snapshot.
    if (visById.size > snapshot.length) {
      for (const id of visById.keys()) {
        if (!snapshot.some((r) => r.riderId === id)) {
          visById.delete(id);
          smoothedRatio.delete(id);
        }
      }
    }

    const rawWeather = ridingCount > 0 ? zoneSum / 100 / ridingCount : 0;
    const weather = Math.min(1.5, Math.max(0, lastWeather + alphaWeather * (rawWeather - lastWeather)));
    lastWeather = weather;

    const shipSpeed = ridingCount > 0 ? cruiseSum / ridingCount : 0;

    // The pursuit's lead: the destination's lead rider, else rider 0.
    const leadRiderId = session?.destination?.leadRiderId ?? session?.riders[0]?.riderId ?? null;

    // Drain new events (cursor-based; see module doc).
    const events: GameEvent[] = [];
    const list = state.events;
    let i = 0;
    while (i < list.length && list[i]!.ts < cursorTs) i++;
    let skip = cursorTsCount;
    while (i < list.length && list[i]!.ts === cursorTs && skip > 0) {
      i++;
      skip--;
    }
    for (; i < list.length; i++) {
      const ev = list[i]!;
      if (ev.ts > cursorTs) {
        cursorTs = ev.ts;
        cursorTsCount = 1;
      } else if (ev.ts === cursorTs) {
        cursorTsCount++;
      }
      switch (ev.kind) {
        case 'legCompleted':
          // Only objective legs are survey chances (coast/launch/approach are
          // flown, not graded) and never produce a HUD toast.
          if (ev.objective) {
            events.push({ kind: 'legComplete', riderId: ev.riderId, clean: ev.clean, legKind: ev.legKind });
          }
          // A burn leg ends with the raider either destroyed or away: only the
          // LEAD rider's burn legs run a pursuit (and only on a voyage), so only
          // those resolve it.
          if (ev.legKind === 'burn' && ev.riderId === leadRiderId && session?.destination != null) {
            events.push({ kind: 'raider', outcome: ev.clean ? 'down' : 'escaped', legIndex: ev.legIndex });
          }
          break;
        case 'workoutCompleted':
          finishers++;
          events.push({ kind: 'arrival', finishers });
          break;
        case 'bothInZone': {
          // Clock-domain note: ev.ts is the SERVER epoch clock (Date.now ms),
          // nowMs is the render/RAF clock. Anchor to the SAMPLE clock at drain
          // time so the window can never be measured across clock domains.
          lastBothInZoneTs = nowMs;
          let threshold = nextBeaconThreshold(streakHighS);
          while (threshold <= ev.streakS) {
            events.push({ kind: 'beacon', streakS: threshold });
            threshold = nextBeaconThreshold(threshold);
          }
          if (ev.streakS > streakHighS) streakHighS = ev.streakS;
          break;
        }
        case 'ergGuard':
          events.push({ kind: 'guard', riderId: ev.riderId, engaged: ev.engaged });
          break;
        case 'stepCompleted':
        case 'riderJoined':
        case 'riderLeft':
          // No game event: ship fades are driven by snapshot presence and the
          // HUD reads step progress straight from the snapshot.
          break;
        case 'rescue': {
          const helper = snapshot.find((r) => r.riderId === ev.helperId);
          const distressed = snapshot.find((r) => r.riderId === ev.riderId);
          // The shield is painted in the helper's identity hue; without the
          // helper in the snapshot there is no identity to paint
          // (identityColor(0) would alias the distressed rider's own hue).
          if (helper !== undefined) {
            rescueVis = {
              helperId: ev.helperId,
              riderId: ev.riderId,
              helperName: helper.name,
              riderName: distressed?.name ?? ev.riderId,
              hue: identityColor(snapshot.indexOf(helper)),
            };
            rescueStartedMs = nowMs;
          }
          break;
        }
      }
    }

    const raw = rawGameProgress(session);
    let progress = lastProgress;
    if (raw !== null) {
      const clamped = Math.min(1, Math.max(0, raw));
      progress = lastProgress < 0 ? clamped : Math.max(lastProgress, clamped); // monotone, no rewind
    }
    if (progress < 0) progress = 0.5;
    lastProgress = progress;

    // The emerald sync core is an in-workout co-op signal: with no active
    // numeric target (all workouts finished / free ride) a stale bothInZone
    // must not keep it lit, regardless of the 35 s window.
    const anyNumericTarget = snapshot.some((r) => r.targetW !== null && r.targetW > 0);
    const syncLit = anyNumericTarget && lastBothInZoneTs !== null && nowMs - lastBothInZoneTs <= SYNC_LIT_WINDOW_MS;

    if (rescueVis !== null) {
      const active = rescueVis;
      const distressed = snapshot.find((r) => r.riderId === active.riderId);
      const expired = nowMs - rescueStartedMs > RESCUE_MAX_HOLD_MS;
      if (expired || distressed === undefined || !distressed.ergGuardActive) {
        rescueVis = null;
      }
    }

    const destination = session?.destination ?? null;
    const lead = destination === null ? snapshot[0] : snapshot.find((r) => r.riderId === destination.leadRiderId);
    const legIndex = lead?.legIndex ?? null;
    const legKind = lead?.legs !== undefined && lead?.legs !== null && legIndex !== null ? (lead.legs[legIndex]?.kind ?? null) : null;
    // Pursuit runs on the lead's burn legs only, and only on a voyage.
    const pursuit =
      destination !== null && legKind === 'burn' && legIndex !== null
        ? {
            active: true,
            legIndex,
            lock:
              lead !== undefined && lead.legTargetedS >= LOCK_MIN_TARGETED_S
                ? Math.min(1, Math.max(0, lead.legOnTargetS / lead.legTargetedS))
                : 0,
          }
        : null;

    return {
      riders,
      shipSpeed,
      weather,
      progress,
      destination,
      surveys: surveyTotals(session),
      legKind,
      legIndex,
      syncLit,
      events,
      seed,
      rescue: rescueVis,
      pursuit,
      sessionAgeS: lead === undefined ? null : (lead.workoutClockS ?? lead.elapsedS),
    };
  };

  return { sample };
}
