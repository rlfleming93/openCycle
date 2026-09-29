import { EventEmitter } from 'node:events';

export interface TrainerSample {
  powerW: number;
  cadenceRpm: number;
  speedKmh?: number;
  ts: number; // Date.now()
}

export type TrainerStatusKind =
  | 'connecting'
  | 'connected'
  | 'controlAcquired'
  | 'controlLost'
  | 'disconnected'
  | 'error';

export interface TrainerStatus {
  kind: TrainerStatusKind;
  message?: string;
}

export interface HrmSample {
  bpm: number;
  rrMs: number[];
  ts: number;
}

export type TrainerEvents = {
  sample: [TrainerSample];
  status: [TrainerStatus];
};

export type HrmEvents = {
  hr: [HrmSample];
  status: [TrainerStatus];
};

export abstract class TrainerDriver extends EventEmitter<TrainerEvents> {
  abstract readonly id: string; // stable device id (BLE peripheral UUID or sim:trainer:N)
  abstract readonly name: string;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  /**
   * Clamps to the device range; resolves when written. Rejects when the
   * driver is not connected or (for ERG-capable trainers) control has not
   * been acquired.
   */
  abstract setTargetPower(watts: number): Promise<void>;
}

export abstract class HrmDriver extends EventEmitter<HrmEvents> {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
}
