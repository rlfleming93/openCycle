import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Decoder, Stream, Utils } from '@garmin/fitsdk';
import type { TelemetrySample } from '@opencycle/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDb } from '../storage/db.js';
import { Recorder } from './recorder.js';

const STARTED_AT = 1_700_000_000_000;

function freshRecorder() {
  const dir = mkdtempSync(join(tmpdir(), 'opencycle-recorder-'));
  tempDirs.push(dir);
  const db = openDb(':memory:');
  const recorder = new Recorder(db, dir, { flushIntervalMs: 0 });
  return { db, recorder, dataDir: dir };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

type SampleOpts = { powerW?: number; hrBpm?: number | null; cadenceRpm?: number; speedKmh?: number };

function sampleAt(startedAt: number, index: number, opts: SampleOpts = {}): TelemetrySample {
  const { powerW = 200, hrBpm = 145, cadenceRpm = 90, speedKmh = 36 } = opts;
  return {
    riderId: 'rider-1',
    ts: startedAt + index * 1000,
    powerW,
    cadenceRpm,
    ...(hrBpm !== null ? { hrBpm } : {}),
    speedKmh,
    distanceM: (index + 1) * 10,
    targetW: powerW,
  };
}

function appendRange(recorder: Recorder, rideId: string, startedAt: number, count: number, opts: SampleOpts = {}): void {
  for (let i = 0; i < count; i++) recorder.append(rideId, sampleAt(startedAt, i, opts));
}

describe('Recorder', () => {
  it('flushes buffered samples to ride_samples exactly once; a second flush is a no-op', async () => {
    const { db, recorder } = freshRecorder();
    const rideId = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
    appendRange(recorder, rideId, STARTED_AT, 3);

    await recorder.flush();
    await recorder.flush();

    const rows = db
      .prepare(
        `SELECT ride_id, ts, power_w, cadence_rpm, hr_bpm, speed_kmh, distance_m, target_w
         FROM ride_samples WHERE ride_id = ? ORDER BY ts`,
      )
      .all(rideId);
    expect(rows).toEqual([
      { ride_id: rideId, ts: STARTED_AT, power_w: 200, cadence_rpm: 90, hr_bpm: 145, speed_kmh: 36, distance_m: 10, target_w: 200 },
      { ride_id: rideId, ts: STARTED_AT + 1000, power_w: 200, cadence_rpm: 90, hr_bpm: 145, speed_kmh: 36, distance_m: 20, target_w: 200 },
      { ride_id: rideId, ts: STARTED_AT + 2000, power_w: 200, cadence_rpm: 90, hr_bpm: 145, speed_kmh: 36, distance_m: 30, target_w: 200 },
    ]);

    recorder.append(rideId, sampleAt(STARTED_AT, 3));
    await recorder.flush();
    const count = db.prepare('SELECT COUNT(*) AS n FROM ride_samples WHERE ride_id = ?').get(rideId) as { n: number };
    expect(count.n).toBe(4);
    db.close();
  });

  it('append and finalize throw for an unknown ride', async () => {
    const { db, recorder } = freshRecorder();
    expect(() => recorder.append('nope', sampleAt(STARTED_AT, 0))).toThrow(/unknown ride/);
    await expect(recorder.finalizeRide('nope', { endedAt: STARTED_AT + 5000 })).rejects.toThrow(/unknown ride/);
    db.close();
  });

  it('finalizeRide computes the summary and writes the FIT file at the contracted path', async () => {
    const { db, recorder, dataDir } = freshRecorder();
    const rideId = recorder.startRide({
      sessionId: 's1',
      riderId: 'rider-1',
      workoutId: 'w1',
      workoutName: 'Sweet Spot',
      startedAt: STARTED_AT,
    });
    appendRange(recorder, rideId, STARTED_AT, 120, { powerW: 200, hrBpm: 145 });
    const endedAt = STARTED_AT + 120_000;

    const { fitPath, summary } = await recorder.finalizeRide(rideId, { endedAt, ftpW: 250 });

    expect(summary).toEqual({
      durationS: 120,
      distanceM: 1200,
      avgPowerW: 200,
      weightedPowerW: 200,
      avgHrBpm: 145,
      trainingLoad: (120 / 3600) * 0.8 ** 2 * 100,
    });
    expect(summary.trainingLoad).toBeCloseTo((120 / 3600) * 0.8 ** 2 * 100, 6);
    // Collision-proof name: ISO timestamp + first 8 chars of the ride id.
    expect(fitPath).toBe(
      join(dataDir, 'rides', 'rider-1', `${new Date(STARTED_AT).toISOString().replaceAll(':', '-')}-${rideId.slice(0, 8)}.fit`),
    );
    expect(existsSync(fitPath)).toBe(true);

    const row = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId) as Record<string, unknown>;
    expect(row.session_id).toBe('s1');
    expect(row.rider_id).toBe('rider-1');
    expect(row.started_at).toBe(STARTED_AT);
    expect(row.ended_at).toBe(endedAt);
    expect(row.workout_id).toBe('w1');
    expect(row.workout_name).toBe('Sweet Spot');
    expect(row.fit_path).toBe(fitPath);
    expect(JSON.parse(row.summary as string)).toEqual(summary);
    db.close();
  });

  it('encodes a FIT file that round-trips: integrity, record count, laps, session and activity totals', async () => {
    const { recorder } = freshRecorder();
    const rideId = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
    appendRange(recorder, rideId, STARTED_AT, 120, { powerW: 200, hrBpm: 145 });
    const endedAt = STARTED_AT + 120_000;
    const laps = [
      { startTs: STARTED_AT, endTs: STARTED_AT + 60_000, ridingS: 60 },
      { startTs: STARTED_AT + 60_000, endTs: STARTED_AT + 120_000, ridingS: 60 },
    ];
    const { fitPath } = await recorder.finalizeRide(rideId, { endedAt, ftpW: 250, laps });

    const decoder = new Decoder(Stream.fromBuffer(readFileSync(fitPath)));
    expect(decoder.checkIntegrity()).toBe(true);
    const { messages, errors } = decoder.read();
    expect(errors).toEqual([]);

    const records = messages.recordMesgs!;
    expect(records).toHaveLength(120);
    // Strictly 1 Hz distinct timestamps for 1 Hz input.
    for (let i = 0; i < records.length; i++) {
      expect((records[i]!.timestamp as Date).getTime()).toBe(STARTED_AT + i * 1000);
    }
    expect(records[0]!.power).toBe(200);
    expect(records[0]!.cadence).toBe(90);
    expect(records[0]!.heartRate).toBe(145);
    expect(records[0]!.distance).toBeCloseTo(10, 2);
    expect(records[0]!.speed).toBeCloseTo(10, 2);
    expect(records[119]!.distance).toBeCloseTo(1200, 2);

    const lapsDecoded = messages.lapMesgs!;
    expect(lapsDecoded).toHaveLength(2);
    expect(lapsDecoded[0]!.messageIndex).toBe(0);
    expect(lapsDecoded[1]!.messageIndex).toBe(1);
    expect((lapsDecoded[0]!.startTime as Date).getTime()).toBe(STARTED_AT);
    expect((lapsDecoded[0]!.timestamp as Date).getTime()).toBe(STARTED_AT + 60_000);
    expect((lapsDecoded[1]!.startTime as Date).getTime()).toBe(STARTED_AT + 60_000);
    expect(lapsDecoded[0]!.totalElapsedTime).toBeCloseTo(60, 2);
    expect(lapsDecoded[1]!.totalElapsedTime).toBeCloseTo(60, 2);
    expect(lapsDecoded[0]!.avgPower).toBe(200);
    expect(lapsDecoded[0]!.sport).toBe('cycling');
    expect(lapsDecoded[0]!.subSport).toBe('indoorCycling');

    const session = messages.sessionMesgs![0]!;
    expect(session.sport).toBe('cycling');
    expect(session.subSport).toBe('indoorCycling');
    expect((session.startTime as Date).getTime()).toBe(STARTED_AT);
    expect(session.totalElapsedTime).toBeCloseTo(120, 2);
    expect(session.totalTimerTime).toBeCloseTo(120, 2);
    expect(session.totalDistance).toBeCloseTo(1200, 2);
    expect(session.avgPower).toBe(200);
    expect(session.avgHeartRate).toBe(145);
    expect(session.numLaps).toBe(2);

    const activity = messages.activityMesgs![0]!;
    expect(activity.numSessions).toBe(1);
    expect(activity.totalTimerTime).toBeCloseTo(120, 2);
    // localTimestamp carries the machine's UTC offset: local - timestamp == -getTimezoneOffset() * 60.
    // (fitsdk's loose mesg typings resolve localTimestamp as unknown under NodeNext + skipLibCheck)
    const localTimestamp = activity.localTimestamp as number;
    expect(localTimestamp - Utils.convertDateToDateTime(activity.timestamp as Date)).toBe(
      -new Date(endedAt).getTimezoneOffset() * 60,
    );

    expect(messages.eventMesgs!.map((e) => [e.event, e.eventType])).toEqual([
      ['timer', 'start'],
      ['timer', 'stop'],
    ]);

    const fileId = messages.fileIdMesgs![0]!;
    expect(fileId.type).toBe('activity');
    expect(fileId.manufacturer).toBe('development');
  });

  it('handles HR present, HR absent, and no FTP variants', async () => {
    const { db, recorder } = freshRecorder();

    // Partial HR coverage: only the first three of five samples carry HR.
    const rideA = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
    for (let i = 0; i < 5; i++) {
      recorder.append(rideA, sampleAt(STARTED_AT, i, { hrBpm: i < 3 ? 140 : null, powerW: 180 }));
    }
    const { summary: withHr } = await recorder.finalizeRide(rideA, { endedAt: STARTED_AT + 5000, ftpW: 200 });
    expect(withHr.avgHrBpm).toBe(140);
    expect(withHr.avgPowerW).toBe(180);
    expect(withHr.weightedPowerW).toBe(180);
    expect(withHr.trainingLoad).toBeCloseTo((5 / 3600) * (180 / 200) ** 2 * 100, 6);

    // No HR at all and no FTP: nulls in the summary, no HR in the FIT.
    const rideB = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
    appendRange(recorder, rideB, STARTED_AT, 5, { hrBpm: null });
    const { fitPath, summary: noHr } = await recorder.finalizeRide(rideB, { endedAt: STARTED_AT + 5000 });
    expect(noHr.avgHrBpm).toBeNull();
    expect(noHr.trainingLoad).toBeNull();

    const { messages } = new Decoder(Stream.fromBuffer(readFileSync(fitPath))).read();
    expect(messages.recordMesgs!.every((record) => record.heartRate === undefined)).toBe(true);
    expect(messages.sessionMesgs![0]!.avgHeartRate).toBeUndefined();
    db.close();
  });

  it('writes pause-aware timers: totalTimerTime = riding seconds, totalElapsedTime = wall span', async () => {
    const { recorder } = freshRecorder();
    const rideId = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
    // 60 s riding, 60 s pause (no samples), 60 s riding: 120 riding / 180 wall seconds.
    for (let i = 0; i < 60; i++) recorder.append(rideId, sampleAt(STARTED_AT, i));
    for (let i = 120; i < 180; i++) recorder.append(rideId, sampleAt(STARTED_AT, i));
    const endedAt = STARTED_AT + 180_000;
    const laps = [{ startTs: STARTED_AT, endTs: endedAt, ridingS: 120 }];

    const { fitPath, summary } = await recorder.finalizeRide(rideId, { endedAt, elapsedS: 120, laps });

    expect(summary.durationS).toBe(120); // riding seconds drive the summary duration
    const { messages } = new Decoder(Stream.fromBuffer(readFileSync(fitPath))).read();
    expect(messages.recordMesgs).toHaveLength(120);
    const lap = messages.lapMesgs![0]!;
    expect(lap.totalTimerTime).toBeCloseTo(120, 2);
    expect(lap.totalElapsedTime).toBeCloseTo(180, 2);
    const session = messages.sessionMesgs![0]!;
    expect(session.totalTimerTime).toBeCloseTo(120, 2);
    expect(session.totalElapsedTime).toBeCloseTo(180, 2);
  });

  it('sessionStarted inserts a sessions row; sessionEnded stamps ended_at', async () => {
    const { db, recorder } = freshRecorder();
    recorder.sessionStarted('sess-1', 1000);
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual([{ id: 'sess-1', started_at: 1000, ended_at: null }]);
    recorder.sessionEnded('sess-1', 5000);
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual([{ id: 'sess-1', started_at: 1000, ended_at: 5000 }]);
    db.close();
  });

  it('attributes lap samples at the window edge and baselines distance to the session total', async () => {
    const { recorder } = freshRecorder();
    const rideId = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
    // End-stamped 1 Hz samples: ts = STARTED_AT + (i+1) s carries the distance
    // through the END of that second (10 m/s), so the 12 s ride samples ts 1..12
    // with distance 10..120.
    for (let i = 0; i < 12; i++) {
      recorder.append(rideId, {
        riderId: 'rider-1',
        ts: STARTED_AT + (i + 1) * 1000,
        powerW: 200,
        cadenceRpm: 90,
        hrBpm: 145,
        speedKmh: 36,
        distanceM: (i + 1) * 10,
        targetW: 200,
      });
    }
    const endedAt = STARTED_AT + 12_000;
    const laps = [
      { startTs: STARTED_AT, endTs: STARTED_AT + 6_000, ridingS: 6 },
      { startTs: STARTED_AT + 6_000, endTs: STARTED_AT + 12_000, ridingS: 6 },
    ];
    const { fitPath } = await recorder.finalizeRide(rideId, { endedAt, ftpW: 250, laps });

    const { messages } = new Decoder(Stream.fromBuffer(readFileSync(fitPath))).read();
    const lapsDecoded = messages.lapMesgs!;
    expect(lapsDecoded).toHaveLength(2);
    // The t = 6 s sample closes lap 1 (ts <= endTs); lap 2's window is (6, 12].
    expect(lapsDecoded[0]!.totalDistance).toBeCloseTo(60, 2); // d(6 s) − baseline (0)
    expect(lapsDecoded[1]!.totalDistance).toBeCloseTo(60, 2); // d(12 s) − d(6 s)
    // Lap distances telescope exactly to the session total.
    const lapSum = (lapsDecoded[0]!.totalDistance as number) + (lapsDecoded[1]!.totalDistance as number);
    expect(lapSum).toBeCloseTo(120, 2);
    expect(lapSum).toBeCloseTo(messages.sessionMesgs![0]!.totalDistance as number, 2);
    // Each lap samples exactly its own six 200 W seconds.
    expect(lapsDecoded[0]!.avgPower).toBe(200);
    expect(lapsDecoded[1]!.avgPower).toBe(200);
  });

  it('survives a ride_samples PK collision via INSERT OR REPLACE', async () => {
    const { db, recorder } = freshRecorder();
    const rideId = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
    recorder.append(rideId, sampleAt(STARTED_AT, 0, { powerW: 200 }));
    recorder.append(rideId, sampleAt(STARTED_AT, 0, { powerW: 300 })); // same (ride_id, ts)

    await expect(recorder.flush()).resolves.toBeUndefined();

    const rows = db
      .prepare('SELECT ts, power_w FROM ride_samples WHERE ride_id = ? ORDER BY ts')
      .all(rideId);
    expect(rows).toEqual([{ ts: STARTED_AT, power_w: 300 }]); // replaced, not duplicated
    db.close();
  });

  it('captures interval flush failures in lastFlushError and retries on the next interval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencycle-recorder-'));
    tempDirs.push(dir);
    vi.useFakeTimers();
    try {
      const db = openDb(':memory:');
      const recorder = new Recorder(db, dir, { flushIntervalMs: 1000 });
      const rideId = recorder.startRide({ sessionId: 's1', riderId: 'rider-1', startedAt: STARTED_AT });
      recorder.append(rideId, sampleAt(STARTED_AT, 0));
      expect(recorder.lastFlushError).toBeNull();

      db.close(); // every interval flush now fails
      await vi.advanceTimersByTimeAsync(1000);
      expect(recorder.lastFlushError).toBeInstanceOf(Error);
      const firstFailure = recorder.lastFlushError;
      await vi.advanceTimersByTimeAsync(1000); // next interval retries the same buffered rows
      expect(recorder.lastFlushError).not.toBe(firstFailure); // a fresh attempt ran (and failed)
    } finally {
      vi.useRealTimers();
    }
  });
});
