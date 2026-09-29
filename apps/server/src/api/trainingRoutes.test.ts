import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { fitnessFatigue } from '@opencycle/shared';
import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '../storage/db.js';
import { ApiError } from './routes.js';
import { registerTrainingRoutes } from './trainingRoutes.js';

/** Milliseconds at local noon `offsetDays` from today (noon avoids DST date edges). */
function dayMs(offsetDays: number): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, 12, 0, 0).getTime();
}

/** 'YYYY-MM-DD' in the local timezone, mirroring the route's date keys. */
function dateKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A rides.summary JSON matching the Recorder's RideSummary shape. */
function rideSummary(trainingLoad: number | null): Record<string, unknown> {
  return { durationS: 3600, distanceM: 25000, avgPowerW: 200, weightedPowerW: 205, avgHrBpm: 140, trainingLoad };
}

function seedRide(db: Db, id: string, riderId: string, startedAt: number, summary: unknown, workoutId?: string): void {
  db.prepare(
    `INSERT INTO rides (id, session_id, rider_id, started_at, ended_at, workout_id, summary)
     VALUES (?, 'seed-session', ?, ?, ?, ?, ?)`,
  ).run(id, riderId, startedAt, startedAt + 3600_000, workoutId ?? null, JSON.stringify(summary));
}

function seedActivity(
  db: Db,
  opts: { id: string; riderId: string | null; startedAt: number; summary: unknown; power1Hz?: number[] | null },
): void {
  const { id, riderId, startedAt, summary, power1Hz = null } = opts;
  db.prepare(
    `INSERT INTO activities (id, source, rider_id, started_at, duration_s, sport, name, summary, power_1hz)
     VALUES (?, 'garmin', ?, ?, 3600, 'cycling', ?, ?, ?)`,
  ).run(id, riderId, startedAt, id, JSON.stringify(summary), power1Hz === null ? null : JSON.stringify(power1Hz));
}

function seedSamples(db: Db, rideId: string, baseTs: number, powers: number[]): void {
  const insert = db.prepare('INSERT OR REPLACE INTO ride_samples (ride_id, ts, power_w) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    for (let i = 0; i < powers.length; i++) insert.run(rideId, baseTs + i, powers[i]);
  });
  tx();
}

/** Standalone app with registerTrainingRoutes; mirrors the ApiError mapping the lead wires in registerRoutes. */
async function buildWorld(): Promise<{ app: FastifyInstance; db: Db }> {
  const db = openDb(':memory:');
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status).send({ error: err.message });
      return;
    }
    reply.send(err);
  });
  registerTrainingRoutes(app, { db });
  await app.ready();
  return { app, db };
}

describe('GET /api/training/load', () => {
  it('sums daily loads, zero-fills the range to today, and mirrors shared fitnessFatigue', async () => {
    const { app, db } = await buildWorld();
    try {
      // Physiology is per-rider: the route requires a riderId.
      const missing = await app.inject({ method: 'GET', url: '/api/training/load' });
      expect(missing.statusCode).toBe(400);

      const profileId = 'p1';
      db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
        profileId,
        JSON.stringify({ id: profileId, name: 'P', ftpW: 250, weightKg: 75 }),
      );

      // Day -4: two rides -> 80 summed.
      seedRide(db, 'r1', profileId, dayMs(-4), rideSummary(50));
      seedRide(db, 'r2', profileId, dayMs(-4) + 60_000, rideSummary(30));
      // Day -3: activity with trainingLoad -> 20.
      seedActivity(db, { id: 'a1', riderId: profileId, startedAt: dayMs(-3), summary: { trainingLoad: 20 } });
      // Day -2: activity without trainingLoad but with weightedPowerW ->
      // derived at query time from the rider's CURRENT FTP (250): 1 h at
      // 200/250 = 0.8 intensity -> 0.64 * 100 = 64.
      seedActivity(db, {
        id: 'a2',
        riderId: profileId,
        startedAt: dayMs(-2),
        summary: { avgPowerW: 180, weightedPowerW: 200 },
        power1Hz: Array(1200).fill(200),
      });
      // Day -6: stream-less activity (no power, no weightedPowerW) is
      // excluded, so the range still starts at day -4.
      seedActivity(db, { id: 'a3', riderId: profileId, startedAt: dayMs(-6), summary: { avgPowerW: 0 } });
      // Day -1: ride finalized without a load datum is skipped.
      seedRide(db, 'r3', profileId, dayMs(-1), rideSummary(null));
      // Day -1: NULL-rider activity belongs to no rider's series.
      seedActivity(db, { id: 'a4', riderId: null, startedAt: dayMs(-1), summary: { trainingLoad: 99 } });

      const res = await app.inject({ method: 'GET', url: `/api/training/load?riderId=${profileId}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const expectedDays = [
        { date: dateKey(dayMs(-4)), load: 80 },
        { date: dateKey(dayMs(-3)), load: 20 },
        { date: dateKey(dayMs(-2)), load: 64 },
        { date: dateKey(dayMs(-1)), load: 0 },
        { date: dateKey(dayMs(0)), load: 0 },
      ];
      expect(body.days).toHaveLength(expectedDays.length);
      for (let i = 0; i < expectedDays.length; i++) {
        expect(body.days[i]!.date).toBe(expectedDays[i]!.date);
        expect(body.days[i]!.load).toBeCloseTo(expectedDays[i]!.load, 9);
      }
      expect(body.fitness).toHaveLength(5);
      const expected = fitnessFatigue(expectedDays.map((day) => day.load));
      for (let i = 0; i < expected.fitness.length; i++) {
        expect(body.fitness[i]).toBeCloseTo(expected.fitness[i]!, 9);
        expect(body.fatigue[i]).toBeCloseTo(expected.fatigue[i]!, 9);
        expect(body.form[i]).toBeCloseTo(expected.form[i]!, 9);
      }

      const ghost = await app.inject({ method: 'GET', url: '/api/training/load?riderId=ghost' });
      expect(ghost.statusCode).toBe(200);
      expect(ghost.json()).toEqual({ days: [], fitness: [], fatigue: [], form: [] });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('derives activity loads from the rider current FTP; FTP edits rewrite the historic curve', async () => {
    const { app, db } = await buildWorld();
    try {
      const profileId = 'p-load';
      db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
        profileId,
        JSON.stringify({ id: profileId, name: 'P', ftpW: 200, weightKg: 75 }),
      );
      // 1 h at weightedPowerW 200 with FTP 200 -> intensity 1.0 -> load 100.
      seedActivity(db, {
        id: 'a1',
        riderId: profileId,
        startedAt: dayMs(-2),
        summary: { weightedPowerW: 200 },
      });

      const res = await app.inject({ method: 'GET', url: `/api/training/load?riderId=${profileId}` });
      expect(res.statusCode).toBe(200);
      const day = res.json().days.find((d: { date: string }) => d.date === dateKey(dayMs(-2)));
      expect(day.load).toBeCloseTo(100, 9);

      // FTP edit (200 -> 250) changes the historic day's load: 0.8^2 * 100 = 64.
      db.prepare('UPDATE profiles SET data = ? WHERE id = ?').run(
        JSON.stringify({ id: profileId, name: 'P', ftpW: 250, weightKg: 75 }),
        profileId,
      );
      const res2 = await app.inject({ method: 'GET', url: `/api/training/load?riderId=${profileId}` });
      const day2 = res2.json().days.find((d: { date: string }) => d.date === dateKey(dayMs(-2)));
      expect(day2.load).toBeCloseTo(64, 9);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe('POST /api/profiles/:id/ftp-from-history', () => {
  it('estimates 0.95 x best 20-min power across activities and finalized rides', async () => {
    const { app, db } = await buildWorld();
    try {
      const profileId = 'p-ftp';
      db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
        profileId,
        JSON.stringify({ id: profileId, name: 'FTP', ftpW: 200, weightKg: 75 }),
      );

      // Activity: 20 min at 200 W; ride: 20 min at 250 W -> best 250 -> 238.
      seedActivity(db, {
        id: 'a1',
        riderId: profileId,
        startedAt: dayMs(-30),
        summary: { avgPowerW: 200 },
        power1Hz: Array(1200).fill(200),
      });
      seedRide(db, 'r1', profileId, dayMs(-10), rideSummary(60));
      seedSamples(db, 'r1', dayMs(-10), Array(1200).fill(250));

      const res = await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/ftp-from-history` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ftpW: 238 });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('returns null without qualifying power data and 404s for unknown profiles', async () => {
    const { app, db } = await buildWorld();
    try {
      const profileId = 'p-null';
      db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
        profileId,
        JSON.stringify({ id: profileId, name: 'NoPower', ftpW: 200, weightKg: 75 }),
      );

      // Only a 60 s activity: shorter than the 20-minute window -> no estimate.
      seedActivity(db, { id: 'a1', riderId: profileId, startedAt: dayMs(-1), summary: {}, power1Hz: Array(60).fill(200) });
      const none = await app.inject({ method: 'POST', url: `/api/profiles/${profileId}/ftp-from-history` });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ ftpW: null });

      // Older than the 6-month window -> no estimate.
      const oldProfile = 'p-old';
      db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
        oldProfile,
        JSON.stringify({ id: oldProfile, name: 'Old', ftpW: 200, weightKg: 75 }),
      );
      seedActivity(db, { id: 'a2', riderId: oldProfile, startedAt: dayMs(-220), summary: {}, power1Hz: Array(1200).fill(250) });
      const old = await app.inject({ method: 'POST', url: `/api/profiles/${oldProfile}/ftp-from-history` });
      expect(old.statusCode).toBe(200);
      expect(old.json()).toEqual({ ftpW: null });

      const missing = await app.inject({ method: 'POST', url: '/api/profiles/nope/ftp-from-history' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe('Unknown profile nope');
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe('GET /api/rides/:id/ftp-estimates', () => {
  it('returns rounded ramp and 20-minute FTP estimates only when applicable', async () => {
    const { app, db } = await buildWorld();
    try {
      // Ramp test workout: ramp applies. 1200 samples: twentyMin applies.
      seedRide(db, 'r1', 'p1', dayMs(-1), rideSummary(50), 'ftp-ramp-test');
      // 600 s at 200 W then 600 s at 250 W: best 60 s = 250 -> ramp 188;
      // whole-ride 20-min average = 225 -> twentyMin 214.
      seedSamples(db, 'r1', dayMs(-1), [...Array(600).fill(200), ...Array(600).fill(250)]);

      const res = await app.inject({ method: 'GET', url: '/api/rides/r1/ftp-estimates' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ramp: 188, twentyMin: 214 });

      // A non-ramp workout never yields a ramp estimate, however long.
      seedRide(db, 'r2', 'p1', dayMs(-1), rideSummary(50), 'tempo-2x20');
      seedSamples(db, 'r2', dayMs(-1), Array(1200).fill(200));
      const plain = await app.inject({ method: 'GET', url: '/api/rides/r2/ftp-estimates' });
      expect(plain.statusCode).toBe(200);
      expect(plain.json()).toEqual({ ramp: null, twentyMin: 190 });

      // Short rides cannot produce a 20-minute estimate.
      seedRide(db, 'r3', 'p1', dayMs(-1), rideSummary(50), 'ftp-ramp-test');
      seedSamples(db, 'r3', dayMs(-1), Array(600).fill(200));
      const short = await app.inject({ method: 'GET', url: '/api/rides/r3/ftp-estimates' });
      expect(short.statusCode).toBe(200);
      expect(short.json()).toEqual({ ramp: 150, twentyMin: null });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('404s for unknown rides and returns nulls for a ride with no samples', async () => {
    const { app, db } = await buildWorld();
    try {
      const missing = await app.inject({ method: 'GET', url: '/api/rides/nope/ftp-estimates' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe('Unknown ride nope');

      seedRide(db, 'r1', 'p1', dayMs(-1), rideSummary(50));
      const empty = await app.inject({ method: 'GET', url: '/api/rides/r1/ftp-estimates' });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ ramp: null, twentyMin: null });
    } finally {
      await app.close();
      db.close();
    }
  });
});
