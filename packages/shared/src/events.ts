import { z } from 'zod';

import { LegKindSchema } from './voyage.js';

/**
 * Session-level events emitted by the session engine and pushed to clients
 * over WS; the Phase 6 co-op game consumes `bothInZone` / `stepCompleted` /
 * `workoutCompleted` / `rescue`.
 */
export const SessionEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stepCompleted'), riderId: z.string(), stepIndex: z.number().int().nonnegative(), ts: z.number() }),
  z.object({ kind: z.literal('workoutCompleted'), riderId: z.string(), ts: z.number() }),
  // streakS is the CUMULATIVE in-zone streak seconds: emitted every 30 s while
  // the streak holds (30, 60, 90…), reset only when a rider leaves the zone,
  // pauses, or stops.
  z.object({ kind: z.literal('bothInZone'), ts: z.number(), streakS: z.number().int().positive() }),
  z.object({ kind: z.literal('ergGuard'), riderId: z.string(), engaged: z.boolean(), ts: z.number() }),
  z.object({ kind: z.literal('riderJoined'), riderId: z.string(), ts: z.number() }),
  z.object({ kind: z.literal('riderLeft'), riderId: z.string(), ts: z.number() }),
  z.object({ kind: z.literal('rescue'), helperId: z.string(), riderId: z.string(), ts: z.number() }),
  // Emitted when a rider's workout clock passes a flight leg's end, always
  // before the stepCompleted/workoutCompleted of the same tick.
  z.object({
    kind: z.literal('legCompleted'),
    riderId: z.string(),
    legIndex: z.number().int().nonnegative(),
    legKind: LegKindSchema,
    objective: z.boolean(),
    targetedS: z.number().int().nonnegative(),
    onTargetS: z.number().int().nonnegative(),
    clean: z.boolean(),
    ts: z.number(),
  }),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
