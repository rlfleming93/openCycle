import { openDb } from '../src/storage/db.js';
import { DeviceHub } from '../src/devices/hub.js';
import { DeviceRegistry } from '../src/devices/registry.js';
import type { HrmDriver, TrainerDriver } from '../src/devices/driver.js';

const USAGE = `Usage: pnpm --filter @opencycle/server exec tsx scripts/probe.ts [flags]

Flags:
  --real            BLE only, no sim: scan for real FTMS trainers and HR straps
  --sim NxM         sim devices, e.g. 2x2 (default: 2x2 when --real is absent)
  --watts a,b,c     ERG target steps in watts (default: 100,150)
  --hold SECONDS    hold time per ERG step (default: 20)`;

const REAL_BANNER = `--real preconditions (docs/ble-protocol.md, "KICKR CORE specifics") --
* CORE firmware >= 1.1.1 required for FTMS (prefer >= 1.5.36)
* Close Zwift / Zwift Companion; close the Wahoo app or set it Passive
  (a CORE allows 3 BLE centrals but exactly ONE controller)
* If a trainer does not advertise, power-cycle it ~30 s to drop stale centrals
* One-time: disable "ERG Mode Power Smoothing" in the Wahoo app (it rewrites broadcast watts)`;

interface CliArgs {
  real: boolean;
  sim: string | undefined;
  watts: number[] | undefined;
  holdS: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { real: false, sim: undefined, watts: undefined, holdS: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--real':
        args.real = true;
        break;
      case '--sim': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--sim requires an argument (NxM)');
        args.sim = value;
        break;
      }
      case '--watts': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--watts requires an argument (a,b,c)');
        const watts = value.split(',').map((part) => Number(part.trim()));
        if (watts.length === 0 || watts.some((w) => !Number.isFinite(w) || w <= 0)) {
          throw new Error(`invalid --watts value: ${value}`);
        }
        args.watts = watts;
        break;
      }
      case '--hold': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--hold requires an argument (seconds)');
        const holdS = Number(value);
        if (!Number.isFinite(holdS) || holdS <= 0) throw new Error(`invalid --hold value: ${value}`);
        args.holdS = holdS;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.real && args.sim !== undefined) {
    throw new Error('--real and --sim are mutually exclusive');
  }
  return args;
}

const LINE_WIDTH = 100;

function render(text: string): string {
  return text.slice(0, LINE_WIDTH).padEnd(LINE_WIDTH);
}

/** Overwrite the streaming single line. */
function stream(text: string): void {
  process.stdout.write(`\r${render(text)}`);
}

/** Print a full line, breaking out of the streaming line. */
function println(text: string): void {
  process.stdout.write(`\r${render(text)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let interrupted = false;
let shuttingDown = false;
let lastDiscovery = Date.now();

function onSignal(): void {
  interrupted = true;
  if (shuttingDown) process.exit(130);
}

const CONNECT_TIMEOUT_MS = 20_000;

async function connect(d: TrainerDriver | HrmDriver, kind: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CONNECT_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([d.connect().then(() => 'connected' as const), timeout]);
    if (result === 'timeout') {
      println(`[${kind} ${d.id}] connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s; continuing without it`);
    }
  } catch (err) {
    println(`[${kind} ${d.id}] connect failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDiscovery(real: boolean, trainers: TrainerDriver[]): Promise<void> {
  if (!real) return; // sim devices are emitted synchronously during hub.start()
  const deadline = Date.now() + 30_000;
  while (!interrupted && Date.now() < deadline) {
    if (trainers.length > 0 && Date.now() - lastDiscovery >= 3_000) return;
    await sleep(250);
  }
}

async function hold(seconds: number): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (!interrupted && Date.now() < end) await sleep(200);
}

async function runErg(trainers: TrainerDriver[], watts: number[], holdS: number): Promise<void> {
  for (const w of watts) {
    if (interrupted) break;
    println(`ERG: setting ${trainers.length} trainer(s) to ${w} W for ${holdS}s`);
    await Promise.allSettled(
      trainers.map((t) =>
        t.setTargetPower(w).catch((err) =>
          println(`[trainer ${t.id}] setTargetPower(${w}) failed: ${err instanceof Error ? err.message : String(err)}`),
        ),
      ),
    );
    await hold(holdS);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sim = args.real ? undefined : (args.sim ?? '2x2');
  const watts = args.watts ?? [100, 150];
  const holdS = args.holdS ?? 20;

  if (args.real) println(REAL_BANNER);

  const db = openDb();
  const registry = new DeviceRegistry(db);
  const hub = new DeviceHub({ registry, sim, ble: args.real });

  const trainers: TrainerDriver[] = [];
  const hrms: HrmDriver[] = [];
  const connects: Promise<void>[] = [];

  hub.on('trainer', (trainer) => {
    trainers.push(trainer);
    lastDiscovery = Date.now();
    println(`discovered trainer ${trainer.id} (${trainer.name})`);
    trainer.on('status', (s) =>
      println(`[trainer ${trainer.id}] status: ${s.kind}${s.message !== undefined ? ` (${s.message})` : ''}`),
    );
    trainer.on('sample', (s) =>
      stream(`[trainer ${trainer.id}] ${Math.round(s.powerW)} W  ${Math.round(s.cadenceRpm)} rpm`),
    );
    connects.push(connect(trainer, 'trainer'));
  });

  hub.on('hrm', (hrm) => {
    hrms.push(hrm);
    println(`discovered hrm ${hrm.id} (${hrm.name})`);
    hrm.on('status', (s) =>
      println(`[hrm ${hrm.id}] status: ${s.kind}${s.message !== undefined ? ` (${s.message})` : ''}`),
    );
    hrm.on('hr', (s) => stream(`[hrm ${hrm.id}] ${s.bpm} bpm`));
    connects.push(connect(hrm, 'hrm'));
  });

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await hub.start();
    println(`hub started (sim=${sim ?? 'none'}, ble=${args.real})`);

    await waitForDiscovery(args.real, trainers);
    // Drain late discoveries (e.g. HRMs advertising after the trainer that
    // ended the discovery wait): keep awaiting until no connect is pending.
    for (let settled = 0; settled < connects.length && !interrupted; settled = connects.length) {
      await Promise.all(connects.slice(settled));
    }
    println(`connected ${trainers.length} trainer(s), ${hrms.length} hrm(s)`);

    if (trainers.length > 0) {
      if (!interrupted) await runErg(trainers, watts, holdS);
    } else {
      println('no trainers discovered; skipping ERG sequence');
    }
  } finally {
    shuttingDown = true;
    await hub.stop();
    db.close();
  }
  println('probe complete');
  process.exit(0);
}

main().catch((err) => {
  println(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  println(USAGE);
  process.exit(2);
});
