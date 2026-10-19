interface CadenceDialProps {
  cadenceRpm: number | null;
  className?: string;
  compact?: boolean;
}

interface TorqueMeterProps {
  torqueNm: number | null;
  className?: string;
  compact?: boolean;
}

const ARC = 'M 20 112 A 80 80 0 0 1 180 112';
const SWEET_START = (80 / 130) * 100;
const SWEET_LENGTH = ((100 - 80) / 130) * 100;
// ERG riders mostly sit at 5-30 Nm; a 40 Nm full scale keeps cadence changes visible.
const TORQUE_SCALE_NM = 40;

export function CadenceDial({ cadenceRpm, className = '', compact = false }: CadenceDialProps) {
  const fraction = cadenceRpm === null ? 0 : Math.min(1, Math.max(0, cadenceRpm / 130));
  const angle = Math.PI * (1 + fraction);
  // Marker rides the arc itself so it never crosses the centered number.
  const markerX = 100 + Math.cos(angle) * 80;
  const markerY = 112 + Math.sin(angle) * 80;
  const zoneClass =
    cadenceRpm === null ? 'text-dim' : cadenceRpm < 80 ? 'text-under' : cadenceRpm > 100 ? 'text-over' : 'text-on';
  const labelSize = compact ? 'text-[9px]' : 'text-xs';

  return (
    <div className={`font-display ${className}`}>
      <div className={`mb-1 flex items-center justify-between gap-2 uppercase tracking-[0.06em] ${labelSize}`}>
        <span className="text-dim">Cadence</span>
        <span className="text-on">80–100 sweet</span>
      </div>
      <svg
        aria-label={cadenceRpm === null ? 'Cadence unavailable' : `Cadence ${Math.round(cadenceRpm)} rpm`}
        className="h-auto w-full overflow-visible"
        role="img"
        viewBox="0 0 200 136"
      >
        <path d={ARC} fill="none" pathLength="100" stroke="currentColor" strokeLinecap="round" strokeWidth="10" className="text-dim/25" />
        {cadenceRpm !== null && (
          <path
            d={ARC}
            fill="none"
            pathLength="100"
            stroke="currentColor"
            strokeDasharray={`${fraction * 100} 200`}
            strokeLinecap="round"
            strokeWidth="10"
            className={zoneClass}
          />
        )}
        <path
          d={ARC}
          fill="none"
          pathLength="100"
          stroke="currentColor"
          strokeDasharray={`${SWEET_LENGTH} ${100 - SWEET_LENGTH}`}
          strokeDashoffset={-SWEET_START}
          strokeWidth="16"
          className="text-on/25"
        />
        {cadenceRpm !== null && (
          <circle cx={markerX} cy={markerY} r="8" fill="currentColor" stroke="var(--color-void)" strokeWidth="3" className="text-ink" />
        )}
        <text x="100" y="88" textAnchor="middle" fill="currentColor" className={`text-[46px] font-bold tabular-nums ${zoneClass === 'text-dim' ? 'text-ink' : zoneClass}`}>
          {cadenceRpm === null ? '—' : Math.round(cadenceRpm)}
        </text>
        <text x="100" y="108" textAnchor="middle" fill="currentColor" className="text-[13px] uppercase tracking-[0.12em] text-dim">
          rpm
        </text>
        <text x="17" y="132" textAnchor="middle" fill="currentColor" className="text-[10px] tabular-nums text-dim">
          0
        </text>
        <text x="183" y="132" textAnchor="middle" fill="currentColor" className="text-[10px] tabular-nums text-dim">
          130
        </text>
      </svg>
    </div>
  );
}

export function TorqueMeter({ torqueNm, className = '', compact = false }: TorqueMeterProps) {
  const roundedTorque = torqueNm === null ? null : Math.round(torqueNm);
  const fillPct = torqueNm === null ? 0 : Math.min(100, Math.max(0, (torqueNm / TORQUE_SCALE_NM) * 100));

  return (
    <div
      aria-label="Torque per pedal stroke"
      aria-valuemax={torqueNm === null ? undefined : TORQUE_SCALE_NM}
      aria-valuemin={torqueNm === null ? undefined : 0}
      aria-valuenow={roundedTorque ?? undefined}
      className={`font-display ${className}`}
      role={torqueNm === null ? undefined : 'meter'}
    >
      <div className="uppercase tracking-[0.06em] text-dim">
        <div className={compact ? 'text-[clamp(10px,0.73vw,22px)]' : 'text-lg'}>Torque</div>
        <div className={compact ? 'text-[clamp(8px,0.57vw,17px)]' : 'text-sm'}>per pedal stroke</div>
      </div>
      <div className={`mt-1 font-bold leading-none tabular-nums text-ink ${compact ? 'text-[clamp(24px,1.88vw,58px)]' : 'text-5xl'}`}>
        {roundedTorque ?? '—'}
        <span className={`ml-1 font-semibold text-dim ${compact ? 'text-[0.45em]' : 'text-xl'}`}>Nm</span>
      </div>
      <div aria-hidden="true" className={`mt-2 overflow-hidden rounded-full bg-ink/10 ${compact ? 'h-[clamp(3px,0.26vw,8px)]' : 'h-3'}`}>
        <span
          className="block h-full rounded-full bg-over transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${fillPct}%` }}
        />
      </div>
    </div>
  );
}
