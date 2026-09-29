---
name: workout-author
description: Author and validate openCycle workout + plan JSON. Use when creating, editing, or validating workout files in data/plans/*.json or plan templates in data/plans/templates/*.json, or when asked to design a training session or plan for openCycle.
---

# Workout Author

Author curated workouts and multi-week plan templates for the openCycle training library, then gate them with the repo validator.

## Files

- **Workouts**: `data/plans/*.json` — one workout per file, filename matching the `id` (e.g. `tempo-2x20.json`).
- **Plan templates**: `data/plans/templates/*.json` — one template per file, filename matching the `id`.
- Both are loaded by the server at boot; invalid files are skipped with a warning, so always run the validator after editing.

## Validation gate (required)

Run before finishing any change to these files:

```bash
pnpm workout:validate <file-or-dir>   # e.g. pnpm workout:validate data/plans
```

Accepts a single file or a directory (defaults to `data/plans`). Parses workouts against WorkoutSchema, templates against TemplateSchema, and checks that every template `workoutId` exists in the workout library. Exits 0 only when everything is valid; exits 1 with a per-file error list otherwise.

## Workout schema

```jsonc
{
  "id": "tempo-2x20",            // kebab-case, unique across the library
  "name": "Tempo 2x20",          // human-readable
  "description": "…",            // cite the training principle (see below)
  "tags": ["tempo"],             // kebab-case topic tags
  "steps": [ … ]
}
```

All targets are **fractions of FTP** (0.0–5.0), never watts — the engine multiplies by the rider's profile FTP at ride time.

| kind | fields | meaning |
|---|---|---|
| `steady` | `seconds`, `targetPctFtp` | hold a fixed % FTP |
| `ramp` | `seconds`, `fromPctFtp`, `toPctFtp` | linear ramp between two % FTP (flattened to 15 s sub-steps) |
| `interval` | `repeats`, `on: {seconds, targetPctFtp}`, `off: {seconds, targetPctFtp}` | repeated on/off blocks |
| `free` | `seconds` | no ERG target (null); rider self-paces |

Worked example (steady with warmup/cooldown ramps):

```json
{
  "id": "endurance-z2-60",
  "name": "Endurance Z2 60 min",
  "description": "Zone 2 endurance ride at 65% FTP — aerobic base stimulus (Coggan level 2).",
  "tags": ["endurance", "zone-2"],
  "steps": [
    { "kind": "ramp", "seconds": 300, "fromPctFtp": 0.5, "toPctFtp": 0.65 },
    { "kind": "steady", "seconds": 3000, "targetPctFtp": 0.65 },
    { "kind": "ramp", "seconds": 300, "fromPctFtp": 0.65, "toPctFtp": 0.4 }
  ]
}
```

## Zone conventions

Percentages are fractions of FTP (Coggan-style bands; describe them without trademarked metric names — never TSS, IF, NP, CTL, ATL):

| band | % FTP | typical use |
|---|---|---|
| 1 Recovery | 0.35–0.55 | recovery spins |
| 2 Endurance | 0.65–0.75 | base miles |
| 3 Tempo | 0.76–0.87 | muscular endurance |
| 4 Threshold / sweet spot | 0.88–1.00 | FTP work |
| 5 VO2max | 1.05–1.20 | maximal aerobic power |
| 6 Anaerobic | 1.20–1.50 | short repeats |

Every `description` must cite the training principle it encodes (e.g. "classic 2x20 threshold (Coggan level 4)", "Norwegian 4x4", "ramp-test protocol"), so riders see why the session exists.

## Plan template schema

```jsonc
{
  "id": "base-build-8w",        // kebab-case, unique
  "name": "8-Week Base Builder",
  "description": "…",
  "weeks": [
    {
      "days": [
        { "dow": 0, "workoutId": "endurance-z2-60" }  // day 0 = plan start day
      ]
    }
  ]
}
```

- `dow` is 0–6 with **day 0 = the plan start day**; a Monday start makes day 0
  Monday. The calendar anchors to the assignment's `startDate`, not to the
  calendar week — a template started on a Wednesday rides Wednesdays.
- Each week's `dow` values must be unique within that week.
- Every `workoutId` must exist in the workout library — the validator enforces this.
- The assignment calendar renders as `startDate + (week * 7 + dow)` days.

## Style rules

- One principle per workout; keep steps few and readable (warmup → work → cooldown).
- Fraction targets in the ranges above; avoid odd values like 0.83 — use round band values (0.65, 0.70, 0.80, 0.90, 0.97, 1.15…).
- Repeats and recoveries: VO2max ~1:1–1:2 work:rest, anaerobic ~1:3, threshold 5–10 min recovery.
- Progression across a template: ramp weekly volume roughly 5%, and insert a recovery week (fewer/lighter rides) every 3–4 weeks.
