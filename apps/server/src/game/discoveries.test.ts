import { EventEmitter } from 'node:events';

import { nameFromSeed, type SessionEvent } from '@opencycle/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerDiscoveriesRoutes } from '../api/discoveriesRoutes.js';
import { openDb } from '../storage/db.js';
import { attachDiscoveries, isBeaconStreak, type DiscoveryEngine } from './discoveries.js';

/** Minimal engine fake: EventEmitter plus the session-id surface discoveries reads. */
class FakeEngine extends EventEmitter implements DiscoveryEngine {
  session: { id: string } | null = { id: 'sess-test' };
}

function emit(engine: FakeEngine, event: SessionEvent): void {
  engine.emit('event', event);
}

function beaconRows(db: ReturnType<typeof openDb>): Array<{ streakS: number; seed: string }> {
  return db
    .prepare("SELECT streak_s AS streakS, seed FROM discoveries WHERE kind = 'beacon' ORDER BY streak_s")
    .all() as Array<{ streakS: number; seed: string }>;
}

describe('attachDiscoveries', () => {
  it('materializes beacons only at streak thresholds (30 and 90, not 60)', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachDiscoveries(engine, db);
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 30 });
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 60 });
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 90 });
    expect(beaconRows(db)).toEqual([
      { streakS: 30, seed: 'sess-test:30' },
      { streakS: 90, seed: 'sess-test:90' },
    ]);
    db.close();
  });

  it('replaying the same beacon event does not duplicate rows', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachDiscoveries(engine, db);
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 30 });
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 30 });
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 90 });
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 90 });
    expect(beaconRows(db)).toEqual([
      { streakS: 30, seed: 'sess-test:30' },
      { streakS: 90, seed: 'sess-test:90' },
    ]);
    db.close();
  });

  it('writes no discovery for a finished workout (voyage systems are separate)', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachDiscoveries(engine, db);
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 1000 });
    emit(engine, { kind: 'workoutCompleted', riderId: 'r2', ts: 2000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM discoveries').get()).toEqual({ n: 0 });
    db.close();
  });

  it('ignores bothInZone and workoutCompleted when no session is active', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachDiscoveries(engine, db);
    engine.session = null;
    emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 30 });
    emit(engine, { kind: 'workoutCompleted', riderId: 'r1', ts: 1000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM discoveries').get()).toEqual({ n: 0 });
    db.close();
  });

  it('ignores non-discovery events', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachDiscoveries(engine, db);
    emit(engine, { kind: 'stepCompleted', riderId: 'r1', stepIndex: 0, ts: 1000 });
    emit(engine, { kind: 'ergGuard', riderId: 'r1', engaged: true, ts: 1000 });
    emit(engine, { kind: 'riderJoined', riderId: 'r1', ts: 1000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM discoveries').get()).toEqual({ n: 0 });
    db.close();
  });

  it('materializes a rescue row with helper and rider ids', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachDiscoveries(engine, db);
    emit(engine, { kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 });
    const rows = db
      .prepare(
        "SELECT kind, seed, name, streak_s AS streakS, rider_ids AS riderIds FROM discoveries",
      )
      .all() as Array<{ kind: string; seed: string; name: string; streakS: number | null; riderIds: string }>;
    expect(rows).toEqual([
      {
        kind: 'rescue',
        seed: 'sess-test:rescue:r2:r1:1000',
        name: nameFromSeed('sess-test:rescue:r2:r1:1000'),
        streakS: null,
        riderIds: '["r2","r1"]',
      },
    ]);
    db.close();
  });

  it('replaying the same rescue event does not duplicate rows', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    attachDiscoveries(engine, db);
    const event = { kind: 'rescue' as const, helperId: 'r2', riderId: 'r1', ts: 1000 };
    emit(engine, event);
    emit(engine, event);
    emit(engine, { kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 4000 });
    const rows = db
      .prepare('SELECT seed FROM discoveries WHERE kind = ? ORDER BY created_at')
      .all('rescue') as Array<{ seed: string }>;
    expect(rows).toEqual([
      { seed: 'sess-test:rescue:r2:r1:1000' },
      { seed: 'sess-test:rescue:r2:r1:4000' },
    ]);
    db.close();
  });


  it('guards writes against a closed database (shutdown race)', () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    const logged: string[] = [];
    attachDiscoveries(engine, db, (message) => logged.push(message));
    db.close();
    expect(() => emit(engine, { kind: 'bothInZone', ts: 1000, streakS: 30 })).not.toThrow();
    expect(() => emit(engine, { kind: 'rescue', helperId: 'r2', riderId: 'r1', ts: 1000 })).not.toThrow();
    expect(logged.length).toBe(2);
    expect(logged[0]).toMatch(/^discovery write failed:/);
  });
});

describe('isBeaconStreak', () => {
  it('flags 30, 90, 180, and every 300 s thereafter', () => {
    for (const streakS of [30, 90, 180, 300, 600, 900, 1200, 2100]) {
      expect(isBeaconStreak(streakS)).toBe(true);
    }
  });

  it('skips non-threshold cumulative streaks', () => {
    for (const streakS of [15, 60, 120, 150, 210, 240, 270, 330, 450, 750]) {
      expect(isBeaconStreak(streakS)).toBe(false);
    }
  });
});

describe('GET /api/discoveries', () => {
  it('returns parsed rows newest first', async () => {
    const db = openDb(':memory:');
    const insert = db.prepare(
      `INSERT INTO discoveries (id, kind, seed, name, session_id, streak_s, rider_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('b1', 'beacon', 'sess-1:30', 'Velari', 'sess-1', 30, '[]', 1500);
    insert.run('b2', 'beacon', 'sess-1:90', 'Taro-2', 'sess-1', 90, '[]', 2000);
    insert.run('s1', 'rescue', 'sess-1:rescue:r2:r1:2500', 'Orbi-3', 'sess-1', null, '["r2","r1"]', 2500);

    const app = Fastify({ logger: false });
    registerDiscoveriesRoutes(app, { db });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/discoveries' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: 's1', kind: 'rescue', seed: 'sess-1:rescue:r2:r1:2500', name: 'Orbi-3', sessionId: 'sess-1', streakS: null, riderIds: ['r2', 'r1'], createdAt: 2500 },
      { id: 'b2', kind: 'beacon', seed: 'sess-1:90', name: 'Taro-2', sessionId: 'sess-1', streakS: 90, riderIds: [], createdAt: 2000 },
      { id: 'b1', kind: 'beacon', seed: 'sess-1:30', name: 'Velari', sessionId: 'sess-1', streakS: 30, riderIds: [], createdAt: 1500 },
    ]);
    await app.close();
    db.close();
  });

  it('honors ?limit and rejects invalid limits', async () => {
    const db = openDb(':memory:');
    const insert = db.prepare(
      `INSERT INTO discoveries (id, kind, seed, name, session_id, streak_s, rider_ids, created_at)
       VALUES (?, 'beacon', ?, ?, 'sess-1', ?, '[]', ?)`,
    );
    insert.run('b1', 's1:30', 'A', 30, 1000);
    insert.run('b2', 's1:90', 'B', 90, 2000);
    insert.run('b3', 's1:180', 'C', 180, 3000);

    const app = Fastify({ logger: false });
    registerDiscoveriesRoutes(app, { db });
    await app.ready();
    const limited = await app.inject({ method: 'GET', url: '/api/discoveries?limit=2' });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().map((row: { id: string }) => row.id)).toEqual(['b3', 'b2']);
    for (const bad of ['?limit=0', '?limit=abc', '?limit=-1']) {
      const res = await app.inject({ method: 'GET', url: `/api/discoveries${bad}` });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
    db.close();
  });
});
