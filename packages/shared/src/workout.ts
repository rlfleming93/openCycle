import { z } from 'zod';

const secondsSchema = z.number().int().positive();
const pctFtpSchema = z.number().min(0).max(5);

export const StepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('steady'),
    seconds: secondsSchema,
    targetPctFtp: pctFtpSchema,
  }),
  z.object({
    kind: z.literal('ramp'),
    seconds: secondsSchema,
    fromPctFtp: pctFtpSchema,
    toPctFtp: pctFtpSchema,
  }),
  z.object({
    kind: z.literal('interval'),
    repeats: z.number().int().positive(),
    on: z.object({ seconds: secondsSchema, targetPctFtp: pctFtpSchema }),
    off: z.object({ seconds: secondsSchema, targetPctFtp: pctFtpSchema }),
  }),
  z.object({
    kind: z.literal('free'),
    seconds: secondsSchema,
  }),
]);

export type Step = z.infer<typeof StepSchema>;

export const WorkoutSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  steps: z.array(StepSchema).min(1),
});

export type Workout = z.infer<typeof WorkoutSchema>;

/** One resolved, absolute-time segment of a workout. targetPctFtp null = free ride. */
export type FlatStep = {
  startS: number;
  endS: number;
  targetPctFtp: number | null;
  /**
   * Index into workout.steps. Ramp sub-steps and interval on/off repeats all
   * share their originating step's index, so consumers can coalesce them
   * (one stepCompleted event / one FIT lap per source step).
   */
  sourceStepIndex: number;
};

/** Duration of a ramp sub-step in seconds. */
export const RAMP_SUBSTEP_S = 15;

/**
 * Flatten a workout into absolute-time segments.
 * steady -> one segment; interval -> repeats x (on, off); free -> null target;
 * ramp -> ceil(seconds/15) sub-steps (last is the remainder), each targeted at the
 * linear interpolation of fromPctFtp->toPctFtp evaluated at the sub-step's midpoint.
 * Every segment carries its originating workout.steps index in sourceStepIndex;
 * ramp sub-steps and interval on/off repeats share their step's index.
 */
export function resolveSteps(workout: Workout): FlatStep[] {
  const flat: FlatStep[] = [];
  let cursor = 0;
  workout.steps.forEach((step, sourceStepIndex) => {
    switch (step.kind) {
      case 'steady':
        flat.push({ startS: cursor, endS: cursor + step.seconds, targetPctFtp: step.targetPctFtp, sourceStepIndex });
        cursor += step.seconds;
        break;
      case 'free':
        flat.push({ startS: cursor, endS: cursor + step.seconds, targetPctFtp: null, sourceStepIndex });
        cursor += step.seconds;
        break;
      case 'interval':
        for (let r = 0; r < step.repeats; r++) {
          flat.push({ startS: cursor, endS: cursor + step.on.seconds, targetPctFtp: step.on.targetPctFtp, sourceStepIndex });
          cursor += step.on.seconds;
          flat.push({ startS: cursor, endS: cursor + step.off.seconds, targetPctFtp: step.off.targetPctFtp, sourceStepIndex });
          cursor += step.off.seconds;
        }
        break;
      case 'ramp': {
        const rampStart = cursor;
        const chunks = Math.ceil(step.seconds / RAMP_SUBSTEP_S);
        for (let i = 0; i < chunks; i++) {
          const dur = i === chunks - 1 ? step.seconds - RAMP_SUBSTEP_S * (chunks - 1) : RAMP_SUBSTEP_S;
          const midFrac = (cursor - rampStart + dur / 2) / step.seconds;
          const targetPctFtp = step.fromPctFtp + (step.toPctFtp - step.fromPctFtp) * midFrac;
          flat.push({ startS: cursor, endS: cursor + dur, targetPctFtp, sourceStepIndex });
          cursor += dur;
        }
        break;
      }
    }
  });
  return flat;
}

/** Total workout duration in seconds (intervals count as repeats x (on + off)). */
export function workoutDurationS(workout: Workout): number {
  return workout.steps.reduce((total, step) => {
    switch (step.kind) {
      case 'steady':
      case 'ramp':
      case 'free':
        return total + step.seconds;
      case 'interval':
        return total + step.repeats * (step.on.seconds + step.off.seconds);
    }
  }, 0);
}
