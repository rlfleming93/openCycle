import type { CSSProperties } from 'react';

import type { Leg, LegKind, SessionSnapshot } from '@opencycle/shared';

import type { ProfileBar } from '../../game/hud.js';
import {
  LEG_ON_TARGET_DISPLAY_S,
  STEP_CURRENT_SPAN,
  STEP_WINDOW_UNITS,
  fmtClock,
  legFillFraction,
  legLabel,
  legOnTargetPct,
  legRemainingS,
  legTargetLabel,
  profilePlayhead,
  stepWindow,
  surveyMarker,
  surveyMarks,
  workoutHeader,
  workoutProfile,
} from '../../game/hud.js';
import { useAppStore } from '../../store.js';

type Rider = SessionSnapshot['riders'][number];

/**
 * Zwift-style workout plan on the left of the space game: the whole workout as
 * a mini profile with a live playhead, then the step list scrolling so the
 * current step sits near the top. The panel lives inside the world's left
 * keep-out band (x 1.35–19.5%, y 15.2–56.6% of the viewport, measured at
 * 1920x1080 and 3840x2160) and is DOM only — the world never draws a ship, the
 * raider or the destination through it, and the ride page renders it after the
 * destination marker so the panel paints over that ring where they meet.
 *
 * Hidden on free rides, without a workout, and whenever the flat dashboard is
 * on (the ride page renders it inside the space-game branch only).
 */

/**
 * One step row's height; the current row and the list offset are multiples of
 * it. The panel's own height is 41.4vh, and its contents are a fixed fraction
 * of that (header 4.4vh, profile 5vh, list 6.4 rows, gaps 1.4vh), so the row
 * height is what keeps the list inside the band at any viewport height while
 * the vw term pins the type scale at 1080p and 4K.
 */
const PANEL_STYLE = {
  '--row-h': 'clamp(22px, min(4.4vh, 2.5vw), 100px)',
} as CSSProperties;

/** Kind tone: the same reading the route strip's leg bar used. */
const KIND_TONE: Record<LegKind, { swatch: string; bar: string }> = {
  burn: { swatch: 'bg-over', bar: 'bg-over' },
  climb: { swatch: 'bg-over/60', bar: 'bg-over/60' },
  cruise: { swatch: 'bg-under', bar: 'bg-under' },
  coast: { swatch: 'bg-dim/40', bar: 'bg-ink/45' },
  launch: { swatch: 'bg-dim/40', bar: 'bg-ink/45' },
  approach: { swatch: 'bg-dim/40', bar: 'bg-ink/45' },
  free: { swatch: 'bg-dim/40', bar: 'bg-ink/45' },
};

/** Gridlines in the profile, as %FTP readings. */
const GRID_PCT = [0.5, 0.75, 1] as const;

/** Lead rider of the voyage: the destination's lead, else the first rider. */
function leadRider(session: SessionSnapshot): Rider | undefined {
  if (session.destination === null) return session.riders[0];
  return session.riders.find((rider) => rider.riderId === session.destination?.leadRiderId) ?? session.riders[0];
}

export default function WorkoutSidebar() {
  const session = useAppStore((state) => state.session);
  const events = useAppStore((state) => state.events);
  const spaceGame = useAppStore((state) => state.spaceGame);

  if (session === null || !spaceGame) return null;
  const lead = leadRider(session);
  const legs = lead?.legs ?? null;
  if (lead === undefined || legs === null || legs.length === 0) return null;

  const profile = workoutProfile(legs);
  // After the last step the snapshot's clock goes null while the legs stay: the
  // panel then reads as a finished workout instead of an unrun one.
  const clockS = lead.workoutClockS ?? profile.totalS;
  const header = workoutHeader(lead.workoutName, clockS, profile.totalS, lead.workoutRemainingS);
  const playhead = profilePlayhead(legs, clockS);
  const marks = surveyMarks(events, lead.riderId);
  const currentIndex = lead.legIndex;
  // Anchor the window on the live leg; a finished workout keeps the last one in
  // view rather than snapping back to the top.
  const view = stepWindow(legs.length, currentIndex ?? legs.length - 1, STEP_WINDOW_UNITS, STEP_CURRENT_SPAN);

  return (
    <aside
      aria-label="Workout plan"
      style={PANEL_STYLE}
      className="pointer-events-none absolute left-[clamp(12px,1.35vw,58px)] top-[15.2vh] z-20 flex h-[41.4vh] w-[clamp(160px,18.2vw,700px)] flex-col overflow-hidden rounded-[14px] border border-line bg-deep/80 px-[clamp(8px,0.62vw,24px)] py-[1vh] font-display uppercase tracking-[0.06em] text-ink backdrop-blur-[10px]"
    >
      <header className="flex h-[4.4vh] shrink-0 flex-col justify-center gap-[0.4vh]">
        <h2 className="truncate text-[clamp(12px,min(0.99vw,1.77vh),38px)] font-semibold leading-[1.2] text-ink">
          {header.name}
        </h2>
        <p className="flex items-baseline justify-between gap-[clamp(4px,0.42vw,16px)] text-[clamp(10px,min(0.78vw,1.4vh),30px)] leading-[1.3] text-dim">
          <span className="truncate">
            <span className="tabular-nums text-ink/90">{header.clock}</span>
          </span>
          <span
            className={`shrink-0 tabular-nums ${header.remaining === 'COMPLETE' ? 'text-on' : 'text-over'}`}
          >
            {header.remaining}
          </span>
        </p>
      </header>

      <Profile
        bars={profile.bars}
        scale={profile.scale}
        playhead={playhead}
        label={`Workout profile: ${legs.length} steps over ${fmtClock(profile.totalS)}, now ${fmtClock(clockS)}`}
      />

      <div
        className="relative mt-[0.7vh] shrink-0 overflow-hidden"
        style={{ height: `calc(var(--row-h) * ${STEP_WINDOW_UNITS})` }}
      >
        <ol
          className="transition-transform duration-[420ms] ease-out motion-reduce:transition-none"
          style={{ transform: `translateY(calc(var(--row-h) * ${-view.offset}))` }}
        >
          {legs.map((leg) => {
            const isCurrent = leg.index === currentIndex;
            const isDone = !isCurrent && leg.endS <= clockS;
            return (
              <StepRow
                key={leg.index}
                leg={leg}
                state={isCurrent ? 'current' : isDone ? 'done' : 'future'}
                riders={session.riders.length}
                ftpW={lead.ftpW}
                biasPct={lead.biasPct}
                clockS={clockS}
                targetedS={lead.legTargetedS}
                onTargetS={lead.legOnTargetS}
                clean={marks[leg.index]}
              />
            );
          })}
        </ol>
        {view.moreAbove && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-[clamp(6px,0.83vh,20px)] bg-gradient-to-b from-deep to-transparent"
          />
        )}
        {view.moreBelow && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-[clamp(6px,0.83vh,20px)] bg-gradient-to-t from-deep to-transparent"
          />
        )}
      </div>
    </aside>
  );
}

/** Whole-workout bar chart: duration across, %FTP up, dimmed behind the playhead. */
function Profile({
  bars,
  scale,
  playhead,
  label,
}: {
  bars: ProfileBar[];
  scale: number;
  playhead: number;
  label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className="relative mt-[0.7vh] h-[5vh] shrink-0 overflow-hidden rounded-[4px] bg-void/45"
    >
      {GRID_PCT.map((pct) => {
        const top = (1 - pct / scale) * 100;
        // 0 is the track's own top edge (the scale ceiling), 100 the floor.
        if (top < 0 || top >= 100) return null;
        return (
          <div
            key={pct}
            aria-hidden="true"
            className="absolute inset-x-0 border-t border-line/70"
            style={{ top: `${top}%` }}
          />
        );
      })}

      {bars.map((bar) => {
        const heightLeft = 1 - bar.top;
        const heightRight = 1 - bar.topRight;
        // A sloped bar is a trapezoid: both edges sit in one box as tall as the
        // taller edge, and the clip cuts the other down to its own height.
        const height = Math.max(heightLeft, heightRight, 0.002);
        const tone = KIND_TONE[bar.kind];
        return (
          <div
            key={bar.index}
            className={`absolute bottom-0 border-r border-void/60 ${tone.bar}`}
            style={{
              left: `${bar.x * 100}%`,
              width: `${bar.width * 100}%`,
              height: `${height * 100}%`,
              clipPath: bar.ramp
                ? `polygon(0 ${(1 - heightLeft / height) * 100}%, 100% ${(1 - heightRight / height) * 100}%, 100% 100%, 0 100%)`
                : undefined,
            }}
          />
        );
      })}

      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-void/60 transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
        style={{ width: `${playhead * 100}%` }}
      />
      {/* Cursor: a dark casing with a light stem, so it reads over the amber
          burn bars as clearly as over the dark track. */}
      <div
        aria-hidden="true"
        data-playhead
        className="absolute inset-y-0 flex w-[clamp(5px,0.31vw,11px)] -translate-x-1/2 justify-center bg-void/75 transition-[left] duration-1000 ease-linear motion-reduce:transition-none"
        style={{ left: `${playhead * 100}%` }}
      >
        <span className="h-full w-[clamp(2px,0.16vw,6px)] bg-ink" />
        <span className="absolute -top-[3px] h-[clamp(6px,0.42vw,14px)] w-[clamp(6px,0.42vw,14px)] rounded-full border-2 border-void/80 bg-ink" />
      </div>
    </div>
  );
}

interface StepRowProps {
  leg: Leg;
  state: 'done' | 'current' | 'future';
  riders: number;
  ftpW: number;
  biasPct: number;
  clockS: number;
  targetedS: number;
  onTargetS: number;
  clean: boolean | undefined;
}

function StepRow({ leg, state, riders, ftpW, biasPct, clockS, targetedS, onTargetS, clean }: StepRowProps) {
  const isCurrent = state === 'current';
  const isDone = state === 'done';
  const remainingS = legRemainingS(leg, clockS);
  const marker = isDone ? surveyMarker(clean) : null;
  const onTarget = isCurrent && leg.objective && targetedS >= LEG_ON_TARGET_DISPLAY_S;
  const tone = KIND_TONE[leg.kind];
  // Done rows dim by type colour, not by opacity: at 45% opacity the small
  // dim text falls to ~2:1 against the panel and stops being readable.
  const labelTone = isCurrent
    ? 'font-semibold text-ink'
    : isDone
      ? 'font-medium text-ink/60'
      : 'font-medium text-ink/85';
  const metaTone = isDone ? 'text-dim/90' : 'text-dim';

  return (
    <li
      aria-current={isCurrent ? 'step' : undefined}
      style={{ height: isCurrent ? `calc(var(--row-h) * ${STEP_CURRENT_SPAN})` : 'var(--row-h)' }}
      className={`relative flex flex-col justify-center gap-[clamp(1px,0.1vw,3px)] overflow-hidden border-line/50 px-[clamp(5px,0.42vw,16px)] ${
        isCurrent ? 'rounded-[6px] border border-over/45 bg-over/[0.08]' : 'border-b last:border-b-0'
      }`}
    >
      <p className="flex items-baseline gap-[clamp(4px,0.42vw,16px)] leading-[1.15]">
        <span
          aria-hidden="true"
          className={`h-[clamp(8px,0.63vw,24px)] w-[clamp(3px,0.21vw,8px)] shrink-0 rounded-[2px] ${tone.swatch} ${
            isDone ? 'opacity-50' : ''
          }`}
        />
        <span className={`min-w-0 flex-1 truncate text-[clamp(12px,min(1.09vw,1.95vh),42px)] ${labelTone}`}>
          {legLabel(leg.kind, leg)}
        </span>
        <span className={`shrink-0 tabular-nums text-[clamp(10px,min(0.885vw,1.58vh),34px)] ${metaTone}`}>
          {isCurrent && remainingS !== null ? `${fmtClock(remainingS)} LEFT` : fmtClock(leg.endS - leg.startS)}
        </span>
      </p>

      <p className="flex items-baseline justify-between gap-[clamp(4px,0.42vw,16px)] leading-[1.15] text-[clamp(10px,min(0.885vw,1.58vh),34px)]">
        <span className={`truncate tabular-nums ${metaTone}`}>
          {legTargetLabel(leg, { riders, ftpW, biasPct })}
        </span>
        {onTarget ? (
          <span className="shrink-0 text-on">
            ON TARGET <span className="font-semibold tabular-nums">{legOnTargetPct(targetedS, onTargetS)}%</span>
          </span>
        ) : marker !== null ? (
          <span className={`shrink-0 leading-none ${marker.clean ? 'font-semibold text-on' : 'text-dim'}`}>
            {marker.clean ? (
              <span aria-hidden="true" className="text-[1.25em]">
                {marker.glyph}
              </span>
            ) : (
              // A drawn dot rather than the · glyph: the glyph's ink is ~2px at
              // TV sizes, which reads as a stray pixel instead of "no survey".
              <span
                aria-hidden="true"
                className="inline-block h-[clamp(5px,0.36vw,14px)] w-[clamp(5px,0.36vw,14px)] rounded-full bg-dim"
              />
            )}
            <span className="sr-only">{marker.title}</span>
          </span>
        ) : null}
      </p>

      {isCurrent && (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[clamp(2px,0.21vw,6px)] bg-ink/10">
          <span
            className={`block h-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none ${tone.bar}`}
            style={{ width: `${legFillFraction(leg, clockS) * 100}%` }}
          />
        </span>
      )}
    </li>
  );
}
