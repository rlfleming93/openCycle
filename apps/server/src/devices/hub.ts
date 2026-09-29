import { EventEmitter } from 'node:events';
import { BleManager } from './ble/manager.js';
import { createSimDevices } from './sim/index.js';
import type { DeviceRegistry } from './registry.js';
import type { HrmDriver, TrainerDriver } from './driver.js';

/**
 * Facade over all device sources (sim + BLE). Emits a driver instance once per
 * discovered device and persists every discovery to the registry.
 */
export class DeviceHub extends EventEmitter<{ trainer: [TrainerDriver]; hrm: [HrmDriver] }> {
  private readonly registry: DeviceRegistry;
  private readonly sim: string | undefined;
  private readonly ble: boolean;
  private readonly trainerDrivers = new Set<TrainerDriver>();
  private readonly hrmDrivers = new Set<HrmDriver>();
  private bleManager: BleManager | undefined;

  constructor(opts: { registry: DeviceRegistry; sim?: string; ble?: boolean }) {
    super();
    this.registry = opts.registry;
    this.sim = opts.sim;
    this.ble = opts.ble !== false;
  }

  async start(): Promise<void> {
    if (this.sim !== undefined) {
      const sim = createSimDevices(this.sim);
      for (const trainer of sim.trainers) this.registerTrainer(trainer);
      for (const hrm of sim.hrms) this.registerHrm(hrm);
    }
    if (this.ble) {
      this.bleManager = new BleManager();
      this.bleManager.on('trainer', (trainer) => this.registerTrainer(trainer));
      this.bleManager.on('hrm', (hrm) => this.registerHrm(hrm));
      await this.bleManager.startScan();
    }
  }

  async stop(): Promise<void> {
    if (this.bleManager !== undefined) {
      try {
        await this.bleManager.dispose();
      } catch {
        // Best effort: a dispose failure must not block driver disconnect.
      }
      this.bleManager = undefined;
    }
    const pending: Promise<void>[] = [];
    for (const trainer of this.trainerDrivers) pending.push(trainer.disconnect());
    for (const hrm of this.hrmDrivers) pending.push(hrm.disconnect());
    await Promise.allSettled(pending);
    // Drop the tracked sets so a stop/start cycle cannot resurrect stale drivers.
    this.trainerDrivers.clear();
    this.hrmDrivers.clear();
  }

  drivers(): { trainers: TrainerDriver[]; hrms: HrmDriver[] } {
    return { trainers: [...this.trainerDrivers], hrms: [...this.hrmDrivers] };
  }

  find(id: string): TrainerDriver | HrmDriver | undefined {
    for (const trainer of this.trainerDrivers) {
      if (trainer.id === id) return trainer;
    }
    for (const hrm of this.hrmDrivers) {
      if (hrm.id === id) return hrm;
    }
    return undefined;
  }

  private registerTrainer(trainer: TrainerDriver): void {
    this.trainerDrivers.add(trainer);
    this.registry.upsertSeen({ id: trainer.id, kind: 'trainer', name: trainer.name });
    this.emit('trainer', trainer);
  }

  private registerHrm(hrm: HrmDriver): void {
    this.hrmDrivers.add(hrm);
    this.registry.upsertSeen({ id: hrm.id, kind: 'hrm', name: hrm.name });
    this.emit('hrm', hrm);
  }
}
