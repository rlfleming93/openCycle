import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { GARMIN } from '../src/garmin/connect.js';

const USAGE = `Usage: pnpm --filter @opencycle/server exec tsx scripts/garmin-login.ts --rider <id>

Opens a headed Chromium window on the Garmin Connect sign-in page. Complete
the login (and any MFA) yourself; the script polls until the modern dashboard
loads (15 min cap), then saves the Playwright storage state to
<OPENCYCLE_DATA_DIR>/garmin/<riderId>.json (default ~/.opencycle/garmin/).
Re-running overwrites the saved state.`;

interface CliArgs {
  riderId: string;
}

function parseArgs(argv: string[]): CliArgs {
  let riderId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--rider': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--rider requires an argument (profile id)');
        riderId = value;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (riderId === undefined) throw new Error('--rider <id> is required');
  return { riderId };
}

async function main(): Promise<void> {
  const { riderId } = parseArgs(process.argv.slice(2));
  const dataDir = process.env.OPENCYCLE_DATA_DIR ?? join(homedir(), '.opencycle');
  const garminDir = join(dataDir, 'garmin');
  const statePath = join(garminDir, `${riderId}.json`);
  // Persistent profile keeps the session cookies warm across logins.
  const profileDir = join(garminDir, `${riderId}.profile`);
  mkdirSync(garminDir, { recursive: true });

  console.log(`Signing in to Garmin Connect for rider "${riderId}".`);
  console.log('A browser window opens — complete the login and any MFA there.');
  console.log('The script waits until the Garmin Connect dashboard loads, then saves login state to:');
  console.log(`  ${statePath}`);

  const context = await chromium.launchPersistentContext(profileDir, { headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(GARMIN.signInUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(GARMIN.dashboardUrlGlob, { timeout: 15 * 60 * 1000 });
    await context.storageState({ path: statePath });
    console.log(`Signed in. Login state saved to: ${statePath}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
