import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type Database from 'better-sqlite3';
import { Encoder, Profile, Utils, type Mesg } from '@garmin/fitsdk';
import { intensity, trainingLoad, weightedPower, type TelemetrySample } from '@opencycle/shared';

import type { Db } from '../storage/db.js';

/**
 * fitsdk's encoder types accept only `Mesg` (mesgNum/developerFields), but its
 * runtime encoder reads arbitrary camelCase FIT field names. This cast bridges
 * the loose shipped types to the message objects we pass to `onMesg`.
 */
function fitMesg(fields: Record<string, unknown>): Mesg {
  return fields as Mesg;
}

export interface RideSummary {
  durationS: number;
  distanceM: number;
  avgPowerW: number;
  weightedPowerW: number;
  avgHrBpm: number | null;
  trainingLoad: number | null;
}

export interface StartRideOptions {
  sessionId: string;
  riderId: string;
  workoutId?: string;
  workoutName?: string;
  startedAt: number;
}

export interface FinalizeRideOptions {
  endedAt: number;
  /** Riding seconds (pauses excluded); drives summary durationS and FIT totalTimerTime. */
  elapsedS?: number;
  ftpW?: number;
  /**
   * Completed source-step laps as wall-clock ranges plus the final partial
   * tail lap. ridingS = riding seconds accumulated inside the lap (pauses
   * excluded); totalElapsedTime in the FIT is the wall-clock range.
   */
  laps?: Array<{ startTs: number; endTs: number; ridingS: number }>;
}

interface ActiveRide {
  rideId: string;
  sessionId: string;
  riderId: string;
  workoutId: string | null;
  workoutName: string | null;
  startedAt: number;
  buffer: TelemetrySample[];
}

interface SampleRow {
  rideId: string;
  ts: number;
  powerW: number;
  cadenceRpm: number;
  hrBpm: number | null;
  speedKmh: number;
  distanceM: number;
  targetW: number | null;
}

interface StoredSample {
  ts: number;
  powerW: number;
  cadenceRpm: number;
  hrBpm: number | null;
  speedKmh: number;
  distanceM: number;
}

/**
 * Records per-rider rides: buffers 1 Hz samples in memory, flushes them to
 * `ride_samples` on an interval, and on finalize writes a FIT activity file
 * plus a summary back to the `rides` row.
 */
export class Recorder {
  private readonly dataDir: string;
  private readonly insertSampleStmt: Database.Statement;
  private readonly flushTx: (rows: SampleRow[]) => void;
  private readonly rides = new Map<string, ActiveRide>();
  private readonly timer: NodeJS.Timeout | null;
  /** Last error from the interval flush, or null while the last flush succeeded. */
  lastFlushError: unknown = null;

  constructor(
    private readonly db: Db,
    dataDir: string,
    opts: { flushIntervalMs?: number } = {},
  ) {
    this.dataDir = resolve(dataDir);
    // OR REPLACE: (ride_id, ts) is the PK and samples are 1 Hz end-stamped, so
    // a same-second collision replaces rather than crashes the flush.
    this.insertSampleStmt = db.prepare(
      `INSERT OR REPLACE INTO ride_samples
         (ride_id, ts, power_w, cadence_rpm, hr_bpm, speed_kmh, distance_m, target_w)
       VALUES (@rideId, @ts, @powerW, @cadenceRpm, @hrBpm, @speedKmh, @distanceM, @targetW)`,
    );
    this.flushTx = db.transaction((rows: SampleRow[]) => {
      for (const row of rows) this.insertSampleStmt.run(row);
    });
    const flushIntervalMs = opts.flushIntervalMs ?? 10_000;
    if (flushIntervalMs > 0) {
      // A failed flush is recorded, never thrown (no unhandled rejection). The
      // buffer survives a failed flushTx, so the next interval retries it.
      this.timer = setInterval(() => {
        void this.flush().catch((err: unknown) => {
          this.lastFlushError = err;
        });
      }, flushIntervalMs);
      this.timer.unref();
    } else {
      this.timer = null;
    }
  }

  /** Records a session row; called once when the session starts. */
  sessionStarted(sessionId: string, startedAt: number): void {
    this.db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(sessionId, startedAt);
  }

  /** Stamps the session's ended_at; called once when the session stops. */
  sessionEnded(sessionId: string, endedAt: number): void {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId);
  }

  startRide(opts: StartRideOptions): string {
    const rideId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO rides (id, session_id, rider_id, started_at, workout_id, workout_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rideId,
        opts.sessionId,
        opts.riderId,
        opts.startedAt,
        opts.workoutId ?? null,
        opts.workoutName ?? null,
      );
    this.rides.set(rideId, {
      ...opts,
      workoutId: opts.workoutId ?? null,
      workoutName: opts.workoutName ?? null,
      rideId,
      buffer: [],
    });
    return rideId;
  }

  append(rideId: string, sample: TelemetrySample): void {
    const ride = this.rides.get(rideId);
    if (ride === undefined) {
      throw new Error(`append called for unknown ride: ${rideId}`);
    }
    ride.buffer.push(sample);
  }

  /** Writes all buffered samples to `ride_samples` in a single transaction. */
  async flush(): Promise<void> {
    const batches: Array<{ ride: ActiveRide; rows: SampleRow[] }> = [];
    for (const ride of this.rides.values()) {
      if (ride.buffer.length === 0) continue;
      batches.push({
        ride,
        rows: ride.buffer.map((sample) => ({
          rideId: ride.rideId,
          ts: sample.ts,
          powerW: sample.powerW,
          cadenceRpm: sample.cadenceRpm,
          hrBpm: sample.hrBpm ?? null,
          speedKmh: sample.speedKmh,
          distanceM: sample.distanceM,
          targetW: sample.targetW ?? null,
        })),
      });
    }
    if (batches.length === 0) return;
    const allRows = batches.flatMap((batch) => batch.rows);
    this.flushTx(allRows);
    for (const batch of batches) batch.ride.buffer = [];
  }

  /** Flushes, computes the ride summary, writes the FIT file, and updates the `rides` row. */
  async finalizeRide(rideId: string, opts: FinalizeRideOptions): Promise<{ fitPath: string; summary: RideSummary }> {
    const ride = this.rides.get(rideId);
    if (ride === undefined) {
      throw new Error(`finalizeRide called for unknown ride: ${rideId}`);
    }
    await this.flush();
    const rows = this.db
      .prepare(
        `SELECT ts, power_w, cadence_rpm, hr_bpm, speed_kmh, distance_m
         FROM ride_samples WHERE ride_id = ? ORDER BY ts ASC`,
      )
      .all(rideId) as Array<{
      ts: number;
      power_w: number;
      cadence_rpm: number;
      hr_bpm: number | null;
      speed_kmh: number;
      distance_m: number;
    }>;
    const samples: StoredSample[] = rows.map((row) => ({
      ts: row.ts,
      powerW: row.power_w,
      cadenceRpm: row.cadence_rpm,
      hrBpm: row.hr_bpm,
      speedKmh: row.speed_kmh,
      distanceM: row.distance_m,
    }));
    const summary = computeSummary(samples, opts.ftpW, opts.elapsedS);
    const fitPath = writeFitFile(this.dataDir, ride, samples, summary, opts);
    this.db
      .prepare('UPDATE rides SET ended_at = ?, summary = ?, fit_path = ? WHERE id = ?')
      .run(opts.endedAt, JSON.stringify(summary), fitPath, rideId);
    this.rides.delete(rideId);
    return { fitPath, summary };
  }

  /**
   * Removes a ride that started but must never be finalized (session rollback):
   * drops the in-memory ride and its buffered samples, and deletes the `rides`
   * row. No samples were ever flushed for such a ride, so `ride_samples` is
   * untouched.
   */
  discardRide(rideId: string): void {
    const ride = this.rides.get(rideId);
    if (ride === undefined) {
      throw new Error(`discardRide called for unknown ride: ${rideId}`);
    }
    this.rides.delete(rideId); // drops the buffered samples
    this.db.prepare('DELETE FROM rides WHERE id = ?').run(rideId);
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeSummary(samples: StoredSample[], ftpW: number | undefined, elapsedS?: number): RideSummary {
  if (samples.length === 0) {
    return { durationS: 0, distanceM: 0, avgPowerW: 0, weightedPowerW: 0, avgHrBpm: null, trainingLoad: null };
  }
  const last = samples[samples.length - 1]!;
  // Riding seconds when the engine provides them (pause-aware); otherwise the
  // recorded sample count is the closest estimate.
  const durationS = elapsedS !== undefined ? Math.round(elapsedS) : samples.length;
  const power1Hz = samples.map((sample) => sample.powerW);
  const avgPowerW = Math.round(mean(power1Hz));
  const weightedPowerW = Math.round(weightedPower(power1Hz));
  const hrValues = samples.filter((sample) => sample.hrBpm !== null).map((sample) => sample.hrBpm as number);
  const avgHrBpm = hrValues.length > 0 ? Math.round(mean(hrValues)) : null;
  const trainingLoadValue =
    ftpW !== undefined && ftpW > 0 ? trainingLoad(durationS, intensity(weightedPowerW, ftpW)) : null;
  return { durationS, distanceM: last.distanceM, avgPowerW, weightedPowerW, avgHrBpm, trainingLoad: trainingLoadValue };
}

/** Encodes a FIT activity file (File Id, Device Info, timer Events, 1 Hz Records, Laps, Session, Activity). */
function writeFitFile(
  dataDir: string,
  ride: ActiveRide,
  samples: StoredSample[],
  summary: RideSummary,
  opts: FinalizeRideOptions,
): string {
  const dir = join(dataDir, 'rides', ride.riderId);
  mkdirSync(dir, { recursive: true });
  // The rideId prefix makes the filename collision-proof for same-second starts.
  const fileName = `${new Date(ride.startedAt).toISOString().replaceAll(':', '-')}-${ride.rideId.slice(0, 8)}.fit`;
  const fitPath = join(dir, fileName);

  const startDate = new Date(ride.startedAt);
  const endDate = new Date(opts.endedAt);
  // Wall-clock span (pauses included); totalTimerTime carries the riding duration.
  const wallElapsedS = Math.max(0, (opts.endedAt - ride.startedAt) / 1000);

  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, fitMesg({
    type: 'activity',
    manufacturer: 'development',
    product: 0,
    timeCreated: startDate,
  }));
  encoder.onMesg(Profile.MesgNum.DEVICE_INFO, fitMesg({
    timestamp: startDate,
    deviceIndex: 'creator',
    manufacturer: 'development',
    product: 0,
    productName: 'openCycle',
  }));
  encoder.onMesg(Profile.MesgNum.EVENT, fitMesg({ timestamp: startDate, event: 'timer', eventType: 'start' }));
  for (const sample of samples) {
    encoder.onMesg(Profile.MesgNum.RECORD, fitMesg({
      timestamp: new Date(sample.ts),
      power: Math.round(sample.powerW),
      cadence: Math.round(sample.cadenceRpm),
      ...(sample.hrBpm !== null ? { heartRate: Math.round(sample.hrBpm) } : {}),
      distance: sample.distanceM,
      speed: sample.speedKmh / 3.6,
    }));
  }
  encoder.onMesg(Profile.MesgNum.EVENT, fitMesg({ timestamp: endDate, event: 'timer', eventType: 'stop' }));

  const laps = opts.laps?.length ? opts.laps : [{ startTs: ride.startedAt, endTs: opts.endedAt, ridingS: summary.durationS }];
  for (let i = 0; i < laps.length; i++) {
    encoder.onMesg(Profile.MesgNum.LAP, fitMesg(lapFields(samples, laps[i]!, i)));
  }

  encoder.onMesg(Profile.MesgNum.SESSION, fitMesg({
    messageIndex: 0,
    timestamp: endDate,
    startTime: startDate,
    event: 'session',
    eventType: 'stop',
    sport: 'cycling',
    subSport: 'indoorCycling',
    totalElapsedTime: wallElapsedS,
    totalTimerTime: summary.durationS,
    totalDistance: summary.distanceM,
    avgPower: summary.avgPowerW,
    ...(summary.avgHrBpm !== null ? { avgHeartRate: summary.avgHrBpm } : {}),
    firstLapIndex: 0,
    numLaps: laps.length,
  }));
  // getTimezoneOffset is minutes WEST of UTC; subtracting adds the local
  // offset, so localTimestamp - timestamp equals the machine's UTC offset seconds.
  encoder.onMesg(Profile.MesgNum.ACTIVITY, fitMesg({
    timestamp: endDate,
    localTimestamp: Math.round(Utils.convertDateToDateTime(endDate)) - endDate.getTimezoneOffset() * 60,
    numSessions: 1,
    totalTimerTime: summary.durationS,
  }));

  writeFileSync(fitPath, encoder.close());
  return fitPath;
}

function lapFields(
  samples: StoredSample[],
  lap: { startTs: number; endTs: number; ridingS: number },
  index: number,
): Record<string, unknown> {
  // Samples stamp the END of their second, so a lap window is (startTs, endTs]:
  // the endTs sample closes the lap, the startTs sample belongs to the previous
  // one. Distance is baselined at the window edge (the last sample at or before
  // startTs) so consecutive lap distances telescope to the session total.
  // samples arrive sorted by ts (finalizeRide reads ORDER BY ts ASC).
  let baselineM = 0;
  for (const sample of samples) {
    if (sample.ts > lap.startTs) break;
    baselineM = sample.distanceM;
  }
  const inLap = samples.filter((sample) => sample.ts > lap.startTs && sample.ts <= lap.endTs);
  const power = inLap.map((sample) => sample.powerW);
  const cadence = inLap.map((sample) => sample.cadenceRpm);
  const hrValues = inLap.filter((sample) => sample.hrBpm !== null).map((sample) => sample.hrBpm as number);
  const lastInLap = inLap[inLap.length - 1];
  const distanceM = lastInLap !== undefined ? lastInLap.distanceM - baselineM : 0;
  const fields: Record<string, unknown> = {
    messageIndex: index,
    timestamp: new Date(lap.endTs),
    startTime: new Date(lap.startTs),
    event: 'lap',
    eventType: 'stop',
    // Wall-clock lap span; pauses inside the lap keep totalTimerTime below it.
    totalElapsedTime: (lap.endTs - lap.startTs) / 1000,
    totalTimerTime: lap.ridingS,
    totalDistance: Math.max(0, distanceM),
    avgPower: power.length > 0 ? Math.round(mean(power)) : 0,
    avgCadence: cadence.length > 0 ? Math.round(mean(cadence)) : 0,
    ...(hrValues.length > 0 ? { avgHeartRate: Math.round(mean(hrValues)) } : {}),
    sport: 'cycling',
    subSport: 'indoorCycling',
  };
  return fields;
}
