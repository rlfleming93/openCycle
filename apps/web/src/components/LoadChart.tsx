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

import type { TrainingLoadResponse } from '../lib/api.js';

/** One charted day: date label plus the three Banister curve values. */
interface Point {
  date: string;
  fitness: number;
  fatigue: number;
  form: number;
}

// Explicit hex (SVG strokes cannot use Tailwind classes; dark theme).
const FITNESS_COLOR = '#5ee6a8'; // --color-on
const FATIGUE_COLOR = '#ff6b6b'; // --color-danger
const FORM_COLOR = '#7fb2ff'; // --color-under
const GRID_COLOR = '#111a2b'; // --color-line over void
const AXIS_COLOR = '#8b97ad'; // --color-dim
const TICK_COLOR = '#8b97ad'; // --color-dim

const SERIES_LABELS: Record<string, string> = {
  fitness: 'Fitness',
  fatigue: 'Fatigue',
  form: 'Form',
};

/** Charts stay responsive by capping the rendered series length. */
const MAX_POINTS = 2000;

function formatShortDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Bucket-average adjacent days so long histories (years of Garmin imports)
 * stay under MAX_POINTS; the bucket's first date labels the point.
 */
function downsample(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const bucketSize = Math.ceil(points.length / MAX_POINTS);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket = points.slice(i, i + bucketSize);
    out.push({
      date: bucket[0]!.date,
      fitness: bucket.reduce((sum, p) => sum + p.fitness, 0) / bucket.length,
      fatigue: bucket.reduce((sum, p) => sum + p.fatigue, 0) / bucket.length,
      form: bucket.reduce((sum, p) => sum + p.form, 0) / bucket.length,
    });
  }
  return out;
}

function LoadTooltip({ active, payload, label }: Partial<TooltipContentProps<number, string>>) {
  if (!active || payload === undefined || payload.length === 0) return null;
  return (
    <div className="rounded-[8px] border border-line bg-void/95 px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-dim">{String(label ?? '')}</p>
      {payload.map((entry) => {
        if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) return null;
        const name = SERIES_LABELS[String(entry.name ?? '')] ?? String(entry.name ?? '');
        return (
          <p key={name} className="flex items-center gap-2 text-ink">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color ?? FITNESS_COLOR }}
            />
            <span className="text-dim">{name}</span>
            <span className="ml-auto tabular-nums">{entry.value.toFixed(1)}</span>
          </p>
        );
      })}
    </div>
  );
}

/** Fitness / Fatigue / Form curves over the training-load history. */
export default function LoadChart({ load, height = 320 }: { load: TrainingLoadResponse; height?: number }) {
  const points = useMemo<Point[]>(() => {
    const mapped: Point[] = [];
    for (let i = 0; i < load.days.length; i++) {
      const day = load.days[i]!;
      mapped.push({
        date: day.date,
        fitness: load.fitness[i] ?? 0,
        fatigue: load.fatigue[i] ?? 0,
        form: load.form[i] ?? 0,
      });
    }
    return downsample(mapped);
  }, [load]);

  if (points.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-[14px] border border-line bg-panel text-sm text-dim">
        No training data yet.
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            stroke={AXIS_COLOR}
            tick={{ fill: TICK_COLOR, fontSize: 12 }}
            tickLine={false}
            tickFormatter={formatShortDate}
            minTickGap={48}
          />
          <YAxis
            width={48}
            stroke={AXIS_COLOR}
            tick={{ fill: TICK_COLOR, fontSize: 12 }}
            tickLine={false}
            tickFormatter={(value) => String(value)}
          />
          <Tooltip content={<LoadTooltip />} cursor={{ stroke: AXIS_COLOR, strokeDasharray: '3 3' }} />
          <Legend
            verticalAlign="top"
            height={28}
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value) => SERIES_LABELS[String(value)] ?? String(value)}
          />
          <Line
            type="monotone"
            dataKey="fitness"
            stroke={FITNESS_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="fatigue"
            stroke={FATIGUE_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="form"
            stroke={FORM_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
