import { z } from 'zod';

/**
 * A rider profile. No credentials are ever stored here: Playwright Garmin
 * storage state lives on disk only, keyed by rider id.
 */
export const RiderProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ftpW: z.number().int().min(50).max(600),
  weightKg: z.number().min(30).max(200),
  restingHr: z.number().int().min(25).max(100).optional(),
  maxHr: z.number().int().min(120).max(230).optional(),
  garmin: z
    .object({
      email: z.email(),
      /** Upload finalized rides to Garmin Connect automatically (requires a saved login). */
      autoUpload: z.boolean().optional(),
    })
    .optional(),
});

export type RiderProfile = z.infer<typeof RiderProfileSchema>;
