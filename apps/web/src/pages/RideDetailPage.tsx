import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RiderProfile } from '@opencycle/shared';
import {
  fitUrl,
  ftpEstimates,
  listProfiles,
  listRideSamples,
  listRides,
  rideUploadStatus,
  updateProfile,
  uploadRide,
  type FtpEstimates,
  type RideListItem,
  type RideUploadStatus,
} from '../lib/api.js';
import { RideChart, type RideChartSample } from '../components/RideChart.js';

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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-line bg-panel p-4">
      <p className="text-xs uppercase tracking-wider text-dim">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

const UPLOAD_PILL_CLASS: Record<RideUploadStatus, string> = {
  pending: 'border-over/40 bg-over/10 text-over',
  uploading: 'border-over/40 bg-over/10 text-over',
  uploaded: 'border-on/40 bg-on/10 text-on',
  failed: 'border-danger/40 bg-danger/10 text-danger',
};

const UPLOAD_PILL_LABEL: Record<RideUploadStatus, string> = {
  pending: 'Queued',
  uploading: 'Uploading…',
  uploaded: 'Uploaded',
  failed: 'Upload failed',
};

/** Status pill for the Garmin upload; hidden when upload was never attempted. */
function UploadPill({ status, error }: { status: RideUploadStatus | null; error: string | null }) {
  if (status === null) return null;
  return (
    <span
      className={`rounded-full border px-3 py-1 text-sm font-medium ${UPLOAD_PILL_CLASS[status]}`}
      title={status === 'failed' && error !== null ? error : undefined}
    >
      {UPLOAD_PILL_LABEL[status]}
    </span>
  );
}

/**
 * Ride detail view: summary stats from the rides list plus per-second samples
 * fetched from GET /api/rides/:id/samples (loading / error / empty states).
 */
export function RideDetailPage() {
  const { rideId } = useParams();
  const [rides, setRides] = useState<RideListItem[]>([]);
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [samples, setSamples] = useState<RideChartSample[] | null>(null);
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [samplesAttempt, setSamplesAttempt] = useState(0);

  const [ftpEstimate, setFtpEstimate] = useState<FtpEstimates | null>(null);
  const [ftpError, setFtpError] = useState<string | null>(null);
  const [ftpAttempt, setFtpAttempt] = useState(0);
  const [applyingFtp, setApplyingFtp] = useState<'ramp' | 'twentyMin' | null>(null);
  const [appliedFtp, setAppliedFtp] = useState<number | null>(null);

  const [uploadStatus, setUploadStatus] = useState<RideUploadStatus | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadActionError, setUploadActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rideList, profileList] = await Promise.all([listRides(), listProfiles()]);
      setRides(rideList);
      setProfiles(profileList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ride details.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ride = useMemo(() => rides.find((r) => r.id === rideId) ?? null, [rides, rideId]);
  const profile = useMemo(() => profiles.find((p) => p.id === ride?.riderId), [profiles, ride]);
  const summary = useMemo(() => (ride === null ? null : parseSummary(ride.summary)), [ride]);

  // Fetch per-second samples once the ride row resolves; retried via the
  // samplesAttempt counter. A stale in-flight request is cancelled by the
  // effect cleanup when the ride changes.
  useEffect(() => {
    if (ride === null) {
      setSamples(null);
      setSamplesError(null);
      return;
    }
    let cancelled = false;
    setSamples(null);
    setSamplesLoading(true);
    setSamplesError(null);
    listRideSamples(ride.id)
      .then((rows) => {
        if (!cancelled) setSamples(rows);
      })
      .catch((err) => {
        if (!cancelled) setSamplesError(err instanceof Error ? err.message : 'Failed to load ride samples.');
      })
      .finally(() => {
        if (!cancelled) setSamplesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ride, samplesAttempt]);

  // Seed the upload pill from the rides-row fields whenever the ride resolves.
  useEffect(() => {
    if (ride === null) return;
    setUploadStatus(ride.uploadStatus);
    setUploadError(ride.uploadError);
    setUploadActionError(null);
  }, [ride]);

  // Poll /upload-status every 3 s while an upload is queued or in flight;
  // stops on the terminal states (uploaded / failed / never attempted).
  useEffect(() => {
    if (ride === null || (uploadStatus !== 'pending' && uploadStatus !== 'uploading')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      try {
        const row = await rideUploadStatus(ride.id);
        if (cancelled) return;
        setUploadStatus(row.uploadStatus);
        setUploadError(row.uploadError);
        if (row.uploadStatus !== 'pending' && row.uploadStatus !== 'uploading' && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // Transient poll failure: keep polling on the next tick.
      }
    };
    void poll();
    timer = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [ride, uploadStatus]);

  // FTP estimates from this ride's power stream; retried via ftpAttempt.
  useEffect(() => {
    if (ride === null || ride.endedAt === null) {
      setFtpEstimate(null);
      setFtpError(null);
      setAppliedFtp(null);
      return;
    }
    let cancelled = false;
    setFtpEstimate(null);
    setFtpError(null);
    setAppliedFtp(null);
    ftpEstimates(ride.id)
      .then((estimate) => {
        if (!cancelled) setFtpEstimate(estimate);
      })
      .catch((err) => {
        if (!cancelled) setFtpError(err instanceof Error ? err.message : 'Failed to load FTP estimates.');
      });
    return () => {
      cancelled = true;
    };
  }, [ride, ftpAttempt]);

  async function handleUpload() {
    if (ride === null) return;
    setUploadActionError(null);
    setUploading(true);
    try {
      await uploadRide(ride.id);
      // Optimistic: the server marks the row on its own schedule; the poll
      // effect picks up the authoritative state on its next tick.
      setUploadStatus('pending');
      setUploadError(null);
    } catch (err) {
      setUploadActionError(err instanceof Error ? err.message : 'Failed to queue the upload.');
    } finally {
      setUploading(false);
    }
  }

  async function handleApplyFtp(kind: 'ramp' | 'twentyMin') {
    if (profile === undefined || ftpEstimate === null) return;
    const estimate = kind === 'ramp' ? ftpEstimate.ramp : ftpEstimate.twentyMin;
    if (estimate === null || estimate <= 0) return;
    const ftpW = Math.round(estimate);
    setFtpError(null);
    setApplyingFtp(kind);
    try {
      // Re-fetch the profile so the PUT spreads fresh values, not the
      // possibly-stale copy the header rendered.
      const fresh = (await listProfiles()).find((p) => p.id === profile.id);
      if (fresh === undefined) {
        setFtpError('Profile no longer exists.');
        return;
      }
      const { id, ...rest } = fresh;
      await updateProfile(id, { ...rest, ftpW });
      setAppliedFtp(ftpW);
      // The header shows the rider's FTP via the profile; refresh it.
      setProfiles(await listProfiles());
    } catch (err) {
      setFtpError(err instanceof Error ? err.message : 'Failed to update FTP.');
    } finally {
      setApplyingFtp(null);
    }
  }

  if (loading) {
    return <p className="p-8 text-dim">Loading ride…</p>;
  }

  if (error !== null) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="rounded-[14px] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          <p>{error}</p>
          <button type="button" onClick={() => void load()} className="mt-3 text-danger underline hover:text-danger/80">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (ride === null) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <p className="text-dim">Ride not found.</p>
        <Link to="/history" className="mt-3 inline-block text-sm text-on hover:text-on">
          Back to history
        </Link>
      </div>
    );
  }

  const riderName = profile?.name ?? 'Unknown rider';
  const fitName = `${riderName}-${new Date(ride.startedAt).toISOString().slice(0, 10)}.fit`;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link to="/history" className="text-sm text-dim hover:text-ink">
        ← History
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">{riderName}</h1>
          <p className="mt-1 text-dim">
            {new Date(ride.startedAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}
          </p>
          {ride.workoutName !== null && <p className="mt-1 text-sm text-dim">{ride.workoutName}</p>}
        </div>
        {/* Finalized rides always get the FIT link; the endpoint 404s cleanly
            if the file is missing, so summary parse success is not a gate. */}
        {ride.endedAt !== null && (
          <a
            href={fitUrl(ride.id)}
            download={fitName}
            className="inline-flex items-center gap-2 rounded-[8px] bg-on px-4 py-2 text-sm font-semibold text-void hover:bg-on/85"
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
            Download FIT
          </a>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Duration" value={summary === null ? '—' : formatDuration(summary.durationS)} />
        <Stat label="Distance" value={summary === null ? '—' : `${(summary.distanceM / 1000).toFixed(1)} km`} />
        <Stat label="Avg Power" value={summary === null ? '—' : `${Math.round(summary.avgPowerW)} W`} />
        <Stat label="Weighted Power" value={summary === null ? '—' : `${Math.round(summary.weightedPowerW)} W`} />
        <Stat label="Avg HR" value={summary === null || summary.avgHrBpm === null ? '—' : `${summary.avgHrBpm} bpm`} />
        <Stat
          label="Training Load"
          value={summary === null || summary.trainingLoad === null ? '—' : summary.trainingLoad.toFixed(1)}
        />
      </div>

      {ride.endedAt !== null && (
        <section className="mt-6 flex flex-wrap items-center gap-4 rounded-[14px] border border-line bg-panel p-4">
          <div className="min-w-40">
            <h2 className="font-display text-sm font-medium uppercase tracking-[0.06em] text-ink">Garmin Connect</h2>
            <p className="mt-0.5 text-xs text-dim">Upload this ride's FIT; Strava picks it up downstream.</p>
          </div>
          {uploadActionError !== null && <p className="text-sm text-danger">{uploadActionError}</p>}
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={
              uploading ||
              uploadStatus === 'uploaded' ||
              uploadStatus === 'pending' ||
              uploadStatus === 'uploading'
            }
            className="rounded-[8px] bg-on px-4 py-2 text-sm font-medium text-void hover:bg-on/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {uploading ? 'Uploading…' : uploadStatus === 'failed' ? 'Retry upload' : 'Upload to Garmin'}
          </button>
          <UploadPill status={uploadStatus} error={uploadError} />
        </section>
      )}

      {ride.endedAt !== null && (
        <section className="mt-6 rounded-[14px] border border-line bg-panel p-4">
          <h2 className="font-display text-sm font-medium uppercase tracking-[0.06em] text-ink">FTP estimate</h2>
          {ftpError !== null ? (
            <div className="mt-2 flex items-center gap-3 text-sm text-danger">
              <p>{ftpError}</p>
              <button
                type="button"
                onClick={() => setFtpAttempt((n) => n + 1)}
                className="text-danger underline hover:text-danger/80"
              >
                Retry
              </button>
            </div>
          ) : ftpEstimate === null ? (
            <p className="mt-2 text-sm text-dim">Estimating…</p>
          ) : ftpEstimate.ramp === null && ftpEstimate.twentyMin === null ? (
            <p className="mt-2 text-sm text-dim">No FTP estimate from this ride.</p>
          ) : (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink/90">
              {ftpEstimate.ramp !== null && (
                <span>
                  This ride suggests FTP ≈ {Math.round(ftpEstimate.ramp)} W (ramp)
                  <button
                    type="button"
                    onClick={() => void handleApplyFtp('ramp')}
                    disabled={applyingFtp !== null}
                    className="ml-2 rounded-[8px] border border-on/40 px-2 py-0.5 text-xs text-on hover:bg-on/10 disabled:opacity-50"
                  >
                    {applyingFtp === 'ramp'
                      ? 'Applying…'
                      : appliedFtp === Math.round(ftpEstimate.ramp)
                        ? 'Applied'
                        : 'Apply'}
                  </button>
                </span>
              )}
              {ftpEstimate.ramp !== null && ftpEstimate.twentyMin !== null && <span className="text-dim/70">/</span>}
              {ftpEstimate.twentyMin !== null && (
                <span>
                  {Math.round(ftpEstimate.twentyMin)} W (20 min)
                  <button
                    type="button"
                    onClick={() => void handleApplyFtp('twentyMin')}
                    disabled={applyingFtp !== null}
                    className="ml-2 rounded-[8px] border border-on/40 px-2 py-0.5 text-xs text-on hover:bg-on/10 disabled:opacity-50"
                  >
                    {applyingFtp === 'twentyMin'
                      ? 'Applying…'
                      : appliedFtp === Math.round(ftpEstimate.twentyMin)
                        ? 'Applied'
                        : 'Apply'}
                  </button>
                </span>
              )}
            </p>
          )}
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 font-display text-lg font-semibold uppercase tracking-[0.06em] text-ink">Power · HR · Cadence</h2>
        {samplesLoading ? (
          <div className="rounded-[14px] border border-dashed border-line bg-panel p-8 text-center text-sm text-dim">
            Loading samples…
          </div>
        ) : samplesError !== null ? (
          <div className="rounded-[14px] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            <p>{samplesError}</p>
            <button
              type="button"
              onClick={() => setSamplesAttempt((n) => n + 1)}
              className="mt-3 text-danger underline hover:text-danger/80"
            >
              Retry
            </button>
          </div>
        ) : samples !== null && samples.length > 0 ? (
          <RideChart samples={samples} />
        ) : (
          /* Only reachable when the endpoint returned an empty list. */
          <div className="rounded-[14px] border border-dashed border-line bg-panel p-8 text-center text-sm text-dim">
            No per-second samples were recorded for this ride.
          </div>
        )}
      </section>
    </div>
  );
}
