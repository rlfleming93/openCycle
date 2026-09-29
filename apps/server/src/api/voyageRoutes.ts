import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { nextDestination } from '../game/voyage.js';
import type { Db } from '../storage/db.js';
import { ApiError } from './routes.js';

/** GET /api/voyage item: one system a rider has arrived at. */
export interface VoyageSystemItem {
  id: string;
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

const VoyageQuerySchema = z.object({ riderId: z.string().min(1) });

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue === undefined ? 'Invalid request' : `${issue.path.join('.')}: ${issue.message}`;
    throw new ApiError(400, detail);
  }
  return parsed.data;
}

/**
 * A rider's voyage: every system they have arrived at, oldest first, plus the
 * destination their next workout flies to.
 */
export function registerVoyageRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/api/voyage', (req) => {
    const { riderId } = parseOr400(VoyageQuerySchema, req.query);
    const profile = deps.db.prepare('SELECT id FROM profiles WHERE id = ?').get(riderId);
    if (profile === undefined) throw new ApiError(404, `Unknown profile ${riderId}`);
    const systems = deps.db
      .prepare(
        `SELECT id, session_id AS sessionId, voyage_index AS voyageIndex, seed, name,
                workout_id AS workoutId, workout_name AS workoutName,
                surveys_total AS surveysTotal, surveys_clean AS surveysClean,
                arrived_at AS arrivedAt
         FROM voyage_systems
         WHERE rider_id = ?
         ORDER BY arrived_at ASC, voyage_index ASC`,
      )
      .all(riderId) as VoyageSystemItem[];
    return { riderId, systems, next: nextDestination(deps.db, riderId) };
  });
}
