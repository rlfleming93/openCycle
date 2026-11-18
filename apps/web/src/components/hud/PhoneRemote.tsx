import { useEffect, useRef, useState } from 'react';

import type { Leg, SessionSnapshot, TelemetrySample } from '@opencycle/shared';
import { useNavigate } from 'react-router-dom';

import { getEffortCue, type EffortCue } from '../../game/feedback.js';
import {
  fmtClock,
  legFillFraction,
  legRemainingS,
  legTargetLabel,
  profilePlayhead,
  trailingAvgCadence,
  trailingAvgPower,
  workoutProfile,
} from '../../game/hud.js';
import { identityColor } from '../../lib/identity.js';
import { sendWs } from '../../lib/ws.js';
import { targetRatioColor, zoneColor } from '../../lib/zones.js';
import { useAppStore } from '../../store.js';
import { KIND_TONE, Profile } from './WorkoutSidebar.js';

type Rider = SessionSnapshot['riders'][number];

const NO_SAMPLES: TelemetrySample[] = [];
const CONFIRM_MS = 5000;
/** The server clamps ERG bias to ±15 %. */
const BIAS_LIMIT = 15;

const CUE_TONE: Record<EffortCue['tone'], string> = {
  neutral: 'border-line text-dim',
  cool: 'border-under/55 text-under',
  emerald: 'border-on/55 text-on',
  amber: 'border-over/55 text-over',
};

const LABEL = 'font-display text-[13px] uppercase tracking-[0.08em] text-dim';

/**
 * The ride page as a phone remote (portrait and landscape phones): the numbers
 * first, the current and next step under them, and every ride control in a
 * thumb dock at the bottom. No game canvas: the Mac/TV shows the voyage, the
 * phone is the handlebar remote. Safe-area insets pad every edge, since the
 * page runs standalone from the home screen.
 */
export default function PhoneRemote({ session }: { session: SessionSnapshot }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const riderIndex = Math.max(
    0,
    session.riders.findIndex((rider) => rider.riderId === selectedId),
  );
  const rider = session.riders[riderIndex]!;

  return (
    <div className="absolute inset-0 flex flex-col pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] pt-[max(10px,env(safe-area-inset-top))]">
      {/* Landscape has no height for a tab row: the tabs join the header line. */}
      <div className="flex shrink-0 flex-col gap-1 landscape:flex-row landscape:items-center landscape:gap-4">
        <Header rider={rider} />
        {session.riders.length > 1 && (
          <RiderTabs riders={session.riders} selected={rider.riderId} onSelect={setSelectedId} />
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="flex h-full flex-col gap-3 overflow-y-auto py-3 landscape:grid landscape:grid-cols-2 landscape:gap-x-5 landscape:py-2">
          <Readout rider={rider} riderIndex={riderIndex} multiRider={session.riders.length > 1} />
          <StepPanel rider={rider} stepsOpen={stepsOpen} onToggleSteps={() => setStepsOpen((open) => !open)} />
        </div>
        {stepsOpen && rider.legs !== null && (
          <StepSheet rider={rider} legs={rider.legs} onClose={() => setStepsOpen(false)} />
        )}
      </div>
      <ControlDock rider={rider} />
    </div>
  );
}

function Header({ rider }: { rider: Rider }) {
  const wsStatus = useAppStore((state) => state.wsStatus);
  const dot = wsStatus === 'open' ? 'bg-on' : wsStatus === 'connecting' ? 'animate-pulse bg-over' : 'bg-danger';
  const right =
    rider.workoutName === undefined
      ? `${(rider.distanceM / 1000).toFixed(1)} km`
      : rider.workoutRemainingS === null
        ? rider.workoutName
        : `${fmtClock(rider.workoutRemainingS)} left`;

  return (
    <header className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-3 font-display text-[15px] uppercase tracking-[0.06em] text-dim landscape:flex-1">
      <span className="flex shrink-0 items-center gap-2">
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dot}`} />
        {wsStatus === 'open' ? (
          <>
            Elapsed <span className="font-semibold tabular-nums text-ink">{fmtClock(rider.elapsedS)}</span>
          </>
        ) : (
          <span className="text-over">Reconnecting…</span>
        )}
      </span>
      <span className="min-w-0 truncate text-right">
        {rider.workoutName !== undefined && rider.workoutRemainingS !== null && (
          <span className="text-dim">{rider.workoutName} · </span>
        )}
        <span className="tabular-nums text-ink">{right}</span>
      </span>
    </header>
  );
}

function RiderTabs({
  riders,
  selected,
  onSelect,
}: {
  riders: Rider[];
  selected: string;
  onSelect: (riderId: string) => void;
}) {
  return (
    <div role="tablist" aria-label="Rider" className="flex shrink-0 gap-1 rounded-[12px] border border-line p-1 landscape:w-[44%]">
      {riders.map((rider, index) => (
        <button
          key={rider.riderId}
          type="button"
          role="tab"
          aria-selected={rider.riderId === selected}
          onClick={() => onSelect(rider.riderId)}
          className={`flex min-h-11 min-w-0 flex-1 touch-manipulation items-center justify-center gap-2 rounded-[8px] font-display text-[17px] uppercase tracking-[0.06em] ${
            rider.riderId === selected ? 'bg-ink/10 font-semibold text-ink' : 'text-dim active:bg-ink/10'
          }`}
        >
          <span aria-hidden="true" className="h-1 w-4 shrink-0 rounded-[2px]" style={{ backgroundColor: identityColor(index) }} />
          <span className="truncate">{rider.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Power against target, then cadence and heart rate: the numbers read at a glance. */
function Readout({ rider, riderIndex, multiRider }: { rider: Rider; riderIndex: number; multiRider: boolean }) {
  const latest = useAppStore((state) => state.latest[rider.riderId]);
  const telemetry = useAppStore((state) => state.telemetry[rider.riderId]) ?? NO_SAMPLES;
  const deviceStatus = useAppStore((state) => state.deviceStatus);

  const avgPower = trailingAvgPower(telemetry);
  const avgCadence = trailingAvgCadence(telemetry);
  const hasTelemetry = telemetry.length > 0 && latest !== undefined;
  const hasTarget = rider.targetW !== null && rider.targetW > 0;
  const powerColor = hasTarget
    ? targetRatioColor(avgPower / rider.targetW!)
    : zoneColor(rider.ftpW > 0 ? (avgPower / rider.ftpW) * 100 : 0);
  const trainerStatus = deviceStatus[rider.trainerId];
  const hrmStatus = rider.hrmId !== undefined ? deviceStatus[rider.hrmId] : undefined;
  const cue = getEffortCue({
    rider,
    trainerStatus,
    avgPowerW: hasTelemetry ? avgPower : null,
    cadenceRpm: hasTelemetry ? latest.cadenceRpm : null,
  });
  const paused = rider.state === 'paused';
  const fade = paused ? 'opacity-40' : '';
  // A pause takes the cue chip (no extra banner row: landscape has no height to spare).
  const chipTone = !paused
    ? CUE_TONE[cue.tone]
    : rider.pauseReason === 'trainer'
      ? 'border-danger/55 bg-danger/10 text-danger'
      : 'border-over/55 bg-over/10 text-over';

  return (
    <section aria-label={`${rider.name} numbers`} className="flex shrink-0 grow flex-col justify-center gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className={`${LABEL} flex min-w-0 items-center gap-2`}>
          {multiRider && (
            <span aria-hidden="true" className="h-1 w-4 shrink-0 rounded-[2px]" style={{ backgroundColor: identityColor(riderIndex) }} />
          )}
          <span className="truncate">{multiRider ? rider.name : 'Power'}</span>
        </span>
        <span
          aria-live="polite"
          className={`truncate rounded-[8px] border-2 px-2 py-0.5 font-display text-[15px] font-bold uppercase tracking-[0.06em] ${chipTone}`}
        >
          {cue.instruction}
        </span>
      </div>

      <div className={`flex items-end justify-between gap-3 ${fade}`}>
        <p
          className={`flex items-baseline font-display text-[clamp(84px,min(34vw,15vh),150px)] font-bold leading-none tabular-nums landscape:text-[clamp(64px,24vh,112px)] ${powerColor}`}
        >
          {Math.round(avgPower)}
          <span className="ml-1 text-[0.24em] text-dim">W</span>
        </p>
        {hasTarget && (
          <div className="shrink-0 pb-1 text-right">
            <p className={LABEL}>Target</p>
            <p className="font-display text-[38px] font-semibold leading-none tabular-nums text-ink">
              {Math.round(rider.targetW!)}
              <span className="ml-1 text-[15px] text-dim">W</span>
            </p>
          </div>
        )}
      </div>

      <dl className={`grid grid-cols-2 divide-x divide-line border-y border-line ${fade}`}>
        <Stat label="Cadence" unit="rpm" value={avgCadence === null ? null : Math.round(avgCadence)} tone={cadenceTone(avgCadence)} />
        <Stat
          label={hrmStatus === 'disconnected' || hrmStatus === 'error' ? 'HR offline' : 'Heart rate'}
          unit="bpm"
          value={latest?.hrBpm ?? null}
          tone="text-ink"
          className="pl-4"
        />
      </dl>
      {(trainerStatus === 'disconnected' || trainerStatus === 'error') && (
        <p className="font-display text-[15px] font-semibold uppercase tracking-[0.06em] text-danger">Trainer offline</p>
      )}
    </section>
  );
}

function cadenceTone(rpm: number | null): string {
  if (rpm === null) return 'text-ink';
  if (rpm < 80) return 'text-under';
  if (rpm > 100) return 'text-over';
  return 'text-on';
}

function Stat({
  label,
  unit,
  value,
  tone,
  className = '',
}: {
  label: string;
  unit: string;
  value: number | null;
  tone: string;
  className?: string;
}) {
  return (
    <div className={`py-2 ${className}`}>
      <dt className={LABEL}>{label}</dt>
      <dd className={`mt-1 font-display text-[clamp(40px,6vh,52px)] font-bold leading-none tabular-nums landscape:text-[36px] ${tone}`}>
        {value ?? '—'}
        <span className="ml-1 text-[15px] font-semibold text-dim">{unit}</span>
      </dd>
    </div>
  );
}

/** Current step with its time left, the next step, and the whole workout as a strip. */
function StepPanel({
  rider,
  stepsOpen,
  onToggleSteps,
}: {
  rider: Rider;
  stepsOpen: boolean;
  onToggleSteps: () => void;
}) {
  const legs = rider.legs;
  if (legs === null || legs.length === 0) {
    return (
      <section aria-label="Ride" className="rounded-[14px] border border-line bg-panel px-4 py-3">
        <p className={LABEL}>Now</p>
        <p className="font-display text-[30px] font-bold uppercase leading-tight tracking-[0.04em] text-ink">Free ride</p>
        <p className="font-display text-[17px] uppercase tracking-[0.06em] text-dim">
          <span className="tabular-nums text-ink">{(rider.distanceM / 1000).toFixed(1)}</span> km
        </p>
      </section>
    );
  }

  const profile = workoutProfile(legs);
  const clockS = rider.workoutClockS ?? profile.totalS;
  const current = rider.legIndex === null ? undefined : legs[rider.legIndex];
  const next = rider.legIndex === null ? undefined : legs[rider.legIndex + 1];
  const target = { riders: 1, ftpW: rider.ftpW, biasPct: rider.biasPct };

  return (
    <section aria-label="Workout" className="flex shrink-0 flex-col gap-2 landscape:justify-center">
      <CurrentStep leg={current} clockS={rider.workoutClockS} target={current === undefined ? null : legTargetLabel(current, target)} />
      {next !== undefined && (
        <p className="flex items-baseline gap-2 px-1 font-display text-[17px] uppercase tracking-[0.06em]">
          <span className={`${LABEL} shrink-0`}>Next</span>
          <span className="min-w-0 truncate font-semibold text-ink">{next.label}</span>
          <span className="shrink-0 tabular-nums text-dim">{legTargetLabel(next, target)}</span>
          <span className="ml-auto shrink-0 tabular-nums text-dim">{fmtClock(next.endS - next.startS)}</span>
        </p>
      )}
      <button
        type="button"
        aria-expanded={stepsOpen}
        onClick={onToggleSteps}
        className="flex min-h-11 touch-manipulation flex-col gap-1.5 rounded-[10px] px-1 py-1 text-left active:bg-ink/5"
      >
        <Profile
          bars={profile.bars}
          scale={profile.scale}
          playhead={profilePlayhead(legs, clockS)}
          label={`Workout profile: ${legs.length} steps over ${fmtClock(profile.totalS)}, now ${fmtClock(clockS)}`}
          className="h-9 w-full landscape:h-7"
        />
        <span className="flex w-full items-center justify-between font-display text-[14px] uppercase tracking-[0.06em] text-dim">
          <span className="tabular-nums">
            Step {rider.legIndex === null ? legs.length : rider.legIndex + 1} of {legs.length}
          </span>
          <span className="flex items-center gap-1 text-ink">
            {stepsOpen ? 'Hide steps' : 'All steps'}
            <Chevron up={stepsOpen} />
          </span>
        </span>
      </button>
    </section>
  );
}

function CurrentStep({ leg, clockS, target }: { leg: Leg | undefined; clockS: number | null; target: string | null }) {
  if (leg === undefined) {
    return (
      <div className="rounded-[14px] border border-on/40 bg-on/[0.06] px-4 py-3">
        <p className="font-display text-[26px] font-bold uppercase tracking-[0.04em] text-on">Workout complete</p>
      </div>
    );
  }
  const remainingS = legRemainingS(leg, clockS);
  return (
    <div className="relative overflow-hidden rounded-[14px] border border-line bg-panel px-4 pb-3.5 pt-2.5">
      <p className={LABEL}>Now</p>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-display text-[26px] font-bold uppercase leading-tight tracking-[0.04em] text-ink">
            {leg.label}
          </p>
          <p className="truncate font-display text-[17px] tabular-nums tracking-[0.04em] text-dim">{target}</p>
        </div>
        <p className="shrink-0 text-right font-display leading-none">
          <span className="block text-[44px] font-bold tabular-nums text-over">
            {remainingS === null ? '—' : fmtClock(remainingS)}
          </span>
          <span className="mt-1 block text-[13px] uppercase tracking-[0.08em] text-dim">left</span>
        </p>
      </div>
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1 bg-ink/10">
        <span
          className={`block h-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none ${KIND_TONE[leg.kind].bar}`}
          style={{ width: `${legFillFraction(leg, clockS) * 100}%` }}
        />
      </span>
    </div>
  );
}

/** Every step, over the readout and above the dock, with the current one in view. */
function StepSheet({ rider, legs, onClose }: { rider: Rider; legs: Leg[]; onClose: () => void }) {
  const currentRef = useRef<HTMLLIElement>(null);
  const target = { riders: 1, ftpW: rider.ftpW, biasPct: rider.biasPct };
  const clockS = rider.workoutClockS ?? workoutProfile(legs).totalS;

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Workout steps"
      className="absolute inset-x-0 bottom-0 top-2 z-10 flex flex-col rounded-t-[14px] border border-b-0 border-line bg-deep shadow-[0_-12px_32px_rgb(0_0_0/0.55)]"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line pl-4">
        <h2 className="truncate font-display text-[17px] font-semibold uppercase tracking-[0.06em] text-ink">
          {rider.workoutName ?? 'Workout'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 shrink-0 touch-manipulation px-4 font-display text-[15px] uppercase tracking-[0.06em] text-ink active:bg-ink/10"
        >
          Close
        </button>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {legs.map((leg) => {
          const isCurrent = leg.index === rider.legIndex;
          const isDone = !isCurrent && leg.endS <= clockS;
          const remainingS = isCurrent ? legRemainingS(leg, rider.workoutClockS) : null;
          return (
            <li
              key={leg.index}
              ref={isCurrent ? currentRef : undefined}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex min-h-11 items-center gap-3 px-2 font-display text-[17px] uppercase tracking-[0.04em] ${
                isCurrent ? 'my-1 rounded-[8px] border border-over/45 bg-over/[0.08]' : 'border-b border-line/50'
              }`}
            >
              <span aria-hidden="true" className={`h-5 w-1 shrink-0 rounded-[2px] ${KIND_TONE[leg.kind].swatch} ${isDone ? 'opacity-50' : ''}`} />
              <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-semibold text-ink' : isDone ? 'text-ink/60' : 'text-ink/85'}`}>
                {leg.label}
              </span>
              <span className="shrink-0 tabular-nums text-dim">{legTargetLabel(leg, target)}</span>
              <span className={`w-16 shrink-0 text-right tabular-nums ${isCurrent ? 'text-over' : 'text-dim'}`}>
                {remainingS !== null ? fmtClock(remainingS) : fmtClock(leg.endS - leg.startS)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const DOCK_BTN =
  'flex min-h-14 min-w-0 touch-manipulation select-none items-center justify-center gap-2 rounded-[12px] border font-display text-[19px] font-semibold uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 landscape:min-h-12';
const DOCK_NEUTRAL = 'border-line bg-ink/[0.06] text-ink active:bg-ink/15';

/** Thumb dock: ERG bias on top, pause / skip / end on the bottom row (one row in landscape). */
function ControlDock({ rider }: { rider: Rider }) {
  const navigate = useNavigate();
  const controlsOff = useAppStore((state) => state.wsStatus) !== 'open';
  const [confirmEnd, setConfirmEnd] = useState(false);
  const paused = rider.state === 'paused';

  useEffect(() => {
    if (!confirmEnd) return;
    const id = window.setTimeout(() => setConfirmEnd(false), CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [confirmEnd]);

  const end = () => {
    if (!confirmEnd) {
      setConfirmEnd(true);
      return;
    }
    sendWs({ type: 'stopSession' });
    navigate('/history');
  };

  return (
    <nav
      aria-label="Ride controls"
      className="-ml-[max(16px,env(safe-area-inset-left))] -mr-[max(16px,env(safe-area-inset-right))] flex shrink-0 flex-col gap-2 border-t border-line bg-deep/95 pb-[max(10px,env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] pt-2.5 landscape:flex-row landscape:gap-3"
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 landscape:flex-1">
        <button
          type="button"
          disabled={controlsOff || rider.biasPct <= -BIAS_LIMIT}
          onClick={() => sendWs({ type: 'setBias', riderId: rider.riderId, deltaPct: -1 })}
          aria-label={`Ease ${rider.name} 1 percent`}
          className={`${DOCK_BTN} ${DOCK_NEUTRAL}`}
        >
          −1%
        </button>
        <p className="min-w-16 text-center font-display uppercase leading-none tracking-[0.06em]" aria-live="polite">
          <span className="block text-[12px] text-dim">ERG bias</span>
          <span className={`mt-1 block text-[24px] font-bold tabular-nums ${rider.biasPct === 0 ? 'text-ink' : 'text-over'}`}>
            {rider.biasPct > 0 ? '+' : ''}
            {rider.biasPct}%
          </span>
        </p>
        <button
          type="button"
          disabled={controlsOff || rider.biasPct >= BIAS_LIMIT}
          onClick={() => sendWs({ type: 'setBias', riderId: rider.riderId, deltaPct: 1 })}
          aria-label={`Push ${rider.name} 1 percent`}
          className={`${DOCK_BTN} ${DOCK_NEUTRAL}`}
        >
          +1%
        </button>
      </div>
      <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 landscape:flex-[1.3]">
        <button
          type="button"
          disabled={controlsOff}
          onClick={() => sendWs({ type: paused ? 'resume' : 'pause', riderId: rider.riderId })}
          className={`${DOCK_BTN} ${paused ? 'border-on bg-on text-void active:bg-on/80' : DOCK_NEUTRAL}`}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          disabled={controlsOff}
          onClick={() => sendWs({ type: 'skipStep', riderId: rider.riderId })}
          className={`${DOCK_BTN} ${DOCK_NEUTRAL}`}
        >
          <SkipIcon />
          Skip
        </button>
        <button
          type="button"
          disabled={controlsOff}
          onClick={end}
          className={`${DOCK_BTN} ${
            confirmEnd ? 'border-danger bg-danger text-void active:bg-danger/80' : 'border-danger/40 bg-danger/10 text-danger active:bg-danger/20'
          }`}
        >
          {confirmEnd ? 'Confirm' : 'End'}
        </button>
      </div>
    </nav>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 shrink-0" fill="currentColor">
      <rect x="4" y="3" width="4" height="14" rx="1" />
      <rect x="12" y="3" width="4" height="14" rx="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 shrink-0" fill="currentColor">
      <path d="M5 3.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 5 3.5Z" />
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 shrink-0" fill="currentColor">
      <path d="M3 4.2v11.6a.8.8 0 0 0 1.25.66L12.5 10.66a.8.8 0 0 0 0-1.32L4.25 3.54A.8.8 0 0 0 3 4.2Z" />
      <rect x="14" y="3.5" width="3" height="13" rx="1" />
    </svg>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${up ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}
