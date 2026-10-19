import { homedir } from 'node:os';
import { join } from 'node:path';

import { garminLoginStatePath } from '../src/garmin/connect.js';
import { runGarminLogin } from '../src/garmin/login.js';

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
  const statePath = garminLoginStatePath(dataDir, riderId);

  console.log(`Signing in to Garmin Connect for rider "${riderId}".`);
  console.log('A browser window opens — complete the login and any MFA there.');
  console.log('The script waits until the Garmin Connect dashboard loads, then saves login state to:');
  console.log(`  ${statePath}`);

  await runGarminLogin(dataDir, riderId, (state) => {
    if (state === 'installing') console.log('Chromium is not installed. Installing it now.');
  });
  console.log(`Signed in. Login state saved to: ${statePath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
