import { randomUUID } from 'node:crypto';

import { nameFromSeed, type SessionEvent } from '@opencycle/shared';

import type { Db } from '../storage/db.js';

/**
 * The engine surface discoveries needs: engine events plus the active
 * session's id (the namespace for seeded names). Structural so tests inject
 * a plain EventEmitter fake; the real SessionEngine satisfies it.
 */
export interface DiscoveryEngine {
  /** Active session (null once a session ends); its id seeds discovery names. */
  session: { id: string } | null;
  on(event: 'event', listener: (event: SessionEvent) => void): unknown;
}

/** Beacon streak thresholds: 30, 90, 180, then every 300 s (300, 600, 900…). */
const BEACON_FIRST_THRESHOLDS = [30, 90, 180] as const;
const BEACON_PERIOD_S = 300;

const BEACON_KIND = 'beacon' as const;
const RESCUE_KIND = 'rescue' as const;

/** Whether a cumulative bothInZone streak seconds value crosses a beacon threshold. */
export function isBeaconStreak(streakS: number): boolean {
  if (BEACON_FIRST_THRESHOLDS.includes(streakS as (typeof BEACON_FIRST_THRESHOLDS)[number])) return true;
  return streakS >= BEACON_PERIOD_S && streakS % BEACON_PERIOD_S === 0;
}

/**
 * Materializes co-op game discoveries from engine events:
 * - bothInZone crossing a beacon threshold → 'beacon' row (idempotent via the
 *   unique (session_id, kind, streak_s) index, seed `${sessionId}:${streakS}`).
 * - rescue → one 'rescue' row (seed `${sessionId}:rescue:${helperId}:${riderId}:${ts}`),
 *   rider_ids `[helperId, riderId]`; replay of the same event is a no-op.
 * Voyage systems are logged separately (game/voyage.ts); workoutCompleted
 * writes nothing here.
 * Stays subscribed for the process lifetime — sessions come and go — so the
 * DB-closed guard on writes (same shape as the Garmin upload queue) keeps a
 * shutdown race a log line, never an unhandled rejection.
 */
export function attachDiscoveries(
  engine: DiscoveryEngine,
  db: Db,
  log: (message: string) => void = () => {},
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO discoveries
      (id, kind, seed, name, session_id, streak_s, rider_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const findBySeed = db.prepare('SELECT id FROM discoveries WHERE seed = ?');

  engine.on('event', (event) => {
    const sessionId = engine.session?.id;
    if (sessionId === undefined) return; // events fire mid-session; be safe anyway
    if (event.kind === 'bothInZone' && isBeaconStreak(event.streakS)) {
      const seed = `${sessionId}:${event.streakS}`;
      writeDb(db, log, () => {
        insert.run(
          randomUUID(),
          BEACON_KIND,
          seed,
          nameFromSeed(seed),
          sessionId,
          event.streakS,
          '[]',
          Date.now(),
        );
      });
      return;
    }
    if (event.kind === 'rescue') {
      const seed = `${sessionId}:rescue:${event.helperId}:${event.riderId}:${event.ts}`;
      writeDb(db, log, () => {
        if (findBySeed.get(seed) !== undefined) return;
        insert.run(
          randomUUID(),
          RESCUE_KIND,
          seed,
          nameFromSeed(seed),
          sessionId,
          null,
          JSON.stringify([event.helperId, event.riderId]),
          Date.now(),
        );
      });
    }
  });
}

/** Guarded write: a closed DB during shutdown surfaces as a log line, never a throw. */
function writeDb(db: Db, log: (message: string) => void, write: () => void): void {
  try {
    write();
  } catch (err) {
    log(`discovery write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
