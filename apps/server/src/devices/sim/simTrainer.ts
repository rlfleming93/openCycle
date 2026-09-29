import { TrainerDriver } from '../driver.js';

/** Deterministic 32-bit PRNG (mulberry32). Same seed -> same sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimTrainerOptions {
  tickMs?: number;
  seed?: number;
}

const DEFAULT_TICK_MS = 1000;
/** First-order response time, matching measured KICKR CORE behavior. */
const TIME_CONSTANT_MS = 2000;
/** Uniform power noise on the emitted sample. */
const POWER_NOISE_W = 3;
/** Uniform cadence drift around the rider's cadence. */
const CADENCE_NOISE_RPM = 5;
/** Per-tick spin-down once the rider stops (reaches round(0) within ~2 ticks). */
const STOPPED_DECAY = 0.05;

export class SimTrainer extends TrainerDriver {
  readonly id: string;
  readonly name: string;
  private readonly tickMs: number;
  private readonly rand: () => number;
  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private targetW = 0;
  private currentW = 0;
  private riderCadence = 90;

  constructor(id: string, name: string, opts: SimTrainerOptions = {}) {
    super();
    this.id = id;
    this.name = name;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.rand = mulberry32(opts.seed ?? ((Math.random() * 2 ** 32) >>> 0));
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    this.emit('status', { kind: 'connected' });
    this.emit('status', { kind: 'controlAcquired' });
    const timer = setInterval(() => this.tick(), this.tickMs);
    timer.unref();
    this.timer = timer;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('status', { kind: 'disconnected' });
  }

  /** Rejects when not connected, matching the BLE driver contract. */
  async setTargetPower(watts: number): Promise<void> {
    if (!this.connected) throw new Error('not connected');
    this.targetW = Math.max(0, watts);
  }

  /** 0 = rider stops pedaling; the trainer cannot force power. */
  setRiderEffort(cadenceRpm: number): void {
    this.riderCadence = Math.max(0, cadenceRpm);
  }

  private tick(): void {
    if (!this.connected) return;
    const ts = Date.now();
    if (this.riderCadence === 0) {
      this.currentW = Math.max(0, this.currentW * STOPPED_DECAY);
      this.emit('sample', {
        powerW: Math.max(0, Math.round(this.currentW)),
        cadenceRpm: 0,
        ts,
      });
      return;
    }
    const lag = 1 - Math.exp(-this.tickMs / TIME_CONSTANT_MS);
    this.currentW += (this.targetW - this.currentW) * lag;
    const noiseW = (this.rand() * 2 - 1) * POWER_NOISE_W;
    const drift = (this.rand() * 2 - 1) * CADENCE_NOISE_RPM;
    const cadence = Math.min(
      Math.max(this.riderCadence + drift, this.riderCadence - CADENCE_NOISE_RPM),
      this.riderCadence + CADENCE_NOISE_RPM,
    );
    this.emit('sample', {
      powerW: Math.max(0, Math.round(this.currentW + noiseW)),
      cadenceRpm: Math.round(cadence),
      ts,
    });
  }
}
