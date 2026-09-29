import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { openDb } from '../storage/db.js';
import type { Db } from '../storage/db.js';
import { registerPlansRoutes } from './plansRoutes.js';
import { ApiError, WorkoutLibrary } from './routes.js';

// Real shipped data: exercises parsing of every curated workout and template
// JSON that ships with the repo (the same files `pnpm workout:validate` gates).
const REAL_PLANS_DIR = fileURLToPath(new URL('../../../../data/plans/', import.meta.url));

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
  const workoutLibrary = new WorkoutLibrary(db, REAL_PLANS_DIR);
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
  registerPlansRoutes(app, { db, workoutLibrary });
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

interface CalendarDay {
  date: string;
  workoutId: string;
  workoutName: string;
}

interface Assignment {
  id: string;
  riderId: string;
  templateId: string;
  startDate: string;
  calendar: CalendarDay[];
}

async function assign(world: TestWorld, body: Record<string, unknown>): Promise<Assignment> {
  const res = await world.app.inject({ method: 'POST', url: '/api/plans/assign', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('plan templates', () => {
  it('serves the shipped template library', async () => {
    const world = await buildWorld();
    const res = await world.app.inject({ method: 'GET', url: '/api/plans' });
    expect(res.statusCode).toBe(200);
    const templates = res.json() as Array<{
      id: string;
      name: string;
      description: string;
      weeks: Array<{ days: Array<{ dow: number; workoutId: string }> }>;
    }>;
    const ids = templates.map((template) => template.id).sort();
    expect(ids).toEqual(['base-build-8w', 'vo2-block-6w']);
    for (const template of templates) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.weeks.length).toBeGreaterThan(0);
      for (const week of template.weeks) {
        expect(week.days.length).toBeGreaterThan(0);
        for (const day of week.days) {
          expect(day.dow).toBeGreaterThanOrEqual(0);
          expect(day.dow).toBeLessThanOrEqual(6);
          expect(day.workoutId.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('plan assignments', () => {
  it('assigns a plan and renders its calendar from startDate (dow 0 = Monday)', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'r1');
    const assignment = await assign(world, {
      riderId: 'r1',
      templateId: 'base-build-8w',
      startDate: '2026-01-05',
    });

    expect(assignment.id.length).toBeGreaterThan(0);
    expect(assignment.riderId).toBe('r1');
    expect(assignment.templateId).toBe('base-build-8w');
    expect(assignment.startDate).toBe('2026-01-05');

    const res = await world.app.inject({ method: 'GET', url: '/api/plans/assignments?riderId=r1' });
    expect(res.statusCode).toBe(200);
    const assignments = res.json() as Assignment[];
    expect(assignments).toHaveLength(1);
    const calendar = assignments[0]?.calendar ?? [];
    expect(calendar).toHaveLength(24);

    // Week 1: Mon endurance, Wed tempo, Sat endurance.
    expect(calendar[0]).toEqual({
      date: '2026-01-05',
      workoutId: 'endurance-z2-60',
      workoutName: 'Endurance Z2 60 min',
    });
    expect(calendar[1]).toEqual({
      date: '2026-01-07',
      workoutId: 'tempo-2x20',
      workoutName: 'Tempo 2x20',
    });
    expect(calendar[2]).toEqual({
      date: '2026-01-10',
      workoutId: 'endurance-z2-60',
      workoutName: 'Endurance Z2 60 min',
    });
    // Recovery week 4 keeps the rhythm (Mon, Wed, Sat) with recovery-45.
    expect(calendar[9]).toEqual({ date: '2026-01-26', workoutId: 'endurance-z2-60', workoutName: 'Endurance Z2 60 min' });
    expect(calendar[10]).toEqual({ date: '2026-01-28', workoutId: 'recovery-45', workoutName: 'Recovery 45' });
    // Week 8 ends on Saturday 2026-02-28 (start + 7*7 + 5 days).
    expect(calendar[23]).toEqual({
      date: '2026-02-28',
      workoutId: 'endurance-z2-180',
      workoutName: 'Endurance Z2 180 min',
    });
    // Every workoutName resolved from the shipped library (never the raw id).
    expect(calendar.every((day) => day.workoutName !== day.workoutId)).toBe(true);
  });

  it('renders a vo2max block calendar including its two-ride recovery week', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'r1');
    await assign(world, {
      riderId: 'r1',
      templateId: 'vo2-block-6w',
      startDate: '2026-03-02',
    });
    const res = await world.app.inject({ method: 'GET', url: '/api/plans/assignments?riderId=r1' });
    const calendar = (res.json() as Assignment[])[0]?.calendar ?? [];
    expect(calendar).toHaveLength(17);
    expect(calendar[0]).toEqual({
      date: '2026-03-03',
      workoutId: 'vo2max-5x3',
      workoutName: 'VO2max 5x3',
    });
    // Recovery week 4: Tuesday quality ride + Saturday endurance only —
    // no Thursday ride between week 3's Saturday and week 4's Tuesday.
    expect(calendar[11]).toEqual({
      date: '2026-03-31',
      workoutId: 'vo2max-4x4',
      workoutName: 'VO2max 4x4',
    });
    expect(calendar[16]).toEqual({
      date: '2026-04-11',
      workoutId: 'endurance-z2-120',
      workoutName: 'Endurance Z2 120 min',
    });
  });

  it('rejects assignments for unknown riders and templates', async () => {
    const world = await buildWorld();
    const noRider = await world.app.inject({
      method: 'POST',
      url: '/api/plans/assign',
      payload: { riderId: 'ghost', templateId: 'base-build-8w', startDate: '2026-01-05' },
    });
    expect(noRider.statusCode).toBe(404);
    expect(noRider.json()).toEqual({ error: 'Unknown profile ghost' });

    insertProfile(world.db, 'r1');
    const noTemplate = await world.app.inject({
      method: 'POST',
      url: '/api/plans/assign',
      payload: { riderId: 'r1', templateId: 'ghost', startDate: '2026-01-05' },
    });
    expect(noTemplate.statusCode).toBe(404);
    expect(noTemplate.json()).toEqual({ error: 'Unknown plan template ghost' });
  });

  it('rejects malformed start dates', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'r1');
    for (const startDate of ['2026-02-31', '2026-13-01', 'not-a-date']) {
      const res = await world.app.inject({
        method: 'POST',
        url: '/api/plans/assign',
        payload: { riderId: 'r1', templateId: 'base-build-8w', startDate },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('filters assignments by rider and lists all when no rider is given', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'r1');
    insertProfile(world.db, 'r2');
    const first = await assign(world, {
      riderId: 'r1',
      templateId: 'base-build-8w',
      startDate: '2026-01-05',
    });
    const second = await assign(world, {
      riderId: 'r2',
      templateId: 'vo2-block-6w',
      startDate: '2026-03-02',
    });

    const forRider = await world.app.inject({ method: 'GET', url: '/api/plans/assignments?riderId=r2' });
    const forRiderBody = forRider.json() as Assignment[];
    expect(forRiderBody).toHaveLength(1);
    expect(forRiderBody[0]?.id).toBe(second.id);
    expect(forRiderBody[0]?.calendar.length ?? 0).toBeGreaterThan(0);

    const all = await world.app.inject({ method: 'GET', url: '/api/plans/assignments' });
    const allBody = all.json() as Assignment[];
    expect(allBody.map((a) => a.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('deletes an assignment and 404s on repeat deletes', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'r1');
    const assignment = await assign(world, {
      riderId: 'r1',
      templateId: 'base-build-8w',
      startDate: '2026-01-05',
    });

    const del = await world.app.inject({ method: 'DELETE', url: `/api/plans/assignments/${assignment.id}` });
    expect(del.statusCode).toBe(204);

    const list = await world.app.inject({ method: 'GET', url: '/api/plans/assignments' });
    expect(list.json()).toEqual([]);

    const again = await world.app.inject({ method: 'DELETE', url: `/api/plans/assignments/${assignment.id}` });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: `Unknown plan assignment ${assignment.id}` });
  });
});
