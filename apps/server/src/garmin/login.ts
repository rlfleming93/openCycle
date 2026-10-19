import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { chromium } from 'playwright';

import { GARMIN, garminLoginStatePath } from './connect.js';

export type GarminLoginProgress = 'installing' | 'running';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = join(dirname(require.resolve('playwright/package.json')), 'cli.js');

async function installChromium(): Promise<void> {
  const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'install', 'chromium'], { stdio: 'inherit' });
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  if (code === 0) return;
  const outcome = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
  throw new Error(`Playwright Chromium install failed (${outcome})`);
}

export async function runGarminLogin(
  dataDir: string,
  riderId: string,
  onProgress: (state: GarminLoginProgress) => void,
): Promise<void> {
  const garminDir = join(dataDir, 'garmin');
  const statePath = garminLoginStatePath(dataDir, riderId);
  const profileDir = join(garminDir, `${riderId}.profile`);
  mkdirSync(garminDir, { recursive: true });

  if (!existsSync(chromium.executablePath())) {
    onProgress('installing');
    await installChromium();
    if (!existsSync(chromium.executablePath())) {
      throw new Error('Playwright Chromium is still missing after installation');
    }
  }

  onProgress('running');
  const context = await chromium.launchPersistentContext(profileDir, { headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(GARMIN.signInUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(GARMIN.dashboardUrlGlob, { timeout: 15 * 60 * 1000 });
    await context.storageState({ path: statePath });
  } finally {
    await context.close();
  }
}
