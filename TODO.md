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

- [ ] Cube-sphere cell grid: `CubeGrid(resolution)` with cell index ↔ (face, i, j), cell-center directions and cell areas
- [ ] Neighbor lookup across face seams and corners (4- and 8-neighborhoods), with tests
- [ ] Plate seeding steered into two continental clusters 90–130° apart, with oceanic plates between them (`rng("plates")`)
- [ ] Plate growth by randomized weighted flood fill; a motion vector (Euler pole) per plate
- [ ] Plate boundary detection and classification (convergent / divergent / transform × continental / oceanic)
- [ ] Uplift field: continental collision ranges, trenches and island arcs, mid-ocean ridges, with distance-to-boundary falloff
- [ ] Base elevation from crust type plus uplift; sea level set at the `oceanFraction` height percentile
- [ ] Provisional climate (temperature from latitude and altitude, banded moisture) and a stylized biome palette
- [ ] Bake height and biome into per-face textures at coarse resolution (256²)
- [ ] Globe material: displace by height (with an exaggeration slider) and color by biome, replacing the debug face colors
- [ ] Debug views: plate IDs, boundary types, uplift
- [ ] Run generation in a worker with progress reporting and transferable typed arrays
- [ ] Parameter sliders (plate count, ocean fraction, temperature offset, moisture scale) driving regeneration
- [ ] Determinism tests: same seed gives the same height hash; changing one stage's parameters leaves other streams untouched
- [ ] Per-stage timing log

## Milestone 2: Erosion, rivers, LOD

- [ ] Detail noise stage on the GPU: ridged multifractal amplified by uplift, domain warping on coasts and ridges
- [ ] GPU height-map layout per face with seam handling (shared edges or border texels)
- [ ] Hydraulic erosion compute pass with cross-face neighbors
- [ ] Thermal erosion compute pass (talus angle)
- [ ] Erosion benchmark at coarse and full resolution; tune iterations to the 30 s budget
- [ ] Flow direction and flow accumulation maps
- [ ] River extraction: threshold the accumulation into vector polylines with a width per segment
- [ ] Quadtree per cube face, refined by screen-space error
- [ ] Tile meshes with skirts and a float64 origin per tile (camera-relative)
- [ ] Tile heights from baked maps plus shader detail noise; normals
- [ ] Tile cache and streaming; geomorphing so LOD changes don't pop
- [ ] Camera: terrain-aware near plane and ground clamp; flyable down to 500 m
- [ ] High-resolution regional bake (about 50 m): design and prototype

## Milestone 3: Atmosphere, ocean, forests

- [ ] Single-scattering atmosphere: limb glow from orbit
- [ ] Aerial perspective on terrain
- [ ] Ocean: depth-based color from bathymetry
- [ ] Ocean: wave normal map and sun glint
- [ ] Coastal foam
- [ ] Terrain shading: biome color blended by slope (rock), altitude (snow) and moisture; triplanar mapping on cliffs
- [ ] Forest density map (also used later by line of sight)
- [ ] Instanced low-poly tree clusters within about 5 km of the camera
- [ ] River rendering from vector data (mask texture or decals)
- [ ] Stretch: 2D cloud shell driven by the moisture map

## Milestone 4: Geography and front

- [ ] Landmass labeling (connected components); identify the two largest landmasses
- [ ] Ocean gap measurement between the two continents
- [ ] Main-continent size and depth checks
- [ ] Reject and retry with seeded sub-seeds (`fork("retry-n")`), with a test for retry determinism
- [ ] Coarse pass wired end to end before the full pass
- [ ] Barrier map from river width, slope, ridge prominence and forest density
- [ ] Coast-to-coast maximum-barrier path search with a 35/65–50/50 area-ratio constraint
- [ ] Repeated search with corridor exclusion to get 3–4 defensive lines
- [ ] Start line placed one line forward of the strongest barrier
- [ ] Faction placement: NATO holds the side nearer the second continent
- [ ] Invasion corridors: low-barrier segments with good access (refine with roads after milestone 5)
- [ ] Strategic map overlay for defensive lines, start line and corridors

## Milestone 5: Settlements, roads, airbases

- [ ] Settlement site scoring (river confluences, coasts, fertile lowlands); placement with population
- [ ] Ports on coasts facing the ocean gap
- [ ] Movement cost map from slope, terrain and water
- [ ] Least-cost road paths between settlements, merged where they overlap
- [ ] Bridges at river crossings, as targetable features
- [ ] Airbase site search on flat, low terrain near roads
- [ ] Airbase density by distance behind the front (densest 100–400 km back); strategic bomber bases far from the front
- [ ] Road rendering
- [ ] Settlement building clusters scaled by population
- [ ] Airbase runway meshes

## Milestone 6: Simulation core

- [ ] Sim worker host: message protocol and state snapshots to the main thread (evaluate transferables vs. SharedArrayBuffer)
- [ ] Float64 game clock and time acceleration (pause, 1×, 4×, 16×, 64×, 256×)
- [ ] Discrete-event scheduler (priority queue with deterministic tie-breaking)
- [ ] Fixed-tick processes (1 game minute) interleaved with events in time order
- [ ] Determinism test: 1× and 64× give identical state at a given game time
- [ ] Time-control UI with auto-slowdown on flagged events
- [ ] Benchmark: how many battalions the worker handles at 256×

## Milestone 7: Flights, convoys, formations

- [ ] Great-circle route math with climb and descent profiles; analytic position(t)
- [ ] Flight scheduling between airbases (20–50 aircraft), with the range factor applied to fuel
- [ ] Convoys on great-circle sea routes between ports
- [ ] Order of battle: division / brigade / battalion data model with per-unit seeds (ready for promotion)
- [ ] Initial deployment along the start line
- [ ] Lanchester-style aggregate combat per tick, with terrain, posture, supply and support modifiers
- [ ] Front segment movement by local force balance, slowed by barriers
- [ ] Scripted Pact offensive along the corridors
- [ ] Display: faction icons and route lines from orbit; NATO-style unit symbols
- [ ] Low-poly aircraft and ship meshes below about 50 km altitude
- [ ] Smooth transition to a chase camera when a flight is selected

## Milestone 8: Polish

- [ ] IndexedDB cache of baked maps and vector data, keyed by seed, parameters and generator version
- [ ] Generation profiling to meet the 30 s budget on a mid-range laptop
- [ ] Rendering performance pass (GPU timestamp queries, frame budget)
- [ ] Bundle size and code splitting
- [ ] Scripted flythrough camera path for screenshots
- [ ] Check every demo goal against the design doc

## After the demo

- Entity promotion and ground behaviors
- Cockpit flight for attack aircraft and helicopters
- Air combat
- Naval combat
- The campaign economy
