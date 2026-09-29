import { SimHrm } from './simHrm.js';
import { SimTrainer } from './simTrainer.js';

export { SimHrm } from './simHrm.js';
export { SimTrainer } from './simTrainer.js';

export interface SimDeviceOptions {
  tickMs?: number;
  seed?: number;
}

const SIM_SPEC_RE = /^(\d+)x(\d+)$/;

/** Parses a "NxM" sim spec: N trainers × M HRMs. Throws on anything else. */
export function parseSimSpec(spec: string): { trainers: number; hrms: number } {
  const match = SIM_SPEC_RE.exec(spec);
  if (match === null) {
    throw new Error(`Invalid sim spec "${spec}": expected "NxM", e.g. "2x2"`);
  }
  return { trainers: Number(match[1]), hrms: Number(match[2]) };
}

/** Builds sim devices; each HRM is coupled to the same-index trainer when present. */
export function createSimDevices(
  spec: string,
  opts: SimDeviceOptions = {},
): { trainers: SimTrainer[]; hrms: SimHrm[] } {
  const { trainers: trainerCount, hrms: hrmCount } = parseSimSpec(spec);
  const baseSeed = opts.seed ?? ((Math.random() * 2 ** 32) >>> 0);
  const trainers: SimTrainer[] = [];
  for (let i = 1; i <= trainerCount; i++) {
    trainers.push(
      new SimTrainer(`sim:trainer:${i}`, `Sim KICKR ${i}`, {
        tickMs: opts.tickMs,
        seed: baseSeed + i,
      }),
    );
  }
  const hrms: SimHrm[] = [];
  // HRM seeds use a family offset so trainer/hrm PRNG streams never collide.
  for (let i = 1; i <= hrmCount; i++) {
    hrms.push(
      new SimHrm(`sim:hrm:${i}`, `Sim HRM ${i}`, {
        tickMs: opts.tickMs,
        seed: baseSeed + 1000 + i,
        trainer: trainers[i - 1],
      }),
    );
  }
  return { trainers, hrms };
}
