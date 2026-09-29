import type { SessionSnapshot, TelemetrySample } from '@opencycle/shared';

import { getEffortCue, getWorkoutCommand, type EffortCueState } from '../../game/feedback.js';
import {
  LEG_ON_TARGET_DISPLAY_S,
  fmtClock,
  legOnTargetPct,
  trailingAvgPower,
} from '../../game/hud.js';
import { identityColor } from '../../lib/identity.js';
import { targetRatioColor, zoneColor } from '../../lib/zones.js';
import { useAppStore } from '../../store.js';

type Rider = SessionSnapshot['riders'][number];

const NO_SAMPLES: TelemetrySample[] = [];

/** Effort-cue states carry a glyph so color never stands alone. */
const STATE_GLYPH: Record<EffortCueState, string> = {
  unavailable: '…',
  stopped: '●',
  paused: '⏸',
  guard: '⟳',
  under: '▲',
  locked: '✓',
  over: '▼',
  free: '~',
};

const STATE_CLASS: Record<'neutral' | 'cool' | 'emerald' | 'amber', string> = {
  neutral: 'border-line text-dim',
  cool: 'border-under/55 text-under',
  emerald: 'border-on/55 text-on',
  amber: 'border-over/55 text-over',
};

/**
 * Ride card over the game canvas: who, how hard, and what to do next. Sizes
 * are clamp()'d against vw so a 1080p TV at 3 m and a 4K wall read the same.
 */
export default function RiderCard({ rider, riderIndex }: { rider: Rider; riderIndex: number }) {
  const latest = useAppStore((state) => state.latest[rider.riderId]);
  const telemetry = useAppStore((state) => state.telemetry[rider.riderId]) ?? NO_SAMPLES;
  const deviceStatus = useAppStore((state) => state.deviceStatus);

  const avgPower = trailingAvgPower(telemetry);
  const paused = rider.state === 'paused';
  const hasTelemetry = telemetry.length > 0 && latest !== undefined;
  // With a numeric target the numeral reads ratio-to-target; free rides read
  // against FTP instead (same law as the plain dashboard).
  const powerColor =
    rider.targetW !== null && rider.targetW > 0
      ? targetRatioColor(avgPower / rider.targetW)
      : zoneColor(rider.ftpW > 0 ? (avgPower / rider.ftpW) * 100 : 0);
  const trainerStatus = deviceStatus[rider.trainerId];
  const hrmStatus = rider.hrmId !== undefined ? deviceStatus[rider.hrmId] : undefined;
  const hrmOffline = hrmStatus === 'disconnected' || hrmStatus === 'error';

  const cue = getEffortCue({
    rider,
    trainerStatus,
    avgPowerW: hasTelemetry ? avgPower : null,
    cadenceRpm: hasTelemetry ? latest.cadenceRpm : null,
  });
  const command = getWorkoutCommand(rider);
  const [commandKey, ...commandRest] = command.primary.split(' ');
  // Join with the separator only when both parts exist: a ramp or launch leg
  // has a clock but no next target.
  const commandMeta = [
    command.remainingS === null ? null : fmtClock(command.remainingS),
    command.secondary,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const currentLeg = rider.legIndex === null ? undefined : rider.legs?.[rider.legIndex];
  const showOnTarget =
    currentLeg?.objective === true && rider.legTargetedS >= LEG_ON_TARGET_DISPLAY_S;
  const onTargetPct = legOnTargetPct(rider.legTargetedS, rider.legOnTargetS);

  return (
    <section
      aria-label={`${rider.name} ride state`}
      className="w-full rounded-[14px] border border-line bg-panel px-[clamp(14px,1.35vw,52px)] pb-[clamp(12px,1.04vw,40px)] pt-[clamp(12px,1.15vw,44px)] backdrop-blur-[10px]"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-[clamp(8px,0.62vw,24px)] text-[clamp(20px,1.5625vw,44px)] font-semibold text-ink">
          <span
            aria-hidden="true"
            className="h-[clamp(4px,0.31vw,10px)] w-[clamp(18px,1.35vw,48px)] shrink-0 rounded-[3px]"
            style={{ backgroundColor: identityColor(riderIndex) }}
          />
          <span className="truncate">{rider.name}</span>
        </h2>
        <span
          className={`shrink-0 rounded-[8px] border-2 px-[clamp(6px,0.73vw,22px)] py-[clamp(1px,0.21vw,8px)] font-display text-[clamp(14px,1.25vw,38px)] font-bold uppercase tracking-[0.06em] ${STATE_CLASS[cue.tone]}`}
        >
          <span aria-hidden="true">{STATE_GLYPH[cue.state]}</span> {cue.instruction}
        </span>
      </div>

      <div className="mt-[clamp(4px,0.31vw,12px)] flex items-end gap-[clamp(12px,1.15vw,44px)]">
        <div
          className={`flex items-baseline font-display text-[clamp(96px,6.9vw,264px)] font-bold leading-[0.9] tabular-nums ${powerColor} ${paused ? 'opacity-40' : ''}`}
        >
          {Math.round(avgPower)}
          <span className="ml-[clamp(4px,0.31vw,14px)] text-[clamp(22px,2.08vw,80px)] text-dim">W</span>
        </div>
        <div className="min-w-0 pb-[clamp(6px,0.62vw,24px)] font-display uppercase tracking-[0.06em]">
          <div className="text-[clamp(12px,0.94vw,30px)] text-dim">{commandKey}</div>
          <div className="truncate text-[clamp(22px,2.08vw,80px)] font-bold text-ink">
            {commandRest.join(' ')}
          </div>
          <div className="text-[clamp(15px,1.354vw,44px)] text-over">{commandMeta}</div>
        </div>
      </div>

      <div className="mt-[clamp(6px,0.52vw,20px)] flex flex-wrap items-baseline gap-x-[clamp(14px,1.46vw,56px)] gap-y-1 font-display text-[clamp(15px,1.25vw,38px)] uppercase tracking-[0.06em] text-dim">
        <span>
          <span className="font-semibold tabular-nums text-ink">{Math.round(latest?.cadenceRpm ?? 0)}</span> rpm
        </span>
        <span>
          <span className="font-semibold tabular-nums text-ink">
            {latest?.hrBpm !== undefined ? latest.hrBpm : '—'}
          </span>{' '}
          bpm
        </span>
        {hrmOffline && <span className="text-over">HR OFFLINE</span>}
        {rider.biasPct !== 0 && (
          <span className="text-over">
            BIAS {rider.biasPct > 0 ? '+' : ''}
            {rider.biasPct}%
          </span>
        )}
        {showOnTarget && (
          <span className="text-on">
            ON TARGET <span className="font-semibold tabular-nums">{onTargetPct}%</span>
          </span>
        )}
      </div>
    </section>
  );
}
