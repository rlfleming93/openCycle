import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GarminLoginStatus } from '@opencycle/shared';

import type { GarminConnector } from '../garmin/connect.js';
import type { GarminLoginProgress } from '../garmin/login.js';
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
  hasLogin(riderId: string): boolean;
  runLogin(riderId: string, onProgress: (state: GarminLoginProgress) => void): Promise<void>;
}

/** How many days back the history pull scans on each request. */
const PULL_SINCE_DAYS = 30;

function parseIdParam(params: unknown): string {
  const result = IdParamSchema.safeParse(params);
  if (!result.success) throw new ApiError(400, 'Invalid ride id');
  return result.data.id;
}

function parseRiderIdParam(params: unknown): string {
  const result = RiderIdParamSchema.safeParse(params);
  if (!result.success) throw new ApiError(400, 'Invalid rider id');
  return result.data.riderId;
}

function requireProfile(db: Db, riderId: string): void {
  if (db.prepare('SELECT id FROM profiles WHERE id = ?').get(riderId) === undefined) {
    throw new ApiError(404, `Unknown profile ${riderId}`);
  }
}

interface StoredLoginStatus {
  state: GarminLoginStatus['state'];
  error?: string;
}

interface UploadStatusRow {
  uploadStatus: string | null;
  uploadError: string | null;
}

/**
 * Garmin login, upload, and history endpoints. Login and history work run in
 * the background after a 202 response. Login status stays in memory while the
 * saved Playwright state stays on disk; upload status stays with each ride.
 */
export function registerGarminRoutes(app: FastifyInstance, deps: GarminRouteDeps): void {
  const { db, queue, connector, engine, hasLogin, runLogin } = deps;
  const loginStatuses = new Map<string, StoredLoginStatus>();

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

  app.get('/api/garmin/login/:riderId', async (req) => {
    const riderId = parseRiderIdParam(req.params);
    requireProfile(db, riderId);
    const status = loginStatuses.get(riderId);
    return {
      hasLogin: hasLogin(riderId),
      state: status?.state ?? 'idle',
      ...(status?.error !== undefined ? { error: status.error } : {}),
    };
  });

  app.post('/api/garmin/login/:riderId', async (req, reply) => {
    const riderId = parseRiderIdParam(req.params);
    requireProfile(db, riderId);
    const current = loginStatuses.get(riderId)?.state;
    if (current === 'installing' || current === 'running') {
      throw new ApiError(409, `Garmin login already in progress for ${riderId}`);
    }

    let state: GarminLoginProgress = 'running';
    loginStatuses.set(riderId, { state });
    let pending: Promise<void>;
    try {
      pending = runLogin(riderId, (nextState) => {
        state = nextState;
        loginStatuses.set(riderId, { state });
      });
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending.then(
      () => loginStatuses.set(riderId, { state: 'idle' }),
      (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        loginStatuses.set(riderId, { state: 'failed', error });
      },
    );
    reply.code(202).send({ state });
  });

  app.post('/api/garmin/pull/:riderId', async (req, reply) => {
    const riderId = parseRiderIdParam(req.params);
    requireProfile(db, riderId);
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
