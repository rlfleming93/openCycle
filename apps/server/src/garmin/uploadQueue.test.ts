import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionEngine } from '../session/engine.js';
import { openDb, type Db } from '../storage/db.js';
import { attachAutoUpload, UploadQueue, type UploadConnector } from './uploadQueue.js';

/** Records calls, can block, and can reject — never touches a real browser. */
class FakeConnector implements UploadConnector {
  readonly uploads: Array<{ riderId: string; fitPath: string }> = [];
  /** When set, uploadFit rejects with this error. */
  failWith: Error | null = null;
  /** When set, uploadFit blocks until the promise resolves. */
  gate: Promise<void> | null = null;
  hasLoginResult = true;
  readonly loginChecks: string[] = [];

  async uploadFit(riderId: string, fitPath: string): Promise<void> {
    this.uploads.push({ riderId, fitPath });
    if (this.gate !== null) await this.gate;
    if (this.failWith !== null) throw this.failWith;
  }

  hasLogin(riderId: string): boolean {
    this.loginChecks.push(riderId);
    return this.hasLoginResult;
  }
}

interface Ride {
  id: string;
  riderId: string;
  fitPath?: string | null;
  startedAt?: number;
}

function insertRide(db: Db, ride: Ride): void {
  db.prepare(
    `INSERT INTO rides (id, session_id, rider_id, started_at, ended_at, fit_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    ride.id,
    's1',
    ride.riderId,
    ride.startedAt ?? 1_700_000_000_000,
    (ride.startedAt ?? 1_700_000_000_000) + 3600,
    ride.fitPath ?? null,
  );
}

function insertProfile(db: Db, profile: Record<string, unknown>): void {
  db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
    String(profile.id),
    JSON.stringify({ name: 'Ryan', ftpW: 250, weightKg: 75, ...profile }),
  );
}

function statusOf(db: Db, rideId: string): { uploadStatus: string | null; uploadError: string | null } {
  return db
    .prepare('SELECT upload_status AS uploadStatus, upload_error AS uploadError FROM rides WHERE id = ?')
    .get(rideId) as { uploadStatus: string | null; uploadError: string | null };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dbs: Db[] = [];

afterEach(() => {
  while (dbs.length > 0) {
    const db = dbs.pop();
    if (db !== undefined && db.open) db.close();
  }
});

function freshDb(): Db {
  const db = openDb(':memory:');
  dbs.push(db);
  return db;
}

describe('UploadQueue', () => {
  it('transitions pending → uploading → uploaded and calls the connector', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    const queue = new UploadQueue(db, connector);
    insertRide(db, { id: 'r1', riderId: 'p1', fitPath: '/tmp/x.fit' });

    let release!: () => void;
    connector.gate = new Promise((resolve) => {
      release = resolve;
    });
    queue.enqueue('r1');
    await waitFor(() => statusOf(db, 'r1').uploadStatus === 'uploading');
    expect(connector.uploads).toEqual([{ riderId: 'p1', fitPath: '/tmp/x.fit' }]);
    expect(statusOf(db, 'r1').uploadError).toBeNull();

    release();
    await waitFor(() => statusOf(db, 'r1').uploadStatus === 'uploaded');
    expect(statusOf(db, 'r1').uploadError).toBeNull();
  });

  it('marks failed with the error reason when uploadFit rejects', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    connector.failWith = new Error('No Garmin login for rider p1');
    const queue = new UploadQueue(db, connector);
    insertRide(db, { id: 'r1', riderId: 'p1', fitPath: '/tmp/x.fit' });

    queue.enqueue('r1');
    await waitFor(() => statusOf(db, 'r1').uploadStatus === 'failed');
    expect(statusOf(db, 'r1').uploadError).toBe('No Garmin login for rider p1');
  });

  it('fails rides without a FIT file without calling the connector', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    const queue = new UploadQueue(db, connector);
    insertRide(db, { id: 'r1', riderId: 'p1' });

    queue.enqueue('r1');
    await waitFor(() => statusOf(db, 'r1').uploadStatus === 'failed');
    expect(statusOf(db, 'r1').uploadError).toContain('no FIT file');
    expect(connector.uploads).toEqual([]);
  });

  it('processes two enqueued rides serially in enqueue order', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    const queue = new UploadQueue(db, connector);
    insertRide(db, { id: 'r1', riderId: 'p1', fitPath: '/tmp/a.fit' });
    insertRide(db, { id: 'r2', riderId: 'p1', fitPath: '/tmp/b.fit' });

    let release!: () => void;
    connector.gate = new Promise((resolve) => {
      release = resolve;
    });
    queue.enqueue('r1');
    queue.enqueue('r2');

    // First ride in flight, second still queued: no overlap.
    await waitFor(() => connector.uploads.length === 1);
    expect(connector.uploads.map((upload) => upload.fitPath)).toEqual(['/tmp/a.fit']);
    expect(statusOf(db, 'r1').uploadStatus).toBe('uploading');
    expect(statusOf(db, 'r2').uploadStatus).toBe('pending');

    release();
    await waitFor(() => statusOf(db, 'r2').uploadStatus === 'uploaded');
    expect(connector.uploads.map((upload) => upload.fitPath)).toEqual(['/tmp/a.fit', '/tmp/b.fit']);
    expect(statusOf(db, 'r1').uploadStatus).toBe('uploaded');
  });

  it('reconciles rides left pending or uploading by a previous process on construction', () => {
    const db = freshDb();
    const connector = new FakeConnector();
    insertRide(db, { id: 'r-pending', riderId: 'p1', fitPath: '/tmp/a.fit' });
    insertRide(db, { id: 'r-uploading', riderId: 'p1', fitPath: '/tmp/b.fit' });
    insertRide(db, { id: 'r-uploaded', riderId: 'p1', fitPath: '/tmp/c.fit' });
    insertRide(db, { id: 'r-failed', riderId: 'p1', fitPath: '/tmp/d.fit' });
    db.prepare("UPDATE rides SET upload_status = 'pending' WHERE id = 'r-pending'").run();
    db.prepare("UPDATE rides SET upload_status = 'uploading' WHERE id = 'r-uploading'").run();
    db.prepare("UPDATE rides SET upload_status = 'uploaded' WHERE id = 'r-uploaded'").run();
    db.prepare("UPDATE rides SET upload_status = 'failed', upload_error = 'nope' WHERE id = 'r-failed'").run();

    new UploadQueue(db, connector);

    expect(statusOf(db, 'r-pending')).toEqual({ uploadStatus: 'failed', uploadError: 'interrupted by restart' });
    expect(statusOf(db, 'r-uploading')).toEqual({ uploadStatus: 'failed', uploadError: 'interrupted by restart' });
    expect(statusOf(db, 'r-uploaded')).toEqual({ uploadStatus: 'uploaded', uploadError: null });
    expect(statusOf(db, 'r-failed')).toEqual({ uploadStatus: 'failed', uploadError: 'nope' });
  });

  it('never throws or rejects when the DB is closed mid-drain (shutdown race)', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    const logs: string[] = [];
    const queue = new UploadQueue(db, connector, (message) => logs.push(message));
    insertRide(db, { id: 'r1', riderId: 'p1', fitPath: '/tmp/x.fit' });
    connector.gate = new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    queue.enqueue('r1');
    await waitFor(() => connector.uploads.length === 1);

    // The app closes the DB while the connector is still in flight.
    db.close();
    expect(() => queue.enqueue('r2')).not.toThrow();
    await sleep(50);
    expect(logs.some((message) => message.includes('DB write failed'))).toBe(true);
    expect(logs.some((message) => message.includes('upload skipped'))).toBe(true);
  });
});

describe('attachAutoUpload', () => {
  function fakeEngine(): SessionEngine {
    return new EventEmitter() as unknown as SessionEngine;
  }

  it('enqueues the newest finalized ride when autoUpload and hasLogin', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    const queue = new UploadQueue(db, connector);
    const engine = fakeEngine();
    attachAutoUpload(engine, db, queue);

    insertProfile(db, { id: 'p1', garmin: { email: 'r@example.com', autoUpload: true } });
    insertRide(db, { id: 'r-old', riderId: 'p1', fitPath: '/tmp/old.fit', startedAt: 1_700_000_000_000 });
    insertRide(db, { id: 'r-new', riderId: 'p1', fitPath: '/tmp/new.fit', startedAt: 1_700_000_100_000 });

    engine.emit('event', { kind: 'riderLeft', riderId: 'p1', ts: 1_700_000_200_000 });

    await waitFor(() => statusOf(db, 'r-new').uploadStatus === 'uploaded');
    expect(connector.uploads.map((upload) => upload.fitPath)).toEqual(['/tmp/new.fit']);
    expect(statusOf(db, 'r-old').uploadStatus).toBeNull();
  });

  it('skips riders without garmin.autoUpload', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    const queue = new UploadQueue(db, connector);
    const engine = fakeEngine();
    attachAutoUpload(engine, db, queue);

    insertProfile(db, { id: 'p1', garmin: { email: 'r@example.com' } });
    insertRide(db, { id: 'r1', riderId: 'p1', fitPath: '/tmp/x.fit' });

    engine.emit('event', { kind: 'riderLeft', riderId: 'p1', ts: 1_700_000_200_000 });
    await sleep(50);
    expect(statusOf(db, 'r1').uploadStatus).toBeNull();
    expect(connector.uploads).toEqual([]);
  });

  it('skips riders without a saved Garmin login even when autoUpload is on', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    connector.hasLoginResult = false;
    const queue = new UploadQueue(db, connector);
    const engine = fakeEngine();
    attachAutoUpload(engine, db, queue);

    insertProfile(db, { id: 'p1', garmin: { email: 'r@example.com', autoUpload: true } });
    insertRide(db, { id: 'r1', riderId: 'p1', fitPath: '/tmp/x.fit' });

    engine.emit('event', { kind: 'riderLeft', riderId: 'p1', ts: 1_700_000_200_000 });
    await sleep(50);
    expect(statusOf(db, 'r1').uploadStatus).toBeNull();
    expect(connector.uploads).toEqual([]);
    expect(connector.loginChecks).toContain('p1');
  });

  it('ignores non-riderLeft events', async () => {
    const db = freshDb();
    const connector = new FakeConnector();
    const queue = new UploadQueue(db, connector);
    const engine = fakeEngine();
    attachAutoUpload(engine, db, queue);

    insertProfile(db, { id: 'p1', garmin: { email: 'r@example.com', autoUpload: true } });
    insertRide(db, { id: 'r1', riderId: 'p1', fitPath: '/tmp/x.fit' });

    engine.emit('event', { kind: 'workoutCompleted', riderId: 'p1', ts: 1_700_000_200_000 });
    await sleep(50);
    expect(statusOf(db, 'r1').uploadStatus).toBeNull();
    expect(connector.uploads).toEqual([]);
  });
});

describe('migration 3', () => {
  it('exposes upload_status and upload_error columns on rides', () => {
    const db = freshDb();
    // Migration 3 or later (later phases append migrations; db.test.ts pins the exact count).
    expect(Number(db.pragma('user_version', { simple: true }))).toBeGreaterThanOrEqual(3);
    const columns = db.prepare('PRAGMA table_info(rides)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['upload_status', 'upload_error']),
    );
  });
});
