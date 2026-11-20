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
- [x] Owner: the same ten runs on the owner's GPU, where the flake was seen (about 1 run in 5–10). First run 2026-11-19: 96 of 98 pass, the seam test included; `faceShading` and `skyView` failed by rounding and now have bounds from what is visible (decision 244). Twenty runs 2026-11-19 (10 parallel, 10 sequential): no determinism failure in `detailStage` or `tileSynth`; `faceShading` and `skyView` failed 20 of 20 on the old bounds and pass on the new; `globalPipeline` timed out at 30 s in 3 of the 10 parallel runs (now 120 s)
- [x] Pin the demo seeds 4, 10 and 7: a test that each keeps a continental front and passes validity on the current `GENERATOR_VERSION` (`DEMO_SEEDS` in `src/campaign/demoSeeds.ts`, `tests/demoSeeds.test.ts`: valid, a continental front with fit ≥ 0.9, and a reminder to re-check on a version bump)
- [x] Strategic map frame rate (10–15 fps): profile labels, the zone list and glyph rebuilds; fix the hot path (its GPU time is 4.3 ms a frame at 640 × 360, so the cost is on the CPU; decision 242): the labels were laid out every frame; now shaped once and redrawn only on change (decision 245)
- [x] Owner: the map with `?dev&cputime=1&gputime=1` for a few minutes: 30–38 fps (from 10–15); CPU 7–10 ms, GPU 15 ms, nothing growing (decision 246)
- [ ] The map's main pass takes 15 ms of GPU at 1080p (owner): time its layers (relief, biome fill, patterns, glyphs, clouds) with `?dev&gputime=1` and bring the frame under 16.7 ms
- [x] Owner feedback: orbit finicky near the poles; the campaign opened in the simulation view; too many zone names (decision 246)
- [x] Frame-rate decay over a session: check tile and mesh caches, undisposed geometries and textures, label rebuilds; a soak test that counts GPU objects after 20 view switches (`tests/gpu/mapSoak.test.ts`: flat with and without tiles; decision 245)
- [x] GPU timing tool: timestamp queries per pass in the app behind `?dev`, logged per view (`?dev&gputime=1`, `GPU_TIMING=1` in the smoke test; decision 242)
- [x] Owner: run `tools/browser.smoke.mjs` with `MODE=gpu` and the timing tool on the owner's machine; record the standard views in the audit's performance baseline (`MODE=gpu GPU_TIMING=1 node tools/browser.smoke.mjs`): 2026-11-19, at 640 × 360 (decision 242)
- [x] Owner: the same run at full resolution (`W=1920 H=1080`), to see whether the map's GPU time stays small at the size it is played: 7–8 ms, so the map's frame rate is CPU time (decision 242)
- [ ] Low flight is GPU-bound at 1080p: Free Flight's helicopter 25 m up takes 35.4 ms of GPU time, 34.5 ms in the main pass (campaign view 8.4 ms). Time the near-ground layers (trees, ground cover, canopy shell, props) with `tools/render.preview.ts` `PERF=n` and the views `hover`, `skid`, `treeline`, and on the owner's GPU with `ONLY=helicopter GPU_TIMING=1`; bring the main pass under 16 ms (R6.4 if it is not quick). Geometry is modest (preview at 1408 × 792: `hover` 0.37 M terrain + 0.28 M tree + 0.06 M cover triangles in about 100 draws, `treeline` 0.44 M + 0.45 M in 82 draws; CPU 7–8 ms), so the cost is likely per pixel (overdraw of trees and cover, the shell, shading); lavapipe cannot time it, so it needs the owner's `gputime` per pass
- [ ] The lavapipe smoke test loses its device about 160 s into Free Flight's start screen in cloud containers, also at `0c81707` (decision 242); most likely the container's memory limit killing Chromium's GPU process (the kernel reported out-of-memory kills during the runs)
- [ ] Rerun the whole-world alignment on a desktop after the tile-cache fix; record time, forced pieces, viaduct and tunnel totals (moved to R6.4; does not gate R2)
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
- [x] Owner: find the next CAS mission over the front (Pontiac 35 on seed 4, decision 248); subscribing to strikes on own airbases needs the intelligence picture (below)
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

- [x] `MissionPlugin` interface with the eight parts (a part a later milestone builds is a `pending` marker naming it); `MISSION_PLUGINS` registry; completeness test that lists every pending part and pins the list
- [x] Campaign input for planning: each front's corridors (named weak segments) and the settlements' names and points, for front segments and named places (rule 9: from the strategic graph)
- [x] Front segments with pressure: the start line cut into segments, pressure from the corridors and the attacker until the ground war (R2.3) replaces it
- [x] Supply lines: shortest-path trees over the road and rail graphs from each side's depots and rail yards to its front segments, cut bridges left out; how much supply each bridge, depot, rail yard and road edge carries
- [x] Environment for the planner: sun elevation at a point and time; a persistence forecast of ceiling, visibility, storm and surface wind from the weather view; minimums per plug-in (daylight, target and base weather)
- [x] Winds aloft in route ground speeds (`planMissionRoute`'s wind; the fuel follows the time)
- [x] Squadron ledger: committed and planned sorties as occupancy over time against strength, and the airborne cap
- [x] Package builder: flights from squadrons in range by role preference and distance, escort and SEAD by the package template, one package id
- [x] Doctrine scheduler: times on target in a window (Alliance spread with jitter, Pact waves), revision periods by side (Alliance 2 h, Pact 4 h); per-side, per-day forks keyed by need
- [x] The ATO process: one order per game day, revisions, commitment of sorties departing within the commit window, cancellations with reasons; decisions logged; save, load and hash
- [x] CAP plug-in: front stations, carriers, fields at sea, the AEW orbit (high-value asset)
- [x] Interdiction plug-in (fixed targets: bridges, depots, rail yards, road segments) ranked by supply carried
- [x] CAS plug-in (fixed-wing) by segment pressure, daylight only
- [x] Airlift plug-in: forward and island bases by stock, from the airlift squadrons' bases
- [x] Provisional plug-ins for the interim tasker's other types (support, escort, SEAD, low-level strike, strategic bombing, reconnaissance, attack helicopters): planner rule and package template ported, other parts pending R4.2
- [x] Briefing templates with named places for the four types (`src/campaign/missionBriefings.ts`)
- [x] Interface defaults per phase for the four types (data in the plug-in; R2.6 applies them through `presets.ts`)
- [x] Retire the interim tasker; tests and `tools/war.preview.ts` on the ATO (orders, revisions, cancellations, missions by type)
- [x] Determinism tests: the same orders at 1× and 64×, independent of the viewing side; all four types on both sides on the three seeds
- [x] Decision, `design.md` (Air Tasking), roadmap state, `CLAUDE.md` directory map (decision 249)
- [x] Apportionment of airborne aircraft by mission category (discovered: without it standing CAP filled the cap for the whole day)
- [ ] Interdiction volume differs by seed (seed 10: 5 Alliance and 1 Pact a day): look at the supply lines there (few depots or rail yards reached?) and the airborne cap
- [ ] The Pact's helicopter CAS finds no squadron in range on all three seeds, and its AEW route fails (fuel or station time): check the provisional plug-ins' reach before R4.2
- [ ] Mission search: show a mission's briefing (`missionBriefing`) and the order's cancelled sorties with their reasons (R2.4 or R6.2)

### R2.2 Resolution and consequences

- [x] Combat values per type: the bundle's `calibration` block (air, strike, survival) when present, else a prior from the type's role and radar until R2.10 fits them (rule 18)
- [x] AirOps keeps turnaround returns with their ready times (replaces the counter and the ATO's own returns); the ATO's ledger reads live missions and returns
- [x] Hook from mission phase events to resolution (`MissionResolution`, set on AirOps); keep phase event ids so an abort cancels later phases
- [x] Abort and return: a route home from the flight's position at any time (`returnRoute`), new phase events, the abort logged
- [x] Losses: lower the flight's and the squadron's aircraft; crews eject or are killed; survivors as records (pilot, side, point, time) for R2.9; the pilot leaves the roster
- [x] Air-to-air resolver: a package entering an enemy CAP station's reach meets it; escorts, CAP and the strike flight by their air values; draws from forks keyed by mission
- [x] Point defenses: an abstract air-defense value per target kind and value; losses on target, halved with SEAD in the package
- [x] Strike resolver: damage to target sites and bridges, road edges (new in the damage state); interdiction's plug-in resolver
- [x] CAS resolver: ground attacks recorded per theater and point for R2.3
- [x] Airlift resolver: deliveries into the destination's stocks, drawn from the origin's
- [x] CAP resolver: time on station held, kills
- [x] Outcomes logged (`mission-resolved`, `aircraft-lost`, `mission-aborted`) and their consequences applied through one function
- [x] Revisions read the outcomes: damaged targets, depleted squadrons, stocks; tests that each changes the next revision
- [x] 24 h test on the three seeds: losses on both sides, damaged targets and bridges, delivered airlift; war tool reports them
- [x] Decision, design and roadmap state (decision 250)
- [x] CAP stations by front length (one per 250 km, two to four), scored by the pressure near them (discovered: two stations left long fronts open, so almost no interceptions)
- [x] Rear cities as supply sources (discovered: seed 10's Alliance had no depots on its supply lines)
- [ ] R2.10 replaces the priors: each type's `calibration` block and the resolvers' constants (KILL_RATE, AD_RATE, P_HIT, DAMAGE_PER_HIT)
- [ ] Strikes on airbases (deep strike, provisional) have no effect until R4.2's airfield attack: runway denial (Durandal analogues), shelters, aircraft on the ground, fuel (decision 254)
- [ ] A strike's damage does not yet change supply beyond cut bridges (depots, rail yards and road edges feed R2.3's supply)

### R2.3 The ground war in aggregate

- [x] Order of battle: divisions, brigades or regiments, battalions with per-unit seeds (`sim/ground/orbat.ts`)
- [x] Deployment along the start line by corridor (the attacker massed by pressure squared) and terrain (the start line's barrier strength per segment)
- [x] Lanchester attrition per game minute with terrain, posture and supply (`sim/ground/war.ts`)
- [x] Air support: CAS reduces strength; interdiction cuts supply
- [x] Supply over the road graph; cut bridges force detours; damaged depots and roads lower it
- [x] Front segments move by local force balance, slowed by barriers
- [x] Offensives along the invasion corridors by cast posture, culminating at half strength
- [x] CAS and interdiction needs from the ground state (the ATO plans at the moved front with the fighting's pressure)
- [x] The moving front on the strategic map; brigade and regiment symbols (NATO style) at the Region band
- [x] Comparison tool: one side's air support suppressed; report the front's difference (`tools/airSupport.preview.ts`)
- [x] Benchmark: battalions plus weather plus air war in the worker at 64× and 256× (decision 251)
- [ ] Owner: the moving front and the unit symbols on the map (`npm run dev`, seed 4, Region band over the front, run at 64× for a few hours)
- [ ] Part II's checks of the unit symbols (`SCENE=strategic VIEWS=ground`, with `CVD=1` for check 4): the first render (seed 4, a day in) reads; symbols still touch in an oblique view's distance where the attacker masses
- [x] Unit symbols in a grid behind each segment (columns and rows 14 km apart; the first render piled twenty Pact regiments on one corridor)
- [ ] Reserves and their commitment, motorized infantry, echelon marks on the symbols (R3.6)
- [ ] Seed 10's response to suppressed air support is not monotonic (both suppressed runs stall the Pact's advance): look at how the air war's allocation shifts when a category is removed

### R2.4 Follow

- [x] The followed flight's pose from its analytic route: position, nose and top, velocity, the turns at waypoints smoothed into banked turns, formation slots (`sim/air/analyticPose.ts`)
- [x] Campaign aircraft in the simulation view: the followed flight's aircraft from their bundles' models, posed by the analytic pose (one model per aircraft, the flight in formation), lifted over the drawn ground (`follow/followFlight.ts`, `follow/follow.ts`)
- [x] Stand-in models by class and side for types without geometry, in their own schemes, until R2.7; the C-150's model (it stands in for the large types)
- [x] Other flights near the camera, instanced by type, with a level of detail for packages; shadows near the camera (full views within 1.5 km, at most six; `follow/campaignTraffic.ts`, `render/sim/aircraft/trafficLayer.ts`)
- [x] Chase camera on an analytic target (`ChaseTarget` from the pose); the rig from the followed type's bundle, including a transport rig (the C-150's); rigs for the Vo-31, Vo-35 and F-124
- [x] *Follow* from mission search and from a subscription offer (and the map's selection panel): a cut into the simulation view with a chase-camera settle (owner decision 12)
- [x] Return to the map above the flight's position (Escape or M, and the bar's button)
- [x] Read-only HUD for the followed aircraft from its analytic state (`followHudFrame`)
- [x] Spectator displays: the followed aircraft's own formats, read-only, with the moving map
- [x] Retire the debug free camera behind `?dev` only
- [x] Followed flights rendered headless with the HUD (`tools/follow.preview.ts`, `docs/reports/screens/follow-*.png`)
- [x] Acceptance checks 7 and 10 as scripted sequences: `ONLY=follow` in `tools/browser.smoke.mjs`, passed with `MODE=gpu` on the owner's machine (decisions 253, 254)
- [ ] Check 10 headless: a low-level shot through a valley in `tools/follow.preview.ts` (the planned routes there have no terrain floor)
- [x] Owner: follow a mission of each demo type and return (2026-11-20, GPU smoke run passed on seed 4)
- [x] Owner's review (decision 253): formations by phase in the plug-ins; penetrators low on interdiction and CAS at 2,500 m; free look orbits the aircraft; HUD only by default, V for displays or a clean view; FPS gauge under the follow bar; aircraft near a base on its sited field; the Kestrel's gear folds inward
- [x] Check 10 over truly low flight: the owner's GPU run followed an RF-34 on a low-level leg, the camera 100–106 m above the ground (2026-11-20)
- [ ] Stretch (R6.6, owner): Follow and jump-in ease from the map's orbit down into the aircraft
- [x] Interdiction by the nearest able squadron, penetrators first against defended targets (owner: both should fly it; decision 254)
- [x] Owner: look at the formations, the low-level interdiction and the orbit (decision 253); second look answered in decision 255 (carriers, gear and pylons, turns, egress, canopy), checked by the owner on 2026-11-20
- [ ] Formation lights at night, off in combat spread from the fence-in (owner; with the controlled-aircraft lights of R4.1)
- [ ] Taxi and take off in turn, the flight joining up after takeoff (owner; with R2.5's ground handling or later)
- [ ] The Pact's own carrier model (its carrier draws the Alliance's)
- [ ] Owner: the karst towers and other landform props are not in the one height function (R3.6), so low flights pass through them; keep, thin out or remove them?
- [ ] Spectator displays' radar and threat formats are empty until R2.6's sensors read campaign contacts
- [ ] Afterburner, control surfaces and speedbrake of the followed aircraft stay at rest until R2.5's flight model drives them

### R2.5 Full fidelity and handover

- [x] Promotion: analytic state → `FlownAircraft` (position, attitude, speed, fuel by share, gear and power; stores and damage as records until R2.6) from the drawn poses (`sim/flight/promotion.ts`; decision 256)
- [x] Demotion: `FlownAircraft` → the flight's state (survivors, crashes as losses, where the lead is, fuel by share, stores) and a route rebuilt from there that carries on the mission by its phase (`rejoinRoute`)
- [x] AI pilot on the director: route following (`sim/flight/aiPilot.ts`: station keeping on the route's point, speed first)
- [x] AI pilot: formation keeping (the slots of `formation.ts` beside the flown lead; `PromotedFlight`)
- [x] AI pilot: orbit and CAP station (the route's racetrack; flights now join it running the way they arrive)
- [x] AI pilot: attack run and egress (the route's pass and turn home; weapons release is R2.6)
- [x] Worker protocol: a take-over input holds the mission (no aggregate resolution, phase events cancelled); a handback input carries the demoted state, the worker rebuilds the route with `rejoinRoute`, reschedules the phases and logs losses (crashes) and the new route (decision 257)
- [ ] While the player flies, the map and the war see the held flight on its old route: post its position as fixes (inputs every few game seconds) so the map draws it where it is and other flights' resolution can find it
- [ ] The follow must not end a held flight at its old route's end (`missionPhase` reads the old timeline while it is held)
- [ ] Follow on `PromotedFlight`: promote a followed flight whose type has flight data inside the window, its lead's reference the drawn route (the fields' shift and the lift over the drawn ground); draw the aircraft from their airframes (surfaces, afterburner, speedbrake); the HUD frame and displays from the airframe; demote at the approach
- [ ] Ground for promoted flights: the drawn surface with the airfields' grading (Free Flight's `AirfieldGround`)
- [ ] The route's climb (the air war's 110 m/s for the F-21) is steeper than the Kestrel sustains at its climb speed: the AI follows it up to 4 km late and catches up by the station (R2.10's calibration, or a slower climb in the route)
- [ ] An abort (`returnRoute`) still turns home at a corner; give it the rejoin's turn
- [ ] The plug-ins' `behavior` parts (rule 16): CAP's first, once the follow runs `PromotedFlight` (the route tracker per phase; weapons on the pass in R2.6)
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
- [ ] AI-only models: F-25, E-5, KC-40, Vo-37, Ra-44, Ra-60, Ve-28 and the two utility helicopters (the E-5 first: the owner asked for a proper AWACS model; the C-150 stands in for it until then)
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
- [ ] R4.2 Mission catalog (large); with airfield attack (runway denial) and carrier alpha strikes (decision 254)
- [ ] R4.3 Helicopter track (large)
- [ ] R4.4 Transport operations (medium)
- [ ] R4.5 Crews (large)
- [ ] R4.6 Naval war (large); with amphibious and airborne seizure of an airfield and a squadron staged onto it, the Iceland operation of *Red Storm Rising* (decision 254)
- [ ] R4.7 Power lines (small)

## R5. Dynamic campaign

- [ ] R5.1 Logistics (large)
- [ ] R5.2 Morale and reputation (medium)
- [ ] Operational movement (owner, 2026-11-19; with R5.3, before its breakthrough end condition): reserves committed where an offensive succeeds; exploitation when a defending segment collapses (faster advance, the shear limit loosened behind it); pockets cut off from supply. The defender scrambles to cut the spearhead off: CAS and interdiction against it, blowing bridges and destroying supplies in its path (demolitions as a ground action, not only air strikes)
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
- [ ] GPU determinism flake in `detailStage` and `tileSynth` (about 1 run in 5–10 on record): not reproduced in 20 runs on the owner's GPU and 10 on lavapipe (2026-11-19), nothing changed to fix it; close if it stays away. History in the archived TODO
- [ ] The Free Flight session's "drizzle: wet at once" check fails (decision 217); not investigated
- [ ] Stale code comments listed in the audit's "Left in the Code"; fix when the files are next touched
- [ ] On lavapipe, `tests/gpu/mapSoak.test.ts` "keeps the relief tiles within their caches while panning at the floor" fails (geometries 274 against 234; the same at 8542fd3, before R2.4's changes), and in Chromium on lavapipe the app stops drawing after its ninth frame (simulation view or map) while the GPU process grows by about 1 GB every 5–10 s, until the kernel kills it after about 195 s: seeds 4 and 1983, the `campaign` part as well as `follow`, and at 8542fd3. Not seen on the owner's GPU (decision 245); look at the relief and terrain tiles' buffers on a software adapter
