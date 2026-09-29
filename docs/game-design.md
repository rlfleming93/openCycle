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

### Pursuits

Every burn leg of the lead rider is a pursuit. A raider warps in ahead of the
fleet about 3 s into the burn. Every riding ship whose rider is in band (live,
no ERG guard, power within ±10% of target) fires at it. A lock ring on the raider
fills with the lead's on-target share for the leg. When the burn ends, a clean
survey takes the raider down; otherwise it escapes to warp. Nobody takes damage,
and the survey rules are unchanged: the raider only shows the verdict the server
already made.

## World

The renderer lives in `apps/web/src/game/world/`, driven by the pure director
in `apps/web/src/game/director.ts`, which turns the store (session snapshot,
telemetry, events) into one frame per animation tick.

- **Sky and anchor**: a near-black deep sky baked per destination into a cube
  map (galactic band with dust lanes, emission and reflection nebulae, a faint
  star field, distant galaxies), plus about 48 bright stars with diffraction
  spikes. Each system has one colossal anchor, seeded by the destination: a
  black hole that lenses the sky (45%), a blue supergiant (30%) or a binary pair
  (25%). The anchor is the only key light.
- **Destination planet**: procedural bands, land and clouds, lit by the anchor
  with a deep night side and an atmosphere rim. Its apparent size grows with
  workout progress, from 1.5% of the viewport height at the start to 12% at
  80%, then 18% at arrival.
- **Fleet**: one ship per rider (CC0 Quaternius hulls with a custom finish),
  accented in the rider's identity color. Ships fly with mass and flight assist:
  they bank to turn, weave by leg kind (widest on burns), overtake each other on
  burns and barrel-roll on a clean survey, with RCS puffs on every maneuver.
  Engine color follows throttle (idle orange-red, cruise blue-white, white-hot
  with shock diamonds in band on a burn); each burn starts with a boost and ion
  contrails. Paused ships idle, a guarded ship sputters amber, a stopped rider's
  ship peels away.
- **Frame Shift Drive**: the session opens with a charge, a hyperspace tunnel
  and an exit flash that reveals the system; arrival is a drop from supercruise.
  Cruise, climb and coast legs fly in supercruise with faint edge distortion.
- **Pursuit**: the raider jinks, rolls and drops chaff under lock; in-band ships
  fire paired pulse bolts in their identity color plus yellow tracers. A kill is
  a fireball, shock ring and glowing debris; an escape is a warp-out.
- **Travel**: everything streams past along the travel direction: speed
  streaks, dust, glinting debris and ice shards, rocks at three depths, hero
  rocks that tumble past just outside a clear corridor around the fleet's and
  the raider's sightlines, wreckage and now and then a derelict hull section.
  Density follows the leg kind (burn dense with a dust haze, climb medium,
  cruise sparse, coast open space) and sweeps in from far ahead. Hero rocks,
  wreckage and the derelict never cover a HUD zone, the destination (disc plus
  5% of the frame height) or the anchor's core: they fly headings that leave
  the frame through the clear gaps and shrink away wherever they would still
  overlap one. They stay out while the system is hidden and for 3 s after the
  reveal, then return from far ahead.
- **Passing bodies**: gas giants (some ringed), rocky and ice moons and the odd
  station drift past beyond the destination, seeded per system, under the same
  keep-clear rules; once per ride a big moon's limb slides by just below the
  fleet. They also hold off for 3 s after the reveal.
- **Route**: a dashed line from the fleet to the destination.
- **Effects**: a survey probe flies from the ship to the planet on each clean
  cruise or climb leg; co-op tether, beacon flare and rescue shield.
- **Camera**: an external chase camera that lags the ship's orientation, so
  maneuvers read in frame. It cuts only at leg boundaries between the chase, a
  low side track and a high wide shot; burns and arrival always use the chase.
  On arrival it settles into a slow orbit until the session ends.

## HUD

The HUD is DOM over the canvas, sized with `clamp()` against the viewport width
so it reads from about 3 m on 1080p and 4K screens. The sidebar measures its
band in viewport height instead, because the world keeps that band clear.
Color never carries state alone; every state also has a glyph or word.

- **Route strip** (top center): the route header (`LEG n · BOUND FOR X`,
  `ARRIVAL IN`), the objective line with the burn lock meter, and
  `SURVEYS clean/total`. Free rides show `OPEN SPACE` instead.
- **Workout sidebar** (left band, x < 20%): the lead rider's workout — name,
  workout clock and time left, the whole workout as a mini profile with a
  playhead over dimmed done time, then the step list scrolling so the current
  step sits near the top. Each step shows its kind, duration and target (watts
  for one rider, `%FTP` for two or more); the current step carries a fill bar,
  its countdown and the live on-target share; done steps dim and carry a ✓
  (clean survey) or · (not clean) marker. Hidden on free rides, and the flat
  dashboard is unchanged.
- **Rider cards** (bottom): effort badge, 3 s power, the workout command with
  time left and the next target, cadence, heart rate, and the leg's on-target
  percentage on objective legs.
- **Destination marker**: a ring and label tracking the planet on screen.
- **Leg toasts**: `BURN 1/4 COMPLETE · RAIDER DOWN · SURVEY LOCKED` on a clean
  burn, `RAIDER ESCAPED · {pct}% ON TARGET` otherwise; other legs show `SURVEY
  LOCKED` or the on-target percentage. On a burn the objective line adds
  `LOCK {pct}%`.
- **Arrival card**: system name, surveys per finisher, place in the voyage and
  co-op honors; it collapses to a chip after 20 s.
- **Ride controls** (`c`): pause, bias, skip, stop rider, media, space game on
  or off, stop session. Stops use an inline two-step confirm.

## Degradation ladder

The renderer tracks a 5 s moving average of frame time and steps down one rung
each time it stays above 20 ms. Each frame counts for at most 40 ms, so a lone
stall (a GC pause, a tab hiccup) never costs a rung; only sustained slow frames
do. The HUD is unaffected.

| Rung | Change |
|---|---|
| 0 | Full quality: bloom, anamorphic streak, grain, AgX tone mapping, internal render up to 2560×1440 |
| 1 | Lens off, tone mapping only (recovers after 10 s under 14 ms, at most 3 times) |
| 2 | Cheaper anchor and half the bright stars; every streaming class halved, no dust haze |
| 3 | Internal render capped at 1920×1080 |
| 4 | Planet noise octaves drop from 7 to 3 |
| 5 | 3D frozen on the last frame |

`window.__ocGameRung`, `window.__ocDrawCalls` and `window.__ocFrameMs` (median
of the last 300 frames) expose the current rung, draw calls and frame time for
performance traces.
