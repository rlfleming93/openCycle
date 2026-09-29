import { z } from 'zod';

export const DeviceKindSchema = z.enum(['trainer', 'hrm']);

/** A known BLE device; `id` is the peripheral UUID, `lastSeen` epoch ms. */
export const DeviceInfoSchema = z.object({
  id: z.string().min(1),
  kind: DeviceKindSchema,
  name: z.string(),
  lastSeen: z.number().nonnegative(),
});

/** Which rider is assigned to which trainer/HR strap (all optional until paired). */
export const RiderSlotSchema = z.object({
  riderId: z.string().min(1),
  trainerId: z.string().min(1).optional(),
  hrmId: z.string().min(1).optional(),
});

export type DeviceKind = z.infer<typeof DeviceKindSchema>;
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;
export type RiderSlot = z.infer<typeof RiderSlotSchema>;
