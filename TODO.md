# TODO

Tech-demo milestones from [docs/design.md](docs/design.md) (revision 9, decisions 72, 94 and 161): a foundation (F), a strategic track (S), a simulation core track (C), a flight view track (V) and integration (I), after a scaffold, then a post-demo piloting track (P, decisions 94 and 189) and helicopter track (H, decision 149), the terrain networks track (N, decision 161), the ground detail track (G, decision 168) and the world diversity track (W, decision 204). The design doc's _Milestones_ section maps the old M1–M9 onto these. Each task should take a few hours. Check tasks off as they are completed, and add subtasks as you discover them.

Suggested order for the remaining work: S1, V1, S2, V2, the rest of S3 and S4, V3, C2, V4, C3, I1. Visual milestones (all S, V, I, P, H and G, N3, N6, N7 and N8, and W3, W4 and W6–W9) close only after the acceptance checks in [docs/visual-style.md](docs/visual-style.md) for the views they touch: Part I for the simulation view, Part II for the strategic view.

## Scaffold (done)

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

## Foundation

### F1. Globe skeleton (done; old M1)

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
- [x] Globe mesh on the cell grid: seam-free averaged heights/normals/colors, exaggeration slider, biome coloring (CPU mesh; GPU tiles in F2/V1)
- [x] Debug views: biome, height, plates, boundaries, crust, uplift, temperature, moisture, cube faces
- [x] Run generation in a worker with transferable typed arrays; per-stage progress UI and cancel
- [x] Parameter sliders (plate count, ocean fraction, relief scale, temperature offset, moisture scale) driving regeneration
- [x] Determinism tests: same seed gives the same height hash; changing one stage's parameters leaves other streams untouched
- [x] Per-stage timing log
- [x] Offline map preview tool (`npm run maps`) so worlds can be inspected without a browser
- [x] Review fixes: irregular polar caps, warped climate bands, temperate east–west continents (decisions 20, 21)
- [x] Owner review in the browser: tune continent shapes, range widths and biome palette from feedback

### F2. World data (done; data half of old M2)

- [x] Benchmark erosion memory and time on a global grid at 1024² and 2048² per face; choose the global grid resolution (decision 13): 1024², decision 27 (`tools/bench.preview.ts`)
- [x] Global grid on the GPU with cross-face neighbor addressing (plain WGSL on a raw device, decision 26; self-tests run in Vitest on Dawn and from the GUI)
- [x] Bake global maps into tiles with borders (GPU textures); F1 renders straight from the grid (same kernel as detail synthesis, no octaves at or above the global level; decision 28)
- [x] Detail noise stage on the GPU: ridged multifractal amplified by uplift, domain warping on coasts and ridges (upsamples the tectonic grid; `tools/terrain.preview.ts` renders it offline)
- [x] Hydraulic erosion compute pass on the global grid (stream power with rebound toward the tectonic height, Planchon–Darboux routing surface, gathered drainage; decision 23)
- [x] Thermal erosion compute pass (talus angle; symmetric pairwise exchange, mass-conserving)
- [x] Wire the GPU stages into the app: main-thread orchestrator after the worker's tectonic pass, progress UI, downsampled display in the F1 globe
- [x] Checkpoint 1: owner review of eroded terrain, rivers and climate (in the browser and `tools/terrain.preview.ts`)
- [x] Flow direction and flow accumulation maps (CPU in the worker: Priority-Flood+ε, D8, Turc–Pike runoff accumulated to m³/s, lakes; about 2 s at 1024²)
- [x] River extraction: threshold the accumulation into vector polylines with a width per segment (w = 4·√Q m)
  - [x] Spatial index of river segments by tile key (needed by detail tile synthesis)
- [x] Climate stage proper: seasonal temperature range from axial tilt, prevailing-wind moisture with rain shadows, Whittaker biomes (replaces the provisional climate)
  - [x] Recompute biomes on the eroded global grid (lapse-corrected temperature, upsampled precipitation)
- [x] Detail tile synthesis on the GPU: global maps + detail noise + local erosion constrained by global rivers; per-tile `fork(tileKey)` (erosion filter and river carving as a pure function of direction, decisions 24, 28; `tools/tiles.preview.ts`)
- [x] Tile borders and seam tests: neighboring tiles agree on shared texels whatever the generation order (bit-exact within a face, < 5 cm across face seams)
- [x] Tile cache: GPU/CPU LRU with a memory budget; on-demand generation queue (`render/common/terrain/tileCache.ts`; textures attach in the tile renderer)
- [x] IndexedDB persistence for generated worlds and tiles, keyed by seed, parameters and generator version (moved from old M8, decision 12): worlds only, tiles regenerate faster than they load (decision 29)

## Strategic track

### S1. Illustrated base map

The strategic view from [docs/visual-style.md](docs/visual-style.md) Part II: globe to a ~100 km zoom floor, its own scene, camera and look. Day, night and weather stay on the map (decision 72).

- [x] Check decision 71 in the browser: forest edges, town patches from 500 m to orbit, road network continuity, frame time with trees and buildings off (carried from old M5)
- [x] Split `src/render/` into `common/` (camera-relative helpers, shared materials, palette, render scale), `sim/` (the current terrain, atmosphere, water, clouds, forest and infra folders) and `strategic/`; no behavior change, tests and previews still pass; update CLAUDE.md's directory map
- [x] `StrategicScene` beside the existing scene (later `SimScene`), both resident; debug GUI view switch; `SCENE=` env in `tools/render.preview.ts` (decision 74)
  - [ ] Run `SCENE=strategic` previews and `tests/gpu/strategicScene.test.ts` on a machine with a GPU (the cloud container has none)
  - [ ] Rename `GlobeScene` to `SimScene` once it no longer draws orbit views (V1)
- [x] Strategic camera: altitude 100–3,000 km (floor a tunable constant), tilt eased from 0° above about 1,500 km to about 50° at the floor, heading, mouse and keyboard, and decision 60's touch gestures; unit tests for the clamps and the tilt curve (decision 75)
  - [ ] Owner check on a tablet: pinch, twist and pan feel at the floor, where zoom about the fingers is approximate under tilt
- [x] Zoom bands (globe above 1,500 km, theater 400–1,500 km, region below 400 km): band from altitude with hysteresis, per-band fade factors as uniforms and a change event; tests (decision 76)
- [x] Relief mesh: reuse `quadtree.ts` and `tileMesh.ts` with a level cap chosen for the floor and its own exaggeration uniform (default 4×); measure tile count and frame time at globe scale and at the floor (decision 77)
  - [x] Owner: frame time in the browser at the ceiling and at the floor (2026-11-11: 70+ fps, 16.75 ms mean and 16.90 ms worst frame at the floor, 41 tiles at the floor with 50° tilt; no holes or gaps; level debug view works)
  - [ ] `SCENE=strategic VIEWS=orbit,floor` on a GPU for the preview's numbers
  - [ ] Share tile data between the two views' caches, or extract the common tile-set logic of `TerrainRenderer` and `StrategicRelief` (duplicated selection, build and eviction loop)
- [x] Cartographic hillshade: a light fixed at the screen's upper left (view-space direction) on the 4× normals, plus soft ambient; decide between a bake and per-fragment shading and log it; no physical sky or aerial perspective in this scene (decision 78: per fragment)
  - [ ] Owner: tune GUI → Map (strategic view) → Hillshade strength, Light elevation, Shadow floor and Relief exaggeration in the browser; fold the chosen values into the defaults
- [x] Strategic biome palette (Part II) and biome boundary blending over a few kilometers (decision 79)
  - [x] Farmland fill from the graph's habitability in open lowland biomes (decision 80)
  - [ ] Wetland and urban fills once data marks them (urban extents in S4)
- [x] Pattern framework: procedural shader patterns with screen-stable scaling per band; forest stipple and farmland grid first (decision 80)
  - [ ] Browser check: patterns compile and read well; tune stipple and field sizes (`STIPPLE_SPACING_PX`, `GRID_SPACING_PX`) and the farmland habitability threshold
- [x] Remaining patterns: desert dune ripples, tundra tussocks, steep-slope rock hatching, wetland reeds, ice-cap cracks (decision 81)
  - [ ] Wetland mask: no wetland biome exists; derive wetlands (e.g. flat, wet lowland along large rivers and lakes) and fill the mask texture's alpha, which turns on the reeds and the wetland fill
  - [ ] Browser check: all patterns read well and frame time stays near 60 fps at the floor over ice caps and deserts (the costliest patterns)
- [x] Water: flat depth bands, a thin dark coastline outline (reuse the coast distance of decision 39), lakes (decision 82)
- [x] Coastal halo and parallel coastal lines; wide rivers with the water treatment, narrow rivers as lines by discharge
  - [x] Coastal halo and parallel coastal lines (decision 83)
  - [x] Rivers: wide rivers with the water treatment, narrow rivers as lines by discharge (decision 84)
  - [ ] Browser check: river density per band (60 m and 15 m thresholds), line widths, and frame time over river-dense regions
  - [x] Owner: rings of coastal lines in the open ocean and lines sliding while orbiting (fixed, decision 85)
  - [ ] Browser check: outer coastal lines at Theater zoom follow the 1.5 km coast-distance grid and may show slight steps; if they do, refine (finer field near coasts, or subcell coast positions)
  - [ ] Move the coast-distance transform (about 0.6 s at 1024²) into the worldgen worker
- [x] Day and night on the map: the ephemeris sun draws a terminator with a warm twilight band over the hillshade; a legible deep-blue night side; settlement, base and industry lights from the existing light lists (decisions 66, 71); seasonal snow line, sea ice and frozen lakes
  - [x] Terminator, twilight band, night tint; seasonal snow, sea ice and lake ice (decision 87)
  - [x] Settlement, base and industry lights on the night side, sized by population, with a soft halo (decision 88)
  - [ ] Browser check: night legibility and twilight warmth (GUI → Map → Night, Twilight), snow line and sea ice through the year (Time → day)
- [x] Weather on the map: stylized soft cloud shapes and precipitation hatching from the live weather field (`weatherTexture`, `coverageBake`), at every band, moving with game time, on by default with a toggle (decision 89)
  - [ ] Browser check: cloud opacity and softness at each band, hatching density, and fronts readable at globe scale; the bake's 2 km texels may look soft at the floor
- [x] Graticule toggle and range rings around a selected point (decision 91)
  - [ ] Range rings around a selected base or aircraft once map symbols and selection exist (S4, C2); ring distance labels with the label engine (S2)
- [x] Post-processing: light vignette and paper grain; a soft halo on night lights only; a thin pale rim around the globe instead of the limb glow (decision 92)
  - [ ] Browser check: grain visible but subtle at 1× and 2× pixel ratio; rim thin and even all around the globe
- [x] Strategic preview views (globe band with the terminator, theater band, region band at the floor) in `tools/render.preview.ts`, plus a color-vision-deficiency filter (Part II check 4) and a 1920 × 1080 sharpness view at the floor (check 5); move the old `orbit`, `limb` and `terminator` views here (decision 93)
  - [x] Owner: run `SCENE=strategic CVD=1` on a GPU and share the PNGs from `tools/out/` (first run 2026-11-11; review in decision 99)
  - [ ] Re-run the previews after decision 99 (no tone curve, coast field in km) and send all seven views, the CVD images and the console's frame times
  - [x] Previews were sRGB-encoded twice (too pale); fixed in tests/gpu/renderer.ts (decision 100)
  - [x] Night lights blew out at globe scale; they thin out with scale (decision 100)
  - [ ] Retune hillshade strength, night darkness and cloud opacity without the AgX curve (they were tuned under it)
  - [x] Check 1 gaps: territory tint, front lines and theater names now show at the Globe band (S3, decision 101; seed 1 `globe` preview); the terminator view moved to 18:30 so the terminator crosses the globe
  - [x] Clouds read as blurry fog at the floor (2 km bake): give them a crisper stylized edge band, as printed weather maps do (decision 102)
  - [x] Mountain glyphs at the Globe band: Part II lists ranges from the Theater band; hide or thin them above 1,500 km (decision 97's Theater set shows at the globe) (the Theater set crowded its own band; smaller and sparser, decision 102)
  - [x] Hill mounds at Globe and Theater scale read as scattered dirt dots, some in regular rows; check their spacing and band (the rows were dunes; both thinned, decision 102)
  - [ ] A dark, noisy speckled patch on steep ground at the floor (rock hatching, tussocks and grain stacking?); find which pattern and calm it
  - [ ] Browser check: vignette and grain visible after the stronger defaults (Paper finish up to 3×)
- [ ] Acceptance checks 1, 4 and 5 (Part II) against the reference board; ask the owner to add the Civilization VI and Cold War map references
- [ ] Checkpoint: owner review of the base map in the browser

### S2. Geography and names (done)

- [x] Named-feature types in `worldgen/strategic/graph.ts` (kind, point / polyline / polygon geometry, extent, importance), packed into transferable buffers; bump `GENERATOR_VERSION`; round-trip test (decision 72: types live with the graph; decision 95: polygons are raster layers)
- [x] Water features in `worldgen/geography/`: oceans, seas, bays (watershed on distance to land), straits (saddles and chokepoints), lakes
- [x] Land features: continents, islands and archipelagos from the landmass and archipelago nodes; plains and plateaus (and hills)
- [x] Mountain ranges (connected high-uplift ridge regions with ridge polylines) and peaks by prominence; tests on synthetic height fields
- [x] Deserts, major forests and wetlands as polygons from biome components above a size threshold (wetlands from flat, low, watered land; no wetland biome yet)
- [x] River main stems from flow accumulation, with importance by discharge
- [x] Naming regions: one flavor per landmass for now (design open question); assignment test (decision 96)
- [x] Toponymy generator in `worldgen/names/` from `rng("names")`: syllable inventories and phonotactic rules per flavor, generic terms; determinism and uniqueness tests. Settlement names moved to it (decision 96)
- [x] Name every feature and the invasion corridors ("the X Gap"); the briefing uses feature names
- [x] Tools: `npm run maps MODES=features` draws features and prints the name table; `npm run seeds` reports feature counts
- [x] Mountain glyphs: faceted pyramids with snow caps above the snow line, instanced along ridge lines, sized by prominence, spaced as chains; rounded mounds for hills (decision 97)
- [x] Forest tokens (region band, 3–7 stylized trees, 2–5 km across) and dune glyphs (decision 97)
  - [x] Browser check (owner, 2026-11-11)
- [x] MSDF text spike: check libraries against three r187 WebGPU, or generate an MSDF atlas offline and render it with a TSL shader; record the choice in a decision (decision 98: a single-channel SDF atlas built at load time)
- [x] Label renderer: glyph atlas, point labels with halo, Part II typography styles, size by class
- [x] Curved labels along polylines (rivers, ranges, roads) and widely spaced area labels (roads come with S4)
- [x] Placement and collision pass in screen space, run when the camera settles or changes band, ranked by importance, with fades; tests on synthetic layouts, including a no-overlap assertion
- [x] Band content tables (globe, theater, region) wired to the zoom bands
- [x] Acceptance checks 2 (no overlapping labels at any band) and 3 (ten-second legibility test with the owner)
  - [x] Check 2 in Node: no overlaps at 3,000, 900, 250 and 100 km on a generated world (tests/labels.test.ts)
  - [x] Check 2 on screenshots of each band (seed 1983 previews: globe, theater, region, floor) and in the browser (owner, 2026-11-11: no overlaps)
  - [x] Check 3 with the owner (2026-11-11): the front line and the largest mountain ranges found "easily"; capitals wait for S4's settlement classes, so that part of the check reruns with S4
  - [x] Tone curve: the map renders without one (decision 99); labels draw in their own pass without it (decision 98)
- [x] Checkpoint: owner review of names, glyphs and labels (2026-11-11: "beautiful", no big problems)

#### S2 follow-ups (not blocking)

- [ ] The Globe band shows no ocean name on seed 1983 (the ocean's area label finds no fit); check the axis and level fallback for very large water features
- [ ] Theater-band mountain chains read as scattered pyramids on very broad ranges; fewer, larger glyphs, or fill by slope at that band too (see also decision 99's glyph gaps under S1)
- [ ] Tune extraction thresholds across more seeds (lakes may be too many)
- [ ] Wetland reed marks on the base map (decision 81) from the cover layer
- [ ] Range ring distance labels with the label engine
- [ ] Build the font atlas in a worker if its 0.3 s on the main thread shows as a hitch

### S3. Reading the world (done; old M4)

The strategic graph is the only view of the world that theater detection, casting and the command layer get (decision 52). Generation is unsteered (decision 46).

#### Unsteered generation and the coarse pass

- [x] Unsteered generation: uniform plate seeding, plate types from `rng("plates")`, crust from plate types; remove the two-continent layout and `oceanGap` (decision 46)
- [x] Landmass labeling with statistics: area, centroid, coastline length, latitude span, terrain mix (extends `worldgen/landmasses.ts`)
- [x] Coarse pass end to end: stages 1–9 at 256² per face in the worker; time it and report it in the progress UI (CPU only, no erosion, about 4–6 s; decision 61)

#### Strategic graph

- [x] Graph types in `worldgen/strategic/graph.ts`: landmass and archipelago nodes, sea-lane edges, chokepoints, barrier lines; packed into transferable buffers and stored in the world record (bump `GENERATOR_VERSION`)
- [x] Airbase capacity per landmass: flat, low land (slope and height thresholds) counted as candidate airbase sites
- [x] Candidate port sites per landmass: sheltered coast with deep water close inshore
- [x] Archipelago nodes: merge islands under about 2,000 km² by coast-to-coast distance within strike range (single linkage)
- [x] Coarse ocean grid (about 25–50 km cells) with a cost field: open water, shallows, sea ice
- [x] Sea-lane edges: least-cost routes from port site to port site between landmass node pairs, with length and the minimum width of water along the route
- [x] Chokepoints: straits under about 150 km and islands that could host an airfield within about 300 km of a lane; record which lanes each one controls

#### Front generator

- [x] Barrier map per land cell from river width, slope, ridge prominence and forest density (decision 44)
- [x] Coast-to-coast maximum-barrier path search with the area constraint (each side at least 35% of the landmass)
- [x] Repeated search with exclusion corridors to get 3–4 roughly parallel defensive lines; store them as the landmass node's barrier lines
- [x] Start line one line forward of the strongest barrier; invasion corridors on weak segments of each line (refined with roads in S4)

#### Theaters

- [x] Theater module interface (precondition on the graph, fit score, instantiation) and a registry
- [x] Continental front theater
- [x] Sea-lane theater (800–3,000 km lane from a rear-base landmass to a front)
- [x] Chokepoint theater (chokepoint on an active sea lane)
- [x] Island campaign theater (archipelago and small landmass nodes in mutual strike range, no front-sized landmass)
- [x] Strategic theater (industry and logistics targets, air defense belts)
- [x] Validity check: flat land for at least 15 airbases per side and at least one theater above its fit threshold; retry with seeded sub-seeds `fork("retry-n")`, with a test that each seed maps to exactly one world

#### Casting

- [x] Cast data type (theaters, territory per side, posture, range factor, logistics links, regions) stored with the world; theater selection above fit thresholds from `rng("casting")` (decision 47)
- [x] Territory assignment: the Pact takes mass and interior lines, the Alliance takes the side next to its rear base and sea lanes; island campaign variant
- [x] Posture (the Pact attacks by default) and logistics links between theaters (a cut lane starves a front, a lost chokepoint exposes convoys)
- [x] Range factor search in [0.35, 1.0] from the two reach targets (decision 51)
- [x] Industry, port and base regions for each side, consistent with territory and theaters (S4 places the sites)
- [x] Briefing text generated from the cast: the theaters, the stakes in each, the first expected moves
- [x] Regional bake: pre-bake ground-combat regions to tile level 7 (about 48 m) during world generation (on-demand level-7 tiles already cover it; `regionTiles` lists them for prefetch, decision 64)

#### Strategic overlays (new with decision 72; needs S1 and S2)

- [x] Territory tint per faction (Part II palette): the placement territory raster kept in `Infrastructure.territory`, a cube-face texture, 22% over dry land, neutral at 8% (decision 101)
- [x] Front line as a bold line with teeth on the attacker's side; defensive lines dashed (screen-space ribbons fixed to the ground, `overlays/militaryLayer.ts`)
- [x] Invasion corridors as named arrows (names from S2, labels in the attacker's color)
- [x] Sea lanes as dashed routes; chokepoints marked; theater names at the globe band (lanes and chokepoints of the cast's theaters only)
- [x] Layer toggles (GUI → Map → Military overlays); the graph debug overlay stays as a developer view, off by default on the map
- [x] Browser check (owner, 2026-11-12): teeth on the attacker's side and evenly spaced at every band, dashes fixed to the ground while panning, no gaps at line joins, corridor names along their arrows, overlays fading with the bands; tint opacity (Map → Military overlays → Tint opacity; 15% was faint in previews, 22% is the default)
- [x] Preview check: `SCENE=strategic SEED=1 VIEWS=front,globe CVD=1` (Part II checks 1 and 4 with overlays; front, teeth and corridors distinct under all three deficiencies); seed 1983 has no front (ring continent, below)

#### Tools and review

- [x] Strategic graph debug overlay on the globe: nodes, sea lanes, chokepoints, barrier lines, start line, corridors, theater boundaries (GUI → Campaign; not yet seen in a browser)
- [x] Graph overlay mode in `npm run maps`, so detection can be checked without a browser (`MODES=graph,barrier`)
- [x] Seed browser: a CLI table first (`npm run seeds`: theaters, fit scores, range factor, retries per seed), then a GUI panel (GUI → Campaign → "Seed browser: scan next 10")
- [x] Determinism tests: graph and cast identical across runs; changing casting leaves the graph unchanged
- [x] Checkpoint 5: owner review of the overlays, theaters and briefings on the strategic map (signed off 2026-11-12)

#### S3 follow-ups (not blocking)

- [ ] Ring-shaped continents around an inland or polar sea get no front: a single cut cannot split them (decision 62; seed 1983). Consider two cuts, or a front across the ring's narrowest part
- [ ] Air defense coverage as faint rings (once air defense sites exist)
- [ ] Convoy icons on sea lanes (once convoys exist in the simulation, C track)
- [ ] The tint's edge follows the coarse grid (about 40 km) and can sit a cell off the drawn front line at the floor; if it shows, cut the tint along the start line in the shader
- [ ] Tune the theater fit thresholds from seed browser statistics (design open question)
  - First run, seeds 1–40 at the defaults (2026-11-10): continental front 90%, sea lane 25%, chokepoint 5%, island campaign 10%, strategic 100%; one retry (seed 9, Alliance short of airbase room), none invalid; 4–6 s per seed.
  - The range factor is 1.0 for almost every seed (mean 0.98, min 0.73): fronts are 1,500–2,500 km deep, beyond a medium strike radius of 1,300 km. Owner decision: keep real ranges, measure depth to the enemy's industry and base regions instead of 90% of its land, or change the reference radii.
  - Island campaigns are lopsided: the Pact gets a large landmass with no valid front (often a ring continent) and the Alliance a few islands (45–254 vs. 1,200–1,500 airbase sites).

### S4. Settlements and infrastructure (done; old M5)

Civilian geography (settlements, roads, bridges) joins the strategic graph before casting; ports, airbases and targets follow the cast (decision 65). Everything runs on the coarse pass, on the CPU, in `worldgen/strategic/` (decision 72).

- [x] Settlement site scoring (river confluences, coasts, fertile lowlands); placement with population, denser in each side's industry regions (casting puts industry regions on the largest urban clusters)
- [x] Ports at the cast's port sites (sea-lane ends, island ports), plus commercial ports
- [x] Movement cost map from slope, terrain and water
- [x] Least-cost road paths between settlements, merged where they overlap
- [x] Bridges at river crossings, as targetable features
- [x] Airbase site search on flat, low terrain near roads
- [x] Airbase density by distance behind each front (densest 100–400 km back); strategic bomber bases far from the front
- [x] Island airfields and forward airfields at chokepoints
- [x] Industry and logistics sites as targets for the strategic theater
- [x] Refine invasion corridors with the road network
- [x] Road rendering (terrain shader, like rivers)
- [x] Night-side settlement lights
- [x] Tools: `npm run maps` graph mode draws settlements, roads, bridges, airbases, ports and targets; `npm run seeds` and the seed browser report them; render preview views `town`, `airbase`, `roads`, `night`
- [x] Denser settlements (about 2,000), feeder roads, rural night glow (decision 66, after the owner's first look)
- [x] Strategic view shows the big picture (decision 71, owner review): forests as canopy masses and towns as built-up patches in the terrain shader, guide palette; instanced trees and buildings off by default (simulator detail); procedural shader lanes removed; local roads link neighboring settlements (Gabriel graph, 70 km), so villages sit on through roads
- [x] Urban extent polygons per settlement from the growth model, in the graph (decision 103: radial growth along roads, cut at water)
- [x] Road hierarchy from a gravity model: motorway, trunk and secondary from the populations a road connects and the traffic routed over it; `GENERATOR_VERSION` 11 (decision 103)
- [x] Route numbers from a fictional scheme ("R4", "M12") and names for notable pass and coast roads ("the Kessar Pass Road"), with S2's generator (decision 103)
- [x] Railways linking major cities, ports and industry, with rail yards and rail bridges as targets (decision 103)
- [x] Capitals: each side's largest settlement (decision 103)
- [x] Map: urban extent fills and oversized low-poly city glyphs by class (village, town, city, capital with a star) (decision 104)
- [x] Map: road ribbons with casing by class, bridge marks, railway lines with ticks (decision 104)
- [x] Map: symbols for airbases (runway glyph), ports (pier glyph), factories, refineries, depots and rail yards (decision 104)
- [x] Labels: route numbers and pass and coast road names along roads; capitals (decision 104)
- [x] Preview views `cities` (700 km) and `capital` (150 km) on the Alliance capital
- [x] Check 3 with the owner, capital part (2026-11-12): found the capital quickly by its star; completes the check S2 deferred to S4
- [x] Check 2 in Node with route and capital labels (tests/labels.test.ts, seed 7: no overlaps at any band)
- [x] Checkpoint 6: owner review of towns, roads, airbases, railways and their symbols on the map (signed off 2026-11-12 from the seed 1 `cities` and `capital` previews: "Looks great")

#### S4 follow-ups (not blocking)

- [ ] Snap bridges to the rendered (eroded) rivers, which can run a few kilometers from the coarse ones (decision 65); track N's alignment does this (N5, decision 161)
- [ ] Keep civilian roads off airfields (a road may cross a taxiway; route around airbase footprints or end them at the gate)
- [ ] Island campaigns can leave the Alliance under 15 airbases (seed 11: 9), since its islands have little flat land; tied to the lopsided island split noted under S3
- [ ] Tune routes across seeds: seed 1983 numbers 33 motorway and 86 trunk chains, many short pieces between junctions; consider merging through junctions across classes
- [ ] Browser check: frame time at the floor with roads, railways, symbols and building glyphs; whether secondary roads crowd the Region band near 400 km
- [x] Acceptance checks 1, 4 and 5 on the new views (2026-11-12, `SCENE=strategic SEED=1 VIEWS=globe,cities,capital,sharp CVD=1`): pass, with the gaps below
  - [ ] Check 4: under deuteranopia and protanopia motorways (`#C0563A`) and trunk roads (`#D99A4E`) both turn olive and differ only by width; consider a lighter trunk or a stronger width step
  - [ ] Check 4: under protanopia the Pact's front teeth go near black against the front line; they still read by shape
  - [x] Check 5: site symbols, bridge marks and the urban fill were hard to see at 1080p at the floor (the `sharp` view); larger symbols facing the screen, towns drawn larger than life with an outlined fill (decision 105)
  - [ ] Check 1: weather clouds are hard to tell from snow on the `globe` view; the night side's lights merge into a bright field over the densest region

## Simulation core track

### C1. Simulation core and weather (done; old M6)

- [x] Sim worker host: message protocol and state snapshots to the main thread as transferable buffers (decision 40, 67)
- [x] Float64 game clock and time acceleration (pause, 1×, 4×, 16×, 64×, 256×)
- [x] Discrete-event scheduler (priority queue with deterministic tie-breaking)
- [x] Fixed-tick processes (1 game minute) interleaved with events in time order (one queue for both, decision 67)
- [x] Determinism test: 1× and 64× give identical state at a given game time (`tests/sim.test.ts`; also one jump, auto-slowdown and backward seeks)
- [x] Time-control UI with calendar date and local time display, and auto-slowdown on flagged events (time bar; GUI → Time: jumps, test alarm)
- [x] Weather model: coarse global grid (about 50–100 km cells), hourly ticks, `rng(seed, "weather")`, driven by the climate maps and season (decision 15, 68)
- [x] Weather fields for operations: cloud cover and ceiling, visibility, precipitation, wind at several levels
- [x] Weather determinism test across time acceleration
- [x] Clouds rendered from the live weather field (replaces the static M3 field)
- [x] Tools: `tools/weather.preview.ts` draws cloud, precipitation, isobars and 850 hPa winds and prints statistics
- [x] Checkpoint 7: owner review of the time bar, auto-slowdown and clouds from live weather in the browser (signed off 2026-11-11; the GPU cloud test now runs on lavapipe and caught clear skies that were not clear, decision 69)
- [x] Storm and dust channels (rain from drizzle to 55 mm/h in storm cores), weather presets, the standalone weather for Free Flight, and the `WeatherState` uniforms the effects share (decision 137)
- Carried to V2: live winds for wave direction (fog, visibility, rain, snow, dust and storms reached the renderer with decisions 141 and 142)

### C2. Air tasking and mission search (old M7, without models and the chase camera)

#### Data model and flight

- [x] Aircraft type table for both sides: fictional names, reference type, role, speeds, ceiling, combat radius before the range factor, loadouts (`sim/air/aircraft.ts`, 31 types; decision 132)
- [x] Squadrons, bases and inventories per side (aircraft, readiness, stocks) (`sim/air/orbat.ts`)
- [x] Carrier groups as mobile bases on analytic sea routes; air wings launch and recover at the group's predicted position (decision 56): cast by `campaign/carriers.ts`, on station from the outbreak, patrolling a stretch of sea lane (`sim/naval/carrierGroup.ts`; decision 132)
- [x] Mission model: type, side, theater, package, target or station, phase timeline, originating need and score (decision 50), per-mission seed ready for promotion (`sim/air/mission.ts`)
- [x] Great-circle routes with climb and descent profiles; analytic position(t); fuel with the cast's range factor (decision 51) (`sim/air/route.ts`, `missionRoute.ts`)
  - [ ] Winds aloft in ground speeds (with the ATO's weather task)
  - [ ] Altitudes are above sea level and low level is 100 m: terrain following in the execution layer (V4, P1)
- [x] Phase timeline per mission type (departure, climb-out, ingress, fence-in, on target or on station, egress, approach, recovery) as scheduled events (`sim/air/airOps.ts`)
- [x] Interim tasker until the ATO below replaces it (`sim/command/tasker.ts`; decision 132): standing CAP, AEW and tanker orbits, CAS, strikes on fixed sites with escort and SEAD, reconnaissance, airlift; fixed installations known from the outbreak

#### Intelligence (decisions 53, 57)

- [ ] Per-side intelligence store: contacts with position, type, last seen, confidence and source; decay with age; determinism test
- [ ] Satellite orbits: circular Keplerian orbits from GM = g·R², sun-synchronous node precession, analytic ground tracks and passes over a point; tests for period and pass times
- [ ] Satellite classes and per-side constellations modeled on Cold War systems (film-return, digital electro-optical, radar and ELINT ocean reconnaissance, late radar imaging); sensor field of regard tuned to Cold War revisit times, with a revisit-statistics test
- [ ] Imaging conditions: optical needs daylight and clear sky from the weather field; radar ocean reconnaissance sees ships through cloud; ELINT sees only emitters
- [ ] Delivery delays: film capsules on a recovery schedule, digital imagery after processing, ocean reconnaissance within minutes; contacts stamped at observation time and delivered later
- [ ] Radar air picture: ground radar and AWACS coverage with radar horizon and terrain masking; feeds Pact ground-controlled interception
- [ ] Reconnaissance missions refresh contacts along their routes

#### Air tasking order (decision 50)

- [ ] Need collection from fronts: CAS for segments under pressure, interdiction of supply behind the front (known contacts only)
- [ ] Need collection from sea lanes, chokepoints, islands and strategic targets: CAP over high-value assets, convoy escort and attack, strikes on industry and air defenses, resupply and airlift
- [ ] Priority score (theater weight × target value × urgency) with deterministic tie-breaking
- [ ] Package builder: flights from squadrons in range; escort and SEAD when the target area is defended
- [ ] Doctrine scheduler: Pact strikes in large waves, Alliance missions spread evenly; daily ATO plus a replanning tick every few game hours
- [ ] Weather and daylight in tasking: cancellations below minimums, winds aloft in ground speed, night and bad-weather low-level strikes
- [ ] Aggregate mission resolution: target damage and losses from package composition, defenses and weather
- [x] Concurrency cap so that 20–50 aircraft are airborne (MAX_AIRBORNE, 24 per side, in the interim tasker; keep it in the ATO)
- [ ] Determinism tests: identical ATO at 1× and 64×, and independent of the viewing side (decision 48) (the interim tasker's hash is step-size independent, `tests/air.test.ts`; repeat for the ATO)

#### Mission search and the map

- [x] Debug GUI toggle for the viewing side (developer tool until I1): GUI → Map → Air war → Viewing side; 'both' shows ground truth until the intelligence overlay
- [x] Mission icons (small aircraft with heading and short trails) and route lines on the strategic map (`render/strategic/overlays/airModel.ts`; carrier groups as ship icons; every route as a debug toggle until selection draws one; `VIEWS=air` in the strategic preview)
  - [x] Icons as badges that stand out, and click selection of flights and carriers with an info panel (decision 133)
  - [ ] Owner: watch the flights in the browser at 64× and 256× (badge size, trail length, legibility over the front and at the Globe band; clicking flights and carriers)
  - [ ] Badges for convoys and NATO-style formation symbols (C3), with the same grammar: filled discs move, pale tiles stay
  - [ ] Declutter where badges overlap (an airbase's departing flights, a strike package): offset or stack them
  - [ ] Models for the types without one (`model: null` in the table), for V4's chase view
- [ ] Mission search panel: ongoing and upcoming missions of the viewing side
- [ ] Filters: mission type, aircraft, theater, current phase, threat level, time until action
- [ ] Focus the strategic camera on a selected mission and draw its route
- [ ] Subscriptions: a saved query plus a phase triggers auto-slowdown to 1× and offers the mission
- [ ] Intelligence overlay: the viewing side's contacts and satellite tracks
- [ ] Checkpoint 8: owner review of the ATO, mission search and subscriptions on the map

### C3. Ground and naval aggregates (old M8)

- [ ] Order of battle: division / brigade or regiment / battalion data model with per-unit seeds (ready for promotion)
- [ ] Initial deployment along each front's start line, and island garrisons
- [ ] Lanchester-style aggregate combat per tick, with terrain, posture, supply, artillery, air support (from mission resolution) and weather modifiers
- [ ] Front segment movement by local force balance, slowed by barriers
- [ ] Offensives by cast posture along the invasion corridors
- [ ] Supply: interdiction cuts it, convoy arrivals deliver reinforcements and supplies to the receiving theater
- [ ] Convoys on sea-lane routes between ports; analytic position(t)
- [ ] Amphibious groups for island campaigns and chokepoint seizures; theater tasking of carrier groups (their movement and air wings come from C2)
- [ ] Display: NATO-style unit symbols for battalions, and convoy and naval group icons, on the strategic map (ship models are in V3)
- [ ] Benchmark: how many battalions plus weather the worker handles at 256×

## Flight view track

### V1. Local terrain (LOD done for the old single renderer; adapt to the simulation view)

Done in old M2, for the renderer that served orbit to ground:

- [x] Terrain quadtree per cube face on the same tile keys, refined by screen-space error (conservative cap horizon culling, frustum culling, parent fallback while children load)
- [x] Tile meshes with skirts and a float64 origin per tile (camera-relative; built on the CPU, decision 30)
- [x] Tile normals; shader detail noise below the finest baked level (CPU render-detail noise instead, decision 30)
- [x] Geomorphing so LOD changes don't pop (morph toward the parent's actual surface)
- [x] Checkpoint 2: owner review of the tiled terrain in the browser, orbit to 500 m
  - [x] Exaggeration changes without rebuilding meshes (decision 31)
  - [x] Thin rivers drawn as continuous lines on diagonals (wider coverage mask; true channels stay)
  - [x] One "Color by" list for grid and tiles; grid-only modes switch the display to the grid
- [x] Camera: terrain-aware near plane and ground clamp; flyable down to 500 m (heading, WASD/QE/RF flight, tilt to 87° below 50 km)
  - [x] Touch input for tablets: one-finger drag, two-finger pan/pinch/twist about the midpoint, three-finger tilt (decision 60)

Simulation view (needs S1's `render/sim/` split):

- [x] Camera envelope 0–20 km; an observer camera at an airbase or port from the cast; the free camera kept as a debug tool behind a dev flag until V4 (decision 72; decision 112)
  - [x] Owner review (2026-11-12): the ground flickered to sea or black for single frames while turning (fixed, decision 113: tiles split only when all four children are ready); horizontal drag felt inverted (mouse-look now); movement too slow (40 m/s, Shift ×5, 25 km leash)
  - [ ] Owner: recheck the observer in the browser after decision 113 (no flicker while turning or walking; drag and Shift feel right)
  - [x] Touch controls for the observer (owner request; decision 114): one finger looks, pinch zooms, on-screen walk stick, height slider and ×5
  - [x] Owner tablet review (2026-11-12): the stick works but is a little slow (now 80 m/s near the ground); finger look felt inverted (now mouse-look, as with the mouse)
  - [ ] Owner: recheck finger look and pace on the tablet
  - [x] Fly rather than walk (owner request; decision 115): forward along the view, climb straight, altitude kept over valleys, never within 2 m of the ground
  - [ ] Owner: try flying on the tablet and the desktop (look down and push to dive; the floor at 2 m)
  - [x] No leash: stations are starting points (owner; decision 118)
  - [ ] Owner concern: the ground around bases looks flat and uniform. Airbases sit on flat land by design and the grading flattens 400 m beyond; the uniform look is the smooth, one-color-per-biome land shading that the faceted shading, shade quantization and farmland tasks below replace
  - [ ] Ports: a quay layout and buildings, so a port observer stands on the quay rather than at the coarse site point (with C3's ships)
  - [ ] Ease between stations instead of jumping (V4's transition controller)
- [x] Horizon-bounded tile selection: drop tiles beyond √(2Rh) plus a margin (at most about 200 km at 20 km); tests for the bound and that selection never exceeds it (decision 116: exact tile distance; `horizonRange` and `selectionRange` in `quadtree.ts`)
  - [ ] The bound grows with the tallest displayed terrain: at the current 10× exaggeration (40 km peaks) it is about 490 km at 20 km; True-scale relief (below) brings it to about 290 km
- [x] Tile cache budget and prefetch for the bounded radius around the active unit or camera (`selectionRange`, decision 116); prefetch the regional level-7 tiles (decision 64) (decision 119: `prefetch.ts`, `terrainBudget.ts`; GUI → View → Terrain tiles → Prefetch; status shows the bubble)
  - [ ] Recheck the working set and the 600 MiB default after true-scale relief (below); at today's 10× the views need more meshes, and a lower default would suit tablets
  - [ ] The sim worker's line of sight (C3, P1) reads its own level-7 tiles; give it `regionTiles` inside the bubble then, since the renderer's cache lives on the main thread
  - [ ] Tile generation throughput (one batch of eight in flight) bounds a fast climb, not prediction (decision 119's measurement); for P1's low, fast flight try larger or overlapping batches and measure on a real GPU
- [ ] Owner: recheck the glitter toward the sun from altitude on the tablet after decision 120 (rivers reflect only their true width)
- [ ] Frame rate at altitude (owner, tablet: 28–30 fps near the ground, about 10 high up). Headless at 8 km facing the sun: 10× draws 107 tiles, 0.93 M triangles, 12.5 ms of terrain CPU per frame; 1× draws 13 tiles, 0.11 M triangles, 0.7 ms, and the software-rendered frame takes half as long. True-scale relief (next) is the main fix; then shorten the river lists of coarse meshes (mean 36–52 segments per pixel, up to 160, at 8 km), e.g. by dropping rivers narrower than a fraction of the mesh's vertex spacing
- [x] True-scale relief: the simulation view's own exaggeration uniform, default 1×; recheck skirt depth and the near plane; owner look at whether decision 14's relief reads at 1× (it did not: decision 121 keeps landforms at Earth's proportions, and the view defaults to 1×; skirts were already sized for 40×)
  - [ ] Owner: look at the terrain at true scale in the browser (seed 1983 at 9.853, −48.200 and elsewhere): valleys, ridges, snow lines and forests after decision 121
  - [ ] Strategic map: relief is now much taller at landform scale (gain 12, peaks near 8 km, decision 122); check the hillshade and the 4× exaggeration at the floor, and lower it if the map gets busy
  - [ ] Owner: true scale after decision 122 (gain 12): dramatic enough, too much, snow and alpine extent, flying low through valleys
  - [ ] Peak labels show coarse-pass heights (about 1.4 km at most), lower than the eroded summits now; label from the global grid's height near the peak, or drop the height
  - [ ] Airfields on rougher ground: check the 400 m grading margin and embankments at true scale (`VIEWS=airbase,runway`)
  - [ ] Tune the landform gain, radius and tile detail across more seeds and terrain types (plains, coasts, high mountains) with `tools/relief.preview.ts`
- [x] Faceted flat shading on terrain (derivative normals), with facets of about 20–60 m at low altitude; check it against geomorphing (decision 123: `render/sim/terrain/facets.ts`; GUI → Lighting → Faceted terrain; preview `FACETS=0`)
  - [ ] Owner: look at the facets in the browser at low altitude and over mountains, toggling GUI → Lighting → Faceted terrain
  - [ ] Facets read as a grid of squares on gentle ground: the mesh is a regular grid with one diagonal direction, so a quad's two triangles shade almost alike. Shade quantization (decision 124) breaks it up near the camera; if it still shows, consider jittering each vertex by an amount set by the level at which it first appears, which keeps geomorphing exact
- [x] Per-face shade quantization: three to five shades per biome from slope, altitude, moisture and low-frequency noise, constant per face (decision 124: `render/sim/terrain/faceShading.ts`; the land albedo is evaluated at each face's center)
  - [ ] Owner: judge the shades in the browser (GUI → Lighting → Faceted terrain toggles facets and shades together); tune the shade count and the dark and pale multipliers (`LandShading.shades`, `shadeDark`, `shadePale`) if the mottling is too strong or too weak
  - [ ] The forest edge steps along the road clearings in the `trees` view, with or without facets: the density field, not the shading
- [x] Rock and snow by face; drop smooth rock blending (style gap from decision 70) (decision 125; preview view `alpine`)
  - [ ] Owner: look at snow lines and rock faces in the browser, high in a range and from a valley floor
  - [ ] Owner idea (2026-11-12): more color variation per facet, possibly from textures, later; keep it value-first and constant per face (Part I)
- [x] Memorable landforms (owner request; decision 126): landform masks, a branching erosion filter, alpine crests, glacial troughs and lakes, layered dry rock with buttes and mesas, meanders, deltas, green corridors, falls and skerries; `SPOTS=all` in `tools/render.preview.ts` renders a spot for each
  - [ ] Owner: fly to the spots in the browser (`npx vitest run --config vitest.tools.config.ts tools/spots.preview.ts --silent=false` lists them for seed 1983) and judge each against its Earth reference
  - [ ] Cliffs sharper than the 48 m baked samples stair-step along the mesh grid; a finer baked level near the observer, or vertex jitter (above), would allow sharper cliffs and falls
  - [ ] Meanders end at every confluence (they taper to zero there); on rivers with many tributaries the bends come in short trains. Carry the phase across confluences of the main stem (with N2's meander work, decision 161)
  - [ ] Tune the landforms across more seeds (buttes are sparse on seed 1983; skerries need cold, low coasts)
  - [ ] Buttes, terraces and skerries come from tile noise that knows nothing of roads and towns placed by the coarse pass: a road can run into a 320 m butte cliff or a skerry inlet. Suppress the landforms within a few hundred meters of roads and urban extents (as airfield grading does), or let roads cut through
  - [x] Owner review (2026-11-13): archipelagos showed light-blue, raised patches. Two causes (decision 129): lakes spilled over gully-cut ground to the blocky edge of the lake level's reach, and land the tiles raise over global sea or lake cells took the water's biome color. Also asked for lighter shallow water and reefs (decision 129)
  - [x] Owner review (2026-11-13, second): light-blue regions remained (shallow lakes, pale and blocky) and coasts were regular. Decision 130: ragged coasts, wandering lake shores, darker lakes, salt pans
  - [ ] Owner: recheck archipelagos, coasts, lake shores and the reef spot (`SPOTS=reef`) in the browser
  - [ ] Lakes along diagonal troughs read as a chain of beads: the lake cells form a staircase and the water is held to them. Smooth the lake share (a blurred lake mask) so narrow diagonal lakes stay continuous
- [x] Voronoi farmland patchwork near settlements and on flat lowland (decision 127; GUI → Lighting → Farmland; preview view `farmland`, `FARMLAND=0`)
  - [ ] Owner: judge field size (256 m lattice), crop shares and the stepped field edges in the browser
  - [ ] Field edges: hedgerows or darker field margins, if the patchwork needs more structure (not in Part I yet)
  - [ ] Farmland follows the 4 km habitability grid and the biome; S4's urban extents and roads could shape it further (fields along roads, none inside town extents)
- [x] Simulation preview views: re-aim Part I checks 1–5 (5 km mixed landscape, 500 m conifer edge with a road, mountains at low sun, airbase at dusk, coast with glint) at or below 20 km in `tools/render.preview.ts`; retire views between 20 and 100 km (`oblique`, `roads`, `coast`) or move them to the strategic set (carried from old M5) (decision 128: `mixed`, `conifer`, `range`, `dusk`, `beach`; `VIEWS=checks`; targets in `tools/checkViews.ts`)
  - [x] Check 1 (`mixed`): at 5 km the view looked down onto a cloud layer that ended in a hard straight edge across the frame (the flat shell seen edge-on); the volumetric clouds replace the shell inside 20 km (decision 141)
  - [ ] Check 1: the river at the town is hard to find at 5 km; rivers should be the most visible terrain feature from altitude (Part I)
  - [ ] Check 2 (`conifer`): the town's built-up patch reads as large triangles of roof and wall colors under the buildings; the road is faint at 500 m
  - [ ] Check 4 (`dusk`): no parked aircraft yet (aircraft meshes in the simulation view, V4)
  - [x] Check 5 (`beach`): no beach: the coast has the foam line and shallow water but no sand strip (sand in coves of gentle coasts, decision 146)
- [x] Style audit: compare those views with the reference board and Part I (terrain facets and shade quantization, farmland, rivers, ocean, haze, trees, towns, lights); the old M3 and M5 rendering predates the guide (smooth shading, clump trees). Add a task per gap (carried from old M5) ([docs/style/audit-sim-2026-11-13.md](docs/style/audit-sim-2026-11-13.md); light and post-processing gaps are under V2)
  - [ ] Owner: compare the audit's previews with the reference board (the screenshots are local only)
  - [ ] Rivers are gray ribbons at 2 km and hard to find at 5 km (`mixed`); Part I wants them the most visible terrain feature from altitude: brighter sky mirror, wider legibility floor from altitude, or a darker bank
  - [ ] In `trees`, a river leaves a lake as a straight canal between even grass banks; find which layer draws it (channel carving, the green corridor of decision 126, or the river polyline)
  - [ ] Shallow water in `shore` ends in straight edges; check the shelf depth field and the seabed color at tile or grid boundaries
  - [x] Beaches: a sand strip (`#C9B48A`, `#B9A276`) on low, gentle coasts between open ground and the foam line (Part I palette), per face (decision 146)
  - [ ] Built-up patches (decision 71) read as large triangles of roof and wall colors under the buildings (`conifer`): give them a block pattern finer than the facets, or evaluate them per fragment
  - [ ] The `town` view scatters buildings across hills and does not frame the city; aim it at the city's urban extent
- [x] Frame time over 0–20 km within Part I's budgets (decision 131: draw calls, triangles and CPU per frame measured headless with `PERF`; trees and buildings culled by the frustum, trees thinned with distance; every view from 2 m to 20 km now under 2 M triangles and 100 draws)
  - [ ] Owner: frame rate in the browser on the desktop and the tablet, low over dense forest (`trees`-like) and over a town; Status shows fps
  - [ ] GPU timing on real hardware (timestamp queries, I1) to split terrain, trees and clouds; the headless software renderer gives only counts and CPU time
  - [ ] One frame in ten takes 170–320 ms of CPU in the headless preview (garbage collection in a heap of several GB, probably); check for hitches in the browser's performance panel
- [ ] Checkpoint: owner review of the simulation view's terrain from an observer camera

### V2. Atmosphere and nature (mostly done; old M3)

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
- [x] Cloud layer rendering, from a static field derived from moisture until live weather exists (C1) (decision 55)
- [x] Checkpoint 4: owner review of terrain shading, seasons, forests, rivers and clouds
  - [x] No river channels carved into lake beds
  - [x] Clouds moved by prevailing winds without stretching, and regularly clear everywhere (decisions 58, 59)
- [x] Weather in the renderer (from C1): fog and visibility, rain and snow in the air and wet ground, dust storms, lightning (decisions 139, 141, 142)
  - [ ] Live winds for wave direction on the sea
  - [ ] Snow accumulating on the ground from snowfall (ground snow follows climate and season; a preset shifts the temperature)
- [ ] Tree kit from model specs ([docs/visual-style.md](docs/visual-style.md) Part I, Vegetation): conifer, broadleaf, birch/poplar, palm, acacia, shrub, dead/burnt, each within the guide's triangle budget and sturdy proportions (canopy width ≥ ½ height, trunk ≥ ⅒); per-instance scale 0.8–1.3, yaw, tilt under 4°, and a value-first shade shift within the biome's canopy shades; types assigned by biome; clustered placement with a sharp forest edge and a scattered fringe of trees and shrubs. Replaces the old M3 clump trees (needs V3's model builder)
  - [x] Kit specs: fir, pine, oak, broadleaf, birch, poplar, acacia, shrub and dead tree (20–70 triangles, model class `tree`), lumpy crowns from the builder's blob `jitter`; CPU lineup and forest-corner previews in `tools/trees.preview.ts` ([docs/proposals/0003-forests-for-low-flight.md](docs/proposals/0003-forests-for-low-flight.md))
  - [ ] Palm (with the coast work)
  - [x] Owner: review proposal 0003 (accepted 2026-11-15, decision 148); the birch's crown floated over its thin trunk (owner), now lower on a thicker trunk
- [ ] Forests for low flight (proposal 0003, decision 148), replacing the old tree LOD and denser-forest tasks:
  - [x] Canopy height field H with stands (composition, height, shade), CPU and GPU versions with a test that they agree (`worldgen/canopy.ts`, `render/common/canopyNode.ts`; decision 150)
  - [ ] A stand map mode in `npm run maps`
  - [x] Canopy shell from the terrain tiles: lifted by H, cut at the edge and along roads and towns, stand shades, the understory near the camera; preview views `treeline` (25 m) and `canopy` (100 m) (decision 150)
  - [x] The shell's edge is notched where its ramp crosses mesh triangles: visible beyond the edge trees' 1.2 km (gone with the edge a cell inside the forest, decision 157)
  - [x] Near trees from the kit on quarters of level-10 tiles: closed-canopy spacing, crowns only inside stands, whole edge trees, per-instance variation, far models beyond 350 m, culling per tree; the clumps of decision 45 retired (decision 150)
  - [x] Hedgerows by climate along the painted fields and shelterbelts on continental plains; rows of trees along roads; acacias in savanna only (decision 162)
  - [x] Gallery woods along rivers and lone landmark trees in open land; preview view `gallery` (decision 166)
  - [ ] Hedges and rows for the line of sight and the AI's firing positions (with step 7)
  - [ ] Measure on the owner's laptop and tablet; near and edge radii as quality-governor steps (tablet 400 m and 1 km, desktop 1 km and 2 km); aerial perspective per instance or from a froxel volume if the per-vertex march dominates; GPU culling with indirect draws if the CPU re-sort costs show
  - [ ] Owner: fly Free Flight low over forest (seed 1983 near −45.5, −28.0 has a river through dense forest) and judge the look, the stands and the frame rate
  - [ ] Line of sight from H (opaque for any sight line from or to an aircraft) and tree strikes in the ground model (with P3 and P1)
  - [x] Seasons per species: fall colors (birch yellow, oak orange to red), brown, then bare winter models; the shell turns with its stands; tropical forest evergreen (decision 153)
  - [x] Owner's first flight (decision 153): the shell's edge rises from the ground (no skirt over the trunks), the fringe takes after its forest (no acacias before broadleaf), rarer and taller young stands, conifers below 6 °C and all firs in the cold
  - [x] Owner's second look (decision 157): the shell's edge a cell inside the forest (no hanging edge, no ramp past the edge trees), a patchy snow line, whiter snowy conifers, browner ground in the fall
  - [x] The shell still ended at full height along road lanes and town clearings (cut per fragment): it now slopes down before them, and the trees by a lane are whole (decision 166)
  - [ ] Owner: the tablet's frame rate over forest; judge fall colors and winter woods in the browser (the campaign view with time accelerated into the fall; previews: `TEMP_OFFSET`)
- [ ] Sky, haze and clouds tuned for 0–20 km only (Part I): drop orbit-only work such as the limb glow from the simulation view (the sky and the clouds are done, decisions 140 and 141; the old cloud shell and sky march remain for the debug camera above 30–50 km)
- [x] Volumetric clouds, cirrus, fog, dust and rain veils: one march at low resolution in the pipeline's volumetric stage, shaped by the weather; cloud shadows and gray sky light under cloud; three quality levels (`render/sim/clouds/volumetrics.ts`, `cloudForm.ts`, `noiseVolume.ts`, decision 141)
  - [ ] Time it on a real GPU (timestamp queries, I1): only lavapipe ratios and counted texture reads exist; the estimate for an integrated laptop GPU at 1080p is 4–8 ms at medium
  - [ ] Snow and blizzard scenes are a dim uniform gray at midday: brighter air under snow cloud, and snow-covered ground lighting the cloud base
  - [ ] A thin strip along the horizon keeps some of the march's sample pattern from a low camera in a steep bank (pinned by a test in `tests/gpu/simPipeline.test.ts`)
  - [ ] Faint horizontal streaks in night rain at high brightness (the rain's cloud-cover read is held for 400 m of the ray)
  - [ ] Clouds receive no mountain shadows and do not shade moonlight; cloud bases ignore terrain exaggeration
  - [ ] Fog pools by 65 km weather cells: fill single valleys from the terrain's height under the camera
  - [ ] Single cumulus still read as smooth pebbles at medium quality; more lobes per cloud without noise in the sky
- [x] Rain, snow and dust particles near the camera, lightning from a seeded schedule with a bolt and a flash, synthesized thunder, rain and wind (`render/sim/weather/precipitation.ts`, `lightning.ts`, `ui/audio/`, decision 142)
  - [ ] Owner: listen to the audio (thunder, rain, wind, blowing sand); its gains are first guesses and nobody has heard it
  - [ ] An option that softens repeated strokes: a strike can flash the whole frame up to four times in 0.3 s (photosensitivity)
  - [ ] Lamp light on particles at night; splashes on the runway
  - [ ] Snow may twinkle in a slow pan where flakes cross the edge of their cell: check in motion
- [x] The atmosphere in the app and in Free Flight: per-frame wiring, GUI → Atmosphere, weather as a Free Flight option (start screen, pause menu, `&weather=`), a quality governor, a render scale that probes upward, wind and gusts in the shared flight model, weather audio (decision 143)
  - [ ] Owner, on a machine with a GPU: frame rates by weather, the first frames after "Fly", GUI → Atmosphere (the frame loop, the menus and the switch between map and simulation view ran in Chromium on a software rasterizer, decision 144)
  - [ ] Owner: watch "Quality now" and the resolution on a steady view; either changing more often than once a minute is a governor or render-scale bug (thresholds come from simulated machines)
  - [ ] Owner: fly the wind and gusts in storm, blizzard and dust storm (only the scripted pilot has); retire the 8 m/s cap on the ground once the control laws hold a gale on the runway
  - [ ] Owner: fly a crosswind takeoff and landing by hand with the track hold (decision 145). A crabbed touchdown ends 4 to 8 m off the centerline (an integral term if that is too much); at 30 m/s a tapped pedal turn gives back 15 to 25% on release, because the hold takes the track at release and the nose returns to it
  - [ ] `controlLaws.ts` and `flightModel.ts` each carry the track hold's 2 m/s threshold as a literal: export `TRACK_MIN_SPEED`
  - [ ] Render scale and governor on a page capped at 30 FPS with a 100 ms frame about once a second: the scale bounces and the governor ends near its second step, though fewer pixels help nothing there. The governor should not read a low scale as a struggle while the median frame time is on target
  - [ ] Target FPS 60 on a page capped at 30: scale 0.35 and the governor's second step within minutes. Use the trial of decision 145: a step down that does not shorten the median is taken back
  - [ ] Render scale: a probe that fails inside a slow spell delays the climb back by up to two minutes; treat a failure within about 10 s of a large step down as provisional
  - [ ] Cuts closer than about 10 s apart keep the governor from acting: check that no future caller of `resetAtmosphere()` is periodic
  - [ ] Audio: try the first-touch start on iOS and iPadOS Safari and on Chrome for Android; listen to the volume tone and to a cut during a storm
  - [ ] The debug panel's volume control gives no sound while paused
  - [ ] Model viewer: decide whether a software adapter needs a notice there (it generates no world)
  - [x] The pause menu's volume slider gives no sound while paused: it plays a short tone and lets the ambience run for 1.2 s (decision 145)
  - [ ] A campaign weather override also shows on the strategic map; a preset's temperature shift is taken at the camera
  - [ ] Dust does not dim the aircraft's ground shadow
  - [x] The start screen's weather options are long descriptions; shorten them to labels (short names with the description beside the list, decision 145)
- [x] Cast shadows from terrain: a height-field shadow baked around the camera, three nested grids, soft edges; deeper sky fill, a low-sun exposure for surfaces, snow sparkle and wet ground (`render/sim/lighting/terrainShadow.ts`, decision 139)
  - [x] Wire the app: `globe.shadows.setHeights` with the terrain's world in `main.ts` and in Free Flight (decision 143)
  - [ ] Shadows cast by trees, buildings and aircraft (Part I: the aircraft's shadow on the ground is a height cue)
  - [ ] Cross-fade when finer tile heights arrive under the near grid (the field is replaced at once today)
  - [ ] Conifer forest in a mountain's shadow at a 3° sun is close to black (luma 9–14): a shadow lift in the golden and dusk grade bands
  - [x] GUI controls: mountain shadows, shadow softness and snow sparkle (GUI → Atmosphere → Shadows and snow, decision 143)
  - [ ] GUI controls for `lighting.skyLean` and `lighting.lowSunExposure`
- [x] Sky: a sky-view LUT with multiple scattering, sun disk with halo, moon with phases and moonlight, stars, clear-air haze that keeps the ground's palette, twilight gain and sunset vibrance (`render/sim/atmosphere/skyView.ts`, `core/moon.ts`, decision 140)
  - [x] Wire the app: `globe.gameTime`, `globe.planetOrbit`, `globe.calendar` and `globe.weatherView` in `main.ts` and in Free Flight (decision 143)
  - [ ] Moon glint on water; clouds shading moonlight
  - [x] GUI slider for `atmosphere.haze` (GUI → Atmosphere → Clouds, fog and dust, decision 143)
  - [ ] GUI slider for `lighting.sunsetVibrance`, a toggle for `twilightAdaptation`
  - [ ] Point the `sunset` preview view at a real sunset (its sun is at −6.7°)
- [x] Exposure tied to time of day (Part I, Post-Processing): a twilight gain on the sun's illuminance, a low-sun sky fill and a low-sun exposure for surfaces (decisions 139, 140); the `sunset` view's ground median went from luma 10 to 29
- [ ] Night: settled land glows a uniform warm brown at 6 km with no distinct town lights (style audit, `night`); keep the rural glow to points and let towns read as clusters of lights
- [x] Post-processing for the simulation view: bloom on emissives and glints, a grade per time-of-day band, faint film grain and dither, a low-resolution volumetric stage and an overlay scene (`render/sim/post/`, decision 138)
  - [x] Check the pipeline in a real browser: the validation guard, the canvas path, switching views (Chromium on lavapipe, `tools/browser.smoke.mjs`, decision 144)
  - [ ] Revisit bloom strength and thresholds at 1080p once clouds and the new sky exist (tuned at 640×360)
  - [ ] Runway lights barely bloom at dusk: they are as bright as the sky then (`StructureLayer.lightBrightness`)
  - [ ] Optional pixelation pass (Part I, Post-Processing)
- [ ] Pixelation option: nearest-neighbor upscale of the reduced render scale, with optional ordered dithering on sky gradients, default 75% on desktop (Part I; decision 69's render scale upscales smoothly)
- [ ] Acceptance checks 1–5 (Part I) against the reference board; owner checkpoint
  - [x] Rendered at 1408 × 792 with trees, live and fair weather, beside `main`'s (decision 144), and compared with the text of Part I; the reference screenshots are not in the cloud session, so the comparison with the board is the owner's
  - [x] Check 1 (`mixed`): cumulus terraces from close above (the march's skip to a column's top put all nine sample offsets on the top; decision 145)
  - [x] Check 4 (`dusk`): a grid of columns in the cloud deck (the upsample's weight floor rippled every gradient at the texel period; decision 145). The teal fringes in the gaps are the neutral twilight sky against the orange deck: measured, no pixel has green above red
  - [ ] Check 4 (`dusk`): the far cloud band still shows low-resolution blocks (3-pixel texels at medium), and texel rows are 0.06 levels darker than the rows between them (0.5 in the brightest cloud; below the grain): try a smoother upsampling kernel and count its reads
  - [ ] Check 4 with `WEATHER=fair`: a faint yellow dot with a streak under it at (805, 120) of 1408 × 792: the twilight sky through a thin spot in the deck; find why the deck has a pinhole there
  - [ ] Check 4 with `WEATHER=clear`: the gradient is a more saturated orange than the guide's `#F6B07A`, with a dark blue-violet band at the horizon
  - [ ] Cumulus seen from the side at medium quality carry a fine stipple that high does not have (reduced only slightly by the softer light steps of decision 145)
  - [ ] Cumulus seen from above at a high sun are nearly uniform white (check 1): more shading in the creases without bringing back the stipple
  - [ ] The deep form of the cloud's light now starts at the shortest step (`LIGHT_STEPS` [10, 90]): a deck from below is 1.6 times brighter in linear terms than before decision 145; owner's eye at the checkpoint
  - [ ] Under an overcast the sea is nearly flat: an even gray sky gives the ripples no gradient to mirror. Try the overcast sky's gradient (zenith three times the horizon), no extra reads
  - [ ] From 20 km straight down a closed deck lets 14% of the ground through at medium and 24% at low (a march of the same density in even steps: 5%)
  - [ ] Mountain shadows fading in after a cut lighten for a moment when the near grid is published (the coarse grid's share is dropped while the middle one still fades)
  - [ ] `tests/gpu/volumetrics.test.ts`: set the camera's own fog, rain and snow in the rig's `WeatherState`, as the app does
  - [ ] `SimPipeline` frees three's frame target through the private `_frameBufferTargets` (r187): check at the next three upgrade
  - [x] Checks 1 and 4 under the weather: rendered in live, fair and clear weather (decision 145)
  - [ ] Check 1 (`mixed`) at 5 km sits inside the cumulus layer and check 4 (`dusk`) under a closed deck in live and fair weather: move check 1 under the cloud base, or make `WEATHER=clear` the checks' default, so the landscape and the dusk gradient can be judged
  - [ ] Check 1 in clear weather: the river is a thin pale line, the town a lilac patch without visible buildings, forest edges are stair-stepped and lowland facets hardly show (predates the atmosphere work)
  - [ ] Check 3 (`range`): forest slopes in mountain shadow are near black (see the shadow lift under "Cast shadows from terrain")
  - [ ] Check 2 (`conifer`): the town reads as a patch of large triangles in roof and wall colors with tiny houses on it, and no road shows at 500 m (predates the atmosphere work)
  - [ ] Check 5 (`beach`): regular ripple moiré on the water under the sun glint; no sand strip at the shore (predates)
  - [ ] Check 4: no parked aircraft on the apron (V3)
- [x] The built app in headless Chromium with WebGPU (`tools/browser.smoke.mjs`, lavapipe through a shim); cost against `main`; sky LUT bakes 3 to 9 times less often in flight, the coverage bake spread over six frames, idle render targets freed; Esc closes the pause menu (decision 144)
  - [x] A notice for a browser that offers only a software WebGPU adapter, with "Start anyway" (`software` in the URL skips it; decision 145)
  - [x] With the wind on (the default), an unsteered takeoff roll left the runway: the shared control laws now hold the ground track with free pedals (`trackHold`, decision 145); the smoke test takes off in the day's wind
  - [x] The governor stepped down during the first flight's shader compiles and tile loads: it counts no frame for 5 s after a cut and while tiles are pending (decision 145)
  - [x] Snow near the camera: the aircraft 12 m ahead was veiled by about 22% at 1.1 km visibility; within 15 m the air now has the weather's own extinction (4.3%; decision 145)
  - [ ] Measure in a browser on real GPUs: frame time by weather and quality, the coverage bake per face, main-thread time per pipeline pass (Node on Dawn: 0.1 ms per pass, 7 to 11 passes)
  - [ ] The sky LUT still bakes about 5 times a second in a 10 m/s climb; if it shows on integrated GPUs, bound it to every other frame
  - [ ] The shadow bake's tile-height fill allocates 40 to 80 KB per frame in bursts; its two work grids (4 MiB) could be freed between bakes
  - [ ] Add the cost pass's modes (weather × quality matrix, per-subsystem flight profile) to `tools/render.preview.ts`
- [x] Adversarial review of decisions 137–144 and of its own fixes: the render scale no longer ratchets on single long frames, the track hold, the march's skip, fog strata, near veils, cirrus, water under cloud, shadows across a cube-face crossing, the upsample's ripple (decision 145)
- [x] Water in the terrain (decision 146): river water surfaces that never rise downstream (profiles in `RiverIndex`, carving last in the tiles; `tools/rivers.preview.ts`), cliffs on headlands and beaches in coves, marshes with pools at the water table, a sea that does not repeat from altitude (gusts and calms streaked along the wind, swell, color patches, whitecaps); the sun's sparkle in low views kept (owner's review)
  - [ ] Owner: canyons, falls and confluences in the browser; the sea from 5–15 km; beaches, cliffs and marshes (`SPOTS=cliffs,marsh`)
  - [x] Skerry islands showed pale blue patches on land at 150 m (`SPOTS=skerries`): dry vertices reading the shelf's material; now sand or rock (decision 146)
  - [ ] A thin channel beside a large river draws as a dark water strip along its bank (`tower` at 3.04, −26.19 on seed 1983); find which layer draws it
  - [ ] Salt marsh on low coasts is rare (most become beaches); decide with the owner whether wet, low coasts should favor marsh over sand
  - [ ] Beach and marsh edges step with the 48 m samples (per-sample covers); a smoother edge would need the cover as a field the shader thresholds
  - [ ] The strategic map's wetland mask (decision 81) could take the tiles' marsh rule on the global grid
  - [ ] Sea state from the surface wind once the weather reports it near the ground (the shader takes only the wind's direction, read at the camera's height, and the storm channel)
- [x] River banks and bars (sand, gravel), a darker bank line, white water on fast reaches, foam on lake shores (decision 147)
- [x] A blob of surf in the middle of a lake (lake shore distance over shoals) and white water on lakes (decision 155)
- [x] Holes in the sea when flying low, down to the skirts: the horizon margin shrank the tiles' bounding caps (decision 152)
  - [ ] Skirts copy their edge vertex's water attributes, so any hole (a tile still loading) shows them as walls of water; shade skirts as dark ground or seabed
  - [ ] Owner: white water and lake foam in motion in the browser; the GUI's "River white water" and "River banks"
  - [ ] Point bars on the inside of bends: store each bend's side in the river index (the meander code knows it)
  - [ ] Lake foam is about one mesh vertex wide at level 7; a finer shore distance (per fragment from the lake depth) would sharpen it
- [x] Ground detail that fades in near the ground (owner, 2026-11-16, after the first helicopter flight): now the ground detail track (decision 168)

### V3. Models and bases

Aircraft, vehicles, ships, buildings and trees are generated in code from small JSON specs, flat-shaded with vertex colors ([docs/visual-style.md](docs/visual-style.md) Part I, decision 70).

- [x] Settlement building clusters scaled by population (old M5; instanced boxes, off by default on the globe since decision 71)
- [x] Airbase runway meshes (drawn as concrete in the terrain shader, plus hangar and shelter meshes; decision 65) (old M5)
- [x] Flatten the terrain under runways (they follow the fine terrain's detail noise) (old M5): a height hook in `surfaceSampler` that blends toward the field elevation inside the airfield, and a terrain rebuild when the infrastructure arrives (decision 108)
  - [ ] Owner: look at an airfield low and along the runway in the browser (embankment height, margin width); `VIEWS=runway` in the preview
  - [ ] Move the grading to a layer the sim's execution layer can import (flight, line of sight) once those query terrain (P1). Free Flight's flight model receives the ground as a function (`freeflight/ground.ts`, decision 134), so it imports no render code yet
- [x] Model spec JSON format and types (decision 106): lofted fuselages from 6–8-sided cross-sections along the length; wings and tails as extruded planforms with sweep, dihedral, thickness and a sharp leading edge; primitives (box, beveled box, pyramid stack, coarse icosphere blob, cylinder); mirroring; named face groups; camouflage schemes mapping face groups to palette colors; emissive points (afterburners, navigation lights). Validation with clear errors, and tests
- [x] Procedural model builder (decision 106): spec → non-indexed, flat-shaded `BufferGeometry` with vertex colors and baked per-vertex AO, plus emissive anchors; deterministic (same spec, same bytes); fails a test when a model exceeds its class's triangle budget from the guide
- [x] Faction palettes and camouflage schemes from the guide's palette tables, as data shared by the builder and the viewer (plus ship schemes, decision 106)
- [x] Debug model-viewer page (decision 106; `viewer.html`): renders any spec with a turntable, sun direction and time of day, sky light and exposure controls, wireframe, triangle count, and a silhouette mode (solid black on a pale sky, Part I acceptance check 6); hot-reloads specs in dev; reachable from the debug GUI and built as a second Vite page under `/bearing/`
- [x] First specs: one fighter and one strike aircraft per side (F-21 Kestrel, F-124 Harrow, Vo-31 Strizh, Vo-35 Molot), checked with the silhouette test in `tools/models.preview.ts`
  - [x] Owner review of the previews (2026-11-12): wingtip missiles onto the F-21's tips, the F-124's outer wings into the fuselage, stores under the wings of the Vo-31 and Vo-35, both Vo-35 wings one color (camouflage now symmetric), the destroyer's radar mast onto the bridge roof
  - [x] Owner: check them in the model viewer in the browser (shading, camouflage patches, silhouettes) (2026-11-12)
  - [x] Ink outlines on models, switchable (owner request; decision 107)
  - [ ] Browser check: ink outlines in the viewer and on buildings in the simulation view (width, fade with distance, no ink blots far away)
  - [ ] Markings: national insignia, modex numbers and squadron codes as painted faces or decals (Part I, Aircraft)
- [x] Base kit from specs: hangars, hardened shelters, tower, radar on a lattice mast, radar dome, fuel tanks, revetments, placed at airbases in the simulation view (decision 106)
  - [x] Runway and taxiway markings in the pavement shader (threshold bars, centerline dashes, runway numbers) (decision 109)
    - [ ] Owner: check the paint in the browser low over a runway (legibility of the numbers, shimmer of the thin lines at 1–3 km)
  - [x] Night lighting: runway edge lights, apron floods and tower windows from the models' emissive anchors (decision 110)
    - [ ] Owner: the `dusk` preview and a browser look at an airbase after sunset (GUI → View → Buildings on, Night lights); brightness and size of the points
    - [ ] Blinking beacons (a clock uniform on the structure layer); bloom on emissives (Part I, Post-Processing)
- [x] Settlement buildings from specs (pitched and flat roofs, taller city blocks), using S4's urban extents (decision 106)
  - [x] The terrain's built-up patch is still the urban radius disk; draw it from the extent polygon too (decision 111)
  - [ ] Town buildings read as dark specks from 3 km (`DETAIL=1 VIEWS=town`): walls facing away from the sun get only a weak sky light; tune with V1's style audit
- [x] Ship specs: carrier (CVN-73 Resolute), Alliance destroyer, Pact cruiser (decision 106)
  - [ ] Ship meshes in the simulation view once ships exist (carrier groups exist since C2, decision 132; convoys and amphibious groups in C3)
- [ ] Checkpoint: owner review in the model viewer (done 2026-11-12) and at an airbase in the simulation view (waits for a camera that can get close: V1's observer camera; from the free camera the owner cannot see hangars)

### V4. Transition, camera rig, and spectator HUD

Follow a flight from mission search into the simulation view and back. Chase camera with per-type rigs, free look, and terrain avoidance. Read-only HUD with flight path marker, tapes, and heading for the followed aircraft. Bearing has no cockpits (decision 94): this is the view the player later flies in (P1).

- [ ] Low-poly aircraft meshes from model specs for flights within the simulation view
- [ ] The followed aircraft at the controlled-aircraft detail level (1,500–4,000 triangles, flat-shaded; Part I, _The Controlled Aircraft_), with its shadow on terrain visible down to the ground
- [ ] Chase camera behind and slightly above one aircraft of a mission, on a spring-damper so it lags behind rolls, pitch changes and acceleration while keeping the aircraft near screen center; tests for the damping and the centering bound
- [ ] Per-type camera rigs: offsets and damping in the model spec (further back and looser for fast jets, closer and tighter for helicopters, further back and higher for bombers and transports)
- [ ] Free look: hold a key or mouse button to orbit the camera around the aircraft; release springs it back
- [ ] Terrain awareness: raycast against the height map so the camera never clips terrain; at low altitude it lowers and closes in; tests on synthetic terrain
- [ ] Read-only HUD for the followed aircraft: Canvas 2D overlay at device pixel ratio; flight path marker projected from the velocity vector at a great distance (no parallax from the camera offset); airspeed, altitude and heading tapes; single color with a thin dark halo (Part I, _HUD and Displays_)
- [ ] Transition controller in `render/common/`: the strategic camera eases toward the flight down to the zoom floor, a quick dissolve through a cloud layer, the simulation view opens behind the aircraft; under 2 s; both scenes stay resident
- [ ] Return to the map: reverse transition, landing the strategic camera above the flight's position
- [ ] _Follow_ from mission search and from a subscription offer starts the transition
- [ ] Retire the debug free camera, or keep it only behind the dev flag (decision 72)
- [ ] Follow representative sorties to judge the range factor (design open question)
- [ ] Acceptance checks 7 (HUD legible against bright sky, snow and night), 8 (flight path marker only) and 10 (no terrain clipping in valley flight) as scripted sequences in `tools/render.preview.ts` (Part I)
- [ ] Checkpoint: owner review of following missions from the map into the simulation view and back, with the camera rig and HUD

## Integration

### I1. Polish (old M9)

- [ ] Side selection at campaign start, with the generated briefing
- [ ] Cache the strategic graph and the cast with the world in IndexedDB
- [ ] Generation profiling and progress polish (no time budget, decision 12)
- [ ] Rendering performance pass (GPU timestamp queries, frame budget); consider building tile meshes in a worker (decision 30)
  - [x] First pass after the owner saw 1–2 fps on an RTX 5090 laptop (decision 69): device on the high-performance adapter, tile bounds from each tile's own heights (5–9× fewer draws at 20–50 km), cloud coverage baked by compute for shadows, light shared per fragment, water and night lights branch off where they do not show, adaptive render scale
  - [x] `PERF=n` and `PROF=<file>` in `tools/render.preview.ts` (frame and CPU times, draw statistics, V8 profiles)
  - [ ] Owner check in the browser: 25–30 fps in map views (20–300 km) while panning; Status → Backend names the discrete GPU
  - [ ] GPU timestamp queries per pass, to split terrain, clouds, sky and trees on real hardware
  - [ ] Per-object uniforms on terrain meshes (eight per tile) packed into fewer, if draw submission shows up in profiles
- [ ] Acceptance checks for both views (Part I checks 1–6, Part II checks 1–5) on the final build
- [ ] Bundle size and code splitting
- [ ] Scripted flythrough camera path for screenshots, including a dawn and a weather front, across both views
- [ ] Check every demo goal against the design doc and decisions

## Free Flight (sandbox; decisions 134, 135)

A sandbox outside the campaign: pick a seed and an airbase, take off in the F-21 Kestrel, fly anywhere, land at any airbase. It pulls a first version of P1 and part of P2 forward; the plan is [docs/plans/free-flight.md](docs/plans/free-flight.md) and the report [docs/reports/free-flight-report.md](docs/reports/free-flight-report.md).

- [x] Plan: survey, what to build and reuse, deviations (`docs/plans/free-flight.md`)
- [x] Entry: `?mode=freeflight&seed=…&base=…` (`tod`, `spawn`, `fuel`, `autopilot`), and a GUI button; no war simulation in the mode
- [x] Start screen: seed, airbases with side, region and runway, a map click picks the nearest base; time of day (17:00), unlimited fuel, runway or air start
- [x] Runways: the coarse pass's heading and length, the graded pads (decision 108) as the flight model's ground; touchdown-zone bars in the paint
- [x] Flight model in `src/sim/flight/`: standard atmosphere, thrust, lift, drag, control laws, ground model, gear, outcomes; data in the Kestrel's spec; deterministic at 120 Hz
- [x] Controls: one remappable binding table, keyboard stick, mouse as stick, throttle detents, free look; mouse aim through the flight director (simplified, decision 135); basic gamepad axes
- [x] Chase camera with springs, free look and terrain clearance; animated gear, surfaces, speedbrakes, afterburner and a shadow on the Kestrel
- [x] HUD: flight path marker, boresight, runway marker, tapes, attitude, G, AoA indexer, throttle, fuel, states, landing aid, messages, F3 debug panel
- [x] Session: pause menu, summary card after a stop or a crash, refuel and take off from another base
- [x] Tests: atmosphere, tables, limits, rest stability, determinism, outcomes, plausibility, the headless circuit from a generated airbase; renders and HUD composites in `docs/reports/screens/`
- [ ] Owner: fly it in a desktop browser (takeoff, circuit, landing at another base) and judge the feel: rotation, roll rate, pitch response, the flare, ground handling
- [ ] Owner: runway pavement concrete (as now) or dark asphalt (decision 135)
- [ ] Mouse aim as in Proposal 0002: a world-locked aim point that the camera follows, not the cursor's direction in the chase view (P1)
- [x] Direct mode (the captured mouse's offset from the center is the stick, keys win), inversion per mode, the control cursor in its own color, the jet's sticky right-button look with V and the wheel (decision 198)
  - [ ] Owner: fly direct mode and judge the stick's travel (full at 0.7 of the half-screen) and the dead zone
  - [x] Mouse aim takes the stick only once the mouse has been captured; a keyboard takeoff was put back on the runway at liftoff (decision 206, found by the browser smoke test)
- [ ] The Kestrel at the controlled-aircraft detail level (1,500–4,000 triangles) with navigation lights and a blinking beacon at night (V4)
- [ ] Shadow without double darkening where triangles overlap (a stencil or a max-blend pass)
- [x] Weather in Free Flight: run the weather model without the war, so clouds and winds show (`StandaloneWeather`, decisions 137, 143)
- [ ] Initial fuel option: with unlimited fuel the Kestrel always weighs 13.3 t and approaches at about 164 kt; a landing at 1,000 kg of fuel comes in near 145 kt
- [ ] Nosewheel steering switch (castoring nosewheel without it), so differential braking alone can turn the aircraft
- [ ] Key remapping in the UI (the table exists; there is no settings page), and gamepad buttons for gear, brakes and throttle detents
- [ ] Browser check on a machine with a GPU: run `node tools/browser.smoke.mjs` with `MODE=gpu` (never run; headless Chromium may need `HEADED=1` for the real adapter). In the cloud session the app flies end to end in Chromium on lavapipe (decision 144)
- [ ] Departures and spins: the control laws hold the aircraft inside the α and g limits, and the model has no aerodynamic moment tables yet (decision 134)

## Piloting track (after the demo)

Player flight control in the chase view, with the HUD and displays as 2D overlays and no cockpits ([docs/proposals/0002-third-person-flight.md](docs/proposals/0002-third-person-flight.md), decision 94). AI pilots and the player share one flight director and one flight model. The displays, status strip, master modes and AI crews follow [docs/proposals/0006-displays-and-crew.md](docs/proposals/0006-displays-and-crew.md) (decision 189); the plan is [docs/plans/displays.md](docs/plans/displays.md). P1 depends on V4. P2 depends on P1, and its Free Flight work may start before P1 closes. P3 depends on P2 and S4. P4 and P5 depend on P3, P6 on P3. All P milestones touch rendering or UI, so they close only after the Part I acceptance checks.

### P1. Flight model and controls

Table-driven flight model, flight director shared with the AI, mouse-aim and direct schemes, flight stick support through the Gamepad API, take control and hand back. Free Flight (decision 134) has a first version of the flight model, the control laws, the flight director, direct control and the animated parts; P1 extends them to every type and to the campaign.

- [ ] Flight-model tables in the aircraft JSON spec (thrust, drag, lift, instantaneous and sustained turn rates, specific excess power, roll rate, and the effects of altitude, wing sweep and stores), with validation and tests
- [ ] Table-driven flight model in `src/sim/` (SI units, deterministic, no `Math.random`): energy management, stalls and departures in simplified form; tests that sustained turn rate and specific excess power match the tables
- [ ] Decide where the flight model and flight director run for the player's aircraft (sim worker or main thread, given input latency) and log it
- [ ] Flight director: desired direction and speed → control inputs for the flight model; one implementation for AI pilots and the player; tests that it reaches and holds an aim point
- [ ] Full fidelity for the controlled or followed aircraft: deterministic switch from the analytic route to the flight model and back (promotion and demotion)
- [ ] Mouse aim (default): the mouse steers an aim point in the world, the camera follows it, the flight director flies toward it; keyboard for throttle, rudder overrides, weapons and displays
- [ ] Direct control: keyboard and mouse-as-stick drive the control surfaces through a stability augmentation layer
- [ ] Flight stick support through the Gamepad API, with axis and button bindings
- [ ] Take control and hand back: _Jump in_ from mission search and subscription offers; handback gives the flight director an aim point from the AI's orders instead of the mouse
- [ ] Flight cap on time acceleration: while the player controls an aircraft, up to 8× in cruise phases, cancelled on any threat
- [ ] Animated parts from model-spec hinge axes and pivots: control surfaces, flaps, slats, airbrakes and speedbrakes from control inputs; swing wings with speed; afterburner nozzles (helicopter rotor discs move to H1, decision 149)
- [ ] Flight effects: vapor and wingtip vortices at high G, contrails at altitude, heat shimmer behind engines, dust and spray at very low level (rotor downwash moves to H3, decision 149)
- [ ] Acceptance check 9 (aircraft readable and centered in a maximum-rate turn) as a scripted sequence
- [ ] Checkpoint: owner flies representative aircraft with mouse aim and a flight stick, takes control and hands back

### P2. HUD, displays and status strip

The allocation rule, the display frame, slots and slot states, the status strip, master modes, cursor mode, faction skins and the moving map format; Free Flight's discrete indicators move from the HUD into the status strip. Free Flight's HUD (decision 135, `src/ui/flight/hud.ts`) is the starting point; the steps are the plan's.

- [x] Owner: confirm decision 189's readings (decision 193): torque and RPM to the strip, immediate warnings on the HUD, fuel off the HUD, avionics state in the sim; one capture key for every aircraft instead of a software cursor; keys only for hot display actions
  - [ ] Owner: readings 3 (the throttle stays on the HUD) and 8–14, and the plan's recommendations on voice, single-seat help and spectating (working assumptions until answered)
- [x] Spike and capture key (decision 193): Tab grabs and frees the pointer lock in the jet and the helicopters (`ui/flight/mouseCapture.ts`), a click grabs it, a lock the browser drops pauses, refused grabs are retried; the jet's mouse stick and mouse aim under pointer lock with a relative cursor; tests, and the session tool presses real keys in Chromium
  - [x] Fix (decision 195): the owner could capture the mouse in the Kestrel but not fly with it (keyboard mode ignored it). A capture in keyboard mode now starts the last mouse mode (mouse aim first), the keys free the mouse, and the jet reads motion as the helicopter does; `HEADED=1` in the session tool checks with a real mouse under Xvfb
  - [ ] Owner: Tab, a click and Escape in Firefox and Safari and in Chrome on Windows (only Chromium on Linux was probed); fly the Kestrel with mouse aim and mouse stick under pointer lock
- [ ] Allocation inventory: every Free Flight HUD item classified by the rule (the plan's table), recorded with the decision that closes P2
- [x] `layout()` (`src/ui/displays/layout.ts`, decision 195): slot rects and tabs from the viewport and the UI scale only; large squares 28% of the height, small slots 60% of that, the strip bottom center; the central column (middle 60% of the width above the strip) never entered, so slots shrink on 4:3 and portrait and stop growing with the UI scale at the column; tests over 12 viewports and 4 scales, pinned at 1920 × 1080; `SLOTS=1` draws them over a HUD composite
  - [ ] The HUD's retrofit keeps every HUD element inside `layout().center` (the helicopter HUD fits at 1280 × 720, 1366 × 768 and 1920 × 1080; check the jet's HUD and 4:3 when the jet's composites can be drawn again)
  - [ ] Owner: the slot sizes in the pictures (`docs/reports/screens/hover-transition-slots-*.png`); a large slot is 201 px at 1280 × 720, small for 20 bezel buttons
- [x] Display model types (`DisplayModel`, 20 bezel buttons with label, state, enabled and command; owner tag; scope vector items, map descriptions, render-target screens), `DisplayCommand`, `DisplayState`, the format registry in `src/ui/displays/`; test that snapshots and models survive `structuredClone` and JSON (decision 199)
- [x] `sim/avionics/`: `AvionicsState`, `AvionicsCommand`, `apply`; avionics profiles in the model spec (slots, formats per slot, systems, skin, era bezel, crew roles) parsed and validated as `rotorSpec.ts` is; profiles for the Kestrel, the Wren and the Buzzard (decision 199; profiles in code keyed by model spec until P3, then into the specs)
- [x] Display frame in HTML and CSS: bezel with 20 buttons, on-screen labels, owner tag, focus ring, alert highlight; expanded, collapsed and hidden states with 300 ms transitions from the edge; Alliance and Pact skins as CSS variables (Part I, _Displays and Status Strip_); the round era bezel (decision 199)
  - [ ] The round era bezel (no aircraft needs it yet)
  - [ ] Owner: the bezel, the buttons and the screens in a browser, both skins
- [x] Status strip: `stripItems(snapshot, mode)` rules for GEAR, PARK BRK, BRAKES, SPD BRK, AB, the control mode, HOVER HOLD, ALT HOLD, JOKER, BINGO, LOW FUEL, GEAR SPEED and the proposal's conflicts; levels, shapes and labels; clicks and keys; the master caution; the helicopter's torque, rotor RPM and power margin gauges (decision 199)
- [x] Master modes: `nextMode` with the triggers (ground, navigation, approach, hover; air-to-air, dogfight and air-to-ground by key until P4), hysteresis, presets, pins, HUD declutter levels; preset edits saved per viewer in browser storage with the defaults as fallback (decision 199: `autoMode` in sim/avionics, presets in ui/displays)
  - [x] Preset edits saved per viewer in browser storage, with a reset in the pause menu (decision 200)
- [ ] Cursor mode with the displays: the free cursor clicks bezel buttons and strip items, the wheel over a display sets range or zoom; the director holds the aim point, or attitude and altitude in direct control; hover hold in a slow helicopter
- [x] Hot-action bindings (master modes, dogfight, slot states, master caution, map range; later radar, designation, countermeasures, weapons, crew menu) in the binding tables and the help overlay; each format lists its hot actions and a test enumerates them against the bindings; no keys for bezel buttons (decision 193) (decision 199: 1–4, M, F, K; radar, designation, countermeasures, weapons and the crew menu come with their formats)
- [x] Messages format in the messages slot: Free Flight's messages move there (summary and crash cards stay) (decision 199)
- [x] Moving map, strategic mode (decision 201): `StrategicScene.renderMap` from a straight-down camera into a render target every 0.5 s, read back into the display's canvas, √2 wider than the range so track-up and the aircraft's motion are a 2D transform; 5–160 nm; north-up and track-up; the aircraft, a ring at half the range; `MAP=1` in the strategic render preview writes the pictures
  - [ ] Owner: the map in a browser with a GPU: legibility at 10 nm, the cost of a picture every half second (the label pass runs each time), whether 2 Hz motion between pictures reads smoothly
  - [x] The destination runway on the map, and the wheel for its range (decision 202)
  - [ ] Route and waypoints, and the side's front and threat rings as the format's overlays (with missions and P3's sensor model)
  - [ ] Judge the base map at 10 nm on a 400-pixel display; if the 1.5 km grid looks blocky, strategic mode stops at 20 nm
- [x] Engines and fuel format, first version: fuel state, joker and bingo (pulled forward from P3 so fuel can leave the HUD) (decision 199)
- [x] Retrofit Free Flight: states, fuel, messages, torque and rotor RPM leave the HUD (`hud.ts`, `hudFrame.ts`, `heloHud.ts`); the HUD follows the master mode; the helicopter's hover symbology stays (decision 199: `HudFrame.panels`)
- [x] Tests: master mode transitions and pins; strip items in scripted Free Flight scenarios (gear up slow and low, speedbrake with afterburner, parking brake with throttle, hover hold); display model snapshots (decision 199: tests/displays.test.ts, the session tool)
- [ ] Previews (in-flight screenshots done: `SHOT_DIR` in the session tool, decision 199): `tools/hud/` composites of displays and strip for the Kestrel and a helicopter in each master mode; `tools/freeflight.screens.mjs` shots; the browser smoke test checks that displays and strip exist and measures their CPU time (under 2 ms per frame) and the map's GPU pass
- [x] UI scale setting in the pause menu (0.75–1.5) and the URL (decision 200)
- [ ] HUD color: tune the values and record them in `docs/visual-style.md` (decision 203: thicken or brighten the tapes' thin ticks against a bright snow sky)
- [ ] Acceptance checks 7, 12 and 13 (Part I)
  - [x] Checks 12 and 13 as a tool, `tools/displays.screens.mjs` (decision 200): no slot in the column, at most two large and two small expanded, both skins and the three deficiencies; four color-only cues fixed
  - [ ] Checks 12 and 13 again with the moving map, and over real renders when a GPU is at hand
  - [x] Check 7 with the full HUD (decision 203): passed at noon, in snow and at night over lavapipe renders, `docs/reports/screens/check7/`; the thinnest tape ticks are faint on a bright snow sky (for the HUD color task)
- [ ] Checkpoint: owner review of the HUD, displays and strip in Free Flight in both aircraft kinds, with mouse and keyboard

### P3. Sensors and formats

The sensor model, avionics profiles with display complements, datalink tracks, the elevation mode of the moving map, and the air-to-air radar, air-to-ground radar, threat warning, stores, engines and fuel, and comms formats; the Su-27 analogue's HUD-integrated radar. May split into P3a (sensor model, radar, threat warning) and P3b (the rest).

- [ ] Sensor model in `sim/sensors/`, per aircraft: radar detection by radar type (none, ranging only, pulse, pulse-Doppler with look-down), mode, range, radar cross-section, aspect, terrain masking and clutter; RWR (emitting radars by bearing and type); visual detection (range, size, aspect, contrast, light); datalink and AWACS tracks with lower precision and a delay (Pact leaning on ground control, Alliance on AWACS); targeting pods and terrain-following radar; deterministic, with tests
- [ ] The AI uses the same filtered picture as the player
- [ ] Avionics profiles for every type of the air war's table, with display complements (the proposal's examples as the first cases)
- [ ] Free Flight targets: scripted traffic and emitters as a start-screen option, so the formats have something to sense
- [ ] Air-to-air radar format: B-scope with range-while-search, track-while-scan, single-target track and dogfight sub-modes; designation cursor with keys and mouse; elevation and azimuth coverage; contact altitude and aspect; datalink tracks marked
- [ ] Threat warning format: RWR symbols by bearing and type, lock and launch indications
- [ ] Air-to-ground radar format: ground map, moving-target mode; the terrain-following scope for the F-111 and Su-24 analogues
- [ ] Stores format: pylons and weapons, selection, fuzing, release mode (CCIP or CCRP), quantity and ripple, jettison, countermeasure programs
- [ ] Engines and fuel format, complete: engine states, damage and failures
- [ ] Comms format: radio channels, AWACS and controller calls, wingman commands, ATC, message history
- [ ] Moving map, elevation mode: the resident terrain tiles drawn from an orthographic camera with hypsometric tints, contours and spot heights; the relative sub-mode (red and hatched above the aircraft, amber within 500 ft below); the global grid beyond the tiles; datalink tracks and threat rings from the side's picture on both modes
- [ ] The Su-27 analogue's radar picture in its HUD
- [ ] Single-seat assists, if the owner wants them: the radar's mode follows the master mode, dogfight mode locks the nearest contact in the boresight; each a toggle
- [ ] Spectator displays, if the owner wants them: the followed aircraft's own picture, read-only
- [ ] Tests: each aircraft shows only its profile's formats in its profile's slots; display model snapshots (radar with tracks, stores after a scripted release, datalink fallback); relative elevation colors in scripted low-level scenarios
- [ ] Acceptance checks 12–14 for a fighter and a strike aircraft
- [ ] Checkpoint: owner review of the displays across aircraft with very different avionics

### P4. Weapons

Guns with lead-computing pipper, air-to-air missiles, bombs with CCIP and CCRP, target and weapon cameras, damage states.

- [ ] Guns with a lead-computing pipper projected at the predicted impact point
- [ ] Air-to-air missiles with seeker circles and guidance
- [ ] Bombs with CCIP fall lines and CCRP release cues
- [ ] Stores hang on pylons and disappear on release; fuel tanks can be jettisoned
- [ ] Target camera: keeps the aircraft (foreground) and the selected target in frame
- [ ] Weapon camera: follows a released missile or bomb, picture-in-picture or full screen
- [ ] Damage states: smoke, fire and missing parts on models; damage in the engines and fuel format
- [ ] Acceptance check 8 with the gun pipper
- [ ] Checkpoint: owner review of a dogfight and an attack run

### P5. Crews and special roles

Format ownership, the crew command menu, the six crew roles, callouts, crew station mode, and the targeting pod, hook camera and airdrop formats (decision 189). Attack helicopter gunner mode moves to H5 and the sling-load tools to H3 (decision 149); the hook camera format is built by whichever of H3 and P5 comes first.

- [ ] `sim/crew/`: a crewmate per crewed seat of the controlled or followed aircraft (role, owned formats, task, skill from the squadron's experience and morale, added to the order of battle if missing); acts only through avionics commands; randomness from a fork of the aircraft's stream
- [ ] Format ownership: shown on the bezel; the player takes a format by using it and hands it back from the crew menu
- [ ] Crew command menu: a radial menu with numbered entries per role, clickable in cursor mode; the crew format (role, task, owned formats)
- [ ] Callouts: events with a priority (launch, lock, threat, contact, waypoint, fuel, task results) in one queue shown in the messages slot; a higher priority interrupts a lower one
- [ ] Roles: radar intercept officer (F-14 analogue), weapon systems officer (F-111, F-4G, Tornado, Su-24 analogues), bombardier/navigator (A-6 analogue), copilot/gunner (attack helicopters), crew chief with directive calls (transport helicopters), loadmaster (transport aircraft)
- [ ] Crew station mode through ownership: the AI pilot flies through the shared director, the player owns the sensor and weapon formats
- [ ] Targeting pod format: FLIR white-hot and black-hot or TV from a render target with a thermal post-process; zoom; point and area track; laser arm and fire
- [ ] Hook camera format, unless H3 built it
- [ ] Airdrop format: drop zone marker and release cue
- [ ] Headless scenario tests: a crewmate locks a contact, designates a ground target, and guides a sling load
- [ ] Blocky crew figures visible through canopies
- [ ] Acceptance checks 12–14 for a crewed strike aircraft and a transport helicopter
- [ ] Checkpoint: owner review of crew station and airdrop sorties and the crew command menu

### P6. Companion displays (later)

Displays popped out of the game window (decision 189). Depends on P3.

- [ ] A display in a second browser window, synced through a `BroadcastChannel`: display models out, display commands back
- [ ] A companion page for a tablet or phone: peer-to-peer pairing by WebRTC with the offer and answer exchanged through QR codes (static hosting, rule 8), or an optional public signaling broker
- [ ] Render-target screens (map, pod, hook camera) on a companion: a light 2D map from the display model, or compressed frames at 2 Hz
- [ ] Checkpoint: owner flies with a display on a second window and a tablet

## Helicopter track (after P1; decision 149)

Rotor-disc helicopters with fly-by-mouse, mouse aim and direct control over one flight director, and three assist presets ([docs/proposals/0004-helicopter-flight.md](docs/proposals/0004-helicopter-flight.md)); the plan is [docs/plans/helicopters.md](docs/plans/helicopters.md). Free Flight is the test bed for H1–H4. H1 depends on P1's framework (the shared airframe and director interfaces, which H1's first task builds, and the input plumbing) and on Free Flight; H5 depends on P4 and on P1's take control and hand back. All H milestones touch rendering or UI, so they close only after the Part I acceptance checks.

- [x] Owner: confirm the plan's readings and answer the open questions (decision 151): H1 starts now; new types stay out of the campaign for now; hot starts only; door gunners AI-only, and in the end any crew position with the AI in the others

### H1. Rotor model and fly-by-mouse

The thrust-disc model, the speed-scheduled controls, the Assisted preset, the hover HUD, the helicopter camera rig, and Free Flight from a helicopter pad with the Little Bird and Black Hawk analogues.

- [x] Shared `Airframe` interface, `rigidBody.ts` and `contact.ts` split out of `flightModel.ts`; Free Flight, the chase camera, the HUD frame and the outcomes read the interface; a lockstep test that the Kestrel's circuit, air maneuvers and braked stand stay bit-identical (decision 154: 15 scenarios hashed every step on Node 22 and 24, recorded before the split; `tools/lockstep.preview.ts` charts them)
  - [ ] Free Flight's flown model as a pair keyed by `kind` (model, controls, director, pose, HUD builder) when the aircraft choice arrives (item below); until then `FreeFlight.model` stays a `FlightModel`
  - [ ] Split `buildHudFrame` into the fields every airframe has and the jet's, for the hover HUD
- [x] Shared director interface (`sim/flight/director.ts`); `DirectorTarget` gains optional heading, ground-velocity and height-reference fields that the fixed-wing director ignores (decision 156: also a point to hover over; a test that the jet's controls are unchanged with them)
- [x] `rotor/rotorSpec.ts`: the spec's `rotor` block (masses, inertias, rotor radius, blades, solidity, hub type and stiffness, flapping time constant, power available by altitude and temperature, power-required curve, tail rotor or yaw authority, drag, fin, stabilizer and wing areas, never-exceed speed, gear, hook points, mouse-turn thresholds), with validation and tests (decision 159; the never-exceed speed, slope limit and crash sink as `limits`; hook points wait for H3)
- [x] Specs for the Little Bird and Black Hawk analogues: names, public figures marked as tuning values, Free Flight only (not in the air war's type table) (MH-14 Wren and UH-68 Buzzard: figures decision 159, models decision 158)
  - [x] The Wren's skid struts reach into the fuselage and its step sits on them (decision 160; the owner saw a gap)
- [x] Inflow and thrust (`inflow.ts`): Glauert momentum inflow by a fixed number of Newton steps, closed-form thrust from collective, ground effect (Cheeseman–Bennett), an empirical branch for steep descent; tests that translational lift arrives between 15 and 25 kt and that ground effect cuts hover power within one diameter (in `rotorAero.ts`: the inflow is a lagged state rather than Newton steps, continuous in every regime; the descent branch is a floor at half the hover's inflow until H4)
- [x] Flapping and hub moment (`flapping.ts`): first-order disc tilt from cyclic, lag behind body rates, moment from hub stiffness and thrust offset by hub type; step-response tests per hub type (in `rotorcraftModel.ts`; per-hub-type step tests wait for H2's teetering and hingeless types)
- [x] Power and rotor speed (`powerplant.ts`): induced, profile, parasite and climb power; power available and the transmission limit; governed rotor speed as a state with droop; tests of hover ceilings in and out of ground effect (in `rotorcraftModel.ts`; hover power tested against the published figures, ceilings wait for the calibration task)
- [x] Yaw (`tailRotor.ts`): torque reaction, tail rotor thrust and its authority limit with power and relative wind; yaw authority for tandem and coaxial types (the tail rotor as a second disc in `rotorcraftModel.ts`; tandem and coaxial types wait for H2)
- [x] Airframe forces: fuselage drag areas, fin and stabilizer (weathervaning, nose attitude), stub-wing lift; `RotorcraftModel` assembles them at 120 Hz in four substeps; determinism test bit for bit
- [ ] Calibration figures in `tools/flight.preview.ts` (hover power is tested; the curves and ceilings are not drawn yet): power-required curves against the spec, translational lift, hover ceilings, step responses; tests that hover, bucket and maximum-speed power match the curve within the type's tolerance
- [x] Augmentation (`rotor/heloLaws.ts`): attitude command and hold, yaw rate command with pedal trim, translational rate command near the hover, climb-rate collective, hover hold on ground velocity and position
- [x] Assists (`rotor/assists.ts`): independent toggles and the Assisted preset (bank and pitch limits, torque limiter, auto hover hold, radar-altitude hold, ground collision warning) (the three presets as data; Standard and Expert behaviors in H2)
- [ ] Rotary director (`rotor/heloDirector.ts`) and a scripted helicopter test pilot; test that the director and the same recorded inputs fly the same result (the tests script `HeloCommand`s through the laws for now)
- [ ] Wind for rotorcraft: a surface-layer profile (logarithmic, roughness from land cover) instead of the jets' 8 m/s ground cap; test that hover hold keeps position in a 10 m/s crosswind; decide whether jets keep the cap
- [x] Fly-by-mouse: pointer lock with relative motion, pitch-attitude command, the speed-scheduled yaw-rate and turn blend between the type's thresholds (settle ground speed against airspeed with the wind tests), W/S, A/D, Q/E and H in the binding table; Escape and the pause menu with pointer lock (`ui/flight/heloInput.ts`; F1 is help for helicopters, H being hover hold)
- [x] Model specs with `rotors`; the animated model spins hubs, tilts the disc by the flapping state, and fades blades into a faceted translucent disc with rotor speed (Part I, _Helicopters_); `tools/models.preview.ts` renders them with the disc (decision 158: the MH-14 Wren and UH-68 Buzzard models, `RotorPose` in `aircraftView.ts`)
  - [x] Free Flight fills `AircraftPose.rotors` (azimuth, rotor speed, flapping tilt) from `RotorcraftModel`
  - [ ] The disc and blade crossfade seen in a browser and in a `tools/freeflight.preview.ts` hover shot (so far only the CPU previews and a static lavapipe render)
- [x] Helicopter `ChaseRig` from the spec: closer and higher, lifting and tilting down as airspeed falls, free look without spring-back in the hover; tests for the schedule (`helicopterRig(rotorRadius)`; the schedule uses ground speed)
  - [x] Owner feedback (2026-11-16, decision 160): free look stays where it is left at any speed, V or a middle click recenters it, the mouse wheel zooms (0.5–3×), and the look point orbits with the eye, so a lowered eye looks toward the horizon
  - [ ] Owner: judge the sticky free look; if the view ahead is still hard to keep, try tilting the camera with the flight path in cruise (the owner's first proposal)
- [x] A solid, even aircraft shadow (decision 170; owner, 2026-11-16: the helicopter's shadow matters near the ground but looks weird and semi-translucent; wanted darker and more robust). Cause: `aircraftView.ts` flattens every posed triangle onto a level plane through the point under the aircraft and blends each at 32% black, so a closed mesh covers its shadow two to four times (top and bottom surfaces, canopy over body, hub): the body reaches 54–75%, skids, fins and blades stay at 32%, and on a slope part of the shadow sinks into the ground and part floats. Plan:
  - One layer everywhere: one shadow mesh and one material for body, blades and disc (per-vertex opacity written on the CPU with the positions; body triangles first), writing depth computed per pixel from the shadow plane (ray through `screenCoordinate` against the plane uniforms, so every triangle at a pixel writes the same bits) with a strict depth test: the first triangle at a pixel shadows it, later ones fail. No stencil: the scene target's float depth (decision 112) would need the optional `depth32float-stencil8` feature
  - Darker and tinted: about 55–60% at a high sun, toward the sun's share of the ground's light (the sky light stays), in a deep blue-gray rather than black (Part I: shadows deep and blue, never black); keep the fade under cloud and in terrain shadow, and fade dust (decision 142 left it out)
  - On slopes: the plane through the ground point under the aircraft along the terrain's normal from three ground samples around it (FreeFlight's ground query, in `AircraftPose`), lifted a few centimeters plus a share of the distance against z-fighting
  - Check: a hover shot in `tools/freeflight.preview.ts` (the Wren at 3 m and 15 m, high and low sun, on a slope) and the Kestrel's runway shot unchanged in shape
  - [ ] The shadow does not dim in a dust storm yet (decision 142 left it out; the lighting has no dust term for it to read)
  - [ ] Owner: the shadow near the ground in the browser, on flat ground and on a slope, high and low sun
- [x] Hover HUD in `hud.ts` and `hudFrame.ts`: ground-plane velocity vector with acceleration cue, radar altitude with vertical speed, torque, rotor RPM, landing zone marker (`hoverSymbols`; `freeflight/heloHud.ts` builds the frame)
  - [ ] Torque and rotor RPM move to the status strip's gauges with P2's retrofit (decision 189)
  - [x] The vertical speed as a figure under the radar altitude, amber in a hard descent near the ground (decision 160: the owner had not found the small fpm figure above the tape)
- [ ] Free Flight: aircraft choice on the start screen and in the URL (`&aircraft=`), helipads painted on airbase aprons on the graded pad, spawn on a pad or in a hover, a landing zone marker at a point picked on the start screen's map
  - [x] Aircraft choice (start screen, `&aircraft=kestrel|scout|utility`), spawn beside the runway's middle or hovering at 150 m, the helicopter's own session path (decision 159)
  - [ ] Helipads on the aprons, a landing zone marker
  - [x] Mouse inversion: per aircraft kind, on the start screen, in the pause menu, the key I and the URL (decision 196)
  - [ ] Mouse sensitivity in the pause menu
  - [ ] Owner: fly both helicopters with a real mouse (the camera's steep look down in a high hover, the mouse's sensitivity, the ease to a stop below 20 kt) and judge the feel
  - [x] The outcomes monitor's runway rules (touched down away from a runway, ran off the runway or the paved field) by kind: a helicopter may land and hover-taxi anywhere; its own hazards (slope, rollover, rotor strike) come with H3 and H4
- [ ] Maneuver tests: 60 s hover in ground effect within 1 m with hover hold; a 360° pedal turn within the type's time; a nap-of-the-earth course at 30 m radar altitude over synthetic ridges without contact
  - [x] Hover hold (0.13 m in 60 s), pedal turns, rest on the gear, takeoff, circuit and landing (`tests/rotorcraft.test.ts`)
  - [ ] Nap-of-the-earth course with radar-altitude hold (the hold itself is not built yet)
- [ ] Previews: `tools/freeflight.preview.ts` shots of a hover over a pad, a transition and low flight; a helicopter scene in `tools/freeflight.session.mjs` and `tools/browser.smoke.mjs`
  - [x] The browser smoke test's `helicopter` part (takeoff, hover, pedal turn, forward flight, landing in the real app); HUD composites in `tools/hud/hover.ts`
- [ ] Adversarial probe workflow on fly-by-mouse and the Assisted preset before the owner flies it (as in decision 136)
- [ ] Part I acceptance checks for the helicopter views (check 9 for a helicopter in a maximum-rate turn; the rotor disc in the silhouette test)
- [ ] Checkpoint: the owner takes off from a pad, flies to a landing zone and lands on the first attempt with mouse and keyboard, in the Little Bird and the Black Hawk analogues

### H2. All modes and types

Mouse aim, direct control with flight stick support, all assists and presets, and the remaining types.

- [ ] Mouse aim: the director points the nose (and a fixed gun or rocket pods) at a world-locked aim point while holding altitude; one key switches to fly-by-mouse in flight
- [ ] Direct control: cyclic and pedals command rates through augmentation, or deflect the controls with it off; manual collective
- [ ] Flight stick, throttle-as-collective and twist or rudder-pedal axes through the Gamepad API, shared with P1's stick task
- [ ] Standard and Expert presets and every assist as a toggle in the pause menu and the URL
- [ ] Remaining type specs: Lynx or Bo-105 (hingeless), Cobra and Huey (teetering), Apache (the AH-70 Lancer of the air war), Hind with wings (the Ve-28 Shershen), Mi-8, and the heavy CH-47 (CH-60 Mule, tandem) and Mi-26 (Ve-36 Bizon); models within Part I's helicopter budget
- [ ] Tests: per-type power and pedal-turn figures; the Lynx analogue's loop and roll with protection off; the Hind's wing offload at speed
- [ ] Checkpoint: owner flies mouse aim, a stick in direct mode, and each preset

### H3. Ground and utility

Skids and wheels, slope and confined-area landings, dynamic rollover, sling loads with the hook camera, hoisting, fast-roping.

- [ ] Skids as sliding contact points and wheels with castoring tail wheel or steered nose wheel; slope limits by type; ground taxi for wheeled types
  - [ ] Running landings on wheels at speed: the utility rolled over after a 50 kt touchdown (no attitude control on the wheels; decision 159)
  - [ ] The ground's normal in `GroundQuery` and `contact.ts`: today the strut acts along the local vertical and friction in the horizontal plane (the Kestrel's level pads), so nothing slides down a slope; the Kestrel must stay bit-identical where the normal is vertical
- [ ] Dynamic rollover from the contact physics, with a warning under protection; test of a slope takeoff that rolls over with protection off
- [ ] Slope and confined-area landings; tests of a slope landing at the type limit and a rejected one beyond it
- [ ] Rooftop and structure contact: the ground query includes building tops (Little Bird rooftop landings); tree strikes from the canopy height field once it exists (decision 148)
- [ ] Ship decks as moving ground where a ship is in the simulation view
- [ ] Sling loads: a cable that can go slack, a load with mass and drag, pickup and release; cable tension and load position on the HUD; test of a load carried 5 km and set down within 3 m
- [ ] Hook camera: a downward render-target view for pickup and placement, as the hook camera format on P2's display frame with load position and cable tension (decision 189; built here or in P5, whichever comes first)
- [ ] Hoist and fast-rope as cable-length states with crew figures
- [x] Downwash: dust, snow, spray and a water ring under the rotor by surface and power, through the weather's particles; near trees sway once the near trees exist (Part I, _Helicopters_); the dust, snow, spray and flattening are done (decisions 176, 182); the water ring and the near trees are done (decisions 188, 191)
- [ ] Checkpoint: owner flies slope, confined-area and rooftop landings and a sling-load delivery

### H4. Hazards and damage

Vortex ring state, mast bumping, retreating blade stall, autorotation, tail rotor loss, and their cues.

- [ ] Vortex ring state from the descent branch of the inflow, with deterministic thrust fluctuation; recovery by forward or lateral cyclic; test of entry and recovery
- [ ] Mast bumping in teetering types at low load factor; envelope protection's load-factor floor; test that a Cobra pushover bumps with protection off and is prevented with it on
- [ ] Retreating blade stall as a soft never-exceed speed with roll-off and vibration; protection's speed limit
- [ ] Engine failure and autorotation (the collective's low stops let a full-down autorotation overspeed the rotor to 126–150% today; the Assisted preset holds it near 103% with a collective floor): rotor speed free, the flare's energy; test of an autorotation from 300 m to a landing under the type's crash sink rate
  - [ ] Overspeed: a 35° yank in a quick stop still takes the Buzzard to 114% under the Assisted preset's collective floor, and the Standard and Expert presets' lever collective has no floor at all (review of decision 159); the low stops, the floor's rate and a HIGH RPM cue's timing together
- [ ] Tail rotor loss and the controlled crash
- [ ] HUD hazard cues for each hazard and for dynamic rollover; rotor RPM prominent in autorotation
- [ ] Damage effects: engine smoke, the spinning fuselage, the slowing rotor with blades returning
- [ ] Checkpoint: owner flies each hazard with protection on, with warnings only, and off

### H5. Combat and AI

Fixed and turreted weapons, gunner mode from proposal 0002, AI nap-of-the-earth and battle-position behaviors. Depends on P4.

- [ ] Fixed guns and rocket pods with mouse aim; turreted guns following free look
- [ ] Attack helicopter gunner mode: the gunner sight as P5's targeting pod format slaved to the turret, owned by the copilot/gunner or the player (moved from P5; decision 189)
- [ ] AI behaviors with protection on: nap-of-the-earth routes with radar-altitude hold on the real terrain, battle positions with line of sight through the canopy height field, pop-up attacks, landing zone approaches, sling-load deliveries
- [ ] Door gunners operated by the AI (decision 151); the crew built so that every seat has an AI and the player can later take any one
- [ ] Campaign: helicopter missions' jump-in window over their ground phases, handback on the ground (with P1's take control and hand back)
- [ ] New helicopter types and mission types in the order of battle, with their own decision, since they change every world's cast. Roles (decision 151): Little Bird for close air support and small-unit warfare (troop drops), Cobra as a marine attack helicopter (close air support), Black Hawk, Huey and Mi-8 as troop and cargo transports; whether the transports also fly fire support is open
- [ ] Checkpoint: owner flies a CAS sortie with pop-up attacks and a troop insertion in the campaign

## Terrain networks track (decision 161)

Rivers by regime, roads and railways aligned to the terrain with earthworks as analytic edits, and a bridge or culvert at every crossing ([docs/proposals/0005-terrain-adaptive-networks.md](docs/proposals/0005-terrain-adaptive-networks.md)); the plan is [docs/plans/terrain-networks.md](docs/plans/terrain-networks.md). The network tier stays on the coarse pass; the alignment tier runs on the eroded world. N1, N2 and N4 can start in any order; N3, N6, N7 and N8 touch rendering and close only after the acceptance checks (Part I, and Part II for the map work). Protect decisions 146, 147 and 155: keep their tests passing and port a test before replacing what it tests.

- [x] Proposal saved, plan, decision 161; design doc, style guide, proposal 0001, `CLAUDE.md` (rule 13) updated
- [x] Owner: the plan's open questions (decision 163): `main`; seeds may change, nothing is frozen in development; every bridge is a target; lazy alignment is acceptable

### N1. Edit framework

- [x] `worldgen/edits/`: corridor and pad records, the clamp form for banks (fill 1:1.5, cut 1:1 or 1:2), priority blending, an index by level-7 tile, `TerrainEdits.apply(dir, base)`
- [x] Protected channels: inside a river's channel and inner banks, the minimum of the edited and the carved height (distance from the `RiverIndex` segments; no CPU re-run of the carve)
- [x] Migrate decision 108's airfield pads; tests that every mesh vertex, `heightAt`, `displaySurfaceAt` and Free Flight's ground are unchanged; the Kestrel lockstep passes unchanged (decision 164)
  - [x] `tools/edits.preview.ts` on seed 1983: 6 of 71 airfield pads lie across a rendered river, so pads are exempt from channel protection (decision 164)
  - [ ] Keep airfields off rendered rivers (the coarse pass cannot see them: a check against the eroded rivers after the global pass, or a crossing site's culvert), then remove the pads' exemption
- [x] One function for meshes, trees, buildings, the camera's clearance and the flight model's ground; `SurfaceGrading` becomes its client
- [x] Tests per edit type and for the composition order, including a fill corridor across a channel that never raises the channel

### N2. River planform

- [x] Invariant metrics first, over at least 10 seeds: monotone surface (1 mm), no maxima in the vector bed, the tile walk of decision 146 (2 m), headings mod 45° and short alternating segments (`tests/riverInvariants.test.ts`, `tools/riverInvariants.preview.ts`; decision 165)
  - [x] Planform smoothing: the ladder failed (51% of seed 1983's channel on grid headings); a Gaussian of one point spacing before Chaikin brings it to 21% (decision 165)
  - [x] Bed walk of decision 146 with and without the smoothing, recorded in decision 165
  - [x] Wander for every river and natural banks in the shader (owner request, decision 167)
  - [ ] Owner's look at the natural banks in the browser; tune `NATURAL_BANKS` and `WANDER_TUNING`
  - [x] Trees and the canopy keep clear of the river's polyline, but the shader's wander draws water up to about 40 m from it: trees can stand at or in the moved water (`treeline` view). A CPU twin of the bank noise for tree placement and the canopy, or a narrower wander where forest grows to the bank (trees: decision 177)
  - [ ] The canopy shell over forest beside a river can still cover moved water: lane it from the drawn water too
  - [ ] The `treeline` preview targets the densest forest, not a river; since the headwaters shifted the rivers' wander it frames forest only. Target a river through dense forest
  - [x] Rivers start in the mountains: headwaters along each source's largest tributary down to 4 m³/s (owner, decision 177)
  - [ ] The carve follows the polyline, not the shader's wander: a river resolved by the mesh (wider than about 50 m) can show water beside its channel; carry the wander into the kernel's carve if it shows
  - [ ] Eroded worlds of ten seeds through `tools/riverInvariants.preview.ts` (about ten minutes each on lavapipe)
  - [ ] The remaining 21% on grid headings (long straight D8 runs): bend them with the regime and meander work, then tighten the tests' bounds
- [ ] Regimes per reach (mountain, lowland meandering, small lowland; braided as stretch) from bed gradient, discharge and floodplain width (per polyline so far: migration for lowland rivers at least 80 m wide with a floodplain of eight widths, the train below, wander for all; decisions 167, 173)
- [x] Floodplain mask from `valleyFloor` and the height above the river's surface (as a half-width along each river, from the global heights within a few meters of its surface; decision 173)
- [x] Meander migration (Howard and Knutson) with resampling, cutoffs within about a width and oxbow polylines; `rng(seed, "meanders")` forked per river; endpoints fixed; caps on iterations and time; fallback to the procedural train (decision 173: no random numbers, the train seeds the bends; run once per world in the worker and stored)
  - [x] Move the migration off the worker's critical path or speed it further if the stage costs more than about 10 s on a real GPU's world (6.7 s on seed 1983 after a faster loop; decision 173)
  - [ ] A render of oxbows at low altitude over open floodplain (the views so far are of a river beside a deep lake)
- [x] Profiles recomputed on the final planform; carve segments from it (decision 173)
- [x] Floodplain edit in the kernel (lowers and smooths, never raises, before the carve) (in the carve itself, as its profile beyond the bank, so the carve stays the minimum; decision 173)
- [ ] Distributaries that bifurcate in deltas, with a build-up edit to just above sea level
- [ ] Sinuosity (lowland 1.5–2.5, mountain 1.0–1.3), wavelength (10–14 widths) and bend radius (2–3 widths) tests; carry the meander phase across confluences (the V1 item below)

### N3. River rendering

- [x] Oxbows and abandoned channels as standing water at the floodplain's water table (no white water, decision 155): segments after the network's at the river's surface at the cut, 0.3 m lower, level; carved and drawn like rivers (decision 173)
  - [ ] Oxbows silt up: older ones narrower and marshier (needs an age per oxbow)
- [ ] The bank band on oxbows and distributaries
- [ ] Map: per-band generalization of river polylines, width exaggeration kept
- [ ] Spray at knickpoints, if cheap
- [ ] Acceptance checks: Part I (`mixed`, `beach`, new `oxbow` spot from 2 km), Part II (Region band)

### N4. Crossings and settlements

- [x] Crossing sites on the coarse rivers and on the eroded rivers: narrow, straight, firm banks, off knickpoints (coarse: decision 175; the eroded rivers' sites go with N5's snapping)
- [x] Settlement pull: a habitability term for coarse crossing sites; worlds without sites unchanged bit for bit (test); `GENERATOR_VERSION` up; tell the owner which seeds' casts changed (decision 175: 25–30% more settlements at sites; the road search discounts bridges there too)
- [x] Bridges as nodes: road and rail polylines cut at bridges; type on the coarse pass (beam, truss, arch, viaduct, suspension), span, traffic carried, detour if it falls (decision 179; cutting the polylines at bridges is left)
  - [ ] Cut road and rail polylines at bridges, so each is a node of the network
- [x] Every bridge a target (decision 163): a network bridge at every coarse crossing of a river that needs a structure (not only 25 m and wider), and viaducts where railways and major roads cross valleys deeper than their class's threshold on the coarse relief (decision 179; viaducts are rare at 6 km cells)
- [ ] `names/bridges` (after the river, the nearest town or the feature), `names/lines`, `names/reaches`, `names/sections`, in id order; existing streams unchanged (test) (bridges done, after the nearest town: decision 179)

### N5. Router and alignment

- [x] Spike N5.0: level-6 tiles along every link's band for seeds 1, 2, 3 and 1983, synthesis time on Dawn; eager after the global pass or lazy per piece (decision 181: router v2; lazy near the camera on the renderer's tiles)
  - [ ] Why road 2219 of seed 1983 finds no route on either height source
  - [ ] Fewer corners tighter than their radius on rough tiles
- [x] Offline alignment stage (decision 184, superseding 181's lazy choice): link tasks from roads, railways and spurs in Hilbert order; level-6 tiles synthesized along the bands with a shared cache; a worker pool; links assembled whole (one plan and profile across their anchors); thinned, packed and stored with the world in IndexedDB; a progress panel; `?align=0` skips it
  - [ ] Whole-world run on a desktop GPU: time, tiles, forced pieces, record size; `tools/alignment.preview.ts` on seeds 1, 2, 3
  - [x] A build screen in place of the progress panel: phases, bars, times and a log, nothing drawn or simulated behind it (decision 186; it covers Free Flight's start screen too)
  - [x] Tiles evicted from the stage's cache while a lane waited: a million height lookups at 0 m in the owner's run on 8 workers; tiles pinned until handed out, regression test (decision 186)
  - [x] Observer stations at the 8 most winding stretches (GUI → Simulation camera → Observer at "Roads · switchbacks", decision 186)
  - [ ] The owner's run with the fix: viaducts and tunnels without the 0 m lookups (1,918 and 1,401 km of 86,818 before)
- [x] Anchors: polyline ends (settlements, junctions) and every 12 km of the polyline (decision 185)
  - [ ] Anchors at strategic bridges, once they are snapped to rendered rivers
  - [ ] Elevations at anchors from the network (fixed decks, junction platforms); now the ground at link ends
- [x] Router: tangent-plane lattice by class, state (node, heading of 16), Galin's k = 2 neighborhood, long viaduct and tunnel edges; grade, curvature, earthwork, crossing, pass and corridor terms; tests on synthetic slopes (switchbacks on a steep face, a valley detour for a railway) (decision 180: state also counts the straight run; structures from the profile instead of long edges; crossing, pass and corridor terms through the caller's extra cost, not yet used)
- [x] Class switches: mountain railway where a piece cannot meet 2%; mountain road for secondary roads in mountains; motorway → trunk → mountain road; spurs → mountain road → track; forced pieces as the last resort (decision 185)
- [x] Plan fitting (straights and arcs, hairpins with a shelf pad), profile (slope-limited passes, vertical curves, fixed decks and anchors), earthworks (cut, fill, viaduct, tunnel by class thresholds) (decision 180; hairpin shelves and bridge decks as fixed points still to come)
  - [x] `alignPiece`: a piece between two anchors on the sphere with its corridor edits (decision 180)
- [ ] Railways, then major roads, then minor roads; earlier corridors as obstacles and attachment points
- [ ] Spiral template where a railway cannot meet its grade
- [x] Rivers in the router: a bridge's cost by span and angle; ground costs (forest, water, a seeded field); a wander for the classes that wind; crossing records with spans and decks, matched to network bridges within 25 km (decision 190)
  - [ ] Owner decision: network bridges over coarse rivers with no rendered river near (10 of 18 on seed 1983's first 120 links): bridges from the rendered rivers, viaducts over the valley, or no target
  - [ ] Crossing-site discounts on the rendered rivers
  - [ ] Viaduct and tunnel records (spans, heights) beside the bridge records
- [ ] Structure records for every crossing, viaduct and tunnel; strategic bridges snapped to rendered rivers (closes the S4 follow-up); each alignment bridge matched to a network bridge on its link, the unmatched counted (under a tenth, decision 163)
- [ ] Tracks and minor roads as local detail near the camera, `rng(seed, "tracks")` per region
- [ ] Tests: grades within 0.5 points, radii, every crossing recorded (link assembly, thinning, packing, task order: `tests/networkLink.test.ts`, decision 184)

### N6. Corridors in the terrain

- [ ] Spike N6.0: the error between mesh and edits on the formation at level-10 spacing (24 m)
- [x] Corridor edits from the alignments, through N1's function (decision 184: `alignmentCorridors` into the app's `TerrainEdits`; roads drawn along their alignments, off viaducts and tunnels; railways drawn as concrete strips until their shading)
- [ ] Segment tables: a third vec4 per corridor segment (design elevations, kind and flags, bank width)
- [ ] Shading: asphalt or gravel, shoulders, center and edge lines, ballast and rails below about 1 km, lighter fill and darker cut banks; nothing in tunnels or under bridges
- [ ] Corridor-aware refinement (levels 11–12 within 2 km of the camera) if N6.0 needs it; triangle count in the standard views at most 10% up (`PERF`)
- [ ] Clearings and canopy lanes follow the aligned corridors
- [ ] Acceptance checks: Part I checks 1–5 and new spots `switchbacks`, `viaduct`

### N7. Structures and names

- [ ] Bridge kit specs (abutments, piers, beam decks, truss panels, arch ribs, viaduct arches, suspension towers) and tunnel portals within the budgets; silhouettes in the model viewer (check 6)
  - [x] Deck, parapet, wall pier, column pier, abutment, truss panel and top brace (`bridge-*.json`, decision 192)
  - [ ] Arch ribs and viaduct arches (arch bridges are drawn as beam bridges until then)
  - [ ] Suspension towers and cables (suspension bridges are drawn as trusses until then)
  - [ ] Tunnel portals
  - [ ] Ink outlines on bridges, like the buildings
- [x] Assembly per structure record: `bridgeRecords` (a crossing's run of bridge points, viaducts in pieces of 1.2 km), `bridgeKit` (beam on wall piers at most 35 m apart, truss up to 90 m with panels and braces, viaduct on columns every 40 m, abutments), `BridgeLayer` (merged per structure, within 12 km; decision 192)
- [ ] Map: bridge labels in the Region band, dashed tunnels, aligned routes generalized where they exist
- [ ] Alignment-tier names from per-piece forks (tunnels, minor bridges, spirals and inclines); names in briefings and mission names
- [ ] Acceptance checks: Part I (`bridge` spot at 300 m), Part II checks 1, 2, 4, 5 in the Region band and check 3 with the owner

### N8. Verification and report

- [ ] `tools/networks.preview.ts`: every criterion of the proposal over 20 seeds, generation time per stage → `docs/reports/terrain-networks-metrics.md`
- [ ] Screenshots on lavapipe: oxbows from 2 km, a delta, switchbacks, a viaduct, a bridge at 300 m, the Region band with bridges → `docs/reports/screens/`; the browser smoke test once
- [ ] `docs/reports/terrain-networks-report.md`: what works, metrics, simplifications, decisions and deviations, known issues, times per stage, next steps
- [ ] Checkpoint: owner flies low over a river valley with a railway and a mountain road

### Stretch and later

- [ ] Braided channels on steep outwash plains
- [ ] Canals: level pools, locks as pads with a kit model, numbered ("Lock 7"), aqueducts over rivers
- [ ] Power lines with pylons on high ground and wire strikes for helicopters, on the corridor framework

## Ground detail track (decision 168)

Detail near a low camera for helicopter flight, faceted and slightly cartoony, at no cost at working altitude; the plan is [docs/plans/ground-detail.md](docs/plans/ground-detail.md). Every milestone is a visual milestone and closes after Part I's checks, including check 11.

- [x] Owner direction recorded, plan, decision 168; design doc and style guide updated
- [x] Owner: the plan's questions (decision 169): flowers yes, boulders block landings, dust as sprites; snow keeps its sparkle; glints on wet ground, ice and smooth rock

### G1. Micro-facets

- [x] Piecewise-linear fields on Kuhn-split cubic lattices on the wrapped coordinates (no tangent frame, no seams), three octaves turned against each other by integer matrices; one normal and one shade step per cell; no derivatives inside (decision 171)
- [x] Land cover, first pass: grass, dry ground, rock, snow (shade steps only) (decision 171)
- [x] Crop furrows by field heading and crop, sand ripples with snaking crests along a prevailing heading (decision 183)
- [x] Owner's review (decision 187): no cover on snowfields or faces steeper than about 35°; furrows and ripples switched off
- [ ] Furrows and ripples again, much fainter or shading-only, if the owner wants them back
- [x] Single pixels of the neighboring field's crop in fields (the owner's dotted fields): the face's center from the camera-relative position (decision 183)
- [ ] Gravel bars and scree, marsh hummocks
- [x] Fade from 7 to 3 px per cell; uniform gate on the camera's height above the ground; distance cutoff at 600 m (decision 171)
- [x] Glints per micro-facet on wet ground (by wetness) and glacier-polished rock; snow's normal and sparkle untouched (decision 171)
- [ ] Glints on ice (frozen lakes are the water shader's); check wet glints looking into a low sun in the browser
- [x] Preview views `hover` (5 m) and `skid` (20 m) over the `meadow` target, `nap` (60 m) over farmland; `TARGET=peak` for rock; `MICRO`, `GLINT` (decision 171)
- [x] Moiré where an octave faded (owner, in the browser): slivers of the 3D lattice; octaves are 2D triangle lattices on the facet's dominant plane (decision 178)
- [ ] Owner: the micro-facets in the browser after decision 178 (no moiré at any distance); up close the cells lean a little toward one diagonal
- [ ] Views over scrub, scree, a field and dunes once their patterns exist; shimmer in motion (`FLICKER`)
- [ ] The `hover` and `skid` previews show a vertical line down the middle of the frame with the micro-facets off as well; find its source
- [ ] `PERF` at 1 km and at 20 m against the plan's budgets on a real GPU (lavapipe times are not meaningful; above 600 m the evaluation is skipped by a uniform)

### G2. Ground cover kit

- [x] Model specs (class `cover`, 8–40 triangles), generated by `tools/models/cover.py`: grass tuft and dry tuft, flower tufts in cream, yellow and violet, tussock, reed clump, bush and dry bush, boulder in three sizes and with lichen, sandstone slab, pebbles; dark bases and light tips from ground occlusion over the model's own height; per-face rock shades from the schemes `rock`, `rock-lichen` and `sandstone` (decision 172)
- [x] `tools/models.preview.ts` sheets and triangle counts (20–40): `docs/reports/screens/ground-g2-kit.png` (decision 172)
- [ ] Owner: the kit's look in the model viewer (`viewer.html`, models `cover-*`)

### G3. Placement

- [x] `worldgen/groundCover.ts`: a pure function of a cell (one level-10 sample) and its site, from cell hashes; mixes by cover, moisture, temperature, slope, forest, aridity and farmland; clumps, boulder fields and flower-color patches; `isObstacle` for boulders of 0.8 m and up; tests (decision 174)
- [x] Talus below cliffs, reeds on river and lake banks, tufts and flowers on field verges (decision 185)
- [ ] Preview views at a cliff's foot and on a river bank to see talus and reeds (the existing views miss them)
- [x] Masks: sea, lakes, river water (the river index's stretches), the infrastructure's clearings (roads, airfields, towns), closed forest; plants hide under lying snow (decision 174)
- [x] Heights on the drawn level-10 triangle, as a base and a displacement per unit of exaggeration; a test that every item lies within a centimeter of the mesh's plane at two exaggerations (decision 174)
- [ ] A test that the finest level draws throughout the ring under the gate (the previews draw level 10 at 5 and 20 m)
- [x] The ring: chunks of 1/8 level-10 tile placed a few rows per frame, one instanced mesh per kind (at most 15 draws) filled within each kind's range and the view cone from an anchor at the eye, shrinking into the ground at the range's end (decision 174)
- [ ] Ranges by quality tier (`rangeScale` exists, not wired to the tiers)
- [x] Color from the open ground's color at the cell with the land shader's moisture tint; plants take its brightness and half its hue; browning by the ground's greenness and the season; wet; snow on rocks' tops; light bent toward the vertical and bounced from the ground so shaded sides never go black (decision 174)
- [x] Counts in the previews: 4,000–6,200 items, 0.06–0.18 M triangles in 6–9 draws (hover, skid, gallery, peak)
- [ ] Placement costs about 10 ms of CPU per chunk (a few seconds to fill the ring, nearest first); profile and trim (climate sample and mix per cell)
- [ ] `PERF` on a real GPU in a hover at 10 m over grass by a forest edge against the 2 M triangle and 500 draw budgets
- [ ] Owner: the cover in the browser (Free Flight, a helicopter hover over meadow, scrub, desert and scree)

### G4. Motion

- [x] Sway from the flight model's wind and gusts (`airVelocity` at the ground under the eye and 50 m round it, a linear field over the ring), with waves along the wind and a flutter per plant; stiffness by kind, rocks still (decision 176)
- [x] `sim/flight/rotor/downwash.ts`: the main rotor's outwash at the ground from thrust, disc area and air density, fading with hub height and forward speed, centered down the disc's axis; tests (decision 176)
- [x] Downwash flattening in travelling rings from that center, the flattened side paler; Free Flight feeds it each frame and clears it on exit (decision 176)
- [ ] Free Flight hover at 5, 15 and 30 m (check 11), in the browser: the ring's size with height, its offset with drift
- [x] The trees near a hovering rotor sway too (decision 191)

### G5. Dust

- [x] Soft sprites with noise-eroded edges and depth fade, stretched along their motion, in the pipeline's overlay, counts by the particles' quality factor (`render/sim/ground/rotorDust.ts`, decision 182)
- [x] By surface (`washSurface`, tests): spray over water, snow powder where snow lies, ochre dust in the ground's color on deserts, beaches and dry grass, gray grit on rock, gravel, alpine ground and pavement, nothing on green ground; less when wet (decision 182)
- [x] A ring of ruffled water under the rotor on lakes, rivers and the sea (the water shader, decision 188)
- [ ] Leaves and cut grass on green ground; the sprites' self-shadowing (darker underside) if they read too flat
- [ ] Owner: the wash in Free Flight in the browser over desert, snow, water and a runway
- [x] Slowdown over roads (owner): pavement raised up to 700 large sprites; dust only below 30–50 kt, at most 240 sprites, capped size, fade near the lens, ground read when the wash moves (decision 191)
- [ ] Owner: frame rate in a slow hover over a runway and a desert; trees swaying beside a hover
- [x] The Kestrel's frame rate on the ground (owner): the clearing test gathered per chunk, one row per slice, no micro-facets under pavement (decision 194)
- [x] Owner: the Kestrel parked on a runway ran at 3–4 fps with the micro-facets: off by default, a Free Flight graphics option (decision 197)
- [ ] A cheaper micro-facet form (one octave, a shorter range, or baked per tile) before they come back on by default
- [ ] The forest's placement asks `isClear` per tree too: gather per part as the cover does
- [ ] Wheels on dirt strips, vehicles on gravel roads and impacts through the same emitter
- [x] Closes H3's downwash task for dust, snow and spray (the water ring stays open)

## World diversity track (decision 204)

Terrain provinces and rock from tectonic history, a richer climate with twenty land biomes, closed basins with salt lakes and playas, continental characters, named zones with their own look, landform props and natural wonders ([docs/proposals/0007-world-diversity.md](docs/proposals/0007-world-diversity.md)); the plan is [docs/plans/world-diversity.md](docs/plans/world-diversity.md). Keep the erosion and the tile kernel as the backbone: feed them new inputs, do not replace them. New stages draw from new streams (`provinces`, `lithology`, `climate-modifiers`, `zones`, `props`, `wonders`, `names/zones`, `names/wonders`); plates, crust and boundaries stay byte-identical. Every criterion is measured by `tools/diversity.preview.ts` against the baseline. Protect decisions 126, 130, 146, 161 and 165: keep their tests passing.

- [x] W0: proposal saved, plan, decision 204; design doc, style guide, proposals 0001 and 0005, `CLAUDE.md` (rules 10 and 15) updated
- [x] W0: `tools/diversity.preview.ts` and the baseline over 20 seeds → `docs/reports/world-diversity-baseline.md`
- [x] Owner: the plan's readings in decision 204 (decision 205: regional distances scaled to the planet; the rest accepted)

### W1. Provinces and lithology

- [x] `provinces` stage after `boundaries`: boundary runs with an age (young or old, weighted by closing speed), craton ages, fossil sutures in old continental plates, 3–8 hotspots with tracks; forks `ages`, `sutures`, `hotspots`, `characters`
- [x] The province map (twelve classes; the first nine before uplift, karst and soft sediment from lithology, glaciated lowland after climate) in `WorldMaps` and the global finish; stored and transferred
- [x] `lithology` stage after climate (decision 209): nine rocks by province with noise and layering, the layered flag; `rng(seed, "lithology")`
- [x] Erodibility map (0.3–3, smoothed, contrast at most 10) multiplied into the incision; talus angle by rock; the uniform case pinned by a test
- [x] Map modes `provinces` and `lithology` in `npm run maps`; debug overlays for both in the strategic view (GUI)
- [x] Tests (`tests/provinces.test.ts`, 8 seeds at 64²): every class appears; plates, crust and boundaries byte-identical to before; determinism; `GENERATOR_VERSION` up
- [x] `tools/diversity.preview.ts`: province entropy and province shares

### W2. Relief by province

- [x] Uplift profiles by province (decision 210; soft limits per province left: peaks already reach 8.6–9.2 km): young collision ranges with a soft limit near 7.5 km (peaks 8–9 km), high plateaus at 4–5 km behind collisions, old mountains to about 2.5 km, volcanic cones of 3–6 km, hotspot shields of 2–5 km, rift escarpments, basins near sea level
- [x] Glacial carving: troughs reaching the sea become fjords (decision 210)
  - [ ] Arêtes and cirques above the snow line beyond the kernel's alpine crests
- [x] Basin and range (in the detail stage, decision 210): parallel tilted fault blocks at Earth spacing (15–30 km) with alluvial fans into flat basins
- [ ] Plateau canyons with stepped walls where the rock is layered (left to erosion so far, decision 210)
- [x] Strata and buttes only in layered sedimentary rock in a dry climate (decision 210): a layered-rock mask in the masks' reserved channel; the `buttes` spot and the terracing metric
- [ ] Measure: peaks over 20 eroded worlds, the theater mix of `npm run seeds` before and after, the tile budget at `ceiling` and `range`

### W3. Closed basins

- [x] Water balance on filled depressions in `computeDrainage` (both grids): hypsometry per depression, inflow from the catchment's runoff, lake evaporation from the climate; balance level, closed or open, salinity, playa
- [x] Endorheic rivers end at their lake's surface (sinks are terminals, decision 210); `riverInvariants` checks it; profiles stay monotone
- [x] Kernel: playas as flat white crust from the basin flags (decision 130's pans become the playa case; decision 210)
  - [ ] Brine colors by salinity and shoreline rings: a flag in the tiles' output material for the terrain shader
- [x] Graph: `SaltFlat` features and airstrip sites (`StrategicGraph.saltFlats`, decision 210) (playas over about 25 km² with a straight run of at least 4 km (decision 205)); names
- [ ] Spot `basin` in `tools/landscapeSpots.ts`; acceptance check 16's salt flat view

### W4. Climate and biomes

- [x] `climate-modifiers`: precipitation seasonality, cold currents and fog tendency, ecotone noise (decision 211; continentality and rain shadows from the climate stage)
  - [ ] The weather model reads the fog tendency
- [x] Twenty land biomes: seven codes appended, old codes keep their meaning (decision 211)
- [x] Every consumer: palettes (Part I's new table), shader shades, strategic fills and masks, forest base, tree kit weights, ground cover, rotor dust, landform masks, airbase suitability, farmable biomes, feature extraction
- [x] Altitude zonation (cloud forest, alpine meadow; plateaus as steppe); soil from lithology (heath on acid sand, grassland on chalk, forest on loam, sparse on granite)
- [x] Ecotones with noise (decision 211)
  - [ ] Aspect in the shader and `canopy.ts`
  - [ ] Oases at springs (riparian corridors are the tiles' green corridors, decision 126)
  - [ ] Disturbance patches in forests (fire scars, clearings, wind-throw) from a seeded rate per biome
- [ ] Gully shade lines in the terrain shader for soft sediment in semi-arid climates; kernel gullies denser there
- [x] Biome coverage over 20 seeds (all twenty, decision 211)
- [ ] Acceptance checks 1–5 against the board with the brighter palette, the grade retuned if needed

### W5. Continental character

- [x] Continents as the continental crust of each plate; characters drawn from what their tectonics allow and their climate belt (`provinces/characters`, decision 212)
- [x] Biases on province assignment, rock and moisture within tectonic limits
- [x] Distinctness check on the coarse pass: joint province and biome divergence of the two largest continents; at most two redraws of the smaller (`provinces/characters/nudge-k`), stored with the world
- [x] Metrics: divergence over 20 seeds (18 of 20 at 0.25 bit); coarse pass time (12.7 s against 11.9 s)

### W6. Zones and visual style

- [x] Segmentation on the eroded global grid in the worker's finish (decisions 205, 213): region growing on province and biome group, merged and split to 16–63 km, boundaries pulled to barriers, stored with the world; zone records with a recipe within the limits of Part I's _Zones_ (`rng(seed, "zones")`) and a name (`names/zones`)
- [x] A distance to the boundary per cell for the 1–2.5 km blends; the palette shift in the tile meshes' vertex colors (decision 213)
- [x] Simulation view: palette shift per vertex (decision 213)
  - [ ] Haze, sky grading, sun warmth, cloud regime and ambient particles blended by camera position; vegetation kit weights; weather tendencies (low cloud, fog, wind)
- [x] Strategic view: fills for the new biomes (decision 211), zone labels at the Theater and Region bands replacing the area labels of cover and plains (decision 213)
  - [ ] Patterns for the new biomes (heather stipple, salt crust, tower dots, mineral banding)
- [ ] Acceptance check 15 (`zones` view); Part II checks 1, 2, 4, 5 and check 3 with the owner

### W7. Landform props (stretch)

- [ ] Specs: karst towers, sandstone pillars, sea stacks and arches, hoodoos, natural arches, basalt column clusters, small inselbergs, within the budgets; silhouettes in the model viewer
- [ ] `worldgen/props.ts`: pure placement by cell from province, rock and relief (`rng(seed, "props")`), drowned towers on the shelf; shared with the sim
- [ ] Instanced layer with two levels of detail within about 6 km
- [ ] Collision shapes queried by flight contact, the camera's clearance and line of sight beside the canopy; the Kestrel lockstep unchanged
- [ ] `PERF` in the `karst` view: at most 0.3 M triangles and 40 draws for props; acceptance check 16's karst bay

### W8. Natural wonders (stretch)

- [x] Detectors for the proposal's twelve kinds; candidates in the graph (`geography/wonders.ts`, decision 214)
- [x] Selection of 5–15 after casting's territory, weighted toward fronts and lanes (`rng(seed, "wonders")`); names (`names/wonders`); mentions in briefings (decision 214)
- [ ] Shaping in the tile kernel (tepui, falls, caldera, travertine, mineral bands) or by props (karst bay, pillar forest, basalt columns)
- [ ] Protection from earthworks in the router (N5's extra cost), scenic routes allowed in sight
- [x] Map labels for the selected wonders (decision 214)
  - [ ] The wonder glyph; acceptance check 16's wonder view

### W9. Verification and report

- [x] Every criterion over 20 seeds against the baseline → `docs/reports/world-diversity-metrics.md` (coarse 20 seeds, eroded seeds so far)
  - [ ] Eroded worlds of all 20 seeds on the final generator (decision 215's wetland and mangrove), and the local-variety measure with altitude zones and surface character
- [x] Globe maps of three contrasting seeds (coarse) → `docs/reports/screens/world-diversity/`
- [ ] Screenshots on lavapipe: three contrasting globes, an alpine range with glacial valleys, a basin-and-range desert with a salt flat, a moorland, a jungle river, a karst bay, two adjacent zones → `docs/reports/screens/`
- [x] `docs/reports/world-diversity-report.md`: what works, metrics, simplifications, decisions and deviations, known issues, times per stage, next steps
- [ ] Checkpoint: owner flies Free Flight over three contrasting zones

## Known issues

- [ ] Intermittent GPU determinism flake in Vitest (about 1 run in 5–10 of the full suite): a GPU determinism test (`detailStage`, `tileSynth`) gets different results for two identical runs. Present at the M2 baseline; not reproduced by 40 back-to-back detail-stage runs under load. Tests now report how many values differ and whether they are zeros (a readback race in Dawn's Node bindings would show zeros). First report (2026-11-10): 24 of 221k cells differ, worst 0.23 m, no zeros, in the single-dispatch detail kernel (pure per cell, no in-place neighbor reads). So it is not a readback race; suspect the GPU or driver under concurrent load. Check whether it happens with `--no-file-parallelism`, and on another GPU.
- [ ] CPU determinism flake in CI (2026-11-11, deploy run 15 for `6274249`): `tests/infrastructure.test.ts` "is deterministic" built `riverWorld(1983)` twice in one process and got different graphs. Only `barrierLines[1].sides[0]` differed (area 5.815e11 vs 5.910e11 m², fraction, depth); the line's endpoints and width matched, so the side flood fill or the path between equal endpoints changed, worth about 35 cells at resolution 96. The commit touched only rendering. Not reproduced locally in 6 runs of the file and a full suite, on Node 22 and on Node 24 (CI's version). Suspects: an earlier test in the file mutating shared state, or tie-breaking in the barrier path search. If it recurs, log the path cells of both builds. Second occurrence (2026-11-11, run 22 for `c50f196`, again a rendering-only commit): `tests/campaign.test.ts` "keeps the first valid world" got a different cast for seed 7 on the second build (start line 0 vs 1, other node owners, other regions), so the divergence is again at or before the fronts. Ruled out here: 24 parallel runs of both files under load; identical results with V8 `--jitless`, `--no-opt --no-maglev`, `--always-turbofan` and `--max-lazy` on Node 22 and Node 24; no `Math.random`, `catch`, time-driven logic or outside imports in the coarse pass; the heap breaks ties by id; the only cache (`neighborAngles8`) is order-independent. Both determinism tests now compare stage by stage (`firstDifference` in `tests/helpers/syntheticWorld.ts`), so the next CI failure names the first quantity that diverged. Third occurrence (run 28 for `dd0ea49`): the stage-by-stage test named it. Heights, biomes, discharge, nodes, settlements and roads matched; `barrierLines[0].points` had 123 vs 147 points, so the front generator diverged from identical inputs. Its band cut sorts cells by a projected axis coordinate (sin, cos, acos) and thresholds at 20% and 80%, so a last-bit difference reroutes the path. Fix (decision 86): that projection and the principal-axis rotation now use only arithmetic, sqrt and atan2. Leave this open until several CI runs pass; if it recurs, quantize the axis coordinate before sorting.

## After the demo

- Entity promotion and ground behaviors
- The piloting track (P1–P6, above)
- The helicopter track (H1–H5, above)
- The world diversity track (W1–W9, above)
- Flyby and cinematic cameras for transitions, replays and idle spectating (Proposal 0002; not yet in a milestone)
- Air combat
- Naval combat
- The campaign economy
- Sketched, desaturated rendering of enemy territory that reconnaissance has not covered recently
