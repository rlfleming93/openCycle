import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { GarminConnector } from '../garmin/connect.js';
import { importGarminZip } from '../garmin/zipImport.js';
import type { SessionEngine } from '../session/engine.js';
import type { Db } from '../storage/db.js';
import { ApiError } from './routes.js';
import type { UploadQueue } from '../garmin/uploadQueue.js';

const IdParamSchema = z.object({ id: z.string().min(1) });
const RiderIdParamSchema = z.object({ riderId: z.string().min(1) });

export interface GarminRouteDeps {
  db: Db;
  queue: UploadQueue;
  connector: Pick<GarminConnector, 'pullRecentActivities'>;
  engine: SessionEngine;
}

/** How many days back the history pull scans on each request. */
const PULL_SINCE_DAYS = 30;

function parseIdParam(params: unknown): string {
  const result = IdParamSchema.safeParse(params);
  if (!result.success) throw new ApiError(400, 'Invalid ride id');
  return result.data.id;
}

interface UploadStatusRow {
  uploadStatus: string | null;
  uploadError: string | null;
}

/**
 * Garmin upload endpoints. POST enqueues a finalized ride's FIT for upload to
 * Garmin Connect (async: 202 immediately, the queue does the work); GET
 * reports the ride's upload_status/upload_error. POST /api/garmin/pull/:riderId
 * starts a background history pull (30 days back, up to 1000 activities per
 * pull — the activitylist-service cap) whose downloaded activity archives are
 * imported under that rider; failures are logged and non-fatal — the 202 is
 * the whole response.
 */
export function registerGarminRoutes(app: FastifyInstance, deps: GarminRouteDeps): void {
  const { db, queue, connector, engine } = deps;

  app.post('/api/rides/:id/upload', async (req, reply) => {
    const id = parseIdParam(req.params);
    const row = db.prepare('SELECT fit_path AS fitPath FROM rides WHERE id = ?').get(id) as
      | { fitPath: string | null }
      | undefined;
    if (row === undefined) throw new ApiError(404, `Unknown ride ${id}`);
    if (row.fitPath === null) throw new ApiError(409, `Ride ${id} has no FIT file yet`);
    queue.enqueue(id);
    reply.code(202).send({ status: 'queued' });
  });

  app.get('/api/rides/:id/upload-status', async (req) => {
    const id = parseIdParam(req.params);
    const row = db
      .prepare('SELECT upload_status AS uploadStatus, upload_error AS uploadError FROM rides WHERE id = ?')
      .get(id) as UploadStatusRow | undefined;
    if (row === undefined) throw new ApiError(404, `Unknown ride ${id}`);
    return row;
  });

  app.post('/api/garmin/pull/:riderId', async (req, reply) => {
    const parsed = RiderIdParamSchema.safeParse(req.params);
    if (!parsed.success) throw new ApiError(400, 'Invalid rider id');
    const { riderId } = parsed.data;
    if (db.prepare('SELECT id FROM profiles WHERE id = ?').get(riderId) === undefined) {
      throw new ApiError(404, `Unknown profile ${riderId}`);
    }
    if (engine.session !== null) {
      throw new ApiError(409, 'history pull blocked while a session is active');
    }
    reply.code(202).send({ status: 'started' });
    void connector
      .pullRecentActivities(riderId, PULL_SINCE_DAYS)
      .then(async (buffers) => {
        let imported = 0;
        let skipped = 0;
        for (const buffer of buffers) {
          try {
            const result = importGarminZip(db, buffer, riderId);
            imported += result.imported;
            skipped += result.skipped;
            for (const error of result.errors) app.log.warn({ error, riderId }, 'garmin pull activity error');
          } catch (err) {
            app.log.error({ err, riderId }, 'garmin pull activity import failed');
          }
          // Yield to the event loop between archives so session ticks, WS
          // broadcasts, and other requests are not starved by a long pull.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        app.log.info({ riderId, imported, skipped }, 'garmin history pull complete');
      })
      .catch((err: unknown) => {
        app.log.error({ err, riderId }, 'garmin history pull failed');
      });
  });
}
