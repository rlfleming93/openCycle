import { useEffect, useRef, useState } from 'react';

import { Link, useNavigate } from 'react-router-dom';

import type { DeviceInfo, RiderProfile, RiderStart } from '@opencycle/shared';

import { importZwo, listDevices, listProfiles, listWorkouts, startSession } from '../lib/api.js';
import { useAppStore } from '../store.js';

interface WorkoutListItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: 'library' | 'import';
}

type ListedDevice = DeviceInfo & { riderId?: string };

interface RiderRow {
  key: number;
  profileId: string;
  trainerId: string;
  hrmId: string;
  workoutId: string;
  workoutQuery: string;
}

const EMPTY_ROW: RiderRow = { key: 0, profileId: '', trainerId: '', hrmId: '', workoutId: '', workoutQuery: '' };

const selectClass =
  'w-full rounded-[8px] border border-line bg-deep px-3 py-2 text-ink focus:border-on focus:outline-none';

export default function SessionBuilderPage() {
  const navigate = useNavigate();
  const nextKey = useRef(1);
  const spaceGame = useAppStore((s) => s.spaceGame);
  const setSpaceGame = useAppStore((s) => s.setSpaceGame);
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);
  const [devices, setDevices] = useState<ListedDevice[]>([]);
  const [workouts, setWorkouts] = useState<WorkoutListItem[]>([]);
  const [rows, setRows] = useState<RiderRow[]>([{ ...EMPTY_ROW }]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [uploadingKey, setUploadingKey] = useState<number | null>(null);
  const [lastImport, setLastImport] = useState<{ key: number; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [ps, ds, ws] = await Promise.all([listProfiles(), listDevices(), listWorkouts()]);
        if (cancelled) return;
        setProfiles(ps);
        setDevices(ds);
        setWorkouts(ws);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const trainers = devices.filter((d) => d.kind === 'trainer');
  const hrms = devices.filter((d) => d.kind === 'hrm');

  function addRow() {
    const key = nextKey.current++;
    setRows((rs) => [...rs, { ...EMPTY_ROW, key }]);
  }

  function patchRow(key: number, patch: Partial<Omit<RiderRow, 'key'>>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function handleProfileChange(key: number, profileId: string) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const assigned = devices.find((d) => d.kind === 'trainer' && d.riderId === profileId);
        const trainerId =
          assigned !== undefined && !rs.some((o) => o.key !== key && o.trainerId === assigned.id)
            ? assigned.id
            : r.trainerId;
        return { ...r, profileId, trainerId };
      }),
    );
  }

  function profileOptions(row: RiderRow): RiderProfile[] {
    const usedElsewhere = new Set(rows.filter((r) => r.key !== row.key).map((r) => r.profileId));
    return profiles.filter((p) => !usedElsewhere.has(p.id));
  }

  /** Trainers not assigned to another rider come first; all trainers stay selectable. */
  function trainerOptions(row: RiderRow): ListedDevice[] {
    const usedElsewhere = new Set(rows.filter((r) => r.key !== row.key).map((r) => r.trainerId));
    const available = trainers.filter((t) => !usedElsewhere.has(t.id));
    const free = available.filter((t) => t.riderId === undefined || t.riderId === row.profileId);
    const rest = available.filter((t) => t.riderId !== undefined && t.riderId !== row.profileId);
    return [...free, ...rest];
  }

  function hrmOptions(row: RiderRow): ListedDevice[] {
    const usedElsewhere = new Set(rows.filter((r) => r.key !== row.key).map((r) => r.hrmId));
    return hrms.filter((h) => !usedElsewhere.has(h.id));
  }

  function profileName(id: string): string {
    return profiles.find((p) => p.id === id)?.name ?? 'another rider';
  }

  function visibleWorkouts(row: RiderRow): WorkoutListItem[] {
    const query = row.workoutQuery.trim().toLowerCase();
    const filtered = workouts.filter((w) => w.name.toLowerCase().includes(query));
    if (row.workoutId !== '' && !filtered.some((w) => w.id === row.workoutId)) {
      const selected = workouts.find((w) => w.id === row.workoutId);
      if (selected !== undefined) return [selected, ...filtered];
    }
    return filtered;
  }

  async function handleZwoFile(rowKey: number, file: File | undefined) {
    if (file === undefined) return;
    setUploadingKey(rowKey);
    setError(null);
    setLastImport(null);
    try {
      const xml = await file.text();
      const imported = await importZwo(xml);
      setWorkouts(await listWorkouts());
      patchRow(rowKey, { workoutId: imported.id, workoutQuery: imported.name });
      setLastImport({ key: rowKey, name: imported.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingKey(null);
    }
  }

  const ready = rows.length > 0 && rows.every((r) => r.profileId !== '' && r.trainerId !== '');

  async function handleStart() {
    if (!ready) return;
    setStarting(true);
    setError(null);
    const riders: RiderStart[] = rows.map((r) => ({
      profileId: r.profileId,
      trainerId: r.trainerId,
      ...(r.hrmId !== '' ? { hrmId: r.hrmId } : {}),
      ...(r.workoutId !== '' ? { workoutId: r.workoutId } : {}),
    }));
    try {
      await startSession(riders);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  function riderRow(row: RiderRow, index: number) {
    return (
      <div key={row.key} className="rounded-[14px] border border-line bg-panel p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display font-medium uppercase tracking-[0.06em] text-ink">Rider {index + 1}</h3>
          {rows.length > 1 && (
            <button
              onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
              className="rounded-[8px] border border-line px-2 py-1 text-xs text-ink/90 hover:bg-ink/10"
            >
              Remove
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm text-dim">Profile</span>
            <select
              className={selectClass}
              value={row.profileId}
              onChange={(e) => handleProfileChange(row.key, e.target.value)}
            >
              <option value="" disabled>
                Select rider…
              </option>
              {profileOptions(row).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.ftpW} W
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-dim">Trainer</span>
            <select
              className={selectClass}
              value={row.trainerId}
              onChange={(e) => patchRow(row.key, { trainerId: e.target.value })}
            >
              <option value="" disabled>
                Select trainer…
              </option>
              {trainerOptions(row).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name === '' ? 'Unnamed trainer' : t.name}
                  {t.riderId !== undefined && t.riderId !== row.profileId
                    ? ` (assigned to ${profileName(t.riderId)})`
                    : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-dim">Heart rate strap (optional)</span>
            <select
              className={selectClass}
              value={row.hrmId}
              onChange={(e) => patchRow(row.key, { hrmId: e.target.value })}
            >
              <option value="">None</option>
              {hrmOptions(row).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name === '' ? 'Unnamed strap' : h.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm text-dim">Workout (optional)</span>
            <input
              className={`${selectClass} mb-2`}
              placeholder="Search workouts…"
              value={row.workoutQuery}
              onChange={(e) => patchRow(row.key, { workoutQuery: e.target.value })}
            />
            <select
              className={selectClass}
              value={row.workoutId}
              onChange={(e) => patchRow(row.key, { workoutId: e.target.value })}
            >
              <option value="">Free ride</option>
              {visibleWorkouts(row).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <div>
            <span className="mb-1 block text-sm text-dim">Import .zwo workout</span>
            <label
              className={`flex cursor-pointer items-center justify-center rounded-[8px] border border-dashed border-line px-4 py-3 text-sm text-dim hover:border-on/60 hover:text-on ${
                uploadingKey === row.key ? 'opacity-50' : ''
              }`}
            >
              {uploadingKey === row.key ? 'Importing…' : 'Choose .zwo file'}
              <input
                type="file"
                accept=".zwo,.xml,application/xml,text/xml"
                className="hidden"
                disabled={uploadingKey === row.key}
                onChange={(e) => {
                  void handleZwoFile(row.key, e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            {lastImport !== null && lastImport.key === row.key && (
              <p className="mt-1 text-xs text-on">Imported {lastImport.name}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">New session</h1>
        <p className="mt-1 text-sm text-dim">Pick riders, trainers, and workouts. Everyone rides together.</p>
      </div>

      {error !== null && (
        <p className="mb-4 rounded-[8px] border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">{error}</p>
      )}

      {trainers.length === 0 && (
        <div className="mb-6 rounded-[8px] border border-over/40 bg-over/10 px-4 py-3 text-sm text-over">
          No trainers paired yet.{' '}
          <Link to="/devices" className="underline hover:text-over">
            Pair trainers on the Devices page
          </Link>{' '}
          to start a session.
        </div>
      )}

      <div className="space-y-4">{rows.map(riderRow)}</div>

      <div className="mt-6">
        <span className="mb-1 block font-display text-sm uppercase tracking-[0.06em] text-dim">Space game</span>
        <div className="flex w-fit overflow-hidden rounded-[8px] border border-line">
          <button
            type="button"
            aria-pressed={spaceGame}
            onClick={() => setSpaceGame(true)}
            className={`px-4 py-2 font-display text-sm uppercase tracking-[0.06em] ${
              spaceGame ? 'bg-on font-semibold text-void' : 'bg-deep text-dim hover:bg-ink/10 hover:text-ink'
            }`}
          >
            On
          </button>
          <button
            type="button"
            aria-pressed={!spaceGame}
            onClick={() => setSpaceGame(false)}
            className={`px-4 py-2 font-display text-sm uppercase tracking-[0.06em] ${
              spaceGame ? 'bg-deep text-dim hover:bg-ink/10 hover:text-ink' : 'bg-on font-semibold text-void'
            }`}
          >
            Off
          </button>
        </div>
        <p className="mt-1 text-sm text-dim">Fly each workout as a voyage leg. Free rides cruise open space.</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          onClick={addRow}
          disabled={rows.length >= trainers.length}
          className="rounded-[8px] border border-line px-4 py-2 text-sm text-ink/90 hover:bg-ink/5 disabled:opacity-40"
        >
          Add rider
        </button>
        <button
          onClick={() => void handleStart()}
          disabled={!ready || starting}
          className="rounded-[8px] bg-on px-6 py-2 font-medium text-void hover:bg-on/85 disabled:opacity-40"
        >
          {starting ? 'Starting…' : 'Start session'}
        </button>
        {!ready && rows.length > 0 && (
          <p className="text-sm text-dim">Every rider needs a profile and a trainer.</p>
        )}
      </div>
    </div>
  );
}
