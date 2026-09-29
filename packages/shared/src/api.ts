import { z } from 'zod';

import { DeviceKindSchema } from './devices.js';
import { SessionEventSchema } from './events.js';
import { TelemetrySampleSchema } from './telemetry.js';
import { LegSchema } from './voyage.js';

/** A rider to add when starting a session; ids resolve server-side. */
export const RiderStartSchema = z.object({
  profileId: z.string().min(1),
  trainerId: z.string().min(1),
  hrmId: z.string().min(1).optional(),
  workoutId: z.string().min(1).optional(),
});

/** Per-rider view of a live session (WS `sessionState`). Null target = free ride / no workout. */
export const SessionSnapshotSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number().int().positive(),
  riders: z.array(
    z.object({
      riderId: z.string().min(1),
      name: z.string().min(1),
      ftpW: z.number().int().min(50).max(600),
      trainerId: z.string().min(1),
      hrmId: z.string().min(1).optional(),
      workoutId: z.string().min(1).optional(),
      workoutName: z.string().min(1).optional(),
      state: z.enum(['riding', 'paused', 'stopped']),
      /**
       * Index into the FLATTENED step list (ramp sub-steps and interval
       * repeats each count); the dashboard progress cursor needs this. It is
       * NOT the workout.steps index used by stepCompleted events.
       */
      stepIndex: z.number().int().nonnegative(),
      /** Server-computed seconds remaining in the current flat step, on the WORKOUT clock; null when free/no workout/finished. */
      stepRemainingS: z.number().nonnegative().nullable(),
      /**
       * TOTAL workout-clock seconds remaining across ALL remaining flat steps
       * (the whole workout, not just the current step); null when
       * free/no workout/finished. Drives game approach progress.
       */
      workoutRemainingS: z.number().nonnegative().nullable(),
      stepKind: z.enum(['steady', 'ramp', 'interval', 'free']).nullable(),
      stepCueRemainingS: z.number().nonnegative().nullable(),
      nextTargetW: z.number().nonnegative().nullable(),
      targetW: z.number().nonnegative().nullable(),
      biasPct: z.number().int().min(-15).max(15),
      elapsedS: z.number().nonnegative(),
      distanceM: z.number().nonnegative(),
      ergGuardActive: z.boolean(),
      /** Seconds on the workout clock; null when no workout or finished. */
      workoutClockS: z.number().nonnegative().nullable(),
      /** Flight legs of this rider's workout; null without a workout (kept after it finishes). */
      legs: z.array(LegSchema).nullable(),
      /** Current leg; null without a workout or after the last leg. */
      legIndex: z.number().int().nonnegative().nullable(),
      legTargetedS: z.number().nonnegative(),
      legOnTargetS: z.number().nonnegative(),
      surveysClean: z.number().int().nonnegative(),
    }),
  ),
  /** Where this session's voyage flies: the lead rider's next system; null for free-only sessions. */
  destination: z
    .object({
      seed: z.string().min(1),
      name: z.string().min(1),
      voyageIndex: z.number().int().nonnegative(),
      leadRiderId: z.string().min(1),
    })
    .nullable(),
});

export type SessionDestination = NonNullable<z.infer<typeof SessionSnapshotSchema>['destination']>;

/** Server → client WS payloads. */
export const WsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('telemetry'), samples: z.array(TelemetrySampleSchema) }),
  z.object({ type: z.literal('sessionEvent'), event: SessionEventSchema }),
  z.object({
    type: z.literal('deviceStatus'),
    deviceId: z.string().min(1),
    kind: DeviceKindSchema,
    status: z.string().min(1),
  }),
  // session: null is the explicit terminal frame, broadcast once after
  // stopSession completes (and after a startSession rollback).
  z.object({ type: z.literal('sessionState'), session: SessionSnapshotSchema.nullable() }),
  z.object({ type: z.literal('error'), message: z.string().min(1) }),
]);

/** Client → server WS payloads. */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('startSession'), riders: z.array(RiderStartSchema).min(1) }),
  z.object({ type: z.literal('setBias'), riderId: z.string().min(1), deltaPct: z.number().min(-15).max(15) }),
  z.object({ type: z.literal('pause'), riderId: z.string().min(1) }),
  z.object({ type: z.literal('resume'), riderId: z.string().min(1) }),
  z.object({ type: z.literal('skipStep'), riderId: z.string().min(1) }),
  z.object({ type: z.literal('stopRider'), riderId: z.string().min(1) }),
  z.object({ type: z.literal('stopSession') }),
]);

export type RiderStart = z.infer<typeof RiderStartSchema>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
