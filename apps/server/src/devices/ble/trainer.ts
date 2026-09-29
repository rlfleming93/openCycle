// BLE drivers for FTMS trainers and HRS heart-rate straps. All GATT
// operations are serialized through the process-global gattQueue (macOS
// CoreBluetooth has one pending GATT op across all peripherals; notifications
// flow freely). Sequence per docs/ble-protocol.md (ground truth).

import type { Characteristic, Peripheral } from '@stoprocent/noble';
import { HrmDriver, TrainerDriver } from '../driver.js';
import type { TrainerSample, TrainerStatus } from '../driver.js';
import {
  CONTROL_POINT,
  FEATURE,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA,
  MACHINE_STATUS,
  RESULT_CONTROL_NOT_PERMITTED,
  RESULT_SUCCESS,
  SUPPORTED_POWER_RANGE,
  encodeRequestControl,
  encodeSetTargetPower,
  encodeStart,
  encodeStop,
  parseControlResponse,
  parseFeature,
  parseIndoorBikeData,
  parseMachineStatus,
  parseSupportedPowerRange,
} from './ftms.js';
import { gattQueue } from './gattQueue.js';
import { HR_MEASUREMENT_UUID, HRS_SERVICE_UUID, parseHeartRateMeasurement } from './hrs.js';

const REACQUIRE_LIMIT = 3;
const CONTROL_RESPONSE_TIMEOUT_MS = 5000;
const DEFAULT_MAX_POWER_W = 2000;

/** Match a noble-normalized uuid (dashes stripped, lowercase) against a 16-bit form. */
export function isUuid(uuid: string, short: string): boolean {
  const normalized = uuid.replace(/-/g, '').toLowerCase();
  return normalized === short || normalized === `0000${short}00001000800000805f9b34fb`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a GATT op through the process-global queue, failing fast if the
 * peripheral already dropped. noble arms its disconnect-rejection listener
 * at op invocation; per noble 2.8.0 the peripheral state flips to
 * 'disconnected' in the same tick that emits 'disconnect', so state ===
 * 'connected' here guarantees the rejection listener arms before the link
 * can drop. An op issued after disconnect would never settle and would
 * wedge the queue for every device.
 */
function guardedGatt<T>(peripheral: Peripheral, op: () => Promise<T>): Promise<T> {
  return gattQueue.run(() => {
    if (peripheral.state !== 'connected') throw new Error('peripheral disconnected');
    return op();
  });
}

/**
 * Auto-reconnect policy: exponential backoff (1 s, 2 s, 4 s … capped at
 * 30 s) until disconnect() was called intentionally.
 */
class BleReconnect {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  intentional = false;

  constructor(private readonly run: () => Promise<void>) {}

  /** Called on link-level disconnect. Schedules the next reconnect attempt. */
  onDisconnected(): void {
    if (this.intentional || this.timer) return;
    const delay = Math.min(1000 * 2 ** this.attempt++, 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.retry();
    }, delay);
  }

  /** One reconnect attempt; success resets the backoff, failure schedules the next. */
  private async retry(): Promise<void> {
    try {
      await this.run();
      this.attempt = 0;
    } catch {
      this.onDisconnected();
    }
  }

  /** Stop retrying; called from driver.disconnect(). */
  stop(): void {
    this.intentional = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
  }
}

export class BleTrainerDriver extends TrainerDriver {
  readonly id: string;
  readonly name: string;
  private readonly peripheral: Peripheral;
  private readonly reconnect: BleReconnect;
  private controlPoint: Characteristic | null = null;
  private minW = 0;
  private maxW = DEFAULT_MAX_POWER_W;
  private controlAcquired = false;
  private lastSentTarget: number | null = null;
  private reacquireCount = 0;
  private reacquiring = false;
  private cpChain: Promise<unknown> = Promise.resolve();
  private connectPromise: Promise<void> | null = null;

  constructor(peripheral: Peripheral) {
    super();
    this.peripheral = peripheral;
    this.id = peripheral.id;
    this.name = peripheral.advertisement?.localName ?? peripheral.id;
    this.reconnect = new BleReconnect(() => this.connect());
  }

  async connect(): Promise<void> {
    this.reconnect.intentional = false;
    // Listen for link drops only while connected. off-before-on: connect() is
    // re-entered by every reconnect attempt and EventEmitter does NOT dedupe,
    // so an unconditional on() would grow one listener per retry.
    this.peripheral.off('disconnect', this.onDisconnected);
    this.peripheral.on('disconnect', this.onDisconnected);
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.runConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.reconnect.stop();
    this.peripheral.off('disconnect', this.onDisconnected);
    // The Stop write is best-effort and only meaningful on a live link; on a
    // dropped link it would queue a poisoned GATT op behind a wedged one.
    if (this.controlAcquired && this.controlPoint && this.peripheral.state === 'connected') {
      try {
        await this.writeCp(this.controlPoint, encodeStop(), 0x08);
      } catch {
        // Best-effort ERG stop; the link teardown below is what matters.
      }
    }
    if (this.peripheral.state !== 'disconnected') {
      await this.peripheral.disconnectAsync().catch(() => undefined);
    }
  }

  /** Clamps to the device range; resolves when the 0x80 response is received. */
  async setTargetPower(watts: number): Promise<void> {
    if (!this.controlAcquired) throw new Error('ERG control not acquired');
    const clamped = Math.min(this.maxW, Math.max(this.minW, Math.round(watts)));
    if (clamped === this.lastSentTarget) return;
    await this.writeCp(this.controlPoint!, encodeSetTargetPower(clamped), 0x05);
    this.lastSentTarget = clamped;
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
          [FTMS_SERVICE_UUID],
          [FEATURE, INDOOR_BIKE_DATA, SUPPORTED_POWER_RANGE, CONTROL_POINT, MACHINE_STATUS],
        ),
      );
      const find = (uuid: string): Characteristic | undefined =>
        characteristics.find((c) => isUuid(c.uuid, uuid));
      const feature = find(FEATURE);
      const ibd = find(INDOOR_BIKE_DATA);
      const powerRange = find(SUPPORTED_POWER_RANGE);
      const cp = find(CONTROL_POINT);
      const ms = find(MACHINE_STATUS);
      if (!feature || !ibd || !cp || !ms) throw new Error('trainer missing required FTMS characteristics');
      this.controlPoint = cp;

      const parsed = parseFeature(await guardedGatt(this.peripheral, () => feature.readAsync()));
      if (!parsed.powerTargetSupported) {
        this.emitStatus({ kind: 'error', message: 'no power target support' });
        // Permanent failure: never retry a trainer that cannot take targets.
        this.reconnect.stop();
        throw new Error('no power target support');
      }
      if (powerRange) {
        const range = parseSupportedPowerRange(await guardedGatt(this.peripheral, () => powerRange.readAsync()));
        this.minW = range.minW;
        this.maxW = range.maxW;
      }

      await this.subscribe(ibd, this.onIbdData);
      // subscribeAsync selects indicate/notify itself; macOS forbids direct 0x2902 writes.
      await this.subscribe(cp, this.onControlPointData);
      await this.subscribe(ms, this.onMachineStatusData);
      this.emitStatus({ kind: 'connected' });

      await this.acquireControl(cp);
      await this.sendStart(cp);
      this.emitStatus({ kind: 'controlAcquired' });
      await this.resendLastTarget(cp);
    } catch (err) {
      // A failed setup must not leave the trainer's central slot occupied.
      if (this.peripheral.state !== 'disconnected') {
        await this.peripheral.disconnectAsync().catch(() => undefined);
      }
      throw err;
    }
  }

  private async subscribe(char: Characteristic, handler: (data: Buffer) => void): Promise<void> {
    char.off('data', handler);
    char.on('data', handler);
    await guardedGatt(this.peripheral, () => char.subscribeAsync());
  }

  /**
   * FTMS mandates a single in-flight Control Point procedure: every write
   * must await its 0x80 <op> <result> indication before the next write.
   * Serialized per driver via cpOp and through the global GATT queue.
   */
  private writeCp(
    cp: Characteristic,
    payload: Uint8Array,
    expectOp: number,
    toleratedResults: readonly number[] = [],
  ): Promise<number> {
    return this.cpOp(() => this.writeCpNow(cp, payload, expectOp, toleratedResults));
  }

  private async writeCpNow(
    cp: Characteristic,
    payload: Uint8Array,
    expectOp: number,
    toleratedResults: readonly number[],
  ): Promise<number> {
    const write = guardedGatt(this.peripheral, () => cp.writeAsync(Buffer.from(payload), false));
    const response = this.waitForResponse(cp, expectOp, CONTROL_RESPONSE_TIMEOUT_MS, write);
    try {
      await write;
    } catch (err) {
      void response.catch(() => undefined); // write failed: drop the waiter
      throw err;
    }
    const result = await response;
    if (result !== RESULT_SUCCESS && !toleratedResults.includes(result)) {
      throw new Error(
        `control op 0x${expectOp.toString(16).padStart(2, '0')} failed: result 0x${result.toString(16).padStart(2, '0')}`,
      );
    }
    return result;
  }

  private async acquireControl(cp: Characteristic): Promise<void> {
    await this.writeCp(cp, encodeRequestControl(), 0x00);
    this.controlAcquired = true;
  }

  /**
   * Wait for the 0x80 response to `requestOp`. The timeout starts only once
   * the queued write has settled, so queue wait under multi-device storms
   * does not eat into the response window.
   */
  private waitForResponse(
    cp: Characteristic,
    requestOp: number,
    timeoutMs: number,
    writeSettled: Promise<unknown>,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      const cleanup = (): void => {
        done = true;
        cp.off('data', onData);
        if (timer !== null) clearTimeout(timer);
      };
      const onData = (data: Buffer): void => {
        if (done) return;
        const response = parseControlResponse(data);
        if (response && response.requestOp === requestOp) {
          cleanup();
          resolve(response.result);
        }
      };
      void writeSettled.then(
        () => {
          if (done) return;
          timer = setTimeout(() => {
            cleanup();
            reject(
              new Error(`control response timeout (op 0x${requestOp.toString(16).padStart(2, '0')})`),
            );
          }, timeoutMs);
        },
        () => {
          cleanup();
          reject(new Error(`control write failed (op 0x${requestOp.toString(16).padStart(2, '0')})`));
        },
      );
      cp.on('data', onData);
    });
  }

  private async sendStart(cp: Characteristic): Promise<void> {
    // Start is optional (CORE auto-starts ERG); tolerate 0x02 not-permitted.
    try {
      await this.writeCp(cp, encodeStart(), 0x07, [0x02]);
    } catch {
      // Optional per protocol.
    }
  }

  private async resendLastTarget(cp: Characteristic): Promise<void> {
    const target = this.lastSentTarget;
    if (target === null) return;
    await this.writeCp(cp, encodeSetTargetPower(target), 0x05);
  }

  private onControlLostSignal(): void {
    if (this.reconnect.intentional || !this.controlAcquired || this.reacquiring) return;
    this.reacquiring = true;
    void this.reacquireControl().finally(() => {
      this.reacquiring = false;
    });
  }

  /** Re-run Request Control + resend last target; give up after 3 consecutive failures. */
  private async reacquireControl(): Promise<void> {
    const cp = this.controlPoint;
    if (!cp) return;
    for (;;) {
      try {
        await this.acquireControl(cp);
        this.reacquireCount = 0;
        await this.resendLastTarget(cp);
        this.emitStatus({ kind: 'controlAcquired' });
        return;
      } catch {
        this.reacquireCount += 1;
        if (this.reacquireCount >= REACQUIRE_LIMIT) {
          this.reacquireCount = 0;
          this.controlAcquired = false;
          this.emitStatus({ kind: 'controlLost' });
          return;
        }
      }
    }
  }

  /** Serialize Control Point operations per driver (write + response window). */
  private cpOp<T>(op: () => Promise<T>): Promise<T> {
    const result = this.cpChain.then(op, op);
    this.cpChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private onIbdData = (data: Buffer): void => {
    const parsed = parseIndoorBikeData(data);
    if (parsed.powerW === undefined || parsed.cadenceRpm === undefined) return;
    const sample: TrainerSample = { powerW: parsed.powerW, cadenceRpm: parsed.cadenceRpm, ts: Date.now() };
    if (parsed.speedKmh !== undefined) sample.speedKmh = parsed.speedKmh;
    this.emit('sample', sample);
  };

  private onMachineStatusData = (data: Buffer): void => {
    if (parseMachineStatus(data).controlLost) this.onControlLostSignal();
  };

  private onControlPointData = (data: Buffer): void => {
    const response = parseControlResponse(data);
    if (response && response.result === RESULT_CONTROL_NOT_PERMITTED) this.onControlLostSignal();
  };

  private onDisconnected = (): void => {
    // Drop control so setTargetPower rejects during the reconnect window
    // instead of queueing a poisoned CP write behind the stale link.
    this.controlAcquired = false;
    this.emitStatus({ kind: 'disconnected' });
    this.reconnect.onDisconnected();
  };

  private emitStatus(status: TrainerStatus): void {
    this.emit('status', status);
  }
}

export class BleHrmDriver extends HrmDriver {
  readonly id: string;
  readonly name: string;
  private readonly peripheral: Peripheral;
  private readonly reconnect: BleReconnect;
  private hrChar: Characteristic | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(peripheral: Peripheral) {
    super();
    this.peripheral = peripheral;
    this.id = peripheral.id;
    this.name = peripheral.advertisement?.localName ?? peripheral.id;
    this.reconnect = new BleReconnect(() => this.connect());
  }

  async connect(): Promise<void> {
    this.reconnect.intentional = false;
    // off-before-on: reconnect retries re-enter connect(); see trainer note.
    this.peripheral.off('disconnect', this.onDisconnected);
    this.peripheral.on('disconnect', this.onDisconnected);
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.runConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.reconnect.stop();
    this.peripheral.off('disconnect', this.onDisconnected);
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
        this.peripheral.discoverSomeServicesAndCharacteristicsAsync([HRS_SERVICE_UUID], [HR_MEASUREMENT_UUID]),
      );
      const hr = characteristics.find((c) => isUuid(c.uuid, HR_MEASUREMENT_UUID));
      if (!hr) throw new Error('heart rate measurement characteristic not found');
      this.hrChar?.off('data', this.onHrData);
      this.hrChar = hr;
      hr.on('data', this.onHrData);
      // Garmin straps gate 0x2A37 behind encryption. The first subscribe can
      // fail with "Encryption is insufficient." while macOS runs just-works
      // pairing in the background; disconnecting here aborts that pairing, so
      // hold the link and retry until the bond lands (observed on HRM-Pro).
      await this.subscribeWithPairingRetry(hr);
      this.emitStatus({ kind: 'connected' });
    } catch (err) {
      // A failed setup must not leave the strap's central slot occupied.
      if (this.peripheral.state !== 'disconnected') {
        await this.peripheral.disconnectAsync().catch(() => undefined);
      }
      throw err;
    }
  }

  /** Retry an encryption-gated subscribe on the live link while pairing completes. */
  private async subscribeWithPairingRetry(hr: Characteristic): Promise<void> {
    const attempts = 6;
    for (let i = 1; ; i++) {
      try {
        await guardedGatt(this.peripheral, () => hr.subscribeAsync());
        return;
      } catch (err) {
        const pairing = /encryption|authentication/i.test(messageOf(err));
        if (!pairing || i >= attempts || this.peripheral.state === 'disconnected') throw err;
        this.emitStatus({ kind: 'connecting', message: `pairing (attempt ${i}/${attempts})` });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private onHrData = (data: Buffer): void => {
    const parsed = parseHeartRateMeasurement(data);
    this.emit('hr', { bpm: parsed.bpm, rrMs: parsed.rrMs, ts: Date.now() });
  };

  private onDisconnected = (): void => {
    this.emitStatus({ kind: 'disconnected' });
    this.reconnect.onDisconnected();
  };

  private emitStatus(status: TrainerStatus): void {
    this.emit('status', status);
  }
}
