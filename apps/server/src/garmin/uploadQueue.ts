import { RiderProfileSchema, type RiderProfile } from '@opencycle/shared';

import type { SessionEngine } from '../session/engine.js';
import type { Db } from '../storage/db.js';
import type { GarminConnector } from './connect.js';

/** The connector surface the queue needs; tests inject fakes. */
export type UploadConnector = Pick<GarminConnector, 'uploadFit' | 'hasLogin'>;

/** upload_status values on the rides row (null = never queued). */
export type UploadStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

interface RideRow {
  riderId: string;
  fitPath: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Serial Garmin upload worker. Enqueue marks the ride `pending`; one worker
 * processes rides one at a time through `pending → uploading → uploaded`
 * (or `failed` + `upload_error`). Retries are never automatic — the UI
 * re-enqueues. Missing FIT file or missing Garmin login surface as `failed`
 * with the reason recorded on the row.
 */
export class UploadQueue {
  private readonly pending = new Set<string>();
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly connector: UploadConnector,
    private readonly log: (message: string) => void = () => {},
  ) {
    // A previous process may have died mid-upload: rides stuck in
    // pending/uploading never finish on their own, so restarting the server
    // marks them failed with an honest reason (the UI offers a retry).
    this.writeDb(() => {
      this.db
        .prepare(
          "UPDATE rides SET upload_status = 'failed', upload_error = 'interrupted by restart' WHERE upload_status IN ('pending', 'uploading')",
        )
        .run();
    });
  }

  enqueue(rideId: string): void {
    this.pending.add(rideId);
    this.writeDb(() => {
      this.db.prepare("UPDATE rides SET upload_status = 'pending' WHERE id = ?").run(rideId);
    });
    void this.drain();
  }

  /** Whether the rider has a saved Garmin login; used by attachAutoUpload. */
  hasLogin(riderId: string): boolean {
    return this.connector.hasLogin(riderId);
  }

  /**
   * Runs a DB write defensively: during shutdown the connection may already
   * be closed (the queue drains in flight while onClose closes the DB), and
   * a throw must surface as a log line, never an unhandled rejection.
   */
  private writeDb(write: () => void): void {
    try {
      write();
    } catch (err) {
      this.log(`garmin upload DB write failed: ${errorMessage(err)}`);
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size > 0) {
        const rideId = this.pending.values().next().value;
        if (rideId === undefined) break;
        this.pending.delete(rideId);
        await this.process(rideId);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(rideId: string): Promise<void> {
    let row: RideRow | undefined;
    try {
      row = this.db
        .prepare('SELECT rider_id AS riderId, fit_path AS fitPath FROM rides WHERE id = ?')
        .get(rideId) as RideRow | undefined;
    } catch (err) {
      this.log(`garmin upload skipped for ride ${rideId}: ${errorMessage(err)}`);
      return;
    }
    if (row === undefined) {
      this.log(`garmin upload skipped: ride ${rideId} no longer exists`);
      return;
    }
    let markedUploading = false;
    this.writeDb(() => {
      this.db
        .prepare("UPDATE rides SET upload_status = 'uploading', upload_error = NULL WHERE id = ?")
        .run(rideId);
      markedUploading = true;
    });
    if (!markedUploading) return;
    try {
      if (row.fitPath === null) {
        throw new Error(`ride ${rideId} has no FIT file (ride not finalized)`);
      }
      await this.connector.uploadFit(row.riderId, row.fitPath);
      this.writeDb(() => {
        this.db.prepare("UPDATE rides SET upload_status = 'uploaded' WHERE id = ?").run(rideId);
      });
      this.log(`garmin upload complete for ride ${rideId}`);
    } catch (err) {
      const reason = errorMessage(err);
      this.writeDb(() => {
        this.db
          .prepare("UPDATE rides SET upload_status = 'failed', upload_error = ? WHERE id = ?")
          .run(reason, rideId);
      });
      this.log(`garmin upload failed for ride ${rideId}: ${reason}`);
    }
  }
}

function getProfile(db: Db, id: string): RiderProfile | undefined {
  const row = db.prepare('SELECT data FROM profiles WHERE id = ?').get(id) as { data: string } | undefined;
  return row === undefined ? undefined : RiderProfileSchema.parse(JSON.parse(row.data));
}

/**
 * Auto-upload wiring: when a rider leaves a session, enqueue their newest
 * finalized ride if the profile has garmin.autoUpload and a saved login
 * exists. The queue itself never makes this decision — callers gate.
 */
export function attachAutoUpload(engine: SessionEngine, db: Db, queue: UploadQueue): void {
  engine.on('event', (event) => {
    if (event.kind !== 'riderLeft') return;
    const profile = getProfile(db, event.riderId);
    if (profile?.garmin?.autoUpload !== true) return;
    if (!queue.hasLogin(event.riderId)) return;
    const ride = db
      .prepare(
        `SELECT id FROM rides WHERE rider_id = ? AND ended_at IS NOT NULL AND fit_path IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(event.riderId) as { id: string } | undefined;
    if (ride === undefined) return;
    queue.enqueue(ride.id);
  });
}
