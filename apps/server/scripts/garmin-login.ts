import { homedir } from 'node:os';
import { join } from 'node:path';

import { garminLoginStatePath } from '../src/garmin/connect.js';
import { runGarminLogin } from '../src/garmin/login.js';

const USAGE = `Usage: pnpm --filter @opencycle/server exec tsx scripts/garmin-login.ts --rider <id>

Opens a Chrome window on Garmin's sign-in page. Sign in and do any MFA
yourself (15 min cap). The window closes once Garmin hands over the sign-in,
and the token pair is saved to <OPENCYCLE_DATA_DIR>/garmin/<riderId>.json
(default ~/.opencycle/garmin/). Re-running replaces it.`;

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
  console.log('A Chrome window opens. Sign in and do any MFA there.');
  console.log('When Garmin accepts the sign-in, the window closes and the login is saved to:');
  console.log(`  ${statePath}`);

  await runGarminLogin(dataDir, riderId, (state) => {
    if (state === 'installing') console.log('Chrome is not installed. Installing Chromium now.');
  });
  console.log(`Signed in. Login state saved to: ${statePath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
