import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import websocket from '@fastify/websocket';

import { registerActivitiesRoutes } from './api/activitiesRoutes.js';
import { registerDiscoveriesRoutes } from './api/discoveriesRoutes.js';
import { registerGarminRoutes } from './api/garminRoutes.js';
import { registerPlansRoutes } from './api/plansRoutes.js';
import { registerRoutes, WorkoutLibrary } from './api/routes.js';
import { registerTrainingRoutes } from './api/trainingRoutes.js';
import { registerVoyageRoutes } from './api/voyageRoutes.js';
import { registerWs } from './api/ws.js';
import { attachDiscoveries } from './game/discoveries.js';
import { attachVoyage } from './game/voyage.js';
import { GarminConnector } from './garmin/connect.js';
import { watchImportFolder } from './garmin/dropFolder.js';
import { attachAutoUpload, UploadQueue } from './garmin/uploadQueue.js';
import { importGarminZip } from './garmin/zipImport.js';
import { DeviceHub } from './devices/hub.js';
import { DeviceRegistry } from './devices/registry.js';
import { SessionEngine } from './session/engine.js';
import { Recorder } from './session/recorder.js';
import { openDb } from './storage/db.js';

const app = Fastify({ logger: true });
await app.register(websocket);

// Data + ride files live under OPENCYCLE_DATA_DIR (default ~/.opencycle);
// curated workouts come from the repo's data/plans directory.
const dataDir = process.env.OPENCYCLE_DATA_DIR ?? join(homedir(), '.opencycle');
const plansDir = fileURLToPath(new URL('../../../data/plans/', import.meta.url));

const db = openDb();
const registry = new DeviceRegistry(db);
// Sim devices from OPENCYCLE_SIM (e.g. '2x2'); unset → no sim. Real BLE is
// opt-in via OPENCYCLE_BLE=1 for now; Phase 3's session engine owns scanning.
const sim = process.env.OPENCYCLE_SIM;
const ble = process.env.OPENCYCLE_BLE === '1';
const hub = new DeviceHub({ registry, sim, ble });
app.decorate('deviceHub', hub);

hub.on('trainer', (trainer) => {
  app.log.info({ id: trainer.id, name: trainer.name }, 'trainer discovered');
  // The session engine never connects drivers; the app owns device
  // lifecycle. Connect on discovery so sim devices emit samples and BLE
  // trainers acquire their GATT link (connect is idempotent).
  void trainer.connect().catch((err: unknown) => {
    app.log.warn({ err, id: trainer.id }, 'trainer connect failed');
  });
});
hub.on('hrm', (hrm) => {
  app.log.info({ id: hrm.id, name: hrm.name }, 'hrm discovered');
  void hrm.connect().catch((err: unknown) => {
    app.log.warn({ err, id: hrm.id }, 'hrm connect failed');
  });
});

const recorder = new Recorder(db, dataDir);
const engine = new SessionEngine({ findDriver: (id) => hub.find(id), recorder });
const workoutLibrary = new WorkoutLibrary(db, plansDir, (message) => app.log.warn({ message }, 'workout library'));
const ctx = { db, registry, engine, recorder, hub, workoutLibrary };
registerRoutes(app, ctx);
registerWs(app, ctx);

// Phase 5: Garmin import/sync + training/plan routes.
const garmin = new GarminConnector(dataDir, app.log);
const uploadQueue = new UploadQueue(db, garmin, (message) => app.log.info({ message }, 'garmin queue'));
attachAutoUpload(engine, db, uploadQueue);
registerActivitiesRoutes(app, { db, engine, importZip: (buf, riderId) => importGarminZip(db, buf, riderId) });
registerGarminRoutes(app, { db, queue: uploadQueue, connector: garmin, engine });
registerTrainingRoutes(app, { db });
registerPlansRoutes(app, { db, workoutLibrary });
const stopImportWatcher = watchImportFolder(db, dataDir, (message) => app.log.info({ message }, 'import folder'));

// Phase 6: co-op game discoveries — beacons + rescues materialized from engine
// events; stays subscribed for the process lifetime (sessions change).
attachDiscoveries(engine, db, (message) => app.log.info({ message }, 'discoveries'));
registerDiscoveriesRoutes(app, { db });

// Voyage: every finisher's arrived systems are logged from engine events and
// served per rider.
attachVoyage(engine, db, (message) => app.log.info({ message }, 'voyage'));
registerVoyageRoutes(app, { db });

app.get('/healthz', async () => ({ ok: true }));

app.addHook('onClose', async () => {
  stopImportWatcher();
  // Stop riders (finalizing their rides), flush any buffered samples, then
  // disconnect devices; the DB closes last so every write lands.
  await engine.stopSession();
  await recorder.flush();
  await hub.stop();
  db.close();
});

// Bind on every interface by default (phones/tablets on the same LAN control
// the session); OPENCYCLE_HOST narrows it to one address.
const host = process.env.OPENCYCLE_HOST ?? '0.0.0.0';
const port = 4000;

// Real signal handling: close the app so the onClose hook (engine stop +
// recorder flush + hub.stop + db.close) runs on Ctrl-C; exit only after the
// graceful teardown settled.
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  // Start the device hub first so a bad OPENCYCLE_SIM spec or a BLE
  // power-on timeout fails fast instead of leaving a half-up server window.
  await hub.start();
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
