import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import chokidar from 'chokidar';

import type { Db } from '../storage/db.js';
import { importFitBuffer, importGarminZip, type ImportResult } from './zipImport.js';

const IMPORT_FILE_RE = /\.(fit|zip)$/i;

/**
 * Watches <dataDir>/import (depth 1) for dropped .fit / .zip files and
 * imports each via the shared Garmin import paths. Files at the top level are
 * unassigned; files in a per-rider subfolder (<import>/<riderId>/) import
 * under that rider (the folder name must be an existing profile id — anything
 * else lands in failed/ with the reason). A file counts as imported when at
 * least one activity landed (imported > 0): it moves to import/done/ with a
 * .err.txt beside it when some files failed; a file that imported nothing
 * moves to import/failed/. Returns a disposer that stops the watcher.
 */
export function watchImportFolder(db: Db, dataDir: string, log: (message: string) => void): () => void {
  const importDir = join(dataDir, 'import');
  const doneDir = join(importDir, 'done');
  const failedDir = join(importDir, 'failed');
  for (const dir of [importDir, doneDir, failedDir]) mkdirSync(dir, { recursive: true });

  // depth 1: files dropped directly into import/ and one level down
  // (per-rider subfolders), never the done/failed subdirectories we write to
  // (those are excluded in the add handler or they would re-trigger the
  // watcher forever). ignoreInitial: false — files left in the folder while
  // the server was down are picked up on startup, not silently skipped.
  const watcher = chokidar.watch(importDir, {
    depth: 1,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1_000, pollInterval: 100 },
  });
  watcher.on('add', (filePath: string) => {
    const riderId = importRiderId(filePath, importDir);
    if (riderId === undefined) return; // inside done/failed or deeper — not ours
    if (!IMPORT_FILE_RE.test(filePath)) return;
    void handleImportFile(db, filePath, riderId, importDir, log).catch((err: unknown) => {
      log(`Import ${filePath} failed: ${errorMessage(err)}`);
    });
  });
  watcher.on('error', (err: unknown) => {
    log(`Import watcher error: ${errorMessage(err)}`);
  });
  return () => {
    void watcher.close();
  };
}

/**
 * Rider id implied by the file's location: null for top-level files, the
 * subfolder name for depth-1 subfolders, undefined for done/failed or deeper
 * paths (outside the import surface).
 */
function importRiderId(filePath: string, importDir: string): string | null | undefined {
  const parent = dirname(filePath);
  if (parent === importDir) return null;
  if (dirname(parent) === importDir) {
    const folder = basename(parent);
    if (folder === 'done' || folder === 'failed') return undefined;
    return folder;
  }
  return undefined;
}

async function handleImportFile(
  db: Db,
  filePath: string,
  riderId: string | null,
  importDir: string,
  log: (message: string) => void,
): Promise<void> {
  let result: ImportResult;
  try {
    if (riderId !== null && db.prepare('SELECT id FROM profiles WHERE id = ?').get(riderId) === undefined) {
      throw new Error(`unknown rider id in import subfolder: ${riderId}`);
    }
    const buf = readFileSync(filePath);
    result = ZIP_RE.test(filePath)
      ? importGarminZip(db, buf, riderId)
      : importSingleFit(db, buf, riderId);
  } catch (err) {
    result = { imported: 0, skipped: 0, errors: [errorMessage(err)] };
  }

  const failed = result.imported === 0;
  const targetPath = join(importDir, failed ? 'failed' : 'done', basename(filePath));
  try {
    renameSync(filePath, targetPath);
    if (result.errors.length > 0) writeFileSync(`${targetPath}.err.txt`, result.errors.join('\n'), 'utf8');
  } catch (err) {
    log(`Move ${filePath} to ${dirname(targetPath)} failed: ${errorMessage(err)}`);
    return;
  }
  log(
    `Imported ${basename(filePath)}${riderId === null ? '' : ` for rider ${riderId}`}: ` +
      `imported=${result.imported} skipped=${result.skipped}` +
      (result.errors.length > 0 ? ` errors=${result.errors.join('; ')}` : ''),
  );
}

function importSingleFit(db: Db, buf: Buffer, riderId: string | null): ImportResult {
  try {
    const outcome = importFitBuffer(db, buf, 'garmin-fit', [], riderId);
    return outcome.outcome === 'imported'
      ? { imported: 1, skipped: 0, errors: [] }
      : { imported: 0, skipped: 1, errors: [] };
  } catch (err) {
    return { imported: 0, skipped: 0, errors: [errorMessage(err)] };
  }
}

const ZIP_RE = /\.zip$/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
