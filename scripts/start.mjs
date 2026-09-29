#!/usr/bin/env node
// Terminal entry point for the production server: one process, one port, the
// built UI served by the server itself. `pnpm start` and `pnpm demo` land
// here; the Mac app starts the server directly (packaging/macos/launcher.swift)
// but keeps the same environment contract (NODE_ENV=production +
// OPENCYCLE_WEB_DIR).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIR = join(REPO, 'apps/web/dist');
const SERVER_DIR = join(REPO, 'apps/server');
const HEALTH_URL = 'http://127.0.0.1:4000/healthz';
const RIDE_URL = 'http://localhost:4000';

/** `--name value` pairs and `--flag[=value]` booleans, no dependency. */
function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/, 2);
    const next = argv[i + 1];
    if (inlineValue !== undefined) flags.set(rawName, inlineValue);
    else if (next !== undefined && !next.startsWith('--')) {
      flags.set(rawName, next);
      i += 1;
    } else flags.set(rawName, true);
  }
  return flags;
}

/** Newest mtime of every file under a path (0 when the path is missing). */
function newestMtime(path) {
  let mtime = 0;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    mtime = Math.max(mtime, newestMtime(child));
  }
  return mtime;
}

/** True when apps/web/dist exists and is newer than every UI source file. */
function webBuildIsFresh() {
  if (!existsSync(join(WEB_DIR, 'index.html'))) return false;
  const buildTime = statSync(join(WEB_DIR, 'index.html')).mtimeMs;
  const sources = [
    join(REPO, 'apps/web/src'),
    join(REPO, 'apps/web/public'),
    join(REPO, 'apps/web/index.html'),
    join(REPO, 'apps/web/vite.config.ts'),
    join(REPO, 'apps/web/package.json'),
    join(REPO, 'packages/shared/src'),
  ];
  return sources.every((source) => newestMtime(source) <= buildTime);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

async function healthz() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await healthz()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** `open` on macOS, `xdg-open` elsewhere: the one platform detail in here. */
function openBrowser() {
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [RIDE_URL], { stdio: 'ignore' });
}

const flags = parseArgs(process.argv.slice(2));
if (flags.has('help')) {
  console.log(`openCycle: run the server with the built UI on http://localhost:4000

  pnpm start            build the UI if needed, then serve it
  pnpm demo             same, with simulated trainers and a temp data dir

  --sim[=2x2]           add simulated trainers/HRMs (default 2x2)
  --ble                 scan for real Bluetooth devices (OPENCYCLE_BLE=1)
  --data-dir <path>     where the database and FIT files live
  --web-dir <path>      serve a different UI build (default apps/web/dist)
  --demo                shorthand for --sim=2x2 plus a temp data dir
  --open                open the browser once the server is up
  --no-build            never run the web build
`);
  process.exit(0);
}

const demo = flags.has('demo');
const sim = flags.get('sim') ?? (demo ? '2x2' : undefined);
const dataDir = flags.get('data-dir') ?? (demo ? mkdtempSync(join(tmpdir(), 'opencycle-demo-')) : undefined);

const env = {
  ...process.env,
  NODE_ENV: 'production',
  OPENCYCLE_WEB_DIR: flags.get('web-dir') ?? process.env.OPENCYCLE_WEB_DIR ?? WEB_DIR,
};
if (flags.has('ble')) env.OPENCYCLE_BLE = '1';
if (typeof sim === 'string') env.OPENCYCLE_SIM = sim;
if (typeof dataDir === 'string') env.OPENCYCLE_DATA_DIR = dataDir;

if (!flags.has('no-build') && !webBuildIsFresh()) {
  console.log('[start] building the web client (apps/web/dist is missing or older than its sources)');
  await run('pnpm', ['build']);
}
if (!existsSync(join(env.OPENCYCLE_WEB_DIR, 'index.html'))) {
  console.error(`[start] no web build at ${env.OPENCYCLE_WEB_DIR} — run \`pnpm build\``);
  process.exit(1);
}

// Another openCycle (the Mac app, an earlier `pnpm start`) already owns the
// port: point at it rather than crash into EADDRINUSE.
if (await healthz()) {
  console.log(`openCycle is already running at ${RIDE_URL}`);
  if (flags.has('open')) openBrowser();
  process.exit(0);
}

// tsx is loaded into the server process itself (`node --import tsx`), so
// SIGTERM from a terminal, a script or the Mac app reaches the server
// directly and its graceful shutdown (finalize FIT, close DB) actually runs.
const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: SERVER_DIR,
  env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

if (!(await waitForServer(server))) {
  if (server.exitCode === null) console.error('[start] the server did not come up within 60s');
  else if (server.exitCode !== 0) console.error('[start] the server exited; is port 4000 already in use?');
  server.kill('SIGTERM');
  process.exit(server.exitCode ?? 1);
}

console.log(`openCycle is running at ${RIDE_URL}`);
if (typeof sim === 'string') console.log(`[start] simulated devices: ${sim}`);
if (typeof dataDir === 'string') console.log(`[start] data dir: ${dataDir}`);
if (flags.has('open')) openBrowser();

process.exitCode =
  server.exitCode ??
  (await new Promise((resolve) => server.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))));
