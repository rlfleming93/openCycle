import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceInfoSchema, RiderSlotSchema } from '@opencycle/shared';

import { openDb } from '../storage/db.js';
import { DeviceRegistry } from './registry.js';

function freshRegistry() {
  const db = openDb(':memory:');
  return { db, registry: new DeviceRegistry(db) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DeviceRegistry', () => {
  it('upserts a new device; reseen updates name and last_seen while preserving rider_id', () => {
    vi.useFakeTimers();
    const { db, registry } = freshRegistry();
    registry.upsertSeen({ id: 'd1', kind: 'trainer', name: 'KICKR CORE A' });
    registry.assign('d1', 'rider-1');
    const first = registry.list().find((d) => d.id === 'd1');
    expect(first).toBeDefined();

    vi.advanceTimersByTime(1);
    registry.upsertSeen({ id: 'd1', kind: 'trainer', name: 'KICKR CORE A+' });
    const second = registry.list().find((d) => d.id === 'd1');
    expect(second?.name).toBe('KICKR CORE A+');
    expect(second?.lastSeen).toBeGreaterThan(first!.lastSeen);
    expect(second?.riderId).toBe('rider-1');
    db.close();
  });

  it('keeps kind immutable after the first sight', () => {
    const { db, registry } = freshRegistry();
    registry.upsertSeen({ id: 'd1', kind: 'hrm', name: 'HRM A' });
    registry.upsertSeen({ id: 'd1', kind: 'trainer', name: 'HRM A' });
    const row = registry.list().find((d) => d.id === 'd1');
    expect(row?.kind).toBe('hrm');
    db.close();
  });

  it('list() returns shared-schema-valid rows with optional riderId', () => {
    const { db, registry } = freshRegistry();
    registry.upsertSeen({ id: 't1', kind: 'trainer', name: 'KICKR' });
    registry.upsertSeen({ id: 'h1', kind: 'hrm', name: 'HRM' });
    registry.assign('t1', 'rider-1');
    const rows = registry.list();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(DeviceInfoSchema.safeParse(row).success).toBe(true);
    }
    expect(rows.find((r) => r.id === 't1')?.riderId).toBe('rider-1');
    expect(rows.find((r) => r.id === 'h1')?.riderId).toBeUndefined();
    db.close();
  });

  it('assign() throws for an unknown device', () => {
    const { db, registry } = freshRegistry();
    expect(() => registry.assign('nope', 'rider-1')).toThrow('unknown device: nope');
    db.close();
  });

  it('assign() reassigns to another rider and unassigns with null', () => {
    const { db, registry } = freshRegistry();
    registry.upsertSeen({ id: 't1', kind: 'trainer', name: 'KICKR' });
    registry.assign('t1', 'rider-1');
    registry.assign('t1', 'rider-2');
    const row = registry.list().find((r) => r.id === 't1');
    expect(row?.riderId).toBe('rider-2');
    registry.assign('t1', null);
    expect(registry.list().find((r) => r.id === 't1')?.riderId).toBeUndefined();
    db.close();
  });

  it('forget() removes the device', () => {
    const { db, registry } = freshRegistry();
    registry.upsertSeen({ id: 't1', kind: 'trainer', name: 'KICKR' });
    registry.forget('t1');
    expect(registry.list()).toEqual([]);
    expect(() => registry.assign('t1', 'rider-1')).toThrow('unknown device: t1');
    db.close();
  });

  it('slots() groups trainer + hrm per rider and includes hrm-only riders', () => {
    const { db, registry } = freshRegistry();
    registry.upsertSeen({ id: 't1', kind: 'trainer', name: 'KICKR 1' });
    registry.upsertSeen({ id: 'h1', kind: 'hrm', name: 'HRM 1' });
    registry.upsertSeen({ id: 'h2', kind: 'hrm', name: 'HRM 2' });
    registry.assign('t1', 'rider-1');
    registry.assign('h1', 'rider-1');
    registry.assign('h2', 'rider-2');
    const slots = registry.slots();
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(RiderSlotSchema.safeParse(slot).success).toBe(true);
    }
    expect(slots.find((s) => s.riderId === 'rider-1')).toEqual({ riderId: 'rider-1', trainerId: 't1', hrmId: 'h1' });
    expect(slots.find((s) => s.riderId === 'rider-2')).toEqual({ riderId: 'rider-2', hrmId: 'h2' });
    db.close();
  });

  it('slots() picks the most recently seen trainer when a rider has two', () => {
    vi.useFakeTimers();
    const { db, registry } = freshRegistry();
    registry.upsertSeen({ id: 't1', kind: 'trainer', name: 'KICKR A' });
    vi.advanceTimersByTime(1);
    registry.upsertSeen({ id: 't2', kind: 'trainer', name: 'KICKR B' });
    registry.assign('t1', 'rider-1');
    registry.assign('t2', 'rider-1');
    const slot = registry.slots().find((s) => s.riderId === 'rider-1');
    expect(slot?.trainerId).toBe('t2');
    db.close();
  });
});
