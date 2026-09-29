import { HrmDriver } from '../driver.js';
import { mulberry32, type SimTrainer } from './simTrainer.js';

export interface SimHrmOptions {
  tickMs?: number;
  seed?: number;
  /** When coupled, HR setpoint tracks the trainer's latest sample power. */
  trainer?: SimTrainer;
}

const DEFAULT_TICK_MS = 1000;
const HR_MIN = 60;
const HR_MAX = 185;
/** Setpoint power used until the coupled trainer reports a sample. */
const DEFAULT_POWER_W = 100;
/** Per-tick drift of HR toward the power-coupled setpoint. */
const HR_DRIFT = 0.05;
/** Uniform HR noise on the emitted sample. */
const HR_NOISE_BPM = 1;
/** Uniform jitter applied to each RR interval. */
const RR_JITTER = 0.02;

export class SimHrm extends HrmDriver {
  readonly id: string;
  readonly name: string;
  private readonly tickMs: number;
  private readonly rand: () => number;
  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private latestPowerW: number = DEFAULT_POWER_W;
  private hr: number;

  constructor(id: string, name: string, opts: SimHrmOptions = {}) {
    super();
    this.id = id;
    this.name = name;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.rand = mulberry32(opts.seed ?? ((Math.random() * 2 ** 32) >>> 0));
    this.hr = this.setpointFor(this.latestPowerW);
    opts.trainer?.on('sample', (sample) => {
      this.latestPowerW = sample.powerW;
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    this.emit('status', { kind: 'connected' });
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

  private setpointFor(powerW: number): number {
    const raw = 60 + 1.4 * Math.sqrt(Math.max(0, powerW));
    return Math.min(HR_MAX, Math.max(HR_MIN, raw));
  }

  private tick(): void {
    if (!this.connected) return;
    const setpoint = this.setpointFor(this.latestPowerW);
    this.hr += (setpoint - this.hr) * HR_DRIFT;
    const bpm = Math.min(
      HR_MAX,
      Math.max(HR_MIN, Math.round(this.hr + (this.rand() * 2 - 1) * HR_NOISE_BPM)),
    );
    const jitter = 1 + (this.rand() * 2 - 1) * RR_JITTER;
    const rrMs = Math.round((60000 / bpm) * jitter);
    this.emit('hr', { bpm, rrMs: [rrMs], ts: Date.now() });
  }
}
