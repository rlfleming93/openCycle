import { randomUUID } from 'node:crypto';

import AdmZip from 'adm-zip';
import { Decoder, Stream, type FitMesgRecord, type FitMessages } from '@garmin/fitsdk';
import { weightedPower } from '@opencycle/shared';

import type { Db } from '../storage/db.js';

export type GarminSource = 'garmin-zip' | 'garmin-fit';

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export type FitImportOutcome = { outcome: 'imported' } | { outcome: 'skipped' };

/** A decoded activity's storage summary: `summary` JSON column, all keys optional. */
export interface ActivitySummary {
  distanceM?: number;
  avgPowerW?: number;
  weightedPowerW?: number;
  avgHrBpm?: number | null;
}

/** One entry from a Garmin export `*_summarizedActivities.json`. */
export interface NameEntry {
  startTimeMs: number;
  name: string;
}

/** Thrown when a FIT buffer cannot be decoded; the message is user-visible. */
export class FitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FitParseError';
  }
}

interface FitFile {
  buf: Buffer;
  label: string;
}

/** ±60 s tolerance when matching FIT start times to summarized-activity names. */
const NAME_MATCH_TOLERANCE_MS = 60_000;
const FIT_RE = /\.fit$/i;
const ZIP_RE = /\.zip$/i;
const SUMMARY_JSON_RE = /[-_]?summarizedactivities\.json$/i;

/**
 * Imports a Garmin account-export ZIP. Walks the root archive for nested ZIPs
 * and loose .fit files at any depth (folder names vary between exports — only
 * file names are matched), recursing one level into nested ZIPs. Display names
 * come from any `*_summarizedActivities.json` found anywhere in the tree,
 * matched by start time within ±60 s. Duplicates of an existing
 * (rider_id, started_at, duration_s) triple already present in `activities`
 * are skipped. An optional riderId (import-time attribution, e.g. from the
 * import-zip query param or a per-rider drop subfolder) is stored on every
 * imported row; omitted, rows stay unassigned (NULL) until POST
 * /api/activities/assign. When re-importing an export (a fresh copy of a ZIP
 * you already imported), always select the rider in the import UI so the
 * rider-scoped dedupe key matches and the already-imported rides are skipped
 * — re-importing the same ZIP unassigned lands a second NULL-rider copy.
 */
export function importGarminZip(db: Db, zipBuffer: Buffer, riderId?: string | null): ImportResult {
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    result.errors.push(`Invalid archive: ${errorMessage(err)}`);
    return result;
  }

  const names: NameEntry[] = [];
  const fits: FitFile[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (ZIP_RE.test(entry.name)) {
      collectNestedZip(entry, fits, names, result);
    } else if (FIT_RE.test(entry.name)) {
      fits.push({ buf: entry.getData(), label: entry.entryName });
    } else if (SUMMARY_JSON_RE.test(entry.name)) {
      names.push(...parseNames(entry.getData()));
    }
  }

  for (const fit of fits) {
    try {
      const outcome = importFitBuffer(db, fit.buf, 'garmin-zip', names, riderId);
      if (outcome.outcome === 'imported') result.imported += 1;
      else result.skipped += 1;
    } catch (err) {
      result.errors.push(`${fit.label}: ${errorMessage(err)}`);
    }
  }
  return result;
}

function collectNestedZip(
  entry: AdmZip.IZipEntry,
  fits: FitFile[],
  names: NameEntry[],
  result: ImportResult,
): void {
  let nested: AdmZip;
  try {
    nested = new AdmZip(entry.getData());
  } catch (err) {
    result.errors.push(`Invalid nested archive ${entry.entryName}: ${errorMessage(err)}`);
    return;
  }
  for (const inner of nested.getEntries()) {
    if (inner.isDirectory) continue;
    if (FIT_RE.test(inner.name)) {
      fits.push({ buf: inner.getData(), label: `${entry.entryName}/${inner.entryName}` });
    } else if (SUMMARY_JSON_RE.test(inner.name)) {
      names.push(...parseNames(inner.getData()));
    }
  }
}

/**
 * Decodes a single FIT buffer and stores it as an activity row. Shared by the
 * ZIP importer, the import drop-folder, and the history-pull route. Throws
 * FitParseError on decode failure; returns { outcome: 'skipped' } when an
 * identical (rider_id, started_at, duration_s) activity already exists.
 * A riderId (import-time attribution) is stored on the row; the dedupe key is
 * rider-scoped, so the same ride imported for two riders lands twice (NULL
 * rider matches only NULL).
 */
export function importFitBuffer(
  db: Db,
  buf: Buffer,
  sourceName: GarminSource,
  names: NameEntry[] = [],
  riderId?: string | null,
): FitImportOutcome {
  const { records, session } = decodeFit(buf);
  const { startedAt, durationS } = timing(records, session);
  if (startedAt === null || durationS === null) {
    throw new FitParseError('no timestamped records or session timing');
  }
  const exists = db
    .prepare('SELECT 1 FROM activities WHERE rider_id IS ? AND started_at = ? AND duration_s = ?')
    .get(riderId ?? null, startedAt, durationS);
  if (exists !== undefined) return { outcome: 'skipped' };

  const sport = typeof session?.sport === 'string' ? session.sport : null;
  const isCycling = sport === 'cycling';
  const power1Hz = isCycling ? downsample1Hz(records, 'power') : null;
  // HR is downsampled for the summary in every sport; only cycling stores streams.
  const hr1Hz = downsample1Hz(records, 'heartRate');
  const summary = buildSummary(records, isCycling, power1Hz, hr1Hz);
  const name = matchName(names, startedAt);

  db.prepare(
    `INSERT INTO activities
       (id, source, rider_id, started_at, duration_s, sport, name, summary, power_1hz, hr_1hz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    sourceName,
    riderId ?? null,
    startedAt,
    durationS,
    sport,
    name,
    JSON.stringify(summary),
    power1Hz === null ? null : JSON.stringify(power1Hz.samples),
    isCycling && hr1Hz !== null ? JSON.stringify(hr1Hz.samples) : null,
  );
  return { outcome: 'imported' };
}

function decodeFit(buf: Buffer): { records: FitMesgRecord[]; session: FitMesgRecord | undefined } {
  let messages: FitMessages;
  try {
    const result = new Decoder(Stream.fromBuffer(buf)).read();
    if (result.errors.length > 0) {
      const detail = result.errors.map((err) => err.message).join('; ');
      throw new FitParseError(detail.length > 0 ? detail : 'FIT decode errors');
    }
    messages = result.messages;
  } catch (err) {
    if (err instanceof FitParseError) throw err;
    throw new FitParseError(errorMessage(err));
  }
  return { records: messages.recordMesgs ?? [], session: messages.sessionMesgs?.[0] };
}

/** Activity start time (ms epoch) and duration (s) from records, falling back to the session mesg. */
function timing(
  records: FitMesgRecord[],
  session: FitMesgRecord | undefined,
): { startedAt: number | null; durationS: number | null } {
  const timestamps = recordTimestamps(records);
  if (timestamps.length > 1) {
    const durationS = Math.max(0, Math.round((timestamps.at(-1)! - timestamps[0]!) / 1000));
    return { startedAt: timestamps[0]!, durationS };
  }
  if (timestamps.length === 1) return { startedAt: timestamps[0]!, durationS: 0 };

  const startTime = epochMs(session?.startTime);
  if (startTime !== null) {
    const timer =
      typeof session?.totalTimerTime === 'number'
        ? session.totalTimerTime
        : typeof session?.totalElapsedTime === 'number'
          ? session.totalElapsedTime
          : null;
    if (timer !== null) return { startedAt: startTime, durationS: Math.round(timer) };
  }
  return { startedAt: null, durationS: null };
}

function recordTimestamps(records: FitMesgRecord[]): number[] {
  const out: number[] = [];
  for (const record of records) {
    const ms = epochMs(record.timestamp);
    if (ms !== null) out.push(ms);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Timestamps arrive as Date (fitsdk) or FIT epoch seconds (number). */
function epochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  return null;
}

/** Short gaps (s) whose value is carried forward; beyond this, power reads 0. */
const GAP_CARRY_S = 10;

/** 1 Hz downsample result: values plus which seconds actually held a reading. */
interface DownsampleResult {
  samples: number[];
  /** Per-second: true when a record or a ≤10 s carry-forward covered the second. */
  present: boolean[];
}

/**
 * Resamples a numeric record field to 1 Hz: mean of each wall-clock second
 * (10 Hz fixtures collapse to one value). Seconds without records are filled
 * by carrying the last value forward for gaps of at most GAP_CARRY_S — Garmin
 * Smart Recording drops interior seconds rather than writing zeroes, so a
 * 5 s cadence must not read as coasting. Longer gaps read 0 (honest coasting
 * for power; the second is marked absent so the HR average excludes it).
 * Returns null when no record carries the field.
 *
 * Asymmetry by design: interior gaps beyond GAP_CARRY_S are materialized as 0
 * and marked absent, while leading/trailing seconds before the first record
 * or after the last are truncated away entirely — the stream spans exactly
 * [first record's second, last record's second]. An activity whose first and
 * last minutes were recorded with a 60 s mid-ride dropout therefore has 60
 * zeroed seconds in the middle and no zeroed padding at the edges, and its
 * duration (first-to-last) ignores the untracked tail.
 */
function downsample1Hz(records: FitMesgRecord[], field: string): DownsampleResult | null {
  const buckets = new Map<number, { sum: number; count: number }>();
  let any = false;
  let minSec = Infinity;
  let maxSec = -Infinity;
  for (const record of records) {
    const ms = epochMs(record.timestamp);
    const value = record[field];
    if (ms === null || typeof value !== 'number' || !Number.isFinite(value)) continue;
    any = true;
    const sec = Math.floor(ms / 1000);
    const bucket = buckets.get(sec);
    if (bucket === undefined) buckets.set(sec, { sum: value, count: 1 });
    else {
      bucket.sum += value;
      bucket.count += 1;
    }
    if (sec < minSec) minSec = sec;
    if (sec > maxSec) maxSec = sec;
  }
  if (!any) return null;

  const samples: number[] = [];
  const present: boolean[] = [];
  let lastValue = 0;
  let lastSec = -Infinity;
  for (let sec = minSec; sec <= maxSec; sec++) {
    const bucket = buckets.get(sec);
    if (bucket !== undefined) {
      lastValue = Math.round(bucket.sum / bucket.count);
      lastSec = sec;
      samples.push(lastValue);
      present.push(true);
    } else if (sec - lastSec <= GAP_CARRY_S) {
      samples.push(lastValue);
      present.push(true);
    } else {
      samples.push(0);
      present.push(false);
    }
  }
  return { samples, present };
}

function buildSummary(
  records: FitMesgRecord[],
  isCycling: boolean,
  power1Hz: DownsampleResult | null,
  hr1Hz: DownsampleResult | null,
): ActivitySummary {
  // Distance is cumulative per record; the last record's value is the total.
  // Avg power is a moving-only average over the raw records: records exist
  // only while pedaling, so under Smart-Recording gaps it diverges from the
  // 1 Hz stream's carried/zeroed values.
  let distanceM: number | null = null;
  let powerSum = 0;
  let powerCount = 0;
  for (const record of records) {
    const distance = record.distance;
    if (typeof distance === 'number' && Number.isFinite(distance)) distanceM = distance;
    const power = record.power;
    if (typeof power === 'number' && Number.isFinite(power)) {
      powerSum += power;
      powerCount += 1;
    }
  }
  // Avg HR covers only seconds that actually held a reading (Smart Recording
  // gaps are excluded, not averaged in as zeroes).
  const avgHrBpm = hr1Hz === null ? null : meanPresent(hr1Hz);
  if (!isCycling) {
    return distanceM === null ? { avgHrBpm } : { distanceM, avgHrBpm };
  }
  const summary: ActivitySummary = { distanceM: distanceM ?? 0, avgHrBpm };
  if (powerCount > 0 && power1Hz !== null) {
    summary.avgPowerW = Math.round(powerSum / powerCount);
    summary.weightedPowerW = Math.round(weightedPower(power1Hz.samples));
  }
  return summary;
}

/** Mean over present seconds; null when no second held a reading. */
function meanPresent(result: DownsampleResult): number | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < result.samples.length; i++) {
    if (result.present[i] === true) {
      sum += result.samples[i]!;
      count += 1;
    }
  }
  return count === 0 ? null : sum / count;
}

/** Closest name whose start time is within ±60 s of the activity start. */
function matchName(names: NameEntry[], startedAt: number): string | null {
  let best: NameEntry | null = null;
  for (const entry of names) {
    const delta = Math.abs(entry.startTimeMs - startedAt);
    if (delta > NAME_MATCH_TOLERANCE_MS) continue;
    if (best === null || delta < Math.abs(best.startTimeMs - startedAt)) best = entry;
  }
  return best?.name ?? null;
}

/**
 * Parses a `*_summarizedActivities.json`. The real Garmin export wraps the
 * entries in an object: [{ summarizedActivitiesExport: [ … ] }]; older and
 * fixture exports are a flat array of entries. Both are accepted. Each entry
 * names the activity via `name` (real export) or `activityName` (flat
 * fixture) and carries a start time as `beginTimestamp` or `startTimeGmt`
 * (epoch-ms numbers, or an ISO/GMT string) or `startTime` (local wall-clock
 * "YYYY-MM-DD HH:MM:SS"). Unreadable entries are skipped.
 */
function parseNames(buf: Buffer): NameEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  // Real export shape: [ { summarizedActivitiesExport: [...] } ].
  const wrapped: unknown[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    if ('summarizedActivitiesExport' in item && Array.isArray(item.summarizedActivitiesExport)) {
      wrapped.push(...item.summarizedActivitiesExport);
    }
  }
  const entries: unknown[] = wrapped.length > 0 ? wrapped : data;

  const out: NameEntry[] = [];
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : record.activityName;
    if (typeof name !== 'string') continue;
    const ms = entryTimeMs(record);
    if (ms !== null) out.push({ startTimeMs: ms, name });
  }
  return out;
}

/** Start time (ms epoch) of a summarized-activity entry, across export shapes. */
function entryTimeMs(record: Record<string, unknown>): number | null {
  const begin = record.beginTimestamp;
  if (typeof begin === 'number' && Number.isFinite(begin)) return begin;
  const gmt = record.startTimeGmt;
  if (typeof gmt === 'number' && Number.isFinite(gmt)) return gmt;
  if (typeof gmt === 'string') {
    const ms = new Date(gmt).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof record.startTime === 'string') return parseLocalDateTimeMs(record.startTime);
  return null;
}

/** Garmin export JSON uses local wall-clock "YYYY-MM-DD HH:MM:SS"; parse as local time. */
function parseLocalDateTimeMs(value: string): number | null {
  const ms = new Date(value.replace(' ', 'T')).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
