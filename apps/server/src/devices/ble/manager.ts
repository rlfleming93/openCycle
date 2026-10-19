// BLE manager: scans for FTMS trainers and HRS straps and emits one driver
// instance per discovered peripheral id. Runs on @stoprocent/noble
// (CoreBluetooth); a fake noble can be injected for tests.

import { EventEmitter } from 'node:events';
import noble, { type AdapterState as NobleAdapterState, type Noble, type Peripheral } from '@stoprocent/noble';
import { HrmDriver, TrainerDriver } from '../driver.js';
import { FTMS_SERVICE_UUID } from './ftms.js';
import { HRS_SERVICE_UUID } from './hrs.js';
import { BleHrmDriver, BleTrainerDriver, isUuid } from './trainer.js';

const SCAN_SERVICE_UUIDS = [FTMS_SERVICE_UUID, HRS_SERVICE_UUID];

export interface BleManagerEvents {
  trainer: [TrainerDriver];
  hrm: [HrmDriver];
  adapter: [NobleAdapterState];
  state: [string];
}

export class BleManager extends EventEmitter<BleManagerEvents> {
  private readonly noble: Noble;
  private readonly drivers = new Map<string, TrainerDriver | HrmDriver>();
  private adapter: NobleAdapterState;
  private scanning = false;
  private scanRequested = false;
  private scanStart: Promise<void> | undefined;
  private restartAfterStart = false;

  constructor(opts?: { noble?: Noble }) {
    super();
    this.noble = opts?.noble ?? noble;
    this.adapter = this.noble.state;
    this.noble.on('discover', this.handleDiscover);
    this.noble.on('stateChange', this.handleStateChange);
  }

  adapterState(): NobleAdapterState {
    return this.adapter;
  }

  /** Release the noble listeners and stop scanning; idempotent. */
  async dispose(): Promise<void> {
    this.noble.off('discover', this.handleDiscover);
    this.noble.off('stateChange', this.handleStateChange);
    try {
      await this.stopScan();
    } catch {
      // Best effort: a stopScan failure must not block shutdown.
    }
  }

  /** Request FTMS + HRS scanning now or when the adapter becomes available. */
  async startScan(): Promise<void> {
    this.scanRequested = true;
    if (this.adapter !== 'poweredOn') return;
    await this.ensureScanning();
  }

  async stopScan(): Promise<void> {
    this.scanRequested = false;
    if (this.scanStart !== undefined) await this.scanStart.catch(() => {});
    if (!this.scanning) return;
    await this.noble.stopScanningAsync();
    this.scanning = false;
    this.emit('state', 'idle');
  }

  private ensureScanning(): Promise<void> {
    if (this.scanning) return Promise.resolve();
    if (this.scanStart !== undefined) return this.scanStart;
    const pending: Promise<void> = this.startScanning().finally(() => {
      if (this.scanStart === pending) this.scanStart = undefined;
      const restart = this.restartAfterStart;
      this.restartAfterStart = false;
      if (restart && this.scanRequested && this.adapter === 'poweredOn') {
        void this.ensureScanning().catch(() => {});
      }
    });
    this.scanStart = pending;
    return pending;
  }

  private async startScanning(): Promise<void> {
    await this.noble.startScanningAsync(SCAN_SERVICE_UUIDS, false);
    if (this.restartAfterStart || !this.scanRequested || this.adapter !== 'poweredOn') {
      await this.noble.stopScanningAsync().catch(() => {});
      return;
    }
    this.scanning = true;
    this.emit('state', 'scanning');
  }

  private readonly handleStateChange = (state: NobleAdapterState): void => {
    this.adapter = state;
    this.emit('adapter', state);
    if (state === 'poweredOn') {
      if (this.scanRequested) void this.ensureScanning().catch(() => {});
      return;
    }
    if (this.scanStart !== undefined) this.restartAfterStart = true;
    if (this.scanning) {
      this.scanning = false;
      this.emit('state', 'idle');
    }
  };

  /** Emit at most one driver instance per discovered peripheral id. */
  private readonly handleDiscover = (peripheral: Peripheral): void => {
    if (this.drivers.has(peripheral.id)) return;
    const kind = classifyPeripheral(peripheral);
    if (!kind) return;
    if (kind === 'trainer') {
      const driver = new BleTrainerDriver(peripheral);
      this.drivers.set(peripheral.id, driver);
      this.emit('trainer', driver);
    } else {
      const driver = new BleHrmDriver(peripheral);
      this.drivers.set(peripheral.id, driver);
      this.emit('hrm', driver);
    }
  };
}

/** Trainer (1826) wins over hrm (180d) when both are advertised. */
function classifyPeripheral(peripheral: Peripheral): 'trainer' | 'hrm' | null {
  const uuids = peripheral.advertisement?.serviceUuids ?? [];
  const has = (short: string): boolean => uuids.some((uuid) => isUuid(uuid, short));
  if (has(FTMS_SERVICE_UUID)) return 'trainer';
  if (has(HRS_SERVICE_UUID)) return 'hrm';
  return null;
}
