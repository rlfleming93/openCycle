import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS, openDb } from './db.js';

const TABLES = ['activities', 'devices', 'discoveries', 'plan_assignments', 'profiles', 'ride_samples', 'rides', 'sessions', 'voyage_systems', 'workouts'];
const INDEXES = [
  'idx_activities_rider_started',
  'idx_discoveries_seed',
  'idx_discoveries_session_kind_streak',
  'idx_ride_samples_ride_id',
  'idx_rides_rider_started',
  'idx_voyage_rider_arrived',
  'idx_voyage_rider_session',
];

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencycle-db-'));
  tempDirs.push(dir);
  return join(dir, 'opencycle.db');
}

describe('openDb', () => {
  it('creates all ten tables and their indexes', () => {
    const db = openDb(':memory:');
    const names = (type: string) => {
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all(type) as Array<{ name: string }>;
      return rows.map((row) => row.name);
    };
    expect(names('table')).toEqual(TABLES);
    expect(names('index')).toEqual(INDEXES);
    db.close();
  });

  it('creates the contracted column layout', () => {
    const db = openDb(':memory:');
    const columns = (table: string) => {
      // PRAGMA cannot be parameterized; table names here are test literals.
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    };
    expect(columns('devices')).toEqual(['id', 'kind', 'name', 'last_seen', 'rider_id']);
    expect(columns('rides')).toEqual([
      'id',
      'session_id',
      'rider_id',
      'started_at',
      'ended_at',
      'workout_id',
      'workout_name',
      'fit_path',
      'summary',
      'upload_status',
      'upload_error',
    ]);
    expect(columns('ride_samples')).toEqual([
      'ride_id',
      'ts',
      'power_w',
      'cadence_rpm',
      'hr_bpm',
      'speed_kmh',
      'distance_m',
      'target_w',
    ]);
    expect(columns('discoveries')).toEqual([
      'id',
      'kind',
      'seed',
      'name',
      'session_id',
      'streak_s',
      'rider_ids',
      'created_at',
    ]);
    expect(columns('voyage_systems')).toEqual([
      'id',
      'rider_id',
      'session_id',
      'voyage_index',
      'seed',
      'name',
      'workout_id',
      'workout_name',
      'surveys_total',
      'surveys_clean',
      'arrived_at',
    ]);
    db.close();
  });

  it('tracks applied migrations in user_version', () => {
    const db = openDb(':memory:');
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(6);
    db.close();
  });

  it('reopening an existing database is idempotent', () => {
    const path = tempDbPath();
    const first = openDb(path);
    first.close();
    const second = openDb(path);
    expect(Number(second.pragma('user_version', { simple: true }))).toBe(6);
    second.close();
  });

  it('upgrades a real v1 database (migration 1 only) to v6 with workouts, upload columns, discoveries and voyages', () => {
    const path = tempDbPath();
    // Build an authentic v1 database: migration 1 only, user_version = 1.
    const v1 = new Database(path);
    v1.exec(MIGRATIONS[0]!);
    v1.pragma('user_version = 1');
    v1.close();

    const db = openDb(path);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(6);
    const workouts = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workouts'")
      .get();
    expect(workouts).toEqual({ name: 'workouts' });
    // Migration 3 columns land on the rides table.
    const rideColumns = db.prepare('PRAGMA table_info(rides)').all() as Array<{ name: string }>;
    expect(rideColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['upload_status', 'upload_error']),
    );
    // Migration 4 lands the discoveries table and its unique key.
    const discoveries = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discoveries'")
      .get();
    expect(discoveries).toEqual({ name: 'discoveries' });
    const unique = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_discoveries_session_kind_streak'")
      .get() as { sql: string } | undefined;
    expect(unique?.sql ?? '').toMatch(/^CREATE UNIQUE INDEX/);
    // Migration 5 lands the seed unique index (rescues are seed-keyed).
    const seedUnique = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_discoveries_seed'")
      .get() as { sql: string } | undefined;
    expect(seedUnique?.sql ?? '').toMatch(/^CREATE UNIQUE INDEX/);
    // v1 tables survive the upgrade untouched.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(TABLES);
    db.close();
  });

  it('migrates v5 planet discoveries into per-rider voyage systems', () => {
    const path = tempDbPath();
    // Build an authentic v5 database: migrations 1-5 only, user_version = 5.
    const v5 = new Database(path);
    for (const script of MIGRATIONS.slice(0, 5)) v5.exec(script);
    v5.pragma('user_version = 5');
    const insertPlanet = v5.prepare(
      `INSERT INTO discoveries (id, kind, seed, name, session_id, streak_s, rider_ids, created_at)
       VALUES (?, 'planet', ?, ?, ?, NULL, ?, ?)`,
    );
    insertPlanet.run('p1', 'sess-1', 'Keinora', 'sess-1', '["r1","r2"]', 1000);
    insertPlanet.run('p2', 'sess-2', 'Velari', 'sess-2', '["r1"]', 2000);
    // A beacon row is not a voyage and survives untouched.
    v5.prepare(
      `INSERT INTO discoveries (id, kind, seed, name, session_id, streak_s, rider_ids, created_at)
       VALUES ('b1', 'beacon', 'sess-1:30', 'Taro', 'sess-1', 30, '[]', 1500)`,
    ).run();
    v5.close();

    const db = openDb(path);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(6);
    const rows = db
      .prepare(
        `SELECT id, rider_id AS riderId, session_id AS sessionId, voyage_index AS voyageIndex,
                seed, name, arrived_at AS arrivedAt
         FROM voyage_systems ORDER BY rider_id, voyage_index`,
      )
      .all();
    expect(rows).toEqual([
      { id: 'p1:r1', riderId: 'r1', sessionId: 'sess-1', voyageIndex: 0, seed: 'sess-1', name: 'Keinora', arrivedAt: 1000 },
      { id: 'p2:r1', riderId: 'r1', sessionId: 'sess-2', voyageIndex: 1, seed: 'sess-2', name: 'Velari', arrivedAt: 2000 },
      { id: 'p1:r2', riderId: 'r2', sessionId: 'sess-1', voyageIndex: 0, seed: 'sess-1', name: 'Keinora', arrivedAt: 1000 },
    ]);
    // Planet rows are consumed by the migration; beacons remain discoveries.
    expect(db.prepare("SELECT COUNT(*) AS n FROM discoveries WHERE kind = 'planet'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM discoveries WHERE kind = 'beacon'").get()).toEqual({ n: 1 });
    db.close();
  });

  it('enables WAL and foreign keys on file-backed databases', () => {
    const db = openDb(tempDbPath());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
    db.close();
  });

  it('treats :memory: specially with memory journal mode', () => {
    const db = openDb(':memory:');
    expect(['wal', 'memory']).toContain(db.pragma('journal_mode', { simple: true }));
    db.close();
  });
});
