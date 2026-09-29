import { useRef } from 'react';

import type { Leg, LegKind } from '@opencycle/shared';

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
 * Top-center flight plan: the lead rider's legs proportional to duration, the
 * objective of the current leg, and the survey tally. Sits inside the top
 * ~14% of the viewport so the destination stays clear in the upper-middle
 * third. Without a destination it is the open-space readout instead.
 */

/** Future-leg tint by kind: burn amber, climb light amber, cruise under-blue, rest slate. */
const FUTURE_LEG_CLASS: Record<LegKind, string> = {
  burn: 'border-over/30 bg-over/10 text-over/80',
  climb: 'border-over/20 bg-over/5 text-over/70',
  cruise: 'border-under/25 bg-under/10 text-under',
  coast: 'border-line bg-ink/5 text-dim',
  launch: 'border-line bg-ink/5 text-dim',
  approach: 'border-line bg-ink/5 text-dim',
  free: 'border-line bg-ink/5 text-dim',
};

function legClass(leg: Leg, isDone: boolean, isCurrent: boolean): string {
  if (isCurrent) return 'border-2 border-over bg-over/20 text-ink';
  if (isDone) return 'border border-on/35 bg-on/15 text-on';
  return `border ${FUTURE_LEG_CLASS[leg.kind]}`;
}

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
  // Clean surveys come from the received legCompleted events: a done leg shows
  // its survey dot only when that leg locked one.
  const cleanLegIndexes = new Set<number>();
  for (const event of events) {
    if (event.kind === 'legCompleted' && event.riderId === lead.riderId && event.objective && event.clean) {
      cleanLegIndexes.add(event.legIndex);
    }
  }
  const total = objectiveLegCount(lead.legs);
  if (!arrivedRef.current && events.some((event) => event.kind === 'workoutCompleted' && event.riderId === lead.riderId)) {
    arrivedRef.current = true;
  }
  const header = routeHeader(destination, lead.workoutRemainingS, arrivedRef.current);
  // The lock meter reads only once the leg has enough targeted seconds; until
  // then it shows 'LOCK —' with an empty bar.
  const lockPct =
    lead.legTargetedS < LEG_ON_TARGET_DISPLAY_S ? null : legOnTargetPct(lead.legTargetedS, lead.legOnTargetS);
  const fillPct =
    currentLeg === undefined || currentLeg.endS <= currentLeg.startS || lead.workoutClockS === null
      ? 0
      : Math.min(
          100,
          Math.max(0, ((lead.workoutClockS - currentLeg.startS) / (currentLeg.endS - currentLeg.startS)) * 100),
        );

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

        <div className="mt-[clamp(6px,0.52vw,16px)] flex gap-[clamp(2px,0.21vw,7px)]">
          {legs.map((leg) => {
            const isCurrent = leg.index === currentIndex;
            const isDone = currentIndex === null ? true : leg.index < currentIndex;
            return (
              <div
                key={leg.index}
                style={{ flexGrow: Math.max(1, leg.endS - leg.startS), flexBasis: 0 }}
                className={`relative flex h-[clamp(22px,1.77vw,52px)] items-center justify-center overflow-hidden rounded-[3px] font-display text-[clamp(11px,0.78vw,24px)] uppercase tracking-[0.06em] ${legClass(leg, isDone, isCurrent)}`}
              >
                {isCurrent && fillPct > 0 && (
                  <div className="absolute inset-y-0 left-0 bg-over/35" style={{ width: `${fillPct}%` }} />
                )}
                <span className="relative truncate px-1">{leg.label}</span>
                {cleanLegIndexes.has(leg.index) && (
                  <span
                    aria-hidden="true"
                    className="absolute right-[6%] top-[14%] h-[clamp(3px,0.31vw,9px)] w-[clamp(3px,0.31vw,9px)] rounded-full bg-on"
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-[clamp(6px,0.73vw,22px)] flex items-center justify-center gap-[clamp(10px,1.04vw,32px)] font-display uppercase tracking-[0.06em]">
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
