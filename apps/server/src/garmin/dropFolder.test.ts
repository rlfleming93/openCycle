import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Encoder, Profile, type Mesg } from '@garmin/fitsdk';
import { afterEach, describe, expect, it } from 'vitest';

import { openDb, type Db } from '../storage/db.js';
import { watchImportFolder } from './dropFolder.js';

const START_MS = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

/** fitsdk's loose encoder types only accept Mesg; same bridge as recorder.ts. */
function fitMesg(fields: Record<string, unknown>): Mesg {
  return fields as Mesg;
}

/** Minimal decodable cycling FIT: File Id, Session, 1 Hz Records at 200 W. */
function cyclingFit(startMs: number, seconds: number): Buffer {
  const encoder = new Encoder();
  encoder.onMesg(
    Profile.MesgNum.FILE_ID,
    fitMesg({ type: 'activity', manufacturer: 'garmin', product: 0, timeCreated: new Date(startMs) }),
  );
  encoder.onMesg(
    Profile.MesgNum.SESSION,
    fitMesg({
      messageIndex: 0,
      timestamp: new Date(startMs + (seconds - 1) * 1000),
      startTime: new Date(startMs),
      event: 'session',
      eventType: 'stop',
      sport: 'cycling',
      subSport: 'generic',
      totalElapsedTime: seconds - 1,
      totalTimerTime: seconds - 1,
    }),
  );
  for (let i = 0; i < seconds; i++) {
    encoder.onMesg(
      Profile.MesgNum.RECORD,
      fitMesg({ timestamp: new Date(startMs + i * 1000), power: 200, heartRate: 140, distance: i * 10 }),
    );
  }
  return Buffer.from(encoder.close());
}

interface World {
  db: Db;
  dataDir: string;
  importDir: string;
  stop: () => void;
}

const worlds: World[] = [];

afterEach(() => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    if (world === undefined) continue;
    world.stop();
    world.db.close();
    rmSync(world.dataDir, { recursive: true, force: true });
  }
});

async function buildWorld(): Promise<World> {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'opencycle-drop-'));
  const importDir = join(dataDir, 'import');
  const stop = watchImportFolder(db, dataDir, () => {});
  worlds.push({ db, dataDir, importDir, stop });
  return { db, dataDir, importDir, stop };
}

function insertProfile(db: Db, id: string): void {
  db.prepare('INSERT INTO profiles (id, data) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, name: `Rider ${id}`, ftpW: 250, weightKg: 75 }),
  );
}

async function waitForFile(path: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function activityCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n;
}

describe('watchImportFolder', () => {
  it('imports a top-level fit into done/ as an unassigned activity', async () => {
    const world = await buildWorld();
    const fitPath = join(world.importDir, 'ride.fit');
    writeFileSync(fitPath, cyclingFit(START_MS, 30));

    await waitForFile(join(world.importDir, 'done', 'ride.fit'));
    expect(existsSync(fitPath)).toBe(false);
    expect(activityCount(world.db)).toBe(1);
    const row = world.db
      .prepare('SELECT rider_id AS riderId FROM activities')
      .get() as { riderId: string | null };
    expect(row.riderId).toBeNull();
  });

  it('imports files in a per-rider subfolder under that rider', async () => {
    const world = await buildWorld();
    insertProfile(world.db, 'p1');
    const subDir = join(world.importDir, 'p1');
    mkdirSync(subDir, { recursive: true });
    const fitPath = join(subDir, 'ride.fit');
    writeFileSync(fitPath, cyclingFit(START_MS + HOUR_MS, 30));

    await waitForFile(join(world.importDir, 'done', 'ride.fit'));
    const row = world.db.prepare('SELECT rider_id AS riderId FROM activities').get() as {
      riderId: string | null;
    };
    expect(row.riderId).toBe('p1');
  });

  it('moves a duplicate (nothing imported) to failed/ and an unknown subfolder to failed/ with a reason', async () => {
    const world = await buildWorld();
    // A second file with the same activity: skipped -> imported 0 -> failed/.
    const fitPath = join(world.importDir, 'dup.fit');
    writeFileSync(fitPath, cyclingFit(START_MS, 30));
    await waitForFile(join(world.importDir, 'done', 'dup.fit'));
    writeFileSync(join(world.importDir, 'dup2.fit'), cyclingFit(START_MS, 30));
    await waitForFile(join(world.importDir, 'failed', 'dup2.fit'));
    expect(activityCount(world.db)).toBe(1);

    // Unknown rider subfolder: rejected before decoding -> failed/ with .err.txt.
    const ghostDir = join(world.importDir, 'ghost');
    mkdirSync(ghostDir, { recursive: true });
    const ghostPath = join(ghostDir, 'ride.fit');
    writeFileSync(ghostPath, cyclingFit(START_MS + 2 * HOUR_MS, 30));
    await waitForFile(join(world.importDir, 'failed', 'ride.fit'));
    const errText = readFileSync(join(world.importDir, 'failed', 'ride.fit.err.txt'), 'utf8');
    expect(errText).toContain('unknown rider id');
    expect(activityCount(world.db)).toBe(1);
  });
}, 20_000);
