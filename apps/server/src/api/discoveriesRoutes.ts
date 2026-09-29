import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../storage/db.js';

/** GET /api/discoveries item: rider_ids JSON parsed, streams never exposed. */
export interface DiscoveryListItem {
  id: string;
  kind: 'beacon' | 'rescue';
  seed: string;
  name: string;
  sessionId: string;
  streakS: number | null;
  riderIds: string[];
  createdAt: number;
}

const DiscoveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

interface DiscoveryRow {
  id: string;
  kind: string;
  seed: string;
  name: string;
  sessionId: string;
  streakS: number | null;
  riderIds: string;
  createdAt: number;
}

/** Phase 6 co-op game discoveries: beacons and rescues, newest first. */
export function registerDiscoveriesRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/api/discoveries', async (req, reply) => {
    const parsed = DiscoveriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      reply
        .code(400)
        .send({ error: issue === undefined ? 'Invalid query' : `${issue.path.join('.')}: ${issue.message}` });
      return;
    }
    const rows = deps.db
      .prepare(
        `SELECT id, kind, seed, name, session_id AS sessionId, streak_s AS streakS,
                rider_ids AS riderIds, created_at AS createdAt
         FROM discoveries
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(parsed.data.limit) as DiscoveryRow[];
    return rows.map(toDiscoveryListItem);
  });
}

function toDiscoveryListItem(row: DiscoveryRow): DiscoveryListItem {
  let riderIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.riderIds);
    if (Array.isArray(parsed)) riderIds = parsed as string[];
  } catch {
    riderIds = [];
  }
  return {
    id: row.id,
    kind: row.kind === 'rescue' ? 'rescue' : 'beacon',
    seed: row.seed,
    name: row.name,
    sessionId: row.sessionId,
    streakS: row.streakS,
    riderIds,
    createdAt: row.createdAt,
  };
}
