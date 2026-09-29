import AdmZip from 'adm-zip';
import { Encoder, Profile, type Mesg } from '@garmin/fitsdk';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionEngine } from '../session/engine.js';
import { openDb, type Db } from '../storage/db.js';
import type { UploadQueue } from '../garmin/uploadQueue.js';
import { registerGarminRoutes } from './garminRoutes.js';

const START_MS = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

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

/** The real download shape: one ZIP per activity, holding the .fit. */
function activityZip(startMs: number): Buffer {
  const zip = new AdmZip();
  zip.addFile('activity.fit', cyclingFit(startMs, 30));
  return zip.toBuffer();
}

/** Queue surface the routes need; records enqueues instead of uploading. */
class FakeQueue {
  readonly enqueued: string[] = [];
  enqueue(rideId: string): void {
    this.enqueued.push(rideId);
  }
}

/** Pull surface: scripted buffers or a failure; never touches a browser. */
class FakeConnector {
  readonly pulls: string[] = [];
  result: Buffer[] = [];
  failWith: Error | null = null;

  async pullRecentActivities(riderId: string): Promise<Buffer[]> {
    this.pulls.push(riderId);
    if (this.failWith !== null) throw this.failWith;
    return this.result;
  }
}

interface World {
  app: FastifyInstance;
  db: Db;
  queue: FakeQueue;
  connector: FakeConnector;
}

const worlds: World[] = [];

afterEach(async () => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    if (world === undefined) continue;
    await world.app.close().catch(() => {});
    world.db.close();
  }
});

/** Engine whose session state the tests drive directly (null = no active session). */
function fakeEngine(session: unknown): SessionEngine {
  return { get session() { return session; } } as unknown as SessionEngine;
}

async function buildWorld(session: unknown = null): Promise<World> {
  const db = openDb(':memory:');
  const queue = new FakeQueue();
  const connector = new FakeConnector();
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    reply.code((err as { status?: number }).status ?? 500).send({ error: (err as Error).message });
  });
  registerGarminRoutes(app, {
    db,
    queue: queue as unknown as UploadQueue,
    connector,
    engine: fakeEngine(session),
  });
  await app.ready();
  const world: World = { app, db, queue, connector };
  worlds.push(world);
  return world;
}

function insertProfile(db: Db, id: string): void {
  db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, name: `Rider ${id}`, ftpW: 250, weightKg: 75 }),
  );
}

function insertRide(db: Db, id: string, opts: { fitPath?: string | null; status?: string | null; error?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO rides (id, session_id, rider_id, started_at, ended_at, fit_path, upload_status, upload_error)
     VALUES (?, 's1', 'p1', ?, ?, ?, ?, ?)`,
  ).run(id, START_MS, START_MS + 3600_000, opts.fitPath ?? null, opts.status ?? null, opts.error ?? null);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /api/rides/:id/upload', () => {
  it('404s for unknown rides and 409s for rides without a FIT file', async () => {
    const world = await buildWorld();
    insertRide(world.db, 'r1', { fitPath: null });

    const missing = await world.app.inject({ method: 'POST', url: '/api/rides/nope/upload' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Unknown ride nope' });

    const noFit = await world.app.inject({ method: 'POST', url: '/api/rides/r1/upload' });
    expect(noFit.statusCode).toBe(409);
    expect(noFit.json()).toEqual({ error: 'Ride r1 has no FIT file yet' });
    expect(world.queue.enqueued).toEqual([]);
  });

  it('202s and enqueues the ride for upload', async () => {
    const world = await buildWorld();
    insertRide(world.db, 'r1', { fitPath: '/tmp/ride.fit' });

    const res = await world.app.inject({ method: 'POST', url: '/api/rides/r1/upload' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued' });
    expect(world.queue.enqueued).toEqual(['r1']);
  });
});

describe('GET /api/rides/:id/upload-status', () => {
  it('returns the recorded status and error, null when never queued', async () => {
    const world = await buildWorld();
    insertRide(world.db, 'r1', { fitPath: '/tmp/ride.fit', status: 'failed', error: 'Garmin said no' });
    insertRide(world.db, 'r2', { fitPath: '/tmp/ride.fit' });

    const failed = await world.app.inject({ method: 'GET', url: '/api/rides/r1/upload-status' });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toEqual({ uploadStatus: 'failed', uploadError: 'Garmin said no' });

    const never = await world.app.inject({ method: 'GET', url: '/api/rides/r2/upload-status' });
    expect(never.statusCode).toBe(200);
    expect(never.json()).toEqual({ uploadStatus: null, uploadError: null });

    const missing = await world.app.inject({ method: 'GET', url: '/api/rides/nope/upload-status' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /api/garmin/pull/:riderId', () => {
  it('202s immediately and imports the pulled archives under that rider in the background', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'p1');
    world.connector.result = [activityZip(START_MS), activityZip(START_MS + HOUR_MS)];

    const res = await world.app.inject({ method: 'POST', url: '/api/garmin/pull/p1' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'started' });
    expect(world.connector.pulls).toEqual(['p1']);

    await waitFor(() => {
      const row = world.db
        .prepare('SELECT COUNT(*) AS n FROM activities WHERE rider_id = ?')
        .get('p1') as { n: number };
      return row.n === 2;
    });
    const rows = world.db
      .prepare('SELECT rider_id AS riderId, source FROM activities ORDER BY started_at ASC')
      .all() as Array<{ riderId: string | null; source: string }>;
    expect(rows).toEqual([
      { riderId: 'p1', source: 'garmin-zip' },
      { riderId: 'p1', source: 'garmin-zip' },
    ]);
  });

  it('409s while a session is active, before starting the pull', async () => {
    const world = await buildWorld({ id: 's1', startedAt: 1, riders: [] });
    insertProfile(world.db, 'p1');

    const res = await world.app.inject({ method: 'POST', url: '/api/garmin/pull/p1' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'history pull blocked while a session is active' });
    expect(world.connector.pulls).toEqual([]);
    expect(world.db.prepare('SELECT COUNT(*) AS n FROM activities').get()).toEqual({ n: 0 });
  });

  it('404s for unknown profiles and 400s for an empty rider id', async () => {
    const world = await buildWorld();

    const missing = await world.app.inject({ method: 'POST', url: '/api/garmin/pull/ghost' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Unknown profile ghost' });

    const empty = await world.app.inject({ method: 'POST', url: '/api/garmin/pull/' });
    expect(empty.statusCode).toBe(400);
    expect(world.connector.pulls).toEqual([]);
  });

  it('keeps the 202 when the pull fails; failures are non-fatal', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'p1');
    world.connector.failWith = new Error('login state expired');

    const res = await world.app.inject({ method: 'POST', url: '/api/garmin/pull/p1' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'started' });
    expect(world.connector.pulls).toEqual(['p1']);
  });
});
