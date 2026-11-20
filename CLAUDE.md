# CLAUDE.md

Guidance for Claude Code sessions in this repository. **`docs/roadmap.md` is the source of truth for what to build next** (phases R0–R6, decision 228), and `TODO.md` breaks its current phases into tasks. `docs/design.md` is the source of truth for scope and architecture. Read both before starting milestone work. `docs/status/audit-2026-11-18.md` records what exists, feature by feature, as of the audit. `docs/decisions.md` records the decisions behind it, with dates and reasons. `docs/visual-style.md` is the source of truth for how the game looks: rendering, models and UI (rule 11). The game has two views of one world (decision 72): the illustrated **strategic view** (globe down to a ~100 km zoom floor; visual-style Part II) and the low-poly **simulation view** (0–20 km, entered through a unit; Part I). Owner proposals live in `docs/proposals/`; an accepted proposal is folded into the design doc and a decision.

**Keep the documents in step with the decisions.** A decision that changes anything `docs/design.md` or `docs/visual-style.md` states must update that document in the same commit. Edit the statement in place rather than leaving the old text for readers to reconcile. If you find a document contradicting a decision anyway, the later decision wins: fix the document.

## Commands

| Task                     | Command                                                         |
| ------------------------ | --------------------------------------------------------------- |
| Dev server               | `npm run dev`                                                   |
| Unit tests               | `npm test` (watch: `npm run test:watch`)                        |
| Type check               | `npm run typecheck`                                             |
| Lint                     | `npm run lint`                                                  |
| Everything but build     | `npm run check`                                                 |
| Production build         | `npm run build` (runs the type check first)                     |
| Serve production build   | `npm run preview` → `http://localhost:4173/bearing/`            |
| Format                   | `npm run format`                                                |
| Render world maps to PNG | `npm run maps` (env: `SEED`, `RES`, `MODES`) → `tools/out/`     |
| Seed browser (theaters)  | `npm run seeds` (env: `SEEDS`, `FROM`, `COUNT`, `BRIEFING=1`)   |
| Weather preview          | `npm run weather` (env: `SEED`, `HOURS`, `DAYS`, `PRESET`) → `tools/out/` |
| Flight-model figures     | `npx vitest run --config vitest.tools.config.ts tools/flight.preview.ts` |
| Kestrel deceleration     | `npx vitest run --config vitest.tools.config.ts tools/decel.preview.ts --disable-console-intercept`: drag breakdown, spool and transit times, the deceleration targets and the straight-in approach (decision 207); `tools/approachHud.preview.ts` writes HUD frames of that approach for `tools/freeflight.screens.mjs` (`SHOTS=approach-20,approach-13,approach-6 OUT_DIR=tools/out`) |
| Kestrel lockstep charts  | `npx vitest run --config vitest.tools.config.ts tools/lockstep.preview.ts` (`ONLY`) → `tools/out/lockstep.html`: the lockstep test's 15 flights (decision 154) |
| Sky sheets, shadow bake  | `tools/sky.preview.ts` (sky-only contact sheets; `PERF=n`, `VIBRANCE`), `tools/shadow.preview.ts` (height sources and bake cost; `ROUNDS`), both with the vitest tools config |
| Clouds, fog, rain        | `tools/clouds.preview.ts` (the volumetrics over a plain ground, 0.1–0.3 s per view; `VIEWS`, `QUALITY`, `COUNT=1` for steps and texture reads, `PERF=n`, `GRAIN=0`, `TUNING` and `TUNING_AIR` as in the render preview), `tools/precip.preview.ts` (particles and a bolt; `BOLT`), both with the vitest tools config |
| Free Flight renders      | `tools/freeflight.preview.ts` (env: `SEED`, `GRES`, `TOD`, `SHOTS`, `WEATHER`, `WIND`, `QUALITY`, `GOVERNOR`, `POST`, `MSAA`, `SETTLE`, `OUT`), then `node tools/freeflight.screens.mjs` with `npm run dev` up (`SHOTS`, `OUT_DIR`) → `docs/reports/screens/` |
| Free Flight session      | `node tools/freeflight.session.mjs` with `npm run dev` up: the real `FreeFlight` class in headless Chromium without WebGPU, through every weather preset, pause, restart, a crash and a takeoff roll with free pedals in clear, storm and blizzard |
| River beds               | `npx vitest run tools/rivers.preview.ts --config vitest.tools.config.ts --disable-console-intercept` (env: `COUNT`, `KM`, `MIN_DROP`, `GRES`): walks rivers' channels on level-7 tiles and prints where the bed climbs (decision 146) |
| Alignment stage          | `npx vitest run --config vitest.tools.config.ts tools/alignment.preview.ts` (env: `LIMIT`, `NEAR=lat,lon,km`, `SAVE`, `ALIGN_TUNING`); `ALIGNMENTS=<saved>` in the render preview draws it (decision 184) |
| Displays, checks 12–13   | `node tools/displays.screens.mjs` with `npm run dev` up: every master mode, both skins, 1366 × 768 and 1920 × 1080, color-vision views (env: `MODES`, `SIZES`, `CVD=0`, `OUT_DIR`) → `tools/out/displays/` (decision 200) |
| World diversity metrics  | `npx vitest run --config vitest.tools.config.ts tools/diversity.preview.ts` (env: `SEEDS` or `FROM`/`COUNT`, `GLOBAL=1` for eroded worlds, `GLOBAL_SEEDS`, `GRES`, `OUT`) → `tools/out/diversity.md`: proposal 0007's criteria over 20 seeds (decision 204) |
| Airfield siting          | `npx vitest run --config vitest.tools.config.ts tools/airbaseWater.preview.ts --disable-console-intercept` (env: `SEEDS`, `GRES`, `ALL=1`): each airbase's pad on the eroded world before and after siting (decision 220) |
| Headless day of war      | `npx vitest run --config vitest.tools.config.ts tools/war.preview.ts --disable-console-intercept` (env: `SEEDS`, `HOURS`, `RATE`, `OUT`) → `tools/out/war.md`: the campaign on the demo seeds, stepped at 64× and in one jump, with the worker's cost (decision 236), missions by type and side, and each side's orders, revisions, cancellations and unfilled requests by reason (decision 249) |
| Air support comparison   | `npx vitest run --config vitest.tools.config.ts tools/airSupport.preview.ts --disable-console-intercept` (env: `SEEDS`, `HOURS`, `OUT`) → `tools/out/air-support.md`: the front after a day with full air war and with each side's strikes and ground support suppressed (decision 251) |
| Ground map               | `npx vitest run --config vitest.tools.config.ts tools/groundMap.preview.ts` (env: `SEED`, `LAT`/`LON`, `KM`, `ALT`, `RANGES`) → `tools/out/groundmap-<nm>.png` and `.json` (decision 226) |
| Map CPU and GPU timings  | In the app: `?dev&cputime=1` logs the map's CPU per section and the app's frame every 5 s; `?dev&gputime=1` GPU time per view and pass (decisions 242, 245). Headless: `SCENE=strategic PERF=1 MOVE=1` in `tools/render.preview.ts` prints the map's CPU per section, still and panning |
| Browser smoke test       | `npm run build && npm run preview`, then `node tools/browser.smoke.mjs` (env: `MODE`, `WORLD`, `ONLY`, `SCENES`, `OUT`) → `tools/out/browser/` (decision 144); `ONLY=follow` follows a flight of each demo type with checks 7 and 10 (`FOLLOW`, `NIGHT=0`; decision 252) |

## Directory map

```
docs/design.md      design doc (source of truth; do not reformat)
docs/decisions.md   architecture decision log
docs/visual-style.md  visual style guide (source of truth for the look; do not reformat)
docs/style/references/  reference screenshots: local only, gitignored, never shipped (decision 70)
docs/proposals/     owner proposals (do not reformat); 0001-two-views.md (decision 72),
                    0002-third-person-flight.md (decision 94), 0003-forests-for-low-flight.md
                    (decision 148), 0004-helicopter-flight.md (decision 149),
                    0005-terrain-adaptive-networks.md (decision 161), 0006-displays-and-crew.md
                    (decision 189), 0007-world-diversity.md (decision 204) and
                    0008-game-loop-and-campaign.md (decision 228) are accepted
docs/roadmap.md     phases R0–R6 with milestones, dependencies and exit criteria: what to build next
docs/status/        audits: audit-2026-11-18.md (status matrix, health, decisions for the owner) and
                    todo-2026-11-18.md (the earlier tracks' TODO, archived)
docs/plans/         implementation plans: free-flight.md (decision 134), helicopters.md (track H), ground-detail.md (track G),
                    terrain-networks.md (track N), displays.md (P2, P3, P5, P6; decision 189),
                    world-diversity.md (track W; decision 204)
docs/reports/       milestone reports, metrics and screenshots (screens/ is excluded from the build);
                    world-diversity-baseline.md is track W's baseline
src/core/           units, float64 Vec3d, coordinates, seeded RNG, invented names, the moon's ephemeris. Leaf layer.
src/worldgen/       planet generation pipeline stages (may use GPU compute); canopy.ts is the canopy height
                    field with its stands (decision 148), shared by the renderer and later the sim;
                    groundCover.ts places the ground cover kit per cell (decision 174), shared the same way;
                    (track W) provinces.ts, lithology.ts, zones.ts and props.ts: terrain provinces with
                    continental characters, rock, zones with look recipes, landform prop placement shared with the sim
                    (decision 225);
                    closed basins in drainage.ts; wonder candidates in geography/wonders.ts (decision 204)
  coarsePass.ts     the design's pipeline at 256² on the CPU; campaignWorld.ts adds the validity retries
  edits/            terrain edits (decision 164): pads and corridors, their index by tile, protected
                    river channels and TerrainEdits.apply, the one height function (rule 13);
                    siting.ts sites airfields on the eroded world (decision 220)
  channels/         (track N) meander migration with cutoffs and oxbows, the channel stage, river invariants
  networks/         the alignment tier (decisions 161, 180, 184): the router, plans, profiles, earthworks,
                    link tasks and anchors, links aligned whole, the stage (build.ts, run once per world
                    on a worker pool over level-6 tiles) and its stored record (alignments.ts)
  strategic/        strategic graph types and builder (settlements, roads, bridges), and infrastructure
                    placed after casting: the only world view campaign logic gets. Road hierarchy,
                    railways and urban extents go here too, and the types of named features (decision 72)
  geography/        feature extraction (S2): named-feature records with geometry and importance, run by
                    the graph builder; types in strategic/graph.ts
  names/            toponymy generator from rng("names"): flavors, generic terms; names features,
                    settlements and corridors (route numbering in S4)
src/campaign/       theater detection, casting (carrier groups in carriers.ts), briefing, validity check (reads the
                    strategic graph only); missionBriefings.ts, the mission plug-ins' briefing templates
src/data/models/    model specs (JSON, decision 106) of everything drawn; aircraft/ holds one bundle per aircraft
                    type (rule 17, decision 238): geometry, flight data, air-war entry, avionics profile, rig
src/sim/            headless simulation; runs in a worker: event queue + fixed ticks (simulation.ts),
                    time acceleration, checkpoints and the input timeline (host.ts), saved state and the
                    event log (simulation.ts, eventLog.ts; decision 235), world factory (world.ts)
  weather/          hourly weather model on a bordered 24² cube grid; WeatherView for queries; presets and the
                    standalone weather for Free Flight (decision 137)
  air/              the air war (C2, decision 132): the bundle loader (bundles.ts) and the type table it fills,
                    order of battle, missions,
                    analytic routes (great-circle legs, racetracks, fuel, the turn home) and AirOps (live missions, phase
                    events, losses, survivors, aborts); resolution.ts (interception, point defenses, outcomes and their
                    consequences), resolvers.ts (the demo types' resolvers), outcome.ts, calibration.ts (combat values:
                    fitted or the prior; decision 250)
  naval/            carrier groups on their patrol tracks (analytic position); convoys, amphibious and surface groups in R4 (docs/roadmap.md)
  ground/           road and rail graphs with bridge cuts (network.ts), damage to targets, road edges and attacks on
                    troops (damage.ts; decisions 237, 250), the ground order of battle (orbat.ts) and the ground war in
                    aggregate (war.ts: Lanchester per minute, supply, the moving front; decision 251)
  avionics/         avionics state per aircraft (master mode and its triggers, master arm, acknowledged cautions; later
                    radar mode, locks, designations, stores) changed only by avionics commands, and avionics profiles
                    (decisions 189, 199), each type's from its bundle (decisions 224, 238)
  sensors/          the sensor model (P3a, decision 218): radar, RWR, visual and datalink contacts per aircraft,
                    the filtered picture that displays read and the AI is to read (R3); lineOfSight.ts over the ground; groundMap.ts,
                    the air-to-ground radar's ground map (decision 226)
  crew/             (R4, planned) AI crewmates: roles, format ownership, tasks, callouts; act through avionics commands
  command/          per-side command layer (graph and cast only): campaign input from the main thread, the air tasking
                    orders (ato.ts; decision 249) with front segments, supply lines, doctrine, the planning environment
                    (weather and daylight) and the squadron ledger; missions/ holds the mission plug-ins and their registry
                    (rule 16); later the intelligence picture
  clock.ts          the one clock's rules: flight step, real-step cap, time rates (decision 243)
  flight/           flownAircraft.ts (the flown aircraft: airframe, controls, input source, avionics state,
                    stepping; decision 243); flight model, control laws, ground model, runways, outcomes, flight director and a
                    scripted test pilot, to be shared by AI and player (Free Flight, decision 134; R2 extends it to
                    campaign aircraft; the sensor model is in sensors/, decision 218); wind and gusts from the weather (wind.ts, decision 143);
                    the track hold on the wheels with free pedals (controlLaws.ts, decision 145);
                    airframe.ts (the Airframe interface every flown aircraft implements), rigidBody.ts
                    (gravity, Euler's equations, the integrator, attitude) and contact.ts (ground query,
                    wheels, hard points), shared by the Kestrel and the helicopters (decision 154);
                    rotor/ holds the helicopters' rotor-disc model, laws, assists and downwash; the rotary
                    director is planned (track H, decisions 149, 159)
src/render/         Three.js WebGPU + TSL, split by view (decisions 72–74). Both scenes stay resident;
                    the app renders the active one (GUI → View → View). Until V1, sim/'s GlobeScene
                    still draws orbit to ground.
  common/           shared by both views: camera-relative placement, orbit camera, cell-grid debug
                    globe, palette, climate and habitability textures, render scale and the quality
                    governor of the atmospheric effects (decision 143), canopyNode.ts (the canopy
                    field in TSL, decision 148), cube-sphere
                    geometry, WebGPU checks, terrain/ (tile quadtree, tile meshes, tile cache, budget, prefetch),
                    water/ (river segment tables and river shading), models/ (model spec format,
                    procedural builder, palettes and schemes; the specs are in src/data/models/, decision 106);
                    later the transition controller
  sim/              simulation view: GlobeScene, camera/ (observer, chase camera and stations), aircraft/
                    (the flown aircraft with animated parts, decision 135; trafficLayer.ts, instanced campaign
                    aircraft, decision 252), terrain/
                    (TerrainRenderer), atmosphere/ (sky-view LUT, sun, moon and stars; decision 140), water/ (sea),
                    clouds/ (Volumetrics: the march through cloud, fog, dust and rain veils; cloudForm,
                    noiseVolume, the coverage bake and the weather texture; decision 141), forest/ (the canopy
                    shell over the terrain tiles and the kit trees on it, decision 148), ground/ (the ground cover's
                    ring near a low camera, decision 174), props/ (landform props, decision 225), infra/,
                    lighting/ (PlanetLighting; TerrainShadow, decision 139),
                    post/ (SimPipeline: volumetric stage, overlay, bloom, grade, grain; decision 138),
                    weather/ (WeatherState, the uniforms the effects share, decision 137; Precipitation,
                    Lightning and its strike schedule, decision 142);
                    the chase camera and its rigs are in camera/; the HUD and displays are in ui/
  strategic/        strategic view: StrategicScene, StrategicCamera, zoom bands, relief mesh, hillshade,
                    biome fill, patterns, glyphs (glyphLayout, glyphGeometry, glyphLayer), graph debug
                    overlay
    labels/         label engine: SDF font atlas, styles, band content tables, placement, LabelLayer
    overlays/       military overlays (decision 101): territory tint texture, the overlay model
                    (front, defensive lines, corridors, sea lanes, chokepoints) and MilitaryLayer
    movingMap.ts    the moving map's picture: renderMap into a render target, read back (decision 201)
    infra/          settlements and infrastructure (decision 104): urban fill texture, building
                    glyph placement, the model of roads, railways, bridges and site symbols
                    (overlays/airModel.ts draws flights, trails, routes and carrier groups; decision 132)
src/ui/             displays/ (P2, decisions 195, 199): layout.ts (the slots' rects), model.ts and snapshot.ts (display models,
                    commands, the aircraft snapshot), formats.ts, presets.ts (master modes' presets), strip.ts, bindings.ts
                    (hot keys), system.ts (the controller) and draw/ (the HTML, CSS and Canvas 2D view);
                    lil-gui debug panel (atmosphereSettings.ts maps its Atmosphere folder to the scene),
                    overlays, time controls, the time bar's weather line; flight/ (Free Flight's start screen, input
                    bindings, HUD and the HUD frame built from an airframe, pause menu and cards; decisions 134,
                    135); missionSearch/ (the search model and panel, decision 241); sidePanel.ts; the aircraft
                    snapshot for the displays (displays/aircraftSnapshot.ts, R1.5); audio/ (synthesized thunder,
                    rain and wind, no files; decision 142)
src/freeflight/     the Free Flight mode's glue on the main thread: world and runways, ground query, clock,
                    session flow (?mode=freeflight; decision 134), its weather (a StandaloneWeather feed and
                    presets), URL options (decision 143) and traffic.ts, scripted traffic and ground radars
                    for the sensors (decision 218)
src/follow/         following a campaign flight on the main thread (R2.4, decision 252): followFlight.ts (stand-in
                    models, the drawn altitude over the drawn ground, the read-only HUD frame), follow.ts (the cut,
                    the chase camera on the analytic pose, HUD, spectator displays, the way back to the map) and
                    campaignTraffic.ts (other flights near the camera: full views near, instanced beyond)
src/viewer/         the model viewer page (viewer.html, a second Vite page; decision 106)
src/workers/        worker entry points and message protocols
src/main.ts         app entry: WebGPU checks, renderer, scene, GUI
tests/              Vitest unit tests (node); tests/gpu/ runs WGSL kernels on a real GPU via Dawn
tools/              offline previews (npm run maps; terrain/bench *.preview.ts), output in tools/out/;
                    hud/ (pages that draw Free Flight's HUD, cards, session and the software-adapter notice without WebGPU);
                    browser.smoke.mjs runs the built app in Chromium (browser/: launch, page probe, lavapipe shim)
TODO.md             tasks by roadmap phase and milestone (R1, R2 in tasks of a few hours; later phases as milestones)
```

## Rules

These are the project conventions. Lint enforces some of them (marked ⚙).

1. **SI units everywhere.** Use meters, seconds, radians and kilograms. Convert at the boundary with the constants in `src/core/units.ts`, e.g. `480 * KNOT`, `52 * DEG`. Never store non-SI values.
2. **Game time** is a float64 count of seconds since campaign start (`GameTime`).
3. **World coordinates** are planet-centered Cartesian, float64, in meters.
   - +Y points through the north pole, +Z through latitude 0 / longitude 0, and +X through longitude 90° E.
   - Use the conversions in `src/core/coords.ts`: geodetic ↔ Cartesian, and direction ↔ cube-face UV.
   - Cube faces are 0..5 = +X, −X, +Y, −Y, +Z, −Z and use the equi-angular warp. The face order and axes are fixed because baked maps depend on them.
4. **Camera-relative rendering.**
   - The Three.js camera stays at the origin.
   - Every world-space object's GPU position is `worldPos − cameraEye`, subtracted in float64 _before_ it is written into float32. Place objects with `placeCameraRelative` / `placePlanetCentered` in `src/render/common/cameraRelative.ts`.
   - Never put planet-scale coordinates into an `Object3D` directly.
5. **Determinism.**
   - ⚙ `Math.random()` is banned in `core`, `worldgen` and `sim`.
   - All randomness comes from `rng(worldSeed, "stream-name")` in `src/core/rng.ts`. Give each generation stage its own stream, and use `fork("sub")` for sub-streams.
   - Never pass one stage's stream to another stage. Adding or changing a stage must not change any other stage's output.
6. **Separation.**
   - ⚙ `sim` and `worldgen` never import `render` or `ui`.
   - ⚙ `sim` and `core` also never import `three/webgpu`, `three/tsl` or `lil-gui`.
   - ⚙ `core` imports nothing else from `src/`.
   - `worldgen` may use `three/webgpu` and `three/tsl` for GPU compute.
7. **WebGPU is required.** Do not add a WebGL path. `WebGPURenderer` silently falls back to WebGL 2, so keep the post-`init()` backend check in `main.ts`.
8. **Static hosting.** The app is a static site on GitHub Pages under `/bearing/`, with no server and no custom headers (decision 40).
   - No `SharedArrayBuffer`, `Atomics.wait`, or anything else that needs cross-origin isolation (COOP/COEP).
   - Workers exchange data via `postMessage`, transferring `ArrayBuffer`s rather than copying them.
   - Never use root-absolute asset URLs. Load workers with `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })` or a `?worker` import, and prefix other runtime paths with `import.meta.env.BASE_URL`.
9. **The strategic graph is the only interface between world data and campaign logic** (decision 52).
   - ⚙ Theater detection, casting and the command layer (`src/campaign/`, `src/sim/command/`) never import `worldgen` outside `worldgen/strategic/`.
   - They do not read heightmaps, tiles, `WorldMaps`, `TileData` or `terrainHeight`, not even through a helper or a message that carries them.
   - If campaign logic needs a new fact about the world, add it to the graph builder in `worldgen/strategic/` and to the graph types. The graph debug overlay then shows it too.
   - The sim's execution layer (flight paths, line of sight, ground movement) may query terrain. The restriction covers planning only.
   - ⚙ `Math.random()` is banned in `campaign` as well. Casting draws from `rng(worldSeed, "casting")`.
10. **Unsteered generation** (decisions 46, 204). World generation never steers toward a particular geography. The only rejection is the validity check, which retries with a seeded sub-seed. Do not add biases to make a theater more likely. Theater detection adapts to the world instead. One exception serves variety, not any geography: a continent's character is drawn from what its tectonics allow, and the distinctness check may redraw the smaller of two look-alike continents' characters, at most twice, from seeded sub-streams.
11. **Visual style** (decisions 70, 72). All rendering, models and UI follow `docs/visual-style.md`: Part I for the simulation view, Part II for the strategic view.
    - Part I covers flat shading, the palette, polygon budgets, tree and model construction, LOD distances, post-processing, UI panels and type, and its "What to avoid" list.
    - Part II covers the strategic camera and zoom bands, the base map, glyphs, labels, overlays, day/night and weather on the map, its palette, and its own "What to avoid" list.
    - Keep the two views separate. The map never draws individual trees or buildings, and the simulation view never goes above about 20 km.
    - Models are built in code from JSON specs, not modeled by hand or loaded as photographic assets.
    - If something must deviate from the guide, record it in `docs/decisions.md` and update the guide to match.
    - The reference screenshots in `docs/style/references/` are local only. Never commit them, import them from `src/`, or copy them into `public/` or `dist/`. `vite.config.ts` refuses to load anything under `docs/`.
12. **No cockpits; one flight director and one flight model** (decision 94, Proposal 0002).
    - Bearing has no cockpits. Every aircraft and helicopter is flown and followed from a third-person chase camera, and the HUD and displays are 2D overlays (`docs/visual-style.md` Part I, _HUD and Displays_). Do not add cockpit interiors, cockpit cameras or cockpit-only assets.
    - AI pilots and the player share one flight director (desired direction and speed → control inputs) and one flight model. The player's input only replaces where the aim point or stick input comes from. Never give the player's aircraft its own physics path or the AI a shortcut around the flight model.
    - Fixed-wing and rotary-wing aircraft share one flight director interface and one airframe interface (decision 149, Proposal 0004). Helicopter physics live in `src/sim/flight/` beside the fixed-wing model, headless and deterministic at the same 120 Hz step. Assists and envelope protection belong to the control layer, never to the physics.
    - Displays show only what the aircraft's sensor model knows, which is the same filtered picture the AI uses, never ground truth.
13. **Terrain edits and one height function** (decision 161, Proposal 0005).
    - Every change to the terrain surface beyond the tile kernel's own synthesis (airfield pads, road and rail corridors with their banks, hairpin shelves, rail yards, lock chambers) is an analytic edit, a pure function of direction and the unedited height, applied after the render detail. Edits live in `src/worldgen/edits/`, so `sim/` can use them: `TerrainEdits` holds the airfield pads and the aligned corridors, assembled by `terrainEditsFor` in `worldgen/edits/airfields.ts` for the renderer and the sim worker alike (decisions 164, 184, 240), and takes the river index for protected channels (decision 164). `HeightService` (global grid plus edits) is the execution layer's ground where tiles are not to be waited for: line of sight and the sim worker (decision 240).
    - Everything that asks for the terrain's height (mesh vertices, trees, buildings, the camera's clearance, the flight model's ground, and later line of sight, ground movement and the AI) goes through that one function. Never add an edit's effect to tile data or the global grid yourself.
    - River channels stay last. Carving, floodplains and delta build-up belong to the tile kernel; no edit may raise the ground inside a river's protected channel, and a road or railway crosses a river on a bridge or culvert, never on terrain. Airfield pads are the one exception until their placement keeps off rendered rivers (decision 164).
    - Roads and railways have two tiers: the network tier (coarse pass, strategic graph) is what campaign logic reads (rule 9); the alignment tier (routes aligned on the eroded world, earthworks, structures) is execution and presentation data only.
14. **Displays** (decision 189, Proposal 0006; `docs/visual-style.md` Part I, _Displays and Status Strip_).
    - **Allocation.** Every item lives in exactly one place: the HUD (spatial and time-critical information used while looking outside), a display format (sensor pictures, selection, configuration, planning) or the status strip (discrete states and warnings). Place a new item by this rule; if it fits nowhere, it probably belongs in a format.
    - **Standardization.** The five slots (left and right MFD, threat, messages, status strip) have one position and one set of bindings in every aircraft; an aircraft may leave a slot empty but never moves it. A format has the same layout and buttons in every aircraft that carries it, and exists only where the aircraft carries the system behind it (its avionics profile). Faction skins change colors, fonts, labels and units, never layout or button positions.
    - **Display models.** Every format is a pure function from the sensor-filtered aircraft snapshot and the display state to a serializable display model, in `src/ui/displays/`, with no DOM, canvas or three.js in it. Input from keys, clicks, the crewmate or a companion returns as display commands; what changes the aircraft's behavior is an avionics command in `src/sim/avionics/`, and the crew and AI issue the same ones. Hot actions (those a pilot needs without looking) have key bindings; bezel buttons work by mouse (decision 193).
    - **Mouse capture.** One `MouseCapture` (`src/ui/flight/mouseCapture.ts`) owns the pointer lock for every flown aircraft, toggled by one key (Tab) in every binding table (decision 193). Never request or exit pointer lock elsewhere.

15. **Landform, biome, surface** (decision 204, Proposal 0007). Three separate layers make every landscape, and each has one source.
    - **Landform** comes from tectonics and rock: the terrain province (`provinces.ts`) sets uplift, soft limit and which landforms form; the lithology (`lithology.ts`) sets erodibility, talus, rock color and gates landforms (strata, mesas and buttes only in layered sedimentary rock in a dry climate; karst only in limestone).
    - **Biome** comes from climate: temperature, moisture, seasonality and the local modifiers, stacked by altitude. Climate may gate a landform (strata need a dry climate, cirques a cold one), but the biome label itself never decides one, and a province never decides a biome directly; soil from the rock may tip a biome (heath on acid sand, grassland on chalk).
    - **Surface character** comes from soil, water and disturbance: riparian corridors, oases, ecotones, fire scars and wind-throw, closed-basin salt and shorelines.
    - Zones, props and wonders read the three layers and never change the province, rock or biome maps; a wonder shapes the tiles on top of them. A new landscape feature names the layer it belongs to and reads only the layers below it.

16. **Mission types are plug-ins** (decision 230, Proposal 0008). A mission type is complete only when all eight parts exist: planner rule with priority scoring, package template, aggregate resolver, full-fidelity behavior for the AI pilots, jump-in windows, success criteria and consequences, briefing template, and interface defaults (master mode, formats and HUD cues per phase). Register it with the mission registry, whose test checks every part; never special-case a mission type in the planner, the resolver or the UI outside its plug-in. `docs/roadmap.md`, *Adding Mission and Aircraft Types*, has the checklist.
17. **Aircraft types are bundles** (decisions 230, 232, Proposal 0008). Every type is one JSON bundle: geometry with animated parts, flight data, avionics profile and display complement, pylons and loadouts, role tags, crew roles, camera rig, aggregate performance from calibration, and faction, name and skin. Bundles live in `src/data/models/aircraft/`, where the sim may import them (decision 238); `src/sim/air/bundles.ts` is the one loader for the sim worker and the renderer. Never keep a part of a type in code. Add a type by filling every part; the bundle test (`tests/bundles.test.ts`) lists what a type lacks. A type that changes every world's cast needs its own decision.
18. **Calibration** (decision 230). Aggregate resolvers and full fidelity must agree. Aggregate outcome tables are fitted from headless full-fidelity engagements by a script, stored in the repository, and checked by a tolerance test. A change to a flight model, a weapon or a resolver regenerates the affected tables in the same commit; never tune an aggregate table by hand.
19. **Event log** (decision 230). Every player input to the campaign and every campaign-level decision is an event in the log, and the consequences of a full-fidelity session return to the simulation as logged events. Nothing outside the log may change campaign state, so replaying the log from a snapshot reproduces the same state. Sim state must be serializable: no hidden RNG state, no closures in the queue, no state held only by the UI.

## Fidelity as level of detail

Fidelity is a level of detail in both space and time.

- The renderer refines terrain where the camera looks.
- The simulation refines units where the player looks and coarsens them when time runs fast.

Every unit exists at one of three levels:

- **Aggregate:** formation, flight or convoy. Always simulated, cheaply.
- **Entity:** individual vehicles and squads. Simulated only inside a promotion bubble of about 15–25 km around the player (around the followed or flown aircraft, or the simulation view's camera; decisions 49, 72, 94).
- **Full:** physical simulation (flight model, sensor model, flight director). Used only for the aircraft the player controls or follows, from roadmap R2.5; until then a followed aircraft flies its analytic route, and only Free Flight's aircraft run at full fidelity. The player flies and never commands ground or naval forces.

Promotion expands a unit deterministically from its seed and current strength. Demotion folds entity losses back into aggregate strength, so nothing destroyed comes back. Design data models so that promotion is possible even before it is implemented.

## Working rules

- Work on one milestone task at a time, in the order `docs/roadmap.md` suggests. Keep `TODO.md` current: check off finished tasks and add subtasks you discover. When a roadmap milestone starts, break it into tasks of a few hours in `TODO.md`; when one closes, update its state in the roadmap.
- Record any architectural decision, or any deviation from `docs/design.md`, in `docs/decisions.md` with the date, the decision and the reason. In the same commit, update whatever `docs/design.md` or `docs/visual-style.md` says on the subject.
- Run `npm test` and `npm run typecheck` (or `npm run check`) before declaring a task complete.
- **The Kestrel's flight is pinned bit for bit** by `tests/flightLockstep.test.ts` (decision 154). A change meant to alter it (tuning, a new force) re-records the fixture with `LOCKSTEP_RECORD=1 npx vitest run tests/flightLockstep.test.ts`, once under Node 22 and once under Node 24 (`PATH=/opt/node24/bin:$PATH node node_modules/vitest/vitest.mjs run …` in a cloud session), and says so in its decision. A refactor must pass it unchanged.
- **Visual milestones close only after the acceptance checks** in `docs/visual-style.md` for the views they touch. A visual milestone is any milestone with rendering, model or UI tasks; `docs/roadmap.md` lists them (from R1.1, R2.4, R2.6–R2.8 and R2.12 on). Decisions before 228 name the earlier tracks' visual milestones (S, V, I, P, H, G, N3, N6–N8, W3, W4, W6–W9).
  - Simulation view (Part I): checks 1–5 as `tools/render.preview.ts` views; check 6, the silhouette test, in the model viewer once aircraft models exist; checks 7–10 (HUD and camera rig) as scripted sequences (R2.4 on); checks 12–14 (displays and status strip); checks 15–16 (zones and landmarks; R6.8).
  - Strategic view (Part II): checks 1, 2, 4 and 5 as preview views (4 through simulated color-vision deficiencies); check 3, the ten-second legibility test, with the owner.
  - Read the PNGs next to the reference board in `docs/style/references/` and report to the owner where they match and where they fall short.
  - Add a TODO task for each gap. The milestone's owner checkpoint comes after this comparison, not before.
- Prefer small, reviewable commits with descriptive messages.
- **Commit and push to `main` only.** Do not create feature branches or pull requests, even if a session's default instructions name a different branch; the owner tests from `main` (GitHub Pages deploys from it). Fetch and rebase onto `origin/main` before pushing if it has moved.
- You cannot see the WebGPU view. To inspect generated worlds, run `npm run maps` and read the PNGs in `tools/out/` (equirectangular map plus both polar caps, any view mode). `MODES=graph` draws the strategic graph, the cast's territory, settlements, roads, bridges, airbases, ports and targets (and prints the briefing); `MODES=barrier` shows the front generator's barrier map.
- When a task produces something visual, tell the user what they should see and how to check it in the browser (`npm run dev`, which GUI controls to use, and what would indicate a bug).

## Tooling notes

- **Three.js is pinned to r187 (`~0.187.0`).** Its WebGPU, TSL and compute APIs change between releases, so check the current docs and `node_modules/three/examples/webgpu_*.html` rather than relying on memory. Import from `three/webgpu` and `three/tsl`, and import addons from `three/addons/...`.
  - Init with `new WebGPURenderer()`, then `await renderer.init()`, then `setAnimationLoop`.
  - Run compute with `Fn(() => …)().compute(count)` and `renderer.compute()` or `computeAsync()`.
  - Read back with `renderer.getArrayBufferAsync(storageNode.value)`.
- **World-generation GPU code is plain WGSL on a raw `GPUDevice`** (`src/worldgen/gpu/`, decision 26). Vitest runs it on this machine's GPU through Dawn's Node bindings (the `webgpu` dev dependency); GPU tests skip without an adapter. With webgpu 0.6.2 on Windows, `queue.onSubmittedWorkDone()` and error scopes after a buffer map crash Node: use `GpuContext.finish()` and `GpuContext.errors`. Write kernel checks as self-tests in `worldgen/gpu/selfTests.ts`, so they also run in the browser (GUI → Self-tests).
- **Seeing the rendered scene without a browser:** `npx vitest run --config vitest.tools.config.ts tools/render.preview.ts` draws the app's `GlobeScene` with three's `WebGPURenderer` on Dawn (decision 32) from fixed views (`VIEWS=mixed,conifer,range,dusk,beach,low,sea,ocean,shore,lake,trees,treeline,canopy,woodland,hedgerows,roadrow,gallery,hover,skid,nap,winter,alpine,farmland,sunset,town,airbase,runway,tower,tower-dusk,night,ceiling`, all within 20 km (`ceiling` is 20 km up; `ocean` looks over open sea from 12 km, decision 146); `PERF=n` times n more frames per view and prints draw calls, triangles per layer and CPU per frame against Part I's budgets (decision 131; measure at `W=1408 H=792 DETAIL=1`, about 75% of 1080p); `VIEWS=checks` renders Part I's acceptance checks 1–5, which are `mixed`, `conifer`, `range`, `dusk` and `beach`, aimed at targets `tools/checkViews.ts` finds in the world (decision 128); `alpine` looks at the highest summit near the main continent from 10 km, `farmland` at the most settled farmable lowland near it from 2 km; `tower` and `tower-dusk` look through the observer camera, and `OBS_HEIGHT` (m above the ground), `OBS_PITCH` (deg), `OBS_HEADING` (deg, or `sun`) and `OBS_LAT`/`OBS_LON` (deg) override its station; `FLICKER=n` renders n more frames turning `FLICKER_TURN` rad per frame and logs tile counts and brightness per frame, to catch LOD flicker (`FLICKER_FORWARD`, `FLICKER_CLIMB` and `FLICKER_BOOST=1` also move the observer, and `PREFETCH=0` turns the terrain's prefetch off, to compare tiles waiting for data); `POST=0` draws without the post-processing pipeline (decision 138), `BLOOM=0`, `GRAIN=0` and `GRADE_TOD=0` leave single stages out, `MSAA=4` draws four samples per pixel as the app does (previews draw one), `TUNING='{…}'` and `TUNING_AIR='{…}'` override the cloud light's and the air's tuning (`CLOUD_LIGHT`, `AIR_LOOK`), `VOLTEST=1` puts a test height fog through the volumetric stage (`VOLSCALE`, `VOLDENSITY`), `PERF_POST=n` times the direct path against the pipeline in interleaved frames, and `tools/post.preview.ts` times each stage on a near-empty scene; sky and light views `sunrise,golden,golden-away,twilight6,twilight6-away,twilight12,moonlit,moonlit-range,stars` (decision 140), with `SUN_EL` (deg), `MORNING=1`, `MOON_AGE` (days), `OBS_HEADING=moon|antisun`, `HAZE`, `VIBRANCE`, `LOW_SUN_FILL`, `LOW_SUN_EXPOSURE`, `SKY_LIGHT`, `SKY_LEAN`, `DAYLIGHT`, `LIGHTS=0` (no lamps), `PERF_SKY=n` (LUT against march) and `OUT=dir`; shadows and ground (decision 139): `SHADOW=0`, `SHADOW_LIVE=1` (the per-frame bake), `SPARKLE=0`, `WET=x`, `TEMP_OFFSET` (°C, for snow), `PERF_SHADOW=n`; weather and volumetrics (decision 141): `WEATHER=<preset>` (`clear, fair, overcast, drizzle, rain, storm, snow, blizzard, fog, duststorm`), `QUALITY=low|medium|high`, `VOL=0`, `CLOUDS_3D=0`, `AIR=0`, `CIRRUS=x`, `PERF_VOL=n`, `FRAMES=n` with `FRAME_DT`; precipitation and lightning (decision 142): `RAIN=x`, `SNOW=x`, `DUST=x`, `PRECIP=0`, `PRECIP_DENSITY=x`, `LIGHTNING=<s>` (seconds into a strike) with `LIGHTNING_KM`, `LIGHTNING_SIDE` and `LIGHTNING_SEED`, `CAM_VEL=f[,r[,u]]` (m/s), `PERF_PRECIP=n`; `CLOUDS=0` hides clouds, `RIVERS=x` sets the sub-pixel river legibility (0 = true pixel fraction), `GRADE=0` leaves airfields ungraded, `FACETS=0` shades the terrain smoothly, without facets or per-face shades, `FARMLAND=0` leaves the fields out; forests (decisions 150, 153, 162, 166): views `treeline` (25 m over a river through dense forest), `canopy` (100 m), `woodland` (55 m over woods by the farmland target), `hedgerows` (60 m over the world's best hedge country), `roadrow` (120 m over a road with a row of trees) and `gallery` (40 m over a river through open land, with its woods and landmark trees), ground detail (decision 171): views `hover` (5 m) and `skid` (20 m) over the `meadow` target (open, unsettled grassland) and `nap` (60 m) over the farmland, `MICRO=x` scales the micro-facets (off by default since decision 197; `MICRO=1` turns them on) and `GLINT=x` their glints, `FURROWS=1` and `RIPPLES=1` turn on the crop furrows and sand ripples (off since decision 187), `COVER=0` leaves the ground cover out (decision 174), `WASH=speed[,radius]` puts a rotor's downwash on the ground `WASH_AT` m (default 12) ahead of the observer (decision 176), `SHELL=0` leaves the canopy shell out, `TREE_NEAR` and `TREE_EDGE` (m) set the tree ranges, `HEDGES=x` fixes the share of hedged field boundaries, `TARGET=<name>` moves any targeted view to another target (`mixed`, `farmland`, `hedges`, …); `SPOTS=all` or a list of `canyon,buttes,peaks,glacial,lake,skerries,delta,jungle,falls,reef,cliffs,marsh` adds observer views of the world's landscapes, found and framed by `tools/landscapeSpots.ts` (decision 126), and `tools/spots.preview.ts` lists them); `WONDERS=1` (or a list of feature ids) adds observer views at the war's wonders, sited and shaped as in the app (decision 221) and writes `tools/out/render-*.png`. `SCENE=strategic` draws the strategic view's `StrategicScene` instead from its own views (`globe,night,theater,region,floor,cities,capital,front,air,ground,winter,sharp`; `air` shows the air war over the first front a day in, `ground` the moved front and its unit symbols at the Region band a day in (decision 251), `FLIGHTS=0` leaves it out and `ROUTES=1` draws every route; `cities` and `capital` center on the Alliance capital; `sharp` is 1920 × 1080, `front` centers on the first front line, so use a seed that has one, e.g. `SEED=1`), with clouds, tile counts and frame times; `CVD=1` adds each image as seen with protanopia, deuteranopia and tritanopia (Part II check 4). Read them to judge shading and atmosphere. The simulation views stay within its 20 km envelope and the strategic views cover the map's bands (decision 128). The first run per world generates it (about 25 s); later runs load it from a disk cache in the OS temp directory. `LABELS=0` leaves the map's names out.
- **Vitest traps in tools:** `npx vitest run --disable-console-intercept <file>` takes the file as the flag's value and runs the whole suite, so put the file first. Vitest sets `process.env.MODE` to `test`, so a tool run under Vitest cannot take `MODE` from the environment. Transformed modules are cached in `node_modules/.vitest-cache` by the config file's content, not the environment: a scratch config that swaps modules by an environment variable needs `test.fsModuleCache: false`.
- **No GPU (cloud sessions):** `apt-get install -y mesa-vulkan-drivers` gives Dawn the lavapipe software Vulkan driver, so the GPU tests and `tools/render.preview.ts` run on the CPU (slowly: about 4 minutes per strategic view).
- **The real app in a browser:** with `npm run build && npm run preview` up, `node tools/browser.smoke.mjs` flies Free Flight in Chromium from the start screen through six scenes (fair at golden hour, storm, snow, fog at sunrise, moonlit night, dust storm) by way of the pause menu, takes off with the keyboard, then runs the campaign's simulation view, a weather override from the debug panel, the map and back, and the time controls (decision 144). It saves each scene and its state to `tools/out/browser/` and exits 1 on a page error, a console error, a WebGPU error, a lost device, a post-processing stage that gave up, a scene without its weather, a pause that does not hold or sound that does not start. The app hands the tool its state through `window.bearing`, which exists on the dev server and with `?dev`. Playwright is no dependency of the repo: `tools/browser/launch.mjs` looks in `PLAYWRIGHT_DIR`, `NODE_PATH` and `/opt/node-tools/node_modules`. `MODE=gpu` (the default where there is a display) first ran on the owner's machine on 2026-11-19 (decision 242); with `GPU_TIMING=1` it also records GPU time per view and pass.
- **No GPU, browser:** Chromium's own software WebGPU (SwiftShader) cannot run Bearing: the tile synthesizer's compute never finishes and the GPU process grows by 50 MB a second until the kernel kills it. `MODE=lavapipe` (the default on Linux without a display; needs `mesa-vulkan-drivers` and gcc) starts a hard-link copy of Playwright's Chromium in which `tools/browser/lvpshim.c` stands in for SwiftShader's library and forwards to lavapipe. Always the full Chromium (`channel: 'chromium'`): the headless shell loses the device when the canvas presents. The compositor cannot show what lavapipe drew, so the pictures are read back through the device (scene and HUD); the `-page` screenshots show the HTML over an empty canvas. The global pass takes 14 minutes in the browser there: write the world once with `npx vitest run --config vitest.tools.config.ts tools/browser.world.preview.ts` and pass `WORLD=tools/out/browser/world-1983` (7 s). A frame takes about 0.4 s at 640 × 360 and a run about five minutes. In the URL, `gres` is 512, 1024 or 2048; anything else means 1024.
- **Seeing models without a browser:** `npx vitest run --config vitest.tools.config.ts tools/models.preview.ts` renders every model spec (or `MODELS=a,b`; `SCHEME=` overrides the camouflage) on the CPU into `tools/out/model-<id>.png`: four shaded views over the same four as silhouettes (Part I check 6), and prints triangle counts against the budgets. The carrier's spec is generated by `tools/models/carrier.py`. `tools/trees.preview.ts` (same config) renders the tree kit in a row and a forest corner from a hovering helicopter and from above into `tools/out/trees-*.png` (`SHELL=1` adds the understory shell of decision 148, `SEED`); both share the rasterizer in `tools/modelRaster.ts`.
- **Relief at a point:** `LAT=… LON=… npx vitest run --config vitest.tools.config.ts tools/relief.preview.ts` shades the eroded global grid (300 km) and the synthesized level-7 tiles (40 km) around a point of the campaign world, and prints heights and the RMS height difference at several distances (how relief divides between long and short wavelengths). `EX` sets the shading's exaggeration; `GAIN`, `BAND_KM` and `DETAIL_GAIN` preview stronger local relief; `TUNING='{"gullies":0.4}'` overrides tile-synthesis tuning and `MASKS=1` maps the landform masks (decision 126).
- **Seeing terrain without a browser:** `npx vitest run --config vitest.tools.config.ts tools/terrain.preview.ts` runs the whole pipeline on Dawn and writes PNGs to `tools/out/`. Read them to judge changes.
- **TypeScript is pinned to 6.0.** TypeScript 7 (the native compiler) is out, but typescript-eslint 8.x supports only `<6.1`. See `docs/decisions.md`.
- Vite's cache lives in the OS temp directory (`cacheDir` in `vite.config.ts`), not `node_modules/.vite`, because the repo is in Dropbox and the in-tree cache fails with `EBUSY`. To clear it, delete `%TEMP%/vite-cache/bearing-*`.
- `node_modules/` and `dist/` carry the Dropbox "ignored" attribute so they don't sync. If you delete and recreate them, reapply it in PowerShell with `Set-Content -Path node_modules -Stream com.dropbox.ignored -Value 1`.
