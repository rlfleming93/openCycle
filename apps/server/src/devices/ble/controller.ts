// BLE driver for the Zwift Ride handlebar controllers. Connects to the left
// controller only (it carries the right one's presses too), runs the plain
// RideOn handshake and emits one 'press' per button press. GATT ops go
// through the process-global queue; protocol per docs/ble-protocol.md.

import { EventEmitter } from 'node:events';
import type { Characteristic, Peripheral } from '@stoprocent/noble';
import type { TrainerStatus } from '../driver.js';
import { BleReconnect, guardedGatt, isUuid, messageOf } from './trainer.js';
import {
  DEVICE_INFO_SERVICE_UUID,
  FIRMWARE_REVISION_UUID,
  RIDE_ON,
  RidePressDetector,
  ZWIFT_ASYNC_UUID,
  ZWIFT_LEGACY_SERVICE_UUID,
  ZWIFT_RIDE_SERVICE_UUID,
  ZWIFT_SYNC_RX_UUID,
  ZWIFT_SYNC_TX_UUID,
  decodeRideKeypad,
  isRideOnReply,
  type RideButton,
} from './zwiftRide.js';

const RIDE_ON_REPLY_TIMEOUT_MS = 5000;

export type ControllerEvents = {
  press: [RideButton];
  status: [TrainerStatus];
};

export class BleZwiftRideDriver extends EventEmitter<ControllerEvents> {
  readonly id: string;
  readonly name: string;
  private readonly peripheral: Peripheral;
  private readonly reconnect: BleReconnect;
  private readonly presses = new RidePressDetector();
  private connectPromise: Promise<void> | null = null;

  constructor(peripheral: Peripheral) {
    super();
    this.peripheral = peripheral;
    this.id = peripheral.id;
    this.name = peripheral.advertisement?.localName ?? peripheral.id;
    this.reconnect = new BleReconnect(() => this.connect());
  }

  /** Idempotent: a live link or an attempt in flight is reused. */
  async connect(): Promise<void> {
    this.reconnect.intentional = false;
    // off-before-on: reconnect retries re-enter connect(); see trainer note.
    this.peripheral.off('disconnect', this.onDisconnected);
    this.peripheral.on('disconnect', this.onDisconnected);
    if (this.connectPromise) return this.connectPromise;
    // noble fails a connect on a live link, and the failed setup would drop that link.
    if (this.peripheral.state === 'connected') return;
    const attempt: Promise<void> = this.runConnect().finally(() => {
      if (this.connectPromise === attempt) this.connectPromise = null;
    });
    this.connectPromise = attempt;
    return attempt;
  }

  async disconnect(): Promise<void> {
    this.reconnect.stop();
    this.peripheral.off('disconnect', this.onDisconnected);
    // A connect pending on a sleeping controller never settles once cancelled:
    // forget it so the next connect() starts afresh.
    this.connectPromise = null;
    if (this.peripheral.state !== 'disconnected') {
      await this.peripheral.disconnectAsync().catch(() => undefined);
    }
  }

  private async runConnect(): Promise<void> {
    this.emitStatus({ kind: 'connecting' });
    try {
      await this.connectOnce();
    } catch (err) {
      if (!this.reconnect.intentional) {
        this.emitStatus({ kind: 'error', message: messageOf(err) });
      }
      throw err;
    }
  }

  private async connectOnce(): Promise<void> {
    try {
      await this.peripheral.connectAsync();
      const { characteristics } = await guardedGatt(this.peripheral, () =>
        this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [ZWIFT_RIDE_SERVICE_UUID, ZWIFT_LEGACY_SERVICE_UUID, DEVICE_INFO_SERVICE_UUID],
          [ZWIFT_ASYNC_UUID, ZWIFT_SYNC_RX_UUID, ZWIFT_SYNC_TX_UUID, FIRMWARE_REVISION_UUID],
        ),
      );
      const find = (uuid: string): Characteristic | undefined =>
        characteristics.find((c) => isUuid(c.uuid, uuid));
      const firmware = await this.readFirmware(find(FIRMWARE_REVISION_UUID));
      const notify = find(ZWIFT_ASYNC_UUID);
      const command = find(ZWIFT_SYNC_RX_UUID);
      const reply = find(ZWIFT_SYNC_TX_UUID);
      if (!notify || !command || !reply) {
        // Firmware 1.3+ ("Ride V2") hides the service until the Zwift app unlocks it for ~24 h.
        throw new Error(
          `Zwift service hidden (firmware ${firmware ?? 'unknown'}): connect the Ride in the Zwift app once, quit Zwift, then retry`,
        );
      }
      this.presses.reset();
      notify.off('data', this.onNotify);
      notify.on('data', this.onNotify);
      await guardedGatt(this.peripheral, () => notify.subscribeAsync());
      await guardedGatt(this.peripheral, () => reply.subscribeAsync());
      await this.handshake(command, [reply, notify]);
      this.emitStatus({ kind: 'connected', ...(firmware ? { message: `firmware ${firmware}` } : {}) });
    } catch (err) {
      // A failed setup must not hold the controller: it takes one central at a time.
      if (this.peripheral.state !== 'disconnected') {
        await this.peripheral.disconnectAsync().catch(() => undefined);
      }
      throw err;
    }
  }

  /** Firmware revision (Device Information), for the log and the lock message; best effort. */
  private async readFirmware(char: Characteristic | undefined): Promise<string | undefined> {
    if (!char) return undefined;
    try {
      const data = await guardedGatt(this.peripheral, () => char.readAsync());
      return data.toString('utf8').replace(/\0+$/, '').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Write RideOn and wait for the controller's RideOn echo (Sync TX; Async also watched). */
  private async handshake(command: Characteristic, replyChars: Characteristic[]): Promise<void> {
    const withoutResponse = command.properties.includes('writeWithoutResponse');
    const written = guardedGatt(this.peripheral, () => command.writeAsync(Buffer.from(RIDE_ON), withoutResponse));
    await waitForRideOn(replyChars, written);
  }

  private onNotify = (data: Buffer): void => {
    const frame = decodeRideKeypad(data);
    if (!frame) return;
    for (const button of this.presses.update(frame, Date.now())) this.emit('press', button);
  };

  private onDisconnected = (): void => {
    this.emitStatus({ kind: 'disconnected' });
    this.reconnect.onDisconnected();
  };

  private emitStatus(status: TrainerStatus): void {
    this.emit('status', status);
  }
}

/** Resolve on a RideOn echo; the reply timeout starts once the write settled. */
function waitForRideOn(chars: Characteristic[], written: Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const char of chars) char.off('data', onData);
      if (err) reject(err);
      else resolve();
    };
    const onData = (data: Buffer): void => {
      if (isRideOnReply(data)) finish();
    };
    for (const char of chars) char.on('data', onData);
    written.then(
      () => {
        if (!settled) timer = setTimeout(() => finish(new Error('no RideOn reply')), RIDE_ON_REPLY_TIMEOUT_MS);
      },
      (err: unknown) => finish(new Error(`RideOn write failed: ${messageOf(err)}`)),
    );
  });
}
