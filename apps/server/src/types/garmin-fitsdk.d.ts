/**
 * Local type surface for @garmin/fitsdk 21.213.0.
 *
 * The shipped src/index.d.ts re-exports its types via extensionless relative
 * paths ("./types/decoder"), which NodeNext module resolution cannot follow in
 * an ESM package — every named export vanishes for tsc while the runtime
 * (src/index.js) exports them fine. This ambient declaration takes precedence
 * over the broken package types and covers exactly the surface we use
 * (recorder.ts + FIT round-trip tests). Field values are `unknown` by design:
 * the FIT profile is dynamic and call sites narrow what they read.
 */
declare module '@garmin/fitsdk' {
  /** A FIT message: camelCase profile field names → values. */
  export type Mesg = Record<string, unknown>;

  export type FitMesgRecord = Record<string, unknown>;

  export interface FitMessages {
    fileIdMesgs?: FitMesgRecord[];
    deviceInfoMesgs?: FitMesgRecord[];
    eventMesgs?: FitMesgRecord[];
    recordMesgs?: FitMesgRecord[];
    lapMesgs?: FitMesgRecord[];
    sessionMesgs?: FitMesgRecord[];
    activityMesgs?: FitMesgRecord[];
    [mesgName: string]: FitMesgRecord[] | undefined;
  }

  export class Stream {
    static fromBuffer(buffer: Buffer | Uint8Array): Stream;
  }

  export class Decoder {
    constructor(stream: Stream);
    checkIntegrity(): boolean;
    read(options?: Record<string, unknown>): { messages: FitMessages; errors: Error[] };
  }

  export class Encoder {
    constructor(options?: Record<string, unknown>);
    onMesg(mesgNum: number, mesg: Mesg): void;
    close(): Uint8Array;
  }

  export const Profile: {
    MesgNum: {
      FILE_ID: number;
      DEVICE_INFO: number;
      EVENT: number;
      RECORD: number;
      LAP: number;
      SESSION: number;
      ACTIVITY: number;
    } & Record<string, number>;
    types: Record<string, Record<number, string>>;
  };

  export const Utils: {
    convertDateToDateTime(date: Date): number;
  };
}
