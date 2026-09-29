import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../storage/db.js';
import { ApiError } from './routes.js';
import type { WorkoutLibrary } from './routes.js';

const TemplateDaySchema = z.object({
  dow: z.number().int().min(0).max(6),
  workoutId: z.string().min(1),
});
const TemplateWeekSchema = z
  .object({ days: z.array(TemplateDaySchema).min(1) })
  .superRefine((week, ctx) => {
    const seen = new Set<number>();
    for (const day of week.days) {
      if (seen.has(day.dow)) {
        ctx.addIssue({ code: 'custom', message: `duplicate dow ${day.dow} in week` });
      }
      seen.add(day.dow);
    }
  });
export const TemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  weeks: z.array(TemplateWeekSchema).min(1),
});

export type PlanTemplate = z.infer<typeof TemplateSchema>;

const AssignPlanBodySchema = z.object({
  riderId: z.string().min(1),
  templateId: z.string().min(1),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD')
    .refine(isCalendarDate, 'startDate is not a calendar date'),
});
const AssignmentsQuerySchema = z.object({ riderId: z.string().min(1).optional() });
const IdParamSchema = z.object({ id: z.string().min(1) });

/** Curated plan templates: every data/plans/templates/*.json file parsed at boot. */
export class TemplateLibrary {
  private readonly templates = new Map<string, PlanTemplate>();

  constructor(
    templatesDir: string,
    private readonly log?: (message: string) => void,
  ) {
    let files: string[] = [];
    try {
      files = readdirSync(templatesDir).filter((file) => file.endsWith('.json'));
    } catch {
      this.log?.('No plan templates directory; skipping template load');
      return;
    }
    for (const file of files) {
      try {
        const template = TemplateSchema.parse(JSON.parse(readFileSync(join(templatesDir, file), 'utf8')));
        this.templates.set(template.id, template);
      } catch (err) {
        this.log?.(`Skipping invalid plan template ${file}: ${errorMessage(err)}`);
      }
    }
  }

  list(): PlanTemplate[] {
    return [...this.templates.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): PlanTemplate | undefined {
    return this.templates.get(id);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 'YYYY-MM-DD' that really exists on the calendar (no 2026-02-31). */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Date arithmetic in UTC so results never shift with the server's timezone. */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`invalid date ${date}`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue === undefined ? 'Invalid request' : `${issue.path.join('.')}: ${issue.message}`;
    throw new ApiError(400, detail);
  }
  return parsed.data;
}

export interface CalendarDay {
  date: string;
  workoutId: string;
  workoutName: string;
}

export interface PlanAssignment {
  id: string;
  riderId: string;
  templateId: string;
  startDate: string;
  calendar: CalendarDay[];
}

interface AssignmentRow {
  id: string;
  riderId: string;
  templateId: string;
  startDate: string;
}

export interface PlansDeps {
  db: Db;
  workoutLibrary: WorkoutLibrary;
}

/** One calendar entry per template day: startDate + (week * 7 + dow) days. */
function buildCalendar(template: PlanTemplate, startDate: string, library: WorkoutLibrary): CalendarDay[] {
  const calendar: CalendarDay[] = [];
  template.weeks.forEach((week, weekIndex) => {
    for (const day of week.days) {
      calendar.push({
        date: addDays(startDate, weekIndex * 7 + day.dow),
        workoutId: day.workoutId,
        workoutName: library.get(day.workoutId)?.name ?? day.workoutId,
      });
    }
  });
  return calendar.sort((a, b) => a.date.localeCompare(b.date));
}

/** Training-plan routes: template catalog, assignments, and rendered calendars. */
export function registerPlansRoutes(app: FastifyInstance, deps: PlansDeps): void {
  const templatesDir = fileURLToPath(new URL('../../../../data/plans/templates/', import.meta.url));
  const templateLibrary = new TemplateLibrary(templatesDir);

  app.get('/api/plans', async () => templateLibrary.list());

  app.post('/api/plans/assign', async (req, reply) => {
    const body = parseOr400(AssignPlanBodySchema, req.body);
    const profile = deps.db.prepare('SELECT id FROM profiles WHERE id = ?').get(body.riderId);
    if (profile === undefined) throw new ApiError(404, `Unknown profile ${body.riderId}`);
    if (templateLibrary.get(body.templateId) === undefined) {
      throw new ApiError(404, `Unknown plan template ${body.templateId}`);
    }
    const assignment: PlanAssignment = {
      id: randomUUID(),
      riderId: body.riderId,
      templateId: body.templateId,
      startDate: body.startDate,
      calendar: [],
    };
    deps.db
      .prepare('INSERT INTO plan_assignments (id, rider_id, template_id, start_date) VALUES (?, ?, ?, ?)')
      .run(assignment.id, assignment.riderId, assignment.templateId, assignment.startDate);
    reply.code(201).send(assignment);
  });

  app.get('/api/plans/assignments', async (req) => {
    const { riderId } = parseOr400(AssignmentsQuerySchema, req.query);
    const rows = (riderId === undefined
      ? deps.db
          .prepare(
            'SELECT id, rider_id AS riderId, template_id AS templateId, start_date AS startDate FROM plan_assignments ORDER BY start_date ASC',
          )
          .all()
      : deps.db
          .prepare(
            'SELECT id, rider_id AS riderId, template_id AS templateId, start_date AS startDate FROM plan_assignments WHERE rider_id = ? ORDER BY start_date ASC',
          )
          .all(riderId)) as AssignmentRow[];
    return rows.map((row) => {
      const template = templateLibrary.get(row.templateId);
      return {
        id: row.id,
        riderId: row.riderId,
        templateId: row.templateId,
        startDate: row.startDate,
        calendar: template === undefined ? [] : buildCalendar(template, row.startDate, deps.workoutLibrary),
      };
    });
  });

  app.delete('/api/plans/assignments/:id', async (req, reply) => {
    const { id } = parseOr400(IdParamSchema, req.params);
    const result = deps.db.prepare('DELETE FROM plan_assignments WHERE id = ?').run(id);
    if (result.changes === 0) throw new ApiError(404, `Unknown plan assignment ${id}`);
    reply.code(204).send();
  });
}
