import AdmZip from 'adm-zip';
import { Encoder, Profile, type Mesg } from '@garmin/fitsdk';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDb } from '../storage/db.js';
import { importFitBuffer, importGarminZip } from './zipImport.js';

const START_MS = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

interface RecordFixture {
  timestamp: Date;
  power?: number;
  heartRate?: number;
  distance?: number;
}

interface ActivityRow {
  source: string;
  riderId: string | null;
  startedAt: number;
  durationS: number;
  sport: string | null;
  name: string | null;
  summary: Record<string, unknown> | null;
  power1Hz: number[] | null;
  hr1Hz: number[] | null;
}

/** fitsdk's loose encoder types only accept Mesg; same bridge as recorder.ts. */
function fitMesg(fields: Record<string, unknown>): Mesg {
  return fields as Mesg;
}

/** Minimal decodable FIT: File Id, Session (carries sport), 1 Hz Records. */
function buildFit(opts: { sport: string; startMs: number; records: RecordFixture[] }): Buffer {
  const { sport, startMs, records } = opts;
  const endMs = records.length > 0 ? records.at(-1)!.timestamp.getTime() : startMs;
  const durationS = Math.max(0, (endMs - startMs) / 1000);
  const encoder = new Encoder();
  encoder.onMesg(
    Profile.MesgNum.FILE_ID,
    fitMesg({ type: 'activity', manufacturer: 'garmin', product: 0, timeCreated: new Date(startMs) }),
  );
  encoder.onMesg(
    Profile.MesgNum.SESSION,
    fitMesg({
      messageIndex: 0,
      timestamp: new Date(endMs),
      startTime: new Date(startMs),
      event: 'session',
      eventType: 'stop',
      sport,
      subSport: 'generic',
      totalElapsedTime: durationS,
      totalTimerTime: durationS,
    }),
  );
  for (const record of records) {
    encoder.onMesg(
      Profile.MesgNum.RECORD,
      fitMesg({
        timestamp: record.timestamp,
        ...(record.power !== undefined ? { power: record.power } : {}),
        ...(record.heartRate !== undefined ? { heartRate: record.heartRate } : {}),
        ...(record.distance !== undefined ? { distance: record.distance } : {}),
      }),
    );
  }
  return Buffer.from(encoder.close());
}

/** 1 Hz cycling activity: constant power 200 W, HR 140, 10 m per second. */
function cyclingFit(startMs: number, seconds: number): Buffer {
  const records: RecordFixture[] = [];
  for (let i = 0; i < seconds; i++) {
    records.push({ timestamp: new Date(startMs + i * 1000), power: 200, heartRate: 140, distance: i * 10 });
  }
  return buildFit({ sport: 'cycling', startMs, records });
}

/** 1 Hz running activity: HR 150, distance, no power field. */
function runningFit(startMs: number, seconds: number): Buffer {
  const records: RecordFixture[] = [];
  for (let i = 0; i < seconds; i++) {
    records.push({ timestamp: new Date(startMs + i * 1000), heartRate: 150, distance: i * 10 });
  }
  return buildFit({ sport: 'running', startMs, records });
}

/** 10 Hz cycling activity: per-second power 100..190 and HR 130..139 sweep. */
function tenHzFit(startMs: number, seconds: number): Buffer {
  const records: RecordFixture[] = [];
  for (let i = 0; i < seconds * 10; i++) {
    records.push({
      timestamp: new Date(startMs + i * 100),
      power: 100 + (i % 10) * 10,
      heartRate: 130 + (i % 10),
      distance: i * 10,
    });
  }
  return buildFit({ sport: 'cycling', startMs, records });
}

/** Garmin export JSON: local wall-clock startTime strings, as the real export writes. */
function summarizedJson(entries: Array<{ startMs: number; name: string }>): Buffer {
  return Buffer.from(
    JSON.stringify(
      entries.map((entry) => ({
        activityId: 1,
        activityName: entry.name,
        startTime: localTimeString(new Date(entry.startMs)),
      })),
    ),
  );
}

function localTimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildZip(files: Array<{ path: string; buf: Buffer }>): Buffer {
  const zip = new AdmZip();
  for (const file of files) zip.addFile(file.path, file.buf);
  return zip.toBuffer();
}

function activityRows(db: Database.Database): ActivityRow[] {
  const rows = db
    .prepare(
      'SELECT source, rider_id AS riderId, started_at AS startedAt, duration_s AS durationS, sport, name,' +
        ' summary, power_1hz AS power1Hz, hr_1hz AS hr1Hz FROM activities ORDER BY started_at ASC',
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    source: row.source as string,
    riderId: row.riderId as string | null,
    startedAt: row.startedAt as number,
    durationS: row.durationS as number,
    sport: row.sport as string | null,
    name: row.name as string | null,
    summary: row.summary === null ? null : JSON.parse(row.summary as string),
    power1Hz: row.power1Hz === null ? null : JSON.parse(row.power1Hz as string),
    hr1Hz: row.hr1Hz === null ? null : JSON.parse(row.hr1Hz as string),
  }));
}

const openDbs: Database.Database[] = [];

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

function freshDb(): Database.Database {
  const db = openDb(':memory:');
  openDbs.push(db);
  return db;
}

describe('importGarminZip', () => {
  it('imports cycling + running from nested zips with names, streams, and summaries; re-import skips', () => {
    const db = freshDb();
    const cyclingStart = START_MS;
    const runningStart = START_MS + 24 * HOUR_MS;
    const zip = buildZip([
      { path: 'DI_CONNECT/DI-Connect-Fitness/cycling.zip', buf: buildZip([
        { path: 'activity.fit', buf: cyclingFit(cyclingStart, 120) },
        { path: 'DI-Connect-Statistics-SummarizedActivities.json', buf: summarizedJson([
          { startMs: cyclingStart, name: 'Morning Ride' },
          { startMs: runningStart, name: 'Evening Run' },
        ]) },
      ]) },
      { path: 'DI_CONNECT/DI-Connect-Fitness/running.zip', buf: buildZip([
        { path: 'run.fit', buf: runningFit(runningStart, 60) },
      ]) },
    ]);

    expect(importGarminZip(db, zip)).toEqual({ imported: 2, skipped: 0, errors: [] });

    const rows = activityRows(db);
    expect(rows).toHaveLength(2);
    const cycling = rows[0]!;
    expect(cycling).toMatchObject({
      source: 'garmin-zip',
      riderId: null,
      startedAt: cyclingStart,
      durationS: 119,
      sport: 'cycling',
      name: 'Morning Ride',
      summary: { distanceM: 1190, avgPowerW: 200, weightedPowerW: 200, avgHrBpm: 140 },
    });
    expect(cycling.power1Hz).toEqual(new Array<number>(120).fill(200));
    expect(cycling.hr1Hz).toEqual(new Array<number>(120).fill(140));

    const running = rows[1]!;
    expect(running).toMatchObject({
      source: 'garmin-zip',
      riderId: null,
      startedAt: runningStart,
      durationS: 59,
      sport: 'running',
      name: 'Evening Run',
      summary: { distanceM: 590, avgHrBpm: 150 },
    });
    expect(running.power1Hz).toBeNull();
    expect(running.hr1Hz).toBeNull();

    // Identical bytes re-imported: every activity already present -> skipped.
    expect(importGarminZip(db, zip)).toEqual({ imported: 0, skipped: 2, errors: [] });
    expect(activityRows(db)).toHaveLength(2);
  });

  it('imports a loose root-level .fit matched to a root-level name json within the ±60 s window', () => {
    const db = freshDb();
    const start = START_MS + 2 * 24 * HOUR_MS;
    const zip = buildZip([
      { path: 'activity.fit', buf: cyclingFit(start, 30) },
      // 30 s off -> still within tolerance; the far entry must not match.
      { path: 'DI-Connect-Statistics-SummarizedActivities.json', buf: summarizedJson([
        { startMs: start + 30_000, name: 'Loose Ride' },
        { startMs: start + 90_000, name: 'Too Far' },
      ]) },
    ]);

    expect(importGarminZip(db, zip)).toEqual({ imported: 1, skipped: 0, errors: [] });
    const row = activityRows(db)[0]!;
    expect(row.name).toBe('Loose Ride');
    expect(row.source).toBe('garmin-zip');
    expect(row.startedAt).toBe(start);
    expect(row.durationS).toBe(29);
  });

  it('a corrupt member lands in errors without blocking the other files', () => {
    const db = freshDb();
    const good = cyclingFit(START_MS, 60);
    const broken = good.subarray(0, good.length - 10); // truncates the CRC
    const zip = buildZip([
      { path: 'good.fit', buf: good },
      { path: 'broken.fit', buf: broken },
    ]);

    const result = importGarminZip(db, zip);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('broken.fit');

    const rows = activityRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBeNull();
  });

  it('reports an invalid archive buffer as an error', () => {
    const db = freshDb();
    const result = importGarminZip(db, Buffer.from('not a zip file at all'));
    expect(result).toEqual({ imported: 0, skipped: 0, errors: [expect.stringMatching(/Invalid archive/) as string] });
    expect(activityRows(db)).toHaveLength(0);
  });

  it('10 Hz records downsample to 1 Hz means, gap-free', () => {
    const db = freshDb();
    const start = START_MS + 3 * 24 * HOUR_MS;
    const zip = buildZip([{ path: 'tenhz.fit', buf: tenHzFit(start, 3) }]);

    expect(importGarminZip(db, zip)).toEqual({ imported: 1, skipped: 0, errors: [] });
    const row = activityRows(db)[0]!;
    // fitsdk floors sub-second record timestamps, so 2.9 s of records spans 2 s.
    expect(row.durationS).toBe(2);
    // Per-second means: power 100..190 -> 145, HR 130..139 -> 134.5 rounds to 135.
    expect(row.power1Hz).toEqual([145, 145, 145]);
    expect(row.hr1Hz).toEqual([135, 135, 135]);
    expect(row.summary).toEqual({ distanceM: 290, avgPowerW: 145, weightedPowerW: 145, avgHrBpm: 135 });
  });

  it('carries gaps <= 10 s forward and zeroes longer ones in the 1 Hz stream', () => {
    const db = freshDb();
    const start = START_MS + 6 * 24 * HOUR_MS;
    // 240 s at 250 W / HR 140; records missing for seconds 90..149 (60 s dropout).
    const records: RecordFixture[] = [];
    for (let i = 0; i < 240; i++) {
      if (i >= 90 && i < 150) continue;
      records.push({ timestamp: new Date(start + i * 1000), power: 250, heartRate: 140, distance: i * 10 });
    }
    const fit = buildFit({ sport: 'cycling', startMs: start, records });

    expect(importGarminZip(db, buildZip([{ path: 'dropout.fit', buf: fit }]))).toEqual({
      imported: 1,
      skipped: 0,
      errors: [],
    });
    const row = activityRows(db)[0]!;
    // Seconds 90..99 carry the last 250 forward (gap <= 10 s); 100..149 are
    // honest zeros (coasting); 150..239 resume real records.
    const expectedPower = [
      ...new Array<number>(90).fill(250),
      ...new Array<number>(10).fill(250),
      ...new Array<number>(50).fill(0),
      ...new Array<number>(90).fill(250),
    ];
    const expectedHr = [
      ...new Array<number>(90).fill(140),
      ...new Array<number>(10).fill(140),
      ...new Array<number>(50).fill(0),
      ...new Array<number>(90).fill(140),
    ];
    expect(row.power1Hz).toEqual(expectedPower);
    expect(row.hr1Hz).toEqual(expectedHr);
    expect(row.durationS).toBe(239);
    // Executed vector: weightedPower over the carried stream is 230; the HR
    // average covers only present seconds (140, not the 111 a zero-filled
    // mean would give).
    expect(row.summary).toEqual({ distanceM: 2390, avgPowerW: 250, weightedPowerW: 230, avgHrBpm: 140 });
  });

  it('Smart-Recording-style 5 s cadence does not read as coasting', () => {
    const db = freshDb();
    const start = START_MS + 7 * 24 * HOUR_MS;
    // One record every 5 s: Garmin Smart Recording drops interior seconds,
    // not data — every gap is <= 10 s, so the whole ride carries forward.
    const records: RecordFixture[] = [];
    for (let i = 0; i < 240; i += 5) {
      records.push({ timestamp: new Date(start + i * 1000), power: 250, heartRate: 140, distance: i * 10 });
    }
    const fit = buildFit({ sport: 'cycling', startMs: start, records });

    expect(importGarminZip(db, buildZip([{ path: 'smart.fit', buf: fit }]))).toEqual({
      imported: 1,
      skipped: 0,
      errors: [],
    });
    const row = activityRows(db)[0]!;
    expect(row.power1Hz).toEqual(new Array<number>(236).fill(250));
    // Without carry-forward the 192 zero-filled seconds would deflate
    // weightedPower to 70; the carried stream stays a true 250.
    expect(row.summary).toEqual({ distanceM: 2350, avgPowerW: 250, weightedPowerW: 250, avgHrBpm: 140 });
  });

  it('matches names from the real wrapped export shape (epoch-ms timestamps)', () => {
    const db = freshDb();
    const start = START_MS + 8 * 24 * HOUR_MS;
    const names = Buffer.from(
      JSON.stringify([
        {
          summarizedActivitiesExport: [
            { activityId: 42, name: 'Real Export Ride', startTimeGmt: start, beginTimestamp: start },
          ],
        },
      ]),
    );
    const zip = buildZip([
      { path: 'activity.fit', buf: cyclingFit(start, 30) },
      { path: 'DI-Connect-Statistics-SummarizedActivities.json', buf: names },
    ]);

    expect(importGarminZip(db, zip)).toEqual({ imported: 1, skipped: 0, errors: [] });
    const row = activityRows(db)[0]!;
    expect(row.name).toBe('Real Export Ride');
    expect(row.startedAt).toBe(start);
  });

  it('passes an import-time riderId through to every imported activity', () => {
    const db = freshDb();
    const start = START_MS + 10 * 24 * HOUR_MS;
    const zip = buildZip([{ path: 'activity.fit', buf: cyclingFit(start, 30) }]);

    expect(importGarminZip(db, zip, 'p9')).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(activityRows(db)[0]!.riderId).toBe('p9');
    // Rider-scoped dedupe: the same zip for a different rider imports again,
    // but re-importing for the same rider skips.
    expect(importGarminZip(db, zip, 'p8')).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(importGarminZip(db, zip, 'p9')).toEqual({ imported: 0, skipped: 1, errors: [] });
    expect(activityRows(db)).toHaveLength(2);
  });
});

describe('importFitBuffer', () => {
  it('imports a single FIT as source garmin-fit with no name; identical bytes are skipped', () => {
    const db = freshDb();
    const fit = cyclingFit(START_MS + 4 * 24 * HOUR_MS, 45);

    expect(importFitBuffer(db, fit, 'garmin-fit')).toEqual({ outcome: 'imported' });
    const row = activityRows(db)[0]!;
    expect(row).toMatchObject({
      source: 'garmin-fit',
      riderId: null,
      sport: 'cycling',
      name: null,
      durationS: 44,
      summary: { distanceM: 440, avgPowerW: 200, weightedPowerW: 200, avgHrBpm: 140 },
    });

    expect(importFitBuffer(db, fit, 'garmin-fit')).toEqual({ outcome: 'skipped' });
    expect(activityRows(db)).toHaveLength(1);
  });

  it('a fit that shares started_at+duration_s with an existing activity is skipped across sources', () => {
    const db = freshDb();
    const fit = cyclingFit(START_MS + 5 * 24 * HOUR_MS, 60);
    const zip = buildZip([{ path: 'same.fit', buf: fit }]);

    expect(importGarminZip(db, zip)).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(importFitBuffer(db, fit, 'garmin-fit')).toEqual({ outcome: 'skipped' });
  });

  it('throws FitParseError for undecodable bytes', () => {
    const db = freshDb();
    expect(() => importFitBuffer(db, Buffer.from('garbage bytes'), 'garmin-fit')).toThrow(/FIT/i);
    expect(activityRows(db)).toHaveLength(0);
  });

  it('stores an import-time riderId; the same activity imports once per rider', () => {
    const db = freshDb();
    const fit = cyclingFit(START_MS + 9 * 24 * HOUR_MS, 45);

    expect(importFitBuffer(db, fit, 'garmin-fit', [], 'p1')).toEqual({ outcome: 'imported' });
    expect(importFitBuffer(db, fit, 'garmin-fit', [], 'p2')).toEqual({ outcome: 'imported' });
    // Same rider again -> the (rider_id, started_at, duration_s) dedupe skips.
    expect(importFitBuffer(db, fit, 'garmin-fit', [], 'p1')).toEqual({ outcome: 'skipped' });
    // The NULL-rider key is distinct from any rider's.
    expect(importFitBuffer(db, fit, 'garmin-fit')).toEqual({ outcome: 'imported' });

    const rows = activityRows(db);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.riderId).sort()).toEqual([null, 'p1', 'p2']);
  });
});
