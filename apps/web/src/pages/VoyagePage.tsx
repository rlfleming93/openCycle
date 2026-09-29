import { useCallback, useEffect, useRef, useState } from 'react';

import { hashSeed, mulberry32, nameFromSeed, voyageSeed, type RiderProfile } from '@opencycle/shared';

import {
  getVoyage,
  listDiscoveries,
  listPlanAssignments,
  listProfiles,
  type Discovery,
  type PlanAssignment,
  type Voyage,
} from '../lib/api.js';

/**
 * Star-map layout. Cells are sized in CSS pixels and the SVG viewBox is the
 * measured container width, so one SVG unit is one pixel: labels keep their
 * designed size at every viewport instead of scaling with the drawing.
 */
const CELL_W = 190;
const ROW_H = 136;
const PAD_X = 24;
const PAD_Y = 78;
const NAME_CHARS = 20;
const DETAIL_CHARS = 24;

/** Seeded palette families (same four as the world): primary + secondary hue. */
const PALETTES = [
  ['#5b8cff', '#c07dff'],
  ['#4fd1c5', '#ffb35c'],
  ['#a78bfa', '#ff8fa3'],
  ['#9fb4c7', '#f5c542'],
] as const;

function paletteFor(seed: string): readonly [string, string] {
  return PALETTES[Math.floor(mulberry32(hashSeed(`${seed}:palette`))() * PALETTES.length)] ?? PALETTES[0];
}

function tabClass(active: boolean): string {
  return active
    ? 'rounded-full bg-on/15 px-4 py-1.5 font-display text-sm uppercase tracking-[0.06em] text-on'
    : 'rounded-full px-4 py-1.5 font-display text-sm uppercase tracking-[0.06em] text-dim hover:bg-ink/5 hover:text-ink';
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface MapNode {
  key: string;
  seed: string;
  name: string;
  /** First label line: the arrival date, 'Next destination', or '{Ddd} · {workout}'. */
  dateLine: string;
  /** Second label line: the workout name (arrived systems only). */
  workoutLine: string | null;
  kind: 'arrived' | 'next' | 'planned';
  surveysTotal: number | null;
  surveysClean: number | null;
}

/** SVG text does not wrap: keep labels inside their cell. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Voyage: the systems a rider has arrived in, the next destination, the
 * planned legs ahead, and the co-op log. Systems are laid out along a winding
 * path in voyage order; node positions and palettes are seeded by each
 * system's seed, so a map never reshuffles between visits.
 */
export default function VoyagePage() {
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [riderId, setRiderId] = useState<string | null>(null);
  const [voyage, setVoyage] = useState<Voyage | null>(null);
  const [assignments, setAssignments] = useState<PlanAssignment[]>([]);
  const [discoveries, setDiscoveries] = useState<Discovery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** Measured star-map width in CSS px; the viewBox matches it so 1 unit = 1 px. */
  const [mapWidth, setMapWidth] = useState(1080);
  const mapRef = useRef<SVGSVGElement>(null);

  const loadVoyage = useCallback(async (id: string, cancelled: { current: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const [nextVoyage, planAssignments] = await Promise.all([getVoyage(id), listPlanAssignments(id)]);
      if (cancelled.current) return;
      setVoyage(nextVoyage);
      setAssignments(planAssignments);
    } catch (err) {
      if (!cancelled.current) setError(err instanceof Error ? err.message : 'Failed to load this voyage.');
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void listProfiles()
      .then((list) => {
        setProfiles(list);
        setRiderId((prev) => (prev !== null && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load profiles.'));
    void listDiscoveries(50)
      .then(setDiscoveries)
      .catch(() => setDiscoveries([]));
  }, []);

  useEffect(() => {
    if (riderId === null) return;
    const cancelled = { current: false };
    void loadVoyage(riderId, cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [riderId, loadVoyage, attempt]);

  const systems = voyage?.systems ?? [];
  const surveysTotal = systems.reduce((sum, system) => sum + (system.surveysTotal ?? 0), 0);
  const surveysClean = systems.reduce((sum, system) => sum + (system.surveysClean ?? 0), 0);

  // Up to 3 upcoming calendar legs for the rider, today onward.
  const today = todayString();
  const upcoming = assignments
    .flatMap((assignment) => assignment.calendar)
    .filter((entry) => entry.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3);

  const nodes: MapNode[] = [
    ...systems.map((system) => ({
      key: system.id,
      seed: system.seed,
      name: system.name,
      dateLine: new Date(system.arrivedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }),
      workoutLine: system.workoutName,
      kind: 'arrived' as const,
      surveysTotal: system.surveysTotal,
      surveysClean: system.surveysClean,
    })),
    ...(voyage === null
      ? []
      : [
          {
            key: 'next',
            seed: voyage.next.seed,
            name: voyage.next.name,
            dateLine: 'Next destination',
            workoutLine: null,
            kind: 'next' as const,
            surveysTotal: null,
            surveysClean: null,
          },
        ]),
    ...(voyage === null
      ? []
      : upcoming.map((entry, index) => {
          const plannedIndex = voyage.next.voyageIndex + index + 1;
          return {
            key: `planned-${entry.date}`,
            seed: voyageSeed(riderId ?? '', plannedIndex),
            name: nameFromSeed(voyageSeed(riderId ?? '', plannedIndex)),
            dateLine: `${new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' })} · ${entry.workoutName}`,
            workoutLine: null,
            kind: 'planned' as const,
            surveysTotal: null,
            surveysClean: null,
          };
        })),
  ];

  const perRow = Math.max(1, Math.floor((mapWidth - PAD_X * 2) / CELL_W));
  const rows = Math.max(1, Math.ceil(nodes.length / perRow));
  const mapHeight = PAD_Y * 2 + (rows - 1) * ROW_H;

  const positionOf = (index: number): { x: number; y: number } => {
    const row = Math.floor(index / perRow);
    const rawCol = index % perRow;
    const col = row % 2 === 0 ? rawCol : perRow - 1 - rawCol;
    const jitter = mulberry32(hashSeed(`${nodes[index]?.seed ?? index}:pos`))() - 0.5;
    return {
      x: PAD_X + col * CELL_W + CELL_W / 2,
      y: PAD_Y + row * ROW_H + jitter * 10,
    };
  };

  // The SVG mounts only once there are nodes, so re-measure when that count
  // changes; the observer covers later width changes.
  useEffect(() => {
    const el = mapRef.current;
    if (el === null) return;
    const measure = () => {
      const width = Math.round(el.getBoundingClientRect().width);
      if (width > 0) setMapWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [nodes.length]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="font-display text-4xl font-bold uppercase tracking-[0.06em] text-ink">Voyage</h1>

      {profiles.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={tabClass(riderId === profile.id)}
              onClick={() => setRiderId(profile.id)}
            >
              {profile.name}
            </button>
          ))}
        </div>
      )}

      {profiles.length === 0 ? (
        <p className="mt-6 rounded-[14px] border border-dashed border-line bg-panel p-6 text-center text-dim">
          Create a profile to start a voyage.
        </p>
      ) : error !== null ? (
        <div className="mt-6 rounded-[14px] border border-danger/40 bg-danger/10 p-4 text-danger">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-3 underline hover:text-ink"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-baseline gap-6">
            <span className="font-display text-2xl uppercase tracking-[0.06em] text-ink">
              {systems.length}{' '}
              <span className="text-dim">{systems.length === 1 ? 'system' : 'systems'}</span>
            </span>
            <span className="font-display text-2xl uppercase tracking-[0.06em] text-ink">
              <span className="text-on">{surveysClean}</span>
              <span className="text-dim">/</span>
              {surveysTotal} <span className="text-dim">surveys</span>
            </span>
          </div>

          {loading && voyage === null ? (
            <p className="mt-6 text-dim">Loading voyage…</p>
          ) : systems.length === 0 ? (
            <p className="mt-6 rounded-[14px] border border-dashed border-line bg-panel p-6 text-center text-dim">
              No systems yet. Finish a workout with Space game on to chart your first one.
            </p>
          ) : null}

          {nodes.length > 0 && (
            <svg
              ref={mapRef}
              width={mapWidth}
              height={mapHeight}
              viewBox={`0 0 ${mapWidth} ${mapHeight}`}
              className="mt-6 max-w-full rounded-[14px] border border-line bg-deep"
              role="img"
              aria-label="Star map of arrived and planned systems"
            >
              {nodes.slice(1).map((node, index) => {
                const from = positionOf(index);
                const to = positionOf(index + 1);
                return (
                  <line
                    key={`link-${node.key}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="var(--color-line)"
                    strokeWidth={1.5}
                    strokeDasharray={node.kind === 'arrived' ? undefined : '5 6'}
                  />
                );
              })}
              {nodes.map((node, index) => {
                const { x, y } = positionOf(index);
                const palette = paletteFor(node.seed);
                const dots = node.surveysTotal !== null && node.surveysTotal <= 10 ? node.surveysTotal : null;
                return (
                  <g key={node.key} transform={`translate(${x} ${y})`}>
                    <circle
                      r={17}
                      fill="none"
                      stroke={palette[0]}
                      strokeWidth={node.kind === 'next' ? 2.5 : 1.5}
                      strokeDasharray={node.kind === 'planned' ? '4 4' : undefined}
                      className={node.kind === 'next' ? 'animate-pulse' : undefined}
                      opacity={node.kind === 'planned' ? 0.6 : 1}
                    />
                    <circle r={7} fill={palette[0]} opacity={node.kind === 'planned' ? 0.5 : 1} />
                    <circle r={3} fill={palette[1]} />
                    <text
                      y={-30}
                      textAnchor="middle"
                      className="fill-ink font-display font-semibold uppercase"
                      fontSize={19}
                      letterSpacing="0.06em"
                    >
                      {truncate(node.name, NAME_CHARS)}
                    </text>
                    <text y={34} textAnchor="middle" className="fill-dim" fontSize={13}>
                      {truncate(node.dateLine, DETAIL_CHARS)}
                    </text>
                    {node.workoutLine !== null && (
                      <text y={51} textAnchor="middle" className="fill-dim" fontSize={13}>
                        {truncate(node.workoutLine, DETAIL_CHARS)}
                      </text>
                    )}
                    {dots !== null && node.kind === 'arrived' && (
                      <g transform="translate(0 68)">
                        {Array.from({ length: dots }, (_, dotIndex) => {
                          const cleaned = dotIndex < (node.surveysClean ?? 0);
                          return (
                            <circle
                              key={dotIndex}
                              cx={(dotIndex - (dots - 1) / 2) * 9}
                              cy={0}
                              r={3}
                              fill={cleaned ? 'var(--color-on)' : 'none'}
                              stroke={cleaned ? 'var(--color-on)' : 'var(--color-line)'}
                              strokeWidth={1}
                            />
                          );
                        })}
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          )}

          <section className="mt-10">
            <h2 className="font-display text-2xl font-semibold uppercase tracking-[0.06em] text-ink">
              Co-op log
            </h2>
            {discoveries.length === 0 ? (
              <p className="mt-3 rounded-[14px] border border-dashed border-line bg-panel p-6 text-center text-dim">
                No co-op moments logged yet. Ride with a second rider to earn beacons and rescues.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-line rounded-[14px] border border-line bg-panel">
                {discoveries.map((discovery) => (
                  <li key={discovery.id} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3">
                    <span className="font-display text-lg uppercase tracking-[0.06em] text-ink">
                      {discovery.name}{' '}
                      <span className="text-dim">
                        {discovery.kind === 'beacon' ? 'Beacon' : 'Rescue answered'}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums text-dim">
                      {discovery.kind === 'beacon' && discovery.streakS !== null && `${discovery.streakS} s · `}
                      {new Date(discovery.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
