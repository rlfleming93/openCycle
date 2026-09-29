import { z } from 'zod';

/**
 * One 1 Hz telemetry sample from a rider's trainer + HR strap.
 * `ts` is epoch milliseconds; `hrRrMs` are RR intervals in milliseconds;
 * `targetW` is the ERG target power when the trainer is in ERG mode.
 */
export const TelemetrySampleSchema = z.object({
  riderId: z.string().min(1),
  ts: z.number().int().positive(),
  powerW: z.number().nonnegative(),
  cadenceRpm: z.number().nonnegative(),
  hrBpm: z.number().min(20).max(250).optional(),
  hrRrMs: z.array(z.number().positive()).optional(),
  speedKmh: z.number().nonnegative(),
  distanceM: z.number().nonnegative(),
  targetW: z.number().nonnegative().optional(),
});

export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;
