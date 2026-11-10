# TODO

Tech-demo milestones from [docs/design.md](docs/design.md). Each task should take a few hours. Check tasks off as they are completed, and add subtasks as you discover them.

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
- [x] Continental crust field around two near-antipodal continent centers (decisions 17, 18)
- [x] Plate seeding steered into seeds inside the two continents (3 main, 2 second), the rest spread over the oceans (`rng("plates")`)
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

## Milestone 2: Erosion, rivers, tiles, LOD

- [x] Benchmark erosion memory and time on a global grid at 1024² and 2048² per face; choose the global grid resolution (decision 13): 1024², decision 27 (`tools/bench.preview.ts`)
- [x] Global grid on the GPU with cross-face neighbor addressing (plain WGSL on a raw device, decision 26; self-tests run in Vitest on Dawn and from the GUI)
- [x] Bake global maps into tiles with borders (GPU textures); M1 renders straight from the grid (same kernel as detail synthesis, no octaves at or above the global level; decision 28)
- [x] Detail noise stage on the GPU: ridged multifractal amplified by uplift, domain warping on coasts and ridges (upsamples the tectonic grid; `tools/terrain.preview.ts` renders it offline)
- [x] Hydraulic erosion compute pass on the global grid (stream power with rebound toward the tectonic height, Planchon–Darboux routing surface, gathered drainage; decision 23)
- [x] Thermal erosion compute pass (talus angle; symmetric pairwise exchange, mass-conserving)
- [x] Wire the GPU stages into the app: main-thread orchestrator after the worker's tectonic pass, progress UI, downsampled display in the M1 globe
- [ ] Checkpoint 1: owner review of eroded terrain, rivers and climate (in the browser and `tools/terrain.preview.ts`)
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
- [ ] Tile meshes with skirts and a float64 origin per tile (camera-relative)
- [ ] Tile normals; shader detail noise below the finest baked level
- [ ] Geomorphing so LOD changes don't pop
- [ ] Camera: terrain-aware near plane and ground clamp; flyable down to 500 m

## Milestone 3: Atmosphere, ocean, forests, sky

- [ ] Calendar and sun ephemeris in `core`: sun direction from `GameTime`, axial tilt, day length, year length and campaign start date, with tests (decision 15)
- [ ] Day/night lighting driven by the sun ephemeris; time-of-day slider in the debug GUI
- [ ] Single-scattering atmosphere: limb glow from orbit, sunset colors at the terminator
- [ ] Aerial perspective on terrain
- [ ] Ocean: depth-based color from bathymetry
- [ ] Ocean: wave normal map and sun glint
- [ ] Coastal foam
- [ ] Terrain shading: biome color blended by slope (rock), altitude (snow) and moisture; triplanar mapping on cliffs
- [ ] Seasonal snow line and seasonal vegetation tint
- [ ] Forest density map (also used later by line of sight)
- [ ] Instanced low-poly tree clusters within about 5 km of the camera
- [ ] River rendering from vector data (mask texture or decals)
- [ ] Cloud layer rendering, from a static field derived from moisture until live weather exists (M6)

## Milestone 4: Geography and front

- [ ] Landmass labeling (connected components); identify the two largest landmasses
- [ ] Ocean gap: shortest great-circle distance between the two continents' coasts, islands ignored (decision 16)
- [ ] Main-continent size and depth checks
- [ ] Reject and retry with seeded sub-seeds (`fork("retry-n")`), with a test for retry determinism
- [ ] Coarse pass wired end to end before the full pass
- [ ] Barrier map from river width, slope, ridge prominence and forest density
- [ ] Coast-to-coast maximum-barrier path search with a 35/65–50/50 area-ratio constraint
- [ ] Repeated search with corridor exclusion to get 3–4 defensive lines
- [ ] Start line placed one line forward of the strongest barrier
- [ ] Faction placement: NATO holds the side nearer the second continent
- [ ] Invasion corridors: low-barrier segments with good access (refine with roads after milestone 5)
- [ ] Pre-bake the contested region to tile level 7 (about 48 m) during world generation
- [ ] Strategic map overlay for defensive lines, start line and corridors

## Milestone 5: Settlements, roads, airbases

- [ ] Settlement site scoring (river confluences, coasts, fertile lowlands); placement with population
- [ ] Ports on the coasts facing the ocean gap
- [ ] Movement cost map from slope, terrain and water
- [ ] Least-cost road paths between settlements, merged where they overlap
- [ ] Bridges at river crossings, as targetable features
- [ ] Airbase site search on flat, low terrain near roads
- [ ] Airbase density by distance behind the front (densest 100–400 km back); strategic bomber bases far from the front
- [ ] Road rendering
- [ ] Settlement building clusters scaled by population
- [ ] Night-side settlement lights
- [ ] Airbase runway meshes

## Milestone 6: Simulation core and weather

- [ ] Sim worker host: message protocol and state snapshots to the main thread (evaluate transferables vs. SharedArrayBuffer)
- [ ] Float64 game clock and time acceleration (pause, 1×, 4×, 16×, 64×, 256×)
- [ ] Discrete-event scheduler (priority queue with deterministic tie-breaking)
- [ ] Fixed-tick processes (1 game minute) interleaved with events in time order
- [ ] Determinism test: 1× and 64× give identical state at a given game time
- [ ] Time-control UI with calendar date and local time display, and auto-slowdown on flagged events
- [ ] Weather model: coarse global grid (about 50–100 km cells), hourly ticks, `rng(seed, "weather")`, driven by the climate maps and season (decision 15)
- [ ] Weather fields for operations: cloud cover and ceiling, visibility, precipitation, wind at several levels
- [ ] Weather determinism test across time acceleration
- [ ] Clouds rendered from the live weather field (replaces the static M3 field)
- [ ] Benchmark: how many battalions plus weather the worker handles at 256×

## Milestone 7: Flights, convoys, formations

- [ ] Great-circle route math with climb and descent profiles; analytic position(t)
- [ ] Flight scheduling between airbases (20–50 aircraft), with the range factor applied to fuel
- [ ] Weather and daylight in flight operations: cancellations below minimums, winds aloft in ground speed, day/night sortie mix
- [ ] Convoys on great-circle sea routes between ports
- [ ] Order of battle: division / brigade / battalion data model with per-unit seeds (ready for promotion)
- [ ] Initial deployment along the start line
- [ ] Lanchester-style aggregate combat per tick, with terrain, posture, supply, support and weather modifiers
- [ ] Front segment movement by local force balance, slowed by barriers
- [ ] Scripted Pact offensive along the corridors
- [ ] Display: faction icons and route lines from orbit; NATO-style unit symbols
- [ ] Low-poly aircraft and ship meshes below about 50 km altitude
- [ ] Smooth transition to a chase camera when a flight is selected

## Milestone 8: Polish

- [ ] Generation profiling and progress polish (no time budget, decision 12)
- [ ] Rendering performance pass (GPU timestamp queries, frame budget)
- [ ] Bundle size and code splitting
- [ ] Scripted flythrough camera path for screenshots, including a dawn and a weather front
- [ ] Check every demo goal against the design doc and decisions

## After the demo

- Entity promotion and ground behaviors
- Cockpit flight for attack aircraft and helicopters
- Air combat
- Naval combat
- The campaign economy
