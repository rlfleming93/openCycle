import { useRef } from 'react';

import {
  LEG_ON_TARGET_DISPLAY_S,
  fmtClock,
  legLockFraction,
  legLockLabel,
  legObjective,
  legOnTargetPct,
  legRemainingS,
  objectiveLegCount,
  routeHeader,
} from '../../game/hud.js';
import { useAppStore } from '../../store.js';

/**
 * Top-center flight plan: the route header, the objective of the current leg
 * and the survey tally. The leg-by-leg bar that used to live here is the
 * workout sidebar's job now. Sits inside the top ~11% of the viewport so the
 * destination stays clear in the upper-middle third. Without a destination it
 * is the open-space readout instead.
 */

export default function RouteStrip() {
  const session = useAppStore((state) => state.session);
  const events = useAppStore((state) => state.events);
  // Latched: once the lead rider's workout completes the strip stays in the
  // arrival state for the rest of the session, even if the event cap evicts
  // the workoutCompleted row.
  const arrivedRef = useRef(false);
  if (session === null) return null;

  const destination = session.destination;
  const lead =
    destination === null
      ? undefined
      : (session.riders.find((rider) => rider.riderId === destination.leadRiderId) ?? session.riders[0]);

  if (destination === null || lead === undefined) {
    const distanceKm = Math.max(...session.riders.map((rider) => rider.distanceM)) / 1000;
    const elapsedS = Math.max(...session.riders.map((rider) => rider.elapsedS));
    return (
      <div className="pointer-events-none absolute inset-x-0 top-[clamp(16px,1.77vw,56px)] z-20 flex justify-center">
        <div className="rounded-full border border-line bg-panel px-[clamp(14px,1.35vw,44px)] py-[clamp(6px,0.62vw,20px)] font-display text-[clamp(16px,1.25vw,38px)] uppercase tracking-[0.06em] text-dim backdrop-blur-[10px]">
          OPEN SPACE · <span className="tabular-nums text-ink">{distanceKm.toFixed(1)} km</span> ·{' '}
          <span className="tabular-nums text-ink">{fmtClock(elapsedS)}</span>
        </div>
      </div>
    );
  }

  const legs = lead.legs ?? [];
  const currentIndex = lead.legIndex;
  const currentLeg = currentIndex === null ? undefined : legs[currentIndex];
  const remainingS = currentLeg === undefined ? null : legRemainingS(currentLeg, lead.workoutClockS);
  const total = objectiveLegCount(lead.legs);
  if (!arrivedRef.current && events.some((event) => event.kind === 'workoutCompleted' && event.riderId === lead.riderId)) {
    arrivedRef.current = true;
  }
  const header = routeHeader(destination, lead.workoutRemainingS, arrivedRef.current);
  // The lock meter reads only once the leg has enough targeted seconds; until
  // then it shows 'LOCK —' with an empty bar.
  const lockPct =
    lead.legTargetedS < LEG_ON_TARGET_DISPLAY_S ? null : legOnTargetPct(lead.legTargetedS, lead.legOnTargetS);

  return (
    <aside
      aria-label="Flight plan"
      className="pointer-events-none absolute inset-x-0 top-[clamp(16px,1.77vw,56px)] z-20 flex justify-center"
    >
      <div className="w-[61.458vw] min-w-[420px]">
        <div className="flex items-baseline justify-between gap-4 font-display uppercase tracking-[0.06em]">
          <div className="min-w-0 truncate text-[clamp(20px,1.5625vw,44px)] font-semibold text-ink">
            {header.left}
          </div>
          <div className="shrink-0 text-[clamp(17px,1.354vw,38px)] text-dim">
            {header.right.slice(0, header.right.lastIndexOf(' ') + 1)}
            <span className="font-bold tabular-nums text-ink">
              {header.right.slice(header.right.lastIndexOf(' ') + 1)}
            </span>
          </div>
        </div>

        <div className="mt-[clamp(4px,0.52vw,16px)] flex items-center justify-center gap-[clamp(10px,1.04vw,32px)] font-display uppercase tracking-[0.06em]">
          {currentLeg !== undefined && (
            <p className="truncate text-[clamp(15px,1.25vw,38px)] text-over">
              {currentLeg.label} — {legObjective(currentLeg)}
              {remainingS !== null && <span className="text-dim"> · {fmtClock(remainingS)} LEFT</span>}
              {currentLeg.kind === 'burn' && (
                <span className="text-dim">
                  {' · '}
                  <span className={lockPct === null ? 'text-dim' : 'text-ink'}>
                    {legLockLabel(lead.legTargetedS, lead.legOnTargetS)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="ml-[clamp(4px,0.42vw,14px)] inline-block h-[clamp(4px,0.42vw,14px)] w-[clamp(36px,3.65vw,120px)] overflow-hidden rounded-full bg-ink/15 align-middle"
                  >
                    <span
                      className="block h-full rounded-full bg-on"
                      style={{ width: `${legLockFraction(lead.legTargetedS, lead.legOnTargetS) * 100}%` }}
                    />
                  </span>
                </span>
              )}
            </p>
          )}
          <span className="shrink-0 rounded-full border border-line bg-void/50 px-[clamp(8px,0.83vw,24px)] py-[clamp(2px,0.21vw,6px)] text-[clamp(12px,0.94vw,28px)] text-dim">
            SURVEYS <span className="tabular-nums text-on">{lead.surveysClean}</span>/{total}
          </span>
        </div>
      </div>
    </aside>
  );
}
