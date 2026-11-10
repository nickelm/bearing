# TODO

Tech-demo milestones from [docs/design.md](docs/design.md) (revision 4: nine milestones, after a milestone 0 scaffold). Each task should take a few hours. Check tasks off as they are completed, and add subtasks as you discover them.

## Milestone 0: Scaffold

- [x] Toolchain: TypeScript (strict), Vite, Vitest, ESLint, Prettier, Three.js r187 (`three/webgpu`, `three/tsl`), lil-gui
- [x] Directory layout (`core`, `worldgen`, `sim`, `render`, `ui`, `workers`)
- [x] Lint rules for layering (`no-restricted-imports`) and determinism (no `Math.random` in core/worldgen/sim)
- [x] `core/units`: SI constants, `GameTime`
- [x] `core/vec3d` and `core/coords`: Cartesian ↔ geodetic ↔ cube-face UV (equi-angular), with tests
- [x] `core/rng`: SplitMix64, xoshiro128\*\*, named streams and forks, with tests
- [x] Hello globe: cube-sphere colored by face, camera-relative rendering, altitude-aware orbit camera
- [x] Debug GUI (seed, regenerate, subdivisions, wireframe, status) and frame-time overlay
- [x] WebGPU requirement checks (pre-init probe and post-init backend check)
- [x] GPU compute smoke test and sim-worker ping with a cross-context determinism check
- [x] README, CLAUDE.md, TODO.md, docs/decisions.md; git repository

## Milestone 1: Globe skeleton

- [x] Cube-sphere cell grid: `CubeGrid(resolution)` with cell index ↔ (face, i, j), cell-center directions and cell areas
- [x] Neighbor lookup across face seams and corners (4- and 8-neighborhoods), with tests
- [x] Tile key type `(face, level, x, y)`: parent/child/neighbor math, texel ↔ direction, string key for streams and caches, with tests (decision 13)
- [x] Seeded 3D noise (Perlin, fBm, ridged) and a deterministic min-heap in `core`
- [x] Continental crust field around two near-antipodal continent centers (decisions 17, 18; replaced by crust from plate types, decision 46)
- [x] Plate seeding steered into seeds inside the two continents (3 main, 2 second), the rest spread over the oceans (`rng("plates")`; replaced by unsteered plates, decision 46)
- [x] Plate growth by randomized weighted flood fill; a motion vector (Euler pole) per plate
- [x] Plate boundary detection and classification (convergent / divergent / transform × continental / oceanic)
- [x] Uplift field: continental collision ranges, trenches and island arcs, mid-ocean ridges, with distance-to-boundary falloff
- [x] Base elevation from crust type plus uplift, scaled by `reliefScale` (decision 14); sea level set at the `oceanFraction` height percentile
- [x] Provisional climate (temperature from latitude and altitude, banded moisture, no seasons) and a stylized biome palette
- [x] Globe mesh on the cell grid: seam-free averaged heights/normals/colors, exaggeration slider, biome coloring (CPU mesh; GPU tiles in M2)
- [x] Debug views: biome, height, plates, boundaries, crust, uplift, temperature, moisture, cube faces
- [x] Run generation in a worker with transferable typed arrays; per-stage progress UI and cancel
- [x] Parameter sliders (plate count, ocean fraction, relief scale, temperature offset, moisture scale) driving regeneration
- [x] Determinism tests: same seed gives the same height hash; changing one stage's parameters leaves other streams untouched
- [x] Per-stage timing log
- [x] Offline map preview tool (`npm run maps`) so worlds can be inspected without a browser
- [x] Review fixes: irregular polar caps, warped climate bands, temperate east–west continents (decisions 20, 21)
- [x] Owner review in the browser: tune continent shapes, range widths and biome palette from feedback

## Milestone 2: Erosion, rivers, tiles, LOD (done)

- [x] Benchmark erosion memory and time on a global grid at 1024² and 2048² per face; choose the global grid resolution (decision 13): 1024², decision 27 (`tools/bench.preview.ts`)
- [x] Global grid on the GPU with cross-face neighbor addressing (plain WGSL on a raw device, decision 26; self-tests run in Vitest on Dawn and from the GUI)
- [x] Bake global maps into tiles with borders (GPU textures); M1 renders straight from the grid (same kernel as detail synthesis, no octaves at or above the global level; decision 28)
- [x] Detail noise stage on the GPU: ridged multifractal amplified by uplift, domain warping on coasts and ridges (upsamples the tectonic grid; `tools/terrain.preview.ts` renders it offline)
- [x] Hydraulic erosion compute pass on the global grid (stream power with rebound toward the tectonic height, Planchon–Darboux routing surface, gathered drainage; decision 23)
- [x] Thermal erosion compute pass (talus angle; symmetric pairwise exchange, mass-conserving)
- [x] Wire the GPU stages into the app: main-thread orchestrator after the worker's tectonic pass, progress UI, downsampled display in the M1 globe
- [x] Checkpoint 1: owner review of eroded terrain, rivers and climate (in the browser and `tools/terrain.preview.ts`)
- [x] Flow direction and flow accumulation maps (CPU in the worker: Priority-Flood+ε, D8, Turc–Pike runoff accumulated to m³/s, lakes; about 2 s at 1024²)
- [x] River extraction: threshold the accumulation into vector polylines with a width per segment (w = 4·√Q m)
  - [x] Spatial index of river segments by tile key (needed by detail tile synthesis)
- [x] Climate stage proper: seasonal temperature range from axial tilt, prevailing-wind moisture with rain shadows, Whittaker biomes (replaces the provisional climate)
  - [x] Recompute biomes on the eroded global grid (lapse-corrected temperature, upsampled precipitation)
- [x] Detail tile synthesis on the GPU: global maps + detail noise + local erosion constrained by global rivers; per-tile `fork(tileKey)` (erosion filter and river carving as a pure function of direction, decisions 24, 28; `tools/tiles.preview.ts`)
- [x] Tile borders and seam tests: neighboring tiles agree on shared texels whatever the generation order (bit-exact within a face, < 5 cm across face seams)
- [x] Tile cache: GPU/CPU LRU with a memory budget; on-demand generation queue (`render/terrain/tileCache.ts`; textures attach in the tile renderer)
- [x] IndexedDB persistence for generated worlds and tiles, keyed by seed, parameters and generator version (moved from M8, decision 12): worlds only, tiles regenerate faster than they load (decision 29)
- [x] Terrain quadtree per cube face on the same tile keys, refined by screen-space error (conservative cap horizon culling, frustum culling, parent fallback while children load)
- [x] Tile meshes with skirts and a float64 origin per tile (camera-relative; built on the CPU, decision 30)
- [x] Tile normals; shader detail noise below the finest baked level (CPU render-detail noise instead, decision 30)
- [x] Geomorphing so LOD changes don't pop (morph toward the parent's actual surface)
- [x] Checkpoint 2: owner review of the tiled terrain in the browser, orbit to 500 m
  - [x] Exaggeration changes without rebuilding meshes (decision 31)
  - [x] Thin rivers drawn as continuous lines on diagonals (wider coverage mask; true channels stay)
  - [x] One "Color by" list for grid and tiles; grid-only modes switch the display to the grid
- [x] Camera: terrain-aware near plane and ground clamp; flyable down to 500 m (heading, WASD/QE/RF flight, tilt to 87° below 50 km)

## Milestone 3: Atmosphere, ocean, forests, sky

- [x] Headless render harness: three's `WebGPURenderer` on Dawn in Node, rendering fixed views to PNG (`tools/render.preview.ts`) and compiling every material in a test
- [x] Calendar and sun ephemeris in `core`: sun direction from `GameTime`, axial tilt, day length, year length and campaign start date, with tests (decision 15)
- [x] Day/night lighting driven by the sun ephemeris; time-of-day slider in the debug GUI
- [x] Single-scattering atmosphere: limb glow from orbit, sunset colors at the terminator
- [x] Aerial perspective on terrain
- [x] Climate array texture (sea-level temperature, seasonal range, moisture, cloudiness) with a TSL cube-face lookup by direction
- [x] Ocean: depth-based color from bathymetry
- [x] Ocean: wave normal map and sun glint
- [x] Coastal foam
- [x] Checkpoint 3: owner review of day/night, sky, aerial perspective and ocean in the browser
  - [x] Lakes: per-sample lake level from the tile kernel, drawn flat with a shoreline from the fine terrain (decision 40)
  - [x] Smooth lowlands: plains detail scales with the global slope; lake beds carry no detail
- [x] Terrain shading: biome color blended by slope (rock), altitude (snow) and moisture; triplanar mapping on cliffs
- [x] Seasonal snow line and seasonal vegetation tint (plus frozen lakes)
- [x] Forest density map (also used later by line of sight)
- [x] Instanced low-poly tree clusters within about 5 km of the camera
- [x] River rendering from vector data (per-fragment distance to segment lists, decision 54); replaces the per-vertex river coverage from checkpoint 2
- [x] Cloud layer rendering, from a static field derived from moisture until live weather exists (M6) (decision 55)
- [x] Checkpoint 4: owner review of terrain shading, seasons, forests, rivers and clouds
  - [x] No river channels carved into lake beds
  - [x] Clouds advected by latitude-dependent zonal winds (decision 58)

### Known issues

- [ ] Intermittent GPU determinism flake in Vitest (about 1 run in 5–10 of the full suite): a GPU determinism test (`detailStage`, `tileSynth`) gets different results for two identical runs. Present at the M2 baseline; not reproduced by 40 back-to-back detail-stage runs under load. Tests now report how many values differ and whether they are zeros (a readback race in Dawn's Node bindings would show zeros). First report (2026-11-10): 24 of 221k cells differ, worst 0.23 m, no zeros, in the single-dispatch detail kernel (pure per cell, no in-place neighbor reads). So it is not a readback race; suspect the GPU or driver under concurrent load. Check whether it happens with `--no-file-parallelism`, and on another GPU.

## Milestone 4: Reading the world

The strategic graph is the only view of the world that theater detection, casting and the command layer get (decision 52). Generation is unsteered (decision 46).

### Unsteered generation and the coarse pass

- [x] Unsteered generation: uniform plate seeding, plate types from `rng("plates")`, crust from plate types; remove the two-continent layout and `oceanGap` (decision 46)
- [ ] Landmass labeling with statistics: area, centroid, coastline length, latitude span, terrain mix (extends `worldgen/landmasses.ts`)
- [ ] Coarse pass end to end: stages 1–9 at 256² per face (tectonic grid plus a reduced global erosion and drainage pass) in the worker; time it and report it in the progress UI

### Strategic graph

- [ ] Graph types in `worldgen/strategic/graph.ts`: landmass and archipelago nodes, sea-lane edges, chokepoints, barrier lines; packed into transferable buffers and stored in the world record (bump `GENERATOR_VERSION`)
- [ ] Airbase capacity per landmass: flat, low land (slope and height thresholds) counted as candidate airbase sites
- [ ] Candidate port sites per landmass: sheltered coast with deep water close inshore
- [ ] Archipelago nodes: merge islands under about 2,000 km² by coast-to-coast distance within strike range (single linkage)
- [ ] Coarse ocean grid (about 25–50 km cells) with a cost field: open water, shallows, sea ice
- [ ] Sea-lane edges: least-cost routes from port site to port site between landmass node pairs, with length and the minimum width of water along the route
- [ ] Chokepoints: straits under about 150 km and islands that could host an airfield within about 300 km of a lane; record which lanes each one controls

### Front generator

- [ ] Barrier map per land cell from river width, slope, ridge prominence and forest density (decision 44)
- [ ] Coast-to-coast maximum-barrier path search with the area constraint (each side at least 35% of the landmass)
- [ ] Repeated search with exclusion corridors to get 3–4 roughly parallel defensive lines; store them as the landmass node's barrier lines
- [ ] Start line one line forward of the strongest barrier; invasion corridors on weak segments of each line (refine with roads in milestone 5)

### Theaters

- [ ] Theater module interface (precondition on the graph, fit score, instantiation) and a registry
- [ ] Continental front theater
- [ ] Sea-lane theater (800–3,000 km lane from a rear-base landmass to a front)
- [ ] Chokepoint theater (chokepoint on an active sea lane)
- [ ] Island campaign theater (archipelago and small landmass nodes in mutual strike range, no front-sized landmass)
- [ ] Strategic theater (industry and logistics targets, air defense belts)
- [ ] Validity check: flat land for at least 15 airbases per side and at least one theater above its fit threshold; retry with seeded sub-seeds `fork("retry-n")`, with a test that each seed maps to exactly one world

### Casting

- [ ] Cast data type (theaters, territory per side, posture, range factor, logistics links, regions) stored with the world; theater selection above fit thresholds from `rng("casting")` (decision 47)
- [ ] Territory assignment: the Pact takes mass and interior lines, the Alliance takes the side next to its rear base and sea lanes; island campaign variant
- [ ] Posture (the Pact attacks by default) and logistics links between theaters (a cut lane starves a front, a lost chokepoint exposes convoys)
- [ ] Range factor search in [0.35, 1.0] from the two reach targets (decision 51)
- [ ] Industry, port and base regions for each side, consistent with territory and theaters (milestone 5 places the sites)
- [ ] Briefing text generated from the cast: the theaters, the stakes in each, the first expected moves
- [ ] Regional bake: pre-bake ground-combat regions to tile level 7 (about 48 m) during world generation

### Tools and review

- [ ] Strategic graph debug overlay on the globe: nodes, sea lanes, chokepoints, barrier lines, start line, corridors, theater boundaries
- [ ] Graph overlay mode in `npm run maps`, so detection can be checked without a browser
- [ ] Seed browser: a CLI table first (`npm run seeds`: theaters, fit scores, range factor, retries per seed), then a GUI panel
- [ ] Tune the theater fit thresholds from seed browser statistics (design open question)
- [ ] Determinism tests: graph and cast identical across runs; changing casting leaves the graph unchanged
- [ ] Checkpoint 5: owner review of the graph overlay, theaters and briefings across many seeds

## Milestone 5: Settlements, roads, ports, airbases (placed from the cast)

- [ ] Settlement site scoring (river confluences, coasts, fertile lowlands); placement with population, denser in each side's industry regions
- [ ] Ports at the cast's port sites (sea-lane ends, island ports)
- [ ] Movement cost map from slope, terrain and water
- [ ] Least-cost road paths between settlements, merged where they overlap
- [ ] Bridges at river crossings, as targetable features
- [ ] Airbase site search on flat, low terrain near roads
- [ ] Airbase density by distance behind each front (densest 100–400 km back); strategic bomber bases far from the front
- [ ] Island airfields and forward airfields at chokepoints
- [ ] Industry and logistics sites as targets for the strategic theater
- [ ] Refine invasion corridors with the road network
- [ ] Road rendering
- [ ] Settlement building clusters scaled by population
- [ ] Night-side settlement lights
- [ ] Airbase runway meshes

## Milestone 6: Simulation core and weather

- [ ] Sim worker host: message protocol and state snapshots to the main thread as transferable buffers (decision 40)
- [ ] Float64 game clock and time acceleration (pause, 1×, 4×, 16×, 64×, 256×)
- [ ] Discrete-event scheduler (priority queue with deterministic tie-breaking)
- [ ] Fixed-tick processes (1 game minute) interleaved with events in time order
- [ ] Determinism test: 1× and 64× give identical state at a given game time
- [ ] Time-control UI with calendar date and local time display, and auto-slowdown on flagged events
- [ ] Weather model: coarse global grid (about 50–100 km cells), hourly ticks, `rng(seed, "weather")`, driven by the climate maps and season (decision 15)
- [ ] Weather fields for operations: cloud cover and ceiling, visibility, precipitation, wind at several levels
- [ ] Weather determinism test across time acceleration
- [ ] Clouds rendered from the live weather field (replaces the static M3 field)

## Milestone 7: Air tasking and mission search

### Data model and flight

- [ ] Aircraft type table for both sides: fictional names, reference type, role, speeds, ceiling, combat radius before the range factor, loadouts
- [ ] Squadrons, bases and inventories per side (aircraft, readiness, stocks)
- [ ] Carrier groups as mobile bases on analytic sea routes; air wings launch and recover at the group's predicted position (decision 56)
- [ ] Mission model: type, side, theater, package, target or station, phase timeline, originating need and score (decision 50), per-mission seed ready for promotion
- [ ] Great-circle routes with climb and descent profiles; analytic position(t); fuel with the cast's range factor (decision 51)
- [ ] Phase timeline per mission type (departure, climb-out, ingress, fence-in, on target or on station, egress, approach, recovery) as scheduled events

### Intelligence (decisions 53, 57)

- [ ] Per-side intelligence store: contacts with position, type, last seen, confidence and source; decay with age; determinism test
- [ ] Satellite orbits: circular Keplerian orbits from GM = g·R², sun-synchronous node precession, analytic ground tracks and passes over a point; tests for period and pass times
- [ ] Satellite classes and per-side constellations modeled on Cold War systems (film-return, digital electro-optical, radar and ELINT ocean reconnaissance, late radar imaging); sensor field of regard tuned to Cold War revisit times, with a revisit-statistics test
- [ ] Imaging conditions: optical needs daylight and clear sky from the weather field; radar ocean reconnaissance sees ships through cloud; ELINT sees only emitters
- [ ] Delivery delays: film capsules on a recovery schedule, digital imagery after processing, ocean reconnaissance within minutes; contacts stamped at observation time and delivered later
- [ ] Radar air picture: ground radar and AWACS coverage with radar horizon and terrain masking; feeds Pact ground-controlled interception
- [ ] Reconnaissance missions refresh contacts along their routes

### Air tasking order (decision 50)

- [ ] Need collection from fronts: CAS for segments under pressure, interdiction of supply behind the front (known contacts only)
- [ ] Need collection from sea lanes, chokepoints, islands and strategic targets: CAP over high-value assets, convoy escort and attack, strikes on industry and air defenses, resupply and airlift
- [ ] Priority score (theater weight × target value × urgency) with deterministic tie-breaking
- [ ] Package builder: flights from squadrons in range; escort and SEAD when the target area is defended
- [ ] Doctrine scheduler: Pact strikes in large waves, Alliance missions spread evenly; daily ATO plus a replanning tick every few game hours
- [ ] Weather and daylight in tasking: cancellations below minimums, winds aloft in ground speed, night and bad-weather low-level strikes
- [ ] Aggregate mission resolution: target damage and losses from package composition, defenses and weather
- [ ] Concurrency cap so that 20–50 aircraft are airborne
- [ ] Determinism tests: identical ATO at 1× and 64×, and independent of the viewing side (decision 48)

### Mission search and display

- [ ] Debug GUI toggle for the viewing side (developer tool until milestone 9)
- [ ] Mission icons and route lines from orbit
- [ ] Low-poly aircraft meshes below about 50 km altitude
- [ ] Mission search panel: ongoing and upcoming missions of the viewing side
- [ ] Filters: mission type, aircraft, theater, current phase, threat level, time until action
- [ ] Focus the camera on a selected mission; smooth transition to a chase camera on one of its aircraft
- [ ] Subscriptions: a saved query plus a phase triggers auto-slowdown to 1× and offers the mission
- [ ] Intelligence overlay: the viewing side's contacts and satellite tracks
- [ ] Follow representative sorties to judge the range factor (design open question)
- [ ] Checkpoint 6: owner review of the ATO, mission search, subscriptions and the chase camera

## Milestone 8: Ground and naval aggregates

- [ ] Order of battle: division / brigade or regiment / battalion data model with per-unit seeds (ready for promotion)
- [ ] Initial deployment along each front's start line, and island garrisons
- [ ] Lanchester-style aggregate combat per tick, with terrain, posture, supply, artillery, air support (from mission resolution) and weather modifiers
- [ ] Front segment movement by local force balance, slowed by barriers
- [ ] Offensives by cast posture along the invasion corridors
- [ ] Supply: interdiction cuts it, convoy arrivals deliver reinforcements and supplies to the receiving theater
- [ ] Convoys on sea-lane routes between ports; analytic position(t)
- [ ] Amphibious groups for island campaigns and chokepoint seizures; theater tasking of carrier groups (their movement and air wings come from milestone 7)
- [ ] Display: unit symbols for battalions from orbit; low-poly ship meshes below about 50 km
- [ ] Benchmark: how many battalions plus weather the worker handles at 256×

## Milestone 9: Polish

- [ ] Side selection at campaign start, with the generated briefing
- [ ] Cache the strategic graph and the cast with the world in IndexedDB
- [ ] Generation profiling and progress polish (no time budget, decision 12)
- [ ] Rendering performance pass (GPU timestamp queries, frame budget); consider building tile meshes in a worker (decision 30)
- [ ] Tree LOD: one cone per clump beyond about 2 km, or impostors (decision 45: ~6.6 M triangles over dense forest at the default 5 km range)
- [ ] Denser forests: closer clump spacing in closed-canopy biomes, paid for by the tree LOD (owner request at checkpoint 4)
- [ ] Bundle size and code splitting
- [ ] Scripted flythrough camera path for screenshots, including a dawn and a weather front
- [ ] Check every demo goal against the design doc and decisions

## After the demo

- Entity promotion and ground behaviors
- Cockpit flight and jump-in, then flight stick support
- Air combat
- Naval combat
- The campaign economy
