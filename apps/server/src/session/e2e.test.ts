// Phase 3 gate (kept as regression): a full 2×2 sim session end-to-end —
// real sim drivers, real engine, real recorder, real SQLite — must produce
// diverging per-rider ERG targets, recorded samples, two valid FIT files and
// a workoutCompleted event per rider. Integration test on real (compressed)
// timers: engine and sim drivers both run their own setInterval loops, and the
// completion condition is awaited via engine events, never a guessed sleep.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Decoder, Stream } from '@garmin/fitsdk';
import type { RiderProfile, SessionEvent, Workout } from '@opencycle/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createSimDevices } from '../devices/sim/index.js';
import { openDb } from '../storage/db.js';
import { SessionEngine } from './engine.js';
import { Recorder } from './recorder.js';

// The engine's workout clock advances tickMs/1000 REAL seconds per tick, so a
// fast tick does not compress the workout: keep steps short (1 s each) and
// tick at 100 ms for a dense sample stream.
const TICK_MS = 100;

function profile(id: string, name: string, ftpW: number): RiderProfile {
  return { id, name, ftpW, weightKg: 75 };
}

function steadyWorkout(id: string, pct1: number, pct2: number): Workout {
  return {
    id,
    name: id,
    description: '',
    tags: [],
    steps: [
      { kind: 'steady', seconds: 1, targetPctFtp: pct1 },
      { kind: 'steady', seconds: 1, targetPctFtp: pct2 },
    ],
  };
}

/** Resolves once `workoutCompleted` has fired for every given rider. */
function allWorkoutsCompleted(engine: SessionEngine, riderIds: string[]): Promise<void> {
  const pending = new Set(riderIds);
  return new Promise((resolve) => {
    // Executor form: lib ES2022 has no Promise.withResolvers typings.
    const onEvent = (e: SessionEvent): void => {
      if (e.kind !== 'workoutCompleted') return;
      pending.delete(e.riderId);
      if (pending.size === 0) {
        engine.off('event', onEvent);
        resolve();
      }
    };
    engine.on('event', onEvent);
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('sim e2e (Phase 3 gate)', () => {
  it('runs a 2-rider sim session: diverging targets, recorded samples, 2 valid FITs, workoutCompleted per rider', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'opencycle-e2e-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const db = openDb(':memory:');
    cleanups.push(() => db.close());

    const sim = createSimDevices('2x2', { tickMs: TICK_MS, seed: 42 });
    const drivers = [...sim.trainers, ...sim.hrms];
    await Promise.all(drivers.map((d) => d.connect()));
    cleanups.push(() => void Promise.allSettled(drivers.map((d) => d.disconnect())));

    const recorder = new Recorder(db, dataDir, { flushIntervalMs: 0 });
    const engine = new SessionEngine({
      findDriver: (id) => drivers.find((d) => d.id === id),
      recorder,
      tickMs: TICK_MS,
    });

    const events: SessionEvent[] = [];
    engine.on('event', (e) => events.push(e));
    const targets = new Map<string, Set<number>>();
    sim.trainers.forEach((t, i) => {
      const seen = new Set<number>();
      targets.set(`r${i + 1}`, seen);
      const original = t.setTargetPower.bind(t);
      t.setTargetPower = async (w: number) => {
        seen.add(w);
        await original(w);
      };
    });

    const completedSignal = allWorkoutsCompleted(engine, ['r1', 'r2']);
    await engine.startSession([
      {
        profile: profile('r1', 'Rider One', 200),
        trainerId: 'sim:trainer:1',
        hrmId: 'sim:hrm:1',
        workout: steadyWorkout('w1', 0.5, 1.0),
      },
      {
        profile: profile('r2', 'Rider Two', 250),
        trainerId: 'sim:trainer:2',
        hrmId: 'sim:hrm:2',
        workout: steadyWorkout('w2', 0.8, 0.6),
      },
    ]);

    await completedSignal;
    await engine.stopSession();

    // Diverging ERG targets, exact watts per rider/step; the 50 % FTP floor
    // is pushed once after each workout completes (r1's floor 100 already in
    // its set, r2's 125 is new).
    expect(targets.get('r1')).toEqual(new Set([100, 200]));
    expect(targets.get('r2')).toEqual(new Set([200, 150, 125]));

    // workoutCompleted exactly once per rider.
    const completed = events.filter((e) => e.kind === 'workoutCompleted').map((e) => e.riderId);
    expect(completed.sort()).toEqual(['r1', 'r2']);

    // Samples recorded for both riders.
    const rides = db
      .prepare('SELECT id, rider_id, session_id, fit_path FROM rides ORDER BY rider_id')
      .all() as Array<{ id: string; rider_id: string; session_id: string; fit_path: string | null }>;
    expect(rides.map((r) => r.rider_id)).toEqual(['r1', 'r2']);
    const sampleCountStmt = db.prepare('SELECT COUNT(*) AS n FROM ride_samples WHERE ride_id = ?');
    for (const ride of rides) {
      const row = sampleCountStmt.get(ride.id) as { n: number };
      expect(row.n).toBeGreaterThanOrEqual(10); // ~2 s workout at 10 ticks/s
    }

    // Session lifecycle: one sessions row, started and ended; every ride joins it.
    const sessionRows = db
      .prepare('SELECT id, started_at, ended_at FROM sessions')
      .all() as Array<{ id: string; started_at: number; ended_at: number | null }>;
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]!.ended_at).not.toBeNull();
    expect(sessionRows[0]!.ended_at!).toBeGreaterThanOrEqual(sessionRows[0]!.started_at);
    for (const ride of rides) {
      expect(ride.session_id).toBe(sessionRows[0]!.id);
    }

    // Two FIT files, both structurally valid with matching record counts.
    for (const ride of rides) {
      expect(ride.fit_path).toBeTruthy();
      const stream = Stream.fromBuffer(readFileSync(ride.fit_path!));
      const decoder = new Decoder(stream);
      expect(decoder.checkIntegrity()).toBe(true);
      const { messages, errors } = decoder.read();
      expect(errors).toEqual([]);
      const row = sampleCountStmt.get(ride.id) as { n: number };
      expect(messages.recordMesgs).toHaveLength(row.n);
      expect(messages.sessionMesgs).toHaveLength(1);
      expect(messages.sessionMesgs![0]!.sport).toBe('cycling');
    }
  }, 20_000);
});
