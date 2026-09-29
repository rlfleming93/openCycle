// Unit tests for the BLE manager + drivers against a fake noble injected via
// constructor opts. Fake characteristics record every write byte-exactly and
// auto-respond to every Control Point op like a KICKR CORE would.

import { EventEmitter } from 'node:events';
import type { Noble, Peripheral } from '@stoprocent/noble';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrmDriver, HrmSample, TrainerDriver, TrainerStatus } from '../driver.js';
import { GattQueue } from './gattQueue.js';
import { BleManager } from './manager.js';
import { BleHrmDriver, BleTrainerDriver } from './trainer.js';

// ---------------------------------------------------------------------------
// Fakes

const opLog: string[] = [];

class FakeCharacteristic extends EventEmitter {
  readonly uuid: string;
  readonly properties: string[];
  readValue?: Buffer;
  writes: Buffer[] = [];
  subscribes = 0;
  autoRespond = false;
  holdNextWrite = false;
  /** When true, auto responses are suppressed; release via notify(). */
  holdResponse = false;
  private held: { resolve: () => void } | null = null;
  private readonly devId: string;

  constructor(uuid: string, devId: string, properties: string[] = ['read', 'write', 'notify', 'indicate']) {
    super();
    this.uuid = uuid;
    this.devId = devId;
    this.properties = properties;
  }

  async readAsync(): Promise<Buffer> {
    if (!this.readValue) throw new Error(`no canned read value for ${this.uuid}`);
    return this.readValue;
  }

  async writeAsync(data: Buffer, _withoutResponse: boolean): Promise<void> {
    this.writes.push(Buffer.from(data));
    opLog.push(`${this.devId}.${this.uuid}:write:${data.toString('hex')}`);
    if (this.autoRespond && !this.holdResponse && data.length > 0) {
      const op = data[0]!;
      if (op === 0x00 || op === 0x05 || op === 0x07 || op === 0x08) {
        // Indication arrives after the ATT write, like real hardware.
        setImmediate(() => this.emit('data', Buffer.from([0x80, op, 0x01]), true));
      }
    }
    if (this.holdNextWrite) {
      this.holdNextWrite = false;
      await new Promise<void>((resolve) => {
        this.held = { resolve };
      });
    }
  }

  releaseHeldWrite(): void {
    const held = this.held;
    this.held = null;
    held?.resolve();
  }

  /** Errors thrown by the next subscribeAsync calls, in order (pairing sim). */
  subscribeErrors: Error[] = [];

  async subscribeAsync(): Promise<void> {
    const err = this.subscribeErrors.shift();
    if (err) throw err;
    this.subscribes += 1;
  }

  /** Emit a notification/indication asynchronously, like the native binding. */
  notify(bytes: number[]): void {
    setImmediate(() => this.emit('data', Buffer.from(bytes), true));
  }
}

class FakePeripheral extends EventEmitter {
  readonly id: string;
  readonly advertisement: { localName: string; serviceUuids: string[] };
  readonly characteristics: FakeCharacteristic[];
  state = 'disconnected';
  connects = 0;
  disconnects = 0;

  constructor(id: string, name: string, serviceUuids: string[], characteristics: FakeCharacteristic[]) {
    super();
    this.id = id;
    this.advertisement = { localName: name, serviceUuids };
    this.characteristics = characteristics;
  }

  async connectAsync(): Promise<void> {
    this.connects += 1;
    this.state = 'connected';
  }

  async disconnectAsync(): Promise<void> {
    this.disconnects += 1;
    this.simulateDisconnect();
  }

  async discoverSomeServicesAndCharacteristicsAsync(): Promise<{
    services: unknown[];
    characteristics: FakeCharacteristic[];
  }> {
    return { services: [], characteristics: this.characteristics };
  }

  /** Link drop, as CoreBluetooth reports it. */
  simulateDisconnect(): void {
    this.state = 'disconnected';
    this.emit('disconnect', 'connection terminated');
  }
}

class FakeNoble extends EventEmitter {
  state = 'poweredOn';
  scanning: string[] | null = null;
  allowDuplicates: boolean | null = null;

  async startScanningAsync(serviceUUIDs: string[], allowDuplicates: boolean): Promise<void> {
    this.scanning = serviceUUIDs;
    this.allowDuplicates = allowDuplicates;
  }

  async stopScanningAsync(): Promise<void> {
    this.scanning = null;
  }
}

// ---------------------------------------------------------------------------
// Fixtures

function featureBuf(targetSettingBits: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(0x4002, 0); // features: bit1 cadence + bit14 power measurement
  out.writeUInt32LE(targetSettingBits, 4); // target-setting bit3 = power target
  return out;
}

function rangeBuf(minW: number, maxW: number): Buffer {
  const out = Buffer.alloc(6);
  out.writeInt16LE(minW, 0);
  out.writeInt16LE(maxW, 2);
  out.writeUInt16LE(1, 4);
  return out;
}

interface TrainerOpts {
  targetSetting?: number;
  minW?: number;
  maxW?: number;
  name?: string;
}

function makeTrainerPeripheral(id: string, opts: TrainerOpts = {}): FakePeripheral {
  const feature = new FakeCharacteristic('2acc', id);
  feature.readValue = featureBuf(opts.targetSetting ?? 0x0008);
  const ibd = new FakeCharacteristic('2ad2', id);
  const range = new FakeCharacteristic('2ad8', id);
  range.readValue = rangeBuf(opts.minW ?? 0, opts.maxW ?? 2000);
  const cp = new FakeCharacteristic('2ad9', id, ['write', 'indicate']);
  cp.autoRespond = true;
  const ms = new FakeCharacteristic('2ada', id);
  return new FakePeripheral(id, opts.name ?? 'KICKR CORE TEST', ['1826'], [feature, ibd, range, cp, ms]);
}

function makeHrmPeripheral(id: string, name = 'HRM-Pro TEST'): FakePeripheral {
  const hr = new FakeCharacteristic('2a37', id);
  return new FakePeripheral(id, name, ['180d'], [hr]);
}

function setupTrainer(id = 't1', opts: TrainerOpts = {}): {
  peripheral: FakePeripheral;
  driver: BleTrainerDriver;
  cp: FakeCharacteristic;
  ms: FakeCharacteristic;
  ibd: FakeCharacteristic;
} {
  const peripheral = makeTrainerPeripheral(id, opts);
  const driver = new BleTrainerDriver(peripheral as unknown as Peripheral);
  const chars = peripheral.characteristics;
  return {
    peripheral,
    driver,
    cp: chars.find((c) => c.uuid === '2ad9')!,
    ms: chars.find((c) => c.uuid === '2ada')!,
    ibd: chars.find((c) => c.uuid === '2ad2')!,
  };
}

function statusesOf(driver: TrainerDriver): TrainerStatus[] {
  const statuses: TrainerStatus[] = [];
  driver.on('status', (s) => statuses.push(s));
  return statuses;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Pump microtasks + setImmediates under fake timers until quiescent.
 *
 * fake-timers schedules a setImmediate created while a tick is in progress at
 * callAt = now + 1, so advancing 0 ms per pump would never fire it. Advancing
 * 1 ms per iteration fires those immediates while staying far below any real
 * timeout in these tests (the 5 s control-response window).
 */
async function flushFakeTimers(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  opLog.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// GattQueue

describe('GattQueue', () => {
  it('serializes ops strictly and lets op errors reach only their caller', async () => {
    const queue = new GattQueue();
    const calls: string[] = [];
    const failing = queue.run(async () => {
      calls.push('a');
      throw new Error('boom');
    });
    const b = queue.run(async () => {
      calls.push('b');
    });
    await expect(failing).rejects.toThrow('boom');
    await b;
    expect(calls).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// BleTrainerDriver

describe('BleTrainerDriver', () => {
  it('a) runs the ERG handshake in order: request control, start, then target', async () => {
    const { driver, cp } = setupTrainer();
    const statuses = statusesOf(driver);
    await driver.connect();
    await driver.setTargetPower(200);
    expect(cp.writes.map((w) => w.toString('hex'))).toEqual(['00', '07', '05c800']);
    expect(statuses.map((s) => s.kind)).toEqual(['connecting', 'connected', 'controlAcquired']);
  });

  it('b) writes 05 C8 00 for a 200 W target', async () => {
    const { driver, cp } = setupTrainer();
    await driver.connect();
    await driver.setTargetPower(200);
    expect(cp.writes.at(-1)!.toString('hex')).toBe('05c800');
  });

  it('c) skips the write when the target is unchanged', async () => {
    const { driver, cp } = setupTrainer();
    await driver.connect();
    await driver.setTargetPower(200);
    await driver.setTargetPower(200);
    await driver.setTargetPower(200);
    expect(cp.writes.filter((w) => w[0] === 0x05)).toHaveLength(1);
  });

  it('d) machine-status 0xFF triggers re-request control then resend of last target', async () => {
    const { driver, cp, ms } = setupTrainer();
    const statuses = statusesOf(driver);
    await driver.connect();
    await driver.setTargetPower(200);
    const before = cp.writes.length;
    ms.notify([0xff]);
    await waitFor(() => cp.writes.length === before + 2);
    expect(cp.writes.slice(before).map((w) => w.toString('hex'))).toEqual(['00', '05c800']);
    expect(statuses.at(-1)!.kind).toBe('controlAcquired');
  });

  it('e) clamps targets to the supported power range', async () => {
    const { driver, cp } = setupTrainer('t1', { minW: 50, maxW: 400 });
    await driver.connect();
    await driver.setTargetPower(500);
    expect(cp.writes.at(-1)!.toString('hex')).toBe('059001'); // 400 W = 0x0190
    await driver.setTargetPower(10);
    expect(cp.writes.at(-1)!.toString('hex')).toBe('053200'); // 50 W = 0x32
    await driver.setTargetPower(300);
    expect(cp.writes.at(-1)!.toString('hex')).toBe('052c01'); // 300 W = 0x012c
  });

  it('f) serializes writes from two trainers through one global queue', async () => {
    const t1 = setupTrainer('t1');
    const t2 = setupTrainer('t2');
    await t1.driver.connect();
    await t2.driver.connect();
    const before = opLog.length;
    t1.cp.holdNextWrite = true;
    const p1 = t1.driver.setTargetPower(200);
    await tick();
    const p2 = t2.driver.setTargetPower(200);
    await tick();
    // The second trainer's write must not start while the first is in flight.
    expect(opLog.slice(before)).toEqual(['t1.2ad9:write:05c800']);
    t1.cp.releaseHeldWrite();
    await p1;
    await p2;
    expect(opLog.slice(before)).toEqual(['t1.2ad9:write:05c800', 't2.2ad9:write:05c800']);
  });

  it('g) emits an error status and touches no Control Point without power-target support', async () => {
    const { driver, cp, peripheral } = setupTrainer('t1', { targetSetting: 0 });
    const statuses = statusesOf(driver);
    vi.useFakeTimers();
    await expect(driver.connect()).rejects.toThrow('no power target support');
    expect(statuses).toContainEqual({ kind: 'error', message: 'no power target support' });
    expect(cp.writes).toHaveLength(0);
    expect(cp.subscribes).toBe(0);
    // Permanent failure: no reconnect attempt ever fires.
    await vi.advanceTimersByTimeAsync(120_000);
    await flushFakeTimers();
    expect(peripheral.connects).toBe(1);
  });

  it('j) setTargetPower between disconnect and reconnect rejects and enqueues no write', async () => {
    const { driver, cp, peripheral } = setupTrainer();
    const statuses = statusesOf(driver);
    await driver.connect();
    await driver.setTargetPower(200);
    vi.useFakeTimers();
    peripheral.simulateDisconnect();
    expect(statuses.at(-1)).toEqual({ kind: 'disconnected' });
    const writesBefore = cp.writes.length;
    await expect(driver.setTargetPower(300)).rejects.toThrow('ERG control not acquired');
    expect(cp.writes.length).toBe(writesBefore); // no poisoned write behind a stale link
    // The rejected call did not wedge anything: reconnect still completes.
    await vi.advanceTimersByTimeAsync(1000);
    await flushFakeTimers();
    expect(peripheral.connects).toBe(2);
    expect(statuses.at(-1)!.kind).toBe('controlAcquired');
    expect(cp.writes.slice(writesBefore).map((w) => w.toString('hex'))).toEqual(['00', '07', '05c800']);
  });

  it('k) a never-settling GATT op trips the watchdog and the queue still serves the next op', async () => {
    const t1 = setupTrainer('t1');
    await t1.driver.connect();
    await t1.driver.setTargetPower(100);
    vi.useFakeTimers();
    t1.cp.holdNextWrite = true; // the write never settles
    const stuck = t1.driver.setTargetPower(200);
    const stuckRejection = expect(stuck).rejects.toThrow('GATT op watchdog');
    await flushFakeTimers();
    await vi.advanceTimersByTimeAsync(20_000);
    await stuckRejection;
    // The queue advanced: a second driver's ops still run.
    const t2 = setupTrainer('t2');
    const connect2 = t2.driver.connect();
    await flushFakeTimers();
    await connect2;
    const target2 = t2.driver.setTargetPower(200);
    await flushFakeTimers();
    await target2;
    expect(t2.cp.writes.at(-1)!.toString('hex')).toBe('05c800');
  });

  it('l) disconnect() with the link already dropped resolves promptly and skips the Stop write', async () => {
    const { driver, cp, peripheral } = setupTrainer();
    await driver.connect();
    await driver.setTargetPower(200);
    vi.useFakeTimers();
    peripheral.simulateDisconnect();
    const disconnectsBefore = peripheral.disconnects;
    await driver.disconnect();
    expect(peripheral.disconnects).toBe(disconnectsBefore); // no redundant teardown
    expect(cp.writes.filter((w) => w[0] === 0x08)).toHaveLength(0); // no Stop write
    // Intentional disconnect: no reconnect attempt fires.
    await vi.advanceTimersByTimeAsync(120_000);
    await flushFakeTimers();
    expect(peripheral.connects).toBe(1);
  });

  it('gives up with controlLost after 3 failed re-acquisitions', async () => {
    const { driver, cp, ms } = setupTrainer();
    const statuses = statusesOf(driver);
    await driver.connect();
    vi.useFakeTimers();
    cp.autoRespond = false; // no 0x80 responses from here on
    ms.notify([0xff]);
    await flushFakeTimers();
    await vi.advanceTimersByTimeAsync(3 * 5000); // one 5 s response timeout per attempt
    await flushFakeTimers();
    expect(statuses.at(-1)).toEqual({ kind: 'controlLost' });
    // initial handshake request-control + exactly 3 re-acquisitions
    expect(cp.writes.filter((w) => w[0] === 0x00)).toHaveLength(4);
  });

  it('emits samples from Indoor Bike Data notifications', async () => {
    const { driver, ibd } = setupTrainer();
    await driver.connect();
    const samples: Array<{ powerW: number; cadenceRpm: number; speedKmh?: number }> = [];
    driver.on('sample', (s) => samples.push(s));
    ibd.notify([0x44, 0x00, 0xb8, 0x0b, 0xb4, 0x00, 0xc8, 0x00]); // 30 km/h, 90 rpm, 200 W
    await waitFor(() => samples.length === 1);
    expect(samples[0]).toMatchObject({ powerW: 200, cadenceRpm: 90, speedKmh: 30 });
  });

  it('reconnects with exponential backoff, resends the last target, and resets the backoff after success', async () => {
    const { driver, cp, peripheral } = setupTrainer();
    const statuses = statusesOf(driver);
    await driver.connect();
    await driver.setTargetPower(200);
    vi.useFakeTimers();
    peripheral.simulateDisconnect();
    expect(statuses.at(-1)).toEqual({ kind: 'disconnected' });
    await vi.advanceTimersByTimeAsync(1000); // first retry after 1 s
    await flushFakeTimers();
    expect(peripheral.connects).toBe(2);
    expect(statuses.at(-1)!.kind).toBe('controlAcquired');
    // Reconnect retries re-enter connect(): the disconnect listener must not
    // duplicate (EventEmitter does not dedupe; off-before-on in connect()).
    expect(peripheral.listenerCount('disconnect')).toBe(1);
    cp.writes.length = 0;
    // A successful reconnect resets the attempt counter: the next dropout
    // retries after 1 s again instead of escalating to 2 s.
    peripheral.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(1000);
    await flushFakeTimers();
    expect(peripheral.connects).toBe(3);
    expect(cp.writes.map((w) => w.toString('hex'))).toEqual(['00', '07', '05c800']);
    expect(peripheral.listenerCount('disconnect')).toBe(1);
    vi.useRealTimers();
    await driver.disconnect();
    expect(peripheral.listenerCount('disconnect')).toBe(0);
  });

  it('h) issues no CP write before the previous write\'s 0x80 response arrives', async () => {
    const { driver, cp } = setupTrainer();
    cp.autoRespond = false;
    cp.holdResponse = true; // writes land; responses only via manual notify()
    const connectPromise = driver.connect();
    await tick();
    expect(cp.writes.map((w) => w.toString('hex'))).toEqual(['00']);
    cp.notify([0x80, 0x00, 0x01]);
    await tick();
    expect(cp.writes.map((w) => w.toString('hex'))).toEqual(['00', '07']);
    cp.notify([0x80, 0x07, 0x01]);
    await connectPromise;
    cp.autoRespond = true;
    cp.holdResponse = false;
    await driver.setTargetPower(200);
    expect(cp.writes.map((w) => w.toString('hex'))).toEqual(['00', '07', '05c800']);
  });

  it('i) CP set-target result 0x05 (control not permitted) triggers re-request control then resend of last target', async () => {
    const { driver, cp } = setupTrainer();
    const statuses = statusesOf(driver);
    await driver.connect();
    await driver.setTargetPower(200);
    const before = cp.writes.length;
    cp.notify([0x80, 0x05, 0x05]);
    await waitFor(() => cp.writes.length === before + 2);
    expect(cp.writes.slice(before).map((w) => w.toString('hex'))).toEqual(['00', '05c800']);
    expect(statuses.at(-1)!.kind).toBe('controlAcquired');
  });
});

// ---------------------------------------------------------------------------
// BleHrmDriver

describe('BleHrmDriver', () => {
  it('emits hr samples from HR Measurement notifications', async () => {
    const peripheral = makeHrmPeripheral('h1');
    const driver = new BleHrmDriver(peripheral as unknown as Peripheral);
    const samples: HrmSample[] = [];
    driver.on('hr', (s) => samples.push(s));
    await driver.connect();
    expect(peripheral.characteristics[0]!.subscribes).toBe(1);
    peripheral.characteristics[0]!.notify([0x16, 0x96, 0x20, 0x03]); // 150 bpm, RR 800/1024 s
    await waitFor(() => samples.length === 1);
    expect(samples[0]!.bpm).toBe(150);
    expect(samples[0]!.rrMs).toEqual([781.25]);
  });

  it('reconnects after a link drop without duplicating disconnect listeners', async () => {
    const peripheral = makeHrmPeripheral('h1');
    const driver = new BleHrmDriver(peripheral as unknown as Peripheral);
    await driver.connect();
    expect(peripheral.listenerCount('disconnect')).toBe(1);
    vi.useFakeTimers();
    peripheral.simulateDisconnect();
    await vi.advanceTimersByTimeAsync(1000); // first retry after 1 s
    await flushFakeTimers();
    expect(peripheral.connects).toBe(2);
    expect(peripheral.listenerCount('disconnect')).toBe(1);
    vi.useRealTimers();
    await driver.disconnect();
    expect(peripheral.listenerCount('disconnect')).toBe(0);
  });

  it('holds the link and retries the subscribe while pairing completes (encryption gate)', async () => {
    vi.useFakeTimers();
    const peripheral = makeHrmPeripheral('h1');
    const hr = peripheral.characteristics[0]!;
    hr.subscribeErrors = [
      new Error('Encryption is insufficient.'),
      new Error('Encryption is insufficient.'),
    ];
    const driver = new BleHrmDriver(peripheral as unknown as Peripheral);
    const connectPromise = driver.connect();
    await vi.advanceTimersByTimeAsync(2 * 2000); // two pairing retry waits
    await connectPromise;
    vi.useRealTimers();
    expect(peripheral.connects).toBe(1); // never disconnected mid-pairing
    expect(peripheral.state).toBe('connected');
    expect(hr.subscribes).toBe(1); // third attempt landed
    await driver.disconnect();
  });

  it('gives up after exhausted pairing retries, frees the slot, and recovers via reconnect', async () => {
    vi.useFakeTimers();
    const peripheral = makeHrmPeripheral('h1');
    const hr = peripheral.characteristics[0]!;
    hr.subscribeErrors = Array.from({ length: 8 }, () => new Error('Encryption is insufficient.'));
    const driver = new BleHrmDriver(peripheral as unknown as Peripheral);
    const connectPromise = driver.connect().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(6 * 2000); // exhaust the pairing window
    const err = await connectPromise;
    expect(String(err)).toMatch(/Encryption/);
    expect(peripheral.disconnects).toBe(1); // give-up released the strap slot
    await vi.advanceTimersByTimeAsync(30_000); // reconnect backoff + remaining retries
    await flushFakeTimers();
    vi.useRealTimers();
    expect(peripheral.connects).toBeGreaterThanOrEqual(2); // backoff loop re-acquired
    expect(hr.subscribes).toBe(1); // errors exhausted -> subscribe finally landed
    await driver.disconnect();
  });
});

// ---------------------------------------------------------------------------
// BleManager

describe('BleManager', () => {
  it('scans for FTMS + HRS services without duplicates and emits state', async () => {
    const noble = new FakeNoble();
    const manager = new BleManager({ noble: noble as unknown as Noble });
    const states: string[] = [];
    manager.on('state', (s) => states.push(s));
    await manager.startScan();
    expect(noble.scanning).toEqual(['1826', '180d']);
    expect(noble.allowDuplicates).toBe(false);
    await manager.stopScan();
    expect(noble.scanning).toBeNull();
    expect(states).toEqual(['scanning', 'idle']);
  });

  it('waits for the adapter to power on before scanning', async () => {
    const noble = new FakeNoble();
    noble.state = 'poweredOff';
    const manager = new BleManager({ noble: noble as unknown as Noble });
    const scanPromise = manager.startScan();
    await tick();
    expect(noble.scanning).toBeNull();
    noble.state = 'poweredOn';
    noble.emit('stateChange', 'poweredOn');
    await scanPromise;
    expect(noble.scanning).toEqual(['1826', '180d']);
  });

  it('classifies devices and emits each driver once per peripheral id', async () => {
    const noble = new FakeNoble();
    const manager = new BleManager({ noble: noble as unknown as Noble });
    const trainers: TrainerDriver[] = [];
    const hrms: HrmDriver[] = [];
    manager.on('trainer', (d) => trainers.push(d));
    manager.on('hrm', (d) => hrms.push(d));
    await manager.startScan();
    const t1 = makeTrainerPeripheral('t1');
    noble.emit('discover', t1);
    noble.emit('discover', t1); // duplicate advertisement
    noble.emit('discover', makeHrmPeripheral('h1'));
    noble.emit('discover', new FakePeripheral('u1', 'Some Speaker', [], []));
    expect(trainers.map((d) => d.id)).toEqual(['t1']);
    expect(hrms.map((d) => d.id)).toEqual(['h1']);
  });
});
