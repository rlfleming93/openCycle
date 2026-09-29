import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  parseZwo,
  RiderProfileSchema,
  RiderStartSchema,
  WorkoutSchema,
  ZwoParseError,
  type RiderProfile,
  type RiderStart,
  type Workout,
} from '@opencycle/shared';

import { HrmDriver, TrainerDriver } from '../devices/driver.js';
import type { DeviceHub } from '../devices/hub.js';
import type { DeviceRegistry } from '../devices/registry.js';
import { sessionDestination } from '../game/voyage.js';
import type { SessionEngine, RiderConfig } from '../session/engine.js';
import type { Recorder } from '../session/recorder.js';
import type { Db } from '../storage/db.js';

export interface ApiContext {
  db: Db;
  registry: DeviceRegistry;
  engine: SessionEngine;
  recorder: Recorder;
  hub: DeviceHub;
  workoutLibrary: WorkoutLibrary;
}

/** Error carrying an HTTP status; mapped to `{error}` bodies by registerRoutes. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type WorkoutSource = 'library' | 'import';

export interface WorkoutListItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: WorkoutSource;
}

interface LibraryEntry {
  workout: Workout;
  source: WorkoutSource;
}

interface WorkoutRow {
  id: string;
  data: string;
  source: string;
}

/** In-memory workout catalog: curated data/plans/*.json files plus DB-persisted .zwo imports. */
export class WorkoutLibrary {
  private readonly entries = new Map<string, LibraryEntry>();

  constructor(
    private readonly db: Db,
    plansDir: string,
    private readonly log?: (message: string) => void,
  ) {
    this.loadPlans(plansDir);
    this.loadImported();
  }

  list(): WorkoutListItem[] {
    return [...this.entries.values()]
      .map(({ workout, source }) => ({
        id: workout.id,
        name: workout.name,
        description: workout.description,
        tags: workout.tags,
        source,
      }))
      .sort((a, b) =>
        a.source === b.source ? a.name.localeCompare(b.name) : a.source.localeCompare(b.source),
      );
  }

  get(id: string): Workout | undefined {
    return this.entries.get(id)?.workout;
  }

  /** Validates, persists, and indexes a parsed workout; re-imports replace by id. */
  addImported(workout: Workout): WorkoutListItem {
    this.db
      .prepare('INSERT OR REPLACE INTO workouts (id, data, source) VALUES (?, ?, ?)')
      .run(workout.id, JSON.stringify(workout), 'import');
    this.entries.set(workout.id, { workout, source: 'import' });
    return {
      id: workout.id,
      name: workout.name,
      description: workout.description,
      tags: workout.tags,
      source: 'import',
    };
  }

  private loadPlans(plansDir: string): void {
    let files: string[] = [];
    try {
      files = readdirSync(plansDir).filter((file) => file.endsWith('.json'));
    } catch {
      this.log?.('No workout plans directory; skipping library load');
      return;
    }
    for (const file of files) {
      try {
        const workout = WorkoutSchema.parse(JSON.parse(readFileSync(join(plansDir, file), 'utf8')));
        this.entries.set(workout.id, { workout, source: 'library' });
      } catch (err) {
        this.log?.(`Skipping invalid workout plan ${file}: ${errorMessage(err)}`);
      }
    }
  }

  private loadImported(): void {
    const rows = this.db.prepare('SELECT id, data, source FROM workouts').all() as WorkoutRow[];
    for (const row of rows) {
      try {
        const workout = WorkoutSchema.parse(JSON.parse(row.data));
        this.entries.set(workout.id, { workout, source: row.source === 'import' ? 'import' : 'library' });
      } catch (err) {
        this.log?.(`Skipping invalid workout row ${row.id}: ${errorMessage(err)}`);
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ProfileInputSchema = RiderProfileSchema.omit({ id: true });
const IdParamSchema = z.object({ id: z.string().min(1) });
const AssignBodySchema = z.object({ riderId: z.string().min(1).nullable() });
const ImportBodySchema = z.object({ xml: z.string().min(1) });
const StartSessionBodySchema = z.object({ riders: z.array(RiderStartSchema).min(1) });
const RidesQuerySchema = z.object({ riderId: z.string().min(1).optional() });

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue === undefined ? 'Invalid request' : `${issue.path.join('.')}: ${issue.message}`;
    throw new ApiError(400, detail);
  }
  return parsed.data;
}

/** Every REST route under /api; bodies and params are zod-validated. */
export function registerRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status).send({ error: err.message });
      return;
    }
    reply.send(err);
  });
  registerProfileRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerWorkoutRoutes(app, ctx);
  registerRideRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
}

function registerProfileRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/profiles', async () => listProfiles(ctx.db));

  app.post('/api/profiles', async (req, reply) => {
    const input = parseOr400(ProfileInputSchema, req.body);
    const profile: RiderProfile = { ...input, id: randomUUID() };
    ctx.db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(profile.id, JSON.stringify(profile));
    reply.code(201).send(profile);
  });

  app.put('/api/profiles/:id', async (req, reply) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    const input = parseOr400(ProfileInputSchema, req.body);
    const existing = ctx.db.prepare('SELECT id FROM profiles WHERE id = ?').get(id);
    if (existing === undefined) throw new ApiError(404, `Unknown profile ${id}`);
    const profile: RiderProfile = { ...input, id };
    ctx.db.prepare('UPDATE profiles SET data = ? WHERE id = ?').run(JSON.stringify(profile), id);
    reply.send(profile);
  });

  app.delete('/api/profiles/:id', async (req, reply) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    const result = ctx.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    if (result.changes === 0) throw new ApiError(404, `Unknown profile ${id}`);
    reply.code(204).send();
  });
}

function listProfiles(db: Db): RiderProfile[] {
  const rows = db.prepare('SELECT data FROM profiles').all() as Array<{ data: string }>;
  return rows.map((row) => RiderProfileSchema.parse(JSON.parse(row.data)));
}

function registerDeviceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/devices', async () => ctx.registry.list());

  app.post('/api/devices/:id/assign', async (req, reply) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    const { riderId } = parseOr400(AssignBodySchema, req.body);
    try {
      ctx.registry.assign(id, riderId);
    } catch (err) {
      throw new ApiError(404, errorMessage(err));
    }
    const device = ctx.registry.list().find((d) => d.id === id);
    if (device === undefined) throw new ApiError(404, `Unknown device ${id}`);
    reply.send(device);
  });

  app.delete('/api/devices/:id', async (req, reply) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    ctx.registry.forget(id);
    reply.code(204).send();
  });
}

function registerWorkoutRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/workouts', async () => ctx.workoutLibrary.list());

  app.post('/api/workouts/import', async (req, reply) => {
    const { xml } = parseOr400(ImportBodySchema, req.body);
    let workout: Workout;
    try {
      workout = parseZwo(xml);
      WorkoutSchema.parse(workout);
    } catch (err) {
      if (err instanceof ZwoParseError || err instanceof ZodError) {
        throw new ApiError(400, err.message);
      }
      throw err;
    }
    reply.code(201).send(ctx.workoutLibrary.addImported(workout));
  });
}

interface RideRow {
  id: string;
  riderId: string;
  startedAt: number;
  endedAt: number | null;
  workoutName: string | null;
  summary: string | null;
  fitPath: string | null;
  uploadStatus: string | null;
  uploadError: string | null;
}

export interface RideListItem {
  id: string;
  riderId: string;
  startedAt: number;
  endedAt: number | null;
  workoutName: string | null;
  summary: unknown;
  uploadStatus: string | null;
  uploadError: string | null;
}

function registerRideRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get('/api/rides', async (req) => {
    const { riderId } = parseOr400(RidesQuerySchema, req.query);
    const rows = (riderId === undefined
      ? ctx.db
          .prepare(
            'SELECT id, rider_id AS riderId, started_at AS startedAt, ended_at AS endedAt, workout_name AS workoutName, summary, upload_status AS uploadStatus, upload_error AS uploadError FROM rides ORDER BY started_at DESC',
          )
          .all()
      : ctx.db
          .prepare(
            'SELECT id, rider_id AS riderId, started_at AS startedAt, ended_at AS endedAt, workout_name AS workoutName, summary, upload_status AS uploadStatus, upload_error AS uploadError FROM rides WHERE rider_id = ? ORDER BY started_at DESC',
          )
          .all(riderId)) as Array<Omit<RideRow, 'fitPath'>>;
    return rows.map(toRideListItem);
  });

  // 1 Hz samples straight from ride_samples; nullable columns (hr_bpm,
  // target_w) pass through as null.
  app.get('/api/rides/:id/samples', (req) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    const ride = ctx.db.prepare('SELECT id FROM rides WHERE id = ?').get(id);
    if (ride === undefined) throw new ApiError(404, `Unknown ride ${id}`);
    return ctx.db
      .prepare(
        `SELECT ts, power_w AS powerW, cadence_rpm AS cadenceRpm, hr_bpm AS hrBpm,
                speed_kmh AS speedKmh, distance_m AS distanceM, target_w AS targetW
         FROM ride_samples WHERE ride_id = ? ORDER BY ts ASC`,
      )
      .all(id);
  });

  // Sync handler: fastify streams reply.send() bodies only from non-async
  // handlers (async ones serialize the promise result as an empty payload).
  app.get('/api/rides/:id/fit', (req, reply) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    const row = ctx.db.prepare('SELECT fit_path AS fitPath FROM rides WHERE id = ?').get(id) as
      | { fitPath: string | null }
      | undefined;
    if (row === undefined || row.fitPath === null || !existsSync(row.fitPath)) {
      throw new ApiError(404, `Ride ${id} has no FIT file`);
    }
    reply.type('application/octet-stream');
    reply.send(createReadStream(row.fitPath));
  });
}

function toRideListItem(row: Omit<RideRow, 'fitPath'>): RideListItem {
  let summary: unknown = null;
  if (row.summary !== null) {
    try {
      summary = JSON.parse(row.summary);
    } catch {
      summary = null;
    }
  }
  return {
    id: row.id,
    riderId: row.riderId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    workoutName: row.workoutName,
    summary,
    uploadStatus: row.uploadStatus,
    uploadError: row.uploadError,
  };
}

function getProfile(db: Db, id: string): RiderProfile | undefined {
  const row = db.prepare('SELECT data FROM profiles WHERE id = ?').get(id) as { data: string } | undefined;
  return row === undefined ? undefined : RiderProfileSchema.parse(JSON.parse(row.data));
}

/** Resolves RiderStart payloads to engine rider configs; shared by REST and WS. */
export async function resolveRiderConfigs(ctx: ApiContext, riders: RiderStart[]): Promise<RiderConfig[]> {
  const configs: RiderConfig[] = [];
  const seenProfiles = new Set<string>();
  const seenTrainers = new Set<string>();
  const seenHrms = new Set<string>();
  for (const rider of riders) {
    if (seenProfiles.has(rider.profileId)) throw new ApiError(400, `Duplicate profile ${rider.profileId}`);
    seenProfiles.add(rider.profileId);
    const profile = getProfile(ctx.db, rider.profileId);
    if (profile === undefined) throw new ApiError(404, `Unknown profile ${rider.profileId}`);
    let workout: Workout | undefined;
    if (rider.workoutId !== undefined) {
      workout = ctx.workoutLibrary.get(rider.workoutId);
      if (workout === undefined) throw new ApiError(404, `Unknown workout ${rider.workoutId}`);
    }
    if (seenTrainers.has(rider.trainerId)) throw new ApiError(400, `Duplicate trainer ${rider.trainerId}`);
    seenTrainers.add(rider.trainerId);
    const trainer = ctx.hub.find(rider.trainerId);
    if (!(trainer instanceof TrainerDriver)) throw new ApiError(400, `Unknown trainer ${rider.trainerId}`);
    let hrmId: string | undefined;
    if (rider.hrmId !== undefined) {
      if (seenHrms.has(rider.hrmId)) throw new ApiError(400, `Duplicate HRM ${rider.hrmId}`);
      seenHrms.add(rider.hrmId);
      const hrm = ctx.hub.find(rider.hrmId);
      if (!(hrm instanceof HrmDriver)) throw new ApiError(400, `Unknown HRM ${rider.hrmId}`);
      hrmId = hrm.id;
    }
    configs.push({ profile, trainerId: trainer.id, hrmId, workout, workoutId: workout?.id });
  }
  return configs;
}

function registerSessionRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post('/api/sessions', async (req, reply) => {
    const { riders } = parseOr400(StartSessionBodySchema, req.body);
    const configs = await resolveRiderConfigs(ctx, riders);
    let snapshot;
    try {
      snapshot = await ctx.engine.startSession(configs, {
        destination: sessionDestination(ctx.db, configs),
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'session already active') {
        throw new ApiError(409, err.message);
      }
      throw err;
    }
    reply.send(snapshot);
  });

  app.post('/api/sessions/stop', async () => {
    await ctx.engine.stopSession();
    return { ok: true };
  });
}
