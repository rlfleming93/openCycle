import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

export type Db = Database.Database;

/** One SQL script per migration; PRAGMA user_version tracks the applied count. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    rider_id TEXT
  );

  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE rides (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    rider_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    workout_id TEXT,
    workout_name TEXT,
    fit_path TEXT,
    summary TEXT
  );

  CREATE TABLE ride_samples (
    ride_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    power_w REAL,
    cadence_rpm REAL,
    hr_bpm INTEGER,
    speed_kmh REAL,
    distance_m REAL,
    target_w REAL,
    PRIMARY KEY (ride_id, ts)
  );

  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    rider_id TEXT,
    started_at INTEGER NOT NULL,
    duration_s INTEGER NOT NULL,
    sport TEXT,
    name TEXT,
    summary TEXT,
    power_1hz TEXT,
    hr_1hz TEXT
  );

  CREATE TABLE plan_assignments (
    id TEXT PRIMARY KEY,
    rider_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    start_date TEXT NOT NULL
  );

  CREATE INDEX idx_ride_samples_ride_id ON ride_samples (ride_id);
  CREATE INDEX idx_rides_rider_started ON rides (rider_id, started_at);
  CREATE INDEX idx_activities_rider_started ON activities (rider_id, started_at);
  `,
  // Migration 2: workouts table for imported .zwo workouts (source 'import')
  // and any library workouts persisted into the DB.
  `
  CREATE TABLE workouts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    source TEXT NOT NULL
  );
  `,
  // Migration 3: Garmin Connect upload tracking on finalized rides
  // (upload_status: pending|uploading|uploaded|failed, null = never queued).
  `
  ALTER TABLE rides ADD COLUMN upload_status TEXT;
  ALTER TABLE rides ADD COLUMN upload_error TEXT;
  `,
  // Migration 4: Phase 6 co-op game discoveries — 'planet' rows (one per
  // session, streak_s NULL) and 'beacon' rows (one per session+streak_s
  // crossing, so INSERT OR IGNORE is the idempotency key).
  `
  CREATE TABLE discoveries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    seed TEXT NOT NULL,
    name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    streak_s INTEGER,
    rider_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX idx_discoveries_session_kind_streak ON discoveries (session_id, kind, streak_s);
  `,
  // Migration 5: rescue rows escape the session-kind-streak unique index
  // (streak_s NULL; SQLite NULLs are distinct), so a replayed rescue event
  // could double-insert. The seed is a discovery's idempotency key — enforce
  // uniqueness on it (INSERT OR IGNORE in discoveries.ts becomes a true
  // no-op for an exact replay).
  `
  CREATE UNIQUE INDEX idx_discoveries_seed ON discoveries (seed);
  `,
  // Migration 6: the voyage. Systems become per-rider rows (a shared session
  // logs one row per finisher, each with their own survey counts and voyage
  // index), so the co-op 'planet' discoveries migrate into them — one row per
  // rider in rider_ids, sequenced by arrival — and the planet rows are gone.
  `
  CREATE TABLE voyage_systems (
    id TEXT PRIMARY KEY,
    rider_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    voyage_index INTEGER NOT NULL,
    seed TEXT NOT NULL,
    name TEXT NOT NULL,
    workout_id TEXT,
    workout_name TEXT,
    surveys_total INTEGER,
    surveys_clean INTEGER,
    arrived_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX idx_voyage_rider_session ON voyage_systems (rider_id, session_id);
  CREATE INDEX idx_voyage_rider_arrived ON voyage_systems (rider_id, arrived_at);

  INSERT INTO voyage_systems (id, rider_id, session_id, voyage_index, seed, name, workout_id, workout_name, surveys_total, surveys_clean, arrived_at)
    SELECT d.id || ':' || j.value, j.value, d.session_id,
           ROW_NUMBER() OVER (PARTITION BY j.value ORDER BY d.created_at, d.id) - 1,
           d.seed, d.name, NULL, NULL, NULL, NULL, d.created_at
    FROM discoveries d, json_each(d.rider_ids) j WHERE d.kind = 'planet';

  DELETE FROM discoveries WHERE kind = 'planet';
  `,
];

/** Opens (creating if needed) the openCycle SQLite database and migrates it to the latest schema. */
export function openDb(filePath?: string): Db {
  const path =
    filePath ?? resolve(process.env.OPENCYCLE_DATA_DIR ?? join(homedir(), '.opencycle'), 'opencycle.db');
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const applied = Number(db.pragma('user_version', { simple: true }));
  if (applied >= MIGRATIONS.length) return;
  db.transaction(() => {
    for (const script of MIGRATIONS.slice(applied)) {
      db.exec(script);
    }
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
}
