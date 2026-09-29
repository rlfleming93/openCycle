import type { SessionSnapshot, TelemetrySample } from '@opencycle/shared';

import { getEffortCue, getWorkoutCommand } from '../game/feedback.js';
import { fmtClock, trailingAvgPower } from '../game/hud.js';
import { identityColor } from '../lib/identity.js';
import { targetRatioColor, zoneColor } from '../lib/zones.js';
import { useAppStore } from '../store.js';

import WorkoutProfile from './WorkoutProfile.js';

type Rider = SessionSnapshot['riders'][number];

const NO_SAMPLES: TelemetrySample[] = [];

interface ChipProps {
  paused: boolean;
  stopped: boolean;
  trainerOffline: boolean;
  controlLost: boolean;
  hrmOffline: boolean;
}

/** Device/state chips: driver status mirrors come over WS. */
function StatusChips({ paused, stopped, trainerOffline, controlLost, hrmOffline }: ChipProps) {
  const chip = 'rounded-[8px] border px-3 py-1 font-display text-xl uppercase tracking-[0.06em]';
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {paused && <span className={`${chip} border-over/40 bg-over/10 text-over`}>PAUSED</span>}
      {stopped && <span className={`${chip} border-danger/40 bg-danger/10 text-danger`}>STOPPED</span>}
      {trainerOffline && <span className={`${chip} border-over/40 bg-over/10 text-over`}>trainer offline</span>}
      {controlLost && <span className={`${chip} border-danger/40 bg-danger/10 text-danger`}>control lost</span>}
      {hrmOffline && <span className={`${chip} border-over/40 bg-over/10 text-over`}>HR offline</span>}
    </div>
  );
}

function Stat({ label, value, unit, className }: { label: string; value: string; unit: string; className?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-display text-lg uppercase tracking-[0.06em] text-dim">{label}</span>
      <span className={`font-display text-4xl font-bold leading-none tabular-nums ${className ?? 'text-ink'}`}>
        {value}
        <span className="ml-2 text-xl font-semibold text-dim">{unit}</span>
      </span>
    </div>
  );
}

/**
 * Plain per-rider dashboard for a ride with the space game off. Controls live
 * in the ride controls tray; this column is read-only telemetry.
 */
export default function RiderColumn({ rider, riderIndex = 0 }: { rider: Rider; riderIndex?: number }) {
  const latest = useAppStore((state) => state.latest[rider.riderId]);
  const telemetry = useAppStore((state) => state.telemetry[rider.riderId]) ?? NO_SAMPLES;
  const deviceStatus = useAppStore((state) => state.deviceStatus);

  const avgPower = trailingAvgPower(telemetry);
  // LAW (round-2 blind review): with a numeric target the power numeral is
  // colored by ratio-to-target — on 0.90-1.10, over >1.10, dim <0.90.
  // %FTP zone bands apply ONLY when there is no target (free ride).
  const powerColor =
    rider.targetW !== null && rider.targetW > 0
      ? targetRatioColor(avgPower / rider.targetW)
      : zoneColor(rider.ftpW > 0 ? (avgPower / rider.ftpW) * 100 : 0);
  const paused = rider.state === 'paused';
  const speedKmh = latest?.speedKmh ?? 0;
  const distanceKm = (latest?.distanceM ?? rider.distanceM) / 1000;

  const trainerStatus = deviceStatus[rider.trainerId];
  const hrmStatus = rider.hrmId !== undefined ? deviceStatus[rider.hrmId] : undefined;

  const hasTelemetry = telemetry.length > 0 && latest !== undefined;
  const effortCue = getEffortCue({
    rider,
    trainerStatus,
    avgPowerW: hasTelemetry ? avgPower : null,
    cadenceRpm: hasTelemetry ? latest.cadenceRpm : null,
  });
  const workoutCommand = getWorkoutCommand(rider);
  const cueClass = {
    neutral: 'border-line bg-void/80 text-dim',
    cool: 'border-under/50 bg-under/10 text-under',
    emerald: 'border-on/50 bg-on/10 text-on',
    amber: 'border-over/50 bg-over/10 text-over',
  }[effortCue.tone];

  return (
    <section className="flex min-h-0 flex-col gap-4 p-6 pb-[clamp(64px,6.4vw,210px)]">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-2 text-4xl font-semibold text-ink">
          <span
            aria-hidden="true"
            className="h-[6px] w-7 shrink-0 rounded-[3px]"
            style={{ backgroundColor: identityColor(riderIndex) }}
          />
          <span className="truncate">{rider.name}</span>
        </h2>
        <StatusChips
          paused={paused}
          stopped={rider.state === 'stopped'}
          trainerOffline={trainerStatus === 'disconnected' || trainerStatus === 'error'}
          controlLost={trainerStatus === 'controlLost'}
          hrmOffline={hrmStatus === 'disconnected' || hrmStatus === 'error'}
        />
      </header>

      <div className={`w-fit rounded-[8px] border px-4 py-1.5 font-display text-xl font-bold uppercase tracking-[0.06em] ${cueClass}`}>
        {effortCue.instruction}
      </div>

      {/* Paused riders keep the last known value on screen, dimmed. */}
      <div className={`flex items-baseline gap-3 ${paused ? 'opacity-40' : ''}`}>
        <span className={`font-display text-8xl font-bold leading-none tabular-nums ${powerColor}`}>
          {Math.round(avgPower)}
        </span>
        <span className="font-display text-3xl font-semibold text-dim">W</span>
        {paused && <span className="text-2xl font-semibold text-dim">— paused</span>}
      </div>

      <div className="flex items-center gap-3">
        <span className="font-display text-lg uppercase tracking-[0.06em] text-dim">Target</span>
        <span className="font-display text-5xl font-bold leading-none tabular-nums text-ink">
          {rider.targetW !== null ? Math.round(rider.targetW) : '—'}
        </span>
        <span className="font-display text-2xl text-dim">W</span>
        {rider.biasPct !== 0 && (
          <span className="rounded-[8px] border border-over/40 bg-over/10 px-2 py-0.5 font-display text-xl font-bold tabular-nums text-over">
            {rider.biasPct > 0 ? '+' : ''}
            {rider.biasPct}% bias
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-display uppercase tracking-[0.06em]">
        <span className="text-3xl font-bold text-ink">{workoutCommand.primary}</span>
        <span className="text-2xl text-over">
          {[workoutCommand.remainingS === null ? null : fmtClock(workoutCommand.remainingS), workoutCommand.secondary]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </span>
      </div>

      {/* flex-1 + content-center: the stats block absorbs vertical slack so a
          4K wall has no dead void between the numbers and the controls. */}
      <div className="grid flex-1 content-center grid-cols-3 gap-4">
        <Stat label="Cadence" value={String(Math.round(latest?.cadenceRpm ?? 0))} unit="rpm" />
        <Stat label="HR" value={latest?.hrBpm !== undefined ? String(latest.hrBpm) : '—'} unit="bpm" />
        <Stat
          label="Step ends in"
          value={rider.stepRemainingS !== null ? fmtClock(rider.stepRemainingS) : '—'}
          unit=""
        />
      </div>

      <div className="flex items-baseline gap-3 text-2xl">
        <span className="font-bold tabular-nums text-ink">{speedKmh.toFixed(1)}</span>
        <span className="text-dim">km/h</span>
        <span className="text-dim/60">·</span>
        <span className="font-bold tabular-nums text-ink">{distanceKm.toFixed(2)}</span>
        <span className="text-dim">km</span>
      </div>

      <WorkoutProfile rider={rider} />

      {rider.ergGuardActive && (
        <div className="rounded-[8px] border border-over/40 bg-over/10 px-4 py-2 font-display text-2xl font-bold uppercase tracking-[0.06em] text-over">
          easing off — spin up to resume
        </div>
      )}
    </section>
  );
}
