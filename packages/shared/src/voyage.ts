import { z } from 'zod';

import { hashSeed, mulberry32 } from './random.js';
import type { Workout } from './workout.js';

/** Source steps longer than this split into equal flight legs. */
export const LEG_MAX_S = 600;
/** Seconds at the start of each leg that never count (ERG settle time). */
export const LEG_SETTLE_S = 5;
/** Fraction of targeted seconds that must be on target for a clean survey. */
export const LEG_CLEAN_FRACTION = 0.85;
/** Minimum targeted seconds before a leg can be clean. */
export const LEG_MIN_TARGETED_S = 20;

/** Steady legs: ≥ BURN_MIN_PCT are burns, < COAST_MAX_PCT coasts; < ENDS_MAX_PCT as first/last step are launch/approach. */
const BURN_MIN_PCT = 0.88;
const COAST_MAX_PCT = 0.6;
const ENDS_MAX_PCT = 0.76;

export const LegKindSchema = z.enum(['launch', 'cruise', 'climb', 'burn', 'coast', 'approach', 'free']);
export type LegKind = z.infer<typeof LegKindSchema>;

export const LegSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: LegKindSchema,
  label: z.string(),
  startS: z.number().nonnegative(),
  endS: z.number().nonnegative(),
  startPctFtp: z.number().nullable(),
  endPctFtp: z.number().nullable(),
  objective: z.boolean(),
});
export type Leg = z.infer<typeof LegSchema>;

const OBJECTIVE: Record<LegKind, boolean> = {
  launch: false,
  cruise: true,
  climb: true,
  burn: true,
  coast: false,
  approach: false,
  free: false,
};

type RawLeg = Omit<Leg, 'index' | 'label' | 'objective'>;

/**
 * Split a workout into flight legs on the same absolute clock as resolveSteps.
 * Interval on/off phases become burn/coast legs; steady/ramp/free source steps
 * become one leg each, split into equal legs when longer than LEG_MAX_S.
 */
export function resolveLegs(workout: Workout): Leg[] {
  const raw: RawLeg[] = [];
  const lastIndex = workout.steps.length - 1;
  let cursor = 0;

  const pushSplit = (
    seconds: number,
    kind: LegKind,
    pctAt: (offsetS: number) => number | null,
  ): void => {
    const n = Math.ceil(seconds / LEG_MAX_S);
    const each = Math.floor(seconds / n);
    for (let i = 0; i < n; i++) {
      const offset = i * each;
      const dur = i === n - 1 ? seconds - each * (n - 1) : each;
      raw.push({
        kind,
        startS: cursor,
        endS: cursor + dur,
        startPctFtp: pctAt(offset),
        endPctFtp: pctAt(offset + dur),
      });
      cursor += dur;
    }
  };

  workout.steps.forEach((step, i) => {
    const first = i === 0;
    const last = i === lastIndex;
    switch (step.kind) {
      case 'free':
        pushSplit(step.seconds, 'free', () => null);
        break;
      case 'interval':
        for (let r = 0; r < step.repeats; r++) {
          raw.push({
            kind: 'burn',
            startS: cursor,
            endS: cursor + step.on.seconds,
            startPctFtp: step.on.targetPctFtp,
            endPctFtp: step.on.targetPctFtp,
          });
          cursor += step.on.seconds;
          raw.push({
            kind: 'coast',
            startS: cursor,
            endS: cursor + step.off.seconds,
            startPctFtp: step.off.targetPctFtp,
            endPctFtp: step.off.targetPctFtp,
          });
          cursor += step.off.seconds;
        }
        break;
      case 'steady': {
        const pct = step.targetPctFtp;
        const kind: LegKind =
          first && pct < ENDS_MAX_PCT
            ? 'launch'
            : last && pct < ENDS_MAX_PCT
              ? 'approach'
              : pct >= BURN_MIN_PCT
                ? 'burn'
                : pct < COAST_MAX_PCT
                  ? 'coast'
                  : 'cruise';
        pushSplit(step.seconds, kind, () => pct);
        break;
      }
      case 'ramp': {
        const { fromPctFtp: from, toPctFtp: to, seconds } = step;
        const kind: LegKind =
          first && to > from ? 'launch' : last && to < from ? 'approach' : to > from ? 'climb' : 'coast';
        pushSplit(seconds, kind, (offset) => from + (to - from) * (offset / seconds));
        break;
      }
    }
  });

  const burnTotal = raw.filter((l) => l.kind === 'burn').length;
  let burnN = 0;
  return raw.map((l, index) => ({
    ...l,
    index,
    label: l.kind === 'burn' ? `BURN ${++burnN}/${burnTotal}` : LABELS[l.kind],
    objective: OBJECTIVE[l.kind],
  }));
}

const LABELS: Record<Exclude<LegKind, 'burn'>, string> = {
  launch: 'LAUNCH',
  cruise: 'CRUISE',
  climb: 'CLIMB',
  coast: 'COAST',
  approach: 'APPROACH',
  free: 'OPEN SPACE',
};

/** A survey is clean when an objective leg held target for ≥85% of ≥20 targeted seconds. */
export function isCleanLeg(objective: boolean, targetedS: number, onTargetS: number): boolean {
  return objective && targetedS >= LEG_MIN_TARGETED_S && onTargetS >= LEG_CLEAN_FRACTION * targetedS;
}

const NAME_A = [
  'Ke', 'Ma', 'Ri', 'Ve', 'Lu', 'No', 'Sa', 'Ta', 'Zy', 'Or',
  'El', 'An', 'Cy', 'Dra', 'Pha', 'Te', 'Mi', 'So', 'Qu', 'Hy',
] as const;
const NAME_B = [
  'lith', 'mara', 'vion', 'nia', 'thon', 'rea', 'dora', 'phel', 'gara', 'nys',
  'tor', 'ume', 'cine', 'rax', 'dune', 'ella', 'oris', 'anthe', 'raeus', 'velle',
] as const;

/** Deterministic two-syllable name for any seed (planets, beacons, rescues). */
export function nameFromSeed(seed: string): string {
  const rng = mulberry32(hashSeed(`${seed}:name`));
  const a = NAME_A[Math.floor(rng() * NAME_A.length)] ?? 'Ke';
  const b = NAME_B[Math.floor(rng() * NAME_B.length)] ?? 'lith';
  return a + b;
}

/** Seed of a rider's index-th voyage destination. */
export function voyageSeed(riderId: string, index: number): string {
  return `${riderId}:voyage:${index}`;
}
