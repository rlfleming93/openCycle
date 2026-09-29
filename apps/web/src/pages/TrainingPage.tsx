import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { RiderProfile } from '@opencycle/shared';

import LoadChart from '../components/LoadChart.js';
import PlanCalendar from '../components/PlanCalendar.js';
import SuggestionBanner from '../components/SuggestionBanner.js';
import {
  assignActivities,
  assignPlan,
  deleteAssignment,
  getTrainingLoad,
  importGarminZip,
  listActivities,
  listPlanAssignments,
  listPlans,
  listProfiles,
  pullGarmin,
  type ActivityListItem,
  type ImportResult,
  type PlanAssignment,
  type PlanTemplate,
  type TrainingLoadResponse,
} from '../lib/api.js';

function tabClass(active: boolean): string {
  return active
    ? 'rounded-full bg-on/15 px-4 py-1.5 text-sm font-medium text-on'
    : 'rounded-full px-4 py-1.5 text-sm text-dim hover:bg-ink/5 hover:text-ink';
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatActivityDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Total rides across a template's weeks (every listed day carries a workoutId). */
function rideCount(template: PlanTemplate): number {
  let count = 0;
  for (const week of template.weeks) {
    count += week.days.length;
  }
  return count;
}

const inputClass =
  'rounded-[8px] border border-line bg-deep px-3 py-2 text-sm text-ink focus:border-on focus:outline-none';

/** '' = unassigned, otherwise a profile id. */
const UNASSIGNED = '';

interface AssignForm {
  templateId: string;
  riderId: string;
  startDate: string;
}

/**
 * Training hub: per-rider load dashboard (Fitness/Fatigue/Form + suggestion),
 * Garmin import (ZIP/FIT upload, Connect history pull, activity assignment),
 * and the plan library (which keeps an all-riders view).
 */
export default function TrainingPage() {
  const [profiles, setProfiles] = useState<RiderProfile[]>([]);

  // Physiology is per-rider only (ratified): no all-riders tab; the chart
  // defaults to the first profile.
  const [physioRiderId, setPhysioRiderId] = useState<string | null>(null);
  const physioRider = profiles.find((p) => p.id === physioRiderId) ?? profiles[0] ?? null;

  const [load, setLoad] = useState<TrainingLoadResponse | null>(null);
  const [loadLoading, setLoadLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Plan library keeps an all-riders tab alongside the per-rider ones.
  const [filter, setFilter] = useState('all');
  const [plans, setPlans] = useState<PlanTemplate[]>([]);
  const [assignments, setAssignments] = useState<PlanAssignment[]>([]);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [plansAttempt, setPlansAttempt] = useState(0);

  const [assigning, setAssigning] = useState<AssignForm | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Garmin import card.
  const [importRiderId, setImportRiderId] = useState(UNASSIGNED);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Garmin Connect history pull.
  const [pullingRiderId, setPullingRiderId] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullMessage, setPullMessage] = useState<string | null>(null);

  // Imported activities list + bulk assignment.
  const [activities, setActivities] = useState<ActivityListItem[]>([]);
  const [activitiesError, setActivitiesError] = useState<string | null>(null);
  const [activitiesAttempt, setActivitiesAttempt] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignRiderId, setAssignRiderId] = useState(UNASSIGNED);
  const [assigningActivities, setAssigningActivities] = useState(false);
  const [assignActivitiesError, setAssignActivitiesError] = useState<string | null>(null);

  const loadCurves = useCallback(
    async (cancelled: { current: boolean }) => {
      if (physioRider === null) {
        setLoad(null);
        setLoadLoading(false);
        setLoadError(null);
        return;
      }
      setLoadLoading(true);
      setLoadError(null);
      try {
        const data = await getTrainingLoad(physioRider.id);
        if (!cancelled.current) setLoad(data);
      } catch (err) {
        if (!cancelled.current) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load training data.');
        }
      } finally {
        if (!cancelled.current) setLoadLoading(false);
      }
    },
    [physioRider],
  );

  useEffect(() => {
    const cancelled = { current: false };
    void loadCurves(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [loadCurves, loadAttempt]);

  const loadPlansAndAssignments = useCallback(async () => {
    setPlansError(null);
    try {
      const [planList, assignmentList] = await Promise.all([
        listPlans(),
        listPlanAssignments(filter === 'all' ? undefined : filter),
      ]);
      setPlans(planList);
      setAssignments(assignmentList);
    } catch (err) {
      setPlansError(err instanceof Error ? err.message : 'Failed to load plans.');
    }
  }, [filter]);

  useEffect(() => {
    void loadPlansAndAssignments();
  }, [loadPlansAndAssignments, plansAttempt]);

  useEffect(() => {
    void listProfiles()
      .then((list) => {
        setProfiles(list);
        setPhysioRiderId((prev) => (prev !== null && list.some((p) => p.id === prev) ? prev : (list[0]?.id ?? null)));
      })
      .catch((err) => setPlansError(err instanceof Error ? err.message : 'Failed to load profiles.'));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setActivitiesError(null);
    listActivities()
      .then((list) => {
        if (!cancelled) {
          setActivities(list);
          setSelectedIds(new Set());
        }
      })
      .catch((err) => {
        if (!cancelled) setActivitiesError(err instanceof Error ? err.message : 'Failed to load activities.');
      });
    return () => {
      cancelled = true;
    };
  }, [activitiesAttempt]);

  const riderNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of profiles) map.set(profile.id, profile.name);
    return map;
  }, [profiles]);

  function openAssign(templateId: string) {
    setAssignError(null);
    setAssigning({
      templateId,
      riderId: profiles[0]?.id ?? '',
      startDate: localDateString(new Date()),
    });
  }

  async function handleAssign(e: FormEvent) {
    e.preventDefault();
    if (assigning === null) return;
    setAssignError(null);
    try {
      await assignPlan({
        riderId: assigning.riderId,
        templateId: assigning.templateId,
        startDate: assigning.startDate,
      });
      setAssigning(null);
      setPlansAttempt((n) => n + 1);
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : 'Failed to assign plan.');
    }
  }

  async function handleDelete(assignment: PlanAssignment) {
    if (!window.confirm(`Delete this plan assignment?`)) return;
    setDeletingId(assignment.id);
    setPlansError(null);
    try {
      await deleteAssignment(assignment.id);
      setPlansAttempt((n) => n + 1);
    } catch (err) {
      setPlansError(err instanceof Error ? err.message : 'Failed to delete plan.');
    } finally {
      setDeletingId(null);
    }
  }

  async function handleImport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (importFile === null) return;
    const form = e.currentTarget;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const result = await importGarminZip(importRiderId === UNASSIGNED ? null : importRiderId, importFile);
      setImportResult(result);
      setActivitiesAttempt((n) => n + 1);
      // Imported activities may carry trainingLoad; refresh the charted rider's curve.
      setLoadAttempt((n) => n + 1);
      form.reset();
      setImportFile(null);
    } catch (err) {
      if (err instanceof Error && (err as Error & { status?: number }).status === 409) {
        setImportError('Finish the ride first.');
      } else {
        setImportError(err instanceof Error ? err.message : 'Failed to import.');
      }
    } finally {
      setImporting(false);
    }
  }

  async function handlePull(riderId: string) {
    setPullingRiderId(riderId);
    setPullError(null);
    setPullMessage(null);
    try {
      await pullGarmin(riderId);
      setPullMessage('Pull started — activities appear as they land.');
      // The pull is async server-side; give it 30 s before refreshing the list.
      window.setTimeout(() => setActivitiesAttempt((n) => n + 1), 30_000);
      // Pulled activities land under the rider and may carry load; refresh the curve now.
      setLoadAttempt((n) => n + 1);
    } catch (err) {
      setPullError(err instanceof Error ? err.message : 'Failed to start the pull.');
    } finally {
      setPullingRiderId(null);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleAssignActivities() {
    if (selectedIds.size === 0) return;
    setAssigningActivities(true);
    setAssignActivitiesError(null);
    try {
      await assignActivities(assignRiderId === UNASSIGNED ? null : assignRiderId, [...selectedIds]);
      setActivitiesAttempt((n) => n + 1);
      // Assigned activities now count toward the rider's load; refresh the curve.
      setLoadAttempt((n) => n + 1);
    } catch (err) {
      setAssignActivitiesError(err instanceof Error ? err.message : 'Failed to assign activities.');
    } finally {
      setAssigningActivities(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="font-display text-3xl font-semibold uppercase tracking-[0.06em] text-ink">Training</h1>

      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold uppercase tracking-[0.06em] text-ink">Fitness · Fatigue · Form</h2>
          {profiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={tabClass(physioRider?.id === profile.id)}
                  onClick={() => setPhysioRiderId(profile.id)}
                >
                  {profile.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {profiles.length === 0 ? (
          <p className="mt-4 text-dim">Create a profile to see training data.</p>
        ) : (
          <>
            {loadError !== null && (
              <div className="mt-4 rounded-[14px] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
                <p>{loadError}</p>
                <button
                  type="button"
                  onClick={() => setLoadAttempt((n) => n + 1)}
                  className="mt-3 text-danger underline hover:text-danger/80"
                >
                  Retry
                </button>
              </div>
            )}

            {load !== null && (
              <div className="mt-4 space-y-4">
                <SuggestionBanner load={load} />
                <LoadChart load={load} />
              </div>
            )}
            {loadLoading && load === null && <p className="mt-4 text-dim">Loading training data…</p>}
          </>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold uppercase tracking-[0.06em] text-ink">Garmin import</h2>

        <div className="mt-4 rounded-[14px] border border-line bg-panel p-5">
          <form onSubmit={(e) => void handleImport(e)} className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-sm text-dim">Import to rider</span>
              <select
                className={inputClass}
                value={importRiderId}
                onChange={(e) => setImportRiderId(e.target.value)}
              >
                <option value={UNASSIGNED}>Unassigned</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-dim">Garmin export ZIP or FIT file</span>
              <input
                type="file"
                accept=".zip,.fit"
                onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-dim file:mr-3 file:rounded-[8px] file:border-0 file:bg-ink/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-ink/15"
              />
            </label>
            <button
              type="submit"
              disabled={importing || importFile === null}
              className="rounded-[8px] bg-on px-4 py-2 text-sm font-medium text-void hover:bg-on/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
          </form>
          {importError !== null && <p className="mt-3 text-sm text-danger">{importError}</p>}
          {importResult !== null && (
            <div className="mt-3 text-sm text-ink/90">
              <p>
                Imported {importResult.imported} · Skipped {importResult.skipped}
              </p>
              {importResult.errors.length > 0 && (
                <ul className="mt-2 list-inside list-disc space-y-1 text-danger">
                  {importResult.errors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 rounded-[14px] border border-line bg-panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-sm font-medium uppercase tracking-[0.06em] text-ink">Pull recent from Garmin Connect</h3>
              <p className="mt-0.5 text-xs text-dim">
                Fetches recent activities for the rider's account; new activities appear as they land.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => void handlePull(profile.id)}
                  disabled={pullingRiderId !== null}
                  className="rounded-[8px] border border-line px-3 py-1.5 text-sm text-ink/90 hover:bg-ink/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pullingRiderId === profile.id ? 'Pulling…' : `Pull ${profile.name}`}
                </button>
              ))}
            </div>
          </div>
          {pullError !== null && <p className="mt-3 text-sm text-danger">{pullError}</p>}
          {pullMessage !== null && <p className="mt-3 text-sm text-on">{pullMessage}</p>}
        </div>

        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-base font-semibold uppercase tracking-[0.06em] text-ink">Imported activities</h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={inputClass}
                value={assignRiderId}
                onChange={(e) => setAssignRiderId(e.target.value)}
                aria-label="Assign selected activities to"
              >
                <option value={UNASSIGNED}>Unassigned</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleAssignActivities()}
                disabled={assigningActivities || selectedIds.size === 0}
                className="rounded-[8px] bg-on px-4 py-2 text-sm font-medium text-void hover:bg-on/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {assigningActivities ? 'Assigning…' : `Assign ${selectedIds.size} selected`}
              </button>
            </div>
          </div>
          {assignActivitiesError !== null && <p className="mt-2 text-sm text-danger">{assignActivitiesError}</p>}
          {activitiesError !== null ? (
            <div className="mt-3 rounded-[14px] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
              <p>{activitiesError}</p>
              <button
                type="button"
                onClick={() => setActivitiesAttempt((n) => n + 1)}
                className="mt-3 text-danger underline hover:text-danger/80"
              >
                Retry
              </button>
            </div>
          ) : activities.length === 0 ? (
            <p className="mt-3 rounded-[14px] border border-dashed border-line bg-panel p-6 text-center text-sm text-dim">
              No imported activities yet.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-[14px] border border-line">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-dim">
                    <th className="w-10 px-4 py-3" />
                    <th className="py-3 pr-4">Date</th>
                    <th className="py-3 pr-4">Name</th>
                    <th className="py-3 pr-4">Sport</th>
                    <th className="py-3 pr-4">Duration</th>
                    <th className="py-3 pr-4">Rider</th>
                  </tr>
                </thead>
                <tbody>
                  {activities.map((activity) => (
                    <tr key={activity.id} className="border-t border-line">
                      <td className="px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(activity.id)}
                          onChange={() => toggleSelected(activity.id)}
                          className="h-4 w-4 accent-[var(--color-on)]"
                          aria-label={`Select ${activity.name ?? 'activity'} on ${formatActivityDate(activity.startedAt)}`}
                        />
                      </td>
                      <td className="py-2.5 pr-4 text-ink/90">{formatActivityDate(activity.startedAt)}</td>
                      <td className="py-2.5 pr-4 text-ink">{activity.name ?? '—'}</td>
                      <td className="py-2.5 pr-4 text-dim">{activity.sport ?? '—'}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-ink/90">{formatDuration(activity.durationS)}</td>
                      <td className="py-2.5 pr-4 text-dim">
                        {activity.riderId === null ? 'Unassigned' : riderNameById.get(activity.riderId) ?? 'Unknown rider'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold uppercase tracking-[0.06em] text-ink">Plan library</h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={tabClass(filter === 'all')} onClick={() => setFilter('all')}>
              All riders
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
        </div>
        {plansError !== null && (
          <div className="mt-4 rounded-[14px] border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            <p>{plansError}</p>
            <button
              type="button"
              onClick={() => setPlansAttempt((n) => n + 1)}
              className="mt-3 text-danger underline hover:text-danger/80"
            >
              Retry
            </button>
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {plans.map((plan) => (
            <div key={plan.id} className="rounded-[14px] border border-line bg-panel p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-ink">{plan.name}</h3>
                  <p className="mt-1 text-sm text-dim">
                    {plan.weeks.length} weeks · {rideCount(plan)} rides
                  </p>
                </div>
                {assigning === null && (
                  <button
                    type="button"
                    onClick={() => openAssign(plan.id)}
                    disabled={profiles.length === 0}
                    className="shrink-0 rounded-[8px] bg-on px-3 py-1.5 text-sm font-medium text-void hover:bg-on/85 disabled:cursor-not-allowed disabled:opacity-40"
                    title={profiles.length === 0 ? 'Create a profile first' : undefined}
                  >
                    Assign
                  </button>
                )}
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink/90">{plan.description}</p>

              {assigning !== null && assigning.templateId === plan.id && (
                <form onSubmit={(e) => void handleAssign(e)} className="mt-4 space-y-3 border-t border-line pt-4">
                  <label className="block">
                    <span className="mb-1 block text-sm text-dim">Rider</span>
                    <select
                      className={inputClass}
                      value={assigning.riderId}
                      onChange={(e) => setAssigning({ ...assigning, riderId: e.target.value })}
                    >
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm text-dim">Start date</span>
                    <input
                      className={inputClass}
                      type="date"
                      value={assigning.startDate}
                      min={localDateString(new Date())}
                      onChange={(e) => setAssigning({ ...assigning, startDate: e.target.value })}
                    />
                  </label>
                  {assignError !== null && <p className="text-sm text-danger">{assignError}</p>}
                  <div className="flex gap-3">
                    <button
                      type="submit"
                      disabled={assigning.riderId === '' || assigning.startDate === ''}
                      className="rounded-[8px] bg-on px-4 py-2 text-sm font-medium text-void hover:bg-on/85 disabled:opacity-50"
                    >
                      Assign plan
                    </button>
                    <button
                      type="button"
                      onClick={() => setAssigning(null)}
                      className="rounded-[8px] border border-line px-4 py-2 text-sm text-ink/90 hover:bg-ink/5"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold uppercase tracking-[0.06em] text-ink">
          {filter === 'all' ? 'Your plans' : `${riderNameById.get(filter) ?? 'Rider'}'s plans`}
        </h2>
        <div className="mt-4">
          <PlanCalendar
            assignments={assignments}
            templates={plans}
            profiles={profiles}
            deletingId={deletingId}
            onDelete={(assignment) => void handleDelete(assignment)}
          />
        </div>
      </section>
    </div>
  );
}
