import { describe, expect, it } from 'vitest';

import {
  DeviceInfoSchema,
  RiderProfileSchema,
  TelemetrySampleSchema,
  VERSION,
  WorkoutSchema,
  ZwoParseError,
  fitnessFatigue,
  ftpFromHistory,
  ftpFromRamp,
  integrateDistance,
  parseZwo,
  resolveSteps,
  virtualSpeed,
  weightedPower,
} from './index.js';

describe('shared barrel', () => {
  it('exposes representative exports from every module', () => {
    expect(TelemetrySampleSchema).toBeDefined();
    expect(DeviceInfoSchema).toBeDefined();
    expect(RiderProfileSchema).toBeDefined();
    expect(WorkoutSchema).toBeDefined();
    expect(resolveSteps).toBeTypeOf('function');
    expect(parseZwo).toBeTypeOf('function');
    expect(ZwoParseError).toBeDefined();
    expect(virtualSpeed).toBeTypeOf('function');
    expect(integrateDistance).toBeTypeOf('function');
    expect(weightedPower).toBeTypeOf('function');
    expect(fitnessFatigue).toBeTypeOf('function');
    expect(ftpFromRamp).toBeTypeOf('function');
    expect(ftpFromHistory).toBeTypeOf('function');
    expect(VERSION).toBe('0.0.1');
  });
});
