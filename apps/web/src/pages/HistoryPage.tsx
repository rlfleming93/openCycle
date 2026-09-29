import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RiderProfile } from '@opencycle/shared';
import { fitUrl, listProfiles, listRides, type RideListItem } from '../lib/api.js';

/**
 * Ride summary blob written by the server recorder on ride finalize. The API
 * serves it as JSON (`summary: unknown`), so it is guarded defensively here.
 */
interface RideSummary {
  durationS: number;
  distanceM: number;
  avgPowerW: number;
  weightedPowerW: number;
  avgHrBpm: number | null;
  trainingLoad: number | null;
}

function parseSummary(value: unknown): RideSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.durationS !== 'number' ||
    typeof raw.distanceM !== 'number' ||
    typeof raw.avgPowerW !== 'number' ||
    typeof raw.weightedPowerW !== 'number'
  ) {
    return null;
  }
  return {
    durationS: raw.durationS,
    distanceM: raw.distanceM,
    avgPowerW: raw.avgPowerW,
    weightedPowerW: raw.weightedPowerW,
    avgHrBpm: typeof raw.avgHrBpm === 'number' ? raw.avgHrBpm : null,
    trainingLoad: typeof raw.trainingLoad === 'number' ? raw.trainingLoad : null,
  };
}

function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function tabClass(active: boolean): string {
  return active
    ? 'rounded-full bg-on/15 px-4 py-1.5 text-sm font-medium text-on'
    : 'rounded-full px-4 py-1.5 text-sm text-dim hover:bg-ink/5 hover:text-ink';
}

export function HistoryPage() {
  const navigate = useNavigate();
  const [rides, setRides] = useState<RideListItem[]>([]);
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rideList, profileList] = await Promise.all([listRides(), listProfiles()]);
      setRides(rideList);
      setProfiles(profileList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ride history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of profiles) map.set(profile.id, profile.name);
    return map;
  }, [profiles]);

  const filtered = filter === 'all' ? rides : rides.filter((ride) => ride.riderId === filter);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">History</h1>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={tabClass(filter === 'all')} onClick={() => setFilter('all')}>
          All
        </button>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className={tabClass(filter === profile.id)}
            onClick={() => setFilter(profile.id)}
          >
            {profile.name}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="mt-8 text-dim">Loading rides…</p>
      ) : error !== null ? (
        <div className="mt-8 rounded-[14px] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          <p>{error}</p>
          <button type="button" onClick={() => void load()} className="mt-3 text-danger underline hover:text-danger/80">
            Retry
          </button>
        </div>
      ) : rides.length === 0 ? (
        <p className="mt-8 text-dim">No rides yet.</p>
      ) : filtered.length === 0 ? (
        <p className="mt-8 text-dim">No rides for this rider yet.</p>
      ) : (
        <table className="mt-6 w-full text-left">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-dim">
              <th className="pb-3 pr-4">Date</th>
              <th className="pb-3 pr-4">Rider</th>
              <th className="pb-3 pr-4">Workout</th>
              <th className="pb-3 pr-4">Duration</th>
              <th className="pb-3 pr-4">Distance</th>
              <th className="pb-3 pr-4">Weighted Power</th>
              <th className="pb-3 pr-4">Load</th>
              <th className="pb-3 text-right">FIT</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((ride) => {
              const summary = parseSummary(ride.summary);
              const riderName = nameById.get(ride.riderId) ?? 'Unknown rider';
              const fitName = `${riderName}-${new Date(ride.startedAt).toISOString().slice(0, 10)}.fit`;
              return (
                <tr
                  key={ride.id}
                  onClick={() => navigate(`/history/${ride.id}`)}
                  className="cursor-pointer border-t border-line text-sm hover:bg-ink/5"
                >
                  <td className="py-3 pr-4 text-ink/90">{formatDate(ride.startedAt)}</td>
                  <td className="py-3 pr-4 text-ink">{riderName}</td>
                  <td className="py-3 pr-4 text-dim">{ride.workoutName ?? 'Free ride'}</td>
                  <td className="py-3 pr-4 tabular-nums text-ink/90">
                    {summary === null ? '—' : formatDuration(summary.durationS)}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-ink/90">
                    {summary === null ? '—' : `${(summary.distanceM / 1000).toFixed(1)} km`}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-ink/90">
                    {summary === null ? '—' : `${Math.round(summary.weightedPowerW)} W`}
                  </td>
                  <td className="py-3 pr-4 tabular-nums text-ink/90">
                    {summary === null || summary.trainingLoad === null ? '—' : summary.trainingLoad.toFixed(1)}
                  </td>
                  <td className="py-3 text-right">
                    {ride.endedAt === null ? (
                      <span className="text-dim/70">—</span>
                    ) : (
                      <a
                        href={fitUrl(ride.id)}
                        download={fitName}
                        title="Download FIT"
                        aria-label={`Download FIT for ${riderName}`}
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex rounded-[8px] p-2 text-dim hover:bg-ink/10 hover:text-on"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
