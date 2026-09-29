import { useCallback, useEffect, useState } from 'react';

import type { RiderProfile } from '@opencycle/shared';

import ProfileForm from '../components/ProfileForm.js';
import { deleteProfile, ftpFromHistory, listProfiles, updateProfile } from '../lib/api.js';

type EditingState = { mode: 'create' } | { mode: 'edit'; profile: RiderProfile } | null;

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [estimatingId, setEstimatingId] = useState<string | null>(null);
  /** profileId -> last history FTP estimate; null = no qualifying power data. */
  const [estimates, setEstimates] = useState<Record<string, number | null>>({});
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setProfiles(await listProfiles());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(profile: RiderProfile) {
    if (!window.confirm(`Delete profile "${profile.name}"? This cannot be undone.`)) return;
    setDeletingId(profile.id);
    setError(null);
    try {
      await deleteProfile(profile.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleEstimate(profile: RiderProfile) {
    setError(null);
    setEstimatingId(profile.id);
    try {
      const { ftpW } = await ftpFromHistory(profile.id);
      setEstimates((prev) => ({ ...prev, [profile.id]: ftpW }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEstimatingId(null);
    }
  }

  async function handleApplyFtp(profile: RiderProfile, ftpW: number) {
    setError(null);
    setApplyingId(profile.id);
    try {
      // Re-fetch the profile so the PUT spreads fresh values, not the
      // possibly-stale card copy.
      const fresh = (await listProfiles()).find((p) => p.id === profile.id);
      if (fresh === undefined) {
        setError('Profile no longer exists.');
        return;
      }
      const { id, ...rest } = fresh;
      await updateProfile(id, { ...rest, ftpW });
      setEstimates((prev) => {
        const next = { ...prev };
        delete next[profile.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">Profiles</h1>
          <p className="mt-1 text-sm text-dim">Riders and their FTP / weight settings.</p>
        </div>
        {editing === null && (
          <button
            onClick={() => setEditing({ mode: 'create' })}
            className="shrink-0 rounded-[8px] bg-on px-4 py-2 font-medium text-void hover:bg-on/85"
          >
            New profile
          </button>
        )}
      </div>

      {error !== null && (
        <p className="mb-4 rounded-[8px] border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">{error}</p>
      )}

      {editing !== null && (
        <div className="mb-8 rounded-[14px] border border-line bg-panel p-5">
          <h2 className="mb-4 font-display text-lg font-medium uppercase tracking-[0.06em] text-ink">
            {editing.mode === 'create' ? 'New profile' : `Edit ${editing.profile.name}`}
          </h2>
          <ProfileForm
            initial={editing.mode === 'edit' ? editing.profile : undefined}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {loading && editing === null && <p className="text-dim">Loading profiles…</p>}

      {!loading && editing === null && profiles.length === 0 && (
        <p className="text-dim">No profiles yet. Create one to start riding.</p>
      )}

      {profiles.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {profiles.map((p) => (
            <div key={p.id} className="rounded-[14px] border border-line bg-panel p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="truncate font-display text-lg font-semibold uppercase tracking-[0.06em] text-ink">{p.name}</h3>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => setEditing({ mode: 'edit', profile: p })}
                    className="rounded-[8px] border border-line px-2 py-1 text-xs text-ink/90 hover:bg-ink/10"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void handleDelete(p)}
                    disabled={deletingId === p.id}
                    className="rounded-[8px] border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    {deletingId === p.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
              <dl className="mt-4 space-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-dim">FTP</dt>
                  <dd className="text-ink">{p.ftpW} W</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-dim">Weight</dt>
                  <dd className="text-ink">{p.weightKg} kg</dd>
                </div>
                {p.restingHr !== undefined && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-dim">Resting HR</dt>
                    <dd className="text-ink">{p.restingHr} bpm</dd>
                  </div>
                )}
                {p.maxHr !== undefined && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-dim">Max HR</dt>
                    <dd className="text-ink">{p.maxHr} bpm</dd>
                  </div>
                )}
                {p.garmin !== undefined && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-dim">Garmin</dt>
                    <dd className="truncate text-ink">{p.garmin.email}</dd>
                  </div>
                )}
              </dl>
              <div className="mt-4 border-t border-line pt-3">
                {estimates[p.id] === undefined ? (
                  <button
                    onClick={() => void handleEstimate(p)}
                    disabled={estimatingId === p.id}
                    className="rounded-[8px] border border-line px-2 py-1 text-xs text-ink/90 hover:bg-ink/10 disabled:opacity-50"
                  >
                    {estimatingId === p.id ? 'Estimating…' : 'Estimate FTP from history'}
                  </button>
                ) : estimates[p.id] === null ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-dim">No power data in the last 6 months</p>
                    <button
                      onClick={() => void handleEstimate(p)}
                      disabled={estimatingId === p.id}
                      className="rounded-[8px] border border-line px-2 py-1 text-xs text-ink/90 hover:bg-ink/10 disabled:opacity-50"
                    >
                      {estimatingId === p.id ? 'Estimating…' : 'Estimate FTP from history'}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-ink/90">
                      ≈ {estimates[p.id]} W from the last 6 months
                    </p>
                    <button
                      onClick={() => void handleApplyFtp(p, estimates[p.id]!)}
                      disabled={applyingId === p.id}
                      className="rounded-[8px] border border-on/40 px-2 py-1 text-xs text-on hover:bg-on/10 disabled:opacity-50"
                    >
                      {applyingId === p.id ? 'Applying…' : 'Apply'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
