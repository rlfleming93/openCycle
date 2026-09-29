import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { SessionEngine } from '../session/engine.js';
import type { ImportResult } from '../garmin/zipImport.js';
import type { Db } from '../storage/db.js';
import { ApiError } from './routes.js';

export interface ActivitiesDeps {
  db: Db;
  engine: SessionEngine;
  importZip: (buf: Buffer, riderId?: string | null) => ImportResult;
}

/** GET /api/activities item: summary JSON parsed, streams never exposed. */
export interface ActivityListItem {
  id: string;
  source: string;
  riderId: string | null;
  startedAt: number;
  durationS: number;
  sport: string | null;
  name: string | null;
  summary: unknown;
}

const ActivitiesQuerySchema = z.object({ riderId: z.string().min(1).optional() });
const AssignBodySchema = z.object({
  riderId: z.string().min(1).nullable(),
  ids: z.array(z.string().min(1)).min(1),
});
const MAX_ZIP_BYTES = 2 * 1024 ** 3;

export function registerActivitiesRoutes(app: FastifyInstance, deps: ActivitiesDeps): void {
  // Single multipart registration for the whole app (guarded so wiring the
  // plugin at the top level too does not double-register).
  if (!app.hasPlugin('@fastify/multipart')) {
    app.register(multipart, { limits: { fileSize: MAX_ZIP_BYTES } });
  }

  app.get('/api/activities', async (req, reply) => {
    const parsed = ActivitiesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      reply
        .code(400)
        .send({ error: issue === undefined ? 'Invalid query' : `${issue.path.join('.')}: ${issue.message}` });
      return;
    }
    const { riderId } = parsed.data;
    const sql =
      'SELECT id, source, rider_id AS riderId, started_at AS startedAt, duration_s AS durationS,' +
      ' sport, name, summary FROM activities';
    const rows = (riderId === undefined
      ? deps.db.prepare(`${sql} ORDER BY started_at DESC`).all()
      : deps.db.prepare(`${sql} WHERE rider_id = ? ORDER BY started_at DESC`).all(riderId)) as ActivityRow[];
    return rows.map(toActivityListItem);
  });

  /**
   * Bulk (re)assignment of imported activities to a rider (or unassignment
   * with riderId null). The (rider_id, started_at, duration_s) dedupe key is
   * unique per rider, so assigning to a rider who already holds that triple
   * is skipped — moving activities between riders can never double-count a
   * ride (or its training load). Unassignment is unconditional. Returns the
   * number of rows updated; skipped rows are not counted.
   */
  app.post('/api/activities/assign', async (req) => {
    const body = AssignBodySchema.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const detail = issue === undefined ? 'Invalid body' : `${issue.path.join('.')}: ${issue.message}`;
      throw new ApiError(400, detail);
    }
    const { riderId, ids } = body.data;
    if (riderId !== null && deps.db.prepare('SELECT id FROM profiles WHERE id = ?').get(riderId) === undefined) {
      throw new ApiError(404, `Unknown profile ${riderId}`);
    }
    const placeholders = ids.map(() => '?').join(', ');
    const info =
      riderId === null
        ? deps.db.prepare(`UPDATE activities SET rider_id = NULL WHERE id IN (${placeholders})`).run(...ids)
        : deps.db
            .prepare(
              `UPDATE activities SET rider_id = ?
               WHERE id IN (${placeholders})
                 AND NOT EXISTS (
                   SELECT 1 FROM activities existing
                   WHERE existing.rider_id = ?
                     AND existing.started_at = activities.started_at
                     AND existing.duration_s = activities.duration_s
                     AND existing.id != activities.id
                 )`,
            )
            .run(riderId, ...ids, riderId);
    return { updated: info.changes };
  });

  app.post('/api/garmin/import-zip', async (req, reply) => {
    const parsed = ActivitiesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      reply
        .code(400)
        .send({ error: issue === undefined ? 'Invalid query' : `${issue.path.join('.')}: ${issue.message}` });
      return;
    }
    const { riderId } = parsed.data;
    if (deps.engine.session !== null) {
      reply.code(409).send({ error: 'import blocked while a session is active' });
      return;
    }
    if (riderId !== undefined && deps.db.prepare('SELECT id FROM profiles WHERE id = ?').get(riderId) === undefined) {
      reply.code(404).send({ error: `Unknown profile ${riderId}` });
      return;
    }
    let file: { toBuffer(): Promise<Buffer> } | undefined;
    try {
      file = await req.file();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
        reply.code(415).send({ error: 'Expected a multipart/form-data upload' });
        return;
      }
      reply.code(413).send({ error: errorMessage(err) });
      return;
    }
    if (file === undefined) {
      reply.code(400).send({ error: 'Missing multipart file part' });
      return;
    }
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch (err) {
      reply.code(413).send({ error: errorMessage(err) });
      return;
    }
    reply.send(deps.importZip(buf, riderId));
  });
}

interface ActivityRow {
  id: string;
  source: string;
  riderId: string | null;
  startedAt: number;
  durationS: number;
  sport: string | null;
  name: string | null;
  summary: string | null;
}

function toActivityListItem(row: ActivityRow): ActivityListItem {
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
    source: row.source,
    riderId: row.riderId,
    startedAt: row.startedAt,
    durationS: row.durationS,
    sport: row.sport,
    name: row.name,
    summary,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
