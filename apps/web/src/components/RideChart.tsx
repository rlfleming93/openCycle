import { useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';

/**
 * One ride sample as charted. Structurally compatible with the shared
 * TelemetrySample shape (only ts/power/cadence/HR are charted), so Phase 5
 * can pass ride-sample rows in directly.
 */
export interface RideChartSample {
  ts: number;
  powerW: number;
  cadenceRpm?: number | null;
  hrBpm?: number | null;
}

interface Point {
  min: number;
  power: number;
  hr: number | null;
  cadence: number | null;
}

// Explicit hex (SVG strokes cannot use Tailwind classes; dark theme).
const POWER_COLOR = '#5ee6a8'; // --color-on
const HR_COLOR = '#ff6b6b'; // --color-danger
const CADENCE_COLOR = '#7fb2ff'; // --color-under
const GRID_COLOR = '#111a2b'; // --color-line over void
const AXIS_COLOR = '#8b97ad'; // --color-dim
const TICK_COLOR = '#8b97ad'; // --color-dim

/** Display labels for series; recharts derives entry names from dataKeys. */
const SERIES_LABELS: Record<string, string> = {
  power: 'Power (W)',
  hr: 'HR (bpm)',
  cadence: 'Cadence (rpm)',
};

function formatMin(min: number): string {
  if (!Number.isFinite(min)) return '0:00';
  const total = Math.max(0, Math.round(min * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function RideTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || payload === undefined || payload.length === 0) return null;
  return (
    <div className="rounded-[8px] border border-line bg-void/95 px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-dim">{formatMin(Number(label ?? 0))}</p>
      {payload.map((entry) => {
        if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) return null;
        const name = SERIES_LABELS[String(entry.name ?? '')] ?? String(entry.name ?? '');
        return (
          <p key={name} className="flex items-center gap-2 text-ink">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color ?? POWER_COLOR }}
            />
            <span className="text-dim">{name}</span>
            <span className="ml-auto tabular-nums">{Math.round(entry.value)}</span>
          </p>
        );
      })}
    </div>
  );
}

/** Charts stay responsive by capping the rendered series length. */
const MAX_POINTS = 2000;

/**
 * Bucket-average adjacent points so long rides (a 4 h ride = 14 400 rows,
 * ×3 SVG series) stay under MAX_POINTS. HR/cadence buckets average only the
 * non-null members and stay null when a bucket has none (gaps stay honest).
 */
function downsample(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const bucketSize = Math.ceil(points.length / MAX_POINTS);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket = points.slice(i, i + bucketSize);
    const hrVals = bucket.filter((p): p is Point & { hr: number } => p.hr !== null);
    const cadVals = bucket.filter((p): p is Point & { cadence: number } => p.cadence !== null);
    out.push({
      min: bucket[0]!.min,
      power: bucket.reduce((sum, p) => sum + p.power, 0) / bucket.length,
      hr: hrVals.length > 0 ? hrVals.reduce((sum, p) => sum + p.hr, 0) / hrVals.length : null,
      cadence: cadVals.length > 0 ? cadVals.reduce((sum, p) => sum + p.cadence, 0) / cadVals.length : null,
    });
  }
  return out;
}

/**
 * Power / HR / cadence over elapsed time. Fully data-driven: pass ride
 * samples and it renders.
 */
export function RideChart({ samples, height = 320 }: { samples: RideChartSample[]; height?: number }) {
  const points = useMemo<Point[]>(() => {
    const t0 = samples[0]?.ts ?? 0;
    const mapped = samples.map((sample) => ({
      min: Math.max(0, (sample.ts - t0) / 60_000),
      power: sample.powerW,
      hr: sample.hrBpm ?? null,
      cadence: sample.cadenceRpm ?? null,
    }));
    return downsample(mapped);
  }, [samples]);

  if (points.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-[14px] border border-line bg-panel text-sm text-dim">
        No samples to chart.
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
          <XAxis
            dataKey="min"
            type="number"
            tickFormatter={formatMin}
            stroke={AXIS_COLOR}
            tick={{ fill: TICK_COLOR, fontSize: 12 }}
            tickLine={false}
          />
          <YAxis
            yAxisId="power"
            width={48}
            stroke={AXIS_COLOR}
            tick={{ fill: TICK_COLOR, fontSize: 12 }}
            tickLine={false}
            tickFormatter={(value) => String(value)}
          />
          <YAxis
            yAxisId="body"
            orientation="right"
            width={48}
            stroke={AXIS_COLOR}
            tick={{ fill: TICK_COLOR, fontSize: 12 }}
            tickLine={false}
            tickFormatter={(value) => String(value)}
          />
          <Tooltip content={<RideTooltip />} cursor={{ stroke: AXIS_COLOR, strokeDasharray: '3 3' }} />
          <Legend
            verticalAlign="top"
            height={28}
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value) => SERIES_LABELS[String(value)] ?? String(value)}
          />
          <Line
            yAxisId="power"
            type="monotone"
            dataKey="power"
            stroke={POWER_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="body"
            type="monotone"
            dataKey="hr"
            stroke={HR_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="body"
            type="monotone"
            dataKey="cadence"
            stroke={CADENCE_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
