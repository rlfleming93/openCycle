import type Database from 'better-sqlite3';
import {
  DeviceInfoSchema,
  type DeviceInfo,
  type DeviceKind,
  RiderSlotSchema,
  type RiderSlot,
} from '@opencycle/shared';

import type { Db } from '../storage/db.js';

export interface UpsertSeenInfo {
  id: string;
  kind: DeviceKind;
  name: string;
}

interface DeviceRow {
  id: string;
  kind: DeviceKind;
  name: string;
  lastSeen: number;
  riderId: string | null;
}

interface SlotRow {
  riderId: string;
  kind: DeviceKind;
  id: string;
}

export type ListedDevice = DeviceInfo & { riderId?: string };

/** Persists known BLE devices and rider assignments in SQLite. */
export class DeviceRegistry {
  private readonly upsertStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly assignStmt: Database.Statement;
  private readonly forgetStmt: Database.Statement;
  private readonly slotStmt: Database.Statement;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO devices (id, kind, name, last_seen)
       VALUES (@id, @kind, @name, @lastSeen)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
    );
    this.listStmt = db.prepare(
      `SELECT id, kind, name, last_seen AS lastSeen, rider_id AS riderId
       FROM devices
       ORDER BY last_seen DESC, id ASC`,
    );
    this.assignStmt = db.prepare('UPDATE devices SET rider_id = @riderId WHERE id = @deviceId');
    this.forgetStmt = db.prepare('DELETE FROM devices WHERE id = @deviceId');
    this.slotStmt = db.prepare(
      `SELECT rider_id AS riderId, kind, id
       FROM devices
       WHERE rider_id IS NOT NULL
       ORDER BY rider_id ASC, kind ASC, last_seen DESC, id ASC`,
    );
  }

  upsertSeen(info: UpsertSeenInfo): void {
    this.upsertStmt.run({ id: info.id, kind: info.kind, name: info.name, lastSeen: Date.now() });
  }

  list(): ListedDevice[] {
    const rows = this.listStmt.all() as DeviceRow[];
    return rows.map((row) => {
      const device = DeviceInfoSchema.parse({
        id: row.id,
        kind: row.kind,
        name: row.name,
        lastSeen: row.lastSeen,
      });
      return row.riderId === null ? device : { ...device, riderId: row.riderId };
    });
  }

  assign(deviceId: string, riderId: string | null): void {
    const result = this.assignStmt.run({ deviceId, riderId });
    if (result.changes === 0) {
      throw new Error(`unknown device: ${deviceId}`);
    }
  }

  forget(deviceId: string): void {
    this.forgetStmt.run({ deviceId });
  }

  slots(): RiderSlot[] {
    const rows = this.slotStmt.all() as SlotRow[];
    const byRider = new Map<string, { trainerId?: string; hrmId?: string }>();
    for (const row of rows) {
      const devices = byRider.get(row.riderId) ?? {};
      if (row.kind === 'trainer' && devices.trainerId === undefined) {
        devices.trainerId = row.id;
      } else if (row.kind === 'hrm' && devices.hrmId === undefined) {
        devices.hrmId = row.id;
      }
      byRider.set(row.riderId, devices);
    }
    return [...byRider.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([riderId, devices]) => RiderSlotSchema.parse({ riderId, ...devices }));
  }
}
