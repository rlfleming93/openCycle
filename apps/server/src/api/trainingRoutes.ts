import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  fitnessFatigue,
  ftpFrom20Min,
  ftpFromHistory,
  ftpFromRamp,
  intensity,
  trainingLoad,
  type ActivityWithPower,
  type RiderProfile,
} from '@opencycle/shared';

import type { Db } from '../storage/db.js';
import { ApiError } from './routes.js';

export interface TrainingDeps {
  db: Db;
}

const IdParamSchema = z.object({ id: z.string().min(1) });
/** Physiology is per-rider: the load series always requires a riderId. */
const LoadQuerySchema = z.object({ riderId: z.string().min(1) });

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue === undefined ? 'Invalid request' : `${issue.path.join('.')}: ${issue.message}`;
    throw new ApiError(400, detail);
  }
  return parsed.data;
}

/**
 * Registers the Phase 5 training routes (load dashboard series, FTP-from-
 * history estimate, per-ride FTP estimates). All read-only; the lead composes
 * this into registerRoutes.
 */
export function registerTrainingRoutes(app: FastifyInstance, deps: TrainingDeps): void {
  const { db } = deps;

  app.get('/api/training/load', (req) => {
    const { riderId } = parseOr400(LoadQuerySchema, req.query);
    return loadSeries(db, riderId);
  });

  // Estimate-only: the UI applies the result through the existing profile PUT.
  app.post('/api/profiles/:id/ftp-from-history', (req) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    if (db.prepare('SELECT id FROM profiles WHERE id = ?').get(id) === undefined) {
      throw new ApiError(404, `Unknown profile ${id}`);
    }
    return { ftpW: ftpFromHistory(historyPower(db, id)) };
  });

  app.get('/api/rides/:id/ftp-estimates', (req) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    const row = db
      .prepare('SELECT workout_id AS workoutId FROM rides WHERE id = ?')
      .get(id) as { workoutId: string | null } | undefined;
    if (row === undefined) throw new ApiError(404, `Unknown ride ${id}`);
    const power = ridePower(db, id);
    // null = not applicable: a 20-minute estimate needs a full 20-minute
    // window (1200 samples); the ramp estimate only applies to the ramp-test
    // workout (rides from other workouts read null, never a number).
    const twentyMin = power.length >= 20 * 60 ? Math.round(ftpFrom20Min(power)) : null;
    const ramp = row.workoutId === 'ftp-ramp-test' ? Math.round(ftpFromRamp(power)) : null;
    return { ramp, twentyMin };
  });
}

interface LoadDatum {
  startedAt: number;
  load: number;
}

/**
 * Daily loads from (a) finalized rides and (b) imported activities.
 *
 * - A ride contributes its summary trainingLoad; a finalized ride whose
 *   summary carries none (finalized without an FTP reference) is skipped — a
 *   ride without a load datum contributes nothing.
 * - An activity contributes its summary trainingLoad when present; an
 *   activity with weightedPowerW but no trainingLoad gets its load derived at
 *   query time: trainingLoad(durationS, intensity(weightedPowerW,
 *   <rider's CURRENT FTP>)). Garmin exports carry no openCycle load, so the
 *   rider's current FTP stands in for the FTP at ride time — editing the FTP
 *   profile rewrites the historic curve. Documented, accepted tradeoff.
 * - An activity with a power stream but neither trainingLoad nor
 *   weightedPowerW contributes 0 (the training day still counts); stream-less
 *   non-cycling activities are outside the power-based load model and are
 *   excluded.
 * - Physiology is per-rider: a riderId is always required, and NULL-rider
 *   (unassigned) activities count in no rider's series until assigned.
 */
function loadData(db: Db, riderId: string): LoadDatum[] {
  const datums: LoadDatum[] = [];

  const rideRows = db
    .prepare('SELECT started_at AS startedAt, summary FROM rides WHERE summary IS NOT NULL AND rider_id = ?')
    .all(riderId) as Array<{ startedAt: number; summary: string }>;
  for (const row of rideRows) {
    const load = trainingLoadOf(parseSummary(row.summary));
    if (load !== null) datums.push({ startedAt: row.startedAt, load });
  }

  const profile = getProfile(db, riderId);
  const ftpW = profile?.ftpW ?? 0;
  const activityRows = db
    .prepare(
      'SELECT started_at AS startedAt, duration_s AS durationS, summary, power_1hz AS power1Hz FROM activities WHERE rider_id = ?',
    )
    .all(riderId) as Array<{ startedAt: number; durationS: number; summary: string | null; power1Hz: string | null }>;
  for (const row of activityRows) {
    const summary = parseSummary(row.summary);
    const load = trainingLoadOf(summary);
    if (load !== null) datums.push({ startedAt: row.startedAt, load });
    else {
      const weightedPowerW = weightedPowerOf(summary);
      if (weightedPowerW !== null) {
        datums.push({
          startedAt: row.startedAt,
          load: trainingLoad(row.durationS, intensity(weightedPowerW, ftpW)),
        });
      } else if (row.power1Hz !== null) {
        datums.push({ startedAt: row.startedAt, load: 0 });
      }
    }
  }

  return datums;
}

/** The rider's current profile; undefined when the rider does not exist. */
function getProfile(db: Db, riderId: string): RiderProfile | undefined {
  const row = db.prepare('SELECT data FROM profiles WHERE id = ?').get(riderId) as { data: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.data) as RiderProfile);
}

/** The summary's trainingLoad when it is a finite number, else null. */
function trainingLoadOf(summary: Record<string, unknown> | null): number | null {
  if (summary === null) return null;
  const load = summary.trainingLoad;
  return typeof load === 'number' && Number.isFinite(load) ? load : null;
}

/** The summary's weightedPowerW when it is a finite number, else null. */
function weightedPowerOf(summary: Record<string, unknown> | null): number | null {
  if (summary === null) return null;
  const wp = summary.weightedPowerW;
  return typeof wp === 'number' && Number.isFinite(wp) ? wp : null;
}

/** Parses a summary JSON column; absent or malformed JSON counts as no summary. */
function parseSummary(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 'YYYY-MM-DD' for ms in the server's local timezone. */
function localDateKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Daily load series: per-day sums over the continuous range from the first
 * datum to today (days without data are zero-filled), plus the shared
 * Banister fitness/fatigue/form curves over that same day sequence. No datums
 * (or an unknown riderId) yields an empty series.
 */
function loadSeries(db: Db, riderId: string): {
  days: Array<{ date: string; load: number }>;
  fitness: number[];
  fatigue: number[];
  form: number[];
} {
  const datums = loadData(db, riderId);
  if (datums.length === 0) return { days: [], fitness: [], fatigue: [], form: [] };

  const byDay = new Map<string, number>();
  let firstDate: string | null = null;
  for (const datum of datums) {
    const date = localDateKey(datum.startedAt);
    byDay.set(date, (byDay.get(date) ?? 0) + datum.load);
    if (firstDate === null || date < firstDate) firstDate = date;
  }

  const end = localDateKey(Date.now());
  // A first datum in the future (wrong clock) still yields a range ending today.
  const start = firstDate === null || firstDate > end ? end : firstDate;
  const days: Array<{ date: string; load: number }> = [];
  const dailyLoads: number[] = [];
  // 'YYYY-MM-DDT00:00:00' parses as LOCAL midnight (date-only forms parse as UTC).
  const cursor = new Date(`${start}T00:00:00`);
  const endMs = new Date(`${end}T00:00:00`).getTime();
  while (cursor.getTime() <= endMs) {
    const date = localDateKey(cursor.getTime());
    const load = byDay.get(date) ?? 0;
    days.push({ date, load });
    dailyLoads.push(load);
    cursor.setDate(cursor.getDate() + 1);
  }

  return { days, ...fitnessFatigue(dailyLoads) };
}

/** A ride's 1 Hz power samples in chronological order (null rows filtered out). */
function ridePower(db: Db, rideId: string): number[] {
  const rows = db
    .prepare('SELECT power_w AS powerW FROM ride_samples WHERE ride_id = ? ORDER BY ts ASC')
    .all(rideId) as Array<{ powerW: number | null }>;
  const powers: number[] = [];
  for (const row of rows) {
    if (row.powerW !== null) powers.push(row.powerW);
  }
  return powers;
}

/** Parses a power_1hz JSON array; absent or malformed data -> null. */
function parsePower(raw: string | null): number[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'number') ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

/**
 * One rider's power history for ftpFromHistory: imported activity streams plus
 * finalized ride sample streams (one query per ride — finalize writes each
 * ride's samples in a single flush, so per-ride ordered reads stay cheap).
 */
function historyPower(db: Db, riderId: string): ActivityWithPower[] {
  const activities: ActivityWithPower[] = [];
  const activityRows = db
    .prepare('SELECT started_at AS startedAt, power_1hz AS power1Hz FROM activities WHERE rider_id = ?')
    .all(riderId) as Array<{ startedAt: number; power1Hz: string | null }>;
  for (const row of activityRows) {
    activities.push({ startedAt: new Date(row.startedAt).toISOString(), power1Hz: parsePower(row.power1Hz) });
  }
  const rideRows = db
    .prepare('SELECT id, started_at AS startedAt FROM rides WHERE rider_id = ? AND summary IS NOT NULL')
    .all(riderId) as Array<{ id: string; startedAt: number }>;
  for (const row of rideRows) {
    activities.push({ startedAt: new Date(row.startedAt).toISOString(), power1Hz: ridePower(db, row.id) });
  }
  return activities;
}
