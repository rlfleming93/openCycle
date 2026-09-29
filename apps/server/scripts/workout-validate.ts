import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkoutSchema } from '@opencycle/shared';
import { TemplateSchema } from '../src/api/plansRoutes.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const USAGE = `Usage: pnpm workout:validate [<file-or-dir>]

Validates workout JSON (data/plans/*.json) against WorkoutSchema and plan
templates (data/plans/templates/*.json) against TemplateSchema, then checks
that every template workoutId exists in the workout library. Defaults to the
repo's data/plans directory. Exits 0 when everything is valid, 1 otherwise.`;

/** A JSON file is a plan template when its path contains a 'templates' directory. */
function isTemplateFile(file: string): boolean {
  return dirname(file).split(/[\\/]/).includes('templates');
}

/** Direct *.json files, plus any templates/ subdirectory (when present). */
function collectFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  const stat = statSync(target);
  if (stat.isFile()) return [target];
  const files = readdirSync(target)
    .filter((file) => file.endsWith('.json'))
    .map((file) => join(target, file));
  const nested = join(target, 'templates');
  if (existsSync(nested) && statSync(nested).isDirectory()) {
    files.push(
      ...readdirSync(nested)
        .filter((file) => file.endsWith('.json'))
        .map((file) => join(nested, file)),
    );
  }
  return files;
}

function resolveTarget(arg: string | undefined): string {
  if (arg === undefined) return join(REPO_ROOT, 'data/plans');
  // pnpm --filter exec runs with cwd = apps/server; fall back to the repo root.
  const fromCwd = resolve(process.cwd(), arg);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = resolve(REPO_ROOT, arg);
  if (existsSync(fromRoot)) return fromRoot;
  throw new Error(`Path not found: ${arg} (tried ${fromCwd} and ${fromRoot})`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function main(): void {
  const arg = process.argv[2];
  let target: string;
  try {
    target = resolveTarget(arg);
  } catch (err) {
    console.error(errorMessage(err));
    console.error(USAGE);
    process.exit(1);
  }

  const errors: string[] = [];
  const workouts = new Map<string, string>();
  let workoutCount = 0;
  let templateCount = 0;
  let referenceCount = 0;

  const files = collectFiles(target);

  // Reference checks always run against the shipped library, so a single
  // template file can be validated standalone; target workout files are
  // validated below and supplement the map.
  for (const file of collectFiles(join(REPO_ROOT, 'data/plans')).filter((f) => !isTemplateFile(f))) {
    try {
      const workout = WorkoutSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      workouts.set(workout.id, workout.name);
    } catch {
      // Invalid library files are reported when the library itself is the target.
    }
  }

  for (const file of files) {
    const template = isTemplateFile(file);
    try {
      const parsed = (template ? TemplateSchema : WorkoutSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
      workouts.set(parsed.id, parsed.name);
      if (template) {
        templateCount++;
      } else {
        workoutCount++;
      }
    } catch (err) {
      errors.push(`${file}: ${errorMessage(err)}`);
    }
  }

  // Referential check: every template workoutId must exist in the library.
  for (const file of files.filter(isTemplateFile)) {
    try {
      const template = TemplateSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      for (const week of template.weeks) {
        for (const day of week.days) {
          referenceCount++;
          if (!workouts.has(day.workoutId)) {
            errors.push(`${file}: references unknown workout "${day.workoutId}"`);
          }
        }
      }
    } catch {
      // Schema failures are already reported in the loop above.
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`[error] ${error}`);
    console.error(
      `Validated ${workoutCount} workouts and ${templateCount} templates: ${errors.length} error(s)`,
    );
    process.exit(1);
  }
  console.log(
    `OK: ${workoutCount} workouts and ${templateCount} templates valid (${referenceCount} template workout references checked)`,
  );
  process.exit(0);
}

main();
