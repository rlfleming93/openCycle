import { randomUUID } from 'node:crypto';

import { nameFromSeed, voyageSeed } from '@opencycle/shared';
import type { SessionDestination, SessionEvent } from '@opencycle/shared';

import type { RiderConfig } from '../session/engine.js';
import type { Db } from '../storage/db.js';

/**
 * The engine surface the voyage needs: the active session snapshot (destination
 * plus per-rider legs/workout) and its events. Structural so tests inject a
 * plain EventEmitter fake; the real SessionEngine satisfies it.
 */
export interface VoyageEngine {
  /** Active session (null once a session ends). */
  session: {
    id: string;
    destination: SessionDestination | null;
    riders: Array<{
      riderId: string;
      workoutId?: string;
      workoutName?: string;
      legs: Array<{ objective: boolean }> | null;
    }>;
  } | null;
  on(event: 'event', listener: (event: SessionEvent) => void): unknown;
  on(event: 'ended', listener: () => void): unknown;
}

/** Where a rider's voyage goes next: their arrived-system count seeds the name. */
export function nextDestination(db: Db, riderId: string): { seed: string; name: string; voyageIndex: number } {
  const row = db.prepare('SELECT COUNT(*) AS n FROM voyage_systems WHERE rider_id = ?').get(riderId) as {
    n: number;
  };
  const voyageIndex = row.n;
  const seed = voyageSeed(riderId, voyageIndex);
  return { seed, name: nameFromSeed(seed), voyageIndex };
}

/**
 * The system a session flies to: the first rider with a workout leads the
 * fleet to their next destination; free-only sessions have none.
 */
export function sessionDestination(db: Db, configs: RiderConfig[]): SessionDestination | null {
  const lead = configs.find((cfg) => cfg.workout !== undefined);
  if (lead === undefined) return null;
  return { ...nextDestination(db, lead.profile.id), leadRiderId: lead.profile.id };
}

/**
 * Persists the voyage: every finisher of a session with a destination logs one
 * voyage_systems row — the lead's system, their own survey counts and their
 * own voyage index (the count of systems already arrived at). Clean objective
 * legs are tallied from `legCompleted` events because a rider's snapshot
 * counters reset when they stop; the tally is dropped when the session ends.
 * Stays subscribed for the process lifetime — sessions come and go — and the
 * DB-closed guard on writes keeps a shutdown race a log line, never a throw.
 */
export function attachVoyage(engine: VoyageEngine, db: Db, log: (message: string) => void = () => {}): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO voyage_systems
      (id, rider_id, session_id, voyage_index, seed, name, workout_id, workout_name,
       surveys_total, surveys_clean, arrived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const countForRider = db.prepare('SELECT COUNT(*) AS n FROM voyage_systems WHERE rider_id = ?');
  /** Clean objective-leg tally per `${sessionId}:${riderId}`. */
  const cleanTally = new Map<string, number>();

  engine.on('event', (event) => {
    const session = engine.session;
    if (session === null) return; // events fire mid-session; be safe anyway
    if (event.kind === 'legCompleted') {
      if (!event.objective || !event.clean) return;
      const key = `${session.id}:${event.riderId}`;
      cleanTally.set(key, (cleanTally.get(key) ?? 0) + 1);
      return;
    }
    if (event.kind !== 'workoutCompleted') return;
    const destination = session.destination;
    if (destination === null) return; // free ride: the voyage does not advance
    const rider = session.riders.find((r) => r.riderId === event.riderId);
    if (rider === undefined) return;
    const surveysTotal = rider.legs?.filter((leg) => leg.objective).length ?? 0;
    const surveysClean = cleanTally.get(`${session.id}:${event.riderId}`) ?? 0;
    writeDb(log, () => {
      const arrived = (countForRider.get(rider.riderId) as { n: number } | undefined)?.n ?? 0;
      insert.run(
        randomUUID(),
        rider.riderId,
        session.id,
        arrived,
        destination.seed,
        destination.name,
        rider.workoutId ?? null,
        rider.workoutName ?? null,
        surveysTotal,
        surveysClean,
        event.ts,
      );
    });
  });
  engine.on('ended', () => cleanTally.clear());
}

/** Guarded write: a closed DB during shutdown surfaces as a log line, never a throw. */
function writeDb(log: (message: string) => void, write: () => void): void {
  try {
    write();
  } catch (err) {
    log(`voyage write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
