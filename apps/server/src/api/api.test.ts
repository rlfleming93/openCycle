import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import websocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { WsServerMessage } from '@opencycle/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { DeviceHub } from '../devices/hub.js';
import { DeviceRegistry } from '../devices/registry.js';
import { SessionEngine } from '../session/engine.js';
import { Recorder } from '../session/recorder.js';
import { openDb } from '../storage/db.js';
import type { ApiContext } from './routes.js';
import { registerRoutes, WorkoutLibrary } from './routes.js';
import { registerWs } from './ws.js';

const ZWO_XML = `<?xml version="1.0"?>
<workout_file>
  <author>openCycle</author>
  <name>API Test Ride</name>
  <description>Imported via the API test</description>
  <sportType>bike</sportType>
  <tags><tag name="TEST"/></tags>
  <workout>
    <Warmup Duration="120" PowerLow="0.5" PowerHigh="0.6"/>
    <SteadyState Duration="120" Power="0.7"/>
  </workout>
</workout_file>`;

interface TestWorld {
  app: FastifyInstance;
  ctx: ApiContext;
  dataDir: string;
  plansDir: string;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Real fastify app with a sim hub, real engine (50 ms ticks) and recorder. */
async function buildWorld(sim: string = '1x1'): Promise<TestWorld> {
  const db = openDb(':memory:');
  const registry = new DeviceRegistry(db);
  const hub = new DeviceHub({ registry, sim, ble: false });
  await hub.start();
  // Connect the sim trainer + HRM so samples flow (idempotent if the engine
  // connects drivers itself).
  const { trainers, hrms } = hub.drivers();
  await Promise.all([...trainers.map((t) => t.connect()), ...hrms.map((h) => h.connect())]);
  const dataDir = mkdtempSync(join(tmpdir(), 'opencycle-api-'));
  tempDirs.push(dataDir);
  const recorder = new Recorder(db, dataDir);
  const engine = new SessionEngine({ findDriver: (id) => hub.find(id), recorder, tickMs: 50 });
  const plansDir = mkdtempSync(join(tmpdir(), 'opencycle-plans-'));
  tempDirs.push(plansDir);
  const workoutLibrary = new WorkoutLibrary(db, plansDir);
  const ctx: ApiContext = { db, registry, engine, recorder, hub, workoutLibrary };
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerRoutes(app, ctx);
  registerWs(app, ctx);
  await app.ready();
  return { app, ctx, dataDir, plansDir };
}

async function destroyWorld(world: TestWorld): Promise<void> {
  if (world.ctx.engine.session !== null) {
    await world.ctx.engine.stopSession().catch(() => {});
  }
  await world.app.close().catch(() => {});
  await world.ctx.hub.stop().catch(() => {});
  world.ctx.db.close();
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`waitFor timed out after ${timeoutMs} ms`));
      }
    }, 10);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createProfile(
  world: TestWorld,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const res = await world.app.inject({ method: 'POST', url: '/api/profiles', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function importWorkout(world: TestWorld, xml: string = ZWO_XML): Promise<{ id: string; name: string }> {
  const res = await world.app.inject({ method: 'POST', url: '/api/workouts/import', payload: { xml } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function findTrainer(world: TestWorld): Promise<{ id: string; kind: string }> {
  const res = await world.app.inject({ method: 'GET', url: '/api/devices' });
  expect(res.statusCode).toBe(200);
  const trainer = res.json().find((d: { kind: string }) => d.kind === 'trainer');
  expect(trainer).toBeDefined();
  return trainer;
}

describe('REST /api routes', () => {
  it('CRUDs profiles with zod validation', async () => {
    const world = await buildWorld();
    try {
      const created = await world.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'Ryan', ftpW: 250, weightKg: 75 },
      });
      expect(created.statusCode).toBe(201);
      const profile = created.json();
      expect(profile.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(profile.name).toBe('Ryan');
      expect(profile.ftpW).toBe(250);

      const bad = await world.app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: { name: 'X', ftpW: 9999, weightKg: 75 },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBeTruthy();

      const list = await world.app.inject({ method: 'GET', url: '/api/profiles' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([expect.objectContaining({ id: profile.id, name: 'Ryan', ftpW: 250 })]);

      const updated = await world.app.inject({
        method: 'PUT',
        url: `/api/profiles/${profile.id}`,
        payload: { name: 'Ryan', ftpW: 260, weightKg: 74 },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual(expect.objectContaining({ id: profile.id, ftpW: 260, weightKg: 74 }));

      const putMissing = await world.app.inject({
        method: 'PUT',
        url: '/api/profiles/nope',
        payload: { name: 'X', ftpW: 200, weightKg: 70 },
      });
      expect(putMissing.statusCode).toBe(404);

      const deleted = await world.app.inject({ method: 'DELETE', url: `/api/profiles/${profile.id}` });
      expect(deleted.statusCode).toBe(204);
      const deleteAgain = await world.app.inject({ method: 'DELETE', url: `/api/profiles/${profile.id}` });
      expect(deleteAgain.statusCode).toBe(404);
    } finally {
      await destroyWorld(world);
    }
  });

  it('lists, assigns, and forgets devices', async () => {
    const world = await buildWorld();
    try {
      const list = await world.app.inject({ method: 'GET', url: '/api/devices' });
      expect(list.statusCode).toBe(200);
      const devices = list.json();
      expect(devices).toHaveLength(2);
      expect(devices.map((d: { kind: string }) => d.kind).sort()).toEqual(['hrm', 'trainer']);

      const profile = await createProfile(world, { name: 'A', ftpW: 200, weightKg: 70 });
      const trainer = await findTrainer(world);

      const assign = await world.app.inject({
        method: 'POST',
        url: `/api/devices/${trainer.id}/assign`,
        payload: { riderId: profile.id },
      });
      expect(assign.statusCode).toBe(200);
      expect(assign.json().riderId).toBe(profile.id);

      const assignMissing = await world.app.inject({
        method: 'POST',
        url: '/api/devices/nope/assign',
        payload: { riderId: profile.id },
      });
      expect(assignMissing.statusCode).toBe(404);

      const unassign = await world.app.inject({
        method: 'POST',
        url: `/api/devices/${trainer.id}/assign`,
        payload: { riderId: null },
      });
      expect(unassign.statusCode).toBe(200);
      expect(unassign.json().riderId).toBeUndefined();

      const forget = await world.app.inject({ method: 'DELETE', url: `/api/devices/${trainer.id}` });
      expect(forget.statusCode).toBe(204);
      const after = await world.app.inject({ method: 'GET', url: '/api/devices' });
      expect(after.json()).toHaveLength(1);
    } finally {
      await destroyWorld(world);
    }
  });

  it('imports a .zwo workout and lists it', async () => {
    const world = await buildWorld();
    try {
      const imported = await importWorkout(world);
      expect(imported.name).toBe('API Test Ride');
      expect(imported.id).toMatch(/^api-test-ride-[0-9a-f]{8}$/);

      const list = await world.app.inject({ method: 'GET', url: '/api/workouts' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([
        expect.objectContaining({ id: imported.id, name: 'API Test Ride', source: 'import', tags: ['TEST'] }),
      ]);

      const bad = await world.app.inject({
        method: 'POST',
        url: '/api/workouts/import',
        payload: { xml: '<workout_file><workout><UnsupportedTag/></workout></workout_file>' },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toContain('UnsupportedTag');

      const missing = await world.app.inject({ method: 'POST', url: '/api/workouts/import', payload: {} });
      expect(missing.statusCode).toBe(400);
    } finally {
      await destroyWorld(world);
    }
  });

  it('starts and stops a session, then lists rides and serves the FIT file', async () => {
    const world = await buildWorld();
    try {
      const empty = await world.app.inject({ method: 'GET', url: '/api/rides' });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual([]);

      const profile = await createProfile(world, { name: 'Rider', ftpW: 200, weightKg: 70 });
      const workout = await importWorkout(world);
      const trainer = await findTrainer(world);

      const unknownProfile = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { riders: [{ profileId: 'ghost', trainerId: trainer.id }] },
      });
      expect(unknownProfile.statusCode).toBe(404);

      const unknownTrainer = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { riders: [{ profileId: profile.id, trainerId: 'nope' }] },
      });
      expect(unknownTrainer.statusCode).toBe(400);

      const unknownWorkout = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { riders: [{ profileId: profile.id, trainerId: trainer.id, workoutId: 'nope' }] },
      });
      expect(unknownWorkout.statusCode).toBe(404);

      const start = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { riders: [{ profileId: profile.id, trainerId: trainer.id, workoutId: workout.id }] },
      });
      expect(start.statusCode).toBe(200);
      const snapshot = start.json();
      expect(snapshot.id).toBeTruthy();
      expect(world.ctx.engine.session?.id).toBe(snapshot.id);
      expect(snapshot.riders[0]).toEqual(
        expect.objectContaining({
          riderId: profile.id,
          name: 'Rider',
          state: 'riding',
          workoutName: 'API Test Ride',
        }),
      );

      // Let a few ticks record samples, then stop: the ride is finalized.
      await waitFor(() => (world.ctx.engine.session?.riders[0]?.elapsedS ?? 0) >= 1, 5000);
      const stop = await world.app.inject({ method: 'POST', url: '/api/sessions/stop' });
      expect(stop.statusCode).toBe(200);
      expect(stop.json()).toEqual({ ok: true });
      expect(world.ctx.engine.session).toBeNull();

      const rides = await world.app.inject({ method: 'GET', url: '/api/rides' });
      expect(rides.statusCode).toBe(200);
      const rideList = rides.json();
      expect(rideList).toHaveLength(1);
      expect(rideList[0]).toEqual(
        expect.objectContaining({ riderId: profile.id, workoutName: 'API Test Ride' }),
      );
      expect(rideList[0].summary).toEqual(
        expect.objectContaining({ durationS: expect.any(Number), distanceM: expect.any(Number) }),
      );
      expect(rideList[0].endedAt).toEqual(expect.any(Number));

      const filtered = await world.app.inject({ method: 'GET', url: `/api/rides?riderId=${profile.id}` });
      expect(filtered.json()).toHaveLength(1);
      const filteredOther = await world.app.inject({ method: 'GET', url: '/api/rides?riderId=other' });
      expect(filteredOther.json()).toEqual([]);

      const fit = await world.app.inject({ method: 'GET', url: `/api/rides/${rideList[0].id}/fit` });
      expect(fit.statusCode).toBe(200);
      expect(fit.headers['content-type']).toBe('application/octet-stream');
      expect(fit.rawPayload.byteLength).toBeGreaterThan(100);
      expect(fit.rawPayload.subarray(8, 12).toString()).toBe('.FIT');

      const fitMissing = await world.app.inject({ method: 'GET', url: '/api/rides/nope/fit' });
      expect(fitMissing.statusCode).toBe(404);

      const samples = await world.app.inject({ method: 'GET', url: `/api/rides/${rideList[0].id}/samples` });
      expect(samples.statusCode).toBe(200);
      const sampleRows = samples.json();
      expect(sampleRows.length).toBeGreaterThan(0);
      expect(sampleRows[0]).toEqual(
        expect.objectContaining({
          ts: expect.any(Number),
          powerW: expect.any(Number),
          cadenceRpm: expect.any(Number),
          speedKmh: expect.any(Number),
          distanceM: expect.any(Number),
        }),
      );
      // nullable columns pass through as keys (null or number)
      expect(sampleRows[0]).toHaveProperty('hrBpm');
      expect(sampleRows[0]).toHaveProperty('targetW');
      // ordered by ts ascending
      const timestamps = sampleRows.map((r: { ts: number }) => r.ts);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));

      const samplesMissing = await world.app.inject({ method: 'GET', url: '/api/rides/nope/samples' });
      expect(samplesMissing.statusCode).toBe(404);
      expect(samplesMissing.json().error).toBe('Unknown ride nope');
    } finally {
      await destroyWorld(world);
    }
  });

  it('rejects duplicate profile, trainer, or HRM within one session start', async () => {
    const world = await buildWorld('2x2');
    try {
      const p1 = await createProfile(world, { name: 'One', ftpW: 200, weightKg: 70 });
      const p2 = await createProfile(world, { name: 'Two', ftpW: 250, weightKg: 75 });
      const devices = await world.app.inject({ method: 'GET', url: '/api/devices' });
      const trainers = devices.json().filter((d: { kind: string }) => d.kind === 'trainer');
      const hrms = devices.json().filter((d: { kind: string }) => d.kind === 'hrm');
      expect(trainers).toHaveLength(2);
      expect(hrms).toHaveLength(2);

      const dupProfile = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          riders: [
            { profileId: p1.id, trainerId: trainers[0].id },
            { profileId: p1.id, trainerId: trainers[1].id },
          ],
        },
      });
      expect(dupProfile.statusCode).toBe(400);
      expect(dupProfile.json().error).toBe(`Duplicate profile ${p1.id}`);

      const dupTrainer = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          riders: [
            { profileId: p1.id, trainerId: trainers[0].id },
            { profileId: p2.id, trainerId: trainers[0].id },
          ],
        },
      });
      expect(dupTrainer.statusCode).toBe(400);
      expect(dupTrainer.json().error).toBe(`Duplicate trainer ${trainers[0].id}`);

      const dupHrm = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          riders: [
            { profileId: p1.id, trainerId: trainers[0].id, hrmId: hrms[0].id },
            { profileId: p2.id, trainerId: trainers[1].id, hrmId: hrms[0].id },
          ],
        },
      });
      expect(dupHrm.statusCode).toBe(400);
      expect(dupHrm.json().error).toBe(`Duplicate HRM ${hrms[0].id}`);
    } finally {
      await destroyWorld(world);
    }
  });

  it('maps a double session start to 409', async () => {
    const world = await buildWorld();
    try {
      const profile = await createProfile(world, { name: 'Dup', ftpW: 200, weightKg: 70 });
      const trainer = await findTrainer(world);
      const payload = { riders: [{ profileId: profile.id, trainerId: trainer.id }] };

      const first = await world.app.inject({ method: 'POST', url: '/api/sessions', payload });
      expect(first.statusCode).toBe(200);

      const second = await world.app.inject({ method: 'POST', url: '/api/sessions', payload });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('session already active');
    } finally {
      await destroyWorld(world);
    }
  });
});

describe('WS /ws endpoint', () => {
  function collect(world: TestWorld, ws: WebSocket): WsServerMessage[] {
    const messages: WsServerMessage[] = [];
    ws.on('message', (data: unknown) => {
      messages.push(JSON.parse(String(data)) as WsServerMessage);
    });
    return messages;
  }

  it('sends no messages when no session is running', async () => {
    const world = await buildWorld();
    const ws = await world.app.injectWS('/ws');
    try {
      const messages = collect(world, ws);
      await sleep(200);
      expect(messages).toEqual([]);
    } finally {
      ws.close();
      await destroyWorld(world);
    }
  });

  it('sends sessionState on connect and broadcasts telemetry ticks', async () => {
    const world = await buildWorld();
    try {
      const profile = await createProfile(world, { name: 'WS Rider', ftpW: 200, weightKg: 70 });
      const workout = await importWorkout(world);
      const trainer = await findTrainer(world);
      const start = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { riders: [{ profileId: profile.id, trainerId: trainer.id, workoutId: workout.id }] },
      });
      expect(start.statusCode).toBe(200);

      const ws = await world.app.injectWS('/ws');
      try {
        const messages = collect(world, ws);

        await waitFor(() => messages.some((m) => m.type === 'sessionState'), 3000);
        const state = messages.find((m) => m.type === 'sessionState');
        if (state?.type !== 'sessionState' || state.session === null) {
          throw new Error('expected a sessionState message with a live session');
        }
        expect(state.session.id).toBe(world.ctx.engine.session?.id);

        await waitFor(() => messages.some((m) => m.type === 'telemetry'), 5000);
        const telemetry = messages.find((m) => m.type === 'telemetry');
        if (telemetry?.type !== 'telemetry') throw new Error('expected a telemetry message');
        expect(telemetry.samples.length).toBeGreaterThan(0);
        expect(telemetry.samples[0]).toEqual(
          expect.objectContaining({
            riderId: profile.id,
            speedKmh: expect.any(Number),
            distanceM: expect.any(Number),
          }),
        );
      } finally {
        ws.close();
      }
    } finally {
      await destroyWorld(world);
    }
  });

  it('dispatches client messages (setBias) to the engine', async () => {
    const world = await buildWorld();
    const ws = await world.app.injectWS('/ws');
    try {
      const profile = await createProfile(world, { name: 'Bias Rider', ftpW: 200, weightKg: 70 });
      const trainer = await findTrainer(world);
      const start = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { riders: [{ profileId: profile.id, trainerId: trainer.id }] },
      });
      expect(start.statusCode).toBe(200);

      ws.send(JSON.stringify({ type: 'setBias', riderId: profile.id, deltaPct: 5 }));
      await waitFor(() => world.ctx.engine.session?.riders[0]?.biasPct === 5, 2000);

      // Invalid messages are ignored without breaking the socket.
      ws.send('not json');
      ws.send(JSON.stringify({ type: 'setBias', riderId: profile.id, deltaPct: 100 }));
      await sleep(150);
      expect(world.ctx.engine.session?.riders[0]?.biasPct).toBe(5);
    } finally {
      ws.close();
      await destroyWorld(world);
    }
  });

  it('broadcasts deviceStatus from driver status events', async () => {
    const world = await buildWorld();
    const ws = await world.app.injectWS('/ws');
    try {
      const messages = collect(world, ws);
      const { trainers } = world.ctx.hub.drivers();
      expect(trainers).toHaveLength(1);

      await trainers[0]!.disconnect(); // emits status 'disconnected'
      await waitFor(() => messages.some((m) => m.type === 'deviceStatus'), 2000);
      const status = messages.find((m) => m.type === 'deviceStatus');
      if (status?.type !== 'deviceStatus') throw new Error('expected a deviceStatus message');
      expect(status.deviceId).toBe(trainers[0]!.id);
      expect(status.kind).toBe('trainer');
      expect(status.status).toBe('disconnected');
    } finally {
      ws.close();
      await destroyWorld(world);
    }
  });

  it('sends an error frame when a client dispatch fails', async () => {
    const world = await buildWorld();
    const ws = await world.app.injectWS('/ws');
    try {
      const messages = collect(world, ws);
      const trainer = await findTrainer(world);

      ws.send(JSON.stringify({ type: 'startSession', riders: [{ profileId: 'ghost', trainerId: trainer.id }] }));
      await waitFor(() => messages.some((m) => m.type === 'error'), 2000);
      const error = messages.find((m) => m.type === 'error');
      if (error?.type !== 'error') throw new Error('expected an error frame');
      expect(error.message).toContain('Unknown profile ghost');

      // the socket stays usable after the error
      const profile = await createProfile(world, { name: 'After Error', ftpW: 200, weightKg: 70 });
      ws.send(JSON.stringify({ type: 'startSession', riders: [{ profileId: profile.id, trainerId: trainer.id }] }));
      await waitFor(() => world.ctx.engine.session?.riders[0]?.riderId === profile.id, 2000);
      expect(messages.filter((m) => m.type === 'error')).toHaveLength(1);
    } finally {
      ws.close();
      await destroyWorld(world);
    }
  });

  it('broadcasts a sessionState null frame when the session ends', async () => {
    const world = await buildWorld();
    try {
      const profile = await createProfile(world, { name: 'Term Rider', ftpW: 200, weightKg: 70 });
      const trainer = await findTrainer(world);
      const start = await world.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { riders: [{ profileId: profile.id, trainerId: trainer.id }] },
      });
      expect(start.statusCode).toBe(200);

      const ws = await world.app.injectWS('/ws');
      try {
        const messages = collect(world, ws);
        await waitFor(() => messages.some((m) => m.type === 'sessionState'), 3000);

        const stop = await world.app.inject({ method: 'POST', url: '/api/sessions/stop' });
        expect(stop.statusCode).toBe(200);
        // The terminal null frame is the LAST sessionState the client sees.
        await waitFor(() => messages.some((m) => m.type === 'sessionState' && m.session === null), 3000);
        const stateFrames = messages.filter((m) => m.type === 'sessionState');
        expect(stateFrames.at(-1)).toEqual({ type: 'sessionState', session: null });
      } finally {
        ws.close();
      }
    } finally {
      await destroyWorld(world);
    }
  });
});
