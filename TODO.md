# TODO

Tasks from [docs/roadmap.md](docs/roadmap.md) (decision 228), which is the source of truth for what to build next. R1 and R2 are broken into tasks of a few hours each; later phases are milestone entries until they start, when they get the same breakdown. Check tasks off as they are completed and add subtasks as you discover them. Visual milestones close only after the acceptance checks in [docs/visual-style.md](docs/visual-style.md) for the views they touch (the roadmap lists which milestones are visual).

The state at the start of R1 is in [docs/status/audit-2026-11-18.md](docs/status/audit-2026-11-18.md). Every open item of the earlier tracks (F, S, C, V, I, P, H, N, G, W), with its notes, is kept in [docs/status/todo-2026-11-18.md](docs/status/todo-2026-11-18.md); the roadmap's "Where the Old Milestones Went" says where each went.

## R0. Audit and reconcile (done)

- [x] Proposal 0008 saved as accepted
- [x] Status matrix, health, divergences and decisions for the owner (`docs/status/audit-2026-11-18.md`)
- [x] `docs/roadmap.md`; `design.md`, proposals, plans, `CLAUDE.md`, `README.md` and this file reconciled (decisions 228–231)
- [x] Owner's answers to the audit's decisions (decision 232)

## R1. Consolidation

### R1.1 Health and baselines

- [x] Find the cube-face seam in `tests/gpu/tileSynth.test.ts` (0.10 m against 0.05 m on lavapipe): fix the kernel, or re-baseline with a decision. Fixed in the kernel: edge samples agree bit for bit (decision 233)
- [x] Front generator determinism: run `tests/campaign.test.ts` and `tests/infrastructure.test.ts` 50 times under parallel load on Node 22 and 24; if a divergence recurs, quantize the band cut's axis coordinate (decision 86). Reproduced on Node 24 only (2 of 50 runs; 9 of 200 fresh processes): a V8 on-stack-replacement fault in `lineFromPath`'s side sums, worked around with `lineSides` (decision 234); quantizing would not have helped
- [ ] Watch the CI `determinism` job for a few weeks after decision 234; remove it once clean
- [x] GPU determinism flake (`detailStage`, `tileSynth`): run the GPU suite ten times with and without `--no-file-parallelism` on lavapipe and on the owner's GPU; record the rate. Lavapipe, 2026-11-19: 0 failures in 5 runs with file parallelism (85–140 s) and 5 without (144–153 s), 98 tests each
- [ ] Owner: the same ten runs on the owner's GPU, where the flake was seen (about 1 run in 5–10)
- [x] Pin the demo seeds 4, 10 and 7: a test that each keeps a continental front and passes validity on the current `GENERATOR_VERSION` (`DEMO_SEEDS` in `src/campaign/demoSeeds.ts`, `tests/demoSeeds.test.ts`: valid, a continental front with fit ≥ 0.9, and a reminder to re-check on a version bump)
- [ ] Strategic map frame rate (10–15 fps): profile labels, the zone list and glyph rebuilds; fix the hot path
- [ ] Frame-rate decay over a session: check tile and mesh caches, undisposed geometries and textures, label rebuilds; a soak test that counts GPU objects after 20 view switches
- [x] GPU timing tool: timestamp queries per pass in the app behind `?dev`, logged per view (`?dev&gputime=1`, `GPU_TIMING=1` in the smoke test; decision 242)
- [ ] Owner: run `tools/browser.smoke.mjs` with `MODE=gpu` and the timing tool on the owner's machine; record the standard views in the audit's performance baseline (`MODE=gpu GPU_TIMING=1 node tools/browser.smoke.mjs`)
- [ ] The lavapipe smoke test loses its device about 160 s into Free Flight's start screen in cloud containers, also at `0c81707` (decision 242); find out whether it is memory or the shim
- [ ] Rerun the whole-world alignment on a desktop after the tile-cache fix; record time, forced pieces, viaduct and tunnel totals
- [x] Remove `networkLink`'s timeout under load (raise the budget or split the test): the eviction test reuses one aligned link instead of aligning forty (9.4 s → 0.2 s)

### R1.2 Campaign state that can be saved

- [x] Inventory every piece of sim state (queue, clock, `AirOps`, tasker maps, weather systems and caches, carrier groups) with its owner and type (decision 235's table)
- [x] RNG: export and restore the xoshiro state, or move every draw to a fork keyed by game time; test (every draw was already a keyed fork; the round-trip test covers it)
- [x] `save()`/`load()` for the event queue and clock (events are data already)
- [x] `save()`/`load()` for `AirOps` and the interim tasker
- [x] `save()`/`load()` for the weather model (systems, not the frame cache)
- [x] Snapshot message in the worker protocol; a state hash for comparisons (`saveState`/`state`/`loadState`)
- [x] Round-trip test: run 6 h, snapshot, restore, run 6 h more, compare with 12 h uninterrupted, at 1× and 64×
- [x] Event log skeleton: typed, timestamped events for player inputs to the campaign and campaign-level decisions; stored with the snapshot (`src/sim/eventLog.ts`)
- [x] `SimHost.seek` through snapshot plus log; test that scheduled alarms survive a backward seek (checkpoints every 6 game hours)

### R1.3 A headless day of war

- [x] `tools/war.preview.ts`: build a pinned seed's campaign world, run the sim for 24 game hours as fast as possible, report errors, worker step cost per game hour, missions flown and the state hash (decision 236)
- [x] Measure the worker's cost at 64× on the three seeds with the interim tasker; record it in the audit (7–12 ms per game hour, 0.02% of real time)
- [x] Replace or supplement `tests/air.test.ts`'s synthetic world with a small generated world (fast parameters): `tests/war.test.ts`, with the world's own climate

### R1.4 Mission search shell and side selection

- [x] Side selection at campaign start, with the generated briefing; the debug viewing side becomes the chosen side (decision 241)
- [x] Jump-in windows as data on each mission's phases (fixed-wing: climb-out to approach; decision 231); helicopters over their ground phases (decision 149)
- [x] Mission search panel: list of ongoing and upcoming missions of the player's side, sorted by time until action (M)
- [x] Filters: mission type, aircraft, theater, current phase, threat level, time until action (threat interim per mission type until R3)
- [x] Focus the strategic camera on a selected mission and draw its route
- [x] Subscriptions: a saved query plus a phase; phase events flagged for auto-slowdown; an offer to follow at 1× (the offer shows the mission; following is R2.4)
- [x] Tests: filter logic on display models; a subscription drops 64× to 1× at its phase
- [ ] Owner: find the next CAS mission over the front; subscribe to strikes on own airbases
- [ ] Subscriptions to the enemy's missions ("strikes on our airbases"): a target-side and target-kind query on what the side knows; needs the intelligence picture (R3), since the side cannot see enemy missions yet (decision 241)

### R1.5 The flown aircraft leaves Free Flight

- [x] Map `freeflight/freeFlight.ts`'s responsibilities (session flow, input, airframe, director, sensors, traffic, HUD frame, displays) and draw the split (decision 243)
- [x] `FlownAircraft` in `src/sim/flight/`: airframe, control laws, director target, input source (player or AI), fuel and configuration; no DOM or render imports (the director target lives in the pilot hook)
- [x] Move `AvionicsState` from `ui/displays/system.ts` into per-aircraft sim state; the display system reads it
- [x] Build the aircraft snapshot outside `freeflight/` from `FlownAircraft` and sensors (`ui/displays/aircraftSnapshot.ts`, `ui/flight/hudFrame.ts`)
- [x] One flown-aircraft abstraction for both kinds (replaces Free Flight's `model`/`helo` branching): the stepping; the HUD and camera still branch by kind
- [ ] The HUD frame and the chase camera from `FlownAircraft` instead of `model`/`helo` (with R2.4's followed aircraft)
- [x] One clock: Free Flight's `clock.ts` and the campaign clock share stepping rules (120 Hz, substeps, rates): `src/sim/clock.ts`
- [x] Free Flight on `FlownAircraft`; `tests/flightLockstep.test.ts` passes unchanged; `tools/freeflight.session.mjs` passes (but for the known drizzle check)
- [x] Test: a `FlownAircraft` created from a position, velocity and fuel holds the scripted pilot's route

### R1.6 Terrain for the execution layer

- [x] Move `TerrainEdits` assembly from `render/sim/infra/airfieldGrading.ts` into `worldgen/edits/` (pads from the light record's data, corridors from the alignments): `terrainEditsFor`, from the sited airbases (decision 240)
- [x] A height service from the global grid plus edits that runs in the worker; test against the main thread's function at sample points (bit for bit)
- [x] AI sensing and line of sight read the height service, not resident tiles (decision 227's sensors keep tiles for the ground map and elevation map only)
- [x] Analytic low-level routes: a terrain floor along each leg from the coarse heights, with clearance by mission type; test that no route on the pinned seeds passes below terrain (clearance by airframe: 100 m jets, 30 m helicopters)
- [x] Sited runways for full fidelity and the simulation view: the sim carries the sited runway as presentation data beside the coarse point (`world.terrain.fields`)
- [ ] R2.5: check a flight handed to full fidelity anywhere on its route is above the drawn ground (the floor is checked against the coarse ground only; decision 240)

### R1.7 Aircraft bundles and roster data

- [x] Bundle schema: the model spec gains `avionics`, `airWar` (role tags, performance, crew roles, faction, name, skin), `pylons`, `rig` and `calibration` blocks; geometry optional; validation (decision 238)
- [x] One bundle loader usable by the sim worker (no render imports) and the renderer (`src/sim/air/bundles.ts`; bundles in `src/data/models/aircraft/`)
- [x] Move the 31 avionics profiles from `typeProfiles.ts` into the bundles; `tests/typeProfiles.test.ts` passes on the loaded data
- [x] Move the air-war table from `sim/air/aircraft.ts` into the bundles; the air war's determinism hash is unchanged
- [x] Camera rigs into the bundles (`FAST_JET_RIG`, `helicopterRig` become per-type data)
- [x] Bundle test: list what each type lacks; fail on duplicate or inconsistent ids
- [x] Rename the UH-68 "Buzzard" helicopter (clash with the A-15 Buzzard): the UH-68 Heron (decision 239)
- [x] Utility helicopter role: a Black Hawk analogue and an Mi-8 analogue in `sim/air/aircraft.ts` with avionics profiles; a decision for the change to every world's cast (UH-68 Heron, Ve-18 Shmel; decision 239)
- [x] Pilots per squadron in the order of battle (count, names from a fork); the hash change recorded (decision 239)

### R1.8 Network data for the sim

- [x] Road and rail networks as a node and edge graph in the campaign input: junctions as nodes, polylines as edges with class and length (decision 237)
- [x] Bridges as edges that can be cut: split polylines at bridges in the graph object (not in the stored polylines)
- [x] A damage state for target sites and bridges in the sim, saved with R1.2's snapshot
- [x] Detour test: cut a bridge, compare the graph's detour with the bridge's recorded detour (15 of 15 equal)
- [x] Bridge aim points on the main thread: matched crossing, or the nearest point of the aligned road where none matches (owner decision 7); `bridgeAimPoints`, used from R2.6

## R2. One day of war (tech demo)

### R2.1 Mission plug-ins and the air tasking order

- [ ] `MissionType` plug-in interface with the eight parts; registry and a completeness test
- [ ] Need collection from the front: segments under pressure, supply lines behind it
- [ ] Need collection from bases and high-value assets: CAP stations, airlift between bases
- [ ] Priority score with stable tie-breaking; per-side, per-day forks
- [ ] Package builder: flights from squadrons in range, escorts for strikes
- [ ] Doctrine scheduler: Pact waves, Alliance spread; one order per game day, revisions every two to four hours
- [ ] Weather and daylight minimums; winds aloft in ground speed
- [ ] CAP plug-in
- [ ] Interdiction plug-in (fixed targets: bridges, depots, rail yards, road segments)
- [ ] CAS plug-in (fixed-wing)
- [ ] Airlift plug-in
- [ ] Briefing templates with named places for the four types
- [ ] Retire the interim tasker
- [ ] Determinism tests: the same orders at 1× and 64×, independent of the viewing side

### R2.2 Resolution and consequences

- [ ] Hook from mission phase events to resolvers; keep event ids so aborts can cancel later phases
- [ ] Air-to-air resolver: packages against CAP and escorts by type, numbers and calibration tables
- [ ] Point defenses at targets: an abstract air defense value per site
- [ ] Strike resolver: damage to targets and bridges
- [ ] Airlift resolver: deliveries into base stocks
- [ ] Losses lower squadron strength; ejections create survivors (R2.9's records)
- [ ] Aborts and returns; turnaround with fewer aircraft
- [ ] Revisions read the outcomes: damaged targets, lost squadrons, stocks
- [ ] 24 h test on the three seeds: losses on both sides, damaged targets and bridges, delivered airlift

### R2.3 The ground war in aggregate

- [ ] Order of battle: divisions, brigades or regiments, battalions with per-unit seeds
- [ ] Deployment along the start line by corridor and terrain
- [ ] Lanchester attrition per game minute with terrain, posture and supply
- [ ] Air support: CAS reduces strength; interdiction cuts supply
- [ ] Supply over the road graph; cut bridges force detours
- [ ] Front segments move by local force balance, slowed by barriers
- [ ] Offensives along the invasion corridors by cast posture
- [ ] CAS and interdiction needs from the ground state (feeds R2.1)
- [ ] The moving front on the strategic map; battalion symbols (NATO style)
- [ ] Comparison tool: one side's air support suppressed; report the front's difference
- [ ] Benchmark: battalions plus weather plus air war in the worker at 64× and 256×

### R2.4 Follow

- [ ] Campaign aircraft in the simulation view: instanced models, a level of detail for packages, shadows near the camera
- [ ] *Follow* from mission search and from a subscription offer: a cut and a chase-camera settle
- [ ] Return to the map above the flight's position
- [ ] Read-only HUD for the followed aircraft from its analytic state
- [ ] Spectator displays: the followed aircraft's own picture, read-only
- [ ] Per-type camera rigs from the bundles, including a transport rig
- [ ] Retire the debug free camera behind `?dev` only
- [ ] Acceptance checks 7 and 10 as scripted sequences
- [ ] Owner: follow a mission of each demo type and return

### R2.5 Full fidelity and handover

- [ ] Promotion: analytic state → `FlownAircraft` (position, attitude, speed, fuel, configuration, stores, damage)
- [ ] Demotion: `FlownAircraft` → analytic route from the current position; losses and stores preserved
- [ ] AI pilot on the director: route following and waypoints
- [ ] AI pilot: formation keeping
- [ ] AI pilot: orbit and CAP station
- [ ] AI pilot: attack run and egress
- [ ] Take over inside the jump-in window; hand back with the AI's orders
- [ ] Flight cap: up to 8× in cruise while flying, cancelled on any threat
- [ ] Session consequences as logged campaign events at handback
- [ ] Test: take over and hand back at every phase of a CAP mission; the mission completes

### R2.6 Weapons, damage and interface defaults

- [ ] Pylons and loadouts in the bundles for the demo types
- [ ] Stores on pylons that disappear on release; jettison
- [ ] Stores format and master arm; weapon selection triggers air-to-air and air-to-ground modes
- [ ] Gun with a lead-computing pipper
- [ ] IR missile with a seeker circle and simple guidance, one per side
- [ ] Unguided bombs with CCIP fall lines; rockets
- [ ] Hit and kill resolution; minimal damage states; ejection from full fidelity
- [ ] Sensors read campaign contacts: aggregate flights as radar targets, sites with radars as emitters
- [ ] Interface defaults per mission type and phase: master mode, formats, HUD cues, declutter
- [ ] Route and waypoints on the moving map; HUD steering to the next waypoint; the front on the map
- [ ] Direct control in cursor mode: an attitude and altitude hold as an assist (design §Cursor mode)
- [ ] LOW FUEL in the status strip
- [ ] Acceptance check 8 with the pipper
- [ ] Owner: a CAP kill and a bridge hit, both visible in the campaign state

### R2.7 The demo roster

- [ ] Vo-31 (MiG-29 analogue): flight data and control laws; performance against the air-war table
- [ ] Vo-35 (Su-25 analogue): flight data and control laws
- [ ] A-15 (A-10 analogue): model spec, flight data, laws (if time allows; owner decision 5)
- [ ] C-150 (C-130 analogue): model spec, flight data, laws, transport rig (if time allows)
- [ ] AI-only models: F-25, E-5, KC-40, Vo-37, Ra-44, Ra-60, Ve-28 and the two utility helicopters
- [ ] Pact skin in a flown Vo-31 and Vo-35
- [ ] Silhouette check (Part I check 6) for every new model; checks 12–13 for an attack aircraft

### R2.8 Minimal entity promotion

- [ ] Vehicle model specs: tank, infantry fighting vehicle, truck, short-range air defense vehicle
- [ ] Promotion: a battalion near the player spawns representative vehicles from its seed and strength, on the ground or aligned roads
- [ ] Vehicles as targets for guns, rockets and bombs
- [ ] Demotion folds losses back into the battalion's strength; nothing destroyed comes back
- [ ] Test: CAS destroys promoted vehicles and the battalion's strength drops by the same count

### R2.9 Survivors and CSAR

- [ ] Survivor records: position, injury, survival timer, capture risk near enemy forces
- [ ] CSAR plug-in: planner rule (always), package (rescue helicopter, escort, cover), aggregate resolver, outcomes
- [ ] Rescued pilots return to their squadron's pool; the pool limits sorties
- [ ] Rotary director: a target layer on `HeloLaws` (attitude, ground velocity, height, hover point, heading) without changing the player's feel
- [ ] AI helicopter pilot: route, approach, landing at a point clear of trees and slopes
- [ ] Surface-layer wind for rotorcraft in place of the 8 m/s cap
- [ ] Tests: the director and recorded inputs fly the same result; a landing at a survivor in a 10 m/s crosswind
- [ ] Test: every ejection in a 24 h run has a survivor and a CSAR mission

### R2.10 Calibration

- [ ] Headless engagement runner on `FlownAircraft`: pairs and fours at set ranges and altitudes
- [ ] Matchups: Vo-31 against Kestrel; CAS against a short-range air defense vehicle; strike against point defenses
- [ ] Fit the aggregate tables; store them in the repository with the script that regenerates them
- [ ] Tolerance test: aggregate and full-fidelity outcome rates agree

### R2.11 Event log and replay

- [ ] Log every player input to the campaign, every campaign decision and every fidelity session's consequences
- [ ] Replay from a snapshot; test that the final state hash matches
- [ ] Export and import a log as a file

### R2.12 Demo verification

- [ ] Three seeds × 24 h at 64× unattended, without errors
- [ ] The suppressed-air comparison on each seed
- [ ] Take over and hand back in each flyable aircraft
- [ ] Frame budgets on a real GPU during a full-fidelity mission with the war running
- [ ] Acceptance checks 7–10 and 12–14 for the demo types; Part II checks for the moving front and unit symbols
- [ ] Report in `docs/reports/`; owner checkpoint

## R3. Combat depth

- [ ] R3.1 Intelligence (large)
- [ ] R3.2 Sensors and displays in full (large)
- [ ] R3.3 Weapons in full (large)
- [ ] R3.4 Air combat (medium)
- [ ] R3.5 Air defense networks and scrambles (large)
- [ ] R3.6 Ground entities and terrain in the sim (large)

## R4. Breadth

- [ ] R4.1 Roster (large)
- [ ] R4.2 Mission catalog (large)
- [ ] R4.3 Helicopter track (large)
- [ ] R4.4 Transport operations (medium)
- [ ] R4.5 Crews (large)
- [ ] R4.6 Naval war (large)
- [ ] R4.7 Power lines (small)

## R5. Dynamic campaign

- [ ] R5.1 Logistics (large)
- [ ] R5.2 Morale and reputation (medium)
- [ ] R5.3 Weeks of war (medium)
- [ ] R5.4 Save and load (medium)
- [ ] R5.5 Consequence visibility (medium)
- [ ] R5.6 Campaign tuning (medium)

## R6. Polish

- [ ] R6.1 Onboarding (medium)
- [ ] R6.2 Briefings and after-action (medium)
- [ ] R6.3 Audio (medium)
- [ ] R6.4 Performance (large)
- [ ] R6.5 Accessibility and input (medium)
- [ ] R6.6 Cameras and transitions (medium)
- [ ] R6.7 Companion displays (medium)
- [ ] R6.8 The visual backlog (large; items in `docs/status/todo-2026-11-18.md`)

## Known issues

- [ ] `tests/militaryOverlays.test.ts` "shows the lanes and chokepoints in play" fails in CI now and then (5 of 174 runs, always 2 lanes for 3 theaters on seed 1); not reproduced in 100 local Node 24 runs before or after decision 234's fix; the CI `determinism` job runs it in fresh processes
- [ ] Intermittent GPU determinism flake in `detailStage` and `tileSynth` (about 1 run in 5–10 on the owner's GPU; none in 10 runs on lavapipe, 2026-11-19); R1.1. History in the archived TODO
- [ ] The Free Flight session's "drizzle: wet at once" check fails (decision 217); not investigated
- [ ] Stale code comments listed in the audit's "Left in the Code"; fix when the files are next touched
