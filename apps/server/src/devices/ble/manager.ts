// BLE manager: scans for FTMS trainers and HRS straps and emits one driver
// instance per discovered peripheral id. Runs on @stoprocent/noble
// (CoreBluetooth); a fake noble can be injected for tests.

import { EventEmitter } from 'node:events';
import noble, { type Noble, type Peripheral } from '@stoprocent/noble';
import { HrmDriver, TrainerDriver } from '../driver.js';
import { FTMS_SERVICE_UUID } from './ftms.js';
import { HRS_SERVICE_UUID } from './hrs.js';
import { BleHrmDriver, BleTrainerDriver, isUuid } from './trainer.js';

const SCAN_SERVICE_UUIDS = [FTMS_SERVICE_UUID, HRS_SERVICE_UUID];
const POWER_ON_TIMEOUT_MS = 30_000;

export interface BleManagerEvents {
  trainer: [TrainerDriver];
  hrm: [HrmDriver];
  state: [string];
}

export class BleManager extends EventEmitter<BleManagerEvents> {
  private readonly noble: Noble;
  private readonly drivers = new Map<string, TrainerDriver | HrmDriver>();
  private scanning = false;

  constructor(opts?: { noble?: Noble }) {
    super();
    this.noble = opts?.noble ?? noble;
    this.noble.on('discover', this.handleDiscover);
  }

  /** Release the noble listener and stop scanning; idempotent. */
  async dispose(): Promise<void> {
    this.noble.off('discover', this.handleDiscover);
    if (this.scanning) {
      this.scanning = false;
      this.emit('state', 'idle');
    }
    try {
      await this.noble.stopScanningAsync();
    } catch {
      // Best effort: a stopScan failure must not block shutdown.
    }
  }

  /** Scan for FTMS trainers and HRM straps (no duplicate advertisements). */
  async startScan(): Promise<void> {
    if (this.scanning) return;
    await this.waitForPoweredOn();
    await this.noble.startScanningAsync(SCAN_SERVICE_UUIDS, false);
    this.scanning = true;
    this.emit('state', 'scanning');
  }

  async stopScan(): Promise<void> {
    if (!this.scanning) return;
    await this.noble.stopScanningAsync();
    this.scanning = false;
    this.emit('state', 'idle');
  }

  private async waitForPoweredOn(): Promise<void> {
    if (this.noble.state === 'poweredOn') return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onState = (state: string): void => {
        if (state !== 'poweredOn') return;
        clearTimeout(timer);
        this.noble.off('stateChange', onState);
        resolve();
      };
      timer = setTimeout(() => {
        this.noble.off('stateChange', onState);
        reject(new Error('BLE adapter did not power on within 30 s'));
      }, POWER_ON_TIMEOUT_MS);
      this.noble.on('stateChange', onState);
    });
  }

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
