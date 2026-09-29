import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import AdmZip from 'adm-zip';
import { Encoder, Profile, type Mesg } from '@garmin/fitsdk';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceHub } from '../devices/hub.js';
import type { DeviceRegistry } from '../devices/registry.js';
import type { SessionEngine } from '../session/engine.js';
import type { Recorder } from '../session/recorder.js';
import { openDb, type Db } from '../storage/db.js';
import { importGarminZip } from '../garmin/zipImport.js';
import { registerActivitiesRoutes } from './activitiesRoutes.js';
import { registerRoutes, WorkoutLibrary } from './routes.js';

const START_MS = 1_700_000_000_000;

/** fitsdk's loose encoder types only accept Mesg; same bridge as recorder.ts. */
function fitMesg(fields: Record<string, unknown>): Mesg {
  return fields as Mesg;
}

/** Minimal decodable cycling FIT: File Id, Session, 1 Hz Records at 200 W. */
function cyclingFit(startMs: number, seconds: number): Buffer {
  const encoder = new Encoder();
  encoder.onMesg(
    Profile.MesgNum.FILE_ID,
    fitMesg({ type: 'activity', manufacturer: 'garmin', product: 0, timeCreated: new Date(startMs) }),
  );
  encoder.onMesg(
    Profile.MesgNum.SESSION,
    fitMesg({
      messageIndex: 0,
      timestamp: new Date(startMs + (seconds - 1) * 1000),
      startTime: new Date(startMs),
      event: 'session',
      eventType: 'stop',
      sport: 'cycling',
      subSport: 'generic',
      totalElapsedTime: seconds - 1,
      totalTimerTime: seconds - 1,
    }),
  );
  for (let i = 0; i < seconds; i++) {
    encoder.onMesg(
      Profile.MesgNum.RECORD,
      fitMesg({ timestamp: new Date(startMs + i * 1000), power: 200, heartRate: 140, distance: i * 10 }),
    );
  }
  return Buffer.from(encoder.close());
}

/** Tiny single-activity ZIP, as the import endpoint receives from the UI. */
function tinyZip(startMs: number): Buffer {
  const zip = new AdmZip();
  zip.addFile('activity.fit', cyclingFit(startMs, 30));
  return zip.toBuffer();
}

/** Raw multipart body for a single file part (busboy-consumable). */
function multipartBody(zip: Buffer): { boundary: string; body: Buffer } {
  const boundary = '----opencycle-test-boundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="export.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, body };
}

interface World {
  app: FastifyInstance;
  db: Db;
  session: unknown;
}

const tempDirs: string[] = [];
const worlds: World[] = [];

afterEach(async () => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    if (world === undefined) continue;
    await world.app.close().catch(() => {});
    world.db.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Engine whose session state the tests drive directly (null = no active session). */
function fakeEngine(session: unknown): SessionEngine {
  return { get session() { return session; } } as unknown as SessionEngine;
}

async function buildWorld(session: unknown = null, multipartLimit?: number): Promise<World> {
  const db = openDb(':memory:');
  const plansDir = mkdtempSync(join(tmpdir(), 'opencycle-activities-plans-'));
  tempDirs.push(plansDir);
  const workoutLibrary = new WorkoutLibrary(db, plansDir);
  const ctx = {
    db,
    registry: {} as DeviceRegistry,
    engine: fakeEngine(session),
    recorder: {} as Recorder,
    hub: {} as DeviceHub,
    workoutLibrary,
  };
  const app = Fastify({ logger: false });
  registerRoutes(app, ctx);
  // Pre-register multipart with a custom fileSize cap so tests can exercise
  // the 413 path without allocating a 2 GiB body (registerActivitiesRoutes
  // skips re-registration via its hasPlugin guard).
  if (multipartLimit !== undefined) {
    await app.register(multipart, { limits: { fileSize: multipartLimit } });
  }
  registerActivitiesRoutes(app, {
    db,
    engine: ctx.engine,
    importZip: (buf, riderId) => importGarminZip(db, buf, riderId),
  });
  await app.ready();
  const world: World = { app, db, session };
  worlds.push(world);
  return world;
}

function insertProfile(db: Db, id: string): void {
  db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, name: `Rider ${id}`, ftpW: 250, weightKg: 75 }),
  );
}

function seedActivity(
  db: Db,
  id: string,
  startedAt: number,
  riderId: string | null,
  summary: Record<string, unknown> = { distanceM: 290 },
): void {
  db.prepare(
    `INSERT INTO activities (id, source, rider_id, started_at, duration_s, sport, name, summary)
     VALUES (?, 'garmin-zip', ?, ?, 30, 'cycling', ?, ?)`,
  ).run(id, riderId, startedAt, `Activity ${id}`, JSON.stringify(summary));
}

describe('GET /api/activities', () => {
  it('lists activities newest-first and filters by riderId', async () => {
    const world = await buildWorld();
    seedActivity(world.db, 'a1', START_MS, null);
    seedActivity(world.db, 'a2', START_MS + 1000, 'p1');
    seedActivity(world.db, 'a3', START_MS + 2000, 'p1');

    const all = await world.app.inject({ method: 'GET', url: '/api/activities' });
    expect(all.statusCode).toBe(200);
    expect((all.json() as Array<{ id: string }>).map((row) => row.id)).toEqual(['a3', 'a2', 'a1']);

    const filtered = await world.app.inject({ method: 'GET', url: '/api/activities?riderId=p1' });
    expect(filtered.statusCode).toBe(200);
    const rows = filtered.json() as Array<{ id: string; riderId: string | null }>;
    expect(rows.map((row) => row.id)).toEqual(['a3', 'a2']);
    expect(rows.every((row) => row.riderId === 'p1')).toBe(true);

    const bad = await world.app.inject({ method: 'GET', url: '/api/activities?riderId=' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /api/activities/assign', () => {
  it('assigns, unassigns, and reports the updated count', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'p1');
    seedActivity(world.db, 'a1', START_MS, null);
    seedActivity(world.db, 'a2', START_MS + 1000, null);

    const assign = await world.app.inject({
      method: 'POST',
      url: '/api/activities/assign',
      payload: { riderId: 'p1', ids: ['a1', 'a2'] },
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json()).toEqual({ updated: 2 });
    expect(world.db.prepare('SELECT rider_id FROM activities WHERE id = ?').get('a1')).toEqual({ rider_id: 'p1' });

    const unassign = await world.app.inject({
      method: 'POST',
      url: '/api/activities/assign',
      payload: { riderId: null, ids: ['a1'] },
    });
    expect(unassign.statusCode).toBe(200);
    expect(unassign.json()).toEqual({ updated: 1 });
    expect(world.db.prepare('SELECT rider_id FROM activities WHERE id = ?').get('a1')).toEqual({ rider_id: null });
  });

  it('404s for unknown riders and 400s for malformed bodies', async () => {
    const world = await buildWorld();
    seedActivity(world.db, 'a1', START_MS, null);

    const noRider = await world.app.inject({
      method: 'POST',
      url: '/api/activities/assign',
      payload: { riderId: 'ghost', ids: ['a1'] },
    });
    expect(noRider.statusCode).toBe(404);
    expect(noRider.json()).toEqual({ error: 'Unknown profile ghost' });

    for (const payload of [{ ids: [] }, { riderId: 'p1' }, { riderId: 7, ids: ['a1'] }]) {
      const res = await world.app.inject({ method: 'POST', url: '/api/activities/assign', payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('skips assigning an activity whose dedupe triple already exists under the rider — load not doubled', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'p1');
    // Attributed by a pull: p1 already holds the (START_MS, 30 s) triple.
    seedActivity(world.db, 'a1', START_MS, 'p1', { distanceM: 290, trainingLoad: 50 });
    // Unassigned duplicate of the same ride (e.g. ZIP imported without a rider).
    seedActivity(world.db, 'a2', START_MS, null, { distanceM: 290, trainingLoad: 50 });

    const res = await world.app.inject({
      method: 'POST',
      url: '/api/activities/assign',
      payload: { riderId: 'p1', ids: ['a1', 'a2'] },
    });
    expect(res.statusCode).toBe(200);
    // a1 re-assigns (counted); a2 is skipped by the NOT EXISTS guard.
    expect(res.json()).toEqual({ updated: 1 });

    const rows = world.db
      .prepare('SELECT id, rider_id AS riderId FROM activities ORDER BY id')
      .all() as Array<{ id: string; riderId: string | null }>;
    expect(rows).toEqual([
      { id: 'a1', riderId: 'p1' },
      { id: 'a2', riderId: null },
    ]);
    // No double row under the rider, so training load is not doubled.
    const loads = world.db
      .prepare("SELECT json_extract(summary, '$.trainingLoad') AS load FROM activities WHERE rider_id = ?")
      .all('p1') as Array<{ load: number }>;
    expect(loads).toEqual([{ load: 50 }]);
  });
});

describe('POST /api/garmin/import-zip', () => {
  it('imports a ZIP and attributes it to the ?riderId= profile', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'p1');
    const { boundary, body } = multipartBody(tinyZip(START_MS));

    const res = await world.app.inject({
      method: 'POST',
      url: '/api/garmin/import-zip?riderId=p1',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ imported: 1, skipped: 0, errors: [] });
    const row = world.db.prepare('SELECT rider_id AS riderId FROM activities').get() as { riderId: string | null };
    expect(row.riderId).toBe('p1');

    // Without a riderId the same activity lands unassigned (rider-scoped dedupe).
    const unassigned = await world.app.inject({
      method: 'POST',
      url: '/api/garmin/import-zip',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json()).toEqual({ imported: 1, skipped: 0, errors: [] });
  });

  it('404s when ?riderId= is not a profile', async () => {
    const world = await buildWorld();
    const { boundary, body } = multipartBody(tinyZip(START_MS + 1000));
    const res = await world.app.inject({
      method: 'POST',
      url: '/api/garmin/import-zip?riderId=ghost',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Unknown profile ghost' });
    expect(world.db.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({ n: 0 });
  });

  it('409s while a session is active, before touching the file', async () => {
    const world = await buildWorld({ id: 's1', startedAt: 1, riders: [] });
    const { boundary, body } = multipartBody(tinyZip(START_MS + 2000));
    const res = await world.app.inject({
      method: 'POST',
      url: '/api/garmin/import-zip',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'import blocked while a session is active' });
    expect(world.db.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({ n: 0 });
  });

  it('415s non-multipart POSTs and 413s oversized file parts', async () => {
    const world = await buildWorld(null, 1024);
    insertProfile(world.db, 'p1');

    // Non-multipart content type: req.file() rejects with
    // FST_INVALID_MULTIPART_CONTENT_TYPE -> 415, not a size error.
    const notMultipart = await world.app.inject({
      method: 'POST',
      url: '/api/garmin/import-zip?riderId=p1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ file: 'not a file' }),
    });
    expect(notMultipart.statusCode).toBe(415);
    expect(notMultipart.json()).toEqual({ error: 'Expected a multipart/form-data upload' });

    // File part above the 1 KiB cap (FST_REQ_FILE_TOO_LARGE) stays a 413.
    const boundary = '----opencycle-test-boundary';
    const oversized = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      Buffer.alloc(4096, 7),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const tooBig = await world.app.inject({
      method: 'POST',
      url: '/api/garmin/import-zip?riderId=p1',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: oversized,
    });
    expect(tooBig.statusCode).toBe(413);

    expect(world.db.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({ n: 0 });
  });
});

describe('rides list (registerRoutes-owned)', () => {
  it('carries uploadStatus/uploadError on every ride item', async () => {
    const world = await buildWorld();
    world.db
      .prepare(
        `INSERT INTO rides (id, session_id, rider_id, started_at, ended_at, upload_status, upload_error)
         VALUES ('r1', 's1', 'p1', ?, ?, 'failed', 'Garmin said no')`,
      )
      .run(START_MS, START_MS + 3600_000);
    world.db
      .prepare(
        `INSERT INTO rides (id, session_id, rider_id, started_at, ended_at)
         VALUES ('r2', 's1', 'p1', ?, ?)`,
      )
      .run(START_MS + 1000, START_MS + 1000 + 3600_000);

    const res = await world.app.inject({ method: 'GET', url: '/api/rides' });
    expect(res.statusCode).toBe(200);
    const rides = res.json() as Array<{ id: string; uploadStatus: string | null; uploadError: string | null }>;
    expect(rides).toHaveLength(2);
    expect(rides.find((ride) => ride.id === 'r1')).toEqual(
      expect.objectContaining({ uploadStatus: 'failed', uploadError: 'Garmin said no' }),
    );
    expect(rides.find((ride) => ride.id === 'r2')).toEqual(
      expect.objectContaining({ uploadStatus: null, uploadError: null }),
    );
  });
});
