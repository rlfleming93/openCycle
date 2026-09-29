# openCycle

openCycle is an open-source indoor cycling app. It controls Wahoo KICKR trainers over Bluetooth in ERG mode, runs several riders on one machine, records every ride as a standard FIT file, builds training plans, and syncs with Garmin Connect. While you ride, your workout flies a small fleet of ships across space.

Site: https://opencycle.pages.dev

![A ride in progress: the fleet flies toward the destination planet, with the route strip at the top and the rider card at the bottom](docs/media/ride.webp)

## The voyage

Every workout is a flight to a new star system.

- **The workout clock is the mission clock.** You arrive by finishing the workout. How hard you push changes what you find there, never whether you get there.
- **Legs.** The workout is split into legs: launch, cruise, climb, burn, coast and approach. Interval efforts become burns. The route strip at the top of the screen shows every leg and how long is left in the current one.
- **Surveys.** Each cruise, climb and burn leg is a survey. Hold within 10% of the target for at least 85% of the leg and the survey locks: a probe launches toward the planet, and on arrival that survey lights up a ring, moon or station in the new system. Going over target doesn't count.
- **Your voyage.** Each rider keeps a star map of every system they've reached, with their surveys. The next destination is always known in advance, so the Voyage page can show where your planned workouts will take you.
- **Riding together.** With two or more riders, everyone flies to the lead rider's destination in formation. When everyone holds their zone together, a tether links the ships. When one rider's cadence drops out and another pushes 10% over their own target for 15 seconds to cover, a shield goes up around the struggling ship in the helper's color.
- **Free rides** cruise open space with no destination.

The trainer, the targets and the FIT file are the source of truth. The game only reads them.

![Arrival at a surveyed system](docs/media/arrival.webp)

![The Voyage page star map](docs/media/voyage.webp)

## Hardware

- **Trainers:** tested with the Wahoo KICKR CORE using Bluetooth FTMS ERG control. Other FTMS trainers may work but are untested.
- **Heart rate:** any Bluetooth heart rate strap that uses the standard Heart Rate Service.
- **Computer:** developed and run on macOS. The server needs Node 24 (the Bluetooth stack is a native addon and does not run on Bun).

## Quick start with the simulator

You don't need a trainer to try it. The simulator adds fake trainers and heart rate straps.

```bash
pnpm install
OPENCYCLE_SIM=2x2 OPENCYCLE_DATA_DIR=/tmp/opencycle-demo pnpm dev
```

Open http://localhost:5173, create a profile, then start a session from the session builder. `2x2` means two simulated trainers and two heart rate straps. `OPENCYCLE_DATA_DIR` keeps the demo's database and FIT files out of your real data folder (`~/.opencycle` by default).

Other commands:

```bash
pnpm dev:server  # server only (:4000)
pnpm check       # type-check every package
pnpm test        # run the test suite
```

Requirements: Node 24 and pnpm 10.26 or later (the repo pins pnpm through `packageManager`). Workspace packages export TypeScript source directly, so run the server with `pnpm dev:server`, not plain `node`.

## Real Bluetooth on macOS

Set `OPENCYCLE_BLE=1` to scan for real devices.

macOS denies Bluetooth to SSH and headless processes (`noble` reports `unauthorized`), and the Privacy & Security pane won't register SIP-protected binaries like `sshd-session`. The fix that works is an app-bundle identity: wrap `scripts/rig-app-launch.sh` in a minimal `~/Applications/openCycle.app` (an Info.plist with `NSBluetoothAlwaysUsageDescription`, ad-hoc codesigned). Launch it with `open -n ~/Applications/openCycle.app`. macOS asks once on screen and the permission sticks to the bundle. The default launch runs `pnpm dev:server` with `OPENCYCLE_BLE=1`. To run something else once, put the command in `/tmp/opencycle-app-cmd`. Output goes to `/tmp/opencycle-app.log`.

## Network and security

The server listens on all interfaces (`0.0.0.0:4000`) so a TV or tablet on your home network can show the ride. Set `OPENCYCLE_HOST=127.0.0.1` to keep it on this machine only.

> **There is no login.** Anyone who can reach the server can start sessions, change profiles and read ride data. Run it on a home network you trust. Never expose it to the internet.

## Layout

- `packages/shared`: zod schemas and types, FTMS/HRS constants, physics, the training load model and the voyage rules
- `apps/server`: Node 24 server with Bluetooth, the session engine, ERG control, the FIT recorder, the REST and WebSocket API, Garmin sync and training plans
- `apps/web`: Vite, React and three.js client
- `assets/ships`: the Blender pipeline that finishes the ship models
- `data/plans`: curated workouts and plan templates
- `skills/workout-author`: a Claude skill for writing workouts and plans
- `docs`: the game design and the Bluetooth protocol notes

## Workout authoring

Curated workouts live as JSON in `data/plans/*.json` and multi-week plan templates in `data/plans/templates/*.json` (see the schemas and zone conventions in `skills/workout-author/SKILL.md`). Validate any file or the whole directory with:

```bash
pnpm workout:validate data/plans
```

The script parses every workout against the shared WorkoutSchema, every template against TemplateSchema, and checks that all template `workoutId`s exist in the library. Exit 0 means the server will load them at boot.

The authoring skill ships in the repo. Symlink it into your personal skills so Claude Code picks it up:

```bash
ln -s "$(pwd)/skills/workout-author" ~/.claude/skills/workout-author
```

## Garmin sync

Two paths move rides between openCycle and Garmin Connect:

- **Import history.** Drop a Garmin account-export ZIP or loose `.fit` files
  into the import folder (`<dataDir>/import/`, default
  `~/.opencycle/import/`). Files in a per-rider subfolder (`import/<riderId>/`)
  import under that rider (the folder name must be an existing profile id);
  files at the top level stay unassigned until you assign them in History.
  A file that imported at least one activity moves to `import/done/` (with a
  `.err.txt` beside it when some members failed); a file that imported nothing
  moves to `import/failed/`. You can also upload a ZIP from the UI or via
  `POST /api/garmin/import-zip?riderId=<id>`. Imports are rejected (409) while
  a session is active. `POST /api/garmin/pull/:riderId` pulls the last 30 days
  of the rider's Garmin activities in the background. When re-importing an
  export ZIP you already imported, select the rider in the import UI so the
  rider-scoped dedupe skips the existing rides (re-importing unassigned
  duplicates them).
- **Upload rides.** Finished rides upload to Garmin Connect automatically
  when the rider's profile has Garmin autoUpload on **and** a saved login
  exists. Retries are manual: a failed upload marks the ride `failed` in
  History with the reason and shows a retry button. Garmin changes their web
  flows without notice; when they do, uploads fail and rides stay marked
  `failed` until this module is rebuilt. It is deliberately isolated so
  nothing else depends on its internals.

One-time login per rider (stores Playwright storage state on disk, never in
the database, and no passwords in profiles):

```bash
pnpm garmin:login --rider <profile-id>
```

A browser window opens; complete sign-in and MFA by hand. The state file
lands at `<dataDir>/garmin/<riderId>.json`; running it again overwrites it.

## Credits

- Ship base meshes: [Ultimate Spaceships Pack](https://quaternius.com/packs/ultimatespaceships.html) by Quaternius (CC0), re-finished for openCycle.
- Fonts: Barlow Condensed and Inter (SIL Open Font License), self-hosted through Fontsource.

## License

MIT. See [LICENSE](LICENSE).
