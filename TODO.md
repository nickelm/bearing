# TODO

Tech-demo milestones from [docs/design.md](docs/design.md) (revision 8, decisions 72 and 94): a foundation (F), a strategic track (S), a simulation core track (C), a flight view track (V) and integration (I), after a scaffold, then a post-demo piloting track (P, decision 94). The design doc's _Milestones_ section maps the old M1–M9 onto these. Each task should take a few hours. Check tasks off as they are completed, and add subtasks as you discover them.

Suggested order for the remaining work: S1, V1, S2, V2, the rest of S3 and S4, V3, C2, V4, C3, I1. Visual milestones (all S, V, I and P) close only after the acceptance checks in [docs/visual-style.md](docs/visual-style.md) for the views they touch: Part I for the simulation view, Part II for the strategic view.

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

- [ ] Snap bridges to the rendered (eroded) rivers, which can run a few kilometers from the coarse ones (decision 65)
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
- Carried to V2: weather fields not yet used in the renderer (fog and visibility, rain and snow on the ground, live winds for wave direction)

### C2. Air tasking and mission search (old M7, without models and the chase camera)

#### Data model and flight

- [ ] Aircraft type table for both sides: fictional names, reference type, role, speeds, ceiling, combat radius before the range factor, loadouts
- [ ] Squadrons, bases and inventories per side (aircraft, readiness, stocks)
- [ ] Carrier groups as mobile bases on analytic sea routes; air wings launch and recover at the group's predicted position (decision 56)
- [ ] Mission model: type, side, theater, package, target or station, phase timeline, originating need and score (decision 50), per-mission seed ready for promotion
- [ ] Great-circle routes with climb and descent profiles; analytic position(t); fuel with the cast's range factor (decision 51)
- [ ] Phase timeline per mission type (departure, climb-out, ingress, fence-in, on target or on station, egress, approach, recovery) as scheduled events

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
- [ ] Concurrency cap so that 20–50 aircraft are airborne
- [ ] Determinism tests: identical ATO at 1× and 64×, and independent of the viewing side (decision 48)

#### Mission search and the map

- [ ] Debug GUI toggle for the viewing side (developer tool until I1)
- [ ] Mission icons (small aircraft with heading and short trails) and route lines on the strategic map
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

- [ ] Camera envelope 0–20 km; an observer camera at an airbase or port from the cast; the free camera kept as a debug tool behind a dev flag until V4 (decision 72)
- [ ] Horizon-bounded tile selection: drop tiles beyond √(2Rh) plus a margin (at most about 200 km at 20 km); tests for the bound and that selection never exceeds it
- [ ] Tile cache budget and prefetch for the bounded radius around the active unit or camera; prefetch the regional level-7 tiles (decision 64)
- [ ] True-scale relief: the simulation view's own exaggeration uniform, default 1×; recheck skirt depth and the near plane; owner look at whether decision 14's relief reads at 1×
- [ ] Faceted flat shading on terrain (derivative normals), with facets of about 20–60 m at low altitude; check it against geomorphing
- [ ] Per-face shade quantization: three to five shades per biome from slope, altitude, moisture and low-frequency noise, constant per face
- [ ] Rock and snow by face; drop smooth rock blending (style gap from decision 70)
- [ ] Voronoi farmland patchwork near settlements and on flat lowland
- [ ] Simulation preview views: re-aim Part I checks 1–5 (5 km mixed landscape, 500 m conifer edge with a road, mountains at low sun, airbase at dusk, coast with glint) at or below 20 km in `tools/render.preview.ts`; retire views between 20 and 100 km (`oblique`, `roads`, `coast`) or move them to the strategic set (carried from old M5)
- [ ] Style audit: compare those views with the reference board and Part I (terrain facets and shade quantization, farmland, rivers, ocean, haze, trees, towns, lights); the old M3 and M5 rendering predates the guide (smooth shading, clump trees). Add a task per gap (carried from old M5)
- [ ] Frame time over 0–20 km within Part I's budgets
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
- [ ] Weather in the renderer (from C1): fog and visibility, rain and snow on the ground, live winds for wave direction
- [ ] Tree kit from model specs ([docs/visual-style.md](docs/visual-style.md) Part I, Vegetation): conifer, broadleaf, birch/poplar, palm, acacia, shrub, dead/burnt, each within the guide's triangle budget and sturdy proportions (canopy width ≥ ½ height, trunk ≥ ⅒); per-instance scale 0.8–1.3, yaw, tilt under 4°, and a value-first shade shift within the biome's canopy shades; types assigned by biome; clustered placement with a sharp forest edge and a scattered fringe of trees and shrubs. Replaces the old M3 clump trees (needs V3's model builder)
- [ ] Tree LOD, following the guide's bands: instanced trees casting shadows to 1.5 km, merged cluster meshes (10–30 trees each, no shadows) to 5 km, terrain forest shade beyond, with the 5 km seam hidden by haze and matched colors (decision 45: ~6.6 M triangles over dense forest at the default 5 km range today; budget under 2 M per frame and about 50,000 instances within 1.5 km)
- [ ] Denser forests: closer clump spacing in closed-canopy biomes, paid for by the tree LOD (owner request at checkpoint 4)
- [ ] Sky, haze and clouds tuned for 0–20 km only (Part I): drop orbit-only work such as the limb glow from the simulation view
- [ ] Acceptance checks 1–5 (Part I) against the reference board; owner checkpoint

### V3. Models and bases

Aircraft, vehicles, ships, buildings and trees are generated in code from small JSON specs, flat-shaded with vertex colors ([docs/visual-style.md](docs/visual-style.md) Part I, decision 70).

- [x] Settlement building clusters scaled by population (old M5; instanced boxes, off by default on the globe since decision 71)
- [x] Airbase runway meshes (drawn as concrete in the terrain shader, plus hangar and shelter meshes; decision 65) (old M5)
- [ ] Flatten the terrain under runways (they follow the fine terrain's detail noise) (old M5): a height hook in `surfaceSampler` that blends toward the field elevation inside the airfield, and a terrain rebuild when the infrastructure arrives
- [x] Model spec JSON format and types (decision 106): lofted fuselages from 6–8-sided cross-sections along the length; wings and tails as extruded planforms with sweep, dihedral, thickness and a sharp leading edge; primitives (box, beveled box, pyramid stack, coarse icosphere blob, cylinder); mirroring; named face groups; camouflage schemes mapping face groups to palette colors; emissive points (afterburners, navigation lights). Validation with clear errors, and tests
- [x] Procedural model builder (decision 106): spec → non-indexed, flat-shaded `BufferGeometry` with vertex colors and baked per-vertex AO, plus emissive anchors; deterministic (same spec, same bytes); fails a test when a model exceeds its class's triangle budget from the guide
- [x] Faction palettes and camouflage schemes from the guide's palette tables, as data shared by the builder and the viewer (plus ship schemes, decision 106)
- [x] Debug model-viewer page (decision 106; `viewer.html`): renders any spec with a turntable, sun direction and time of day, sky light and exposure controls, wireframe, triangle count, and a silhouette mode (solid black on a pale sky, Part I acceptance check 6); hot-reloads specs in dev; reachable from the debug GUI and built as a second Vite page under `/bearing/`
- [x] First specs: one fighter and one strike aircraft per side (F-21 Kestrel, F-124 Harrow, Vo-31 Strizh, Vo-35 Molot), checked with the silhouette test in `tools/models.preview.ts`
  - [ ] Owner: check them in the model viewer in the browser (shading, camouflage patches, silhouettes)
  - [ ] Markings: national insignia, modex numbers and squadron codes as painted faces or decals (Part I, Aircraft)
- [x] Base kit from specs: hangars, hardened shelters, tower, radar on a lattice mast, radar dome, fuel tanks, revetments, placed at airbases in the simulation view (decision 106)
  - [ ] Runway and taxiway markings in the pavement shader (threshold bars, centerline dashes, runway numbers)
  - [ ] Night lighting: runway edge lights, apron floods and tower windows from the models' emissive anchors
- [x] Settlement buildings from specs (pitched and flat roofs, taller city blocks), using S4's urban extents (decision 106)
  - [ ] The terrain's built-up patch is still the urban radius disk; draw it from the extent polygon too
  - [ ] Town buildings read as dark specks from 3 km (`DETAIL=1 VIEWS=town`): walls facing away from the sun get only a weak sky light; tune with V1's style audit
- [x] Ship specs: carrier (CVN-73 Resolute), Alliance destroyer, Pact cruiser (decision 106)
  - [ ] Ship meshes in the simulation view once ships exist (C3)
- [ ] Checkpoint: owner review in the model viewer and at an airbase in the simulation view

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

## Piloting track (after the demo)

Player flight control in the chase view, with the HUD and displays as 2D overlays and no cockpits ([docs/proposals/0002-third-person-flight.md](docs/proposals/0002-third-person-flight.md), decision 94). AI pilots and the player share one flight director and one flight model. P1 depends on V4. P2 depends on P1. P3 depends on P2 and S4. P4 and P5 depend on P3. All P milestones touch rendering or UI, so they close only after the Part I acceptance checks.

### P1. Flight model and controls

Table-driven flight model, flight director shared with the AI, mouse-aim and direct schemes, flight stick support through the Gamepad API, take control and hand back.

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
- [ ] Animated parts from model-spec hinge axes and pivots: control surfaces, flaps, slats, airbrakes and speedbrakes from control inputs; swing wings with speed; afterburner nozzles; helicopter rotor discs
- [ ] Flight effects: vapor and wingtip vortices at high G, contrails at altitude, heat shimmer behind engines, dust and spray at very low level, rotor wash
- [ ] Acceptance check 9 (aircraft readable and centered in a maximum-rate turn) as a scripted sequence
- [ ] Checkpoint: owner flies representative aircraft with mouse aim and a flight stick, takes control and hands back

### P2. HUD and display framework

Canvas overlay, layout system, world-anchored and screen-anchored symbology, message log, collapsible displays.

- [ ] Overlay and layout system: aircraft slightly below center, tapes flanking it, display slots in the corners, upper edge and bottom center; collapsible displays; minimal mode with only world-anchored symbols and tapes
- [ ] World-anchored symbology framework: projection from the scene each frame, boresight cross, target boxes, waypoint and target diamonds, missile seeker circles (extends V4's flight path marker)
- [ ] Screen-anchored instruments: airspeed, altitude and heading tapes, compact attitude indicator (no pitch ladder), Mach, G, fuel, master caution
- [ ] Message log: AWACS, wingman, crew and ground controller calls as text
- [ ] Systems display: engines, fuel state, damage; compact, expands on warnings
- [ ] HUD color: green by default, amber option, thin dark halo; tune the values and record them in `docs/visual-style.md`
- [ ] Acceptance check 7 with the full HUD
- [ ] Checkpoint: owner review of HUD legibility and layout

### P3. Sensors and displays

Sensor model, avionics profiles, radar, RWR, moving map from the strategic renderer, stores display.

- [ ] Sensor model in the sim, per aircraft: radar detection by radar type (none, ranging only, pulse, pulse-Doppler with look-down), mode, range, radar cross-section, aspect, terrain masking and clutter; deterministic, with tests
- [ ] RWR (emitting radars by bearing and type), visual detection (range, size, aspect, contrast, light), datalinks and AWACS contacts with lower precision and a delay (Pact leaning on ground control, Alliance on AWACS), targeting pods and terrain-following radar
- [ ] The AI uses the same filtered picture as the player
- [ ] Avionics profiles per type in the aircraft spec
- [ ] Radar display: B-scope for fighter radars, PPI for maritime and AWACS radars, with mode, range scale and contacts; phosphor vector graphics
- [ ] Threat warning display: RWR symbols by bearing and type
- [ ] Moving map: the strategic renderer in a viewport, centered on the aircraft, with route, threats and front
- [ ] Stores display: weapons and pylons, selected weapon, quantities, chaff and flares
- [ ] Checkpoint: owner review of the displays across aircraft with very different avionics

### P4. Weapons

Guns with lead-computing pipper, air-to-air missiles, bombs with CCIP and CCRP, target and weapon cameras, damage states.

- [ ] Guns with a lead-computing pipper projected at the predicted impact point
- [ ] Air-to-air missiles with seeker circles and guidance
- [ ] Bombs with CCIP fall lines and CCRP release cues
- [ ] Stores hang on pylons and disappear on release; fuel tanks can be jettisoned
- [ ] Target camera: keeps the aircraft (foreground) and the selected target in frame
- [ ] Weapon camera: follows a released missile or bomb, picture-in-picture or full screen
- [ ] Damage states: smoke, fire and missing parts on models; damage in the systems display
- [ ] Acceptance check 8 with the gun pipper
- [ ] Checkpoint: owner review of a dogfight and an attack run

### P5. Crews and special roles

AI crewmate and callouts, crew station mode, attack helicopter gunner mode, targeting sensor display, airdrop and sling-load tools with the hook camera.

- [ ] AI crewmate in the F-111, A-6 and Su-24 analogues: runs the radar and targeting sensor, manages terrain-following, calls out threats, waypoints and releases
- [ ] Crew station mode: the AI pilot flies, the player operates radar, targeting sensor and weapons, with the targeting display enlarged
- [ ] Attack helicopter gunner mode with an enlarged gunner sight display
- [ ] Targeting sensor display: FLIR or TV picture-in-picture from a render target with a thermal post-process
- [ ] Airdrop: drop zone marker and release cue
- [ ] Sling load: downward-looking hook camera display for pickup and placement
- [ ] Blocky crew figures visible through canopies
- [ ] Checkpoint: owner review of crew station, gunner, airdrop and sling-load sorties

## Known issues

- [ ] Intermittent GPU determinism flake in Vitest (about 1 run in 5–10 of the full suite): a GPU determinism test (`detailStage`, `tileSynth`) gets different results for two identical runs. Present at the M2 baseline; not reproduced by 40 back-to-back detail-stage runs under load. Tests now report how many values differ and whether they are zeros (a readback race in Dawn's Node bindings would show zeros). First report (2026-11-10): 24 of 221k cells differ, worst 0.23 m, no zeros, in the single-dispatch detail kernel (pure per cell, no in-place neighbor reads). So it is not a readback race; suspect the GPU or driver under concurrent load. Check whether it happens with `--no-file-parallelism`, and on another GPU.
- [ ] CPU determinism flake in CI (2026-11-11, deploy run 15 for `6274249`): `tests/infrastructure.test.ts` "is deterministic" built `riverWorld(1983)` twice in one process and got different graphs. Only `barrierLines[1].sides[0]` differed (area 5.815e11 vs 5.910e11 m², fraction, depth); the line's endpoints and width matched, so the side flood fill or the path between equal endpoints changed, worth about 35 cells at resolution 96. The commit touched only rendering. Not reproduced locally in 6 runs of the file and a full suite, on Node 22 and on Node 24 (CI's version). Suspects: an earlier test in the file mutating shared state, or tie-breaking in the barrier path search. If it recurs, log the path cells of both builds. Second occurrence (2026-11-11, run 22 for `c50f196`, again a rendering-only commit): `tests/campaign.test.ts` "keeps the first valid world" got a different cast for seed 7 on the second build (start line 0 vs 1, other node owners, other regions), so the divergence is again at or before the fronts. Ruled out here: 24 parallel runs of both files under load; identical results with V8 `--jitless`, `--no-opt --no-maglev`, `--always-turbofan` and `--max-lazy` on Node 22 and Node 24; no `Math.random`, `catch`, time-driven logic or outside imports in the coarse pass; the heap breaks ties by id; the only cache (`neighborAngles8`) is order-independent. Both determinism tests now compare stage by stage (`firstDifference` in `tests/helpers/syntheticWorld.ts`), so the next CI failure names the first quantity that diverged. Third occurrence (run 28 for `dd0ea49`): the stage-by-stage test named it. Heights, biomes, discharge, nodes, settlements and roads matched; `barrierLines[0].points` had 123 vs 147 points, so the front generator diverged from identical inputs. Its band cut sorts cells by a projected axis coordinate (sin, cos, acos) and thresholds at 20% and 80%, so a last-bit difference reroutes the path. Fix (decision 86): that projection and the principal-axis rotation now use only arithmetic, sqrt and atan2. Leave this open until several CI runs pass; if it recurs, quantize the axis coordinate before sorting.

## After the demo

- Entity promotion and ground behaviors
- The piloting track (P1–P5, above)
- Flyby and cinematic cameras for transitions, replays and idle spectating (Proposal 0002; not yet in a milestone)
- Air combat
- Naval combat
- The campaign economy
- Sketched, desaturated rendering of enemy territory that reconnaissance has not covered recently
