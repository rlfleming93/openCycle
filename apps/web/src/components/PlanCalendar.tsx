import { useMemo } from 'react';
import type { RiderProfile } from '@opencycle/shared';

import type { PlanAssignment, PlanTemplate } from '../lib/api.js';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Calendar span rendered per assignment, starting today. */
const DAYS_AHEAD = 28;

function dateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

const DAY_CELL_BASE =
  'flex min-h-14 flex-col gap-1 rounded-[8px] border p-1.5';

interface PlanCalendarProps {
  assignments: PlanAssignment[];
  templates: PlanTemplate[];
  profiles: RiderProfile[];
  deletingId: string | null;
  onDelete: (assignment: PlanAssignment) => void;
}

/**
 * Next 28 days for each plan assignment: a 7x4 day grid with workout-name
 * chips from the assignment's rendered calendar, today highlighted, and a
 * per-assignment delete control.
 */
export default function PlanCalendar({
  assignments,
  templates,
  profiles,
  deletingId,
  onDelete,
}: PlanCalendarProps) {
  const today = useMemo(() => new Date(), []);
  const todayString = dateString(today);
  const firstDow = today.getDay();

  const templateNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const template of templates) map.set(template.id, template.name);
    return map;
  }, [templates]);

  const riderNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of profiles) map.set(profile.id, profile.name);
    return map;
  }, [profiles]);

  if (assignments.length === 0) {
    return (
      <p className="rounded-[14px] border border-dashed border-line bg-panel p-6 text-center text-sm text-dim">
        No plan assigned yet — pick a template above.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {assignments.map((assignment) => {
        const entryByDate = new Map(assignment.calendar.map((entry) => [entry.date, entry]));
        const days = Array.from({ length: DAYS_AHEAD }, (_, i) => {
          const date = addDays(today, i);
          return { date, dateKey: dateString(date), entry: entryByDate.get(dateString(date)) };
        });
        return (
          <section key={assignment.id} className="rounded-[14px] border border-line bg-panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display font-semibold uppercase tracking-[0.06em] text-ink">
                  {templateNameById.get(assignment.templateId) ?? 'Unknown plan'}
                </h3>
                <p className="mt-0.5 text-sm text-dim">
                  {riderNameById.get(assignment.riderId) ?? 'Unknown rider'} · starts {assignment.startDate}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onDelete(assignment)}
                disabled={deletingId === assignment.id}
                className="rounded-[8px] border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                {deletingId === assignment.id ? 'Deleting…' : 'Delete plan'}
              </button>
            </div>

            <div className="mt-4 grid grid-cols-7 gap-1.5">
              {Array.from({ length: 7 }, (_, col) => (
                <p key={col} className="pb-1 text-center text-xs text-dim">
                  {WEEKDAY_NAMES[(firstDow + col) % 7]}
                </p>
              ))}
              {days.map(({ dateKey, entry }) => {
                const isToday = dateKey === todayString;
                const cellClass = isToday
                  ? `${DAY_CELL_BASE} border-on/60 bg-on/5`
                  : `${DAY_CELL_BASE} border-line bg-panel`;
                return (
                  <div key={dateKey} className={cellClass}>
                    <p className={`text-xs ${isToday ? 'font-semibold text-on' : 'text-dim'}`}>
                      {dateKey.slice(8)}
                    </p>
                    {entry !== undefined && (
                      <span
                        className="truncate rounded bg-on/15 px-1.5 py-0.5 text-[11px] text-on"
                        title={entry.workoutName}
                      >
                        {entry.workoutName}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
