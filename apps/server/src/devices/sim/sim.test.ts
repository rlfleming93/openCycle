import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HrmSample, TrainerSample } from '../driver.js';
import { createSimDevices, parseSimSpec, SimHrm, SimTrainer } from './index.js';

const TICK_MS = 1000;
const SEED = 42;

function collectTrainer(trainer: SimTrainer): TrainerSample[] {
  const samples: TrainerSample[] = [];
  trainer.on('sample', (sample) => samples.push(sample));
  return samples;
}

function collectHrm(hrm: SimHrm): HrmSample[] {
  const samples: HrmSample[] = [];
  hrm.on('hr', (sample) => samples.push(sample));
  return samples;
}

describe('parseSimSpec', () => {
  it('parses NxM specs', () => {
    expect(parseSimSpec('2x2')).toEqual({ trainers: 2, hrms: 2 });
    expect(parseSimSpec('1x4')).toEqual({ trainers: 1, hrms: 4 });
    expect(parseSimSpec('0x0')).toEqual({ trainers: 0, hrms: 0 });
  });

  it('rejects garbage with an error naming the bad spec', () => {
    for (const bad of ['abc', '2', '2x', 'x2', '2 x 2', '2x2x2', '2X2']) {
      expect(() => parseSimSpec(bad)).toThrow(bad);
    }
  });
});

describe('SimTrainer', () => {
  it('rejects setTargetPower when not connected', async () => {
    const trainer = new SimTrainer('sim:trainer:1', 'Sim KICKR 1', { tickMs: TICK_MS, seed: SEED });
    await expect(trainer.setTargetPower(150)).rejects.toThrow('not connected');
    await trainer.connect();
    await expect(trainer.setTargetPower(150)).resolves.toBeUndefined();
    await trainer.disconnect();
    await expect(trainer.setTargetPower(150)).rejects.toThrow('not connected');
  });

  it('converges to the ERG target and re-converges after retargeting', async () => {
    const trainer = new SimTrainer('sim:trainer:1', 'Sim KICKR 1', { tickMs: TICK_MS, seed: SEED });
    const samples = collectTrainer(trainer);
    await trainer.connect();
    await trainer.setTargetPower(150);
    vi.advanceTimersByTime(10 * TICK_MS);
    expect(samples).toHaveLength(10);
    const last = samples.at(-1)!;
    expect(last.powerW).toBeGreaterThanOrEqual(140);
    expect(last.powerW).toBeLessThanOrEqual(160);
    expect(samples[0]!.powerW).toBeLessThan(last.powerW);

    await trainer.setTargetPower(200);
    vi.advanceTimersByTime(10 * TICK_MS);
    expect(samples).toHaveLength(20);
    const retargeted = samples.at(-1)!;
    expect(retargeted.powerW).toBeGreaterThanOrEqual(190);
    expect(retargeted.powerW).toBeLessThanOrEqual(210);
  });

  it('follows the τ = 2 s first-order shape: ≈150·(1−e⁻¹) after 2 ticks', async () => {
    const trainer = new SimTrainer('sim:trainer:1', 'Sim KICKR 1', { tickMs: TICK_MS, seed: SEED });
    const samples = collectTrainer(trainer);
    await trainer.connect();
    await trainer.setTargetPower(150);
    vi.advanceTimersByTime(2 * TICK_MS);
    const expected = 150 * (1 - Math.exp(-1)); // 2 s elapsed at τ = 2 s
    expect(Math.abs(samples.at(-1)!.powerW - expected)).toBeLessThanOrEqual(7);
  });

  it('spins down to 0 W and cadence 0 within 3 ticks when the rider stops', async () => {
    const trainer = new SimTrainer('sim:trainer:1', 'Sim KICKR 1', { tickMs: TICK_MS, seed: SEED });
    const samples = collectTrainer(trainer);
    await trainer.connect();
    await trainer.setTargetPower(150);
    vi.advanceTimersByTime(5 * TICK_MS);
    expect(samples.at(-1)!.powerW).toBeGreaterThan(120);

    trainer.setRiderEffort(0);
    vi.advanceTimersByTime(3 * TICK_MS);
    const stopped = samples.at(-1)!;
    expect(stopped.powerW).toBe(0);
    expect(stopped.cadenceRpm).toBe(0);
    expect(samples.at(-2)!.powerW).toBeLessThan(samples.at(-3)!.powerW);
  });

  it('produces identical sample series for the same seed', async () => {
    const a = new SimTrainer('sim:trainer:1', 'Sim KICKR 1', { tickMs: TICK_MS, seed: 7 });
    const b = new SimTrainer('sim:trainer:2', 'Sim KICKR 2', { tickMs: TICK_MS, seed: 7 });
    const sa = collectTrainer(a);
    const sb = collectTrainer(b);
    await a.connect();
    await b.connect();
    await a.setTargetPower(120);
    await b.setTargetPower(120);
    vi.advanceTimersByTime(8 * TICK_MS);
    a.setRiderEffort(0);
    b.setRiderEffort(0);
    vi.advanceTimersByTime(3 * TICK_MS);

    const series = (samples: TrainerSample[]) =>
      samples.map((s) => [s.powerW, s.cadenceRpm, s.ts]);
    expect(series(sa)).toEqual(series(sb));
  });
});

describe('createSimDevices', () => {
  it('builds N trainers and M hrms with stable ids and names', () => {
    const { trainers, hrms } = createSimDevices('2x3', { seed: 1 });
    expect(trainers.map((t) => [t.id, t.name])).toEqual([
      ['sim:trainer:1', 'Sim KICKR 1'],
      ['sim:trainer:2', 'Sim KICKR 2'],
    ]);
    expect(hrms.map((h) => [h.id, h.name])).toEqual([
      ['sim:hrm:1', 'Sim HRM 1'],
      ['sim:hrm:2', 'Sim HRM 2'],
      ['sim:hrm:3', 'Sim HRM 3'],
    ]);
  });
});

describe('SimHrm', () => {
  it('tracks a power-coupled setpoint, stays in 60-185, and emits sane RR', async () => {
    const { trainers, hrms } = createSimDevices('2x2', { tickMs: TICK_MS, seed: SEED });
    const trainer = trainers[0]!;
    const hrm = hrms[0]!;
    const samples = collectHrm(hrm);
    await trainer.connect();
    await hrm.connect();

    await trainer.setTargetPower(300);
    vi.advanceTimersByTime(60 * TICK_MS);
    const setpoint300 = 60 + 1.4 * Math.sqrt(300); // ≈ 84.2
    const avgHigh = samples.slice(-5).reduce((sum, s) => sum + s.bpm, 0) / 5;
    expect(Math.abs(avgHigh - setpoint300)).toBeLessThanOrEqual(3);

    await trainer.setTargetPower(100);
    vi.advanceTimersByTime(60 * TICK_MS);
    const setpoint100 = 60 + 1.4 * Math.sqrt(100); // 74
    const avgLow = samples.slice(-5).reduce((sum, s) => sum + s.bpm, 0) / 5;
    expect(Math.abs(avgLow - setpoint100)).toBeLessThanOrEqual(3);
    expect(avgHigh).toBeGreaterThan(avgLow);

    for (const s of samples) {
      expect(s.bpm).toBeGreaterThanOrEqual(60);
      expect(s.bpm).toBeLessThanOrEqual(185);
      const expectedRr = 60000 / s.bpm;
      expect(Math.abs(s.rrMs[0]! - expectedRr)).toBeLessThanOrEqual(0.05 * expectedRr);
    }
  });
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});
