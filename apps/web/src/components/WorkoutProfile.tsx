import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

import type { SessionSnapshot } from '@opencycle/shared';

import { zoneFill } from '../lib/zones.js';

type Rider = SessionSnapshot['riders'][number];

/**
 * v1 limitation: the session snapshot carries only stepIndex / stepRemainingS /
 * targetW — not the resolved workout (there is no workout-detail endpoint yet;
 * the full resolveSteps(workout) profile graph is a Phase 5 candidate). So we
 * render the CURRENT step as a single segmented bar with progress derived from
 * the server's stepRemainingS plus a step counter.
 *
 * Step-duration inference: the snapshot does not carry the step's total
 * duration. We approximate it as the largest stepRemainingS observed per
 * stepIndex (a small ref map): the value seen at step entry is the full
 * duration, and later observations only ever shrink, so the running max is the
 * best available estimate. Free steps (stepRemainingS null) render hatched
 * with no fill.
 */

function fmtSeconds(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}


const FREE_HATCH = {
  backgroundImage: 'repeating-linear-gradient(45deg, #52525b 0 10px, #3f3f46 10px 20px)',
} as const;

export default function WorkoutProfile({ rider }: { rider: Rider }) {
  // Per stepIndex, the largest stepRemainingS observed (≈ step duration).
  const durationsRef = useRef(new Map<number, number>());

  useEffect(() => {
    if (rider.stepRemainingS === null) return;
    const seen = durationsRef.current.get(rider.stepIndex) ?? 0;
    if (rider.stepRemainingS > seen) {
      durationsRef.current.set(rider.stepIndex, rider.stepRemainingS);
    }
  }, [rider.stepIndex, rider.stepRemainingS]);

  const stepRemainingS = rider.stepRemainingS;
  const isFree = stepRemainingS === null;
  const stepDurationS = stepRemainingS !== null ? (durationsRef.current.get(rider.stepIndex) ?? 0) : 0;
  const progress =
    stepRemainingS !== null && stepDurationS > 0
      ? Math.min(1, Math.max(0, 1 - stepRemainingS / stepDurationS))
      : 0;
  const fill =
    rider.targetW !== null && rider.ftpW > 0
      ? zoneFill((rider.targetW / rider.ftpW) * 100)
      : 'bg-dim';
  const remaining = stepRemainingS !== null ? fmtSeconds(stepRemainingS) : '—';
  const fillClassName = `h-full rounded-full transition-[width] duration-500 ${fill}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-xl">
        <span className="font-bold text-ink">STEP {rider.stepIndex + 1}</span>
        <span className="tabular-nums text-ink/90">{isFree ? 'FREE RIDE' : remaining}</span>
      </div>
      <div
        className="h-5 w-full overflow-hidden rounded-full bg-panel"
        style={isFree ? FREE_HATCH : undefined}
      >
        {!isFree && (
          <div
            className={fillClassName}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        )}
      </div>
    </div>
  );
}
