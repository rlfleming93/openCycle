import { nameFromSeed, voyageSeed } from '@opencycle/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../storage/db.js';
import { openDb } from '../storage/db.js';
import { ApiError } from './routes.js';
import { registerVoyageRoutes } from './voyageRoutes.js';

interface TestWorld {
  app: FastifyInstance;
  db: Db;
}

const worlds: TestWorld[] = [];

afterEach(async () => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    if (world === undefined) continue;
    await world.app.close().catch(() => {});
    world.db.close();
  }
});

async function buildWorld(): Promise<TestWorld> {
  const db = openDb(':memory:');
  const app = Fastify({ logger: false });
  // registerRoutes installs this handler in production; mirror it here so
  // error bodies match the real API contract.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status).send({ error: err.message });
      return;
    }
    reply.send(err);
  });
  registerVoyageRoutes(app, { db });
  await app.ready();
  const world: TestWorld = { app, db };
  worlds.push(world);
  return world;
}

function insertProfile(db: Db, id: string): void {
  db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, name: `Rider ${id}`, ftpW: 250, weightKg: 75 }),
  );
}

interface VoyageInsert {
  id: string;
  riderId: string;
  sessionId: string;
  voyageIndex: number;
  workoutId: string | null;
  workoutName: string | null;
  surveysTotal: number | null;
  surveysClean: number | null;
  arrivedAt: number;
}

function insertVoyage(db: Db, row: VoyageInsert): void {
  const seed = voyageSeed(row.riderId, row.voyageIndex);
  db.prepare(
    `INSERT INTO voyage_systems
      (id, rider_id, session_id, voyage_index, seed, name, workout_id, workout_name,
       surveys_total, surveys_clean, arrived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.riderId,
    row.sessionId,
    row.voyageIndex,
    seed,
    nameFromSeed(seed),
    row.workoutId,
    row.workoutName,
    row.surveysTotal,
    row.surveysClean,
    row.arrivedAt,
  );
}

describe('GET /api/voyage', () => {
  it('400s without a riderId', async () => {
    const world = await buildWorld();
    const res = await world.app.inject({ method: 'GET', url: '/api/voyage' });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().error)).toMatch(/riderId/);
  });

  it('404s for an unknown profile', async () => {
    const world = await buildWorld();
    const res = await world.app.inject({ method: 'GET', url: '/api/voyage?riderId=ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Unknown profile ghost' });
  });

  it('returns the rider voyage oldest first plus their next destination', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'r1');
    // Inserted out of order: the response sorts by arrival.
    insertVoyage(world.db, {
      id: 'v2',
      riderId: 'r1',
      sessionId: 's2',
      voyageIndex: 1,
      workoutId: 'w2',
      workoutName: 'Endurance',
      surveysTotal: 2,
      surveysClean: 2,
      arrivedAt: 2000,
    });
    insertVoyage(world.db, {
      id: 'v1',
      riderId: 'r1',
      sessionId: 's1',
      voyageIndex: 0,
      workoutId: 'w1',
      workoutName: 'VO2max 4x4',
      surveysTotal: 4,
      surveysClean: 3,
      arrivedAt: 1000,
    });
    // Another rider's systems never leak in.
    insertVoyage(world.db, {
      id: 'v3',
      riderId: 'r2',
      sessionId: 's1',
      voyageIndex: 0,
      workoutId: null,
      workoutName: null,
      surveysTotal: null,
      surveysClean: null,
      arrivedAt: 500,
    });

    const res = await world.app.inject({ method: 'GET', url: '/api/voyage?riderId=r1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      riderId: 'r1',
      systems: [
        {
          id: 'v1',
          sessionId: 's1',
          voyageIndex: 0,
          seed: voyageSeed('r1', 0),
          name: nameFromSeed(voyageSeed('r1', 0)),
          workoutId: 'w1',
          workoutName: 'VO2max 4x4',
          surveysTotal: 4,
          surveysClean: 3,
          arrivedAt: 1000,
        },
        {
          id: 'v2',
          sessionId: 's2',
          voyageIndex: 1,
          seed: voyageSeed('r1', 1),
          name: nameFromSeed(voyageSeed('r1', 1)),
          workoutId: 'w2',
          workoutName: 'Endurance',
          surveysTotal: 2,
          surveysClean: 2,
          arrivedAt: 2000,
        },
      ],
      next: {
        voyageIndex: 2,
        seed: voyageSeed('r1', 2),
        name: nameFromSeed(voyageSeed('r1', 2)),
      },
    });
  });

  it('returns an empty voyage pointing at the first destination for a new rider', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'r1');
    const res = await world.app.inject({ method: 'GET', url: '/api/voyage?riderId=r1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      riderId: 'r1',
      systems: [],
      next: { voyageIndex: 0, seed: voyageSeed('r1', 0), name: nameFromSeed(voyageSeed('r1', 0)) },
    });
  });
});
