# Game design: the voyage

openCycle's ride screen is a space voyage flown by your workout. The trainer, the
workout and the FIT file stay the source of truth. The game only reads them.

## Rules

### The workout clock is the mission clock

You arrive at the destination by finishing the workout. Effort changes how the
flight looks and what you discover on arrival. It never changes whether you arrive.

### Legs

Each workout is split into flight legs by `resolveLegs(workout)` in
`packages/shared/src/voyage.ts`. Leg times use the same absolute clock as
`resolveSteps`.

| Source step | Rule | Leg kind |
|---|---|---|
| `free` | always | `free` |
| `interval` | `on` phase | `burn` |
| `interval` | `off` phase | `coast` |
| `steady` | first step and < 76% FTP | `launch` |
| `steady` | last step and < 76% FTP | `approach` |
| `steady` | otherwise, ≥ 88% FTP | `burn` |
| `steady` | otherwise, < 60% FTP | `coast` |
| `steady` | otherwise | `cruise` |
| `ramp` | first step and rising | `launch` |
| `ramp` | last step and falling | `approach` |
| `ramp` | otherwise, rising | `climb` |
| `ramp` | otherwise | `coast` |

- `steady`, `ramp` and `free` steps longer than 600 s split into equal legs; the
  last leg takes the remainder. Split ramp legs interpolate their %FTP.
- Labels: `LAUNCH`, `CRUISE`, `CLIMB`, `BURN n/N`, `COAST`, `APPROACH`, `OPEN SPACE`.
- Objective legs are `cruise`, `climb` and `burn`.

### Surveys

Each objective leg is one survey chance. The server counts, per rider and leg:

- **targeted seconds**: seconds after the first 5 s of the leg (ERG settle time)
  while the step has a numeric target;
- **on-target seconds**: targeted seconds with a live trainer sample, the ERG
  guard inactive, and power within ±10% of the step target.

A leg is **clean** when it has at least 20 targeted seconds and at least 85% of
them are on target. Going over target is never on target. Skipped legs are never
clean. When a leg ends the server emits `legCompleted` with the counts and the
verdict, always before the `stepCompleted`/`workoutCompleted` of the same tick.
The thresholds are constants in `packages/shared/src/voyage.ts`.

### Arrival and the voyage

Finishing the workout reveals the destination system. It has one feature slot
(ring, moons, orbital station) per objective leg; each clean survey lights one
feature, the rest show as faint outlines.

Each rider has a persistent voyage: an ordered list of arrived systems in the
`voyage_systems` table. The next destination is deterministic: seed
`${riderId}:voyage:${index}`, where `index` is the rider's arrived-system count,
and the name is `nameFromSeed(seed)`.

In a multi-rider session everyone flies to the lead rider's destination. The
lead is the first rider with a workout. Every finisher logs that system in their
own voyage with their own survey counts. `GET /api/voyage?riderId=` returns the
systems and the next destination; the Voyage page draws them as a star map.

### Co-op

Multi-rider sessions keep the server's co-op events:

- `bothInZone`: a light tether between the ships and a beacon flare. Beacon
  milestones are stored in `discoveries`.
- `rescue`: a shield around the struggling rider's ship in the helper's
  identity color, also stored in `discoveries`.

### Free rides

A free ride, or a session with no workout, is an open-space cruise: no
destination, no route strip, and the voyage does not advance.

## World

The renderer lives in `apps/web/src/game/world/`, driven by the pure director
in `apps/web/src/game/director.ts`, which turns the store (session snapshot,
telemetry, events) into one frame per animation tick.

- **Sky**: near-black blue base, one restrained nebula band, 7,000 stars and a
  seeded sun. The palette family is seeded by the destination.
- **Destination planet**: procedural bands, land and clouds with an atmosphere
  rim. Its apparent size grows with workout progress, from 1.5% of the viewport
  height at the start to 12% at 80%, then 18% at arrival.
- **Fleet**: one ship per rider (CC0 Quaternius hulls with a custom finish),
  accented in the rider's identity color, flying in formation. Engine plumes
  follow effort; paused ships idle, a guarded ship sputters amber, a stopped
  rider's ship peels away.
- **Travel**: speed streaks, dust and asteroids; asteroid density follows the
  leg kind (densest on burns).
- **Route**: a dashed line from the fleet to the destination.
- **Effects**: a survey probe flies from the ship to the planet on each clean
  leg; co-op tether, beacon flare and rescue shield.
- **Camera**: a chase camera with the fleet in the lower-left third and the
  destination in the upper-middle third. On arrival it pushes in over 6 s and
  holds a slow orbit until the session ends.

## HUD

The HUD is DOM over the canvas, sized with `clamp()` against the viewport width
so it reads from about 3 m on 1080p and 4K screens. Color never carries state
alone; every state also has a glyph or word.

- **Route strip** (top center): the lead rider's legs proportional to duration,
  done legs with survey dots, the current leg with its fill, the objective line
  and `SURVEYS clean/total`. Free rides show `OPEN SPACE` instead.
- **Rider cards** (bottom): effort badge, 3 s power, the workout command with
  time left and the next target, cadence, heart rate, and the leg's on-target
  percentage on objective legs.
- **Destination marker**: a ring and label tracking the planet on screen.
- **Leg toasts**: `BURN 1/4 COMPLETE · SURVEY LOCKED` on a clean leg, otherwise
  the on-target percentage.
- **Arrival card**: system name, surveys per finisher, place in the voyage and
  co-op honors; it collapses to a chip after 20 s.
- **Ride controls** (`c`): pause, bias, skip, stop rider, media, space game on
  or off, stop session. Stops use an inline two-step confirm.

## Degradation ladder

The renderer tracks a 5 s moving average of frame time and steps down one rung
each time it stays above 20 ms. The HUD is unaffected.

| Rung | Change |
|---|---|
| 0 | Full quality: bloom, ACES tone mapping, internal render up to 2560×1440 |
| 1 | Post-processing off (recovers after 10 s under 14 ms, at most 3 times) |
| 2 | Streaks, dust and asteroids halved |
| 3 | Internal render capped at 1920×1080 |
| 4 | Planet noise octaves drop from 7 to 3 |
| 5 | 3D frozen on the last frame |

`window.__ocGameRung`, `window.__ocDrawCalls` and `window.__ocFrameMs` (median
of the last 300 frames) expose the current rung, draw calls and frame time for
performance traces.
