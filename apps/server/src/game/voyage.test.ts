import { EventEmitter } from 'node:events';

import { nameFromSeed } from '@opencycle/shared';
import type { SessionDestination, SessionEvent, Workout } from '@opencycle/shared';
import { describe, expect, it } from 'vitest';

import type { RiderConfig } from '../session/engine.js';
import type { Db } from '../storage/db.js';
import { openDb } from '../storage/db.js';
import { attachVoyage, nextDestination, sessionDestination, type VoyageEngine } from './voyage.js';

/** Minimal engine fake: EventEmitter plus the session surface the voyage reads. */
class FakeEngine extends EventEmitter implements VoyageEngine {
  session: VoyageEngine['session'] = null;
}

function emit(engine: FakeEngine, event: SessionEvent): void {
  engine.emit('event', event);
}

function riderConfig(id: string, withWorkout = false): RiderConfig {
  return {
    profile: { id, name: id, ftpW: 250, weightKg: 75 },
    trainerId: `t-${id}`,
    workout: withWorkout ? workout(id) : undefined,
  };
}

function workout(id: string): Workout {
  return {
    id,
    name: id,
    description: '',
    tags: [],
    steps: [{ kind: 'steady', seconds: 60, targetPctFtp: 1 }],
  };
}

function insertVoyage(db: Db, riderId: string, voyageIndex: number): void {
  db.prepare(
    `INSERT INTO voyage_systems
      (id, rider_id, session_id, voyage_index, seed, name, workout_id, workout_name,
       surveys_total, surveys_clean, arrived_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    `${riderId}-${voyageIndex}`,
    riderId,
    `sess-${voyageIndex}`,
    voyageIndex,
    `${riderId}:voyage:${voyageIndex}`,
    nameFromSeed(`${riderId}:voyage:${voyageIndex}`),
    1000 + voyageIndex,
  );
}

interface VoyageRow {
  riderId: string;
  sessionId: string;
  voyageIndex: number;
  seed: string;
  name: string;
  workoutId: string | null;
  workoutName: string | null;
  surveysTotal: number | null;
  surveysClean: number | null;
  arrivedAt: number;
}

function voyageRows(db: Db): VoyageRow[] {
  return db
    .prepare(
      `SELECT rider_id AS riderId, session_id AS sessionId, voyage_index AS voyageIndex, seed, name,
              workout_id AS workoutId, workout_name AS workoutName,
              surveys_total AS surveysTotal, surveys_clean AS surveysClean, arrived_at AS arrivedAt
       FROM voyage_systems ORDER BY rider_id, voyage_index`,
    )
    .all() as VoyageRow[];
}

const DESTINATION = { seed: 'r1:voyage:0', name: 'Keinora', voyageIndex: 0, leadRiderId: 'r1' };

/** Two riders sharing the lead's destination: r1 has 3 objective legs, r2 one. */
function openSession(engine: FakeEngine, destination: SessionDestination | null, sessionId = 'sess-1'): void {
  engine.session = {
    id: sessionId,
    destination,
    riders: [
      {
        riderId: 'r1',
        workoutId: 'w1',
        workoutName: 'VO2max 4x4',
        legs: [{ objective: true }, { objective: false }, { objective: true }, { objective: true }],
      },
      { riderId: 'r2', workoutId: 'w2', workoutName: 'Endurance', legs: [{ objective: true }] },
    ],
  };
}

describe('nextDestination', () => {
  it('seeds the name from the rider and advances with each arrived system', () => {
    const db = openDb(':memory:');
    expect(nextDestination(db, 'r1')).toEqual({
      seed: 'r1:voyage:0',
      name: nameFromSeed('r1:voyage:0'),
      voyageIndex: 0,
    });

    insertVoyage(db, 'r1', 0);
    expect(nextDestination(db, 'r1')).toEqual({
      seed: 'r1:voyage:1',
      name: nameFromSeed('r1:voyage:1'),
      voyageIndex: 1,
    });

    // The count is per rider: r2 still starts their own voyage.
    expect(nextDestination(db, 'r2').voyageIndex).toBe(0);
    db.close();
  });
});

describe('sessionDestination', () => {
  it('flies the fleet to the first rider with a workout', () => {
    const db = openDb(':memory:');
    expect(sessionDestination(db, [riderConfig('r1'), riderConfig('r2', true)])).toEqual({
      seed: 'r2:voyage:0',
      name: nameFromSeed('r2:voyage:0'),
      voyageIndex: 0,
      leadRiderId: 'r2',
    });

    // The lead's own arrived-system count, not the session's.
    insertVoyage(db, 'r2', 0);
    expect(sessionDestination(db, [riderConfig('r1'), riderConfig('r2', true)])?.voyageIndex).toBe(1);
    db.close();
  });

  it('returns null when no rider has a workout', () => {
    const db = openDb(':memory:');
    expect(sessionDestination(db, [riderConfig('r1'), riderConfig('r2')])).toBeNull();
    expect(sessionDestination(db, [])).toBeNull();
    db.close();
  });
});

describe('attachVoyage', () => {
  it('logs one row per finisher with their own survey tally', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachVoyage(engine, db);
    openSession(engine, DESTINATION);

    emit(engine, {
      kind: 'legCompleted',
      riderId: 'r1',
      legIndex: 0,
      legKind: 'burn',
      objective: true,
      targetedS: 55,
      onTargetS: 50,
      clean: true,
      ts: 1000,
    });
    // A non-objective leg never counts toward the tally, however it is ridden.
    emit(engine, {
      kind: 'legCompleted',
      riderId: 'r1',
      legIndex: 1,
      legKind: 'coast',
      objective: false,
      targetedS: 30,
      onTargetS: 30,
      clean: false,
      ts: 1030,
    });
    emit(engine, {
      kind: 'legCompleted',
      riderId: 'r2',
      legIndex: 0,
      legKind: 'burn',
      objective: true,
      targetedS: 55,
      onTargetS: 55,
      clean: true,
      ts: 1000,
    });
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 5000 });
    emit(engine, { kind: 'workoutCompleted', riderId: 'r2', ts: 6000 });

    expect(voyageRows(db)).toEqual([
      {
        riderId: 'r1',
        sessionId: 'sess-1',
        voyageIndex: 0,
        seed: 'r1:voyage:0',
        name: 'Keinora',
        workoutId: 'w1',
        workoutName: 'VO2max 4x4',
        surveysTotal: 3,
        surveysClean: 1,
        arrivedAt: 5000,
      },
      {
        riderId: 'r2',
        sessionId: 'sess-1',
        voyageIndex: 0,
        seed: 'r1:voyage:0',
        name: 'Keinora', // every finisher logs the lead's system
        workoutId: 'w2',
        workoutName: 'Endurance',
        surveysTotal: 1,
        surveysClean: 1,
        arrivedAt: 6000,
      },
    ]);
    db.close();
  });

  it('ignores a replayed workoutCompleted and advances the next session', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachVoyage(engine, db);
    openSession(engine, DESTINATION);

    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 5000 });
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 5000 });
    expect(voyageRows(db).map((row) => row.voyageIndex)).toEqual([0]);

    // A later session's arrival takes the rider's next index.
    openSession(engine, { seed: 'r1:voyage:1', name: 'Velari', voyageIndex: 1, leadRiderId: 'r1' }, 'sess-2');
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 9000 });
    expect(voyageRows(db).map((row) => row.voyageIndex)).toEqual([0, 1]);
    db.close();
  });

  it('writes nothing without a destination and drops the tally when the session ends', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachVoyage(engine, db);
    openSession(engine, null);
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 5000 });
    expect(voyageRows(db)).toEqual([]);

    // No session at all: events are ignored outright.
    engine.session = null;
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 6000 });
    expect(voyageRows(db)).toEqual([]);

    // The tally belongs to the live session: ended clears it.
    openSession(engine, DESTINATION);
    emit(engine, {
      kind: 'legCompleted',
      riderId: 'r1',
      legIndex: 0,
      legKind: 'burn',
      objective: true,
      targetedS: 55,
      onTargetS: 55,
      clean: true,
      ts: 7000,
    });
    engine.emit('ended');
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 8000 });
    expect(voyageRows(db).map((row) => row.surveysClean)).toEqual([0]);
    db.close();
  });

  it('guards writes against a closed database (shutdown race)', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    const logged: string[] = [];
    attachVoyage(engine, db, (message) => logged.push(message));
    openSession(engine, DESTINATION);
    db.close();

    expect(() => emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 5000 })).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^voyage write failed:/);
  });
});
