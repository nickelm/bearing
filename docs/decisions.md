# Architecture decisions

Newest entries go at the bottom. Each entry records the date, the decision and the reason. If a decision is reversed, add a new entry that references the old one rather than editing history.

When an entry changes something `docs/design.md` or `docs/visual-style.md` states, update that document in the same commit, so the documents always describe the current plan. As of 2026-11-11, decisions 1–102 are reflected in both.

---

### 1. Three.js with the WebGPU renderer, not Godot or Unity

**Date:** 2026-11-09
**Decision:** Build on TypeScript, Three.js (`three/webgpu`, TSL shaders) and Vite.
**Reason:**

- The game targets the browser (see 2).
- WebGPU compute shaders cover erosion, terrain baking and batched line-of-sight queries without a native engine.
- Three.js gives us a renderer without imposing a scene or simulation architecture, which matters because simulation and presentation are separate layers.
- Godot and Unity web exports are heavy, their WebGPU and compute support on the web lags behind native, and both pull the project toward engine-centric architecture.

### 2. Browser target

**Date:** 2026-11-09
**Decision:** The demo runs in a desktop browser. Long-running CPU work runs in Web Workers.
**Reason:**

- A browser build is zero-install to share.
- WebGPU now ships in all major desktop browsers.
- The Gamepad API gives us flight-stick support later.

### 3. Planet radius of about 1,000 km

**Date:** 2026-11-09
**Decision:** The default planet radius is 1,000 km (`PLANET_RADIUS`).
**Reason:**

- The planet's surface area is about 12.6 million km², and the farthest two points are about 3,100 km apart. That is enough room for two continents and an ocean gap, while generation stays fast and maps stay bakeable.
- At 4096² texels per cube face, a texel covers about 380 m.

### 4. Compress aircraft range, not speed

**Date:** 2026-11-09
**Decision:** Aircraft ranges are scaled by a common factor (initially 0.5) by scaling fuel capacity and burn rate. Speeds, climb rates and weapon ranges stay real.
**Reason:**

- Compressing range restores the strategic depth that the small planet removes.
- Real speeds keep cockpit feel and air-combat geometry authentic.
- Shorter sorties also help pacing.

### 5. Seeded, named, independent RNG streams

**Date:** 2026-11-09
**Decision:** All randomness in core, worldgen and sim comes from `rng(worldSeed, name)`.

- Seeds are expanded with SplitMix64, and each stream runs xoshiro128\*\*.
- A stream's state depends only on (seed, stream path). It is derived by hashing both with FNV-1a 64 and expanding the hash with SplitMix64.
- `fork(name)` derives a sub-stream from the path, not from the parent's current position.
- Lint bans `Math.random` in those layers.

**Reason:**

- The same seed must always produce the same world.
- Adding or changing one generation stage must not shift the random sequence of any other stage, which a single shared generator would do.
- xoshiro128\*\* is fast with 32-bit integer math in JS, and BigInt is needed only at stream creation.

### 6. WebGPU is required, with no WebGL 2 fallback

**Date:** 2026-11-09
**Decision:** If WebGPU is unavailable, show an explanation and stop. Because `WebGPURenderer` silently falls back to WebGL 2, the app also checks `renderer.backend.isWebGPUBackend` after `init()`.
**Reason:** Erosion, terrain baking and line of sight depend on compute shaders. A WebGL path would be a second, crippled renderer to maintain.

### 7. TypeScript 6.0, not 7

**Date:** 2026-11-09
**Decision:** Pin `typescript` to `~6.0.3`.
**Reason:** TypeScript 7.0 (the Go-native compiler) is the current npm release, but typescript-eslint 8.72 declares `typescript >=4.8.4 <6.1.0` because it depends on the JavaScript compiler API. We'll revisit once typescript-eslint supports 7.

### 8. Coordinate conventions and equi-angular cube mapping

**Date:** 2026-11-09
**Decision:**

- World frame: planet-centered Cartesian, float64, in meters. +Y points through the north pole, +Z through lat 0 / lon 0, and +X through lon 90° E, which makes the frame right-handed with east counterclockwise seen from the north.
- Geodetic altitude is measured above the reference sphere.
- Cube faces are 0..5 = +X, −X, +Y, −Y, +Z, −Z, with fixed u/v axes (u × v = outward normal).
- Faces use the equi-angular warp, `tan(π/4 · s)`.

**Reason:**

- These conventions are cheap to set now and expensive to change after maps are baked.
- With the equi-angular warp, the ratio of largest to smallest cell area across a face is under 1.5 (the test bounds it). Plain gnomonic projection gives about 5×. That keeps texel size, and therefore erosion and simulation resolution, nearly uniform over the planet.

### 9. A custom orbit camera instead of OrbitControls

**Date:** 2026-11-09
**Decision:** The globe view uses `src/render/orbitCamera.ts`, which works in float64 lat/lon/altitude/tilt.

- Zoom scales altitude exponentially, from 10 km to 5,000 km.
- Drag speed scales with altitude.
- Near and far planes follow altitude: near is 0.5·h, and far is the horizon distance.

**Reason:** Three's `OrbitControls` dollies relative to the distance to the planet center, so control near the surface is unusably coarse. It also assumes the camera has a world position, which camera-relative rendering avoids.

### 10. Lint-enforced layering

**Date:** 2026-11-09
**Decision:** ESLint `no-restricted-imports` enforces the layer rules.

- `core` is a leaf.
- `sim` and `worldgen` may not import `render` or `ui`.
- `sim` and `core` may not import `three/webgpu`, `three/tsl` or `lil-gui`.
- `worldgen` _may_ import `three/webgpu` and `three/tsl`.

**Reason:**

- The simulation must stay headless so it can run in a worker.
- World generation needs GPU compute for erosion and baking, which in this stack means TSL compute nodes. Allowing those packages without allowing our `render` module keeps worldgen independent of presentation code.

### 11. Vite cache outside the project tree

**Date:** 2026-11-09
**Decision:** `vite.config.ts` sets `cacheDir` to `<os tmpdir>/vite-cache/bearing-<hash of project path>` instead of the default `node_modules/.vite`.
**Reason:** The repository lives in Dropbox. Vite's dependency optimizer writes `deps_temp_*` and then renames it to `deps`, and that rename failed with `EBUSY` even with `node_modules` marked as ignored by Dropbox. The pre-bundled `three/tsl` then returned 404 and the app could not load. With the cache outside the synced folder, the problem goes away, and the setup works the same on machines without Dropbox.

### 12. No generation time budget

**Date:** 2026-11-09
**Decision:** Drop the design doc's 30-second limit on generation (demo goal 1). Generation may take minutes.

- Keep the fast coarse pass, so failed seeds are still rejected cheaply.
- Report per-stage progress in the UI.
- Cache finished worlds in IndexedDB from milestone 2, instead of milestone 8, so each seed and parameter set is generated once.

**Reason:** Owner's direction: world quality matters more than generation speed. Resolution choices are now limited by GPU memory, not by time.

### 13. Tiled world data from the start

**Date:** 2026-11-09
**Decision:**

- **Tile keys.** Every baked map is addressed by a tile key (face, level, x, y), which forms a quadtree per cube face. A tile is 256 × 256 texels plus a border. At level L a texel spans about 1,571 km / (256 · 2^L), which gives:
  - level 4: about 380 m, the design's 4096² per face;
  - level 7: about 48 m, the design's regional bake.
- **Global grid.** Processes that need the whole planet at once (plates, erosion and drainage, climate, rivers, the front) run on one global grid. Its resolution will be chosen by a GPU memory benchmark, with a target of 1024–2048 per face, or about 1.5–0.77 km per cell.
- **Detail tiles.** Tiles finer than the global grid are synthesized per tile on the GPU from the global maps, detail noise and a local erosion pass constrained by the global river network. Per-tile randomness comes from `fork` with the tile key.
- **Residency.** Tiles are generated on demand, kept in a GPU/CPU LRU cache with a memory budget, and persisted in IndexedDB. World generation pre-bakes the contested region to level 7.
- **Rendering.** The terrain LOD quadtree uses the same tile keys.

**Reason:**

- Holding 4096² × 6 faces × 5 maps in memory at once would take 1–2 GB, and a 50 m regional bake cannot be a single texture.
- Tiling caps resident memory, turns the regional bake into deeper levels of the same structure, and shares addressing with rendering LOD.
- The cost: tile seams need border texels and order-independent generation. The hardest part will be keeping detail tiles consistent with global drainage.

### 14. Relief scaled to the planet

**Date:** 2026-11-09
**Decision:** Elevations and ocean depths are Earth-like reference values multiplied by `reliefScale` = R / R_Earth ≈ 0.157 (1,000 km / 6,371 km). The highest peaks reach about 1.4 km instead of 8.8 km, typical ranges 0.5–0.8 km, and the mean ocean depth is about 600 m. The atmosphere (scale height, density), aircraft performance and service ceilings stay real.
**Reason:** Owner's direction: mountains should look proportionate to the globe.
**Consequences:**

- Terrain no longer constrains aircraft ceilings.
- Helicopter terrain masking still works, because it depends on relief of tens of meters.
- Continental shelves become very shallow (about 20 m). Revisit before naval and submarine work after the demo.

### 15. Day and night, seasons, calendar and weather are in demo scope

**Date:** 2026-11-09
**Decision:**

- **Planet.** A 24 h solar day, 23.44° axial tilt and a 365-day year, all planet parameters. The sun direction is a stateless, analytic function of `GameTime` in `core`.
- **Calendar.** A campaign start date (day of year and time of day) maps `GameTime` 0 onto the calendar. It is a campaign parameter, not a planet parameter.
- **Climate.** The climate stage computes a seasonal temperature range from tilt and latitude, and biomes use annual means. The provisional climate in milestone 1 ignores seasons.
- **Weather.** A headless sim process runs on a coarse global grid (about 50–100 km cells), ticks hourly in game time, draws from `rng(seed, "weather")` and is driven by the climate maps. Because ticks are fixed, weather is identical at any time acceleration. The sim uses ceiling, visibility and wind for flight operations, and the renderer draws clouds from the same field.
- **Rendering.** Lighting follows the sun, the night side shows settlement lights, the snow line moves with the seasons, and clouds are now required rather than a stretch goal.

**Reason:** Owner's direction. Day, night and weather shape air operations (night sorties, weather cancellations) and the view from orbit.

### 16. Ocean gap measured coast to coast

**Date:** 2026-11-09
**Decision:** The ocean gap is the shortest great-circle distance between any coastal cell of the main continent and any coastal cell of the second continent, with islands ignored. The geography check requires it to fall within `oceanGap`. Milestone 5 places ports on the facing coasts, so convoy routes come out at about the gap length or somewhat longer.
**Reason:**

- It can be measured in the coarse pass, before ports exist.
- It is simple and robust.
- An island chain in the gap (the GIUK analogue) does not break it.

Revisit if convoy crossings in milestone 7 come out too long.

### 17. Earth-like geography: near-antipodal continents, ocean fraction 0.70

**Date:** 2026-11-09
**Decision:** The default `oceanFraction` is 0.70, not the design table's 0.55. Continent centers are placed about 150–175° apart, not 90–130°.

- The main continent's crust covers about 60% of the land, which gives a radius of about 50° (roughly 1,750 km across).
- The second continent covers about 30% (a radius of about 35°).
- The remaining land comes from islands and noise.
- The separation is chosen as the sum of the two radii plus the middle of the `oceanGap` range, then jittered and capped below 180°.

**Reason:**

- On a 1,000 km planet a 1,200–1,800 km gap spans 69–103° of arc.
- With centers 90–130° apart, the two continents' radii could add up to at most about 61°, covering about 15% of the surface. That conflicts with 45% land and with a main continent deep enough for a front.
- The owner chose the Earth-like resolution over keeping 0.55 or shrinking the gap.

### 18. Continents come from a crust field, with plates laid over it

**Date:** 2026-11-09
**Decision:**

- **Crust field.** Continental crust is a scalar field: the larger of two cone-shaped fields around the continent centers, plus noise. It is thresholded at the area percentile that matches the land fraction.
- **Plates.** Plates are grown independently by flood fill, with steered seeding: three seeds inside the main continent, two inside the second, and the rest spread over the oceans by best-candidate sampling.
- **Boundaries.** A boundary's type follows from the plates' relative motion and from the crust on each side.

**Reason:**

- It controls land area and continent sizes directly, which the geography check needs.
- Plate boundaries cutting through continents produce internal collision ranges, the river and mountain barriers the front generator looks for, the way India and Asia do on Earth.
- The design doc's "continental plate clusters" become plate seeds clustered inside each continent.

### 19. Climate uses reference (unscaled) elevation for lapse rate

**Date:** 2026-11-09
**Decision:**

- Temperature lapse with altitude (6.5 K/km) and the alpine and snow biomes use the Earth-like reference elevation, i.e. height ÷ `reliefScale`.
- Physical heights, rendering and flight use the scaled heights.

**Reason:** With relief scaled to the planet (decision 14), the highest peaks reach only about 1.4 km, too low for snow caps or tree lines under a real lapse rate. Using reference elevation keeps the stylized biome distribution Earth-like while the shapes stay proportionate.

### 20. Temperate, east–west elongated continents

**Date:** 2026-11-09
**Decision:**

- **Main continent.** Its center lies at 32–45° latitude, in either hemisphere.
- **Shape.** Both continents are ellipses elongated east–west. The main one is 1.8 times as wide as it is tall and the second 1.6 times, each with its long axis tilted up to 25° from east–west.
- **Placement.** The layout tries random bearings from the main continent. For each bearing, it searches the separation (100–178°) that brings the ellipse-to-ellipse gap closest to the middle of `oceanGap`, and it penalizes a second-continent center outside 22–55° latitude. Decision 17's fixed 150–175° separation no longer applies.

**Reason:**

- Map previews (`npm run maps`) showed that a round main continent covering about 18% of a 1,000 km planet spans about 100° of latitude. Centered at mid-latitudes, it reached over a pole, which produced a giant ice sheet, tundra where the front should be, and biomes in concentric rings.
- The design is modeled on Cold War Central Europe, which needs a temperate continent. Elongating the continent east–west, as Eurasia is, keeps its area while limiting how far it reaches toward the poles.

### 21a. Provisional climate breaks latitude symmetry

**Date:** 2026-11-09
**Decision:** The milestone-1 climate no longer depends on latitude alone.

- **Latitude warp.** Large-scale noise bends the latitude used for temperature (up to about 22°) and, separately, for the moisture bands.
- **Coasts and interiors.** Continental interiors at high latitudes run up to 7 °C colder. Open ocean far from land runs up to 9 °C warmer, a stand-in for ocean heat transport, so sea ice hugs coasts and enclosed seas.
- **Ice sheets.** Land becomes ice sheet only below −20 °C annual mean. Tundra covers −20 to −6 °C.

**Reason:** The owner's review found circular polar caps, and map previews showed biome stripes following latitude exactly. Real winds and rain shadows remain the climate stage proper in milestone 2.

### 21b. Two grid resolutions: tectonic CPU grid and GPU global grid

**Date:** 2026-11-09
**Decision:**

- The CPU tectonic stages (continents, plates, boundaries, uplift, base elevation, climate) keep running on `CubeGrid` at a _tectonic resolution_ (default 512 per face).
- The _global grid_ (1024 or 2048 per face, chosen by benchmark) is a set of flat GPU storage buffers with `CubeGrid`'s index layout, `(face · N + j) · N + i`. It is filled by seam-aware bicubic upsampling of the tectonic maps plus detail noise, and then eroded.
- Neighbors on the global grid are computed from (face, i, j) by `core/faceAdjacency.ts`, with no tables. Crossing a face edge is an integer remap, derived from `CUBE_FACES`, and the tests check it against `CubeGrid.neighbors4`.

**Reason:** `CubeGrid` stores float64 centers and neighbor tables, about 80 bytes per cell: about 500 MB at 1024² per face and 2 GB at 2048². Plate growth and the Dijkstra distance fields also do not need kilometer resolution, because their outputs are smooth.

### 22. GPU world generation runs on the render device, on the main thread

**Date:** 2026-11-09
**Decision:** GPU stages (detail noise, erosion, tile baking and synthesis) run on the main thread's `WebGPURenderer`. Work is dispatched in chunks between frames, so the UI keeps rendering. CPU stages stay in the worldgen worker. The renderer requests the adapter's maximum storage-buffer limits.
**Reason:** Baked tiles must end up as render textures. Using the same device avoids a GPU → CPU → GPU copy per tile, and three's renderer in a worker would be a second device with its own pipelines. The main thread only records and submits work, so it stays responsive.

### 23. Stream-power erosion on the global grid; drainage recomputed on the CPU

**Date:** 2026-11-09
**Decision:**

- Global erosion is a stream-power model: tectonic uplift, fluvial incision `K · P · A^m · S^n` (P precipitation, A drainage area, S slope), low-slope deposition, and a talus-angle thermal pass. It is not a particle or virtual-pipe water simulation.
- Flow accumulation on the GPU gathers from donors (no float atomics), so a run is deterministic on a given GPU and driver. Bit-exact results across GPUs are not guaranteed.
- After erosion the height map is read back. Flow directions, accumulation, lakes and rivers are recomputed exactly on the CPU (priority flood, D8), because the sim and the front generator depend on them.

**Reason:** At 0.8–1.5 km cells, stream power is the model geomorphologists use at this scale. It produces dendritic drainage and a consistent drainage area directly. Particle erosion carves features that are finer than one cell. Bit-exact GPU determinism across vendors is not achievable with float math, so the data the sim depends on comes from a deterministic CPU pass. IndexedDB caching (decision 12) means each machine generates a given world once.

### 24. Detail tiles are a pure function of direction

**Date:** 2026-11-09
**Decision:** Below the global grid's level, a tile texel's height is `f(direction)`:

- bicubic global height;
- ridged and warped detail noise, scaled by uplift;
- an analytic erosion filter: gullies aligned with the global slope, attenuated along global rivers;
- river channels carved from the vector rivers, using their widths.

This replaces the TODO's "local erosion pass" on each tile. The same function exists in TypeScript (`worldgen/terrainHeight.ts`) for tests, the camera ground clamp and the sim. `fork(tileKey)` is reserved for features entirely inside one tile, because noise seeded per tile would break seams.
**Reason:** A per-tile erosion simulation disagrees with its neighbors along shared edges unless tiles are generated with overlapping, blended windows. That costs about 4× the work and still depends on generation order at face seams. A pure function makes tiles order-independent and seam-free by construction, and lets headless code query the same terrain the renderer draws.

### 25. Tile texels addressed by integer global texel index

**Date:** 2026-11-09
**Decision:** Tile synthesis computes a texel's face coordinate as `u = (gx + 0.5) / (256 · 2^L)`, with the integer `gx = x · 256 + tx`. It does not add a fractional offset to the tile origin.
**Reason:** Two tiles that share a texel then compute bit-identical inputs within a face, so shared border texels agree exactly. Across face seams the same direction comes from different face coordinates, so agreement there is only to within rounding. Skirts cover the difference.

### 26. World-generation kernels are plain WGSL, tested in Node on Dawn

**Date:** 2026-11-09
**Decision:**

- GPU world-generation kernels are written in plain WGSL and run on a raw `GPUDevice` through `worldgen/gpu/gpuContext.ts`. They do not use TSL compute nodes.
- In the browser the device is three's own (`renderer.backend.device`), which keeps decision 22. In Vitest and offline tools it comes from Dawn's Node bindings, the `webgpu` dev dependency.
- GPU tests skip themselves when no adapter is available.
- Kernel checks are written once as self-tests (`worldgen/gpu/selfTests.ts`). They run in Vitest and from a GUI button in the browser, which catches browser shader compilers that disagree with Dawn.
- This supersedes part of decision 24: detail tiles do **not** get a TypeScript twin. Seam tests run on the GPU in Vitest. The camera ground clamp reads the CPU copies of resident tiles. How the sim queries terrain will be decided in M6.

**Reason:**

- GPU code can then be tested automatically, rather than only by eye in a browser.
- WGSL is far easier to write and review than node graphs for kernels the size of stream-power erosion or multi-octave noise.
- Two implementations of the detail-height function would drift apart.

**Notes (webgpu 0.6.2, Windows):** `queue.onSubmittedWorkDone()` and error scopes used after a buffer has been mapped both crash the Node process. `GpuContext.finish()` waits on a 4-byte readback instead, and errors are collected from the `uncapturederror` event.

### 27. Global grid resolution: 1024² per face

**Date:** 2026-11-09
**Decision:** The global grid is 1024 × 1024 cells per face (6.3 M cells, about 1.5 km per cell, tile level 2). 2048² stays available as an option for powerful machines, but it is not the default.
**Reason:** `tools/bench.preview.ts`, run on Dawn on the owner's desktop (AMD RDNA 3, D3D12), measured:

| Global grid | Cells  | Peak GPU memory in maps | Detail + upsample | Erosion per iteration | 1,200 iterations |
| ----------- | ------ | ----------------------- | ----------------- | --------------------- | ---------------- |
| 1024²       | 6.3 M  | 264 MiB                 | 0.17 s            | 21 ms                 | about 26 s       |
| 2048²       | 25.2 M | 1,056 MiB               | 1.2 s             | 123 ms                | about 147 s      |

- 1 GiB of GPU memory is out of reach for mid-range laptops, whose integrated GPUs share system RAM.
- The CPU drainage and river pass also scales with cell count: at 2048² it would need about 330 MB of typed arrays in the worker.
- A mid-range laptop GPU is perhaps 3–5× slower than this desktop, so 1024² still finishes erosion in one to two minutes, within decision 12.
- Detail below 1.5 km comes from tile synthesis (decision 24), so the global grid only has to carry drainage-scale structure.

### 28. Tile samples on the corner lattice; one synthesis kernel for all levels

**Date:** 2026-11-09
**Decision:**

- **Sample lattice.** Tile samples sit on the tile's corner lattice: 257 × 257 per tile, plus a 2-sample border (261² values). They are not texel centers, which revises the texel convention of decision 13.
  - Sample 0 and sample 256 lie exactly on the tile edges and are shared with the neighbor.
  - A child's even samples are its parent's samples.
- **One kernel.** The same GPU kernel (`worldgen/gpu/tileSynth.ts`) produces every tile, from level 0 to `MAX_BAKED_LEVEL` = 7 (about 48 m).
  - At or above the global grid's level it adds no detail octaves, which is the "bake global maps into tiles" case.
  - Below that level it adds octaves while their wavelength exceeds two sample spacings and 100 m.
  - Finer detail is left to the renderer's shader noise, because float32 noise coordinates lose precision near 10 m wavelengths at R = 1,000 km.
- **Rivers.** Channels are carved from Chaikin-smoothed river polylines, indexed by level-4 tile. The water surface follows the bicubic global height under the channel, so a channel is always cut into the terrain around it.

**Reason:**

- Mesh vertices, seams and geomorphing all want samples on tile edges and nested across levels.
- With texel centers, neighboring tiles would have to interpolate across the edge, and a parent's samples would fall between its child's.

**Measured** (Vitest on Dawn, seed 1983):

- Neighboring tiles on one face match bit for bit in any batch order.
- Across a cube-face seam, shared edge samples agree to under 5 cm.
- Sixteen level-6 tiles generate in about 50 ms.

### 29. Persist worlds, not tiles

**Date:** 2026-11-09
**Decision:**

- IndexedDB (`worldgen/worldStore.ts`) stores each generated world as one record:
  - the tectonic world;
  - the eroded global height and uplift;
  - drainage, rivers, biomes and display maps.
- Records are keyed by a hash of the planet parameters, both resolutions and `GENERATOR_VERSION`. Any change that alters generation output must bump `GENERATOR_VERSION`.
- On a hit the world is shown at once, and height and uplift are re-uploaded to the GPU for tile synthesis.
- Tiles are not persisted, which narrows decision 12.
- The app asks for persistent storage, best-effort.

**Reason:**

- A world costs about 30 s to generate, but a level-6 tile costs about 3 ms (decision 28) and holds about 545 KB. Reading a tile back from IndexedDB is no faster than synthesizing it.
- Persisting tiles would also add hundreds of megabytes per world, with eviction bookkeeping.
- A world record is about 150 MB at 1024².
- Revisit if tile synthesis becomes expensive, e.g. with a real local erosion pass.

### 30. Terrain meshes built on the CPU; geomorphing in the vertex shader

**Date:** 2026-11-09
**Decision:**

- Tile meshes (65² vertices plus skirts) are built on the main thread from the CPU copy of the tile data (`render/terrain/tileMesh.ts`).
  - Positions are relative to a float64 tile origin, and the mesh sits at origin − eye (rule 4).
  - Normals come from height slopes one sample apart, which the tile border makes possible.
  - Colors are per vertex.
- The only custom shader code blends `position` with `positionParent` by a per-mesh morph uniform (CDLOD-style). `positionParent` is the parent tile's actual surface, not the child's own even vertices, because each level adds noise octaves.
- Below the finest baked level (7), meshes read the level-7 ancestor and add CPU render-detail noise, a pure function of direction. This replaces "shader detail noise" in the TODO.
- A mesh costs about 4 ms to build. The renderer spends at most 8 ms per frame on builds, highest screen-space error first.
- One shared index buffer serves every tile. It is detached before a tile's geometry is disposed, because three's dispose would otherwise free it for all tiles.

**Reason:**

- I cannot see the browser in these sessions. Keeping the vertex logic in TypeScript lets Vitest check seams, morph targets and normals. `tests/gpu/terrainRenderer.test.ts` drives the whole renderer on Dawn from orbit to 3 km.
- The CPU data is resident anyway for ground-height queries.
- Moving mesh building into a worker, or into a compute shader, is a performance item for milestone 8 if loading lags.

### 31. Height exaggeration in the vertex shader

**Date:** 2026-11-09
**Decision:** This revises decision 30. Tile meshes store unexaggerated data:

- the base point on the sphere;
- the up vector;
- the displayed height;
- the parent surface as a base point plus a displacement;
- the slope vector.

The vertex shader computes `base + up · height · exaggeration`, morphs toward `parentBase + parentDisp · exaggeration`, and sets the normal to `normalize(up − slope · exaggeration)` through `normalNode = transformNormalToView(…)`. `displacedPosition` in `tileMesh.ts` applies the same formula on the CPU for the tests. Skirts are cut deep enough for the largest exaggeration the GUI allows.
**Reason:** Owner review found flicker and regeneration when changing the exaggeration. Every mesh was rebuilt and the quadtree fell back to coarse tiles while that happened. Now a change is one uniform update. The cost is 76 bytes per vertex instead of 48.

### 32. Headless rendering on Dawn for previews and shader tests

**Date:** 2026-11-09
**Decision:** Three's `WebGPURenderer` runs in Node on Dawn's device (`tests/gpu/renderer.ts`).

- The renderer gets the Dawn device and a stub canvas. Three only creates a canvas context when it draws to the canvas itself, so a stub is enough.
- Frames go into a `RenderTarget` that is also set as the output render target. Three then treats it as screen output and applies tone mapping and the sRGB conversion exactly as on the canvas.
- Node has no `requestAnimationFrame`, so the renderer's animation context is replaced with one that never schedules a frame.
- `tools/render.preview.ts` draws the app's own `GlobeScene` from fixed views (orbit, limb, terminator, oblique, low) and writes PNGs. Generated worlds are cached on disk in the OS temp directory, keyed by `worldKey`.
- `tests/gpu/sceneRender.test.ts` draws the scene in `npm test`. WGSL errors from TSL materials reach the device's `uncapturederror` event, so a broken material fails the test.
- `GlobeScene` takes `input: false` to skip DOM input, and tracks the viewport height from `resize()` rather than the canvas.

**Reason:** Milestone 3 is mostly shader work, and I cannot see the browser. Rendering the real scene offline lets me judge atmosphere, ocean and shading changes myself before the owner reviews them, and catches shader compile errors in tests.

### 33. Calendar and sun ephemeris

**Date:** 2026-11-09
**Decision:** `src/core/calendar.ts` holds the calendar and the sun ephemeris as stateless functions of `GameTime`.

- **Orbit.** The orbit is circular, and the clock is mean solar time with no equation of time. This matches the climate stage's insolation model. `OrbitParams` (axial tilt, solar day, year) is a structural subset of `PlanetParams`.
- **Planet time.** Planet time counts seconds since midnight at longitude 0 on day 0 of a year. Day 0 is the first day of the year, and the northern vernal equinox falls on day 79, as on Earth.
- **Sun direction.** The declination is `asin(sin ε · sin(2π · phase))`, and the subsolar longitude is where local solar time is 12:00.
- **Campaign start.** The campaign parameter `CampaignCalendar { startDay, startTimeOfDay }` maps GameTime 0 onto the calendar. `defaultCampaignStart` picks mid-August (day 226) in the main continent's hemisphere, or half a year later if the continent lies south of the equator, at 06:00 local time at the continent's center.
- **Dates.** Dates print with Earth month names, scaled to the year's length.

**Reason:**

- Owner's direction: the campaign opens in late summer and runs toward winter.
- A stateless ephemeris gives the same sun at any time acceleration, in the sim and in the renderer.

### 34. Planet materials light themselves

**Date:** 2026-11-09
**Decision:** Lit planet materials (terrain now; later ocean, trees and clouds) are `MeshBasicNodeMaterial`s whose `colorNode` computes radiance. They do not use three's scene lights.

- `render/lighting/planetLighting.ts` (`PlanetLighting`) holds the shared uniforms (sun direction, camera eye, sun illuminance, sky light, night light) and the TSL shading functions.
- A fragment's planet-centered position is `positionWorld + eye` in float32, because meshes are camera-relative (rule 4). Its error is about 0.1 m, which is fine for lighting.
- The sun direction comes from the ephemeris (decision 33) each frame. `GlobeScene.sun` is set by the app, which runs a preview clock until the sim clock exists in milestone 6.
- Output is tone-mapped with AgX. Exposure is a GUI control.
- The M1 grid mesh, a debug view, keeps `MeshStandardNodeMaterial` with a directional light that follows the sun, plus ambient light so data views stay readable at night.
- GUI → Time:
  - local date at the camera (read-only);
  - day of year and local solar time at the camera's longitude;
  - clock rate, from paused to 1 day/s;
  - exposure.

**Reason:**

- Sunlight and sky light depend on where a point sits relative to the terminator, and, once the atmosphere is in, on the air between the point and the sun (sunset reddening) and between the point and the camera (aerial perspective).
- Scene lights cannot express either. A single shading function shared by every planet material keeps them consistent.

### 35. Single-scattering atmosphere

**Date:** 2026-11-09
**Decision:**

- **Model.** Earth-like air on the planet (decision 14), with Hillaire's (2020) coefficients:
  - Rayleigh: β = (5.8, 13.6, 33.1)·10⁻⁶ m⁻¹, H = 8 km.
  - Mie: scattering 4.0·10⁻⁶ m⁻¹, extinction 4.4·10⁻⁶ m⁻¹, H = 1.2 km, g = 0.8.
  - Ozone: a tent profile 25 ± 15 km.
  - The top of the atmosphere is 100 km above sea level.
  - A density factor scales everything, for tuning.
  - Owner's choice: real air, not thinned to look Earth-proportioned from orbit.
- **Transmittance LUT.** 256 × 64, Bruneton's (r, μ) parameterization. It is computed on the CPU in `render/atmosphere/model.ts`, which Vitest checks against direct integration and the analytic zenith value, and uploaded as half floats.
- **Sky.** The sky is `scene.backgroundNode`: a 32-step single-scattering march along each view ray, clipped by the planet sphere, plus a sun disk. Three draws the background on a unit sphere around the camera, which sits at the origin, so the geometry normal is the view direction. Nothing has to reach the far plane.
- **Sunlight on surfaces.** Sunlight is multiplied by the LUT transmittance toward the sun and by a soft planet shadow with a penumbra about the sun's size. That gives red light at the terminator and none at night.
- **No multiple scattering.** Twilight skies are darker than Earth's, and the night side is black apart from the material's night floor.
- **Code layout.** `render/atmosphere/atmosphere.ts` (`AtmosphereNodes`) emits the TSL. `march()` is shared with aerial perspective.

**Reason:**

- Single scattering with a precomputed transmittance LUT gives the limb glow and sunset colors at little cost, and the CPU half of the model can be tested.
- A per-pixel march for the sky alone costs about 32 LUT samples per sky pixel.
- Hillaire's sky-view and aerial-perspective LUTs, or multiple scattering, can be added later if quality calls for them.

### 36. Aerial perspective per vertex; sky light from an irradiance LUT

**Date:** 2026-11-09
**Decision:**

- **Aerial perspective.** The terrain's position node marches 10 steps of single scattering from the camera to each vertex (`AtmosphereNodes.aerialPerspective`) and writes the in-scattered light and the transmittance into varyings. The fragment stage then computes `L·T + inscatter·E_sun`.
  - The camera-relative vertex position comes from `modelWorldMatrix`.
  - From space, the march starts where the ray enters the atmosphere.
- **Sky light.** Sky light on surfaces comes from a 64-texel LUT over the sun-elevation cosine (−0.3 to 1). It holds single-scattered sky irradiance on a horizontal surface at sea level, divided by π, and is integrated on the CPU over the hemisphere (8 × 16 directions). The normal's view of the sky weights it.
- **Defaults.**
  - "Sky light" is 1.6 × physical, standing in for the missing multiple scattering.
  - Sun illuminance is 1.4 display units.
  - Exposure is 1.
- **GUI → Lighting:** atmosphere on/off, air density (rebuilds both LUTs), exposure, sky light, night light.

**Reason:**

- Scattering varies slowly across a surface. Per-vertex evaluation (as in O'Neil, GPU Gems 2) costs about 10 LUT samples per vertex rather than per pixel.
- Terrain tiles are dense on screen by construction (screen-space error), so interpolation artefacts stay below a few pixels.
- A per-pixel post pass with a depth buffer remains possible if long, coarse tiles near the limb show banding.

### 37. The sea is shaded inside the terrain material

**Date:** 2026-11-09
**Decision:** There is no separate ocean mesh.

- **Geometry.** The tile mesh's `height` attribute is now the raw height, negative under the sea. The vertex shader displaces by `max(height, 0)`, so the sea stays flat at 0 m as before.
- **Mask and depth.** The fragment stage receives the interpolated raw height. Its h = 0 isoline, antialiased with `fwidth`, is the coastline, finer than the vertex grid, and its negative part is the water depth.
- **Lakes.** Lakes arrive through a new per-vertex `water` attribute (coverage, 1 where the tile's lake flag is set on land). They are shaded as water of a nominal 18 m reference depth.
- **Color** (`render/water/waterShading.ts`). Under water, the vertex color is the seabed albedo: sand in the shallows, silt deeper. The water's albedo blends that seabed into a deep-water color by Beer–Lambert transmittance over twice the depth, measured in reference meters (depth ÷ `reliefScale`, decision 14). Water uses a flat normal.
- **Debug modes.** Debug color modes switch water shading off.
- **Cost.** 80 bytes per vertex (was 76).

**Reason:**

- An ocean mesh would need its own LOD, accurate to centimeters against the coastline at 500 m altitude, and blending at the shore.
- The terrain already covers the sea floor at the right resolution, and the raw height carries the depth for free.
- Reference depths keep the shallow-to-deep color ramp Earth-like even though physical shelves are only about 20 m deep.

### 38. Water surface: periodic waves on wrapped coordinates, glint by unresolved slope

**Date:** 2026-11-09
**Decision:**

- **Wrapped coordinates.** Each terrain mesh carries a per-object uniform with its float64 origin modulo `WAVE_PERIOD` = 4,096 m. The vertex stage passes the mesh-local position as a varying, and their sum is a small, precise fragment coordinate.
- **Waves.** The wave field is 32 plane waves in 3D whose wave vectors are integer multiples of 2π/4,096 m, so the field is periodic and seamless across tiles. A wave's slope projected onto the tangent plane tilts the normal.
  - Wavelengths are log-spaced from 1.5 to 180 m, in fixed random directions (`rng(0, "render/waves")`).
  - Phases follow deep-water dispersion, ω = √(g·k), on wall-clock time.
  - Each wave has a peak slope of 0.044, which gives a total slope variance of about 0.03, Cox–Munk for a moderate breeze.
- **Filtering.** A wave fades out once it is shorter than about 4 pixels (from `fwidth` of the wrapped position). Its slope variance moves into the GGX roughness (α² = α₀² + 2σ²), so the glint widens into the orbital sunglint instead of aliasing.
- **Shading.**
  - Specular: GGX with Schlick Fresnel (F0 = 0.02), with sunlight filtered by the atmosphere.
  - Sky reflection: Fresnel × the average sky radiance from the irradiance LUT.
  - Water body: diffuse, × (1 − F).
- **GUI.** Lighting → "Water waves" scales every slope (0 = mirror).
- **Later use.** The same wrapped coordinate will carry terrain detail noise (milestone 3 terrain shading).

**Reason:**

- Planet-scale positions in float32 cannot carry meter-scale detail.
- A per-mesh wrapped origin does, with no new vertex data and no seams, as long as every detail function is periodic in the same period.
- A fixed wave set costs 32 cosines per water fragment. An FFT ocean is not needed at these altitudes.

### 39. Coastal foam from a per-vertex coast distance

**Date:** 2026-11-09
**Decision:**

- **Coast distance.** Tile meshes carry a signed coast-distance estimate per vertex, −h / |∇h| (m). It is positive at sea and negative on land, clamped to ±5 km, with the gradient taken from the raw tile samples.
- **Foam pattern.** Foam fills a band of `foamWidth` (90 m) from the coast:
  - surf lines every 14 m, moving shoreward;
  - broken up by the crests of the shorter waves (decision 38).
- **Filtering.** When the band is narrower than a few pixels, the pattern averages to 30% coverage and then thins with the band's pixel coverage, so from orbit coasts show only a faint light edge.
- **Vertex layout.** WebGPU allows 8 vertex buffers. Raw height, lake coverage and coast distance travel packed in one vec3 attribute, `surface`. Meshes cost 84 bytes per vertex.
- **GUI.** Lighting → "Coastal foam".

- **Memory split.** Larger meshes made the mesh cache thrash at 2 km: about 400 meshes are drawn, plus fallback parents. The tile memory budget is now split 45% data, 55% meshes (was 65/35), and the renderer's own default matches the app's 600 MiB.

**Reason:** The first version estimated the coast distance per fragment from screen derivatives (depth ÷ `fwidth(height)`). That is constant over each triangle, so the foam came out in visible triangle steps. A per-vertex estimate interpolates smoothly and costs one float.

### 40a. Static hosting on GitHub Pages; no cross-origin isolation

**Date:** 2026-11-10
**Decision:**

- **Hosting.** The app is fully static and lives on GitHub Pages as a project site, `https://<user>.github.io/bearing/`. `.github/workflows/deploy.yml` runs on every push to `main`: `npm ci`, type check, tests, `vite build`, then `actions/upload-pages-artifact` and `actions/deploy-pages`.
- **Base path.** Vite's `base` is `/bearing/` for `vite build` and `vite preview`, and `/` for the dev server and Vitest.
- **No cross-origin isolation.** Pages cannot send COOP/COEP headers, so `SharedArrayBuffer` and `Atomics.wait` are unavailable. The sim and worldgen workers communicate via `postMessage`, transferring `ArrayBuffer`s instead of sharing memory. Snapshots and generation results are built as transferable buffers.
- **Asset URLs.** Runtime paths must resolve under the base. Workers load via `new URL('./x.worker.ts', import.meta.url)`, which Vite rewrites. Shaders are inline WGSL strings. Any future `public/` file is addressed through `import.meta.env.BASE_URL`, never a root-absolute path.

**Reason:** Static hosting needs no server, costs nothing and deploys from CI. The price is no shared memory between threads. Transferring buffers moves them without a copy, so per-tick sim snapshots and world-generation output can still cross the worker boundary cheaply.

### 40b. Lakes from a per-sample lake level; smooth lowlands

**Date:** 2026-11-10
**Decision:**

- **Lake level.** The tile kernel writes a lake level per sample. That is the highest Priority-Flood fill level (terrain + `lakeDepth`) among the 3 × 3 global cells around the sample, counting only cells whose centers lie within about one cell.
  - The level is defined on dry ground near a lake too, so level − height is a signed depth whose zero crossing is the shoreline. It follows the fine terrain, not the 1.5 km global cells.
  - `TileData.lake` holds it, with `NO_LAKE` where no lake is near.
  - To stay within 8 storage buffers, the global lake level rides as a second u32 per cell in the material buffer, and height and level are written as one vec2 per sample.
- **Mesh and shading.** Meshes store the signed lake depth per vertex in place of the old 0/1 lake flag. Lakes are displayed flat at their level, parent morph targets and slopes included. The water shader treats lakes like the sea, with a zero-crossing mask and color by reference depth.
- **Lake beds.** Where the smooth global surface lies below the lake level, the kernel drops the detail octaves (lake beds are sediment-filled). A lake then reads as one body of water, not puddles in rough ground.
- **Lowland detail.** The plains detail amplitude falls to 15% where the eroded global slope is below 0.002 and ramps up to full by 0.015. Flat, sediment-filled lowlands are smooth, and hills and mountains keep their roughness.

**Reason:** In the owner's review at checkpoint 3:

- Lakes showed as staircases of 1.5 km cells. The tiles only had a per-cell lake flag, and the water was drawn on the lake bed.
- The plains looked uniformly rough, flat lowlands included.

### 41. Geography emerges; the campaign adapts to the world

**Date:** 2026-11-10
**Decision:**

- World generation should steer less: there may be more than two continents.
- The forced layout of decisions 17, 18 and 20 gives way to continents that emerge from the crust field and the plates:
  - two near-antipodal continent centers;
  - main and second continents of fixed sizes;
  - an east–west elongated main continent at mid-latitudes.
- The geography stage then selects the theater from what exists:
  - a main continent with room for a front with depth on both sides;
  - a supply continent across an ocean gap in range.
- Reject-and-retry becomes the fallback for worlds where no pair qualifies.
- This is scheduled as the first milestone 4 tasks. Milestone 3's rendering does not depend on it.

**Reason:** Owner's direction: discover the world and adapt the campaign to it, rather than shape the world to fit the campaign.

**Open:** How much steering remains, for example a bias toward temperate land or minimum land fraction, will be settled when the milestone 4 work starts.

### 42. Climate fields as a cube-face array texture

**Date:** 2026-11-10
**Decision:** `render/climateTexture.ts` packs the tectonic grid's climate into a `DataArrayTexture`, one RGBA half-float layer per cube face at the tectonic resolution:

- sea-level annual mean temperature: temperature plus lapse rate × reference height, so shaders can lapse-correct to any surface height;
- seasonal half-range;
- moisture;
- cloudiness, from precipitation.

Shaders sample it by direction through `cubeFaceUv`, a TSL mirror of `directionToCubeFace` (largest axis, equi-angular warp).

- **Lookup test.** A GPU test runs the lookup as a TSL compute kernel through three's renderer on Dawn. It checks face and (u, v) against `core/coords` on 4,096 random directions, and that sampling at cell centers returns each cell's values.
- **Access.** `GlobeScene.climate` is filled when a world loads and shared with the terrain (and later with trees and clouds).
- **No new vertex data.** The meshes carry no climate data.

**Reason:**

- Snow lines, seasonal tint, tree types and clouds need climate at any surface point, and the fields are smooth at the tectonic grid's ~6 km.
- One texture lookup per fragment is cheaper than more per-vertex attributes, and it would not fit the 8-vertex-buffer limit anyway (decision 39).

### 43. Land shading: moisture, rock, seasonal snow and tint, detail noise

**Date:** 2026-11-10
**Decision:** The terrain shader turns the vertex's biome color into a land albedo (`render/terrain/landShading.ts`):

- **Moisture** from the climate texture: drier ground lighter and yellower, wetter ground darker and greener.
- **Rock** where the reference slope (physical ÷ `reliefScale`) passes about 19–35°.
- **Surface temperature today:**
  - the climate texture's sea-level mean, lapse-corrected to the fragment's reference height;
  - plus the seasonal half-range × cos(2π·(phase − warmest)), with the warmest day 30 days after the summer solstice and the sign set by hemisphere;
  - plus a GUI offset;
  - with the phase from the calendar (`seasonPhase(t)`).

  It drives:
  - **Snow:** none at 0 °C, full by −5 °C; not on cliffs, thin where moisture is very low.
  - **Autumn and winter browning:** applies to green albedos (vegetation detected by color, since the shader has no biome id) as the temperature falls from 10 to 2 °C.
  - **Frozen lakes:** from −1.5 °C (full at −4). Sea ice stays the static biome until weather exists in milestone 6.

- **Detail noise.** Periodic value noise (cells of 16, 64 and 256 m) on the wrapped coordinates of decision 38 varies the albedo, rock and snow line. It fades where cells are smaller than a few pixels.
  - It replaces the TODO's triplanar mapping. 3D noise needs no projection, so it cannot stretch on cliffs, and it needs no textures.
- **Water beds.** Water bodies use the raw vertex color as their bed, so snow and rock do not tint the sea floor.
- **Debug modes.** Debug color modes skip all of this.
- **GUI → Lighting:** "Snow: temperature shift" and "Ground detail".

**Reason:**

- Seasons need per-fragment temperature at the true surface height, which the climate texture (decision 42) provides cheaply.
- Snow and tint follow from the same climate the biomes came from, so they agree with the world.

### 44. Forest density: global base and treeline, per-sample stands in the tiles

**Date:** 2026-11-10
**Decision:**

- **Global maps.** `finishWorld` adds two maps on the global grid, stored in the world record (`GENERATOR_VERSION` 2):
  - `forest`: base density 0..255 by biome (forest biomes 0.75–0.95, savanna and shrubland about 0.2, grassland 0.1, tundra 0.03, else 0);
  - `treeline`: the physical height where the warmest month cools to 10 °C, lapse-corrected through reference height.
- **Per sample.** The tile kernel computes forest density per sample and packs it into material bits 24–31:
  - the base density of the noise-jittered biome cell, so forest edges follow biome edges;
  - × the treeline (±30 m band) at the fine height;
  - × slope, gone by a reference slope of 1;
  - × (1 − river coverage);
  - zero in lakes and at sea;
  - clumped into stands and clearings by two noise octaves (1,600 and 500 m) wherever they are resolved, so coarse tiles keep the mean.
- **Packing.** To stay within 8 storage buffers, the global table packs biome, lake flag and forest into one u32. Lake level and treeline go into a second u32 as half floats, about 1 m precision, which is enough because lakes are flat and at least 3 m deep.
- **Rendering.** In biome mode, forest blends the ground toward a canopy green (darker conifer green in taiga). "Color by → forest" shows the density.

**Reason:**

- The design uses forest density in three places: rendering, line of sight and the barrier map.
- A biome-level base plus deterministic per-sample variation is a pure function of direction like the rest of the tile (decision 24), so every consumer sees the same forests.

### 45. Instanced tree clumps per level-9 tile

**Date:** 2026-11-10
**Decision:** `render/forest/forestLayer.ts` draws trees within `range` (default 5 km) of the camera while it is below 8 km above the ground.

- **Placement.** Trees are placed per level-9 tile (about 3 km). Candidates sit on a jittered 40 m lattice from `rng(seed, "trees").fork(tileKey)`. Every candidate draws all its random values, so placement never depends on rejections.
  - A candidate is kept if a draw falls below the forest density (decision 44), sampled bilinearly from the level-7 tile data.
  - It is dropped at sea and in lakes.
  - It stands on the same surface function the terrain mesh evaluates at level 10.
- **Clumps.** An instance is a clump of four low-poly trees, about 40 triangles. Conifers grow in taiga and temperate rainforest, plus 30% of temperate forest; elsewhere trees are broadleaf. Trunks reach 3 m below the ground to hide small height mismatches.
- **Instance data.** Ground point relative to the tile origin, up vector, and (raw height, scale, rotation, kind), in an `InstancedBufferGeometry`.
- **Vertex shader.**
  - It applies the terrain's exaggeration to the ground point only; trees keep their real size.
  - It builds the tree frame and shrinks clumps over the last 1.2 km of the range.
  - It computes aerial perspective per vertex (6 steps).
- **Shading.** Same lighting as the terrain. Broadleaf crowns brown below 10 °C and go bare below 0 °C, and snow settles on upward crown faces (decision 43).
- **Budget.** Tiles build within 4 ms per frame, nearest first, and are evicted 120 frames after they are last wanted.
- **GUI.**
  - View → Terrain tiles: "Trees" and "Tree range".
  - Status: "Trees" shows clumps and tiles.

**Reason:**

- Instancing per tile keeps placement deterministic and local, and the tiles' forest density is already resident for the terrain.
- Clumps rather than single trees give a forest's density at about a tenth of the instances.

**Measured** (preview at 700 m over dense taiga): 33 tiles and 166,000 clumps, about 6.6 M triangles. That is fine on the owner's desktop GPU, and laptops should shorten the range. A coarser far LOD (one cone per clump) is a milestone 8 performance item.

### 46. Unsteered generation; the campaign is detected from the world

**Date:** 2026-11-10
**Decision:** World generation is unsteered (design revision 4). The campaign reads the generated world through the strategic graph and adapts to it.

- **Supersedes:**
  - decision 16, the ocean gap as a generation constraint;
  - the continent layout of decision 17. The default `oceanFraction` stays 0.70 for now;
  - the steered plate seeding of decision 18;
  - decision 20, temperate east–west continents;
  - the open point of decision 41. No steering remains.
- **Plates.** Every plate seed is placed by best-candidate sampling over the whole sphere.
  - Plate types come from `rng("plates")`: plates are taken in a random order and marked continental until their area reaches about 1.35 × the land fraction (capped at 0.9).
  - There is at least one plate of each type.
- **Crust.** Continentalness is derived from the plate types:
  - start from the signed geodesic distance to the interface between continental and oceanic plates (two multi-source Dijkstra passes);
  - sample it at a domain-warped position;
  - roughen it with noise;
  - threshold it at the `oceanFraction` area quantile.

  The stream is `rng("crust")`, and the stage now runs after the plates. Since continental plates cover more area than the land, coasts lie inside them (passive margins), and boundaries between continental plates raise interior ranges.

- **Parameters.** `oceanGap` is removed. Sea-lane lengths come from the strategic graph. `rangeFactor` leaves `PlanetParams` (decision 51).
- **World info.** `mainContinent` now means the most inland cell of the largest landmass. It anchors the campaign calendar (decision 33), previews and tests until the strategic graph exists. Two fields are added: `landmassCount` (landmasses of at least 2,000 km²) and `largestLandmassArea`.
- **Rejection.** The validity check (milestone 4) is the only rejection: enough flat land for 15 airbases per side and at least one theater above its fit threshold. A failed world regenerates from the seeded sub-seed `fork("retry-n")`, so each seed still maps to exactly one world.
- `GENERATOR_VERSION` is 3.

**Reason:** Owner's direction. The world comes first. One seed may give a supercontinent, two continents or an archipelago. Theater detection (design, _Theaters_) turns whatever exists into a war, rather than shaping the world to fit one war.

### 47. Casting is automatic and cannot be confirmed or edited

**Date:** 2026-11-10
**Decision:** Casting turns detected theaters into a campaign: theaters, territory, posture, the range factor, industry, ports and bases, and a briefing.

- It draws only from `rng("casting")` and its forks.
- It reads only the strategic graph (decision 52).
- It runs before the player picks a side.
- The cast does not depend on that choice.
- There is no confirm, re-roll or edit UI. A player who wants a different war picks a different seed.

**Reason:** The same seed must always produce the same war, unfolding identically until the player intervenes. An editable cast would turn worlds into scenarios and make them impossible to share by seed.

### 48. Both sides playable; the side is fixed for a campaign

**Date:** 2026-11-10
**Decision:**

- **Choosing a side.** The player picks the Alliance or the Pact at campaign start (milestone 9) and keeps it for the campaign. There is no side switching, which settles that open question in the design.
- **Symmetric code.** Both command layers run the same code. Doctrine (Pact waves and ground-controlled interception, Alliance AWACS and autonomy) lives in mission templates and planner weights, not in branches.
- **The side is a view, not an input.** The sim never reads the player's side. It only filters the mission panel, subscriptions and the intelligence overlay.
- **Debug toggle.** Until milestone 9, a debug GUI toggle sets the viewing side. It is a developer tool, not a feature.

**Reason:** Owner's direction. Keeping the side out of the sim keeps decision 47's promise that the war does not depend on the choice.

### 49. The player is a pilot only; the fidelity bubble follows the player

**Date:** 2026-11-10
**Decision:**

- **No command.** The player does not command ground or naval forces, and there is no command UI. The player shapes the war only through the aircraft they fly.
- **Jump-in and handback.** A mission accepts the player from climb-out to approach. Leaving hands the aircraft back to the AI with its current orders.
- **Promotion bubble.**
  - The player's own aircraft runs at full fidelity.
  - Ground and air entities within about 15–25 km are promoted to the entity level.
  - Everything else stays aggregate and low-fidelity.
- **Before cockpit flight.** Until cockpit flight exists (after the demo), the bubble centers on the followed aircraft or the camera.

**Reason:** Owner's direction. The player's attention rests on flying (design pillar 5), and simulation cost goes where the player is.

### 50. A rule-based air tasking order

**Date:** 2026-11-10
**Decision:** Each side's command layer builds an ATO per game day and revises it at a fixed replanning tick every few game hours. It works in four steps:

1. collect needs from the theaters;
2. rank them by priority score (theater weight × target value × urgency);
3. build packages from squadrons in range, adding escort and SEAD when the target area is defended;
4. schedule them according to doctrine.

- Ties break deterministically by stable ids, and every random draw comes from a per-side, per-day fork. It contains no search, optimization or learning.
- Each mission records the need it serves and its score. The mission panel can then explain why a mission exists.
- Planning considers only targets the side knows about (decision 53).

**Reason:** The planner only has to produce a believable war, not win one (pillar 5). Rules are deterministic at any time acceleration, cheap enough for a worker, and legible to a player browsing missions.

### 51. A per-world range factor chosen by casting

**Date:** 2026-11-10
**Decision:**

- Casting chooses the range factor in [0.35, 1.0] for each campaign and stores it in the cast, not in `PlanetParams`.
- Two targets set it:
  - a medium strike aircraft from rear bases must reach the full depth of the enemy side of a front;
  - a long-range bomber must reach across the widest contested sea lane.
- It scales fuel capacity and burn rate only. Speeds, climb rates and weapon ranges stay real.
- Supersedes decision 4's fixed 0.5. The principle of compressing range, not speed, stays.

**Reason:** Geography now varies from world to world (decision 46), so no single factor keeps every set of theaters playable. Whether the result feels right is checked by flying sorties once milestone 7 works.

### 52. The strategic graph is the only interface between world data and campaign logic

**Date:** 2026-11-10
**Decision:**

- **Readers.** Theater detection, casting and the command layer read the strategic graph and the cast. They never read heightmaps, tiles, `WorldMaps`, `TileData` or `terrainHeight`.
- **New facts.** If campaign logic needs a fact about the world, the graph builder computes it and adds it to the graph.
- **Layout:**
  - graph types and builder in `src/worldgen/strategic/` (the builder reads the maps);
  - theaters, casting and briefing in `src/campaign/`;
  - the command layer in `src/sim/command/`.
- **Lint.** ESLint bans imports of `worldgen` from `src/campaign/**` and `src/sim/command/**`, except `worldgen/strategic/**`.
- **Execution layer.** The sim's execution layer (flight paths, line of sight, ground movement) may still query terrain. Only planning is restricted.

**Reason:**

- The graph debug overlay and the seed browser can only judge what campaign logic sees if that logic sees nothing else.
- The rule keeps campaign code independent of map resolution and tiling, so it can run on the coarse pass.
- It makes decisions explainable in terms the player can see on the strategic map.

### 53. A per-side intelligence picture from radar, satellites and reconnaissance

**Date:** 2026-11-10
**Decision:**

- **What a side knows.** Each side plans against what it knows, not against ground truth. A per-side intelligence store holds contacts: object id, position, type, time last seen, confidence and source.
- **Sources:**
  - **Reconnaissance satellites.** Analytic orbital ground tracks give revisit times. Optical imaging needs daylight and clear sky from the weather field. Rarer radar-imaging satellites see through cloud.
  - **Ground and airborne radar.** AWACS and ground radar coverage give the air picture, limited by the radar horizon and terrain masking. The air picture also drives the Pact's ground-controlled interception.
  - **Reconnaissance missions.** They refresh contacts along their routes.
- **Decay.** Confidence decays with age, fastest for moving units.
- **Determinism.** Pass times are analytic, and detection rolls come from per-side forks of `rng("intel")`, so the picture is identical at any time acceleration.
- **Display.** An overlay shows the viewing side's contacts and satellite tracks (milestone 7).

**Reason:** Owner's direction. Radar and satellite imaging are central Cold War technology. Reconnaissance missions only make sense if targets must be found before they are struck.

### 54. Rivers drawn from vector data by per-fragment distance

**Date:** 2026-11-10
**Decision:** The terrain fragment shader draws rivers from the world's river polylines by exact distance to the centerline (`render/water/riverTables.ts`, `riverShading.ts`). This replaces the per-vertex river coverage from checkpoint 2. Carved channels stay.

- **Segment table.** One storage buffer holds every smoothed river segment as two vec4 per segment (unit endpoints and half-widths), followed by coarse chords that each merge up to 8 consecutive connected segments (about 3 km).
- **Lists.** Each mesh loops over one list of indices into the segment table:
  - **Fine lists** per level-7 tile hold every segment that can reach into the tile (half-width + 150 m). Meshes at levels 7–10 use their ancestor's list, typically 0–60 segments.
  - **Coarse lists** per level-4 tile hold chords of rivers at least 25 m wide, widest first, capped at 160. Meshes at levels 4–6 use them.
  - Levels 0–3 draw no rivers.
- **Per-mesh range.** Each mesh passes its list's start and count as per-object uniforms. The tables and the material are rebuilt per world (about 2.4 s for 175,000 segments at 1024²).
- **Coverage.** Coverage comes from the signed distance to the bank in pixels.
  - Rivers narrower than `minPixels` (default 2) are drawn that wide.
  - `legibility` (default 0.8) scales them between their true pixel fraction (0) and full strength (1), so rivers stay readable as barriers from altitude.
  - Rivers shade as water of a nominal 30 m reference depth, with waves and glint like the sea.
- **GUI.** Lighting → "River legibility".
- **Tests.**
  - River tables on a synthetic straight river: listing by tile, the coarse width threshold, half-widths.
  - Coverage as a TSL compute kernel on Dawn: inside and outside the banks, and sub-pixel fading.

**Reason:**

- An offset-field texture per tile (the plan) or a coverage mask is limited to the 48 m samples of level 7 and needs per-tile GPU textures.
- Exact distance gives crisp banks at any zoom from a few megabytes of shared buffers, and costs a short loop per fragment.
- Coarse chords keep the loop short where tiles are large: segments are only about 0.4 km long, and the first version's cap kept just a fragment of one river per level-4 tile.

### 55. Cloud shell from a static field; cloud shadows through planet lighting

**Date:** 2026-11-10
**Decision:** Until the weather model exists (milestone 6), clouds are a transparent cube-sphere shell 5 km above sea level (`render/clouds/cloudLayer.ts`).

- **Shell.** The shell is drawn camera-relative at planet center − eye. Fragments compute coverage from their own direction, so the mesh resolution does not limit the clouds.
- **Coverage.**
  - two fractal noises, for weather systems (about 300 km) and finer cells (about 33 km);
  - plus the climate texture's cloudiness (from precipitation, decision 42), so wet regions are cloudy and deserts clear;
  - plus a GUI bias, through a soft threshold.

  The field drifts with game time at about 10 m/s.

- **Lighting.** Sunlight is filtered by the atmosphere, so clouds turn orange at the terminator, plus sky light and per-vertex aerial perspective. Seen from below, thick cloud is darker.
- **Shadows.** `PlanetLighting.sunVisibility` is a hook the cloud layer sets before any material is built. `sunlightAt(p)` multiplies sunlight by the coverage where the ray toward the sun crosses the shell (75% blocked under full cloud), so terrain, water glint and trees all receive cloud shadows.
- **GUI → Lighting:** "Clouds" and "Cloud cover".

**Reason:**

- A 2D shell with a coverage function is what the design asks for until live weather.
- Putting coverage behind one function means milestone 6 swaps the static field for the weather grid without touching the materials.
- One sunlight function keeps the shadows consistent everywhere.

### 56. Owner clarifications on design revision 4

**Date:** 2026-11-10
**Decision:**

- **Ocean fraction.** The default `oceanFraction` stays 0.70, not the 0.55 in the design's parameter table.
- **Weather and day/night** remain in demo scope under decision 15, although revision 4's goals and milestones do not mention them. Weather stays in milestone 6.
- **Carrier air wings fly ATO missions in the demo.**
  - A carrier group is a mobile base: its squadrons belong to the group.
  - A mission launches and recovers at the group's analytic position at those times. The planner measures range from the predicted position.
  - There are no deck operations, which matches "no takeoff or landing by default".
  - Casting assigns carrier groups to sides. Each air wing's aircraft come from its side's aircraft table.
  - Carrier groups move on analytic sea routes from milestone 7, because the ATO needs them. Amphibious groups and theater tasking of naval groups stay in milestone 8, and naval combat after the demo.

**Reason:** Owner's answers to the ambiguities listed after revision 4 was adopted.

### 57. Reconnaissance satellites on fixed orbits, modeled on Cold War systems

**Date:** 2026-11-10
**Decision:** This refines decision 53. Satellites give each side periodic, delayed updates, not a live picture.

- **Orbits.**
  - Satellites fly fixed circular Keplerian orbits that never maneuver.
  - Periods come from the planet's GM = g·R², with Earth's surface gravity (aircraft performance is real, decision 14). At 250 km altitude that is about 47 min, about 31 revolutions per day.
  - Nodes precess at a fixed sun-synchronous rate, so each satellite passes at a fixed local solar time.
  - Ground tracks and passes are analytic functions of `GameTime`, identical at any time acceleration.
- **Revisit.** On a 1,000 km planet a low orbit circles the globe far more often than on Earth. So a sensor's field of regard (narrow off-nadir pointing) and the size of each constellation set the revisit time, tuned to Cold War values. A given target gets digital imaging about once or twice a day per side, and film-return deliveries every few days. These are constants, to be tuned with the seed browser and in milestone 7.
- **Classes,** each modeled on real systems:

  | Class                      | Reference                                                 | Sees                                                    | Delay from observation to contact                                 |
  | -------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
  | Film-return imaging        | KH-9 Hexagon, KH-8 Gambit; Zenit, Yantar-2K               | Wide area, high resolution; daylight and clear sky only | Until the next capsule recovery (every few days), plus processing |
  | Digital electro-optical    | KH-11 Kennen (from 1976); Yantar-4KS1 Terilen (from 1982) | Narrow, high resolution; daylight and clear sky only    | Hours (relay and exploitation)                                    |
  | Radar ocean reconnaissance | US-A (RORSAT)                                             | Ships, through cloud and at night                       | Minutes                                                           |
  | ELINT ocean reconnaissance | US-P (EORSAT); White Cloud (NOSS)                         | Emitting ships and radars                               | Minutes to an hour                                                |
  | Radar imaging              | Lacrosse (1988)                                           | Through cloud and at night, lower resolution            | Hours; rare                                                       |

- **Per-side constellations.** They follow each side's references:
  - The Alliance has few but capable digital imagers, ELINT triplets and, late in the period, radar imaging.
  - The Pact relies on frequent short film-return missions and radar and ELINT ocean reconnaissance.
  - Constellations are fixed at campaign start. There are no launches or losses in the demo, and satellites cannot be attacked (ASAT is out of scope).
- **Contacts.** A satellite contact carries its _observation_ time but enters the side's picture only at its _delivery_ time. It is already stale when it arrives, and its confidence decays from the observation time (decision 53).

**Reason:** Owner's direction. Satellites should give updates only every so often, with real delays, modeled on actual Cold War reconnaissance satellites. A Cold War commander planned against hours- or days-old imagery, and the delay is what makes tactical reconnaissance missions worth flying.

### 58. Clouds move with prevailing zonal winds

**Date:** 2026-11-10
**Decision:** This revises decision 55. The static cloud field is advected around the polar axis by a zonal wind that depends on latitude, instead of translating the noise through the planet in 3D, which read as boiling rather than moving.

- **Wind profile.** Easterly trades at −6 m/s, westerlies of about +12 m/s between 30° and 60°, and polar easterlies. A `windScale` uniform scales it.
- **Advection.** Coverage is sampled upstream: the direction is rotated back about the axis by ω·age, with ω = wind / R.
- **Cross-fading.** Two copies of the field run half of a two-day cycle apart, and each re-seeds its noise when its cycle ends. Their cross-fade keeps shear between latitude bands from piling up, and clouds evolve as they travel.
- **Checks.** Preview renders 2 h apart show clouds shifting downwind (`HOURS` in `tools/render.preview.ts` offsets only the cloud clock). Milestone 6 replaces all of this with the weather grid's own winds.

**Reason:** Owner review at checkpoint 4: the clouds changed shape but did not drift.

Also at checkpoint 4: the tile kernel no longer carves river channels into lake beds (carving × the lake-bed mask of decision 40). Rivers crossing a lake showed as dark lines through the water.

### 59. Clouds: two rigidly moving fields, climate as odds

**Date:** 2026-11-10
**Decision:** This revises decision 58.

- **Motion.** Cloud coverage blends two independent noise fields by latitude band, each turned rigidly about the polar axis:
  - one eastward, the westerlies: about 12 m/s at 45°, between roughly 27° and 63°;
  - one westward, the trades and polar easterlies: about 7 m/s at 15°.

  Rigid motion has no shear, so clouds never stretch. At band edges the two fields slide past each other and cross-fade. Both evolve slowly in place, about one feature every 3 days. The re-seeding cycles of decision 58 are gone.

- **Climate as odds.** The precipitation-derived cloudiness shifts the noise by ±0.15 at most (it was up to +0.63), so it changes how often a place is cloudy, not whether it ever clears.
- **Test.** A GPU test samples coverage at 512 points over 12 days on Dawn. It checks that every point is mostly clear at least 15% of the time, that mean coverage lies between 0.15 and 0.55, and that the field changes more over 12 h than over 1 h. The wettest belts, the equator and the mid-latitude storm tracks, are the cloudiest and still clear about one time in six.

**Reason:** Owner review: the latitude-dependent advection of decision 58 stretched clouds into streaks (shear between bands), and wet regions, mountains included, were solid white all the time.

### 60. Touch gestures for the orbit camera follow map apps

**Date:** 2026-11-10
**Decision:** The orbit camera takes touch and pen input as well as mouse and keyboard. The RTS view is top-down, so touch maps to the gestures people know from map apps:

- **One finger** drags the ground under it, like a left mouse drag.
- **Two fingers** pan by the midpoint's motion, pinch-zoom and twist the heading. Zoom and twist pivot on the midpoint, so the ground under the fingers stays under them (exact at nadir, approximate when tilted). Pinch zoom sets the altitude at once (`OrbitCamera.zoomAt`) instead of easing, because easing would make the ground lag the fingers.
- **Three fingers** dragged up or down tilt the view. Two-finger vertical drags already pan, so tilt needs its own finger count.
- The page blocks browser zoom (`user-scalable=no`, Safari `gesture*` events) so pinches reach the canvas.

**Reason:** Owner testing on a tablet: the old handler kept a single "last position" shared by all pointers, so a second finger made the view jump and pinch did nothing.

### 61. The coarse pass runs on the CPU without erosion

**Date:** 2026-11-10
**Decision:** The coarse pass (design, pipeline steps 1–9) runs in the worldgen worker on the CPU at 256² per face (`worldgen/coarsePass.ts`):

- the tectonic pipeline (plates to biomes) on the tectonic grid;
- drainage (decision 23) on the tectonic heights, which fills `discharge` and `lakeDepth` in the tectonic maps;
- the strategic graph (decision 62), theater detection, casting and the validity check (decision 63).

It skips GPU erosion. The design's "reduced global erosion pass" is left out: drainage on the uneroded tectonic heights already gives the rivers that barrier lines and port scores need, and the coarse pass then runs the same in the worker, in Node tools and in tests, without a GPU.

- **Timing.** About 4–6 s per world on the development container (5 s tectonic pipeline, 0.2 s drainage, 0.4–1.2 s graph, a few ms casting). The design's "about a second" is not met; decision 12 removed the time budget. The Campaign GUI folder and the console report it.
- **Resolution.** The graph is always built at 256², whatever the displayed tectonic resolution. When the GUI asks for another resolution, the worker generates that world separately from the seed that passed the validity check.
- **Seed.** The global pass, tiles and trees use the seed that passed (decision 63), so the eroded world matches the graph.
- `GENERATOR_VERSION` is 4: world records also store the graph and the campaign.

**Reason:** Campaign logic must run wherever the world is generated, including the seed browser over many seeds, and the graph only needs coarse facts (decision 52).

### 62. Strategic graph construction

**Date:** 2026-11-10
**Decision:** `worldgen/strategic/` builds the graph from the coarse pass. Everything is deterministic and draws no random numbers; ties break by cell or node index.

- **Landmass statistics** (`landmasses.ts`): area, centroid, coastline length, latitude span and terrain mix (plains, hills, mountains by reference height and slope; forest, desert and ice by biome).
- **Airbase sites:** reference slope under 3 %, reference height under 1,200 m, no lake, ice sheet or alpine; picked greedily best first, at least 40 km apart within a landmass. The count is the landmass's airbase capacity.
- **Port sites:** coastal land cells scored by shelter (land around about two-thirds of a 30 km circle), deep water within 15 km, a river mouth and flat ground; at least 120 km apart, at most 16 per landmass, and at least one per landmass.
- **Nodes:** every landmass of at least 2,000 km², then archipelagos: smaller islands linked by single linkage within 300 km coast to coast, kept as a node when they total at least 1,000 km².
- **Ocean grid:** a cube-sphere grid of about 33 km cells (48² per face). Cells with at least 25 % water are navigable. Cost per meter: 1 + 0.6 × shallows + 4 × sea ice + 1.5 × land.
- **Sea lanes:** for each pair of nodes, the least-cost route from a port of one to a port of the other. Lanes between two major nodes (landmasses of at least 50,000 km²) are always kept. A lane involving a minor node is dropped if a third node lies on the way (via it costs at most 10 % more), which keeps archipelago worlds from filling with redundant lanes. Applying the rule to major nodes too would split a lane through a strait between two continents at a nearby port, and the strait would never be found.
- **Width and straits:** at each route point the width is measured by marching across the route until land on both sides, skipping 150 km at each end. The narrowest point of each stretch under 150 km is a strait; straits within 150 km merge across lanes.
- **Island chokepoints:** islands under 20,000 km² with at least one airbase site, within 300 km of a lane and more than 250 km from its ends; up to three per lane.
- **Node distance:** coast-to-coast sea distance between all node pairs.
- **Barrier map:** 1 − Π(1 − bᵢ) over river width (15–200 m), reference slope (3–15 %), ridge prominence over a 30 km mean (150–1,200 m), forest density × 0.35, and lakes (0.7). The first version weighted forest at 0.6, and lines then followed forest edges more than rivers and ridges.
- **Front generator:** for each landmass of at least 250,000 km²:
  - a principal axis (area covariance in an azimuthal projection about the centroid) and the area quantile q along it;
  - a least-cost 8-connected path from the largest coastal stretch of the band q ∈ [0.2, 0.8] to the largest stretch on the other side of the band's midline, with step cost length × (0.15 + (1 − b)²);
  - sides by 4-connected flood fill from both ends of the axis. A path that does not separate the land (around an inland sea) is excluded and the search retries;
  - up to four lines, each excluding a corridor of max(60 km, band length / 8) around it, so lines cannot cross;
  - lines ordered along the axis; the start line is the neighbor of the strongest line whose two sides both hold at least 35 %, preferring the one that gives the attacker more land. The forward side (away from the strongest line) is the attacker's;
  - side depth is the distance from the line within which 90 % of the side's land lies, so remote peninsula tips do not set the range factor;
  - corridors: the weakest 50 km windows of each line, below the line's mean strength, at least 150 km apart and away from the coasts, up to three per line.
- **Known limitation:** a ring-shaped continent around a polar sea (seed 1983) has no single coast-to-coast cut that splits it. It gets no front, and the world falls to other theaters or to the validity retry.

**Reason:** The design describes what the graph must contain but not how to find it. These choices are the simplest that produce plausible lines and lanes on the seeds checked with `npm run maps` (`MODES=graph,barrier`).

### 63. Theater detection, casting and the validity check

**Date:** 2026-11-10
**Decision:**

- **Registry** (`campaign/theaters.ts`), run in order; each module sees the theaters selected before it:

  | Theater           | Precondition                                                                                | Fit                                                                         | Threshold |
  | ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- |
  | Continental front | a start line exists                                                                         | size (250,000 km² → 1.5 M km²) × (0.7 + 0.3 × balance) × min(1, bases / 15) | 0.35      |
  | Island campaign   | no front selected; a cluster of ≥ 2 nodes within 600 km of each other                       | nodes (1 → 5) × airbase sites (10 → 40)                                     | 0.35      |
  | Sea lane          | a lane of 800–3,000 km from a selected front's defender side to another node; two per front | length (full between 1,200 and 2,400 km) × rear-base sites (5 → 30) × ice   | 0.4       |
  | Chokepoint        | on a selected sea lane; two per lane                                                        | strait narrowness, or island airfields and distance                         | 0.4       |
  | Strategic         | any other theater selected                                                                  | 1                                                                           | 0         |

  "Balance" is how far the smaller side of the start line is above 35 %. The thresholds are first guesses, to be tuned with the seed browser (design open question).

- **Territory:** a front's landmass is split along its start line, the Pact on the forward side. The front generator chooses the forward side so the attacker gets more land where it can, which stands in for "mass and interior lines". The Alliance takes each sea lane's rear base and each chokepoint island. In an island campaign the cluster splits around its most distant pair of nodes, and the Pact takes the group with more land. Other nodes stay neutral.
- **Posture:** the Pact attacks everywhere; the strategic theater is mutual.
- **Links:** sea lane → front ("supplies"), chokepoint → sea lane ("protects"), strategic → fronts and island campaigns ("industry").
- **Range factor:** the smallest factor that meets every target, clamped to [0.35, 1]:
  - fronts: from rear bases 250 km behind the line (or the side's depth if shallower) to the enemy side's depth, against a medium strike aircraft's 1,300 km radius (Tornado IDS, Su-24 hi-lo-hi);
  - sea lanes: the lane length against a long-range bomber's 4,000 km radius;
  - island campaigns: the farthest opposing node pair against the medium strike radius.

  These reference radii stand in for the aircraft tables of milestone 7.

- **Regions** for milestone 5: up to three industry regions per side deep in its territory (random among good sites, from `fork("regions")`), up to four base regions per side 100–400 km behind each front, ports at both ends of each lane and the best port on each side of a front, and ground-combat regions along the start line, on its corridors and on contested islands.
- **Names and briefing:** invented names from `fork("names")`; one paragraph per theater, with compass directions, areas, depths, corridors and the range factor.
- **Validity:** a world is valid with at least one theater besides the strategic one and at least 15 airbase sites in each side's territory. The per-side count needs the cast, so the check runs after casting. A failed world regenerates from `retrySeed(seed, n)`: two draws from `rng(seed, "validity").fork("retry-n")` as a decimal string, up to 8 retries. If all fail, the seed's own world is kept and marked invalid.

**Reason:** The design fixes the theaters and their preconditions but leaves the fit scores and thresholds open. Simple, monotone fit functions make the seed browser's statistics easy to read and tune.

### 64. The regional bake is the on-demand level-7 tiles

**Date:** 2026-11-10
**Decision:** The design's second bake at about 50 m over ground-combat regions needs no new bake. Tile synthesis already reaches level 7 (about 48 m samples) anywhere on demand (decision 28), and decision 29 found tiles faster to synthesize than to load. Casting marks ground-combat regions, and `regionTiles` (`campaign/regions.ts`) lists the level-7 tiles that cover them, so milestone 8 can prefetch those tiles for line of sight inside the promotion bubble.

**Reason:** A persisted regional bake would duplicate what the tile cache produces and contradict decision 29.

### 65. Settlements, roads and airbases on the coarse pass; civilian geography before casting

**Date:** 2026-11-10
**Decision:** Milestone 5 places everything on the coarse pass's 256² grid on the CPU, in two steps on either side of casting.

- **Why the coarse pass.** Airbases, bridges and targets are what the ATO plans against, so they must be the same on every machine. GPU erosion is not bit-identical across GPUs (see the determinism flake in `TODO.md`), so the eroded 1024² world cannot be the source. The coarse pass is CPU-only and runs in the worker, in tools and in tests.
- **Order (a deviation from "placed from the cast").** Settlements, roads and bridges are world facts and join the strategic graph _before_ casting (`worldgen/strategic/settlements.ts`, `movement.ts`, `roads.ts`). That breaks a cycle: corridors need roads ("weak, well-roaded segments"), roads need settlements, and settlements would otherwise need the cast's industry regions. Instead, casting now puts each side's industry regions on its largest urban clusters (population summed within 80 km, with a random factor from `fork("industry-<side>")`), so settlements are denser there by construction. Worlds without settlements fall back to the old airbase-site rule.
- **Settlements.** Habitability per cell (biome fertility × lowland × flatness × (1 + water access from rivers, confluences, coasts, lake shores and port sites)). One settlement per 3,500 km² of habitability-weighted land, at most 700, placed by weighted sampling without replacement (keys u^(1/w)) at least 18 km apart; every port site gets a port town. Populations follow rank-size (exponent 0.9) over a habitability × lognormal key, scaled to 30 people per weighted km². City from 200,000, town from 40,000. Names come from `NameGenerator`, now in `core/names.ts`. The graph builder draws random numbers here, from `rng(seed, "settlements")` only; decision 62's builder was free of randomness.
- **Movement cost.** 1 + 10 × reference slope + a biome term (ice 6, alpine 2.5, rainforest 1, …) + 0.5 × forest; Infinity at sea and on lakes. The sim's execution layer can reuse it for ground movement.
- **Roads.** Within each landmass, settlements link along their relative neighborhood graph (up to 350 km) plus the minimum spanning tree. Links route most important first (√(pop·pop) / distance) by A* over 8-neighbors; steps on existing roads cost 0.3 ×, so later links merge into trunks. Entering a river at least 25 m wide costs a bridge (1.5 cells + width / 80 m), and a diagonal step that slips between two cells of such a river is forbidden. Traffic per grid edge sets the class: highway from 150, main from 60 (thousands of √(pop·pop)), else minor; widths 24, 12 and 7 m.
- **Bridges** are where a connected group of road cells on a river ≥ 25 m wide has road attached on both banks. They are targetable features in the graph.
- **Corridors** score (1 − mean barrier) × (0.35 + 0.65 × min(1, road score)), where the road score sums class weights (1, 0.6, 0.3) of roads crossing the 50 km window, and center on the best crossing. Windows above the line's mean strength qualify only with roads. Each corridor records its crossings. Each barrier line also records settlement offsets.
- **After casting** (`worldgen/strategic/infrastructure.ts`, pipeline step 10, only for the accepted world): a territory map per cell (whole nodes by owner; split nodes by flooding from sites and settlements on each side of the rasterized start line), then:
  - **Ports:** military ports at the cast's port regions, plus up to three commercial ports per side per node.
  - **Airbases** per side, at least 40 km apart and at least 5 m above sea level (the eroded world can drown lower coastal flats): island airfields on held island nodes of island campaigns and chokepoints; forward airfields within 200 km of strait chokepoints on each side's shore; two strategic bomber bases per side (with a strategic theater) farthest from enemy territory; then main bases up to 15 + one per 80,000 km² of held land (at most 45), by suitability × a depth weight (0.25 at the line, 1 from 100 to 400 km, 0.3 beyond 800 km; 0.45 off fronts) × road access × 1.6 inside base regions × a random factor. Bases within 120 km of the line are forward airfields. Runways lie roughly east–west (prevailing zonal winds) ± 35°.
  - **Spur roads** link airbases and ports off the network to the nearest road or settlement.
  - **Targets:** factories (and a power plant) in the three largest towns of each industry region, one refinery per side, up to three supply depots at road junctions 60–150 km behind each front, rail yards in the two largest towns 150–400 km back, and fuel depots at military ports.
  - Randomness from `rng(seed, "infrastructure")` forks only.
- **Storage.** The graph gains `settlements`, `roads` and `bridges`; `StrategicWorld` gains `infrastructure`. All typed arrays transfer. `GENERATOR_VERSION` is 5. The added cost is about 0.5 s for the graph and 0.5 s for placement per world.
- **Rendering.**
  - **Roads and airfield pavement** draw in the terrain fragment shader like rivers (decision 54): segment lists per tile, with a negative width marking concrete (runway 45 m, parallel taxiway, links and apron). They draw over dry land and rivers, so a road over a river reads as a bridge; at sea and on lakes they do not draw. This replaces the TODO's "runway meshes": a separate mesh would fight the terrain's LOD, exaggeration and geomorphing, while the shader follows the surface exactly.
  - **Night lights** are disks per settlement (radius 1.6 × the urban radius), airbase and industrial site, listed per level-2 tile (per face for levels 0–1), added on the night side in sodium orange, at least 1.5 pixels wide so towns stay visible from orbit.
  - **Buildings** (`render/infra/structureLayer.ts`) are instanced boxes per level-9 tile within 12 km below 15 km altitude, on the trees' level-10 surface: town blocks on a jittered 45 m lattice with probability 0.55·exp(−2(d/r)²), some taller in city cores, shrinking away over the last 2.5 km of the range; hangars, a tower and hardened shelters at airbases; halls and stacks at industrial sites. Trees keep out of towns, airfields and roads.
- **Known limitation.** Coarse rivers (256²) and the rendered rivers of the eroded 1024² world can run a few kilometers apart, so a bridge in the data may sit beside the river the player sees. Roads drawn over rendered rivers still read as crossings. Snapping bridges to rendered rivers is a later polish item.

**Reason:** The design asks for settlements, roads, ports and airbases "according to the cast" and for corridors on "weak, well-roaded segments". Building the civilian geography first keeps the causality plausible (geography, then people and roads, then the war) and keeps every planning fact deterministic and inside the strategic graph (decision 52).

### 66. Denser settlements and roads; rural night glow

**Date:** 2026-11-10
**Decision:** This revises decision 65 after the owner's first look in the browser: roads and night lights were too sparse to resemble Earth at night.

- **Settlements.** One per 350 km² of habitability-weighted land (was 3,500), at most 3,000, at least 1.1 coarse cells (about 7 km) apart, at 70 people per weighted km² (was 30). A typical world now has about 2,000 settlements: some 20–30 cities, 70–140 towns, the rest villages.
- **Two-tier roads.** The trunk network links towns and cities (at least 20,000 people, plus the three largest settlements of each node) as before. Every other settlement, largest first, then gets a feeder road: the cheapest route to any road or connected settlement within 120 km of route cost. Road length roughly doubles, and the extra roads are mostly minor.
- **Habitability in the graph.** The graph stores habitability per coarse cell (`StrategicGraph.habitability`, 0..255): where people live outside towns.
- **Night lights.**
  - Town disks are twice the urban radius, and brighter.
  - Light lists come in three tiers: per face only lights of at least 5 km radius, per level-2 tile those of at least 2 km, per level-4 tile all of them. Coarse meshes loop over few lights.
  - A rural glow fills the land between towns: rescaled habitability^1.5 × village dots (2.5 km value-noise lattice) × clusters of settled land (30 km lattice). Where pixels are larger than about 1.5 km the dots fade to their mean, so orbit views show clustered glow, not a uniform wash. Paved roads glow faintly.
- **Roads at altitude.** Coarse road lists (meshes at levels 4–6, roughly 20–200 km up) now hold every road, not only those at least 12 m wide; minor and feeder roads used to vanish there, which made the network look sparse.
  - The habitability map reaches the shader as an R8 cube-face array texture (`render/infra/habitabilityTexture.ts`).
- **Local lanes and villages (render-only).** Even 2,000 settlements leave one per 1,900 km², a road every 20–30 km. Near the camera (pixels under 400 m), the terrain shader adds a procedural layer: a seed per 4 km cell of a 3D lattice (cells within a thin shell around the sphere, seeds projected onto it), kept as a village where its hash falls below the habitability rescaled so that 0.4 and up count as fully settled (raw habitability peaks near 0.6 and is under 0.1 on half the land); country lanes (5 m, dirt-brown) link each fragment's nearest village to about three quarters of its lattice neighbors; each village has a small light (350 m) that replaces the rural speckle up close. The simulation never sees these; they are scenery, like the render-detail noise.
- **Roads by day** are drawn at least 1.4 pixels wide with legibility 0.65 (was 1.2 and 0.45).
- `GENERATOR_VERSION` is 6.

**Reason:** On Earth, lights trace population density: dense webs of towns and roads, not a few hundred dots. A coarse 6 km grid cannot hold every village road, so the data carries a few thousand settlements and their feeder roads, and the shader fills in the rest from habitability.

### 67. Simulation core: one queue for events and ticks; the worker owns the clock

**Date:** 2026-11-10
**Decision:** Milestone 6's simulation core (`src/sim/`):

- **One queue.** Discrete events and fixed-tick processes share one priority queue (`scheduler.ts`), ordered by (game time, priority, insertion sequence). Ticks sort before events at equal times, processes in registration order, events in scheduling order. Tick times are `offset + k · period` for integer k, so they never drift.
- **Events are data.** An event is a kind, a structured-cloneable payload and an optional flag, dispatched to one handler per kind. Pending events can be hashed, inspected and later saved; closures could not.
- **Acceleration-independent.** `Simulation.advanceTo(t)` runs every entry with time ≤ t at its own time and then sets the clock to t. Nothing reads the size of the step, so the state at a game time is the same at 1× and 256× and after one jump. `Simulation.hash()` covers the clock, counters, pending queue and each process's state; tests compare it across rates.
- **Rates** are pause, 1×, 4×, 16×, 64× and 256× (`TIME_RATES`). Each worker step covers at most 0.25 s of real time, so a stalled tab does not leap ahead.
- **Auto-slowdown.** A flagged event stops `advanceTo` right after it runs, and the host drops the rate to 1×. Milestone 6 has only player test alarms (GUI → Time); mission subscriptions arrive in milestone 7.
- **Seek.** Jumping forward runs everything on the way. Jumping backward rebuilds the simulation from campaign start and replays to the target: the state is a deterministic function of seed and time, so the result equals a straight run. The GUI's day and time-of-day sliders seek (the M3 preview clock could scrub freely; scrubbing now costs a replay, about 6 ms per game hour for the weather).
- **Worker host.** The sim worker owns the clock: a 30 Hz timer steps `SimHost` by the elapsed real time and posts a snapshot (a transferred Float64Array header) when anything changed, plus each new weather frame once (transferred Float32Array). The main thread (`workers/simClient.ts`) extrapolates a smooth display time from the last snapshot, at most 0.1 s of real time ahead, and resets it after a seek or a slowdown.
- **Time bar** (`ui/timeControls.ts`): pause and the rates (Space, keys 1–5), the local date and time under the camera, time since campaign start, and the weather under the camera.

**Reason:** The design asks for analytic events plus fixed ticks with identical outcomes at 1× and 64×. One queue makes the interleaving exact by construction. Owning the clock in the worker keeps the main thread free to render and prepares for heavier sim loads in milestones 7 and 8.

### 68. Weather: synoptic systems on a coarse bordered cube grid; clouds from the weather

**Date:** 2026-11-10
**Decision:** This implements decision 15's weather and replaces decision 59's climate-driven cloud field.

- **Grid.** 24 × 24 samples per cube face (about 65 km) plus a one-sample border that lies across each seam (`sim/weather/grid.ts`). Fields are evaluated at every sample's own direction, border included, so bilinear interpolation inside one face is continuous across seams. The GPU samples the same layout as a 26² × 6 array texture.
- **Climate input.** The main thread averages the tectonic maps over each sample's footprint (temperature, seasonal range, wetness from precipitation, land fraction, ground height, reference-terrain slope, the climate stage's prevailing wind) and transfers them to the worker. The weather is execution-layer code (rule 9 restricts planning only), but it takes plain arrays, so the sim does not import worldgen.
- **State: synoptic systems.** Mid-latitude lows (about 5–6 at a time, radius 280–460 km, −1.2 to −2.8 kPa), subtropical highs (about 4) and tropical lows (about 1, over warm sea in the warm season, weakening over land). Each game hour the weather process (a 1 h tick) spawns from a per-hour fork `rng(seed, "weather").fork("h<k>")`, moves systems with the steering wind (about 0.7 × the 500 hPa wind for lows, with a slow poleward drift scaled to the small planet), and ages them through a grow-and-fill envelope. 120 hours run before campaign start, so the first weather is mature.
- **Fields** are a pure function of the systems, the climate and the clock, per sample and hour (`model.ts`): sea-level pressure; wind at 10 m and about 850, 500 and 250 hPa (climate surface wind + a jet that peaks near 35° and strengthens in winter + circulation around each system, cyclonic around lows, turning inward near the ground); a humidity proxy from wetness, lift in lows and along a spiral frontal band, sinking in highs, upslope wind, afternoon convection over warm land and slowly evolving noise; then cloud cover, cloud base, precipitation and snow fraction, visibility (haze, rain, snow, fog on calm humid nights) and temperature (annual mean, season, diurnal cycle damped by cloud). The fields are computed lazily, only for the two hours that bracket the clock (about 6 ms per hour).
- **Queries.** `WeatherView` interpolates two hourly frames in time and bilinearly in space and answers `report(dir, t)` (cover, cloud base, ceiling where cover ≥ 5/8, visibility, precipitation, temperature, pressure) and `wind(dir, altitude, t)`. The sim and the main thread use the same class; milestone 7's tasking reads ceilings, visibility and winds aloft from it.
- **Clouds.** The cloud shell's coverage now comes from the sim (`render/clouds/weatherTexture.ts`): the weather texture holds two frames' cover and precipitation and blends them through the hour. A finer detail field (150 km systems, 17 km cells, rigidly turning in two latitude bands as in decision 59) decides where inside each weather cell the cloud sits: a fragment is cloudy where the detail value is below the cover fraction, so mean coverage matches the weather. Precipitating cloud is darker. The climate texture's cloudiness channel is no longer used by clouds.
- **Statistics** (seed 1983, 60 days, `tools/weather.preview.ts`): mean cover 34%, precipitation over 7% of the surface, ceilings under 300 m or visibility under 1.6 km over 5%; every place is mostly clear at least 9% of the time, the median place 57%; surface winds up to about 40 m/s in tropical lows, jet up to about 60 m/s.

**Reason:** A system-based model is cheap (a few ms per game hour), deterministic by construction, easy to hash and replay, and produces what flight operations need: fronts and lows with low ceilings and rain, clear highs, winds aloft and seasonal snow. Evaluating fields from the systems rather than advecting moisture on the grid avoids numerical diffusion and seam handling on the cube. Clouds drawn from the same fields keep what the player sees consistent with what cancels missions.

### 69. Rendering performance: GPU choice, tight tile bounds, baked cloud coverage, shared lighting, adaptive resolution

**Date:** 2026-11-11
**Decision:** After milestone 6 the owner measured 1–2 frames per second on a laptop with an RTX 5090 once generation had finished. The headless renderer on a software Vulkan adapter (lavapipe) and V8 profiles of `scene.render` found five causes and two follow-on problems, fixed below.

- **The wrong GPU.** Three's backend requested its own adapter with no power preference, so on a laptop with an integrated and a discrete GPU the browser could hand out the integrated one, although the startup probe had asked for `high-performance`. The app now creates the device itself on the probed adapter (all its limits raised as before, every standard feature requested) and passes it to `WebGPURenderer`. GUI → Status → Backend names the adapter (vendor, architecture), and the console logs it.
- **Tile bounds reached the tallest peak on the planet.** A tile's bounding sphere spanned from the sphere to the highest exaggerated terrain anywhere (about 40 km at 10×). A camera below that height sat inside every nearby tile's bounds, so their distance clamped to 1 m and they all split to level 10: about 2,400 terrain draws at 1080p at 20–50 km altitude, the heights where the map is used. Built tiles are now bounded by their own displayed height range (from their mesh, including the parent surface they morph toward); tiles without a mesh keep the planet-wide range. The same views draw 250–450 tiles. The horizon test uses each tile's own top as well. Bounds are cached per tile across frames. The selection now picks the detail the screen-space error metric intends; the over-refinement was a bug, not a quality setting. GUI → View → Terrain tiles → Detail still trades detail for speed.
- **Cloud shadows evaluated the cloud field six times per fragment.** Every `shadeDiffuse` and `sunlightAt` call built its own cloud-shadow subgraph: two rotated fields of two four-octave fractal noises each. The terrain shades land, water body, ice, glint, roads and lanes, so a terrain fragment evaluated 96 noise octaves for shadows alone. Two changes:
  - **Baked coverage** (`render/clouds/coverageBake.ts`): a compute pass evaluates coverage and precipitation into an atlas of the six cube faces (768² texels per face, about 2 km, with a one-texel border across each seam as in decision 68; RGBA8). Shadows read one texel. The bake reruns when the game clock has moved 30 s (the clouds move about 12 m/s, so 0.2 texel), when the weather frames or cloud settings change, and at most every 100 ms of real time. The cloud shell evaluates the field itself only below 40 km camera altitude, where 2 km texels would look soft; above, it reads the bake too.
  - **Shared light** (`PlanetLighting.at`): sunlight after the atmosphere and clouds, and sky irradiance, are built once per fragment and passed to every `shadeDiffuse` call of the terrain, water, roads and lanes.
- **Work for layers that do not show.** The terrain fragment ran the water body, waves, glint and foam on dry land, and the night-light loop, rural speckle and village lights by day. Water now runs inside a branch on the wet fraction, lights inside a branch on night × dry land × the lights setting, the road and lane loops only on dry land, and the river loop only above the sea. Everything that takes screen-space derivatives (footprints, coast and lake antialiasing) is computed first, outside the branches, because WGSL allows derivatives only in uniform control flow.
- **Pixels.** A 4K laptop panel at a device pixel ratio of 1.5–2 shades three to four times the pixels of 1080p. `RenderScaleController` (`render/renderScale.ts`) adapts the canvas resolution to the frame time: it smooths frame times, lowers the scale by √(target / measured) when frames run 10% over the target, raises it by 10% after 2 s under 70% of the target, in 5% steps between 35% and 100% of the device pixel ratio. GUI → View → Render scale picks auto (default) or a fixed scale; Target FPS sets the goal (30 by default). Status → Resolution shows the drawing-buffer size. Terrain LOD is measured in CSS pixels, so the scale does not change which tiles are drawn.
- **Trees and buildings request their own data.** They used to read only the level-7 data tiles the terrain had loaded. With tight bounds the terrain draws some areas within tree and building range from coarser tiles, so those layers now ask for missing data tiles themselves (`TerrainRenderer.requestDataTile`, at a priority below the terrain's own). The request queue now collects from one terrain update to the next, so requests made after the terrain's update in a frame are served in the following one.
- **Clear skies were not clear.** The cloud coverage clamped its detail threshold to 0.02–0.98 against a ±0.1 blend window, so zero weather cover still drew about 3% cloud, in large patches where the detail field saturated, and full cover never reached 100%. The cover is now stretched by the window (`1.2 · cover − 0.1`): 0 is clear, 1 is overcast, 0.5 is unchanged. The GPU cloud test (never run on a GPU before) caught this.

Measured on lavapipe at 512 × 288 (ratios only; a software rasterizer is about two orders of magnitude slower than a desktop GPU): the orbit view went from 125 to 42 ms per frame, oblique (20 km) from 460 to 230, coast (80 km) from 750 to 220, roads (60 km) from 660 to 190, night from 440 to 93. The tile-bounds fix comes on top of that in views below the tallest exaggerated peak, and cuts CPU time per frame there by about the same factor as the draw count (three's WebGPU backend spends about 25–30 µs of CPU per draw).

**Reason:** The terrain material is one large fragment shader, so its cost multiplies by every pixel and every redundant subgraph. Caching what changes slowly (cloud coverage over game time, tile bounds over frames), computing shared terms once, and skipping layers that contribute nothing keeps the look unchanged while removing most of the work. Adaptive resolution then absorbs what remains on any GPU.

### 70. Visual style guide; reference board stays local; models from JSON specs

**Date:** 2026-11-11
**Decision:** `docs/visual-style.md` (revision 1, from the owner) is binding for all rendering, models and UI (CLAUDE.md rule 11).

- **Acceptance checks gate visual milestones.** A milestone with rendering, model or UI work closes only after the guide's seven acceptance views are captured and compared with the reference board. Checks 1–6 become named views in `tools/render.preview.ts`; check 7, the silhouette test, runs in the model viewer.
- **The reference board is local only.** The five screenshots in `docs/style/references/` come from another project and the repository is public, so `.gitignore` excludes them (only the folder's README is tracked) and they sync through the owner's Dropbox. They also stay out of the build: Vite bundles only what `index.html` imports, there is no `public/` folder, Pages deploys `dist/` from a git checkout, and a `vite.config.ts` plugin refuses to load any module under `docs/`.
- **Models from JSON specs.** Aircraft, vehicles, ships, buildings and trees will be built in code from small JSON specs (cross-section lofts, extruded planforms, primitives, face groups, camouflage schemes) by a procedural builder, with a debug model-viewer page (milestone 7). The tree kit replaces the milestone 3 clump trees and comes with the guide's LOD bands (milestone 9).
- **Existing rendering predates the guide.** Smooth-shaded terrain, triplanar cliffs and clump trees from milestones 3 and 5 differ from it. A style audit before checkpoint 6 lists each gap as a task rather than reworking everything at once.
- `docs/visual-style.md` is in `.prettierignore`, like `docs/design.md`.

**Reason:** One documented look keeps every session's rendering work consistent, and the acceptance views make "done" checkable without a browser. The screenshots are not ours to publish. Spec-built models suit the low-poly style, stay reviewable as text and make new fictional types cheap.

### 71. Strategic view draws forests and towns as patches; road network through villages

**Date:** 2026-11-11
**Decision:** After the owner's review (30 fps typical, roads that look like disconnected stars), the strategic view shows the big picture and leaves individual trees and buildings to the simulator.

- **Forests as canopy masses.** The tile meshes carry forest density per vertex (fourth component of the `surface` attribute), and the vertex color no longer blends in the canopy. `LandShading` thresholds the interpolated density per fragment (`forestThreshold` 0.42, ±0.03, edge broken by the detail noise), so forests read as dark masses with crisp edges along the density contour, not along mesh triangles. Canopy shades come from `docs/visual-style.md`: conifer `#2C4434` below about 3–9 °C annual mean, broadleaf `#3B5A33`, rainforest `#2E5A2E` above 18–24 °C, with a ±18% value shift. Evergreen canopy skips autumn browning and keeps most of its dark color under snow. Open ground in forest biomes uses the guide's grassland and pasture shades, so clearings read as fields.
- **Towns as built-up patches.** The light records gain a built-up radius (the urban radius) and kind (town or industry) in their spare floats. One loop over the tiered light lists now returns town cover, industry cover and night emission, so the patches cost no extra lists, and night does not loop twice. Patches are disks with an edge broken by 2 km value noise, at least 1.2 pixels wide (cover thinned by the area ratio), colored as 70 m blocks of the guide's roof and wall colors that fade to their mean at range; industry is concrete.
- **Trees and buildings off by default.** `ForestLayer` and `StructureLayer` stay in the code for the simulator but start disabled (GUI → Tiles: "Trees (sim detail)", "Buildings (sim detail)"; `DETAIL=1` in `tools/render.preview.ts`). The tree-kit and tree-LOD tasks from decision 70 now belong to the simulator views.
- **Procedural lanes removed.** The render-only country lanes of decision 66 produced the stars: each fragment decided whether a lattice seed was a village from the habitability at the fragment, not at the seed, so neighboring pixels disagreed and lanes stopped midway; it searched lattice neighbors around the fragment rather than around its village, so lanes were drawn on one side only; and lanes linked villages only to each other, never to the road network. The village lights near the camera went with them; the rural speckle covers the countryside at night.
- **Local roads through villages.** In the data, about 940 of the ~1,000 road dead ends per world were villages at the end of a one-cell feeder spur, invisible from altitude. Now every settlement also links to its Gabriel-graph neighbors up to `LOCAL_LINK` (70 km) on the same landmass, routed after the trunk links with the same A* and road reuse, and dropped if the route costs more than 2.5 × the link length. A feeder then joins every road component without a trunk settlement to the trunk network (or failing that, to any road). Seeds 1–3: dead ends from ~1,010 to ~640 (all at settlements or bases), settlements without a road from ~225 to ~45, road cells +24%, road time from ~0.45 to ~0.75 s per world. `GENERATOR_VERSION` is 7.
- **Road color** follows the guide (`#7A7062`) instead of near-black asphalt.

**Reason:** At strategic altitudes, individual trees and buildings cost frame time and add noise without information; the guide's own LOD bands already reduce forests to terrain color beyond 5 km. Patches make every road end at a visible place, and short local links make villages sit on roads that continue, as on real maps.

### 72. Two views: an illustrated strategic map and a simulation view (Proposal 0001)

**Date:** 2026-11-11
**Decision:** The owner's Proposal 0001 (`docs/proposals/0001-two-views.md`) is accepted with one amendment. Bearing gets two views of the same world, each with its own renderer and visual language:

- The **strategic view** is an illustrated globe from about 3,000 km down to a zoom floor of about 100 km. It has 4× relief, a cartographic hillshade, painted biomes with patterns, glyphs, a road hierarchy, named geography with labels, and the military overlays.
- The **simulation view** covers 0 to about 20 km in the low-poly style, with terrain only within the horizon, and is entered through a unit.
- A transition of under two seconds joins them.
- **The roadmap changes.** Milestones M1–M9 become F1–F2, S1–S4, C1–C3, V1–V4 and I1. `docs/design.md` (revision 7) holds the roadmap and the mapping from old to new, `TODO.md` follows it, and earlier entries that cite milestone numbers keep them as history. `docs/visual-style.md` (revision 2) splits into Part I (simulation view) and Part II (strategic view). Part I's acceptance checks are renumbered 1–6 (the old checks 2–7), and Part II has five strategic checks, the first replacing the old orbit check.

The owner's amendment and the engineering calls made while adopting it:

- **Day, night and weather stay on the map (owner).** Planning sorties needs them, so the strategic view always shows a terminator, a legible night side with settlement lights, seasonal snow and ice, and stylized clouds and precipitation from the live weather. They are not the optional overlays the proposal describes. Only the relief hillshade uses the fixed upper-left light.
- **Graph types stay in `worldgen/strategic/`.** Named-feature, road-class and rail types are graph types, so rule 9's lint keeps holding. Campaign code may import only `worldgen/strategic/`. Extraction and naming code may live in `worldgen/geography/` and `worldgen/names/`, called by the graph builder.
- **No `worldgen/infrastructure/`.** Settlements, roads, bridges, airbases and sites stay in `worldgen/strategic/` (decisions 52, 65). The proposal's `worldgen/infrastructure/` means infrastructure work inside that folder until a later decision splits it.
- **No code moves yet.** The `render/common/`, `render/sim/` and `render/strategic/` split is the first S1 task. The existing `render/strategic/strategicOverlay.ts` is the graph debug overlay.
- **A debug free camera stays.** It is for development only and remains until V4 provides entry through units, because render previews and owner checks need low views before units exist. The proposal's "no free camera" applies to the player.
- **The promotion bubble.** Decision 49's bubble "around the camera" now means the simulation view's camera.

**Reason:**

- _Clarity:_ a map that abstracts, exaggerates and labels answers strategic questions at a glance.
- _Risk:_ one renderer that zooms continuously from orbit to 500 m was the hardest rendering problem in the project. The split bounds each renderer: the map never goes below its floor, and the simulation view never goes above the aircraft ceiling, so terrain within 200 km bounds streaming, LOD depth and memory.
- _Identity:_ the map is where the player plans, and the cockpit is where they fly.
- The amendment comes from the owner: night and weather decide which sorties fly, so the planning view must show them.

### 73. Render layout: `common/`, `sim/` and `strategic/`

**Date:** 2026-11-11
**Decision:** `src/render/` is split by view, as decision 72 planned, with no behavior change:

- **`common/`** holds what both views use: `cameraRelative.ts` (new), `palette.ts`, `climateTexture.ts`, `renderScale.ts`, `cubeSphereGeometry.ts`, `webgpuSupport.ts` and `computeSmokeTest.ts`. The climate texture is common because the strategic base map will color biomes and snow from it; the palette is common because both palettes derive from the same biome table.
- **`sim/`** holds `GlobeScene`, `OrbitCamera`, the M1 cell-grid debug globe (`globeMesh.ts`, `cellColors.ts`) and the folders `terrain/`, `atmosphere/`, `water/`, `clouds/`, `forest/`, `infra/` and `lighting/`. `GlobeScene` keeps drawing orbit to ground until `StrategicScene` takes over the upper envelope.
- **`strategic/`** keeps the graph debug overlay for now.
- **Camera-relative placement goes through two helpers**, `placeCameraRelative(object, world, eye)` and `placePlanetCentered(object, eye)`, which subtract in float64 before the float32 write. The six hand-written subtractions in the scene, terrain, forest, structure, cloud and overlay code now call them, so the new strategic scene follows rule 4 by construction.
- Earlier decisions keep the old paths as history.

**Reason:** The strategic view needs a home that does not import the simulation view's atmosphere or LOD code, and a shared helper keeps rule 4 in one place instead of six.

### 74. StrategicScene skeleton beside GlobeScene; the active view takes input

**Date:** 2026-11-11
**Decision:** `render/strategic/strategicScene.ts` adds the strategic view's own scene and camera (the first step of S1):

- **Both scenes stay resident** (design, Architecture). The app renders only the active one, chosen with GUI → View → View (`simulation` or `strategic`; `?view=strategic` opens the map). Switching keeps the camera's latitude, longitude and heading, so the new view opens over the same place. Only the active view's camera listens to mouse, touch and keyboard: both scenes now have an `inputEnabled` switch.
- **The strategic scene builds lazily.** It stores the world and builds its globe on its first rendered frame, so a hidden map costs no CPU time per regeneration.
- **Placeholders until the base-map tasks.** The base map is the F1 cell-grid globe at the guide's 4× relief (`STRATEGIC_EXAGGERATION`), lit by a scene light fixed at the screen's upper left plus ambient light, over a flat `#1E2630` background with no atmosphere. The camera is the orbit camera with `STRATEGIC_ORBIT_LIMITS`: altitude between `STRATEGIC_FLOOR` (100 km) and `STRATEGIC_CEILING` (3,000 km), tilt up to 50°. The strategic camera task replaces it with the altitude-driven tilt curve. The strategic scene has its own graph debug overlay, toggled with the simulation view's.
- **`orbitCamera.ts`, `globeMesh.ts` and `cellColors.ts` move to `render/common/`**, amending decision 73: both views use the orbit camera and the cell-grid globe's debug color modes, and `strategic/` must not import from `sim/`.
- **Previews.** `SCENE=strategic` in `tools/render.preview.ts` draws the strategic scene from the views at or above the floor (orbit, limb, terminator, winter, night) to `render-<seed>-strategic-<view>.png`. `tests/gpu/strategicScene.test.ts` renders it on Dawn at the ceiling and the floor.

**Reason:** The base-map, camera and zoom-band tasks need a scene of their own to land in, without disturbing the simulation view the owner checks today. Building on the existing globe and camera keeps this step small and lets each later S1 task replace one placeholder.

### 75. Strategic camera: a focus point, with tilt that follows the altitude

**Date:** 2026-11-11
**Decision:** `render/strategic/strategicCamera.ts` replaces decision 74's clamped orbit camera in the strategic view:

- **Focus point.** The camera orbits a focus on the sea-level sphere, which stays at the screen center, at an eye altitude between `STRATEGIC_FLOOR` (100 km) and `STRATEGIC_CEILING` (3,000 km). Zoom changes the altitude and panning moves the focus. The eye sits at range ρ from the focus along the tilted vertical, with ρ = −R cos t + √(R² cos² t + h² + 2Rh), so its altitude is exactly h at any tilt.
- **Tilt follows the altitude.** `strategicTilt` is 0 at and above `STRATEGIC_TILT_START` (1,500 km, the Globe band's lower edge) and 50° at the floor, with a smoothstep in log altitude in between (half the tilt at about 390 km). There is no manual tilt. Right drag turns the heading and its vertical part does nothing; three-finger drags do nothing. One-finger drag, two-finger pan, pinch and twist (decision 60), the wheel, W/A/S/D, Q/E and R/F work as in the orbit camera. Panning speed and drag scale follow the range to the focus, with the drag along the screen divided by cos t for foreshortening.
- **Shared input.** `attachOrbitInput` now drives a `CameraControls` interface, which both cameras implement.
- **Horizon at the floor.** At 100 km and 50° tilt on the 1,000 km planet, the top of a 45° frame sits about 1° below the horizon, so the ground fills a landscape window. A unit test guards this. A taller field of view or a lower floor would show space above the horizon.

**Reason:** Part II asks for a camera that looks straight down at globe scale and pitches toward the floor. Deriving the tilt from altitude gives every player the same readable view at each zoom, and keeps the horizon out of the frame on a small planet. Orbiting a focus keeps the point the player zooms into at the center, as map apps do.

### 76. Zoom bands: hysteresis on the edges, timed fades as uniforms

**Date:** 2026-11-11
**Decision:** `render/strategic/zoomBands.ts` picks the strategic view's zoom band from the camera altitude:

- **Edges.** Globe at and above 1,500 km, Theater from 400 km up to 1,500 km, Region below 400 km (Part II). The Globe edge is also where the camera starts to tilt (decision 75).
- **Hysteresis.** The band changes only once the altitude clears an edge by 8% in the direction of travel: from Globe the view goes to Theater below about 1,389 km, and back to Globe above 1,620 km. A jump across several bands lands in the band whose edges it has cleared by the margin.
- **Fades by time, not by altitude.** Each band has a fade factor that ramps linearly toward 1 while the band is active and toward 0 otherwise over 0.35 s of real time, eased with a smoothstep. Content of a band multiplies its opacity by its factor, so a band change is a short crossfade, as the guide asks. A step with dt = 0 snaps the fades, so headless previews show the settled state.
- **Interfaces.** `StrategicScene.bands` exposes the band and an `onChange(band, previous)` event; label placement and band content tables (S2) will run on it. `StrategicScene.bandFade.{globe,theater,region}` are TSL uniforms with the eased factors for shaders. GUI → Status → Zoom band shows the band, and the console logs each change.

**Reason:** Fading by altitude alone would leave content half-visible while the camera rests between bands, and a hard edge would make labels pop when the camera eases across it. A margin plus a short timed crossfade gives one clear band at any rest altitude and smooth transitions, and the change event gives the label engine one moment to re-place labels.

### 77. Strategic relief mesh: the terrain tiles capped at level 6

**Date:** 2026-11-11
**Decision:** `render/strategic/strategicRelief.ts` draws the map's relief from the same tiles as the simulation view's terrain (decision 13), once the world's global pass exists. Before that, the cell-grid globe stands in, also at 4×.

- **Reuse.** Tile selection is `selectTiles` from `sim/terrain/quadtree.ts` and meshes come from `buildTileMesh` in `sim/terrain/tileMesh.ts`, with data from the world's `TileSynthesizer`. Geomorphing works as in the terrain renderer. Exaggeration is a uniform, `STRATEGIC_EXAGGERATION` = 4, applied in the vertex shader, so changing it rebuilds nothing.
- **Level cap 6.** Vertices sit about 380 m apart on the 1,000 km planet. Measured with the CPU selection (`tests/strategicRelief.test.ts`, 16:9, 45° field of view, screen-space error 2 px, every tile ready): 16 tiles at the 3,000 km ceiling, 32 at 1,500 km, 50 at 800 km, 70 at 400 km, 62 at 200 km and 74 at the 100 km floor, where the selection reaches level 6 on its own at 1,080 CSS pixels. At 2,160 CSS pixels (a 4K monitor at pixel ratio 1) the cap holds the floor to about 150 tiles. All levels up to 7 are baked, so no map tile needs render detail noise.
- **Own caches.** The map keeps its own data (80 MiB) and mesh (120 MiB) caches. Only the active view loads and builds tiles. The synthesizer allocates its buffers per batch, so the two views' loaders can overlap safely after a switch. Sharing the data cache, or extracting the common selection, build and eviction loop from `TerrainRenderer`, is a TODO.
- **Placeholder shading.** Lambert from the scene's upper-left relief light plus ambient on the tiles' vertex colors, and one flat water color (`#6C97AC`) at sea and in lakes. The hillshade, palette and water tasks of S1 replace it.
- **Frame time** has to be measured on a GPU. GUI → Status → Tiles shows the map's tile count in the strategic view, and `SCENE=strategic` in `tools/render.preview.ts` prints tiles and milliseconds per frame for each view, including a new `floor` view (100 km, 50° tilt).

**Reason:** The terrain tiles already give seam-free, geomorphed, cached relief at any level, so the map needs only a cap and its own material. Level 6 is where the selection settles at the floor on a 1080p screen. Going deeper would cost tiles without detail a 4× illustrated map shows.

### 78. Cartographic hillshade per fragment, relative to flat ground

**Date:** 2026-11-11
**Decision:** The strategic relief is shaded by `render/strategic/hillshade.ts`:

- **Light.** The light comes from the screen's upper left at 45° above the local ground, at every point of the globe. Its horizontal part is the screen's up-left direction projected onto the tangent plane there. The scene sets the camera's screen right and up as uniforms each frame. A single fixed light direction would darken the globe toward the limb and change the look of flat land with position.
- **Relative to flat.** The factor is n·L / sin(elevation), blended from 1 by `strength` and clamped between `ambient` (0.3, the shadow floor) and 1.35. Flat ground is exactly 1 and keeps its palette color anywhere. Slopes facing the light brighten and slopes facing away darken.
- **Default strength 1.5.** The owner found the first relief subtle. At 4×, a typical steep slope of the quadtree's model (5%) is about 11°, which shades about ±18% at strength 1 and about ±25% at 1.5.
- **Per fragment, not baked.** The shading is one dot product on the interpolated 4× normals. The light turns with the camera every frame, so a bake would be invalid after every heading change. The cell-grid fallback globe keeps a scene light from the upper left.
- **Tuning.** GUI → Map (strategic view) has Relief exaggeration, Hillshade strength, Light elevation and Shadow floor, all uniforms, so tuning rebuilds nothing on the relief.
- There is no physical sky, aerial perspective or sun lighting in this scene. Day and night come later as their own map treatment (Part II).

**Reason:** Cartographic hillshades (Imhof; the 315°, 45° convention of GIS tools) shade relief relative to a flat plane so that the map's colors stay true and only form reads as light and shadow. Doing it per point on a sphere keeps that property at globe scale.

### 79. Strategic biome palette from a blended fill texture; owner's hillshade defaults

**Date:** 2026-11-11
**Decision:** The strategic relief takes its land colors from `render/strategic/biomeFill.ts`:

- **Fills.** Each biome maps to a Part II fill. Taiga takes conifer; temperate forest and tropical seasonal forest take temperate forest; temperate and tropical rainforest take rainforest; hot and cold desert take desert; alpine takes steep rock; ice sheet takes snow and ice. Shrubland has no row in the guide and takes the midpoint of grassland and savanna (`#B3B27B`). Sea biomes have no fill. The guide's farmland, wetland and urban rows wait for data that marks them.
- **Blend.** A cube-face texture array (half-float, linear RGB) at half the global grid's resolution, two cells per texel (about 3 km at 1024²), holds each texel's land-weighted mean fill. A 3 × 3 tent filter within each face widens the blend to about 9 km, and the shader samples it bilinearly by direction. Sea cells carry no weight, so coasts keep their land color, and four dilation passes carry land colors out to sea so bilinear filtering never mixes in a sea color. The filter does not cross cube seams; at 9 km the fills are smooth enough that the step there is slight. The texture costs about 12 MB at 1024².
- **Steep rock.** The shader blends in the steep-rock fill where the displayed (4×) slope rises from tan 0.6 to 1.0 (31° to 45°).
- **Per-vertex colors** stay for the debug color modes (height, tile level, borders, forest).
- **Hillshade defaults** (amending decision 78, after the owner's tuning in the browser): strength 2 and light elevation 20°. The low light lengthens the shading on gentle slopes; the clamp at 1.35 caps lit faces.

**Reason:** The tiles store one biome per sample from the global grid, so per-vertex colors step at the 1.5 km cell size and blur only by vertex interpolation, which changes with the tile level. A fill texture sampled by direction gives the same blended boundary at every zoom, and costs one texture fetch per fragment.

### 80. Map patterns: anchored to the ground, sized on screen; forest stipple and farmland

**Date:** 2026-11-11
**Decision:** `render/strategic/patterns.ts` is the pattern framework of the strategic map:

- **Screen-stable, not screen-space.** A pattern lives in world coordinates, so it never swims while the camera pans. Each fragment estimates its pixel footprint f (meters per pixel, from `fwidth` of the world position), wants a period of `targetPx · f`, and draws the pattern at the power of two of 1 m below that and at twice it, crossfaded by the fraction in between. The two periods lie within half and twice the target on screen at any zoom and tilt, and moving between powers of two is a smooth fade. Edges are antialiased over one pixel of footprint. This meets the guide's "same at every zoom within a band" within each band and across them; bands then choose which patterns show.
- **Coordinates.** The two world axes across the point's dominant radial axis, in meters, so patterns step slightly along the cube's edges. Planet positions come from camera-relative positions plus the eye (a uniform); at map footprints of 50 m and more, float32 precision is ample.
- **Forest stipple.** Jittered dots, one per cell, spaced about 7 px with a radius of 0.24 of the spacing, at every band. They cover forest where the tiles' forest density rises from 0.35 to 0.65. Dots are the fill color times 0.58 in linear light: Part II's three stipple colors are each about 0.78 of their fill in sRGB.
- **Farmland.** Where the strategic graph's habitability rises from 0.25 to 0.45, in farmable biomes, outside forest and off steep slopes, the fill becomes Part II farmland (`#C9B57A`). Farmable biomes are temperate grassland, temperate forest, shrubland, savanna and tropical seasonal forest; the biome fill texture carries their blended share in its alpha channel. Fields get the grid (`#B3A066`, 1 px lines, about 16 px fields) from the Theater band down, faded in by the band fades. This answers decision 79's open farmland row from data the map already has; S4's urban extents and settlements may refine it.
- **Shared tile code moves to `render/common/`.** `quadtree.ts`, `tileMesh.ts` and `tileCache.ts` move to `render/common/terrain/` and `habitabilityTexture.ts` to `render/common/`, since both views use them. This restores decision 74's rule that `strategic/` imports nothing from `sim/`, which decision 77's reuse had broken.
- **Toggle.** GUI → Map (strategic view) → Patterns turns stipple and farmland off for comparison.

**Reason:** Purely screen-space patterns would slide over the terrain while panning, and purely world-space ones would shrink to noise or grow to blobs with zoom. Choosing the period per fragment from its footprint gives both: anchored marks at a constant apparent size, as on printed maps redrawn for each scale.

### 81. The remaining map patterns, with biome masks and per-pattern branches

**Date:** 2026-11-11
**Decision:** `render/strategic/patterns.ts` adds the rest of Part II's patterns on decision 80's screen-stable scheme:

- **Shapes.** Steep-rock hatching: diagonal one-pixel lines every 5 px, Part II `#7E766D`, wherever the steep-rock blend is on. Dune ripples: parallel lines every 9 px, wobbling sideways by 0.15 of the spacing, `#C9AA7A`. Tundra tussocks: dots of radius 0.2 of a 7 px spacing in 55% of cells, `#99957C`. Ice-cap cracks: one-pixel lines along the edges of jittered cells about 28 px across, measured as the exact distance to the bisector between the nearest cell point and each neighbor, `#C9D3D8`. Wetland reeds: short horizontal dashes every 10 px in 70% of cells, `#6F8366`. Lines whose periods nest (hatching) fade by dropping the finer lines; the rest crossfade between the two periods.
- **Masks.** A second cube-face texture (RGBA8, blended and dilated like the fills by the same routine) holds the share of hot desert, tundra, ice sheet and wetland per texel. Only hot deserts get ripples: Part II asks for them on sand deserts, and cold deserts are mostly gravel and rock. The wetland channel is 0, since the world has no wetland biome; the reeds and the wetland fill wait for data that marks wetlands (TODO).
- **Branches.** Each pattern runs inside a branch on its own mask. The pixel footprint is computed first, in uniform control flow, and no pattern takes derivatives, so the branches are safe. A pixel pays only for the patterns present there; the cracks, with their 34 cell lookups per period, run only on ice caps.
- **Check.** The CPU references of all seven patterns were drawn to a test image before the shader was wired. The first crack version, which used half the difference of the two nearest distances, left wedges at cell corners; the exact bisector distance replaced it.

**Reason:** These complete the base map's pattern set in one framework. Masks blended like the fills keep pattern edges as soft as the color edges, and branching keeps the most expensive patterns from costing anything outside their biomes.

### 82. Map water: three flat depth bands, a coastline from the coast distance, lakes alike

**Date:** 2026-11-11
**Decision:** `render/strategic/mapWater.ts` draws the strategic map's water:

- **Bands.** Shelf (`#8DB5C4`) above a reference depth of 200 m, mid-depth (`#6C97AC`) to 3,000 m, deep (`#4F7A93`) below. Reference depth is the depth before relief scaling (decision 14), so the bands match Earth's continental shelf and abyssal plains whatever `reliefScale` is. Each band edge is antialiased over one pixel of depth change (`fwidth`). Water stays flat: no hillshade.
- **Coastline.** A `#2F4756` line about 1.2 px wide where decision 39's coast distance (the per-vertex −h / |∇h| estimate, packed into the relief's `surface` attribute) crosses zero, measured in pixels by dividing by the fragment's footprint. The same distance antialiases the land–sea edge, which replaces the hard step on the interpolated height. Using the coast distance rather than the height keeps the line one pixel wide on steep and gentle coasts alike.
- **Lakes.** The signed lake depth (lake level − height, decision 40) gives the lake's edge, outline (measured in pixels with its own `fwidth`) and depth band, in the same colors.
- **Debug modes** keep the vertex colors, without water or outlines.
- The coastal halo and parallel coastal lines, and rivers, are the next S1 task.

**Reason:** Flat bands read as a printed chart and show where the shelf runs, which matters for naval operations later. A pixel-measured outline keeps the coast crisp at every zoom without any geometry.

### 83. Coastal halo and parallel coastal lines from a coast-distance field

**Date:** 2026-11-11
**Decision:** The strategic map's sea gets a lighter halo along coasts (`#B9D5DC`, fading out over the first 8 px) and three faint parallel lines (`#A9C9D4` at 70%, one pixel wide, 5, 10 and 16 px out), all measured in pixels from the coast:

- **Distance near the coast.** Within 2.5 km of the coast the per-vertex coast distance of decision 39 is used, so the halo and the first lines hug the fine tile coastline that the outline follows. Between 2.5 and 4.5 km it blends into the field below. That estimate is clamped at 5 km and is only good near the coast.
- **Distance farther out.** `render/strategic/coastDistance.ts` runs an exact Euclidean distance transform (Felzenszwalb and Huttenlocher) per cube face on the global height grid, with a margin read from the neighboring faces so distances agree across seams. It stores sea-to-land distance (capped at 60 km) as an R16F cube-face texture of up to 1024² per face, sampled bilinearly. The 16 px outer line lies about 50 km out at the ceiling and about 1.6 km out at the floor, so the field serves the Globe and Theater bands and the per-vertex distance serves the Region band.
- **Cost.** About 0.6 s on the main thread at 1024², computed on the map's first frame after a world loads, so the simulation view never pays it. Moving it into the worldgen worker is a TODO.
- **Lakes** get the outline (decision 82) but no halo or lines.

**Reason:** The halo and lines are what make a coast read as printed, but they need distances in screen pixels out to tens of kilometers at globe scale, beyond the reach of the per-vertex estimate. A distance field computed once per world gives that range, and the per-vertex estimate keeps the lines exact where they are close enough to the coast to show any error.

### 84. Map rivers: two segment tables by band, lines by discharge, wide rivers as water

**Date:** 2026-11-11
**Decision:** The strategic map draws rivers from the world's river segments (decision 46), with `render/strategic/mapRivers.ts`:

- **Tables.** `riverTables.ts` and `riverShading.ts` move to `render/common/water/`, and the table builder gains options for the coarse level, chord length, reach and whether to build fine lists. The map builds two tables on its first frame, alongside the coast field. Major rivers (at least 60 m wide, discharge above about 225 m³/s) go in chords of 64 segments (about 25 km) listed on level-1 tiles, for meshes of levels 1 to 3. Regional rivers (at least 15 m wide) go in chords of 8 segments (about 3 km) on level-4 tiles, for levels 4 to 6. Neither builds fine lists, so the build touches only chords. The material is rebuilt with the new buffers before any mesh of the world exists.
- **Lines.** Narrow rivers are `#5D8FB0` lines 1 px wide at 25 m, a pixel wider per fourfold width (two doublings of discharge, since width is 4·√Q), at most 3.5 px. The minimum keeps minor rivers continuous at a pixel, as the guide asks.
- **Wide rivers.** Once a river's true width passes about 4 px (fading in from 3 px), it is drawn at true width in the shelf-water color, with the 1.2 px dark outline at its banks, like lakes (decision 82).
- **Bands.** Rivers fade in with the Theater and Region bands (the same visibility as the field grid, now called `belowGlobe`); the Globe band shows none. The loop runs only on dry land, and only for the one table that matches the mesh's level.

**Reason:** Part II lists major rivers in the Theater band and minor rivers in the Region band. Two tables matched to the tile levels drawn in those bands keep each fragment's loop short: long chords for the few major rivers at continental scale, and finer chords for the many minor ones up close. Exact distances to the polylines keep lines crisp at any zoom, as for the coastline.

### 85. Coastal lines fixed to the ground; the footprint no longer depends on world axes

**Date:** 2026-11-11
**Decision:** Three fixes after the owner's browser check of decision 83, which showed square rings of coastal lines in the open ocean that moved with zoom, and coastal lines sliding while the camera orbited:

- **Unknown distance.** The coast-distance texture is capped, and the shader read the cap as a real distance. Wherever the cap divided by the pixel footprint came to 5, 10 or 16 px, a ring appeared. The halo and lines now fade out as the texture approaches its cap (75% to 95%), except within the per-vertex estimate's reach near the coast. The cap rises from 60 to 100 km.
- **Footprint.** `length(fwidth(position))` sums absolute derivatives per world axis, so its value depended on how the surface lies to the world axes. That turned the rings into diamonds and changed pattern sizes across the globe by up to 1.7×. The footprint is now the longer of the two screen-axis derivative lengths, which is independent of world axes.
- **Fixed to the ground.** The halo width and line offsets are now measured in `mapScale`, the map scale at the screen center (range × field of view / drawing-buffer height), one value per frame. They stay fixed to the ground while the camera orbits or pans, and respace only when it zooms. Each line stays one pixel wide through its own `fwidth`.
- **Sizes kept.** The old footprint read about 1.4× large on average, so every pattern and the coastal lines drew about 1.4× their nominal sizes, the look the owner approved. The nominal sizes are scaled by 1.4 to keep it: stipple 10 px, fields 22 px, hatching 7 px, dunes 12 px, tussocks 10 px, cracks 40 px, reeds 14 px, halo 11 px, lines at 7, 14 and 22 px. Rivers and the 1.2 px coastline keep their nominal sizes, so they draw a little thinner than before, at the guide's widths.

**Reason:** Printed maps fix their decoration to the paper, so it should not move under the reader's eye. A per-frame map scale gives that while keeping the lines evenly spaced on screen at each zoom.

### 86. The front generator's band cut avoids sin, cos and acos

**Date:** 2026-11-11
**Decision:** The CI-only determinism flake (TODO.md Known issues) was traced with stage-by-stage tests to the front generator. Two builds of one world in one process agreed on heights, biomes, discharge, nodes, settlements and roads, but not on the first barrier line's path. Each landmass's band is cut by sorting cells along a principal axis and thresholding at 20% and 80% of area, and the coast-to-coast path is searched inside that band. One cell crossing a threshold changes the band and the path, so a last-bit difference in a cell's axis coordinate is enough. That coordinate came from an azimuthal projection with `Math.acos`, `Math.cos` and `Math.sin`, and from a rotation by `cos` and `sin` of the principal angle. In recent V8, `sin` and `cos` have more than one implementation, which can differ in the last bit; which one runs can depend on the compilation tier, which depends on timing. That would fit a first build differing from a second only on some CPUs, though it could not be confirmed outside CI.

- The projection now uses dot products, `sqrt` and `atan2` (the angle as `atan2(r, z)` and the direction as `(x, y) / r`), and the rotation uses half-angle identities with `sqrt`. The math is the same, but each remaining operation is correctly rounded (`sqrt`) or is the `atan2` that `CubeGrid.angleBetween` and the road search already use without divergence.
- `GENERATOR_VERSION` becomes 8, since fronts may move slightly and cached worlds store the strategic graph.
- If the flake recurs, the next step is to quantize the axis coordinate before sorting.

**Reason:** Determinism is a project rule (rule 5), and a generator whose output turns on the last bit of a transcendental function breaks it in practice. Removing the sensitive calls from the one stage that amplifies them fixes the observed failure without slowing generation.

### 87. Day, night and seasons on the map

**Date:** 2026-11-11
**Decision:** The strategic relief shades day and night and the seasons (`render/strategic/mapDaylight.ts`), stylized, after the patterns, water and outlines:

- **Terminator.** With μ = n · sun from the ephemeris (the same sun as the simulation view), day blends into night across civil twilight, μ from −sin 6° to +sin 6°. The relief light stays the cartographic hillshade; the sun never lights the relief.
- **Night.** A multiply by Part II's night tint `#1B2A4A`, scaled to its brightest channel and set to 0.62 in sRGB, which gives a linear multiplier of about (0.04, 0.10, 0.34). The night side is deep blue at about a third of daylight's brightness in blue, so relief, coasts and outlines remain readable.
- **Twilight.** A warm tint (`#E3A06A` scaled to its brightest channel), at most 50%, peaking on the terminator with a Gaussian of about ±4°.
- **Seasons.** `render/common/seasons.ts` now holds the seasonal surface temperature both views use (lapse-rate corrected, the hemispheres half a year apart; the simulation view's `WARMEST_PHASE` moves there). The map draws snow on land below about 0 °C (thin where dry or steep), sea ice where the sea-level air temperature falls below −3 to −8 °C, and lake ice below −1.5 to −4 °C at the lake surface. Snow takes the snow fill `#F1F3F2`; sea ice `#E4ECF0`, a little bluer, since Part II names no sea-ice color. The sea-ice threshold sits below freezing because the climate's sea-level temperature is air temperature, and sea ice needs a sustained cold season.
- **Controls.** GUI → Map has Night and Twilight strengths and a Seasons toggle. The render preview's strategic views now set the sun and season from each view's local time and day.
- Settlement, base and industry lights are the next commit of this task.

**Reason:** Part II keeps day, night and seasons on the map because they decide which sorties fly (decision 72). A multiply keeps the map's colors and hillshade, so a coast reads the same by night, only darker and bluer.

### 88. Night lights on the map: instanced screen-facing points on the terrain

**Date:** 2026-11-11
**Decision:** `render/strategic/mapLights.ts` draws the map's night lights:

- **Sources.** Every settlement of the strategic graph (core radius 0.9 px, plus 0.7 px per doubling of population above 2,000, at most 3.5 px), every airbase (1.4 px) and every target site (1.1 px), from the graph and the infrastructure the map already receives. The simulation view's light tables (decisions 66, 71) are per-tile shader lists for close range; the map needs one point per place at globe scale, so it builds its own list.
- **Drawing.** One instanced quad per light, turned to the screen's right and up vectors and sized in drawing-buffer pixels, so a light keeps its size at every zoom. A core with a one-pixel antialiased edge plus a Gaussian halo about four times wider, in `#FFD27A`, additively blended: the soft halo Part II allows on night lights only.
- **Placement.** Each light sits 200 m above its displayed terrain (the world's height at its cell times the relief's exaggeration uniform), so lights stay on their towns when the camera tilts at the floor. The quads are planet-centered at −eye (rule 4).
- **Visibility.** Lights fade in across civil twilight on the night side (decision 87) and follow the GUI's Night strength. They draw without a depth test, so terrain never hides them, and a horizon test removes those on the far side of the globe.

**Reason:** Lights show where people and bases are at night, the moment the map is otherwise darkest. Pixel-sized points with a halo read at every zoom, and drawing them as one instanced mesh costs a single draw call.

### 89. Weather on the map from the simulation view's baked cloud field

**Date:** 2026-11-11
**Decision:** The strategic map draws stylized weather from the live cloud field:

- **Source.** The simulation view's cloud layer already bakes coverage and precipitation from the weather model and its cloud detail into a cube-face atlas of about 2 km texels, moving with game time (decisions 68, 69). The map samples the same bake through a small `WeatherField` interface in `render/common/weatherField.ts`, which the cloud layer implements and the app passes to `StrategicScene`, so `strategic/` imports nothing from `sim/`. While the map is the active view it calls the bake each frame; the bake itself skips work until the clouds have moved.
- **Clouds.** White, with opacity rising from 0 at coverage 0.3 to 35% by 0.75 and 60% by 0.95: soft shapes thick enough to show a front, never opaque.
- **Precipitation.** Part II's hatching `#7C8FA6`: one-pixel anti-diagonal lines about 8 px apart (the pattern framework's nested lines, decision 80), at 70% of the precipitation fraction under cloud, drawn under the cloud tint so it shows through.
- **Order.** Weather goes over the finished surface (patterns, water, outlines) and under day and night, so clouds darken with the night tint.
- **Toggle.** GUI → Map → Weather (clouds, rain), on by default.

**Reason:** One weather field for both views keeps them consistent: a front seen on the map is the cloud the player flies into. Reusing the bake costs the map one texture fetch per fragment.

### 90. Lighter map clouds

**Date:** 2026-11-11
**Decision:** After the owner's browser check of decision 89, map clouds are lighter: opacity rises to 25% by coverage 0.75 and 45% by 0.95 (was 35% and 60%), and GUI → Map → Cloud opacity scales it (0 to 2). Part II's palette row for clouds changes to match.

**Reason:** The owner found the clouds a little too opaque; the guide's "never so opaque that the map vanishes" governs.

### 91. Graticule and range rings in the relief shader; click to select a point

**Date:** 2026-11-11
**Decision:** `render/strategic/graticule.ts` adds Part II's optional graticule and range rings, drawn by the relief shader as annotation after day and night:

- **Graticule.** Latitude and longitude lines one pixel wide (distances in meters divided by the fragment's footprint), at the finest round step of 30°, 15°, 10°, 5°, 2°, 1° or 0.5° that keeps lines at least 120 px apart at the screen center. Longitude lines fade out from 75° to 80° latitude, where they converge, and the equator is 1.6 times stronger. Off by default (GUI → Map → Graticule).
- **Range rings.** Great-circle rings around a selected point at multiples of the finest of 500, 250, 100, 50 or 25 km that keeps them 90 px apart, eight rings, with a three-pixel center dot. On by default once a point is selected (GUI → Map → Range rings).
- **Selection.** Until map symbols exist, a click on the map (a press and release within 5 px and 400 ms, so drags still pan) selects the ground point under the cursor on the sea-level sphere; Escape clears it. Snapping to bases and aircraft comes with their symbols (S4, C2), and ring labels with the label engine (S2).
- **Colors.** Part II names none. The graticule is the water-label blue `#2F5F86` at 35% by day and the coastal-line blue `#A9C9D4` by night; rings are the settlement-label dark `#22252A` at 75% by day and the label halo `#F4EFE4` by night, so both stay visible on the night side.

**Reason:** Range rings answer the planning question "what can reach what" at a glance, and the graticule orients the reader on a globe without coastlines in view. Drawing both in the relief shader keeps them on the ground, one pixel wide at any zoom, at no extra draw calls.

### 92. The map's finish in its own shaders: vignette, paper grain, a pale rim

**Date:** 2026-11-11
**Decision:** Part II's post-processing is applied in the map's shaders (`render/strategic/mapFinish.ts`), not in a separate pass:

- **Vignette and grain.** The relief's final color and the background are multiplied by a vignette that darkens corners by up to 8% (starting 45% of the way from center to corner) and by a constant per-pixel grain of ±2.5% (a hash of the drawing-buffer pixel), fixed to the screen like paper.
- **Rim.** The background becomes a node: flat `#1E2630`, with a thin pale rim `#D9E4E8` just outside the globe's silhouette. For each background ray it takes the angle outside the limb, divides by radians per pixel, and draws a Gaussian about 1.5 px wide at 85%. This replaces the limb glow; there is still no atmosphere on the map.
- **Halo.** The night lights' additive halo (decision 88) stays the only glow.
- **Control.** GUI → Map → Paper finish scales vignette and grain from 0 to 1.

**Reason:** A post-processing pass would add a render target and a full-screen pass for three multiplies. In the map's own shaders the finish costs a hash and a smoothstep per pixel. The night lights, which draw additively over the relief, are not grained, which keeps them clean points.

### 93. Strategic preview views, a color-vision filter, and a stronger paper finish

**Date:** 2026-11-11
**Decision:**

- **Views.** `tools/render.preview.ts` with `SCENE=strategic` renders its own list. `globe` is the Globe band at 3,000 km with the terminator in view (Part II check 1). `night` is the same at 22:00. `theater` is at 900 km, `region` at 250 km, `floor` at 100 km, and `winter` at 1,500 km on day 150. `sharp` is the floor at 1920 × 1080 (check 5). The old `orbit`, `limb`, `terminator` and `floor` views leave the simulation list; the rest of that list is sorted in V1.
- **Clouds and sizes.** Each image size gets its own headless renderer and scene. The previews build a cloud layer fed by the sim's weather at each view's time, and force its bake with a synthetic clock, so check 1's weather shows.
- **Color vision.** `CVD=1` also writes each image as seen with protanopia, deuteranopia and tritanopia (`tools/cvd.ts`: Machado, Oliveira and Fernandes 2009, severity 1, in linear RGB) for check 4. A test confirms that grays stay gray and that Part II's faction colors stay far apart under all three.
- **Paper finish.** The owner saw neither the 8% vignette nor the ±2.5% grain of decision 92 in the browser, most likely because the AgX tone curve compresses small changes. Both are stronger by default: corners darken by 20%, grain is ±6%, and GUI → Map → Paper finish now reaches 3×. The previews will show whether the finish reaches the image at all.

**Reason:** Visual milestones close only after the acceptance checks (CLAUDE.md). This gives the owner one command that produces every image S1's strategic checks need.

### 94. Third-person flight without cockpits; one flight director for AI and player (Proposal 0002)

**Date:** 2026-11-11
**Decision:** The owner's Proposal 0002 (`docs/proposals/0002-third-person-flight.md`) is accepted. `docs/design.md` (revision 8) gains a _Flying_ section, `docs/visual-style.md` (revision 3) gains _The Controlled Aircraft_, _HUD and Displays_ and acceptance checks 7–10 in Part I, and Proposal 0001 is amended where it named cockpits.

- **No cockpits.** The player flies every aircraft and helicopter from a third-person chase camera. The HUD and the key displays (radar, moving map, threat warning, stores, targeting sensor, messages, systems) are 2D overlays. Spectating an AI flight and flying it use the same view; taking control changes only who provides the inputs.
- **One flight director, one flight model.** The flight director turns a desired direction and speed into control inputs. Mouse aim (the default) gives it an aim point from the mouse; direct control drives the surfaces through stability augmentation; AI pilots use the same flight director and the same table-driven flight model. Handback gives the flight director an aim point from the AI's orders.
- **Sensor model.** Displays show only what the aircraft knows: a per-aircraft sensor model (radar, RWR, visual, datalinks and AWACS, targeting sensors) set by avionics profiles per type. The AI uses the same filtered picture.
- **Crews as displays and callouts.** An AI crewmate in the F-111, A-6 and Su-24 analogues; crew station mode replaces the earlier idea of taking the right-hand seat; gunner mode for attack helicopters.
- **The controlled aircraft** uses 1,500–4,000 triangles, with animated control surfaces, swing wings, nozzles, stores and effects, and its shadow down to the ground.
- **Time.** The cockpit cap becomes the flight cap: while the player controls an aircraft, acceleration is limited to cruise phases (up to 8×) and cancels on any threat.
- **Roadmap.** V4 becomes "Transition, camera rig, and spectator HUD" (per-type chase rigs, free look, terrain avoidance, a read-only HUD for the followed aircraft). A post-demo Piloting track follows: P1 flight model and controls, P2 HUD and display framework, P3 sensors and displays, P4 weapons, P5 crews and special roles. P1 depends on V4, P2 on P1, P3 on P2 and S4, P4 and P5 on P3.

The engineering calls made while adopting it:

- **Full fidelity arrives with P1.** The _Full_ level now means the aircraft the player controls or follows, with the flight model, sensor model and flight director. Until P1, a followed aircraft flies its analytic route, and decision 49's bubble still centers on it.
- **Flight code is sim code.** The flight model, flight director and sensor model follow rule 5 (deterministic, SI, no `Math.random`) and are planned for `src/sim/flight/`. Where they run for the player's aircraft (sim worker or main thread, given input latency) is left to P1.
- **Items the proposal's roadmap does not place.** The controlled-aircraft detail level and its shadow go to V4, since the followed aircraft fills the screen there. Animated parts and flight effects go to P1, stores on pylons and damage to P4, crew figures to P5. Flyby and cinematic cameras stay in `TODO.md`'s _After the demo_ list until a milestone takes them.
- **Acceptance checks 7–10** (HUD legibility, symbol accuracy in hard maneuvers, the aircraft centered in a maximum-rate turn, no terrain clipping in valleys) run as scripted sequences from V4; check 9 needs P1 and the gun pipper part of check 8 needs P4. P1–P5 count as visual milestones.
- **No new hex values.** HUD colors are tuned in P2 and recorded in the guide then.
- Earlier entries that mention cockpits (2, 49, 72) stay as history.

**Reason:**

- _Cost:_ each cockpit is its own modeling, texturing and interaction project, and Bearing has more than twenty aircraft types. Without cockpits, a new type needs one exterior model, a flight model and an avionics profile.
- _Style:_ the flat-shaded, low-poly look is best from outside, against terrain and sky; low-poly interiors at arm's length would be its weakest point.
- _Jump-in:_ players join missions already in flight, often minutes before contact, and a chase view with clear 2D displays orients them within seconds.
- _Symmetry:_ one flight director and one flight model keep the AI and the player on equal physical terms and make taking control and handing back trivial. Following and flying become the same experience.
- _Browser budget:_ one exterior model and a 2D overlay cost far less than a detailed interior with its own lighting and render pass.
- The cost is immersion and some realism: the chase camera gives more awareness than a real pilot has, especially to the rear. That advantage is accepted in a single-player game against AI.

### 95. Named features: a list in the graph, raster polygons, extraction in the builder

**Date:** 2026-11-11
**Decision:** Pipeline step 7 (`worldgen/geography/`) turns the coarse maps into a `FeatureList` in the strategic graph (`worldgen/strategic/graph.ts`), so the types live with the graph (decision 72) and campaign logic reads them like any other graph fact.

- **Records.** Struct-of-arrays: kind (17 kinds), importance 0..1, anchor, extent, size, `height` and `measure` (per-kind meaning, documented on the type), parent (a peak's range, an island's archipelago, a tributary's stem), naming region, an optional polyline and the name. Every array transfers.
- **Polygons are rasters.** Each polygon feature owns cells in one of four `Int16Array` layers on the coarse grid (land, water, relief, cover), with a label axis (the longest chord through the anchor along the principal direction) as its polyline. Tracing outlines on the cube sphere buys nothing the renderer and the briefing need; the layers answer "what is here" in one lookup. An archipelago is the union of its islands.
- **Anchors** are the most interior cell (farthest from the edge, nearest the centroid on ties), so a ring-shaped sea anchors in its water.
- **Water.** Oceans, seas and bays come from a watershed on D, the distance to land. A basin that meets a deeper one stays separate only if the saddle's openness is at most 60% of its own peak; basins under 6,000 km² merge across their highest saddle. Oceans need 1.2 million km² and 250 km of open water, seas 50,000 km². Straits are the saddles between two water features narrower than 150 km with a sea or ocean on one side, plus the graph's strait chokepoints, merged within 120 km. Lakes are lake cells over 400 km².
- **Relief.** Classes per cell in reference meters and slope (the units of `landmasses.ts`): plateau (≥ 900 m, flat at the cell and its neighbors, so a ridge crest is not a plateau), mountain, hills, plain. Ranges are mountain components with one-cell gaps bridged, over 3,000 km²; the ridge line joins the ends of the range's longest geodesic along high ground. Peaks come from topographic prominence on the coarse grid (at least 500 m reference prominence and 1,000 m height); a peak's `height` is physical (decision 14), so labels show what the altimeter will read.
- **Cover.** Deserts (hot and cold; `measure` is the sand share), forests and wetlands as biome components over a size threshold. There is no wetland biome, so wetlands are flat, low, watered land next to big rivers, lakes or a low coast.
- **Rivers.** Main stems from each mouth with at least the larger of 100 m³/s and the 60th-largest mouth's discharge, upstream through the largest donor; big tributaries start stems of their own.
- **Importance** is a per-kind log scale of the feature's magnitude times a kind weight (oceans and continents 1, ranges 0.9, wetlands 0.5), so labels can rank across kinds.
- **Cost.** About 1 s per world at 256² on the session's machine, mostly the water watershed and two full-grid distance fields.
- **Fix found on the way.** Two Dijkstra searches in `territory.ts` stored distances in a `Float32Array` and compared the float64 heap key against them, so a key rounded down skipped its cell. They now compare in float32. Infrastructure placement can shift slightly; `GENERATOR_VERSION` goes to 9 for the new graph anyway.

**Reason:** The design's step 7 asks for records with geometry, extent and importance. Raster polygons keep extraction simple and exact on the grid the graph already uses, and putting the list in the graph keeps rule 9: the briefing and casting read features without touching world maps.

### 96. Toponymy: five flavors, one per naming region; names for features, settlements and corridors

**Date:** 2026-11-11
**Decision:** Pipeline step 8 (`worldgen/names/`) names the world from `rng(seed, "names")`.

- **Flavors.** Five syllable inventories with phonotactic rules (`names/flavors.ts`): A (northern), B (eastern), C (southern), D (steppe) and E (islands). Labels describe sound, not real cultures, and names stay ASCII so every label font covers them. Stems run 3–9 letters, with no run of three consonants or three vowels and a short blocklist of English words and slurs.
- **Regions.** Answering the design's open question for now: one flavor per land node. Landmass nodes, largest first, cycle through A–D in an order shuffled by `names/flavors`, so the largest two always differ; archipelagos take E. Water and stray islands take the flavor of the node whose land is nearest. `LandNode.flavor` records it.
- **Generic terms.** English: "the X Range" or "the X Mountains", "Mount X", "the X Hills", "the X Plain", "the X Plateau", "the X Desert" (sand) or "the X Waste" (cold), "the X Forest" or "the X Woods", "the X Marshes" or "the X Fens", "the X Ocean", "the X Sea", "X Bay" or "the Gulf of X", "the X Strait" or "the X Narrows", "Lake X", "the X River", "X Island" or a land name, "the X Islands", and continents with a flavor ending ("Stedargard"). Corridors are "the X Gap". Map labels drop the leading "the" (`labelText`).
- **Streams.** Features draw from `names/features` in id order, settlements from `names/settlements`, corridors from `names/corridors`, so one list's changes leave the others alone. Every full name in a world is unique.
- **Settlement names move here** from `rng("settlements").fork("names")`, so towns sound like their region. Placement does not change; only the names do.
- **Campaign.** Land nodes take their feature's name instead of a casting draw. Chokepoint theaters take the name of the strait or island there, and an island campaign the name of the sea around it. The briefing names the corridors ("through the Beith Gap, the Fator Gap and the Vath Gap") and the ranges or rivers along the strongest line, through `featuresAlong` and `nearestFeature` in the graph module.
- **Also fixed:** the briefing printed node areas in "million km²" divided by 10⁶ instead of 10¹².

**Reason:** Names make the map and the briefing read like a real theater. Drawing every list from its own fork keeps rule 5, and keeping campaign naming on graph data keeps rule 9.

### 97. Geographic glyphs: layout in TypeScript, instanced flat-shaded models per band

**Date:** 2026-11-11
**Decision:** Part II's mountain, hill, forest and dune glyphs come from the named features (decision 95):

- **Layout** (`render/strategic/glyphLayout.ts`, pure and tested). Mountains chain along each range's ridge line about half a glyph apart, zigzagging across it, with peaks placed first and sized by prominence; the rest of a range fills with smaller glyphs where it rises above about 1,320 m reference height with a reference slope of at least 0.05, so high flat ground stays bare. Mounds cover hills features, forest tokens (3–7 trees, 2.5–5 km) cover forest features sparsely in the Region band only, and dunes cover the sand cells of desert features with their horns downwind. Placement is a deterministic dart throw over each feature's cells in hashed order with a minimum spacing.
- **Two sets per kind.** A Theater set (mountains 30–50 km across, every 22 km along the ridge) and a Region set (10–17 km, every 6.5 km), wider than their spacing so chains overlap, each a separate instanced mesh whose opacity is its band's fade, so glyphs keep a roughly constant pixel size within a band and crossfade at band changes. Eight draw calls in all.
- **Models in code** (`glyphGeometry.ts`, rule 11): an irregular five-sided pyramid with a cap that takes snow, a seven-sided mound, seven conifers per token (the shader drops trees past the instance's count), and a barchan crescent.
- **Shading.** Flat, from the face normal by screen-space derivatives, lit from the screen's upper left like the hillshade (decision 78), then the night tint and twilight (decision 87) and the paper finish (decision 92). Snow caps where the annual mean temperature at the glyph is below 0 °C.
- **Colors.** Part II names none: rock `#8C8379`, snow `#F1F3F2` (the snow fill), mounds `#A99B73`, trees `#4E6A48`, dunes `#D8BD8C` with a `#C4A473` slip face.
- **Heights.** Glyphs stand on the display maps' heights times the relief's exaggeration, plus 150 m, like the night lights.

**Reason:** Feature records already carry ridge lines, prominence and polygons, so glyph layout reduces to sampling them. A pure layout keeps the placement rules testable without a GPU; one mesh per kind and band keeps draw calls far under Part II's 300.

### 98. Labels: an SDF atlas built at load time, a TypeScript placement pass, one instanced mesh

**Date:** 2026-11-11
**Decision:** The label engine lives in `render/strategic/labels/`.

- **Text rendering (the MSDF spike).** The known text libraries for three (troika-three-text, three-bmfont-text, three-msdf-text-utils) build GLSL or WebGL-derived materials, which `WebGPURenderer` does not run, and r187's WebGPU examples ship no SDF text; their newest releases were not rechecked in this session. Instead the map builds a single-channel signed distance field atlas at load time: opentype.js parses the fonts, outlines are flattened, and each texel stores the exact distance to the outline (32 px per em, a quarter-em spread so halos fit at 10 px). The atlas takes about 0.3 s on the main thread. A TSL shader draws the letter with an antialiased edge from the field's screen derivative and a halo of a set pixel width. Multi-channel fields would keep corners sharp at large sizes; map labels stay at 10–22 px, where single-channel fields look the same, so the extra complexity buys nothing yet. The guide's "MSDF" becomes "SDF".
- **Fonts.** EB Garamond Medium Italic and Fira Sans Medium and Semibold, from `@fontsource` (SIL Open Font License), loaded by Vite `?url` imports in the app and from `node_modules` in Node previews.
- **Model and bands.** `labelModel.ts` builds labels from the features, settlements and the cast's theaters, with a band content table (class × band → least importance). Peaks carry their true height ("Mount Seir 1,036 m").
- **Placement** (`labelPlacement.ts`, pure and tested). Point labels try four positions; line labels follow the projected polyline at one of five stations, read left to right and reject bends over 0.5 rad between letters; area labels letter-space along the feature's axis to fill 60% of it or sit level on the anchor. Points seen within about 12° of the horizon count as hidden, so text is never squashed along the limb. The collision pass sorts by importance (with a bonus for labels placed last time, against flicker) and keeps the first candidate whose glyph boxes, ink plus halo, stay in the viewport and clear of placed glyphs. It runs when the camera has been still for 0.15 s, when the band changes and when the labels change; between passes, placed labels are laid out again each frame with the candidate they won.
- **Drawing** (`labelLayer.ts`). One instanced mesh of glyph quads; the vertex shader writes clip space from pixel rectangles, so labels need no camera-relative placement. The quads are double-sided, since pixel y runs down and clip y up. Labels fade over 0.3 s, times their bands' fades. They draw in a second pass after the map with tone mapping off (`drawOverlay`): the renderer's AgX curve, set by the simulation view, otherwise lifts `#22252A` ink to mid-gray.
- **Acceptance check 2 in Node.** A test places the labels of a generated world at 3,000, 900, 250 and 100 km on a 1080p view with the scene's own projection and asserts that no two labels' glyph boxes overlap; passes take 0.4–15 ms there.
- **GUI.** Map → Glyphs and Map → Labels toggle the two layers.

**Reason:** Building the atlas from the fonts keeps the toolchain free of native MSDF generators and checked-in binaries, and lets Node previews render the same text. A pure placement pass makes "no overlapping labels" a unit test, not only a screenshot check.

### 99. The map renders without a tone curve; the coast field in kilometers; first preview review

**Date:** 2026-11-11
**Decision:** Fixes and findings from the owner's first run of the strategic previews (decision 93):

- **No tone curve.** The renderer's AgX curve, set by the simulation view, also applied to the map. It lifted the `#1E2630` background to mid slate gray and paled and flattened every Part II fill, and it was the likely reason the vignette and grain of decision 92 were hard to see. The map's scene pass now renders with `NoToneMapping`, restoring the renderer's setting afterward, as the label pass already did (decision 98). Hillshade strength, night darkness and cloud opacity were tuned under AgX and need a second look.
- **Coast field in kilometers.** Decision 85 raised the coast-distance cap to 100 km, past the half-float maximum of 65,504. Far-ocean texels overflowed ("DataUtils.toHalfFloat(): Value out of range" in the previews) and clamped, so the fade toward the cap never triggered. The texture now stores kilometers and the shader returns meters.
- **Previews.** The graph debug overlay is off in strategic previews (`OVERLAY=1` shows it). The `globe` view moves to 18:30 local time, so the terminator crosses the globe for check 1.
- **Review of the first images** (globe, theater, region, floor, sharp), against Part II:
  - Met: the palette, depth bands, coastal halo and lines, rivers, hillshade and patterns read as an illustrated map. Night lights with halos show at the terminator. Labels are legible, with the guide's typography (decision 98).
  - Check 1 falls short. The terminator only grazed the limb (fixed above), and territory tint, front lines and theater names wait for S3's overlays.
  - Clouds read as blurry fog at the floor, from the bake's 2 km texels.
  - Mountain glyphs (decision 97) show at the Globe band and crowd it. Part II lists ranges from the Theater band.
  - Hill mounds read as scattered dots, some in rows.
  - A steep patch at the floor looks noisy.
  - Each gap is a TODO under S1.

**Reason:** Part II specifies colors, not a camera response; a filmic curve built for the physically lit simulation view has no place on an illustrated map. Keeping the review in the log ties each TODO to the images that raised it.

### 100. Previews encoded sRGB twice; night lights thin out with scale

**Date:** 2026-11-11
**Decision:**

- **Double encoding.** The headless renderer of `tools/render.preview.ts` and the GPU tests (`tests/gpu/renderer.ts`, decision 32) rendered into an sRGB render target. Three already encodes its output to sRGB in the shader, as for a canvas, so the bytes were encoded twice: linear 0.0135 (`#1E2630`'s red) read back as 97 instead of 30. Every preview image so far has been too pale, the simulation view's shading previews included. The browser draws to a canvas with one encode and was not affected. The target now stores the shader's bytes as they are, and `tests/gpu/outputEncoding.test.ts` checks three known values. The strategic images' slate background and pastel colors (decision 99) were this bug, not AgX; the previews never set a tone curve. Decision 99's map pass without a tone curve still matters in the browser.
- **Night lights.** With no tone curve on the map, the additive halos of hundreds of towns stacked past white at globe scale. Lights now fade out below a core radius that grows with the map scale: none below 300 m per px, plus 0.6 px per doubling, at most 2.5 px. At the ceiling (about 2.6 km per px) only towns of about 16,000 people and up show, and at the floor every village. The halo's strength drops from 0.45 to 0.3.
- **Debugging without a GPU.** A cloud session can now run the previews on Mesa's software Vulkan driver (CLAUDE.md), which is how the double encoding was found.

**Reason:** Previews are how the map is judged against Part II, so they must show the colors the browser shows. Thinning lights by scale keeps them points on the night side, as Part II asks, instead of a glow that hides the map.

### 101. Military overlays: a territory raster, ground-fixed screen-space lines, and what each layer shows

**Date:** 2026-11-11
**Decision:** S3's strategic overlays (visual-style Part II, _Military Overlays_) live in `render/strategic/overlays/`.

- **Territory raster.** Infrastructure placement already computed who holds each coarse cell (`territory.ts`); `Infrastructure.territory` now keeps that raster (−1 sea, 0 neutral, 1 Alliance, 2 Pact), so the map tints the same split that placed airbases and towns. `GENERATOR_VERSION` goes to 10.
- **Territory tint.** An RGBA8 cube-face texture at the graph's resolution, one channel per holder, filtered linearly; sea cells take the nearest land's holder within three cells, so the tint does not thin along coasts. The relief shader tints dry land below rivers, weather and the night tint: the faction colors at 22%, neutral land `#8C8C8C` at 8%, which Part II names but does not dose. Part II's "about 15%" was faint over the 4× hillshade in the previews (seed 1, front and globe views, with decision 100's single sRGB encode), and 60% buried the map; 22% is a first pick between them, with a GUI slider (Map → Military overlays → Tint opacity) for the owner's tuning. The tint's edge is as soft as the coarse grid (about 40 km); the front line drawn over it is sharp.
- **What each layer shows.** The cast decides, not the graph: the start line of every continental-front theater as the front; that front's other barrier lines as defensive lines; corridors on the start line as arrows from the attacker's side into the defender's; the lanes of sea-lane theaters and the lanes that chokepoint theaters control; and the chokepoints of those theaters and lanes. Lanes and chokepoints outside the cast stay in the graph debug overlay, which is now off by default on the map (Map → Military overlays → Graph debug overlay); the Campaign folder's toggle drives the simulation view's globe only.
- **Bands.** Territory tint and front lines at every band. A sea-lane theater's own lane also shows at the Globe band, since it is that theater's front and its name already shows there. Defensive lines, corridors, other lanes and chokepoints from the Theater band down. Corridor names are labels in the attacker's color (`corridorAlliance`, `corridorPact`, 12 px Fira Sans Semibold capitals) at the Theater and Region bands, hidden with their layer.
- **Teeth side.** The attacker's side of the line is read from the territory raster two cells to either side of each line point (a vote), falling back on the attacker side's centroid; the teeth then sit where the attacker's tint is.
- **Drawing.** One instanced quad per polyline segment, draped on the displayed relief (coarse height × exaggeration + 300 m) and widened across the view by its width in CSS pixels at its distance. The fragment shader measures pixel distance to the segment for round joins, flat ends where a shaft meets its arrowhead, and antialiasing. Dashes and teeth run along the ground distance, with a period of the target pixel length at the screen center's map scale rounded to a power of two in meters: they stay fixed to the ground and change only when the zoom passes a factor of two. Arrowheads and chokepoint diamonds are signed-distance marks on instanced quads lying flat on the map. Each line and mark draws a pale casing (`#F4EFE4`) around its whole shape, teeth included, in a pass before its ink, so a casing never covers a neighbor's ink at joints. There is no depth test, so relief and glyphs never hide the front; shapes fade past the horizon and with their bands. One mesh per layer and pass (at most 20 draw calls).
- **Sizes (CSS px).** Front 3 px `#2A2A2A`, 1.5 px casing; teeth 8 px wide, 6 px tall, every 20 px, in the attacker's color. Defensive lines 1.6 px, 14 px dashes at 60%. Corridor shafts 4 px with 16 × 15 px arrowheads. Lanes 2 px, 12 px dashes at 55%, in the color of the side holding both ends, else the defender of the lane's theater. Chokepoints are hollow diamonds, 11 px (15 px for a chokepoint theater), `#2A2A2A`.
- **Theater names.** A continental front's or sea lane's theater name, anchored on its line, now sits 12 px above or below it instead of centered on it, where at the Globe band it covered the front.
- **Not yet.** Convoy icons on lanes wait for convoys in the simulation (C track), and air defense rings for air defense sites.

**Reason:** Reusing the placement raster keeps the tint, the teeth and the bases on the same side of the same line. Screen-sized, ground-anchored strokes follow Part II's "crisp at every zoom" without swimming dashes, and a pure model (`militaryModel.ts`) keeps the choice of what to draw testable on generated worlds without a GPU.

### 102. Crisp stylized map clouds; Theater mountains and scattered glyphs thinned

**Date:** 2026-11-12
**Decision:** Fixes from the corrected strategic previews (decisions 99, 100):

- **Clouds.** At the floor the cloud bake's 2 km texels drew blurry fog. Clouds now take crisp one-pixel edges at two cover levels, antialiased by the screen-space change of the cover (`fwidth`, taken at the top of the shader): a 28% white fill above cover 0.5, 45% above 0.75, and a thin slate outline (`#AEBBC6`, 45%) at the outer edge, as printed weather maps draw cloud. The bilinear field gives smooth contours, so the 2 km texels no longer show as blur. Precipitation hatching follows the outer edge. Cloud opacity (decision 90) still scales all of it.
- **Theater mountains** (decision 97). The Theater set crowded the band: glyphs of 30–50 km on a 22 km ridge spacing, plus a fill every 30 km. They are now 20% smaller (24–40 km; peaks 35–48 km), and the Theater fill runs every 50 km and only on taller ground (tallness 0.45 rather than 0.3). The Region set is unchanged. Large ranges whose ridge lines yield few chain glyphs still show as massifs, since dropping the Theater fill entirely emptied them.
- **Rows of mounds and dunes.** A maximal dart throw packs toward a hexagonal lattice, which read as rows in large deserts. Mounds and dunes now keep 60% of the darts that pass the spacing test (the dropped ones still count for spacing, as forest tokens already do) and move each by up to 20% of the spacing. The mountain fill moves by up to 35%.

**Reason:** Part II asks for cloud shapes thick enough to show a front without hiding the map, and for ranges legible as chains. Edges carry the shape at any zoom where fill opacity alone could not, and thinner glyph sets keep the map readable beneath them.

### 103. Civilian hierarchy: gravity-model road classes, routes, railways, urban extents and capitals

**Date:** 2026-11-12
**Decision:** S4's data tasks join the strategic graph in `worldgen/strategic/`, all on the coarse pass and before casting except the capitals. `GENERATOR_VERSION` goes to 11.

- **Road classes from a gravity model.** The road network is still routed as before (trunk links, Gabriel-graph local links, feeders; decisions 65, 71), but its classes now come from traffic. Every pair of trunk settlements (towns and cities, or the three largest per landmass) on one road component exchanges P_a · P_b / d², with d the great-circle distance in km and at least 20 km, assigned to the cheapest path over the finished network (length × movement cost; one Dijkstra per origin, flows accumulated up its shortest-path tree). The busiest edges making up 7% of the network's length become motorways, the next 20% trunk roads, the rest secondary roads. `RoadClass` becomes Motorway, Trunk, Secondary (was Highway, Main, Minor); `RoadNetwork.traffic` holds the gravity flow. Length shares rather than absolute thresholds keep the hierarchy similar across worlds whose total population differs tenfold; within a share, the classes follow the flows.
- **Routes.** Polylines of one class chain end to end where they continue within 70° of straight (the straightest pairs join first at each junction). Motorway and trunk chains of at least 30 km get numbers, longest first: M1, M2, … and R1, R2, …. A chain whose highest cell lies in a mountain range, at least 900 m (reference) high and 400 m above both its ends, is a pass road; each range keeps its widest, then longest, pass road. A chain of at least 80 km with 60% of its cells on the coast is a coast road; each land node keeps its two longest. Pass and coast roads are named by the toponymy stage from `names/roads` ("the Kessar Pass Road", "the Roth Coast Road"), whatever their class; a road can carry both a name and a number. They are stored as `StrategicGraph.routes`, and `RoadNetwork.route` points each polyline to its route.
- **Railways.** Stations at settlements of 100,000 and more, port towns of 15,000 and more, and the two largest settlements of every land node with at least six; industry regions sit on the largest urban clusters (casting), so they are served too. Lines follow the stations' relative neighborhood graph and spanning tree per landmass, routed by the road search over a rail cost in which grades cost three times what they cost a road (`railCost`), so lines share track and form junctions. Bridges where they cross rivers that need one; rail yards at city stations and at stations where three or more lines meet. The infrastructure stage now puts its rail-yard targets at the graph's yards 150–400 km behind each front, and falls back on the largest towns there when no railway reaches the band.
- **Urban extents.** One 24-vertex polygon per settlement, grown from a disk of the simulation view's built-up radius (10 m × √population, 0.5 to 9 km): a lobe along each road leaving the town (strength 0.7, 0.5, 0.3 by class), three seeded low harmonics from `rng(seed, "urban")`, slower growth uphill, then scaled to the disk's area and cut short of the sea and lakes. A radial profile is enough at the coarse grid's 6 km cells and keeps every polygon star-shaped around its town, which the map's fill needs. The simulation view keeps its disks until V3.
- **Capitals.** Each side's capital is its largest settlement (`Infrastructure.capitals`), since the cast assigns territory and the graph knows no sides. Part II's check 3 asks the viewer to find them.

**Reason:** The design (pipeline step 9) asks for a hierarchy from "the populations they connect and the traffic routed over them". The old classes came from a sum of √(P_a · P_b) over the links routed through an edge, which made long rural chains main roads; a gravity model assigned over the whole network concentrates traffic between large, close cities, as the maps the design cites show. Routes, railways and extents are what S4's map symbols and labels draw, and what C2's interdiction missions target ("Bridges, roads, rail").

### 104. Settlements and infrastructure on the map: urban fill, building glyphs, roads, railways and symbols

**Date:** 2026-11-12
**Decision:** S4's map tasks (visual-style Part II, _Settlements and Infrastructure_) live in `render/strategic/infra/` and reuse the military overlays' drawing.

- **Urban fill.** The graph's urban polygons (decision 103) are rasterized on the CPU into an R8 cube-face texture at 2,048² per face (about 0.8 km), with 4 × 4 samples per texel for soft edges; each polygon goes onto every face one of its vertices falls on. The relief shader blends Part II's urban fill `#CBB8A0` at 90% over the land fills and patterns and under snow, the hillshade, the territory tint and the night, from the Theater band down (at the Globe band towns are below a pixel and would sparkle without mipmaps). The texture costs 24 MB; a polygon mesh over the relief would have needed its own hillshade and night.
- **Building glyphs.** Four new glyph kinds in the geographic glyph layer (`village`, `town`, `city`, `capital`), built in code from gabled houses, flat-roofed blocks, towers and a faceted dome, flat-shaded and lit like the mountains, roofs in the accent color. Cities and capitals have a Theater set (20 and 26 km across), and every settlement has a Region set (2.6 to 10.5 km), so a glyph keeps roughly its pixel size within a band. Each turns by a hash of its index. A GUI toggle (Map → Settlements and infrastructure → Towns) hides the fill and the glyphs together.
- **Capitals.** A 15 px five-pointed star over each capital's glyph from the Theater band down, in the side's faction color. Principle 5 reserves faction colors for military information; a side's capital is the target the war turns on, and check 3 asks viewers to find it within ten seconds, which a neutral star among the cities' glyphs would not help. Capital labels are 15.5 px spaced Semibold capitals and outrank every other settlement in placement.
- **Roads and railways.** `MilitaryLayer` becomes generic over its layer names, takes a casing color per line, a render order, and an optional day/night input that darkens ink and casing with the map's night tint (decision 87); the front keeps its pale casing and never darkens. A second instance draws `railways` and `roads` before the glyphs and the night lights (render order −10), so glyphs stand on roads, and a third draws `sites` after the glyphs (12), below the military overlays (20). Road polylines run through coarse-cell centers, so they get two rounds of Chaikin corner cutting (ends kept) before densifying. Widths in the Region band: motorways 3 px, trunk 2.3 px, secondary 1.4 px, each with its Part II casing color; motorways also at the Theater band at 1.5 px. Railways are a 1.2 px line plus a 6 px wide line dashed to 1.5 px every 9 px, which draws the cross-ticks with the existing ground-fixed dash code.
- **Symbols.** The mark shader gains signed-distance map symbols in a unit square: airbase (ring and runway along the base's heading), port (quay and jetties), factory, power plant, refinery, supply depot, fuel depot, rail yard, bridge (two bars along the road's tangent) and star. Symbols with no axis stand upright on screen (the camera's up laid into the ground plane). Airbases show from the Theater band (11 px) and at 15 px in the Region band; the rest at 12 px in the Region band. Sites take their holder's faction color; the graph's rail yards that carry no target take the rail color. A town's symbols stand 1.5 built-up radii out on its edge, spread 60° apart from east, as the simulation view places industry.
- **Labels.** Route labels along each numbered or named route, joined end to end and smoothed: "M4", "the Kessar Pass Road", or "the Kessar Pass Road (R4)" for a numbered pass road, 10.5 px brown sans, Region band, hidden with the roads layer. Settlement labels clear their glyphs (gaps of 4 to 12 px by class).
- **Previews.** Two strategic preview views center on the Alliance capital: `cities` at 700 km (Theater band) and `capital` at 150 km (Region band).

**Reason:** Reusing the overlay drawing gives roads and symbols the same crisp, ground-fixed, screen-sized strokes as the front (Part II principle 3) without a second line renderer, and the glyph layer already provides flat shading, the night tint and band fades for the building clusters. Drawing roads under the glyphs and symbols over them follows how printed maps layer them: relief art first, linework, then symbols and type.

### 105. Legible towns and symbols at the zoom floor

**Date:** 2026-11-12
**Decision:** Fixes for the gaps acceptance check 5 found in S4's map (seed 1, `sharp` view at 1920 × 1080).

- **Urban fill.** The map draws urban polygons 1.6 times their size about their centers, and at least 1.6 texels (about 1.3 km) in mean radius, so towns read larger than life (Part II principle 1) and villages show as small patches rather than a smudge under a texel. The graph keeps the true extents. The fill is opaque now and gets a crisp edge at half coverage, with a 1.3 px `#8E7A64` outline where a texel spans at least two to four pixels (fading out where texels are smaller). Without an edge, `#CBB8A0` was nearly invisible on desert (`#DCC195`) and farmland (`#C9B57A`), which differ from it mostly in hue.
- **Symbols.** Site symbols are 16 px (were 12), airbases 13 and 19 px (11 and 15), bridge marks 13 px with thicker bars (9), the capital star 18 px (15), with wider pale casings. Upright symbols now face the screen as billboards. Before, they lay in the ground plane, and the map's tilt of up to 50° at the floor squashed them to half height.

**Reason:** At the floor a factory or depot drawn flat at 12 px was a few pixels tall, and the towns the roads join were hard to find. Larger, screen-facing symbols and outlined towns keep the linework, symbols and type all legible at the closest zoom, which is what check 5 asks.

### 106. Model specs, the procedural builder and the model viewer

**Date:** 2026-11-12
**Decision:** V3's model pipeline (visual-style Part I, _Models_, _Procedural Model Builders_) lives in `src/render/common/models/`, shared by the simulation view and the model viewer.

- **Spec format** (`spec.ts`). JSON files in `models/specs/`, one per model, validated on load with errors that name the path (`model x: parts[3].size: must be positive`). Frame: meters, +x forward, +y up, +z starboard, origin on the ground or the waterline. A spec gives its budget class, a default camouflage scheme, a color per face group (hex, a named model color, or `camo`) and a list of parts: `loft`, `wing`, `box`, `frustum`, `cylinder`, `blob`, `arch`, `house` and `mast`, each optionally mirrored across z = 0; emissive anchors (afterburner, navigation lights, beacon, runway, flood, window) with optional mirroring. Hinges, swing-wing pivots, store stations and crew positions for the controlled aircraft wait for P1, where they are needed.
- **Builder** (`builder.ts`, pure TypeScript). Non-indexed, flat-shaded triangles; each primitive emits its faces with a point inside its solid, and a face whose normal points at that point is flipped, so every face points outward without each primitive getting its winding right. Camouflage: a smooth value noise over face centers, feature size per scheme, picks one scheme color per face, sampled at |z| so the pattern is symmetric and both wings match (owner review); down-facing faces take a scheme's underside color (naval). Ambient occlusion per vertex: eight rays in a cone about the face normal, a quarter of the model's size long, each hit darkening by 7%; buildings also darken toward y = 0. The same spec gives the same bytes (tested). Tests also check every library model against its class budget and that closed primitives have positive signed volume.
- **Palettes** (`palettes.ts`). Part I's faction schemes and model colors as data shared by the builder and the viewer. Part I has no ship colors, so two schemes are added: Alliance ship `#8C949B` and Pact ship `#7E8A86`, both over a `#3A3E42` waterline band.
- **First specs.** Four aircraft, all fictional analogues whose proportions carry the type: the F-21 Kestrel (F-16-like, single tail, chin intake; Alliance air superiority), the F-124 Harrow (F-111-like, swept wings, wide side-by-side canopy; Alliance woodland), the Vo-31 Strizh (MiG-29-like, twin canted fins on spaced nacelles; Pact air superiority) and the Vo-35 Molot (Su-25-like, straight high wing with tip pods and engine nacelles; Pact tactical), 362 to 534 triangles. Base kit: hangar, hardened shelter, control tower, radar on a lattice mast, radar dome, fuel tank, revetment. Towns: house, large house, apartment block and tower block (pale concrete flat roofs: slate flat roofs made a city read as dark specks from above); industry: factory hall and chimney stack. Ships: a carrier (2,092 triangles with its island, angled deck, elevators, sponsons, parked aircraft and painted hull number; its spec is generated by `tools/models/carrier.py`), an Alliance destroyer and a Pact cruiser.
- **Simulation view.** The structure layer's buildings are now instances of these models, one instanced mesh per model and tile, turned and scaled per instance (non-uniform scale, with the normal transformed by its inverse transpose) and shaded with their colors and baked occlusion. Hangars and shelters face the runway and taxiway; airbases gain fuel tanks, a radar dome, a radar mast and revetments; town buildings fill each town's urban extent polygon (decision 103) instead of its disk, houses in the outskirts and blocks and towers in the cores. The layer's tangent frame was left-handed, which mirrored every building; harmless for symmetric boxes, it would have turned models inside out, so it is now right-handed. The material is double-sided like the layer's neighbors (trees, terrain, clouds), and shading uses the builder's outward normals. The terrain's built-up patch is still a disk.
- **Model viewer.** `viewer.html`, a second Vite page (built beside the game under `/bearing/`), opened from the debug GUI (View → Model viewer). Model and scheme pickers, turntable, pitch and distance, time of day (sun elevation, golden low sun and dusk sky), sun azimuth, sky light, exposure, occlusion and wireframe toggles, blinking emissive lights, the triangle count against the budget, and a silhouette mode, solid black on the pale sky `#C9D8E3` for check 6. Settings live in the URL hash, so Vite's reload on a spec edit returns to the same view.
- **CPU previews.** `tools/models.preview.ts` rasterizes each model on the CPU (z-buffer, the same flat shading) into a sheet of four views and four silhouettes, so models can be reviewed in sessions without a GPU.

**Reason:** Part I asks for models generated from small, reviewable JSON specs, within budgets, with a viewer and a silhouette test. Orienting faces from an inside point makes primitives simple to write and impossible to get inside out; a CPU preview lets specs be authored and checked without a browser, as the map previews do for the strategic view.

### 107. Ink outlines on models

**Date:** 2026-11-12
**Decision:** At the owner's request, models get a strong ink outline, switchable. This reverses Part I's "No outlines" for models only; terrain, trees and clouds stay unoutlined, and there is still no cel shading.

- **Technique.** An inverted hull: each model draws a second time, back faces only, in ink `#1A1B1D`, every vertex pushed out along an outline normal by a width in pixels at its distance (distance × radians per pixel × width), so the line keeps its width at any range. The flat-shaded models have split normals at every hard edge, which would tear the hull open, so the builder bakes an `outlineNormal` per vertex: the normalized sum of the distinct face normals meeting at its position (where they cancel, on the two sides of a thin sheet, the face normal). The outline traces silhouettes and the seams where parts meet (canopy on fuselage, wing on body); creases inside one closed part stay unoutlined, as the method does.
- **Model viewer.** "Ink outlines" toggle and "Ink width" (default 2 px).
- **Simulation view.** The structure layer draws an ink mesh beside each building mesh (twice the draw calls of buildings), its offset transformed by the instance's inverse-transpose scale like the normals, under the same aerial perspective as the buildings, and fading out from 3 to 5 km, where buildings are a few pixels across and would turn to ink blots. GUI → View → "Ink outlines on models" and "Ink width (px)" (default 1.6 px).
- **Previews.** `tools/models.preview.ts` draws the hull in its shaded views (INK=0 turns it off, INK_PX sets the width).

**Reason:** The owner wants models strongly inked, in the spirit of illustrated maps and toy-like models, with a switch to compare. An inverted hull costs one extra draw per model and no post-processing pass, keeps a constant pixel width, and works with instancing; a screen-space edge filter would also ink terrain facets and trees, which the guide keeps clean.

### 108. Airfields graded into the terrain from the global height grid

**Date:** 2026-11-12
**Decision:** Each airbase gets a flat pad cut and filled into the simulation view's terrain (V3), a pure function of direction and the ungraded height in `render/common/terrain/grading.ts`.

- **Pad.** A rectangle in the runway's frame: along the runway with 200 m overruns past each end, across from 80 m beyond the runway's left edge to 200 m beyond the apron's far edge, which covers the taxiway, the apron, hangars, shelters, revetments, fuel tanks and the radar dome (`render/sim/infra/airfieldGrading.ts`). Inside it the surface is the field elevation; over a 400 m margin it returns to the terrain with a smootherstep, so the embankment has no crease at either end.
- **Field elevation.** The mean of the global eroded height (the CPU copy of the 1024² grid the tiles add their detail to) at 27 points over the pad, at least 3 m. It is known as soon as the world is, the same for every tile level, without waiting for tile data. The fine surface differs from it by its detail, rivers and gullies, so a pad sits on a low embankment or in a shallow cut of a few meters to a few tens of meters, as real airfields do.
- **Where it applies.** `surfaceSampler` grades after the render detail, so the tile's own heights, its geomorph target, trees and buildings all stand on the same graded ground; the mesh's slope pass grades its samples, so normals are flat on the pad; `TerrainRenderer.heightAt` grades too, for the camera's ground clearance. The terrain's forest canopy (decision 71) is scaled by one minus the pad's cover, so no canopy is painted on the field, where the instanced trees were already cleared. `SurfaceGrading.forTile` keeps only the pads that reach a tile, so other tiles cost nothing and build byte-identical meshes. Only land is graded: a sample at or below sea level keeps its height, so a coastal pad meets the sea at its own edge. The strategic relief is not graded; a 3 km field is below its zoom floor's detail.
- **No separate rebuild.** The grading travels with the infrastructure in `TerrainWorld`, which the app sets together with the synthesizer, and `setWorld` drops every cached mesh. The TODO's "terrain rebuild when the infrastructure arrives" is that drop.

**Reason:** The runway pavement draws in the terrain shader and follows the surface exactly (decision 65), so it followed the fine terrain's detail noise and rolled like a country road. Grading by a closed-form function keeps the shader approach: every LOD level, the morph target and the instanced layers agree without exchanging data, and a field elevation from the global grid needs no tile to be loaded first. The execution layer's terrain queries (flight, line of sight) will need the same function when they exist; it lives in `render/common/` for now and moves to a shared layer then.

### 109. Runway and taxiway paint in the terrain shader, from the airbase light record

**Date:** 2026-11-12
**Decision:** Runway and taxiway markings (visual-style Part I, _Bases_) are painted in the terrain fragment shader over the concrete, like the pavement itself (decision 65), in `render/sim/infra/runwayMarkings.ts`.

- **Data.** Each airbase's light record (decision 71) now has kind `BUILT_AIRFIELD` and carries its runway in the last float: the length in whole meters plus the heading (folded to 0..π) over 4, which float32 keeps to about 0.06°. The shader rebuilds the runway frame from the record's center and heading, so the markings need no new table and no new per-tile uniform: they ride on the light loop that already runs on dry land by day for the built-up patches.
- **Layout** (ICAO-like, a little bolder than life so it reads from a few hundred meters). Per runway end, in the frame of a pilot landing there: five threshold bars each side of the centerline (1.8 m on 3.6 m centers, 30 m long), the two-digit designation in seven-segment figures 18 m tall (the heading in tens of degrees, 36 for north, the far end ± 18), and the aiming-point blocks 300 m in. Along the runway: side stripes at both edges and 30 m centerline dashes every 50 m between the designations. In yellow: the taxiway centerline and its links to the runway ends and to the apron. White paint `#E6E4DC`, yellow `#D9A92E`.
- **Antialiasing.** Each mark is a box whose cover is clamped by the pixel footprint and scaled by its width over the footprint, so thin lines fade to their share of the pixel rather than shimmer; the dashes fade to their duty cycle once a period is under two pixels.
- **Layout as data.** The boxes, the segment boxes and the figure masks are constants read by both the shader and a CPU twin, `markingAt`, which the tests check.
- **Apron links.** The apron stood 150 m beyond the taxiway with grass between; two 23 m links now join them, so an airbase has seven concrete strips.

**Reason:** A paint layer in the pavement shader follows the surface, its LOD and the new grading (decision 108) exactly, as the pavement does; decals would fight geomorphing. Riding on the light record keeps the per-tile uniform count where it is (I1 lists it as a cost).

### 110. Night lights at bases and in towns as camera-facing points

**Date:** 2026-11-12
**Decision:** The simulation view's night lights (visual-style Part I, _Bases_; check 4) are additive camera-facing points drawn by the structure layer (`render/sim/infra/lightPoints.ts`), emitted per level-9 tile with the buildings.

- **Sources.** Every building's emissive anchors from its model spec (decision 106), turned and scaled with the instance in float64 on the CPU (the material's own frame, `instanceAxes`): apron floods on hangars, tower windows and beacons, mast and chimney beacons, and lit windows in towns, where 55% of buildings have one, chosen by a hash of the building's position so that no random stream changes. Each airbase also gets runway edge lights every 60 m along both edges, a green threshold row and a red end row 3 m beyond it at each end.
- **Drawing.** One instanced quad per light, turned to the camera with the camera's world right and up axes, at the anchor's world size (2–7 m) but at least 6 device pixels across; held at that size, its brightness falls with the square root of the area ratio, between constant brightness and constant total flux (the full ratio left distant rows invisible in the first preview). A hot core plus a soft halo, dimmed by the air's transmittance to the camera, faded at the layer's range. Colors from Part I's emissive table: `#FFD27A` for runway lights and floods, the navigation red and green for the ends and thresholds and beacons, `#FFC98A` for windows.
- **When.** Lights fade in as the sun sets, from a sun elevation of about 6° to fully on at −2°, so the airbase at dusk of check 4 is lit while the sky still glows. GUI → View → Night lights sets the brightness (default 3; 0 hides them).
- **Not yet.** Beacons do not blink (the layer has no clock), lights cast no light on the ground (the terrain's settlement glow stands in), and there is no bloom.

**Reason:** Points scale to hundreds of lights per airfield at one draw per tile, follow the buildings' placement exactly (same tiles, same ground heights, the same grading, decision 108), and keep the emissives defined where the models are. A minimum pixel size with area dimming makes runway rows read as lines of dots from a few kilometers without turning into blobs.

### 111. Town patches in the terrain follow the urban extent polygon

**Date:** 2026-11-12
**Decision:** The terrain's built-up patch for a town (decision 71) takes the town's urban extent polygon (decision 103) instead of a disk of its urban radius, matching where the instanced buildings stand (decision 106).

- `InfraScene.outlines` holds each town's 24 radii, at evenly spaced bearings counterclockwise from east; the town's light record carries 1 + its index in its last float (0: none, the disk as before). Radii are capped at the light's radius plus 1.5 km, so the patch never reaches past the tile lists the light is filed in.
- The shader reads the outline only for town records with one, in a branch (a WGSL `select` would evaluate both sides and index the table with an airfield's runway code), and interpolates the radius by the fragment's bearing, as `townRadiusToward` does on the CPU. The edge noise wobbles a polygon by ±10% rather than a disk's ±25%, since the polygon is already irregular. A GPU test checks the shader's patch against `townRadiusToward` on a lopsided town.

**Reason:** With buildings filling the polygon and the patch a disk, a town's buildings and its patch disagreed at the edges, most visibly where a town stretches along a valley or coast. The light record already reaches the shader in the loop that draws the patch, so the outline costs one small table and no new per-tile uniform.

### 112. The observer camera, the simulation view's envelope, and a reversed depth buffer

**Date:** 2026-11-12
**Decision:** The simulation view gets its own camera, the observer (`render/sim/camera/`), and the old orbit camera becomes its free camera, a development tool offered only behind a dev flag until V4 (decision 72).

- **Stations.** One per airbase and port of the cast's infrastructure, both sides, Alliance first, main bases before forward, bomber and island fields, then ports (`observerStations.ts`). At an airbase the observer stands beside the control tower's cab, 8 m toward the runway and 15 m toward the apron so the cab is behind, 19 m up, looking 3° down along the apron at the middle of the hangar row; the taxiway and runway are a turn to the right. At a port it stands 30 m up over the port's site, facing the lowest ground 2–6 km out (the sea) by the global height map; port sites come from the coarse pass, so a port observer can stand a little inland or offshore until ports have their own layout.
- **The camera** (`observerCamera.ts`, float64, tested without three.js). Eye height 2 m to 20 km above the ground (R/F): the simulation view's envelope. W/A/S/D walk the spot up to 5 km from the station, at walking pace near the ground and faster higher up (25 km, 40 m/s and a Shift boost since decision 113). Drag turns the head with grab semantics (mouse-look since decision 113), right drag or Q/E turn and pitch, and the wheel or a pinch zoom the field of view from 70° down to 5°, like binoculars. It reuses the orbit camera's input wiring through the same `CameraControls` interface.
- **Ground.** The eye stands above `TerrainRenderer.displaySurfaceAt`: the level-10 surface that the finest meshes, trees and buildings use, with render detail and the airfield grading (decision 108), so a standing observer stays above the drawn ground. It asks for the data tile it needs and falls back to the coarser `displayHeightAt` until it has loaded.
- **Reversed depth.** The observer's near plane is a tenth of the eye height, from 0.1 to 1 m, and its far plane is the horizon, up to about 200 km. A standard depth buffer cannot hold that ratio (buildings at 5 km would z-fight with the ground), so the renderer, the model viewer and the headless test renderer all use three's `reversedDepthBuffer` (a float depth buffer with reversed Z). No shader of ours reads depth; the labels draw without a depth test.
- **The app.** GUI → View → Simulation camera picks the camera and the observer's station (_Observer at_). The free camera is offered on the dev server and with `?dev` in the URL; without it the simulation view uses the observer once a world exists, and the free camera only shows the globe while the first world generates. Switching to the strategic view centers the map on the observer; switching back returns to the station. Instanced buildings are now on by default, since the simulation view is a ground view; trees stay off until V2's tree LOD (decision 45).
- **Not yet.** The free camera keeps its orbit-to-ground range as a debug tool; the strategic view owns everything above 20 km for players. Ports have no buildings or ships yet (C3, V3).

**Reason:** The owner could not review the base kit from the free camera, which stops 500 m above the ground. Decision 72 enters the simulation view only through a unit, and the observer at a base or ship is the entry that exists before flights do (V4). A float64 camera class beside the orbit camera keeps the math testable and leaves the free camera untouched for previews and debugging.

### 113. Tiles split only when all four children are ready; observer controls from the owner's review

**Date:** 2026-11-12
**Decision:**

- **The flicker.** In the owner's recording from the observer camera the ground vanished for single frames, showing the sea or, at night, black. The headless renderer reproduced it: while the view turned, a frame drew one level-1 tile instead of about 108 tiles down to level 10. `selectTiles` split a tile when its *visible* children were ready. A child outside the view had no mesh, so when a turn brought it in, its parent stood in for the whole subtree until the child was built; near the ground that parent can be a level-1 tile hundreds of kilometers across, drawn at sea level where its coarse heights are low. Now a tile splits only when all four children are ready, seen or not; the selection reports split tiles and their unseen children as `keep`, and both renderers mark those meshes used so the caches do not evict them. Turning at 7°/s and at 90°/s through the observer (the preview's `FLICKER` and `FLICKER_TURN`) now keeps every frame at 83–119 tiles down to level 10. The cost is up to three extra meshes per split tile, built in the same frames as their siblings. A test covers a split tile with an unready child outside the view.
- **Mouse-look.** Dragging with either button now turns the observer's head the way the right drag already did: right turns right and down looks down. Grab semantics, where the view follows the cursor like a map, felt inverted left and right.
- **Speed.** The observer moves at 40 m/s near the ground and 1.5 times its eye height per second higher up, may roam 25 km from its station (about the promotion bubble, decision 49) instead of 5 km, and Shift moves either camera five times faster.

**Reason:** The owner's review of the observer camera (decision 112) found the flicker, the inverted horizontal drag and the slow movement. The all-or-nothing split is the standard way to avoid holes between tile levels; it only has to count the children outside the view as well.

### 114. Touch controls for the observer camera

**Date:** 2026-11-12
**Decision:** On touch screens the observer camera (decision 112) takes gestures for looking and on-screen controls for moving (`ui/touchControls.ts`), as the owner asked.

- **Gestures on the view.** One finger looks around as the mouse does (decision 113): right turns right, down looks down. (The first version grabbed the view, the scene following the finger as in panorama apps; the owner found it entirely inverted on the tablet, so fingers and mouse now share `drag`.) Two fingers pinch to zoom the field of view and move to look; a twist does nothing, since it would jitter the heading while pinching. Three fingers dragged up or down pitch, as before.
- **On-screen controls**, bottom left and bottom right above the time bar, in Part I's panel style (dark translucent, square knobs, amber when active): a walk stick, analog, with a 12% dead zone, full deflection being W/A/S/D; a height slider that springs back to the middle, as R/F; and a ×5 toggle for the fast pace, as Shift. Each captures its own pointer, so both thumbs work at once. They feed the observer's `stick` input, which is added to the keys. They show only on touch devices (`maxTouchPoints` or a coarse pointer), in the simulation view, with the observer camera.
- **Pace.** The owner found the stick a little slow: the observer now moves at 80 m/s near the ground and twice its eye height per second higher up (40 m/s and 1.5 times in decision 113), with keys and stick alike.
- **Checks.** Unit tests for the stick and slider mapping and the observer's touch behavior; the overlay was also driven in headless Chromium with emulated touch (push, release, slider, toggle).

**Reason:** Decision 60 gave the orbit camera map-app gestures, but the observer walks and climbs, which have no natural gesture; a twin-stick layout is the convention for moving a ground camera on a tablet, and keeping looking as a gesture leaves the screen mostly free.

### 115. The observer flies

**Date:** 2026-11-12
**Decision:** The observer camera (decisions 112–114) flies instead of walking, at the owner's request: it starts at its station as before, but its stick and keys move it through the air.

- **Moving.** Forward (W/S, the touch stick's up and down) moves along the view direction, pitch included, so looking down while pushing forward descends and looking up climbs. Sideways (A/D, the stick's left and right) strafes level. The height slider and R/F climb and sink straight up and down at the same speed. Speed is unchanged: 80 m/s near the ground, twice the height above ground per second higher up, five times faster with Shift or ×5.
- **Altitude, not height.** The camera now keeps its altitude above sea level instead of a height above the ground, so it no longer follows the terrain: flying out over a valley leaves it high above the valley floor. Its limits are the ground: never closer than 2 m to the ground under the eye, never more than 20 km above it (the simulation view's envelope). The camera asks the scene for the ground (`groundAt`, the finest drawn surface) after each move, so rising ground lifts it in the same frame rather than the next. A station's eye height is applied once the ground under it has loaded.
- **Unchanged.** It stays within 25 km of its station, and the free camera stays behind the dev flag.

**Reason:** The owner wanted to fly with the joystick rather than stay on the ground, only never below it. Flying along the view is the convention of free-flight cameras and needs no extra control for diving and climbing; following the ground's height would make the camera bob over every rise, which flight should not.

### 116. Horizon-bounded tile selection with an exact tile distance

**Date:** 2026-11-12
**Decision:** The terrain selection (`render/common/terrain/quadtree.ts`) drops a tile when its nearest point lies beyond the horizon, measured exactly, and states its bound as a function that caches and prefetch can share.

- **The gap.** The horizon test compared each tile's bounding cap, a circle around the square tile, with the horizon. The circle reaches past the tile's sides, so tiles lying wholly beyond the horizon were kept: at 500 m with 4 km peaks the horizon range is 121 km, and drawn tiles began as far as 157 km away; at 20 km looking down, 312 km against 291 km.
- **Exact distance.** Tile edges are lines of constant u or v on a cube face, and under the equi-angular warp these are great-circle arcs. The angular distance from the nadir to a tile is therefore 0 inside it (all four edge normals face the point) and otherwise the distance to the nearest of four arcs: the foot on the arc's great circle if it falls within the arc, else the nearer end (`tileAngularDistance`). The cap test stays as a cheap first rejection. A unit test compares the exact distance with dense sampling.
- **The bound.** `horizonRange(view)` is the camera's horizon plus the horizon of the tallest displayed terrain, as ground distance: R·(acos(R/(R+h)) + acos(R/(R+H))), close to √(2Rh) + √(2RH). Over flat land it is 199 km at 20 km, 32 km at 500 m and 2 km at 2 m; 4 km peaks add about 89 km. Each tile still uses its own top (capped at the planet's tallest), so flat tiles drop earlier than mountains. No drawn tile lies wholly beyond the range.
- **The margin.** Decision 113 splits a tile only when all four children are ready, so a turn never finds a child without a mesh. A child beyond the horizon cannot be shown by any turn, only by moving, so it no longer counts. Children within a margin past the horizon range, a tenth of it and at least 1 km, still count: they are built and kept, not drawn, so a moving camera finds them ready as they rise over the horizon. `selectionRange(view)`, the range plus the margin, bounds every tile the selection draws, keeps or asks for. Standing 2 m above the ground, the selection used to ask for meshes 4 km away behind a 2 km horizon.
- **Tests.** A sweep of observer views (2 m to 20 km, three headings, three pitches, flat land and 4 km peaks, with every mesh ready and with only levels up to 6 ready) checks that drawn tiles stay within `horizonRange` and wanted and kept tiles within `selectionRange`; a 2 m view checks that splits no longer need children past the margin.
- **What it does not change.** Tile counts barely move (the dropped tiles were coarse ones near the horizon), and a tile straddling the horizon is still drawn whole; the far plane clips it. The bound grows with exaggeration: at the current 10× (peaks up to 40 km) it is about 490 km at 20 km, which V1's true-scale relief task brings to about 290 km. The design doc's "about 200 km at 20 km" is the flat-land horizon; peaks beyond it add their own horizon, since a 4 km ridge 250–290 km away still shows with 20–40% of its red light through the haze, and cutting it would make ridges pop in as the camera climbs.

**Reason:** V1 bounds the simulation view's terrain by the horizon so that streaming, LOD depth and memory stay bounded (Proposal 0001). The selection already culled by horizon, but loosely, and asked for meshes no view could show. The next task, the tile cache budget and prefetch, needs a radius it can rely on; `selectionRange` is that radius.

### 117. The graph overlay starts off; an observer status line

**Date:** 2026-11-12
**Decision:** The strategic graph debug overlay on the simulation view starts off (owner request); GUI → Campaign → overlay turns it on. Its own default was on and the GUI's value reached it only when toggled, so it is now also applied at startup, as the View folder's settings are. GUI → Status gains an _Observer_ line: the observer's ground distance from its station out of the 25 km allowed, and its height above the ground.

**Reason:** The owner asked whether the 25 km limit is really 25 km. It is (a test flies 50 km outward and stops between 24.99 and 25 km of ground distance), but it feels shorter because speed grows with height: at 1 km above the ground the observer moves 2 km/s, so the limit is twelve seconds away, two and a half with ×5. The status line makes the distance visible.

### 118. No leash on the observer

**Date:** 2026-11-12
**Decision:** The observer camera may fly anywhere within the simulation view's 0–20 km envelope; the 25 km leash around its station (decisions 112, 113) is gone. A station is a starting point for jumping between places of interest (GUI → View → Simulation camera → Observer at), not a tether. The status line reports the distance from the station without a limit.

**Reason:** The owner asked why a leash was needed, and nothing needs it. The promotion bubble (decision 49) follows the simulation view's camera wherever it is; terrain, trees and buildings stream around the camera and are bounded by the horizon (decision 116), not by the station; the free camera already roams without one.

### 119. Terrain prefetch in the promotion bubble and ahead of the camera; the tile budget checked against the bounded radius

**Date:** 2026-11-12
**Decision:** The simulation view's terrain loads data before the view needs it, within the bounded radius of decision 116, and a test holds the tile memory budget to that radius (`render/common/terrain/prefetch.ts`, `terrainBudget.ts`).

- **The bubble.** The level-7 data tiles (about 48 m samples) within the promotion bubble, 20 km around the camera's nadir (decision 49), load at the lowest priority and are never evicted while inside it. These are the tiles line of sight, trees, buildings and the ground under the eye read. `tilesWithin` finds them by a flood fill from the tile under the nadir, across face seams, with the exact tile distance of decision 116; a 20 km bubble holds a dozen to a few dozen tiles (about 12 km each), 6–20 MB. The set is recomputed when the nadir has moved 2 km. Wherever the camera is, this covers decision 64's ground-combat region tiles inside the bubble, so the renderer does not need `regionTiles`; the sim worker's line of sight (C3, P1) will, since the renderer's cache lives on the main thread.
- **Look-ahead.** The scene estimates the camera's velocity from its eye positions (`MotionEstimate`, smoothed over 0.3 s; a move faster than 50 km/s, such as a jump to another station, counts as a jump and resets it). While the camera moves faster than 1 m/s, every fourth frame the renderer selects tiles from where the eye will be in 3 s, looking the same way, with "ready" meaning that a tile's data is cached rather than its mesh. That selection descends wherever data exists and stops where it is missing, so its wanted list is exactly the data a mesh there would lack. Tiles without meshes take their bounds from their data's height range, padded for render detail; with the planet-wide peak instead, the look-ahead would refine everything near the camera (decision 69). The wanted list is requested every frame until the next pass. Only data is fetched ahead: meshes still build when the view needs them, within the frame's 8 ms budget.
- **Priorities.** The view's own requests carry their screen-space error (above 2 px), trees and buildings 1, the look-ahead 0.6–0.9 (rising with the error) and the bubble 0.25–0.5 (nearest first). The loader serves one batch of eight at a time, highest first, so prefetch uses only time the view leaves idle.
- **Budget.** At true scale, 4K and mountains up to 5 km everywhere, the selection's working set anywhere from 2 m to 20 km, plus the bubble, is at most about 205 meshes and 130 data tiles: about 75 MB of meshes and 70 MB of data against the 600 MiB default's 330 MiB and 270 MiB shares. A test holds the worst case under half of each share, leaving the rest for the look-ahead and for turning back. The default stays at 600 MiB until true-scale relief lands, since the current 10× exaggeration needs more meshes (the tower view settles at about 350); a smaller default may then suit tablets. The sizes and the default moved from the renderer into `terrainBudget.ts`, where tests can read them without three.js.
- **Measured** (headless, lavapipe, the `tower` view at today's 10×, 120 frames at 30 fps flying forward with ×5 while climbing, so the observer goes from 19 m and 400 m/s to 2.3 km and 23 km/s in 4 s). With prefetch, no tile waited for data in the first 20 frames, against 4–16 without; the bubble held 16–20 tiles, all loaded. Past about 40 m and 1 km/s both runs saturate alike (6,297 against 6,619 tile-frames waiting over the run, 5% fewer), and the look-ahead goes quiet: 3 s ahead still lies inside the bubble's level-7 tiles, while the waiting tiles are coarser ones toward a horizon that widens as the camera climbs. The bound there is generation throughput, one batch of eight tiles in flight, not prediction. The run is an extreme case; level flight at the observer's normal pace stays within what the loader keeps up with.
- **Controls.** GUI → View → Terrain tiles → Prefetch (bubble, ahead) turns both off, to compare. GUI → Status → Tiles shows the bubble as loaded/total and the look-ahead's requests while moving. The terrain's stats also count `waiting`: tiles the view wants but cannot build for lack of data, which is what prefetch should lower. The preview's `FLICKER` loop can move the observer (`FLICKER_FORWARD`, `FLICKER_CLIMB`, `FLICKER_BOOST`) with prefetch on or off (`PREFETCH=0`).

**Reason:** V1 bounds the simulation view's terrain by the horizon so that streaming and memory stay bounded (decision 116, Proposal 0001). Within that bound, detail arriving late is the visible cost: a coarser tile stands in near the camera until its data is generated. The observer now flies anywhere at up to ten times its height per second (decisions 115, 118), and P1's aircraft will be faster still at low level, so the view should not wait for data it could have predicted. The bubble anticipates what the ground layers and the sim need around the camera regardless of where it looks.

### 120. Rivers reflect only their true width

**Date:** 2026-11-12
**Decision:** A river drawn wider than it is, for legibility (decision 46: at least 2 px, at 0.8 strength), keeps its widened water color but reflects the sun and sky only over its true share of the pixel. `RiverShading.coverage` returns both the drawn coverage and the true pixel fraction (legibility 0); the water shader scales the glint and sky reflection of river-only water by their ratio, and widens its GGX lobe (α² + 0.5 × the part of the drawn river that is not water). Banks, bends and ripples average out within a pixel the river does not fill, so its glint spreads instead of saturating: glint off level water is hundreds of times brighter than sunlit land, and the share alone (5% of a pixel) still left the pixel white.

- **The bug.** The owner saw white glitter on land in a band at a distance, looking toward the sun from altitude on the tablet. Sun glint off level water peaks where the view's depression angle equals the sun's elevation, so every river at that distance lights up together. A 10 m river in 40 m pixels was drawn 80 m wide at nearly full strength and reflected the sun over all of it, about eight times its real water; seen at a grazing angle it broke into chains of saturated dots.
- **Measured** (headless, the observer 1.5 km above the main airbase facing the sun, 6° down): 157 isolated bright pixels below the horizon (luminance over 200, 60 above their neighbors), all within 20 rows of the horizon, where the haze toward the sun is brightest. With buildings off, still 157, so buildings are not the cause; with rivers at their true pixel fraction (`RIVERS=0`), 72. The remainder sits in the bright band itself: sea and lakes near the horizon and the patchy edge of the band. After the fix: 128 with the true share alone, 96 with the wider lobe as well; pixels blown out to near white (every channel at least 245) went from 11 to 0. The remaining river pixels are light lines in the haze band, about (222, 204, 174), not glints.
- A GPU test checks that with legibility 0 the two coverages agree, and that at the app's legibility a 40 m river in 400 m pixels draws over most of its widened line while its reflecting fraction stays near 5%.

**Reason:** Legibility is a choice about the river's color on the ground, made so that thin rivers read as lines from altitude. A reflection is physics: a pixel that is 5% water reflects 5% of the sun. Part I asks for a soft glint column, not sparkle.

### 121. Landmasses scale with the planet; landforms keep Earth's proportions

**Date:** 2026-11-12
**Decision:** Decision 14's relief scale (0.157) now applies to landmasses (continents, ranges, plateaus), not to landforms (hills, valleys, ridges). Erosion still carves the eroded surface in Earth reference meters (decision 23); on the way back to physical meters, relief above the local valley floor is multiplied by a landform gain (`LANDFORM` in `worldgen/gpu/erosion.ts`). The simulation view shows true scale (1×) by default.

- **The owner's concern.** At 9.853° N, −48.200° on seed 1983 the hills and mountains read as uniform high-frequency noise, with no valleys or bigger features. Measured with the new `tools/relief.preview.ts`: across the 40 km the simulation view sees from low altitude, the ground spanned 160 m, with an RMS height difference of 28 m between points 10 km apart in the global grid; the tile detail added as much again at 0.1–1 km, evenly everywhere, and its first octave was about four times stronger than the global grid's nearest one. At true scale that is a nearly flat plain with texture.
- **The cause.** Decision 14 scaled every height by R / R_Earth so mountains look proportionate on the globe. That is right for features whose width also scales with the planet. Hills and valleys are not such features: their slopes come from erosion and rock strength, which do not depend on the planet's size. Scaling them flattened every landform sixfold.
- **The landform gain.** After the erosion iterations the valley floor V is the eroded height's minimum within 20 km (half the 40 km wavelength that splits landforms from landmasses), blurred; on land h_phys = (h + (gain − 1) · blur(h − V)) · reliefScale, with gain 5 and the relief above the floor blurred over two cells. Valley floors and the coast stay where erosion left them, so rivers still drain and nothing sinks below the sea; slopes and ridges rise. The blur keeps the stepwise descent of a channel across the grid from being magnified into terraces. It also raises narrow channels toward their banks, which made closed hollows: 9.5% of the land became lakes (0.01% before). A breach pass follows (128 gather passes): wherever the eroded surface ran downhill from a donor to its receiver, the receiver is lowered to 0.05 reference m below the amplified donor, never below its eroded height, and the cut carries downstream from pass to pass, as an overflow would cut through a rim. Erosion lakes, whose routing runs uphill over the spill, are left alone. Lakes are then 0.15% of the land, mostly deep ones in mountain valleys, with the relief statistics unchanged. Drainage, lakes and rivers are recomputed on the CPU afterwards, as always.
- **Tried and dropped.** Unscaling the short octaves of the global detail noise changed nothing (its ridged octaves carry little energy below 40 km). A dedicated landform noise layer of the right amplitude made closed hollows hundreds of meters deep; erosion filled them into flat plains between ridges, and with gentler incision kept the blobs instead. Noise makes hollows; real river landscapes have almost none. Amplifying what erosion carved keeps its dendritic, drained structure.
- **Tile detail.** On land the detail octaves (2.3 km to 100 m) are multiplied by the gain as well as reliefScale, with their base amplitudes halved (12 reference m on plains, 0.025 per meter of uplift), so they continue the global grid's spectrum instead of dominating it. They follow the landscape position from the global grid (height minus the mean on a ring 3 km out, over 8 m plus half the height change along the slope): a quarter of full detail on valley floors, full on ridges. Forest thins on physical global slopes of 0.5–0.8.
- **Climate.** Decision 19 reads elevation as physical height ÷ reliefScale. The landform excess is Earth-scaled, so it should count at its physical height; erosion raises each land cell's sea-level temperature by the lapse rate × the excess (amplified minus eroded, reference m) × (1 − reliefScale), and every reader of physical height ÷ reliefScale (biomes, treeline, snow and season in the shaders) gets the temperature of the Earth-like elevation unchanged. The one rule that reads elevation itself, the alpine biome above 2,600 reference m, subtracts the same correction (map `landformExcess`, passed to the finish step); without it alpine covered 12.9% of the land instead of 4.0%. With it, 7.6%, and ice sheets 5.2% (3.8% before): ridges and peaks now stand hundreds of meters higher in Earth-like terms, so more of them are above the treeline.
- **Rock.** The simulation view's rock on steep ground now uses the physical slope (19°–35°), not slope ÷ reliefScale, which would have turned every landform-scale hillside to rock.
- **Talus.** Unchanged: thermal erosion runs in reference meters before the gain. A thermal test now runs with gain 1 (`runErosion`'s `landform` option).
- **Measured** at the owner's spot (1024² global grid, 1× shading): across 300 km the RMS height difference is 42 m at 1 km, 102 m at 3 km and 233 m at 10 km (13, 25 and 52 m before); across the 40 km window the ground spans 472–1,003 m (160 m before), with 29 m at 1 km and 139 m at 10 km. Planet heights reach 4.7 km (about 1.4 km before). The 300 km view shows a dendritic valley network cut into rolling uplands, with a sharp range to the east.
- **Unchanged.** The coarse pass (256², no erosion) and everything that reads it: the strategic graph, theaters, casting, peak names and their labeled heights. `GENERATOR_VERSION` 12 regenerates cached worlds.
- **True scale.** The simulation view's exaggeration defaults to 1 (GUI → View → Height exaggeration, still 1–40), the decision-14 relief it was exaggerating to show having been the problem. At 8 km facing the sun this also drew 13 tiles instead of 107 (decision 120's measurement). The strategic view keeps its own 4×.

**Reason:** The owner wants erosion to smooth hills and fill valleys, bigger geographical features and more height difference in the simulation view, and approved this proposal: planet-scaled landmasses, Earth-scaled landforms. Applying the gain to the eroded surface, rather than adding landform noise before erosion, keeps the drainage structure erosion produces and leaves the coast and the campaign untouched.

### 122. Landform gain 12 for dramatic vistas; a soft limit near Earth's highest peaks

**Date:** 2026-11-12
**Decision:** The landform gain of decision 121 goes from 5 to 12, and above 6.5 km physical land rises at 40% of the rate (`LANDFORM.peakSoftLimit`, `peakCompression`), so the tallest massifs end near 8 km. The simulation view stays at true scale (1×) by default: the drama is in the world's heights, not in a display exaggeration.

- **The owner's review.** At 1× after decision 121 the terrain looked flat and uninteresting; with the exaggeration slider at 10–20× it looked much better. The owner wants Earth-scale variation even though the world is smaller, and dramatic vistas.
- **Why not the slider.** Exaggeration is display only (decision 31). From P1, aircraft, terrain following and line of sight use physical heights; a displayed mountain the physics does not know about would be a bug. So the physical relief should be what the owner liked, and 1× should show it.
- **Measured** at the owner's spot (9.853, −48.200, seed 1983) with gain 12, before the soft limit: across 300 km the RMS height difference is 105 m at 1 km, 247 m at 3 km and 565 m at 10 km (233 m at gain 5, 52 m before decision 121; the owner's 10× of the old terrain was about 520 m); across 40 km the ground spans 500–2,056 m. Planet heights reached 10.8 km, hence the soft limit. Lakes cover 0.38% of the land, alpine terrain 14.5% and ice 7.8%: taller mountains are colder.
- **Climate, redone.** At gain 12 the renders showed the owner's tropical upland, about 1 km up at 10° N, under snow. The simulation view's and the map's snow read the climate texture, built from the tectonic world at 6 km cells, which never saw decision 121's sea-level-temperature correction; and no field at that resolution could carry it, since the correction differs between ridge and valley. The Earth-like elevation is now defined from a smooth field: the valley floor F (physical m) at the planet's scale plus the height above it at Earth's, E = min(h, F) ÷ reliefScale + max(h − F, 0) (`earthElevation` in `worldgen/climate.ts`, `earthElevationNode` in `render/common/seasons.ts`). Erosion writes F as map `valleyFloor`; the finish step uses it for biomes and inverts it for the treeline (`heightAtEarthElevation`) and downsamples it to the display grid; the climate texture carries it in channel A (cloudiness, unused since decision 68), so both views' snow, seasons and forest shading use it. Before the global pass delivers F, channel A holds each cell's own height, which gives height ÷ reliefScale as before. The sea-level-temperature correction and the `landformExcess` map of decision 121 are gone.
- **Measured with the soft limit and the floor:** planet heights −897 to 8,239 m; alpine terrain 9.6% of the land and ice sheets 6.2% (4.0% and 3.8% before decision 121); lakes 0.38%. The relief at the owner's spot is unchanged.
- **The strategic map** keeps its own 4× for now; its relief at landform scale is about 2.4 times taller than at gain 5. Owner check in TODO.

**Reason:** The owner's direction: Earth-scale variation and dramatic vistas at true scale. A soft limit rather than a hard cap keeps summits shaped and drainage unchanged.

### 123. Faceted flat shading on the simulation view's terrain

**Date:** 2026-11-12
**Decision:** The simulation view's terrain shades each mesh triangle with its own normal, as Part I asks (_Rendering Model_, _Terrain_), instead of the interpolated vertex normal (`render/sim/terrain/facets.ts`).

- **The normal.** The fragment shader takes the cross product of the screen-space derivatives of the fragment's camera-relative position. A position interpolated across a triangle lies in its plane, so this is the triangle's normal, constant over it, and the mesh needs no extra vertices. Camera-relative positions keep the same relative precision at every distance, so the normal stays clean near the camera; mesh-local positions would lose it at a 2 m eye height. The sign depends on the screen's handedness, so the normal is turned to face up. Skirts hang straight down, where the sign is undefined; there the smooth normal stands in. The normal is computed once, before the material's per-fragment branches (decision 69), and drives the land's and the roads' diffuse light. Water keeps its own wave normal around the radial direction, so the sea's glint does not break into the mesh's triangles.
- **Facet size.** The finest tile level (10) has 24 m between vertices, so facets near a low camera are 24–34 m, inside the guide's 20–60 m. Farther out, the screen-space error criterion (2 px, with relief assumed at 5% of the vertex spacing) coarsens the mesh at the rate it shrinks on screen: a tile splits when its vertex spacing exceeds about 40 px. Facets therefore stay about 20–40 px across at every distance, growing in meters, rather than shrinking below a pixel as the guide said; haze softens them toward the horizon. The guide now says so.
- **Geomorphing.** Child tiles split their quads along the same diagonal as the parent, and at morph 0 their odd vertices sit on the parent's edges and diagonals, so every child triangle lies in the plane of the parent triangle containing it: a split begins with exactly the parent's facets and bends them continuously as the morph runs. A test checks this to within 1e-3 rad (a wrong parent triangle gives 0.037), and that the finest level's facets are within 20–60 m.
- **Controls.** GUI → Lighting → Faceted terrain turns it off, to compare; the preview's `FACETS=0` renders smooth shading into `-smooth` files. Rock, snow and the land's albedo still read the smooth vertex slope; per-face shades and rock and snow by face are the next V1 tasks.
- **Seen in the preview** (`low`, 2 km): the facets read, but on gentle ground as a grid of squares rather than carved triangles, since the mesh is a regular grid with one diagonal direction and a quad's two triangles have nearly the same normal. Breaking the grid (for example, jittering each vertex by an amount set by the level at which it first appears, which keeps geomorphing exact) is a TODO, to judge after shade quantization.

**Reason:** Part I's first principle is hard geometry under soft air; smooth terrain shading was a style gap since decision 70. Derivative normals are the guide's own method, cost a few instructions per fragment and leave the mesh, its memory and the geomorphing unchanged.

### 124. Per-face shade quantization: the land albedo at each face's center

**Date:** 2026-11-12
**Decision:** The simulation view's land takes one of four shades per face, and its whole albedo is evaluated at the face's center, so color as well as light is constant per facet (Part I, _Shade quantization_; `render/sim/terrain/faceShading.ts`).

- **The face's center without new geometry.** Each vertex derives its grid coordinate in the tile from its vertex index (skirt vertices copy their edge vertex's). In the fragment shader the interpolated coordinate names the quad, and the quad's diagonal names the triangle, as `buildTileIndex` splits it. Every varying is an affine function of the grid coordinate across a triangle, so its value at the centroid is the fragment's value plus its gradient times the step to the centroid; the gradient comes from screen-space derivatives through the inverse Jacobian of the grid coordinate, which is exact under perspective. The renderer moves the biome color, raw height, radial direction, wrapped position and slope to the centroid this way and samples the climate texture there. The moisture tint, detail noise, autumn, rock and snow therefore hold per face. The forest density stays per fragment, so the canopy edge still follows its contour (decision 71). The alternative, flat varyings from a provoking vertex, needs a reordered index, gives the shade of a corner rather than the face, and cannot fade into the parent's shades during a split.
- **The shade.** A score of the low-frequency noise (the detail noise's octaves at least about two facets across, so it makes patches several faces wide rather than speckle), the physical slope, the Earth-like elevation (decision 122), the moisture and a per-face jitter picks one of `shades` (default 4) between a dark, lush multiplier (0.84, 0.89, 0.84) and a pale, dry one (1.14, 1.09, 0.97). It replaces the continuous ±12% detail brightness. Steep, high and dry faces lean pale, wet ones dark; the jitter breaks the patches' edges along facets.
- **Geomorphing.** At morph 0 a child tile shows its parent's triangles (decision 123), and now its parent's shades too: the evaluation point slides from the parent face's centroid to the child face's, the jitter cross-fades between the two faces' hashes and the facet size (which sets the noise's finest octave) from the parent's to the child's. Shades stay quantized, so each face switches at most a few times during the morph instead of all at once at the split. The jitter hashes a face's global quad index, level, cube face and half, so a parent face gets the same value drawn by the parent or as a child's morph target.
- **Tests** (compute kernels on Dawn): every vertex gets its grid coordinate, and skirt vertices their edge vertex's; at morph 0 a child's points evaluate the parent's face (centroid, jitter and facet size equal to the parent's own at morph 1), at morph 1 their own; distinct faces get distinct jitters.
- **Cost.** One more per-object uniform (the tile key), five derivative extrapolations and a second climate sample per fragment; the noise is still evaluated once.
- **Seen in the preview:** in `runway` (150 m) the ground near the camera reads as distinct flat triangles of a few shades; the grid of squares noted in decision 123 is broken up there. `low` (2 km) shows broader patches. `trees` is unchanged: its forest edge steps along a road clearing with or without facets, which comes from the density field.
- **Controls.** GUI → Lighting → Faceted terrain switches facets and per-face shading together; the preview's `FACETS=0` renders both off.

**Reason:** Part I asks for three to five shades per biome, constant per face, for the mottled, painted look of reference 2 without textures; with the albedo smooth across faces, flat facets showed only through light. Evaluating every land input at the face center also prepares the next task, rock and snow by face, which only has to replace their smooth blends with steps.

### 125. Rock and snow by face

**Date:** 2026-11-12
**Decision:** With faceted shading on, rock and snow cover whole faces or none, instead of blending smoothly with slope and temperature (Part I, _Rock and snow_; a style gap since decision 70). `LandShading.rockCover` and `snowCover` hold both forms; GUI → Lighting → Faceted terrain switches between them with the facets.

- **Rock.** A face turns to rock where its physical slope, plus the low-frequency noise, passes 0.52 (about 27°), the middle of the old 19°–35° blend. The slope is the vertex slope at the face's center (decision 124), not the facet's own tilt: the vertex slope comes from the data one sample apart, so a coarse distant face over a craggy slope still reads as rock, and rock does not come and go as the LOD refines. Rock takes three shades per face from the noise and the face's jitter, replacing its continuous ±25% noise.
- **Snow.** A face is snow-covered where the old smooth cover (cold from 0 to −5 °C, not on cliffs, thin in deserts) passes one half, about −2.5 °C on gentle, wet ground, at the face's center temperature. Snow takes two shades, 6% apart, so neighboring sunlit faces still separate. Evergreen canopy still keeps 60% of the snow off, per fragment, so forests stay dark in winter (decision 71).
- **Dither.** The face's jitter shifts each threshold slightly (±0.06 in slope, ±0.1 in cover), so the rock line and the snow line follow facet edges without tracing a smooth contour, and a few faces past the line switch early, as patches would.
- **Tests:** a compute kernel on Dawn checks that faceted covers are only 0 or 1 and switch at those thresholds with the jitter neutral, that the jitter dithers faces at the threshold, and that the smooth covers are the old blends.
- **Preview:** a new view, `alpine`, looks at the highest summit within 600 km of the main continent from 10 km. Faceted, its snow line runs along facet edges with scattered snow faces beyond it; smooth (`FACETS=0`), the old blends.

**Reason:** Part I wants transitions on face boundaries, so the terrain reads as built from colored facets rather than painted over them. With the albedo already evaluated per face (decision 124), a step in place of each blend is all it takes.

### 126. Memorable landforms: canyons, buttes, alpine crests, glacial troughs and lakes, skerries, deltas, meanders and falls

**Date:** 2026-11-12
**Decision:** Landscapes that people remember from Earth get generators of their own, each driven by the world's own climate and relief, never placed (rule 10). Most live in tile synthesis, where the observer sees them; two need the global grid. The owner asked for terrain on which Monument Valley, Niagara Falls, the Grand Canyon, Everest, the Nile delta, northern Sweden, the Stockholm archipelago, Lake Como and the Amazon are all possible at default settings in the observer camera.

- **Landform masks** (`worldgen/gpu/landformMasks.ts`). Four smooth fields on the global grid, built on the GPU when a `TileSynthesizer` is made and sampled bilinearly by the tiles: aridity (from the biome, blurred about 9 km), glaciation (tundra, taiga, ice and alpine biomes, and ground up to 900 m below the treeline outside deserts, spread about 12 km by a max filter, then blurred), land proximity at sea and sea proximity on land (1 at the coast, ×0.86 per cell, out to about 20 and 9 km). Aridity and glaciation go to the renderer in material bits 17–20 and 21–23, which were free, and from there into a `landform` vertex attribute.
- **Erosion filter with branching.** The gully term of the tiles (decision 28) now follows the gradient accumulated so far (the global slope, the alpine ridges and the coarser gullies), so finer gullies bend into coarser ones and branch like tributaries (after Clay John's and Rune Skovbo Johansen's erosion filters). Depth 0.35 × slope (capped at 1.2) × wavelength, 0.85 per octave, 30% on valley floors. The ridged detail noise it largely replaces drops to a third (`detailPlains` 6, `detailPerUplift` 0.008): seen from the observer, mountains read as drained ground instead of uniform noise.
- **Alpine crests.** On ground from 1.5 to 4 km with mountain uplift, two octaves of squared ridged noise (900 m at 3.7 km wavelength, then 0.45×) raise arêtes and horns, strongest on ridges, and up to 80% taller on ground from 4.5 to 7.5 km, so the highest massifs tower (Everest over the Himalaya); their gradient feeds the erosion filter, so gullies cut between the crests. Snow slides off faces steeper than about 30–45° (decision 125's limit was 42–56°), so high ranges show gray rock between snowfields. Warm, wet slopes (moisture above 0.3–0.55, Earth-like annual mean above 3–10 °C) hold soil and woods to about 44° instead of turning to rock at 27°, and forest thins on slopes of 0.7–1.05 (was 0.5–0.8).
- **Glacial troughs and lakes** (`GLACIAL` in `worldgen/gpu/erosion.ts`, after the landform gain and the breach). Glaciation comes from the Earth-like annual mean temperature (3 °C to −2 °C, an ice-age snowline), spread 12 cells downhill and around. Within 3 cells, a cell's position between the local floor and top is raised to the power 1.8: floors widen and flatten, walls steepen into U-shaped troughs. Valley floors with drainage above 200 km²·m/yr sink by up to 350 m × ice², so where the ice thinned the floor rises again and long lakes fill the troughs behind (Lake Como, the Swedish mountain lakes). Seed 1983: lakes cover 0.85% of the land (0.38% before); the deepest, 1.7 km, fills a glaciated trough. `GENERATOR_VERSION` 13.
- **Dry rock.** Where aridity is high, rock is layered in 75 m strata: each layer is stepped into a bench and a cliff by s ↦ s^p (p from 1.6 to 3.5 per layer), where a 30 km regional noise is high. Buttes and mesas rise about 320 m from dry plains and plateaus, where 3.5 km fBm noise crosses a threshold that varies over 45 km (sparse in most places, dense mesa country where the regional noise is high), with a talus apron below each cliff: isolated buttes 1–2 km across, several kilometers apart, as in Monument Valley. The renderer paints dry rock in five sandstone shades by layer over a red shale foot, and tints dry ground below the cliffs red (Grand Canyon, Monument Valley).
- **Rivers.** Lowland rivers (bed gradient under 0.12%, at least 25 m wide) meander in `RiverIndex`: a train of bends 11 widths long (±30% per bend) and 0.32 wavelengths wide, with a third harmonic that skews them, tapered to zero at both ends of each polyline so confluences and mouths stay put. Rivers through dry land get a green corridor 9 widths wide (250 m to 2.3 km) with clumped groves (the Nile). Warm rivers carry silt: river water's body color turns toward brown (`WaterShading.siltColor`) as the surface temperature rises from 10 to 22 °C, under the same sky reflection, so the Nile and the Amazon read brown from above and still mirror the sky at grazing angles. Mouths of rivers at least 140 m wide build deltas: a low fan from an apex upstream of the mouth, up to 26 km out, with lobate edges and seven distributaries that branch outward, only on ground lower than 12–40 m and out into the sea; the fan is green in dry land. On steep reaches (bed gradient 1.2–3%) the water surface steps down the 75 m strata in pools and drops over about 140 m, cutting a gorge about four widths across (the valley beyond keeps its slope), and the renderer draws river water on steeper than about 17–37° as white water (falls and rapids; Niagara's escarpment, the Grand Canyon's tributaries).
- **Skerries.** On glaciated coasts within reach of the shore, low land is flattened toward sea level, the sea floor shoals to 4–54 m by the land proximity whatever the global depth (it plunges within a cell of the coast), and five octaves of rounded knobs 44 m tall from 900 m wavelength rise through it: hundreds of islands within a few kilometers of the shore, thinning seaward: islands at sea, inlets and ponds on land (the Stockholm archipelago, Norway's skerry guard). New islands are bare rock with pines on the higher knobs. Dry coasts get none: glaciation spreads into deserts by the max filter.
- **Cliffs and the mesh.** Facets sharper than the 48 m baked samples stair-step along the mesh grid (a cliff band rendered as a sawtooth of lit and dark triangles), so cliffs and falls are kept at least two or three samples wide. Rock and snow keep decision 125's per-face switch; only the snow's slope limit moves.
- **Tile output.** Height, lake level and material now leave the kernel as one `vec4u` per sample, which frees a storage binding for the masks (WebGPU allows eight); delta records travel in the river segment buffer.
- **Tools.** `tools/landscapeSpots.ts` finds a spot for each kind of landscape (canyon, buttes, peaks, glacial, lake, skerries, delta, jungle, falls) and frames it from the observer on synthesized tile heights, with the sun behind and to the side; `SPOTS=all` (or a list) in `tools/render.preview.ts` renders them, `tools/spots.preview.ts` lists them, and `MASKS=1` in `tools/relief.preview.ts` maps the masks.

- **Climate scale.** Under decision 122's Earth-like elevation, a valley floor at 1 km physical is about 6 km up in climate terms, so most mountain lakes are cold and their walls bare; a Lake Como analogue (warm, wooded walls) needs a lake surface within a few hundred meters of sea level. The spot finder looks for one below 450 m.

**Reason:** The owner wants breathtaking, memorable terrain at default settings, and the generator only made one kind of landscape: rounded hills with noise. Each generator here follows a cause the world already has (dry climate, ice-age cold, drainage, coasts), so the landscapes appear where the world puts them and nowhere else, and the campaign layer, which reads the coarse pass, is unchanged.

### 127. Farmland patchwork in the simulation view

**Date:** 2026-11-12
**Decision:** The simulation view draws farmland as a Voronoi patchwork of crop colors, where the strategic map draws its farmland, on flat lowland (Part I, _Farmland_; `LandShading.farmCover` and `fieldColor`).

- **Where.** The map's rule (decision 80): settled land, the strategic graph's habitability rising from 0.25 to 0.45, in farmable biomes (temperate grassland and forest, shrubland, savanna, tropical seasonal forest). Here also flat, under about 5–9° of physical slope, and lowland, under an Earth-like elevation of about 1.2–1.8 km. The farmable set moves to `render/common/palette.ts` (`FARMABLE_BIOMES`), shared by the map's biome fill and the tiles. Tiles carry it as a third component of the landform attribute (decision 126), since WebGPU's eight vertex buffers are all in use; `MESH_TILE_BYTES` now counts every attribute (25 floats per vertex, 21 before). Faceted, a face is a field or not, at its center (decision 124) and dithered by its jitter; smooth, the cover blends.
- **The fields.** One Voronoi site per 256 m lattice cell on the wrapped coordinates (decision 38), in 3D, so the ground cuts the cells into irregular polygons a few hundred meters across, some smaller; the lattice tiles with the wave period. A field's hash picks wheat, fallow, green crop or pasture from Part I's palette, with more wheat on drier land (45% to 20% as moisture rises) and ±6% brightness per field. The face's shade (decision 124) tints a field at a third of its strength, so faces still separate within a field. Each face takes the field at its center, so field edges step along facets. Where the facet (or, smooth, the pixel) outgrows the fields, colors draw up to 60% toward the crops' mean, so distant faces do not speckle. Forest canopy, built-up patches, autumn and snow draw over fields as over other ground. Only farmed points run the 27-cell search.
- **Tests:** a compute kernel on Dawn checks that farmland needs all of settlement, a farmable biome, flat ground and lowland, switches whole faces, and blends when smooth; that fields along a 3 km line take crop colors within ±6% and change a plausible number of times; and that the far blend narrows their spread. A CPU test checks the farmable flag in tile meshes.
- **Preview:** a new view, `farmland`, looks from 2 km over the most settled farmable lowland within 600 km of the main continent; `FARMLAND=0` leaves the fields out. It shows a patchwork of fields between dark forest masses, muted toward the horizon. GUI → Lighting → Farmland switches it in the app.

**Reason:** Reference 2's patchwork is the main thing that tells inhabited lowland from wilderness at a glance, and Part I asks for it. Placing fields by the map's own rule keeps both views agreeing on where people farm; evaluating fields per face keeps them in the faceted style of decisions 123–125.

### 128. Simulation preview views for Part I's checks, all within 20 km

**Date:** 2026-11-13
**Decision:** `tools/render.preview.ts` names one view per Part I acceptance check and keeps every simulation-view preview within the view's 0–20 km envelope (decision 72). `VIEWS=checks` renders the five.

- **The checks.** Each looks at a place the preview finds in the world, so every seed has its own check views; `tools/checkViews.ts` holds the searches.
  - `mixed` (check 1): 5 km above the town or city near the main continent with the most even mix of forest and open farmable ground within 6 km and a river (discharge at least 40 m³/s) nearby, with the sun behind and to the side.
  - `conifer` (check 2): 500 m above a road through a forest edge. Road points with taiga and open ground within 2 km are ranked on the global grid, preferring the main continent's side of the world, and the best eight, at least 30 km apart, are judged on synthesized level-7 tiles. The tiles cut the global forest by the treeline at the fine height, slope and water, so the global grid alone picked a road through bare plateau (13 taiga cells in the grid, no canopy in the tiles).
  - `range` (check 3): 12 km beside the highest summit within 600 km of the main continent (decision 125's `peak`), when the sun has sunk to 8°, lit from the side.
  - `dusk` (check 4): the existing view down the main airbase's runway at sunset, now with trees and buildings.
  - `beach` (check 5): 1.5 km above a low, warm coast (land under 25 m in a warm biome, little relief) with the broadest shelf shallower than 40 m within 4.5 km, facing the sun for its glint.
- **View fields.** `sunHeading` turns a targeted view relative to the sun's azimuth at the target and stands back from it along that heading; `detail` turns trees and buildings on for that view (`DETAIL=0` still turns them off); `check` marks the five.
- **Retired and re-aimed.** `oblique` (20 km), `coast` (80 km), `glint` (40 km), `mountains` (25 km) and `roads` (60 km) are gone: the strategic previews cover those scales, and `range` and `beach` replace the two that served checks. `lake` moves from 30 to 8 km and `night` from 1,500 km to 6 km over the largest city at 23:00. `winter` moves from 1,500 km to 2 km over the check-2 forest edge on its hemisphere's midwinter day (field `midwinter`: 150 days after the campaign's start in the main continent's hemisphere, 335 in the other), and `sea` and `shore`, whose fixed offsets land on dry ground in today's worlds, look at the check-5 coast (amended during the style audit, `docs/style/audit-sim-2026-11-13.md`). The strategic set keeps its own `winter` and `night`.
- **What the first run on seed 1983 shows** (gaps in TODO under the task): `range` and `dusk` match their checks (faceted rock and snow at low sun with layered haze; a lit runway, hangars and buttes against an orange sky). `conifer` shows conifer trees along a forest edge, a road and a town at the edge. `mixed` looks down onto a cloud layer that ends in a hard straight edge across the frame; without clouds, forest, roads, towns, fields and distant mountains read, but the river does not. `beach` shows the glint, the shallow teal shelf and the foam line, but no sand. `dusk` has no parked aircraft yet.

**Reason:** Part I's checks are only useful if they look at what they name, in the simulation view's own envelope. Fixed offsets from the main continent's center found sea or bare ground on other seeds, and several old views looked from heights the simulation view no longer reaches.

### 129. Lakes held to their cells, land biomes on raised ground, shallow water at Earth depth, and reefs

**Date:** 2026-11-13
**Decision:** Four fixes and one addition from the owner's review of archipelagos after decision 126.

- **Lake spill.** A lake's level is the spill height of its 1.5 km global cells, and the tiles define it on dry ground within about a cell of the lake, so the shoreline can follow the fine terrain (decision 40). Decision 126's gullies and crests cut hundreds of meters into trough walls; wherever they went below the level, the lake flooded them out to the edge of that reach, in blocky light-blue patches that ran crosswise to the lake (the owner's screenshot: the real lake along a diagonal trough, the spill as bands across it). Now detail calms toward the level, reaching full strength 120 m above it (`lakeCalm`), and outside the lake's cells (the bilinear share of lake cells below 0.3–0.5) ground below the level is raised to 0.6 m above it. On a trough lake on seed 1983 the water area fell from 15,078 to 8,047 samples against 8,510 lake samples; it matches the lake's cells.
- **Biomes on raised ground.** Land that the tiles raise over global sea or lake cells (islets, coastal ground, dry lake shores) took the cell's water biome and was painted in the shelf's light blue. Now any dry sample on a water biome takes the biome of the nearest land cell in the 5×5 around it, or one by latitude where there is none (savanna, grassland, tundra). On the archipelago of the review, 6,896 such samples became 0. Skerry islets stay bare rock and reef islets sand.
- **Shallow water at Earth depth.** Water color counted depth in reference meters (÷ relief scale, decision 14), so 20 m of water looked like 127 m: lagoons and skerry sounds were as dark as the open sea. Standing water now counts its first 8 m physical at Earth depth, blending to reference depth by 60 m (`shallowDepth` in `waterShading.ts`, and the seabed color in `tileMesh.ts`); rivers keep their nominal depth, so their silt still reads.
- **Reefs.** A second word of landform masks carries a warm-coast proximity (tropical forest, savanna and hot desert spread out to sea like the land proximity). Along warm coasts a reef crest about 260 m wide runs offshore at a distance that varies over 14 km, with a sandy lagoon 3–9 m deep behind it and the open sea beyond; noise breaks the crest into reefs and passes, and its high points break the surface as sand islets. The crest's depth near zero gives the shore foam a surf line. The distance is read from the blurred land proximity, which falls faster than the true distance near the coast, so the tuned 3.5–8 "km" put the crest about 1–4 km out.
- **Tools.** `SPOTS=reef` frames a warm island from 6 km out at 600 m.

**Reason:** The owner found the archipelagos wrong (raised light-blue areas unlike the sea) and asked for lighter water in shallows and reefs. Holding lakes to their cells and giving raised ground a land biome remove artifacts decision 126 made common; counting shallow depth physically makes the shallows the owner expects visible without changing deep water.

### 130. Ragged coasts, lake shores that wander, darker lakes, and salt pans

**Date:** 2026-11-13
**Decision:** Second pass on the owner's archipelago review. The light-blue patches still seen above sea level were real lakes from the global drainage: shallow ones, which decision 129's Earth-depth shading made pale enough to read as ground, held to their cells in staircase outlines, and many in dry land. The coast, meanwhile, was the global grid's smooth zero contour: tile detail never crossed it.

- **Ragged coasts.** In a band either side of the coast (sea proximity above 0.55–0.95 on land, land proximity above 0.3–0.8 at sea, decision 126's masks), five octaves of fractal noise from 3.2 km raise and lower the ground by the local slope × 900 m, clamped to 2–45 m: headlands, coves, inlets and offshore rocks, so the shore moves by up to about a kilometer. Not in lakes; skerries, deltas and reefs are built on top.
- **Lake shores.** The lake share of decision 129 is read at a noise-warped position (0.9 cells, the biome jitter's field) against a noisy threshold (0.42 ± 0.12 over 700 m), so shores wander instead of tracing the cells' staircase.
- **Darker lakes.** Lakes are colored at reference depth again, and at least as deep as 6 m physical: they read as water. Decision 129's Earth-depth shallows apply to the sea only.
- **Salt pans.** The drainage fills every closed hollow, whatever the climate. Where aridity is high (0.45–0.65), a lake's floor becomes a flat salt pan a little below its level, in the ice sheet's white, with no water (Bonneville, Etosha).

**Reason:** The owner saw light-blue regions above sea level and regular coasts in one place, and ragged, convincing archipelagos in another. Lakes must read as water and keep organic shores, dry basins should be pans rather than water, and coasts need detail across the shoreline itself.

### 131. Frame budgets over 0–20 km: trees and buildings culled by the frustum, trees thinned with distance

**Date:** 2026-11-13
**Decision:** The simulation view meets Part I's draw-call and triangle budgets everywhere in its envelope. Tree and building tiles outside the camera's frustum are no longer drawn, and beyond 1.5 km tree clumps thin with distance.

- **Measuring.** The headless preview cannot time a real GPU, but draw calls, triangles and CPU time per frame do not depend on it. `PERF=n` now counts triangles of non-indexed instanced meshes (trees and buildings counted as zero before) and prints the median and maximum CPU per frame. A new view, `ceiling`, looks from 20 km. Measured at 1408 × 792 (about 75% of 1080p), trees and buildings on, ten frames per view, seed 1983.
- **Before.** Draw calls stayed under 150 (budget 500), but triangles reached 6.0 M in `trees` (700 m over dense forest; budget 2 M), 4.4 M in `farmland`, 3.8 M in `conifer`, and 2.1–2.5 M in `runway`, `mixed` and `tower`, nearly all trees: `trees` drew 141,000 clumps of four, about 564,000 trees within 5 km. Tree and building tiles had `frustumCulled` off and no test of their own, so every tile within range was drawn, behind the camera too.
- **Frustum culling.** Each tree or building tile gets a bounding sphere when built, from its instances' base points and ground heights (`render/sim/instanceBounds.ts`; 45 m of margin for trees, 150 m for buildings and masts), placed at the current height exaggeration. The scene passes the camera's frustum to both layers, which hide tiles whose sphere lies outside it; the test is the terrain's own (`sphereOutsideView` in `quadtree.ts`). `trees` dropped to 2.3 M tree triangles.
- **Distance thinning.** A clump at distance d is kept with probability (1.5 km / d)², at least a quarter (`thinKeep`). Clumps are shuffled once when a tile is built (a deterministic Fisher–Yates per tile and kind), so a clump's rank (index + ½) / count is a uniform draw. The vertex shader shrinks a clump away over a rank band of 0.05 as the keep fraction at its own distance falls past its rank, so clumps leave one at a time, not tile by tile; the CPU draws only the ranks kept at the tile's nearest point, which includes every clump the shader can keep. Within 1.5 km every clump stays, as Part I's 0–1.5 km band asks. This stands in for the merged cluster meshes of Part I's 1.5–5 km band until V2's tree LOD: the terrain's canopy shading (decision 71) shows through more and more toward 5 km.
- **After** (draws; triangles; median CPU per frame):

  | View | Draws | Triangles | CPU |
  |---|---|---|---|
  | `tower` (2 m) | 73 | 0.52 M | 7.9 ms |
  | `runway` (150 m) | 58 | 0.45 M | 7.1 ms |
  | `conifer` (500 m) | 87 | 1.18 M | 7.3 ms |
  | `trees` (700 m) | 54 | 1.69 M | 6.4 ms |
  | `low` (2 km) | 36 | 0.33 M | 5.7 ms |
  | `farmland` (2 km) | 43 | 0.72 M | 7.9 ms |
  | `mixed` (5 km) | 65 | 0.53 M | 8.1 ms |
  | `alpine` (10 km) | 23 | 0.22 M | 5.0 ms |
  | `range` (12 km) | 28 | 0.27 M | 5.5 ms |
  | `ceiling` (20 km) | 16 | 0.16 M | 4.5 ms |

  The software renderer's frame time fell by about half in the forest views (`trees` 2.1 s to 0.8 s), which says the GPU work fell too, not how fast a real GPU runs it.
- **Not settled here.** The 60 fps budget needs a real GPU: an owner check on the desktop and the tablet, and GPU timestamp queries (I1). Every ten-frame run also has one frame of 170–320 ms CPU, in a different layer each time, most likely garbage collection in the preview's heap of several GB; the browser needs its own check for hitches.
- **Tests:** the sphere contains every instance as drawn at exaggerations 1, 4 and 40; the frustum test culls spheres behind and beside the camera and keeps those reaching into it; `thinKeep` and the shuffle (deterministic, a permutation of whole rows).

**Reason:** V1's last measurable task is frame time over 0–20 km within Part I's budgets. Culling is what the terrain already does and costs a sphere test per tile; thinning keeps the near band at full density, where trees read individually, and spends triangles where they show.

### 132. The air war's data model, analytic flights and an interim tasker (C2)

**Date:** 2026-11-13
**Decision:** The first half of C2, agreed with the owner: the order of battle, carrier groups, missions with analytic routes, and flights on the map, fed by an interim tasker until the rule-based ATO (decision 50) exists.

- **Aircraft types.** `sim/air/aircraft.ts` holds 31 fictional types, one or more per role and side in the design's table, with a real reference type, SI performance, combat radius, station time, fuel, turnaround and loadouts. The existing models fix three roles differently from decision 106's labels: the F-21 Kestrel (F-16-like) is the Alliance multirole fighter, so the new F-25 Peregrine (F-15) is its air superiority fighter; the Vo-35 Molot (Su-25-like) flies close air support, so the new Vo-37 Grom (Su-24) is the Pact's deep striker. The maritime bomber (Tu-22M analogue) is a Pact-only role; the Alliance's B-52 analogue covers both.
- **Fuel.** Flows are multiples of a cruise flow by regime (climb, cruise, low level, loiter, combat, descent). The cruise flow is calibrated so that the type's typical profile (out and back over its combat radius plus its station time) uses its fuel less a 10% reserve. The range factor multiplies the fuel load; flows stay real, so the radius scales by the factor. This is how the design's "scales fuel capacity and burn rate" is meant, and the design now says so.
- **Order of battle** (`sim/air/orbat.ts`, `rng("orbat")`). Squadrons by airbase kind and depth behind the front; every role a side has gets at least one squadron; Pact regiments are larger. Bases hold fuel and munitions for 30 days at two sorties per aircraft and day (10 at sea); missions draw on them. Aircraft are conserved: available, on missions, or in turnaround.
- **Carrier groups** (decision 56; `campaign/carriers.ts`). Casting sends the Alliance one group to each sea-lane, chokepoint and island theater (at most three) and the Pact one to each island campaign and chokepoint (at most two). Each group starts the war on station and patrols a 160 km stretch of a sea lane at 15 kn, so its position is closed-form. Its air wing launches and recovers at the group's predicted position and flies only in the group's theater until C3 tasks carriers between theaters. The cast gains `carriers`; the generator version goes to 14.
- **Missions and routes** (`sim/air/mission.ts`, `route.ts`, `missionRoute.ts`). A mission is one flight on one route; a package groups the flights planned for one need. Routes are segments with start and end times: great-circle legs with climb and descent at the type's rates, racetrack orbits on station, and ground time. Position, altitude, heading and fuel at any time are closed-form, and the phase timeline is known when the mission is planned. Phase events mark state changes only. Winds aloft are not applied yet. Altitudes are above sea level; low level is 100 m until terrain following comes with the execution layer (V4, P1).
- **Interim tasker** (`sim/command/tasker.ts`, `rng("ato")` forked per side and hour). Every game hour it collects needs (standing CAP at the fronts, over carriers and island fields; AEW and tanker orbits; close air support; strikes on fixed sites with escort and SEAD; reconnaissance; airlift), ranks them by score with ties broken by key, and fills each from the nearest squadron in range, at most 24 aircraft per side in the air. The Alliance spreads its strikes; the Pact launches a wave with a common time on target every three hours. Steps 5 and 6 of C2 replace it with the ATO.
- **Known targets.** Fixed installations (airbases, industry, depots, rail yards, ports) are known to both sides at the outbreak from peacetime intelligence. The intelligence picture of decision 53 tracks what moves and what was hit: convoys, naval groups and ground units are targets only once it holds them, so the tasker strikes none of them yet.
- **Worker and map.** The sim worker sends the full list of live missions when it changes (a planning tick, a completion) and after init and seek; the main thread computes positions from the routes at the display time. The strategic view draws flights as small aircraft icons with their heading and a four-minute trail, and carrier groups as ship icons, in faction colors, above the military overlays. GUI → Map → Air war toggles them, draws every route as a debug view (the guide's routes on hover and selection wait for mission search), and sets the viewing side; its default, both, shows ground truth until the intelligence overlay exists.

**Reason:** The owner asked for the gameplay track after the terrain work. These four steps give the war a visible air traffic on the map at any time acceleration, with every model the ATO, intelligence and the chase camera (V4) build on, while keeping the planner simple enough to replace.

### 133. Map icons as badges that stand out and can be clicked

**Date:** 2026-11-13
**Decision:** The owner found the map's icons too subtle: the air war's flights read as faint crosses, and site symbols were thin outlines in a faction color over a busy map. Every icon becomes a badge with a solid backing, sized in screen pixels at every zoom, and flights and carriers can be selected.

- **Two kinds of badge.** Forces that move (flights, carrier groups; convoys and formations later) are discs filled with the faction color, a dark 1.5 px rim and a pale symbol. Fixed sites (airbases, ports, industry, depots, rail yards) are pale rounded tiles with a 2 px rim and the symbol in the holder's color. Both have a pale halo. The fill tells moving forces from places at a glance.
- **Sizes.** Flights 26 px, carrier groups 30 px; airbases 20 px at the Theater band and 26 px in the Region band, other sites 22 px (were 13, 19 and 16 px outlines). The symbol fills about two thirds of its badge. Trails are 2.5 px with a pale casing. Bridges, the capital star and the front's marks are line decorations, not icons, and stay as they were.
- **Orientation.** Badges face the screen like the upright symbols of decision 105; an oriented symbol (an aircraft's heading, a carrier's course, a runway) turns inside its badge to its axis as seen on screen.
- **Selection.** A click within a flight's or carrier's badge plus 6 px selects it (it wins over the range rings' ground selection); the cursor shows a pointer over an icon, and Escape or the panel's close button clears it. The selected icon grows by a quarter, takes a 3 px amber rim and draws on top; a selected mission's route shows as a dashed line. A panel names the flight (callsign, aircraft, mission, the need it serves, phase and the time to its next step, unit, base and target, priority) or the carrier group (theater, course, air wing in the air). Mission search (C2) builds on it.
- **Drawing.** The mark shader gains a badge (fill, rim, shape and size per instance) and turns the symbol by the axis projected on the screen frame. The symbol's shape code is rounded before it is compared: an exact comparison of the interpolated code failed on scattered pixels and speckled the higher-numbered symbols.

`docs/visual-style.md` Part II, *Base Map* (sites) and *Military Overlays* (icons, routes), now say this.

**Reason:** Icons are how the player finds the war on the map and the way into missions; they must be seen at once over relief, patterns, territory tint and clouds, and be easy to hit with a mouse or a finger.

### 134. Free Flight: a sandbox that pulls a first P1 and part of P2 forward

**Date:** 2026-11-13
**Decision:** At the owner's request, Bearing gets a Free Flight mode: pick a seed and an airbase, spawn on the runway in the F-21 Kestrel (the F-16 analogue), take off, fly anywhere, and land at the same or another airbase. No war simulation, no other traffic, no weapons. This departs from Proposal 0002 and the design, which keep takeoff and landing with the AI and put player flight control after the demo (track P). The plan is `docs/plans/free-flight.md`.

- **What moves forward.** A first version of P1 (the table-driven flight model, the control laws, direct control, a flight director with mouse aim) and part of P2 (a Canvas HUD with world- and screen-anchored symbols), plus ground handling and landing gear, which Proposal 0002 ruled out ("No landing gear animation"). P1 and P2 extend these parts rather than replace them: one flight model and one flight director for the player and, later, the AI; the HUD is a 2D overlay over the third-person chase view; no cockpit.
- **Where the code lives.** The flight model, control laws, ground model, runways, outcomes, flight director and a scripted test pilot are headless sim code in `src/sim/flight/` (rule 5: deterministic, SI, no `Math.random`, tested in Node). The camera rig and the aircraft's animated model are in `render/sim/`, the HUD, input and menus in `ui/`, and the mode's glue (world loading, picker, ground query, clock, session flow) in `src/freeflight/`.
- **Flight data in the model spec.** The Kestrel's spec (`alliance-fighter.json`) gains a `flight` block: masses, inertias, CG, wing, CL(α), CD0(Mach), drag increments, thrust tables (idle, military, afterburner over altitude and Mach), control-law limits and gains, wheels, contact points. Angles are in degrees like the rest of the spec; everything else is SI. `sim/flight/flightSpec.ts` validates it and converts it; sim code receives the parsed block, since it may not import `render`. The figures are approximate public F-16C Block 50 values marked as tuning values: F110-GE-129 thrust less installation losses, 27.87 m² wing, NASA TP-1538 inertias, a 1,500 kg air-to-air payload.
- **Integration.** Fixed 120 Hz steps with four substeps, decoupled from the frame rate; float64 planet-centered position and velocity, a body-to-world quaternion, body rates; gravity g₀·(R/r)² along the local radial; the 1976 standard atmosphere. The planet does not rotate. Same inputs, same states (tested bit for bit).
- **Rotational dynamics from the control laws.** There are no aerodynamic moment tables. The control laws ask for the moment that drives the body rates to their commands, bounded by an authority proportional to dynamic pressure and per-axis moment coefficients; the airframe adds damping (with the laws cancelling it, as an FCS does), weathercock stability, gyroscopic coupling and the wheels' moments. This keeps a medium-fidelity model stable and tunable. Departures and spins are not modeled.
- **Control laws** (`controlLaws.ts`), after the F-16's: the pitch stick commands load factor with the gear up and pitch rate with the gear down (decision 136); lateral stick commands roll rate (230°/s, less at high α); pedals command sideslip, with turn coordination at zero; an α limiter near 25° and +9/−3 g; a stick prefilter shapes the onset. **The 1-g reference subtracts the centripetal relief of level flight** (v_h²/r): on a 1,000 km planet straight and level needs about 0.25% less than 1 g at 300 kt, so a plain 1-g hold climbs 1.5 m/s. This is the mode's pitch trim.
- **Ground model.** Three wheels with spring-dampers along the local vertical and a grip spring per tire capped by friction (a bristle model), so a braked aircraft rests without creeping (5·10⁻⁹ m over 60 s in the test), while unbraked wheels roll against rolling resistance. Differential braking, nosewheel steering from 32° at taxi speed to 4° above 12 m/s, parking brake. Gear transit 6 s, a 300 KCAS limit (warning), drag and flap increments; the flaps follow the gear handle. **Ground effect** (more lift and less induced drag within a span of the ground) lets a flare arrest a 4.4 m/s sink within the 14° tail clearance; without it the test pilot struck its tail.
- **Outcomes** (`outcomes.ts`): liftoff, touchdown (sink rate, speed, distance from the threshold, centerline offset, grade: smooth under 1 m/s, good under 2, firm under 3, hard to 6), full stop, crash above 6 m/s, on contact with the gear up, on a hard point (nose, tail, wingtips, belly, fin, stabilators), on water, on open ground away from the field, or leaving the pavement above 25 m/s. Touchdown zone 150–900 m past the threshold.
- **Ground query.** The flight model reads the ground through an interface. In Free Flight it is the renderer's own surface: on an airfield's graded pad (decision 108) the pad's elevation, the same value the terrain's `surfaceSampler` returns there at every tile level; elsewhere `TerrainRenderer.displaySurfaceAt`, or the graded global height map before the tile loads (`src/freeflight/ground.ts`). Grading itself stays in `render/common/terrain/` for now: the sim receives the ground as a function, so it imports nothing from render.
- **Runways** already had a heading and length from the coarse pass (decision 65) and a 45 m width, a graded pad, paint and edge lights (decisions 108–110), so the "generate a runway from the base data" step is not needed. Runway headings follow the prevailing winds, not the flattest axis; changing that would move every existing world's airfields.
- **Where it runs.** The player's flight model runs on the main thread in Free Flight, since the mode has no sim worker and input latency matters. P1 still decides where it runs in the campaign.
- **No weather.** Without the sim worker there is no weather model, so Free Flight flies in clear air.

Plausibility, checked by `tests/flightModel.test.ts` and printed by `tools/flight.preview.ts`, with the Kestrel at 13.3 t: rotation (nosewheel off with full aft stick) at 147 KCAS, liftoff at 171 KCAS after a 530 m roll in afterburner; 1-g stall in the landing configuration at 125 KCAS (10.8 t); Mach 1.12 at 300 m in afterburner; level flight at 300 KCAS hands off for 60 s within 0.2 m and 0.6 kt. `tests/freeFlight.test.ts` flies the test pilot from a generated airbase (seed 1) around a 1,000 m circuit to a touchdown in the zone under 2 m/s.

`docs/design.md` (*Non-goals*, *Flying*, *Later*) and `docs/visual-style.md` (*The Controlled Aircraft*) now name the exception.

**Reason:** The owner wants to fly the world now, before the campaign's piloting track. A sandbox exercises the flight model, the ground model and the HUD on the real terrain and airfields without depending on the ATO or the transition, and building them in their final layers (sim, render, ui) means P1 and P2 grow from them.

### 135. Free Flight's presentation: chase camera, animated model, HUD, input, and how it was checked

**Date:** 2026-11-13
**Decision:** The presentation half of Free Flight (decision 134), built where V4, P1 and P2 will extend it.

- **Chase camera** (`render/sim/camera/chaseCamera.ts`, float64, tested without three.js). 19 m behind and 4 m above in flight, 14 m and 2.6 m on the ground. Its forward and up axes follow the aircraft's through critically damped springs (3.5 rad/s), its up leans a third toward the local vertical so the horizon stays readable in a roll, and its distance stretches by 0.25 m per m/s² of forward acceleration. In flight its forward axis leans 85% toward the velocity rather than following the nose, and it looks at a point 25 m ahead of the aircraft, which puts the aircraft about 8° below the center and the flight path about 4° above it. In the first renders the camera followed the nose and aimed 6 m ahead, and on final, at 12° of angle of attack, the aircraft hid the runway, which lies along the flight path. Free look (right drag or C) springs back in a quarter second. The eye stays 1.5 m above the ground, and samples along the line to the aircraft lift it over rising terrain. `GlobeScene` gains a `chase` mode, a `vehicles` group and a `beforeDraw(eye)` hook for camera-relative placement. Per-type rigs (`ChaseRig`) wait for other aircraft.
- **Animated parts in the model spec.** A part may carry `anim: { channel, hinge: [a, b], angle }` (degrees); channels are stabilator, flaperon, rudder, speedbrake and gear. `buildAnimatedModel` builds the static body and one piece per animated part and per mirror image, with the same triangles as `buildModel`, so budgets and the viewer are unchanged. The Kestrel gains split speedbrakes, flaperons, a rudder cut from its fin, and three gear legs whose tires sit where the flight model's wheels are; 566 triangles, inside the fighter budget (the controlled-aircraft level of 1,500–4,000 waits for V4). Proposal 0002's "No landing gear animation" is amended for Free Flight in `docs/visual-style.md` (decision 134).
- **The aircraft** (`render/sim/aircraft/aircraftView.ts`): flat-shaded with the planet lighting (sun, sky, night floor) and the builder's occlusion, no aerial perspective at a few tens of meters; the ink outline of decision 107 at 1.6 px; an additive afterburner cone in Part I's `#FFB347` that lengthens with the stage; and a shadow, the posed triangles flattened onto the ground plane along the sun on the CPU each frame (about 1,700 vertices), dark at 32% opacity, below 400 m above the ground and with the sun up. Overlapping shadow triangles darken twice; a stencil pass can fix that later.
- **HUD** (`ui/flight/hud.ts`, Canvas 2D at device pixel ratio). World-anchored: flight path marker (the velocity at 5 km), boresight, the destination runway's outline and aim point. Screen-anchored around the aircraft: KIAS tape with Mach, altitude tape in feet with vertical speed and radar altitude below 1,500 ft, heading tape, a compact attitude indicator, G, α with the approach indexer (13° ± 1.5°), throttle (IDLE, %, MIL, AB 1–5), fuel in pounds, gear, speedbrake and brake states, the control mode. The landing aid takes the nearest runway within 80 km and the end being approached: distance and bearing to the threshold, a localizer needle (full scale ±2.5° from an antenna 300 m past the far end) and a glideslope needle (full scale ±0.7° about the 3° path to the aim point 300 m in). Messages: airborne, touchdown summaries with a grade, gear speed limit, stall, pull up, crash reasons. F3 shows α, β, CL, CD, thrust, q, load factor and the law in use, body forces, and frame and physics times. **Color:** green `#6CFF8A` with a dark halo `rgba(0, 18, 6, 0.75)`, warnings in amber `#FFB347`; a starting value for P2 to tune, now in `docs/visual-style.md`. The frame data comes from `freeflight/hudFrame.ts` (no DOM), so tools build the same frames.
- **Input** (`ui/flight/flightInput.ts`). Every key in one remappable table. Direct control is the default (decision 134). The throttle stops at idle, military and the afterburner gate; a new press passes a detent; there is no lever position between military and the gate. Ctrl+W, which the browser does not let a page block, is guarded by a leave-page prompt while flying. **Mouse aim is simplified:** the flight director flies toward the direction under the cursor in the chase camera's view, rather than toward a world-locked aim point that the camera follows (War Thunder's scheme). Holding the cursor off center therefore turns continuously. The proper scheme needs the camera to follow the aim point and belongs to P1. The gamepad gets basic axes only (stretch goal).
- **Runway paint.** Touchdown-zone bars join the paint layout of decision 109: 3, 2, 2, 1 and 1 bars each side at 150, 450, 600, 750 and 900 m. **The pavement stays concrete** rather than the dark asphalt the task asked for: decisions 65 and 109 and the base kit's pale concrete set it, and the paint reads on it. It is one constant in `roadShading.ts` if the owner prefers asphalt.
- **How it was checked.** Headless Chromium gets a WebGPU adapter here only through SwiftShader, and its device is lost in the world's GPU pass, in the normal app as in Free Flight, so the app cannot be flown in this cloud session. The start screen was checked in Chromium (it renders before the GPU pass). The flight itself is checked by the headless tests, and the views by `tools/freeflight.preview.ts`, which renders the chase view on Dawn and lavapipe as the other previews do, and `tools/freeflight.screens.mjs`, which draws the real Canvas HUD over each render in Chromium. The screenshots are in `docs/reports/screens/`.
- **Branch.** This work is on `feature/free-flight` with a pull request, as the owner asked for this task, instead of CLAUDE.md's "commit to main".

**Reason:** The camera, the animated model and the HUD are what the player looks at for the whole sortie; each is built in the layer the design gives it, so V4 (camera rig, followed aircraft), P1 (animated parts, mouse aim) and P2 (HUD framework) grow from them rather than replace them.

### 136. The gear handle selects the pitch law; takeoff gains, a PI rate loop, and what an adversarial review found

**Date:** 2026-11-13
**Decision:** After the owner's first flights ("constantly a tail strike on takeoff; sluggish at first, then too fast; I can't stay at 10°", from someone who flies the F-16 in DCS), the pitch channel of the control laws (decision 134) changes, and the ground model with it.

- **The gear handle selects the gains**, as in the F-16. With the gear down the stick commands pitch rate and neutral stick holds the attitude; as the gear comes up over its 6 s transit the load-factor law takes over (above 75–110 m/s of calibrated airspeed, as before). Weight on wheels no longer enters the blend: blending on it switched to the load-factor law at the moment of liftoff with the stick still aft, which commanded up to 9 g and took the pitch rate from 9°/s to 31°/s in 0.3 s.
- **The rate law** (`pitchCommand` in `controlLaws.ts`, shared with the flight director). On the ground full stick asks for 5°/s (`groundPitchRate`), a gentle rotation; in the air that grows to 12°/s (`maxPitchRate`) 1–4 s after liftoff, so a stick still aft at liftoff does not whip the nose. In the air it adds the pitch rate of a level turn at the present bank, and from 6–12 s after liftoff a load-factor hold on the commanded path (cos γ / cos bank plus the stick's rate as load, clamped to ±4°/s), so neutral stick holds a turn in the pattern; right after liftoff it holds the attitude the pilot rotated to. After a landing, neutral stick lowers the nose at 2.5°/s onto the nosewheel.
- **The handover** weights the load law's steady part by the blend and its error term by the blend squared, so the first percent of gear travel does not hand the stick a 9 g loop gain. The load law's stick is shaped as on the F-16, s·(0.3 + 0.7|s|): a fifth of the travel asks for 1.7 g, full travel still 9 g.
- **A PI rate loop** with anti-windup on the authority, its integrator frozen and bled with weight on the wheels so the gear's reaction cannot wind it up for release at liftoff; **takeoff gains**, five times the rate gain with weight on the wheels, so the loop overcomes the main gear's nose-down moment (a plain gain settled at about 1.4°/s against it: the sluggish start); and a quicker stick prefilter with the gear down (0.08 s; 0.25 s with the gear up, where it shapes the g onset).
- **The flight director inverts the law exactly**: it computes the pitch rate the law would command for its desired load and rate, and bisects for the stick that gives it. Mixing two stick estimates porpoised the test pilot between 2.3 g and 0.08 g while the gear came up.
- **Tail-strike warning** on the HUD with weight on the wheels when the pitch half a second ahead (pitch + 0.5 s × pitch rate) passes 12.5°; the tail touches near 13.5°. A fixed 10.5° threshold fired on every correct flare and after normal rotations.
- **Ground model.** Nosewheel steering fades to none by 35 m/s (`steerOff`), and at speed the tires' lateral force follows their slip angle (cornering 6 per radian of slip, times the load, capped by friction) instead of the grip spring, whose damping acted like a cornering stiffness about thirty times a tire's at takeoff speed: a 0.25 pedal tap at 150 kt rolled the jet onto a wingtip. With the pedals let go on the wheels the laws hold the ground track (`trackHold`, decisions 143 and 145).
- The scripted test pilot flares with a firmer flight-path gain.

**How it was checked.** A workflow of 33 agents flew six kinds of probe against the first version of this change (DCS-style proportional stick, keyboard variants, gear retraction, approaches and landings, abuse and stability, and a review of the diff), and a separate agent tried to reproduce each reported problem. Nine of 25 survived; the second version above fixes them, and `tests/flightModel.test.ts` holds a test for each: a keyboard pull at 150 KCAS released 0.25 s late rotates at a steady 5°/s and peaks at 11.6° with the tail clear; no tail warning in a normal takeoff or landing; a 30° gear-down turn with the stick released holds its vertical speed within 2 m/s; the gear handover with neutral stick stays under 8°/s and 1.5 g; the test pilot's military-power takeoff stays within 0.7–1.9 g through the gear transit; pedal inputs at 150 kt leave the wings within 6° of level; the nose comes down within 8 s of a landing. Unchanged by design: holding aft stick after raising the gear commands sustained g, as in the F-16; partial-stick rotations are slower by command (liftoff about 182 kt at 0.7 stick and 192 kt at 0.5 in afterburner, 173 kt at full stick).

**Second round.** A second workflow (28 agents) on the revised law found the takeoff sound (no tail strike in any run, a steady 4.8–5.0°/s through liftoff, the attitude held after release) and confirmed 16 smaller problems, fixed here with tests:

- The path hold now uses its own gentle gain (`holdGain` 0.12 rad/s per g): at the load law's 0.5 it added several times the stick's own rate to every small input once it faded in, and a steady pilot holding an attitude bobbed. It gives way below 20 m above the ground and never pulls past the approach angle of attack (13°, `approachAlpha`): released in a flare at idle, it raised the nose toward the stall.
- Derotation is a floor that eases out as the stick comes aft, −2.5°/s·(1 − stick/0.1), so the pitch command stays monotonic in the stick (the flight director's bisection needs it; a band at |stick| < 0.1 also made aerobraking bob). The landing latch takes 2 s of flight to clear, as to set, so a skip keeps it; it clears once the nose is down, so a later takeoff run is not a landing.
- With weight on the wheels, forward stick stops at the ground attitude: pressing the nosewheel down overloaded it and the jet ground-looped at speed.
- On the runway above about 30 m/s the pedals command a yaw rate (3°/s at full pedal), closed by the rudder, instead of open-loop rudder; a pedal held 1 s at 150 kt no longer ground-loops the jet (holding full rudder 1.5 s no longer does either).
- The flight director leaves the pedals alone with weight on the wheels and limits its path change to ±0.6 g about the path's own load (mouse aim allows 4 g): a 5° descent pushed to 0.2 g. Mouse aim hands the stick to the keys on the wheels; it held the stick forward and zeroed the pedals on the rollout.
- The tail-strike warning looks 0.4 s ahead with a threshold of 12.8° (a military-power rotation flickered it for four frames); an air start counts as long airborne for the laws; the parser rejects a `steerOff` not above `steerFade`; stale comments fixed.

**Reason:** A takeoff should be flyable the way F-16 pilots fly it: pull, watch the attitude come up at a steady rate, let go at the target. The law switch at liftoff was a bug, not a tuning matter, and the F-16's own design (gains on the gear handle, integrators held on the ground, a 1 g hold in the landing gains) solves both faults. The adversarial review found the places where the first fix was too simple.

### 137. Weather for the atmosphere work: dust and storm channels, presets, a standalone weather, and shared uniforms

**Date:** 2026-11-13
**Decision:** The owner asked for storms, rain from drizzle to skyfall, snow, thunder and lightning, sandstorms, volumetric clouds and fog, in the game and in Free Flight. This decision covers the data those effects read; the effects follow in later decisions.

- **Two channels**, appended after the winds so existing indices keep their place: `Channel.Dust` and `Channel.Storm` (17 channels). Every other field is bit-identical to before, except precipitation and visibility where a storm or dust is present (checked against the old model for 20 days on three seeds).
- **Storms.** Deep convection in tropical systems, along the fronts of deep lows, and in the afternoon over warm humid land. Precipitation is stratiform (up to 5 mm/h) plus storm cores (`50 · storm²` mm/h), so rates run from drizzle to 55 mm/h. On seed 1983 over 30 days: mean 0.236 mm/h, of which 0.045 from cores; storms are 4% of raining samples. Storms need air above 1.5 °C, so there is no thundersnow.
- **Dust.** Rises only over arid, unfrozen land in gusty surface wind (10.5–20 m/s) without rain. A full dust storm has 200 m of visibility (`200 / dust²`).
- **Presets** (`sim/weather/presets.ts`): `live`, `clear`, `fair`, `overcast`, `drizzle`, `rain`, `storm`, `snow`, `blizzard`, `fog`, `duststorm`. Each is a pure function of the live frame: it keeps the live pressure and wind direction, sets cover, base, visibility, precipitation, snow fraction, dust, storm and a consistent temperature, scales the wind (gale force for storm, blizzard and dust storm), and varies over hundreds of km by a deterministic wave pattern. Presets are for Free Flight, previews and debugging; the campaign always runs `live`.
- **Standalone weather** (`sim/weather/standalone.ts`). Free Flight runs the same `WeatherModel` on the main thread without the war, time-sliced (`prepare(gameTime, budgetMs)`), and gets the same frames as the sim at the same game time. The model computes its fields resumably, 256 samples at a time. This replaces decision 134's clear air.
- **Shared uniforms** (`render/sim/weather/weatherState.ts`). One `WeatherState` per scene holds what every effect reads at the camera: rain and snow intensity on a logarithmic scale (0.5 mm/h → 0.20, 4 mm/h → 0.56, 30 mm/h → 1), dust, storm, fog extinction, wind in the world frame, ground wetness (rising in about 10 s of rain, drying over 3 minutes; in game time where the game clock runs faster than real time, so a shower's wet ground does not last for game hours at 60× or 600×), the lightning flash, and an animation clock.
- **Fog is an extinction.** For rendering, each weather sample's visibility becomes an extinction (`3.912 / visibility`, fading out between 12 and 20 km, minus the dust's share) and is then blended linearly in space and time, in the uniform and in the texture alike. Blending visibility first kept forming fog at zero for half an hour and then brought it in a rush. Flight operations keep the interpolated visibility of `WeatherReport`.
- **Weather texture.** A second RGBA16F array texture carries cloud base (above sea level, from the sample's mean ground height), fog, dust, and storm minus snow in one signed channel, blended in time on the CPU every 1/128 hour.

**Reason:** The effects need quantities the weather model did not expose, and the model already knows what causes them (aridity and gusts for dust, deep lows and warm humid air for storms). Deriving them inside the model keeps flight operations and the screen on the same fields (decision 15), and keeps determinism: no new stream, no change to existing fields. Presets as functions of the live frame keep the wind field and its structure, so a preset sky still moves and varies.

### 138. The simulation view's post-processing pipeline

**Date:** 2026-11-13
**Decision:** The simulation view draws through `SimPipeline` (`render/sim/post/`), which `GlobeScene` owns. The strategic view is untouched and still draws directly with no tone curve (decision 99).

- **Chain**, in linear HDR until the end: the scene into a half-float target with depth; a low-resolution volumetric stage; an overlay scene for rain, snow and lightning; bloom; the time-of-day grade; AgX with the renderer's exposure; sRGB; grain and dither. There is always exactly one full-resolution quad: composite, overlay, bloom, grade, tone curve and grain are one shader. The bare pipeline costs the same two passes as three's direct path; bloom adds five small passes (0.16 of a full-resolution pass in pixels), the overlay one, volumetrics three at low resolution.
- **Hand-built** from render targets and `QuadMesh`, not three's `RenderPipeline` and `PassNode`: the stages share one final shader, each switch selects a cached variant of it, and a stage that is off has no pass and no branch.
- **Volumetrics.** A `VolumetricSource` returns in-scattered radiance and transmittance for a view ray and the distance to the opaque surface. It runs at 1/3 resolution by default (1/2 and 1/4 as quality settings, 1 as a reference): a depth select (nearest or farthest of each block, in a checkerboard), the march with interleaved gradient noise as jitter, and a 3×3 depth-aware filter that evens the jitter out. The final pass upsamples by bilinear weight over depth difference, so fog does not halo around silhouettes. Where the four texels lie at the pixel's depth the weights are exactly bilinear; a floor of 0.02 under them applies only where one of the four is more than 15% apart (with the floor everywhere, gradients in cloud carried a ripple at the texel period; decision 145). The ray is built from the camera's axes and the distance from the reversed depth without an inverse projection (relative error under 2e-6 from 1 m to 799 km in float32).
- **MSAA is kept.** The scene target takes the renderer's sample count, and its float depth stays multisampled. Where a pixel's depth samples disagree, the final pass mixes the volumetric result for the nearest and the farthest surface by their share of samples; taking one sample's depth gave dotted, flickering silhouettes in front of fog.
- **Overlay.** Premultiplied alpha in its own half-float target, without depth or MSAA; overlay materials fade against `pipeline.sceneDistance`, and `overlayAdditive` makes a glow that covers nothing.
- **Bloom.** A thresholded prefilter at 1/4 resolution, two dual-filter downsamples and two upsamples. The threshold follows the time of day (0.3 at night to 2.4 by day, in exposed luminance), because the exposure is constant through the day; light above it is compressed, so the sun gets a halo and stays a disk.
- **Grade.** Five parameter sets (night, dawn, dusk, golden hour, day: gain tint, saturation, gamma, lift) blended on the CPU from the sun's elevation into four uniforms, instead of the five lookup tables the guide named: the same control for a few instructions and no texture. `docs/visual-style.md` is updated.
- **Grain** is constant in strength, with a pattern that changes each frame, plus ±0.5/255 of dither: the longest run of equal values down a sunset sky fell from 89 px to 7.
- **Fallback.** `postEnabled = false` draws directly. A failure while building or drawing (a guard checks the first frames of each shader variant for GPU validation errors in the browser) disposes the pipeline with one console warning and draws directly.
- **Not done:** the optional pixelation pass; temporal reprojection of the volumetric stage.

**How it was checked.** GPU tests on Dawn and lavapipe: the bare pipeline equals the direct render within 1/255; fog at four scales with 0 and 4 samples leaves no halo pixel (plain bilinear upsampling fails this test); rays and distances match a CPU reference (a mirrored ray fails); pass counts match the renderer's own. Stage costs on lavapipe at 640×360, over the direct path: grade, grain and dither +0.2 ms, bloom +2 ms, the volumetric machinery +4.3 ms, everything +9.8 ms, against a scene pass of 180–450 ms. Nothing ran in a browser at the time; decision 144 records the first browser run.

**Reason:** Volumetric clouds and fog need a low-resolution pass that reads scene depth, and bloom, grading and grain need the frame in HDR before the tone curve; the direct path offers neither. One merged final shader keeps the added cost to one full-screen pass.

### 139. Terrain shadows from a baked height field; deeper sky fill, snow sparkle and wet ground

**Date:** 2026-11-13
**Decision:** Mountains cast shadows through `TerrainShadow` (`render/sim/lighting/terrainShadow.ts`), a shadow field baked by compute around the camera, which `PlanetLighting.sunlightAt` reads for every lit material. This replaces the guide's cascaded shadow maps for terrain; `docs/visual-style.md` is updated.

- **Field.** Three nested 512² grids on the terrain tiles' own sample lattice (tile levels 6, 4 and 2): about 96 m, 380 m and 1.5 km between points, 49, 196 and 785 km across. Each texel holds the shadow's height over the ground, the distance to the occluder and the ground height. The two finer grids read the terrain's cached tile heights (the global grid alone misses level-7 relief by 406 m RMS at the highest range; the near grid by 12 m); the coarse grid and any gaps use the global height grid.
- **Bake.** Nine compute passes per grid, each doubling the reach, one pass per frame. The planet's curvature is in the step formula, so the limb shades without a special case. Lattice points are fixed on the planet and a window moves in steps of 32 texels, so shadows do not swim. A re-bake follows the sun (every 2.5 s at 2°, 16 s at 5°, 3 min from 17° up, at real rate) and the camera (the near grid every 3.1 km).
- **Lookup.** One texture read per lit fragment (two in a blend band) behind a uniform branch; the penumbra grows with the distance to the occluder and is never under 1.5 texels (about 144 m). Strength is 0 above a 48° sun, below −9°, above 150 km, and when the clock turns the sun more than 4° per bake (about 8,000× at 60 fps); nothing is baked then. At 256× the bake runs 4 passes per frame. When the camera crosses to another anchor face of the cube (48.7° from a face's center) each grid keeps its published field in the lookups, in the frame of the face it was baked on, until its own bake on the new face is published (coarse first, 27 passes for the three, plus the tile-height fill): shadows do not go out or fade at a crossing (decision 145).
- **Receivers and casters.** Terrain, water, roads, trees, buildings, aircraft and clouds receive. Only terrain casts: trees, buildings and aircraft cast nothing yet, and moonlight is not shadowed.
- **Sky fill.** `skyLight` is 2 (it was 1.6 before decision 140's multiple scattering and 1 after), and the sky's light on a surface leans toward the sun's azimuth (`skyLean` 0.5): a 20° facet in shadow at a 5° sun is 13% brighter facing the sun and 13% darker facing away, where all facets in shadow had one shade before.
- **Low-sun exposure for surfaces.** Light on surfaces, sun and sky alike, is exposed up to 1.7× over the sky's between 16° and −12° of sun elevation (`surfaceExposure`, peak from 4° to −4°), like a graduated filter. Shadow depth relative to sunlit ground is unchanged, and the sky and the air in front of terrain are untouched, so the horizon holds. At 2× golden hour lost its mood; at 1× the ground under a sunset sky was display black. `sunlightAt` does not carry it, so clouds stay at the sky's exposure.
- **Snow sparkle.** Within 2.5 km, sunlit snow carries glints from one hash per fragment: points about 1.3 pixels across in cells of 2–4 pixels, at 10× the sunlight, with a mirror tolerance of about 5°, so they appear toward a low sun and change as the camera moves. None in shadow or under cloud. The bloom picks them up.
- **Wet ground.** `WeatherState.wetness` darkens albedo to 60% and raises saturation by 35%; pavement and level bare ground add a Fresnel sky sheen. Snow, water and forest canopy take none.

**How it was checked.** GPU tests on Dawn and lavapipe: an 800 m wall at an 8° sun throws a shadow whose tip is within 2 texels of h / tan e; the coarse grid agrees with a CPU reference within 3 m + 1%; the limb shades the far side; a re-centered window gives the same field; the scheduler bakes one pass per frame and nothing while nothing moves. The per-frame bake against the real terrain matches the one-go bake within 5/255. Lookup and sparkle cost is inside the noise of interleaved frames on lavapipe; a bake pass costs 7 ms there (4–7% of a 640×360 frame). Nothing ran in a browser at the time; decision 144 records the first browser run.

**Not done:** shadows cast by trees, buildings and aircraft (the guide's aircraft shadow on the ground); a cross-fade when finer tile heights arrive; conifer forest in a mountain's shadow at a 3° sun is still close to black (luma 9–14).

**Reason:** The owner asked for deep shadows and sparkling snow at 30+ FPS. Shadow maps would draw the terrain again per cascade every frame and reach a few kilometers; ridge shadows at low sun are tens of kilometers long. A height-field bake costs one small compute pass per frame, only while the sun or the camera moves, and one texture read per fragment.

### 140. Sky-view LUT with multiple scattering; sun, moon and stars; clear-air haze, twilight and night light

**Date:** 2026-11-13
**Decision:** The sky is a sky-view lookup table with multiple scattering, and it carries a sun disk, a moon with phases and moonlight, and stars. This supersedes decision 35's per-pixel 32-step march and "no multiple scattering", and decision 36's `skyLight` default.

- **Sky-view LUT** (`render/sim/atmosphere/skyView.ts`). Two 128 × 160 half-float textures baked by one compute pass of 48 samples per texel, only when the camera's height, the sun, the moon or the air changes; a still camera does not re-bake. The Mie integral is stored without its phase function, which is applied per pixel, so the table holds only smooth functions and the glow around the sun stays sharp. A sky pixel costs 2 texture reads (it was 32 steps). Above 30 km the sky cross-fades to the old march, which alone draws it from 50 km up. `AtmosphereNodes.skyRadiance(rd)` gives the sky in any direction to water, clouds and fog; water now mirrors it.
- **Multiple scattering.** Hillaire's (2020) Ψ table, 32 × 32 on the CPU with ground albedo 0.3, added in the bake, in the march and in aerial perspective (2 extra reads per vertex).
- **Units.** In-scattered light is multiplied by π (`inScatter`), which the old sky left out: display units count a sunlit white surface as E, π times its radiance. The day sky is blue to a pale horizon where it was navy.
- **Clear-air haze.** Over surfaces the consistent amount washed the ground out (forest 5–10 km away turned teal). Aerial perspective shows `haze` = 0.32 of the in-scattered light through thin air and all of it once the path is opaque in blue (opacity 0.3 → 0.9, about 15 → 100 km at flight altitude), so the ground keeps its palette to about 20 km, far ranges turn blue, and the horizon still meets the sky. Weather raises `haze`.
- **Ozone** is scaled by √(R_Earth / R) = 2.52. Twilight color comes from grazing paths through the ozone layer, which are that much shorter on this planet (decision 14); with Earth's amount twilight is gray and olive, scaled it is violet with a pink band. It costs about 4% of green in overhead sunlight.
- **Twilight.** The pipeline's exposure is constant, so the guide's "exposure tied to time of day" sits on the sun's illuminance: `twilightGain` is 1 from 8° up, about 2 at 0°, 6 at −6°, 16 at −12° and 24 from −18° down. Lamps, moonlight and the bloom thresholds are untouched. The sky's fill on surfaces rises from `skyLight` to π × `skyLight` / 2 from 6° down (`skyFillGain`) and fades out by −18°.
- **Vibrance.** In-scattered light takes a saturation about luminance from the sun's elevation: 1 from 12° up, 1.9 from 3° to −8°, 1 at night. AgX halves the saturation of bright oranges; this is the guide's grade "toward warm, painterly tones", applied per LUT texel and per vertex.
- **Sun.** A disk of 0.40° radius (1.5× real; it was 0.6°) with limb darkening, seen through the transmittance table, at 60× the illuminance so the bloom gives it a halo.
- **Moon** (`core/moon.ts`). A 29.53-day synodic month, 5.145° inclination, nodes regressing in 18.6 years; a mid-August campaign starts with a 10-day-old waxing moon. The disk is 0.52° in radius (2× real), shaded as a sphere lit from the sun's side, with earthshine and four maria. Moonlight is `fullMoon` 0.12 × a diffuse-sphere phase law, tinted (0.42, 0.64, 1.0), on an albedo desaturated by 0.75; the night floor is 0.02. Below about 0.05 moonlit ground is display black under AgX. Moonlit air is in the LUT and in aerial perspective, behind a uniform branch that day does not take.
- **Stars.** Procedural: one star in about a quarter of 6 × 64² cube-face cells from an integer hash, a power law in brightness, a tint, a galaxy band, twinkle, extinction, and a fade against the sky. They turn with the planet (`celestialRotation`) and come out from about −4°. Day evaluates none.

**How it was checked.** The LUT against a 400-sample CPU reference at 4 heights × 7 sun elevations × 16 directions: within 1.1% by day, 4.5% in twilight. Smoothness per 0.05° sweep: bend ≤ 0.14% by day. Aerial perspective at 0.9 of the horizon distance matches the LUT along the same ray within 0.5%. Stars follow a camera turn within 0.03 px (median). On lavapipe, interleaved: the sky alone takes 6.5 ms where the march took 36 ms; `golden` 114 ms against 149 ms. One bake costs 15 ms there. Nothing ran in a browser at the time; decision 144 records the first browser run.

**Not done:** moon glint on water; clouds shading moonlight; eclipses. The settlements' rural glow still spreads a warm tan over unbuilt ground at night.

**Reason:** The owner asked for a soft sky, spectacular sunsets and sunrises, a moon and stars, at 30+ FPS. The march cost 32 steps per sky pixel and could not be shared with clouds, fog or water; a table can, and it makes multiple scattering affordable, which is what lights the twilight sky. The haze, fill and vibrance terms depart from the consistent values where those gave a washed-out ground or a muddy sunset ("hard ground, soft sky").

### 141. Volumetric clouds, cirrus, fog, dust and rain veils as one march at low resolution

**Date:** 2026-11-14
**Decision:** Everything in the air between the camera and the scene is one source for the pipeline's volumetric stage (decision 138): a march through 3D cloud, a cirrus sheet, and a march through the air near the ground for fog, haze, dust and the veils of rain and snow. Inside the simulation view's 20 km it replaces the cloud shell of decision 55, which stays for the debug camera above 30–50 km and where the pipeline is off. This supersedes the style guide's "raymarched 2.5D cloud layer at quarter resolution".

- **Form from the weather** (`render/sim/clouds/cloudForm.ts`). The coverage bake now holds four half-float channels per texel (coverage, precipitation, cloud base, development), 512 texels per face edge, 13 MB, rebaked every 10 game seconds. Development 0..1 follows cover, precipitation and storm cells and sets the thickness from 700 m (fair-weather cumulus) to 11 km (a storm tower with an anvil). The march, the cloud shadow on the ground and the overcast term all read the same column, so shadows sit under their clouds.
- **Shape** (`noiseVolume.ts`). Two tiling 3D noise volumes from an integer hash, generated on the CPU in about 0.3 s on first use: shape 64³ at 10 km per tile and detail 32³ at 2.4 km, half float, 2.3 MiB together. Half floats are needed: a cloud's edge is a narrow range of the noise, and 8-bit filtering drew it as terraces.
- **Cloud march** (`volumetrics.ts`). At most 28, 40 or 48 steps per ray (low, medium, high), 45 m at the shortest and growing with distance, half steps inside cloud, opaque at 1% transmittance. A step that skips to a column's base or top keeps the ray's sample offset (decision 145). Light: 2, 3 or 4 samples toward the sun or moon at fixed distances plus one read of the column 5 km on, the light changing from its sharp form to its deep one over step lengths of 10 to 90 m (`LIGHT_STEPS`), the shape noise giving way to its smooth channel over steps of 200 to 900 m and that to the mean density over 1.2 to 3.5 km (`SMOOTH_STEPS`, `MEAN_STEPS`), and the ground shadow losing the same structure between 8 and 35 km and between 46 and 135 km from the camera (`SHADOW_SMOOTH`, `SHADOW_MEAN`); a dual-lobe phase function (silver lining), a powder term, sky light from above, a gray floor deep inside thick cloud, lightning from inside, aerial perspective per sample. The key light hands over from sun to moon between −5° and −8°.
- **Cirrus.** One sheet at 10.5 km from a stretched 2D field, no march; it catches low sun, so fair weather has color above the horizon at sunset. It fades out between 60° and 72° latitude, where its fibers would converge. It comes in with the most cloud cover in view, between 0.017 and 0.1 (`CIRRUS_IN`), and follows it over 6 real seconds (`CIRRUS_SECONDS`): that cover moves in steps as a weather sample 65 km wide enters the view or leaves it. The march runs until the sheet has gone. A cut, a first frame and a weather change in a paused view set it outright; a paused view otherwise holds it.
- **Air march.** 10, 14 or 20 steps at most, placed in the slab where the medium is and fewer on short rays; the weather is read at 2 points of a ray under 12 km and 6 above. Fog is full to 100 m over the mean ground of its weather sample and thins with a scale height of 120–600 m; from 8 km visibility down it has structure from three noise scales (2,600, 900 and 170 m), the finer two as wisps twice as wide as thick (`AIR_LOOK.strata` 2; sheets eight times wider than thick drew a level view through fog as horizontal streaks), all drifting with the wind. The fine structure of fog, rain, snow and dust comes in between 15 and 120 m from the camera (`NEAR_EVEN`); nearer, the air has the weather's own extinction and an even light, so the aircraft 12 m ahead is veiled by what the visibility says (4.3% at 1.1 km). Its light follows the wisps, because thick fog shows its light and not its density. Dust is an ochre layer 2 km deep with billows; rain and snow are leaning veils under precipitating cloud with narrower curtains near the camera. Cloud shadows cut the fog's sunlight, and terrain shadows do while the sun is under 20°, which gives crepuscular rays.
- **Sky light under cloud** (`PlanetLighting.overcast`, `overcastSky`). Surfaces under cloud take a gray sky at 2.3 times the clear sky's luminance under a thin closed deck down to 0.35 under a storm, from the column already read for the shadow. Water mirrors that gray sky: π times the sky's light on level ground per unit of sky fill (an irradiance in display units to the radiance of the even sky that gives it), and half of a lightning flash's light on surfaces (`FLASH_MIRROR`), which has none of the sky's gains in it.
- **Sampling without flicker.** There is no temporal reprojection, and per-frame jitter left crawl after the 3 × 3 filter. Each ray instead takes one of nine sample offsets laid out as a 3 × 3 magic square and goes through one of nine sub-positions of its block, the same in every frame; the pipeline's filter averages one of each. A still camera shows no noise from the volumetrics.
- **Pipeline changes** (`render/sim/post/simPipeline.ts`). The low-resolution depth target stores the block's nearest and farthest depth. The filter treats samples as one surface within 15% of depth, or within the block's own depth range up to 25%; everything beyond 15 km counts with the sky; surfaces behind air under 10% transmittance count as one; where the nine neighbors do not all match it widens to 5 × 5. A source can report itself idle, and the stage then leaves the frame: a clear day costs nothing. March shaders are cached per source and resolution, so a change of quality compiles once per level.
- **Quality.** Low marches 1/16 of the pixels, medium 1/9 (the default), high 1/4. The level below the current one is compiled in the second frame after attach, so the governor's step down (decision 143) does not hitch.

**How it was checked.** GPU tests: clear air leaves every pixel untouched; a slab of cloud or fog gives the Beer–Lambert optical depth within 2%; the ground shadow agrees with the march's transmittance toward the sun on a 9 × 9 grid; step caps hold for every pixel; a flash stays bounded; no halo of fog on sky beside a wall, and no sample pattern on cloud over receding ground (the two requirements that pull the filter's depth rule in opposite directions, pinned together). Texture reads per low-resolution pixel at medium, mean: fair weather 30–47, overcast from below 78, rain 78, storm from below 49, fog 40, dust 38; divide by 9 for a full-resolution pixel. On lavapipe at 640 × 360, interleaved, medium adds 15–28 ms to a base frame of 12–17 ms, low 7–17 ms, high 24–66 ms. An independent review in three runs fixed 19 issues, among them a horizon seam in cloud, the sun showing as a dot through dense fog, a 28 MB leak per scene dispose, and a lightning flash that turned the whole frame white at night. `tools/clouds.preview.ts` renders the volumetrics over a plain ground in 0.1–0.3 s per view and counts steps and reads (`COUNT=1`, `PERF=n`). Nothing ran in a browser at the time (decision 144 records the first run) and nothing on a real GPU: the estimate for an integrated laptop GPU at 1080p is 4–8 ms at medium and 2–4 ms at low.

**Not done:** clouds do not receive mountain shadows and do not shade moonlight; fog pools by 65 km weather cells, so single valleys inside a high cell do not fill; cloud bases ignore terrain exaggeration; from a low camera in a steep bank a thin strip along the horizon keeps some of the sample pattern; snow and blizzard scenes are a dim gray at midday.

**Reason:** The owner asked for clouds that are "volumetric, shapes, 3D, density, and color", fog that is "volumetric, colored, swirling and moving", storms and dust storms, a "soft and silky" sky over the faceted ground, at 30+ FPS. One march for all participating media shares the weather reads, the light and the compositing, and its cost is bounded by counted steps at a fraction of the resolution. Fixed sample offsets trade a faint fixed residue in grazing views for a sky without flicker, which matters more for "soft".

### 142. Rain, snow and dust as particles; lightning from a schedule; synthesized thunder and ambience

**Date:** 2026-11-14
**Decision:** Precipitation near the camera is instanced particles in the pipeline's overlay, lightning is a pure function of world seed, game time and place, and all weather sound is synthesized in WebAudio.

- **Particles** (`render/sim/weather/precipitation.ts`). Three instanced meshes (rain, snow, dust) with no attribute and no CPU work per particle. Each kind's particles are the points of a lattice fixed in the world; an instance has an anchor fixed to the camera inside the view pyramid and draws the lattice copy nearest to it, faded toward the faces of its cube. A particle therefore stays put in the world while it shows, and 61% of the instances are on screen (a cube around the camera had one in seven). Three layers reach 12, 24 and 48 m; the volumetric veils (decision 141) carry rain beyond that. The caps are 16,000 rain, 12,000 snow and 9,000 dust instances at density 1 (`density` 0.5, 1 or 2); a fragment reads the scene depth once and nothing else. The least width of a streak, a flake, a grain and the bolt is in drawing-buffer pixels, not CSS pixels, so it holds under the render scale. With no precipitation the meshes and the overlay pass are gone.
- **Looks.** A streak runs along the particle's velocity relative to the camera over about 1/30 s, capped at 2 m and at 0.12 rad on screen, so rain from a fast aircraft is short dashes radiating from the direction of flight. Drizzle is 2,700 dashes of 7 cm falling at 2.5 m/s; rain 8,300 streaks of 21 cm; a skyfall 16,000 streaks of 32 cm at 9.5 m/s in gust bands. Snow is soft discs of 1.6 to 7.5 cm that sway; a blizzard stretches finer flakes along the wind. Dust is ochre grains at the wind's speed, thickest in the lowest 10 m. Rain takes half of the wind, or a gale would lay it flat.
- **Light.** One color per kind per frame, computed on the CPU from the lighting's numbers: sky irradiance grayed and dimmed under cloud with the constants surfaces use, sun past the cloud, moon and night light, and 0.6 of the lightning flash on surfaces. Under storm cloud particles take 0.85 of the dimming that surfaces and fog take. Lamps do not light them.
- **Lightning** (`render/sim/weather/lightningStrikes.ts`, `lightning.ts`). A strike is a hash of (world seed, 8 km cell, 4 s slot) compared against a rate from the storm field at its place, so nothing depends on earlier frames: the same strikes at any frame rate and after a seek. 40% reach the ground; each has 1 to 4 strokes within 0.3 s. The bolt is 64 segments plus 3 to 7 branches from midpoint displacement, drawn additively at radiance 60 from inside the cloud base to the ground and dimmed by 0.35 of the air's extinction. A camera above the deck sees the cloud's glow, not the bolt. The flash lights surfaces through the sky term of `PlanetLighting.at()`: 0.6 display units under the strongest strike, halved at 8 km.
- **Time acceleration.** The clock's speed is an average over 0.3 real seconds, because Free Flight's clock and the campaign's snapshots advance in steps. Above 1.5× the view shows at most one strike per 0.9 real seconds, and only those thunder. One long step is a seek and shows nothing.
- **Warm-up frames.** The overlay's meshes are drawn once, empty, at the first frame, when cloud closes in over the camera, and ahead of a ground strike, so that shader compiles do not land on the first drop or eat a 0.3 s bolt.
- **Sound** (`ui/audio/`). No files (decision 40): thunder is brown noise through a low-pass (2.2 kHz near, 110 Hz far) under 3 to 6 swells, with band-passed cracks inside 4 km, delayed by distance / 343 m/s on the AudioContext's clock and silent beyond 25 km; at most six sound at once. Ambience is four filtered noise loops: patter, roar, wind with gusts, and a hiss for blowing sand. Audio starts on the first user gesture and runs through a limiter.

**How it was checked.** 38 unit tests (schedule purity and rates, bolt shape, lattice wrap and world-fixedness, counts, light, the audio graph against a stub) and GPU tests: particles change pixels in open air and not in front of a wall 0.8 m ahead; at zero intensity the frame is bit-identical to a clear one; the bolt does not show through a wall or through cloud from above. An independent review found that lightning never thundered under a stepped clock and that dust was thickest overhead; both are fixed and tested. Cost: at 1080p, at most 0.2 depth reads per pixel standing in a skyfall and 0.63 flying through one; on lavapipe a skyfall adds about a fifth to the `tower` view's frame. Nothing ran in a browser at the time (decision 144 records the first run), and nobody has heard the audio.

**Not done:** lamp light on particles; splashes and snow accumulation on models; an option to soften repeated strokes (a strike can exceed three full-screen flashes in a second).

**Reason:** The owner asked for rain from drizzle to skyfall, snow, thunder and lightning, and dust storms, at 30+ FPS. Particles that are a function of position alone cost one draw call per kind and no per-frame buffer upload. A scheduled strike keeps the simulation deterministic (rule 5) and lets the sim later ask the same function where lightning falls. Synthesized sound keeps the static site free of audio assets.

### 143. The atmosphere in the app and in Free Flight: wiring, a quality governor, a render scale that probes upward, and wind in the flight model

**Date:** 2026-11-14
**Decision:** The effects of decisions 137–142 run in the campaign's simulation view and in Free Flight, a governor trades their quality for frame rate, and the shared flight model flies in moving air.

- **Campaign** (`main.ts`). Each frame the scene gets the game time, the weather view for that time, the planet's orbit and calendar (moon and stars), and once per world the terrain heights for the shadow, the mean ground for fog and dust (copied before `sim.init` transfers the climate's buffers) and the seed for lightning. `GlobeScene.paused` holds the effects' clocks while the camera still moves; `resetAtmosphere()` runs on cuts and seeks (entering the view, a station or camera change, a new world, a seek once the sim has answered it, a weather override), never per frame. Switching to the map releases the pipeline's render targets. The time bar's weather line names thunderstorms and dust.
- **Debug panel → Atmosphere** (`ui/atmosphereSettings.ts`): a weather override (the presets of decision 137, applied where the sim's frames arrive so it holds as hours pass), automatic quality, volumetric quality with switches for clouds, air and cirrus, haze, particles and their density, lightning, mountain shadows and their softness, snow sparkle, post-processing stages, volume and mute. Starting values are read from the scene.
- **Free Flight** (`freeflight/flightWeather.ts`, `clock.ts`, `url.ts`). It has no sim worker, so a `StandaloneWeather` runs on the main thread within 3 ms per frame, prepared on the start screen. Weather is an option on the start screen, in the pause menu (applied at once) and in the URL (`&weather=storm`), listed by short names (Clear … Dust storm, Live weather) with the preset's description beside the list; the default is `fair`, and `live` is the world's own weather. A preset shifts the land's temperature at the base, so snow lies where it snows. This amends decision 134 in one point: Free Flight flies on the day nearest full moon within the first synodic month (day 4 on the default world), not on campaign day 1, so that every night hour has a moon; there is no day option.
- **Quality governor** (`render/common/qualityGovernor.ts`), on by default; a quality or density set by hand turns it off. It has two steps below the panel's quality: the first lowers the volumetric quality one level, the second halves the particles. It steps down after 4 s in which the render scale is at or under 0.75 and not rising with the frame time at or over 0.7 of the target, or, where the scale is fixed or at its floor, the frame time is over 1.15 of the target. It steps up after 10 s at full scale under 0.6 of the target, or after 60 s merely on target. A step up that costs the full resolution is taken back, and one taken back within 30 s doubles that step's wait, up to 5 minutes. At least 5 s pass between changes; a frame counts as at most 4 targets. A break in the headroom or on the target shorter than 2 s (`GRACE`) is a single long frame, not a load: it neither restarts the wait for a step up nor makes a step up regretted. It holds over the map and after a hidden tab, and after every cut (a new world, entering the view, a new flight or restart, a station, a seek, a weather change) it counts no frame for 5 s (`WARM_UP`) and then for as long as terrain tiles are pending, up to 60 s (`WARM_UP_MOST`); at the end of that warm-up the render scale drops what its probes learned. Cuts less than about ten seconds apart leave the governor no time to act; the render scale carries the load then.
- **Render scale** (amends decision 69's controller for every user). A display shows whole refresh periods, so headroom under the old 70% rule is often invisible and the scale stayed where one slow spell left it. While on target below full scale the controller now probes one step of 0.05 up every 2 s; a scale that fails, by a failed probe or by a small step down that then holds, waits 60 s, doubling to 600 s. A frame counts as at most 4 targets, so the long first frame after a hidden tab no longer collapses the scale. The scale steps down at once only when 3 of the last 12 frames were over 1.1 targets: one or two long frames (a tile build, a shader compile, a collected heap) never move it. Before, where the display holds the frame time on the target (Target FPS 60 at 60 Hz, a page capped at 30 FPS), one such frame a minute took the scale to its floor and the governor to its last step within minutes. It also steps down when the mean of the last 96 frames is over 1.1 targets, for long frames that keep coming but are never three of twelve. That step is a trial: if the median of the next 96 frames is not 3% shorter, the time is not in the pixels, and the step is taken back and tried again after 1, 2, 4 and 8 minutes, then every ten. A probe is judged by the median of its 16 frames, or by 4 frames over 1.3 targets (`SLOW`), so two long frames among them do not fail it. Known limits: the controller holds the mean frame time within a tenth over the target, not under it; after a slow spell of 20 to 40 s, full scale can take 2 minutes and full quality 4 (decision 145). On simulated machines with wandering load the scale changes at most 16 times more in 30 minutes than the old controller's.
- **Wind** (`sim/flight/wind.ts`, `FlightModel.wind`). The air's velocity from the weather enters the one flight model that AI and player share (rule 12): airspeed, angle of attack and sideslip are relative to the moving air, so a crosswind drifts the aircraft and a headwind shortens the takeoff roll. Gusts are a hashed lattice in position and time, no random numbers (rule 5): 4 m/s RMS in a full storm, 1.2 m/s in cloud, 0.12 per m/s of wind near the ground. The wind the aircraft feels is capped at 8 m/s on the ground and rises to the weather's wind at 150 m: the storm, blizzard and dust-storm presets blow a gale across whatever runway is chosen, and the scripted pilot left the runway in an 18 m/s crosswind. Particles and sound use the full wind. With the pedals let go on the wheels the control laws hold the ground track (`trackHold`, the same for AI and player): from 2 m/s the nosewheel steers by 2° per degree of track error less 1° per °/s of yaw rate, within ±1.5°, and from the speed at which the rudder's rate loop closes (20 to 35 m/s) the rudder adds 8 rad/s² per radian of error; the error it answers is limited to 3°. It takes the track 0.25 s after the pedals are let go (after a pedal input it waits for the yaw rate to fall under 1°/s, at most 2 s), or the track of the touchdown or brake release if the pedals were already free, and acts 0.25 s later. A takeoff roll with free pedals to 160 kt stays within 0.4 to 0.6 m of the centerline in a 5 m/s crosswind and 1.1 to 1.5 m in 8 m/s (20 to 53 m before); a rollout that starts 5° crabbed stays within 6 m (52 to 85 m before). In still air the scripted pilot's whole circuit, flight in the air, a braked stand and any roll with a pedal in are bit-identical to the model before; an unsteered roll differs by 1e-8 m. Free Flight has a "Wind and turbulence" switch (`&wind=off`).
- **Audio.** One `WeatherAudio` starts on the first key, mouse button, click or lifted finger (it listens until its context has run, and runs it once from that gesture even while paused), is silent over the map, suspends while paused or while the tab is hidden, and is disposed on `pagehide`. Thunder on its way is cancelled on every cut and on switching to the map. The pause menu's volume slider plays a short tone and lets the ambience run for 1.2 s while paused, counted from when the context runs.
- **Aircraft shadow.** The flown aircraft's ground shadow fades under cloud and in terrain shadow.

**How it was checked.** `npm run check` and `npm run build` pass (111 test files, 760 tests). `tests/gpu/atmosphereWiring.test.ts` draws a real `GlobeScene` on Dawn through pause, reset, governor steps and `release()`. The governor and the render scale run against simulated machines (60 and 120 Hz displays, a 30 FPS cap, hitches, a hidden tab). The flight model was compared in lockstep with the committed one over the scripted pilot's whole circuit, air maneuvers and a tail slide; an independent review found it was not identical from the runway and that the first version of the probing changed the scale every 2.5 s under a wandering load, and fixed both. `tools/freeflight.preview.ts` renders flights with `WEATHER=`; `tools/freeflight.session.mjs` drives the real `FreeFlight` class in headless Chromium (no WebGPU) through all presets, pause, restart and a crash. Nothing had run in a browser with WebGPU at the time; decision 144 records the first run. A real GPU, the governor on real hardware, how the audio sounds and how the wind feels to fly remain unverified.

**Not done:** the debug panel's volume control gives no sound while paused; a campaign weather override also shows on the map; dust does not dim the aircraft's shadow; the start screen's map shows no weather.

**Reason:** The owner asked for the effects "as well as the free-flight mode" and for 30+ FPS. The volumetric stage is the largest new cost and scales by resolution, so stepping its quality is the cheapest way to hold the frame rate on a slow machine, and the adaptive render scale already measures the machine. Wind belongs in the flight model because a storm that does not move the aircraft is scenery; the ground cap is a gameplay accommodation until the control laws handle a gale on the runway.

### 144. The app in a browser on a software rasterizer; bakes spread over frames; idle render targets freed

**Date:** 2026-11-14
**Decision:** A smoke test flies the built app in headless Chromium with WebGPU, and the per-frame work that the cost pass found outside the march is cut: the sky LUT bakes less often, the coverage bake is spread over six frames, and unused render targets are freed.

- **Browser smoke test** (`tools/browser.smoke.mjs`, `tools/browser/`). With the production build served, it starts Free Flight from the start screen, flies six scenes through the pause menu (fair at golden hour, storm, snow, fog at sunrise, moonlit night, dust storm), takes off with the keyboard in the day's wind without touching the pedals (and fails if a wheel is off the runway at 150 kt), then runs the campaign's simulation view with a weather override from the debug panel, the map and back, and the time controls. It exits 1 on a page error, a console error, a WebGPU error, a lost device, a pipeline stage that gave up, a scene without its weather, a pause that does not hold, or sound that does not start. The app hands the tool its state through `window.bearing`, which exists only on the dev server or with `?dev` (typed as `BearingHandle` in `main.ts`).
- **Software WebGPU.** Chromium's own software adapter (SwiftShader) cannot run Bearing: the tile synthesizer's compute never finishes and the GPU process grows by about 50 MB a second until the kernel kills it. This predates the atmosphere work (`src/worldgen/gpu` is unchanged). The tool's `MODE=lavapipe` therefore starts a hard-link copy of Playwright's Chromium in which a shim (`tools/browser/lvpshim.c`) stands in for SwiftShader's Vulkan library and forwards to Mesa lavapipe. Chromium's compositor cannot show what lavapipe drew, so the tool reads pictures back through the device. `MODE=gpu` is written and has never run. The app does not start on a software adapter unasked: it shows a notice (what a software adapter is, that Bearing needs a hardware GPU, how to check `chrome://gpu`) with a "Start anyway" button; `software` in the URL skips it, and the smoke tool passes it in its lavapipe and swiftshader modes. The model viewer has no notice.
- **Sky LUT bakes** (`render/sim/atmosphere/skyView.ts`; refines decision 140). The table is re-baked when the sun's cosine moves by 2e-5 on or under the horizon, rising to 2e-4 from 8° up and scaled by the cosine of the elevation, or when the camera's height moves by 0.25 m + 0.1%. A stale table stays within 0.2% (sun) and 0.3% (height) of the sky's radiance, under one 8-bit step. In a 10 m/s climb at golden hour that is 4.6 bakes a second where it was 15; in level flight by day about one.
- **Coverage bake** (`render/sim/clouds/coverageBake.ts`; refines decision 141). A bake that is due only to age (every 10 game seconds) or to the weather texture's re-blend of its fields (every 28 game seconds) fills one cube face per frame over six frames. A new hourly frame, changed settings, the first bake and a clock that jumps or runs fast still bake all six at once.
- **The weather in view** (`cloudLayer.ts`). The scan of the weather samples around the camera repeats only after 400 m of travel, 2% of altitude or new weather, with the scan widened by those margins.
- **Idle targets** (`render/sim/post/simPipeline.ts`; refines decision 138). The volumetric stage's three targets and the overlay's target are freed after 600 frames without use and come back on the first frame that draws them: 21 MiB at 1080p and medium quality on a clear, dry day. Three's own frame target, which a view that drew directly leaves allocated, is disposed on the way back from the map (through the private `_frameBufferTargets` of r187), so the memory figures hold after a map visit too.
- **Esc in Free Flight.** `FlightInput` ignored every key while a menu had the controls, so Esc opened the pause menu and never closed it. A key's release now always counts and the pause key acts while the controls are off.

**What the browser run showed.** Chromium 153 on lavapipe, about 15 sessions: no page error, no WebGPU validation error and no device loss. At the same weather clock the browser's frame equals the Node preview's within one level per region. The canvas is `rgba8unorm`, premultiplied, with alpha 255 in every pixel. Pause holds the clocks; a weather change in the pause menu shows at once; the map releases the pipeline and the view comes back. The audio context starts on the first key, suspends while paused and is silent over the map. On that far-too-slow machine the render scale and the governor reach their floor (0.35, step 2) within a minute and stay there for the 160 s watched, without oscillating.

**What the cost pass showed.** On lavapipe, alternating runs against `main` at 640 × 360: the frame with live weather is 0.76 to 0.93 of `main`'s, because the sky LUT gives back more than the pipeline and the march cost (a sky pixel is 2 texture reads where it was a 32-step march); a clear day is 0.60 to 0.96; a storm at medium quality with 15,000 rain streaks and a bolt is 1.01 to 1.14. At 1408 × 792 with trees the live-weather frame is 0.71 to 0.91 of `main`'s, with at most 82 draw calls and 0.5 M triangles. The volumetric stage alone: low costs about half of medium, high 2 to 2.5 times medium. On the main thread (Node on Dawn) the atmosphere's updates take 0.25 to 0.34 ms per frame and each pipeline pass about 0.1 ms; a frame has 7 passes on a clear day and 10 or 11 under cloud, against 2 on `main`. GPU memory added at 1080p: 25.5 MiB on a clear day, 46.6 MiB in a storm at medium. A clear day is not free: the pipeline costs five small bloom passes and 2.7 more texture reads per pixel than `main`. Frame rates on real GPUs are estimates from read counts (a storm at medium at 1080p: under 1.5 ms on a mid-range discrete GPU, 5 to 8 ms on a recent integrated GPU, 15 to 25 ms on an older one), not measurements.

**Not done:** a first `MODE=gpu` run on a machine with a GPU; the acceptance checks' gaps (low-resolution blocks in the far cloud band at dusk, and a stipple on side cumulus at medium), which are tasks in `TODO.md`.

**Reason:** Until this run nothing of decisions 138–143 had met Chromium's validation, the canvas path or the real frame loop, and `main` deploys to the public site. The owner asked for 30+ FPS, so the cost has to be known against the frame before the work, and the remaining spikes (a 570 ms coverage bake in one frame on lavapipe, a sky bake every other frame in a climb) were the cheapest to remove without changing a pixel: still frames before and after are identical to the bit.

### 145. What an adversarial review of the atmosphere found: a render scale that single frames cannot ratchet, a track hold on the wheels, a march that keeps its sample offsets, and a notice for software adapters

**Date:** 2026-11-15
**Decision:** Two reviewers read decisions 137–144 against the code and the browser run, two engineers fixed what the reviewers found and what the acceptance checks showed, and two further engineers tried to break the fixes. Twelve findings, five gaps of the checks and six defects in the fixes themselves are repaired; the statements of decisions 136–144 are edited in place and this entry records what changed and why.

- **Render scale and governor** (`render/common/renderScale.ts`, `qualityGovernor.ts`; decision 143). Single long frames took the scale to its floor and the governor to its last step within minutes wherever the display hides headroom. The scale now steps down at once only on 3 slow frames of the last 12, and on a mean over 1.1 targets across 96 frames as a trial that is taken back if the median does not improve; probes are judged by their median; the governor ignores breaks under 2 s and counts no frame for 5 s after a cut or while tiles are pending (up to 60 s). "Holds while terrain loads" had been a flag that is set once per world.
- **Track hold** (`sim/flight/controlLaws.ts`; decisions 136, 143). With free pedals a crosswind turned the nose into the wind and the track followed: 20 to 53 m off the centerline by 160 kt. The shared control laws now hold the ground track on the wheels with nosewheel and rudder; one path for AI and player (rule 12). The scripted pilot's circuit is bit-identical, because the hold acts only with the pedals exactly neutral and the pilot steers.
- **Cloud march** (`render/sim/clouds/volumetrics.ts`; decision 141). Cumulus seen from close above were terraced: the skip to a column's top advanced by the distance from the sample, so all nine sample offsets landed on one shell. The skip now keeps the offset. The light's and the density's step ranges start earlier, which removes most of a stipple at medium quality; the counted reads rise by at most 9.9% (a blizzard) at every quality.
- **Fog and veils.** Fog seen level was horizontal streaks (strata 8 → 2). Snow, rain and dust hardly veiled the aircraft 12 m ahead, because the march's fine structure decided the first step; within 15 m the air now has the weather's own extinction.
- **Cirrus** comes in with the cloud cover in view and follows it over 6 s; it popped at 1.7% cover, and in live weather with every weather sample that entered the view.
- **Water under cloud** (`render/sim/water/waterShading.ts`) mirrored the clear sky's LUT under an overcast. It now mirrors the gray deck. The first version of that fix divided the lightning flash by the sky's gains, which are 0 at night, and turned the sea white in every flash; the verification caught it, and the flash is now mirrored separately at half its light on surfaces.
- **Terrain shadow at a cube-face crossing** (`terrainShadow.ts`; decision 139). Shadows went out for the 27 passes of a re-bake. Each grid now keeps its field, read in the frame of the face it was baked on, until its own bake on the new face is published.
- **Upsample** (`simPipeline.ts`; decision 138). The weight floor of 0.02 applied everywhere and put a ripple at the texel period on every gradient in cloud (a grid of columns in a deck at dusk); it now applies only across a depth edge.
- **Smaller ones.** Particle and bolt widths in drawing-buffer pixels; three's frame target disposed after a map visit; sky light 0 no longer divides 0 by 0 in the cloud's moonlight; ground wetness dries in game time under acceleration; a weather field's re-blend no longer bakes all six coverage faces in one frame; scheduled thunder is cancelled on a cut; audio starts on a lifted finger and keeps listening until its context runs; the pause menu's volume slider can be heard; weather lists use short names.
- **Software adapters** (`render/common/webgpuSupport.ts`; decision 144). On a software WebGPU adapter the app showed nothing and hung in world generation. It now shows a notice with "Start anyway" (`software` in the URL skips it). `tools/hud/notice.html` shows the notice without WebGPU.

**How it was checked.** `npm run check` passes (116 test files, 814 tests), the build succeeds, and the browser smoke test passes after the fixes (Chromium on lavapipe, 12 scenes, the takeoff in the day's wind with free pedals to 183 kt). Each fix has a test that fails without it; the verifiers undid each fix in turn (nine mutants in rendering, twelve in the app and flight model) and every mutant was caught, after two tests were added for paths that had none. The march was compared with a brute-force march of 3,000 even steps on 5 weathers, 13 heights and 26 rays at each quality: the mean error fell slightly (0.0080 → 0.0073 at medium) and no cloud was missed. The track hold was flown in lockstep against the model before on four runway headings, in crosswinds to 8 m/s, storm gusts on 12 headings, rejected takeoffs and crabbed landings: at most 2.2 m off the centerline through liftoff. The render scale ran against 73 simulated machines and displays. Stage time on lavapipe at medium, interleaved against the commit before: geometric mean 0.93, which on shared cores says no regression and no more. The acceptance checks 1–5 were rendered again in live, fair and clear weather and read against the text of Part I; the reference board is not in the cloud container.

**Not done:** nobody has flown the track hold by hand, heard the audio or run the app on a real GPU (`MODE=gpu`). The far cloud band at dusk still shows low-resolution blocks at medium, side cumulus keep a faint stipple at medium, and cumulus from above at a high sun are nearly uniform white. A deck seen from below is 1.6 times brighter in linear terms than before the light's step range moved; that is for the owner's eye. A page capped at 30 FPS with a 100 ms frame about once a second still drives the governor to its second step, though fewer pixels help nothing there. These are tasks in `TODO.md`.

**Reason:** The owner asked to keep iterating until the effects hold 30+ FPS. A controller that reads one garbage collection as a slow machine gives up resolution and quality that the machine can afford, which costs the look without buying frame rate; that was the largest risk to the request on real hardware, and it was invisible on lavapipe, where the machine is in fact too slow. The rest are defects in what decisions 137–144 claim, found by reading the claims against the code.

### 146. Water in the terrain: river surfaces that never rise, carving last, a coastal profile with cliffs and beaches, marshes, and a sea that does not repeat

**Date:** 2026-11-15
**Decision:** A review of how the tiles and the renderer handle water, after the owner saw humps in river canyons, a uniform, repeating sea from altitude, and asked for rocky islands, sandy beaches, soaring cliffs, and wetlands. The global terrain and erosion are unchanged; everything here is in the river index, tile synthesis and the water shader.

- **Why rivers climbed.** A tile cut each river to a water surface read from the global grid's bicubic height at the nearest point of its smoothed polyline. Chaikin smoothing and meanders move that polyline off the 1.5 km cells it drains through, onto the valley walls, so the surface rose and fell with them; the falls' steps were blended in by a weight that changed along the river and could lift the surface by up to a stratum (75 m); the nearest segment switched at confluences; and the ragged-coast noise (up to 45 m) and the skerry knobs were added after the carve, damming lower courses. `tools/rivers.preview.ts` walks 24 rivers with relief, 307 km of channel, on level-7 tiles and reads the ground under the centerline: before, 48.3% of the channel lay more than 2 m above the lowest bed upstream, the largest hump was 762 m, and the beds climbed 11.6 km in all against 3.2 km of drop.
- **Water surface profiles** (`RiverIndex`, `riverProfiles`, `PROFILE_TUNING`). Each polyline now carries a water surface: the global height of the cells it drains through (the lake's level in a lake, sea level at the mouth), 0.5 m below, smoothed with the polyline and then made non-increasing downstream. Polylines are visited upstream first, so a main river starts no higher than its tributaries and each tributary ends on the main river's surface. The falls' pools and drops are computed here as well, as a second surface, with points added at the top and foot of each drop so that a drop is a ramp over its run; it too never rises. Segments carry 12 values (`RIVER_SEGMENT_FIELDS`): the two endpoints, widths, surfaces and stepped surfaces. A river index without heights carves nothing.
- **Carving.** The tile kernel cuts every segment within reach (`carveRivers`): each lowers the ground to its channel by its own reach weight, the deepest cut wins, so confluences have no seam, and carving never raises ground. Tiles finer than about 1.2–3 strata use the stepped surface. The carve now runs after the coastal noise, coastal profile, deltas, skerries and reefs, so none of them can dam a river; river channels within a lake's reach keep their cut instead of being raised above the lake. After the change: 0.23% of the same channel lies more than 2 m above the bed upstream, the largest hump is 7.1 m, and what the beds still "climb" (1.9 km against 3.1 km of drop) is the ±1–2 m of bilinear sampling across a channel narrower than the 48 m samples. At the global cells the profile cuts at most 3 m below a cell (the drainage fills pits shallower than a lake), so it digs no trenches of its own; where the interpolated terrain stands above the river, the channel incises through it, as rivers do.
- **Coastal profile** (`cliff*`, `beach*` in `TILE_SYNTH_TUNING`). Within decision 130's coastal band, after the ragged-coast noise, heights near sea level go through a monotone map, so the shoreline stays where it is. On headlands (where that noise raises the shore, with a regional term) of coasts that gain 25–70 m over 1.5 km, |h| below the cliff height (the coast's gain, up to 220 m) is raised to the power 0.3: the ground rises steeply from the water and the sea floor drops away below it (at 0.4 of the height), with stacks and rocks offshore. Not within about a kilometer of a river mouth. In the coves of gentle coasts (gaining under 40–90 m), the first 6 m above and below sea level are flattened by the power 1.8 into a beach and a sandy shelf, and dry ground up to about 2.5 m (±50%) is sand: a tile-only cover, `TileCover.Beach`, in Part I's sand `#C9B48A`. Not on glaciated coasts, whose skerries stay bare rock. Islets the coastal noise raises out of the sea are bare rock.
- **Marshes** (`marsh*`, `TileCover.Marsh`). On ground with aridity below 0.2–0.4 and a global slope under 0.2–0.6% (three times that on coasts), within 3.5 m of a water table (a river's surface out to three floodplain widths, beyond a dry levee a few samples wide; a lake's level on its shore, never in the lake; sea level plus 0.25 m on low coasts that are not beaches), in patches of about 6 km: the ground is raised to just above the table and then leveled to it with noise of 380 m and finer, and the samples carry the table as their lake level, so the pools where the ground dips below it are drawn as lakes, shoreline and freezing included; about a quarter of a marsh is open water. Ground in the marsh's reach that a channel's banks left below the table is raised first, so only the noise makes pools and none meets samples without a table. Marsh ground is olive (`#6B7A4E`) with few trees; low warm coasts grow mangroves (forest in stands). Not in river channels, on salt pans or skerry coasts. On the campaign world of seed 1983, marsh covers about 0.5% of the land in level-7 tiles at 40 floodplain cells; on its coasts salt marsh is rare (most low coasts are beaches). The world still has no wetland biome: these are tile covers, and the strategic map's wetland mask (decision 81) remains a task.
- **Shore colors.** A mesh vertex takes the material of the nearest data sample, so on a steep shore a dry vertex could read the sea sample beside it and take the shelf's blue: blue sawtooth triangles at the foot of the new cliffs, and the pale blue patches that already lay on skerry islands. A dry vertex with a water biome is now sand below 4 m and rock above. The sea is also drawn only where the drawn surface is within a few meters of sea level, so a triangle from a flattened sea vertex up a cliff face is not painted as water partway up.
- **The sea from altitude** (`WaterShading`). The wave field tiles every 4,096 m by construction (decision 38); from altitude a few long waves resolved alone interfered into a regular plaid, and the same field everywhere read as uniform. Now: waves hand over to the roughness below 2–6 px with the camera within 1.5 km of the water, as before, and below 4–12 px from 6 km up (by the camera's height above the water plane; the plaid shows only from high above, and the resolved short waves make the sparkle of a low view); gusts and calms from noise on the planet-centered position, which does not repeat, scale the wind waves' slopes from 0.2 to 1.9 times, drawn out four times longer along the wind into streaks (the weather's wind at the camera, direction only); a swell of six long waves (170–420 m) in two systems runs at sea and fades in water shallower than about 40 m; the open sea's color varies in broad patches, a little greener or darker, and turns greener near the coast; and when the weather's storm channel rises the sea state rises with it, raising whitecaps on the crests of the shorter waves, averaged to a faint coverage where they are unresolved.
- **Tools.** `tools/rivers.preview.ts` measures river beds as above (on the uncast seed's world; the render preview uses the campaign world, whose seed can differ after the validity retries). `VIEWS=ocean` looks over open sea from 12 km (the deep-sea cell nearest the check-5 coast); `SPOTS=cliffs` looks at a high coast from the sea and `SPOTS=marsh` at a large river on flat, wet lowland (scored on the global grid, so it can miss the tiles' marshes).

**How it was checked.** `npm run check` passes (116 test files, 817 tests). New tests: river surfaces never rise along a polyline, tributaries end on the main river's surface, steep reaches step into pools (`tests/landforms.test.ts`), and on the GPU the longest river's water floor (bed, or a lake's level) rises at most 4 m along its channel (`tests/gpu/tileSynth.test.ts`). Previews on lavapipe, before and after, of `ocean`, `sea`, `shore`, `beach` and the spots `canyon`, `falls`, `delta`, `skerries`, `reef`, `cliffs` and `marsh`: at 12 km the plaid of the old wave field is gone and the glint breaks into patches; the check-5 coast has a sand beach; the cliffs spot shows a rock wall rising from the water with sand at its foot; the falls spot's river runs in a level-floored valley instead of over bumps.

**The glint after the owner's review.** The owner saw the sun's sparkle gone from the skerries view. Counted as pixels with every channel at least 235 below the horizon, in the same weather: skerries 66 before this decision, 0 after it; reef 881 and 616; looking into the sun (`sea`) 6,893 and 7,976. Two changes had taken it: the hand-over at 4–12 px everywhere (skerries 15 with the height rule) and a weighting of the waves by the wind that cut those across it to a third of their slope (Cox–Munk's up- and crosswind variances differ by less than a factor of 2), which removed the waves that send the sparkle to the camera when the wind blows across the sun's line (28 with a mild weighting, 149 without). The waves now keep every direction; the streaks still show the wind. After: skerries 149, reef 1,045, `sea` 7,590, none blown out to white, and the sea from 12 km keeps no plaid.

**Not done:** nobody has looked at it in a browser. Beach and marsh edges follow the 48 m samples. A thin parallel channel beside a large river draws as dark water along its bank (seen at the marsh view; not from the marsh). Salt marsh is rare. Sea state follows only the storm channel and the wind's direction at the camera. These are tasks in `TODO.md`.

**Reason:** Water must run downhill: a river that climbs breaks the illusion more than any missing detail, and the cause was structural (a surface sampled where the river is not), so the fix gives each river a surface of its own instead of tuning the carve. Beaches, cliffs and marshes follow causes the world already has (the coast's relief, waves eroding headlands and filling coves, a water table on flat ground), as decision 126 asks, and each is a monotone or local change that keeps coastlines, lakes and the campaign's data as they are. The sea's repetition came from a periodic field seen at a scale where its period shows; non-periodic modulation and an earlier hand-over to roughness remove it without losing the field's precision near the surface.

### 147a. A tree kit from model specs; lumpy blobs

**Date:** 2026-11-15
**Decision:** The tree kit of Part I's *Vegetation* exists as model specs (decision 106), the first step of the owner's brief on forests for low flight, written up as the draft proposal 0003.

- **Model class `tree`** with Part I's budget of 12–80 triangles. Trees darken toward the ground in the baked occlusion, as buildings do.
- **Blob jitter.** A blob may set `jitter` (0–0.5) and `seed`: each vertex of the unit icosphere moves along its radius by up to ± that fraction, by a hash of its position, so faces that share a vertex move together and the blob stays closed. Crowns become lumpy and faceted rather than geometric.
- **Nine specs:** fir (four tiered cones, 50 triangles), pine (umbrella crown on a tall trunk, 58), oak (three masses, 70), broadleaf (two masses, 50), birch (pale trunk, 50), poplar (column, 30), acacia (flat disc on a forked trunk, 44), shrub (20) and dead tree (26). Crowns carry two or three of Part I's canopy shades, so value varies within a tree; new model colors name those shades, a birch green, a dry savanna green and four barks.
- **Previews.** `tools/trees.preview.ts` draws the kit in a row and a forest corner (closed fir and pine stand, lower broadleaf stand, fringe, hedgerow, poplar row, lone oak, dead tree) from a hovering helicopter and from above, on the CPU; the rasterizer of `tools/models.preview.ts` moved to `tools/modelRaster.ts` so both use it. The model viewer lists the trees with the other specs.
- **What the previews showed.** A broadleaf stand at 9.5 m spacing leaves the floor showing between crowns from above; at 7.5 m it closes, and a dark sheet at about 60% of the crown height (the proposal's understory shell) makes it read as one mass with crowns as relief. The conifer stand standing 4–5 m above the broadleaf stand is the most legible feature of the oblique view.

The forest layer still draws the clumps of decision 45; the kit replaces them with the proposal's near trees, after the owner's review.

**Reason:** The brief asks for faceted, slightly cartoonish trees that fit the faceted terrain. Specs keep the trees reviewable as text and within budget, and the CPU previews let the look be judged before the forest layer changes.

### 148. Forests for low flight: a canopy height field, a canopy shell, near and edge trees (proposal 0003 accepted)

**Date:** 2026-11-15
**Decision:** The owner accepts proposal 0003. A forest is a volume with a canopy height H(p) = cover × stand height: zero in the open, the stand's height inside a forest, with the edge on the forest density contour of decision 71 (threshold 0.42). The renderer and the simulation read the same H.

- **Three layers** (Part I, *Level of Detail*): near trees from the kit of decision 147 (crowns only inside stands, whole trees on edges and in the open; laptop 0–700 m), edge trees along forest edges, hedgerows and tree rows (0–1.5 km), and a canopy shell, the terrain tile mesh drawn again and lifted by H (0–12 km), which sinks to about 60% of H near the camera as the understory between crowns. Beyond the shell, the terrain's flat canopy shading of decision 71 remains.
- **Stands, lines and singles** give low-altitude orientation: stands 100–400 m across with a composition, height and shade; species by place; hedgerows, tree rows along roads, woods along rivers and lone trees, all from the world seed.
- **Owner's answers.**
  - Shades: Part I's canopy shades as in the previews; the owner judges them in the game later.
  - Tree shadows: deferred; occlusion baked into the crowns and the dark understory carry the depth cue. Part I's "casting shadows" in the 0–1.5 km band is gone.
  - Hedgerows: by region. Biomes cannot tell Normandy from the Midwest; climate can (an annual range of about 12 K against about 29 K). Hedgerow density follows the climate texture's seasonal half-range and moisture on farmland, more on rolling ground, times a regional term over a few hundred kilometers; continental plains get sparse shelterbelts along the field grid.
  - Line of sight: for any sight line from or to an aircraft, a closed forest is opaque up to its canopy top, edges included. Ground units' sight at forest edges is settled with the ground entities.
- **Simulation.** The ground model treats H as an obstacle: rotor or airframe below the canopy top inside a closed stand strikes the trees.
- **Budgets.** Near and edge radii by quality tier (tablet 400 m and 1 km, laptop 700 m and 1.5 km, desktop 1.2 km and 2.5 km), stepped by the quality governor after the atmospheric effects; about 0.5–0.8 M triangles for trees and shell over dense forest at the laptop tier, estimated, not measured. The shell does not scale, so every machine keeps its tree lines.
- **Check 2** gains a view 30 m above a forest edge with a hedgerow, looking along the tree line.
- **Kit fix (owner review).** The birch's crown seemed to float over its thin, pale trunk, which touched it only at the crown's lowest point; the crown now sits lower on a thicker trunk that reaches 11 m into it.

`docs/design.md` (line of sight, flight model, simulation view), Part I (*Vegetation*, *Performance Budgets*, check 2) and TODO (the old tree LOD and denser-forest tasks become the proposal's steps) change with this decision.

**Reason:** An attack helicopter's tactics depend on what a tree line hides, at the range where pop-up attacks happen. Flat canopy paint gives no cover and thinned clumps make distant forest translucent; one height field drawn as a cheap shell gives cover at every range, and sharing it with the simulation makes the cover on screen the cover the AI respects.

### 147b. River banks and bars, white water on fast reaches, and foam on lake shores

**Date:** 2026-11-15
**Decision:** The owner asked, after decision 146, for river banks and beaches, white water at river edges, and foam lines on lakes.

- **Bars** (`barWidths`, `barRise` in `TILE_SYNTH_TUNING`; `TileCover.Gravel`). Tile samples just outside a channel, out to 1.2 half-widths (at least 1.5 samples) beyond the bank and within 1.6 m of the river's water surface, are bars: sand (`TileCover.Beach`) on lowland rivers, gravel (`#999185`) where the global slope exceeds 1.5–4% or the ground was glaciated. Noise at eight half-widths (at least 300 m) breaks them into patches along and across the river, as shoals and point bars. Not in marshes or under lakes. Point bars proper, on the inside of each bend, would need the bend's side in the river index; the patches stand in for them.
- **The bank** (`RiverStyle.bank`). Part I asks for "a narrow darker bank": a band outside the water an eighth of the river's width (1.5–10 m, at least a pixel), the ground darkened to 72%, only where the river is drawn near its true width (its legibility widening would otherwise thicken it) and at least 3–8 px wide on screen.
- **White water** (`RiverStyle.whiteWater`). The river tables encode each segment's gradient, from decision 146's water surface, in the length of its endpoint directions (1 + gradient; `encodeGradient`, on in the simulation view only, since roads and the strategic map share the layout), and the shader normalizes them. From a bed gradient of 0.8% to 3% a band at the banks, a third of the half-width wide (at least 4 m and a pixel), turns white, and on the fastest reaches the whole channel up to half; the terrain shader breaks that weight into churning foam with periodic noise on the wrapped coordinates whose third axis runs with time. On seed 1983 a quarter of the length of rivers 20–50 m wide is that steep, and 2% of rivers over 150 m. The same resolution limits as the bank apply, so distant rivers do not glitter (decision 120). Falls stay white on steep facets as before.
- **Lake shores** (tileMesh `lakeShore`; `WaterShading.lakeFoam`). The mesh's coast distance now also measures lake shores where a lake is nearer than the sea (in the simulation view only: the strategic map's coastal lines read the same field), and the foam band covers lakes at 60% of the sea's width and 70% of its strength. Marsh pools, marsh ground off the global lake's cells, keep the sea's distance and get no foam ring.
- **What went wrong on the way.** White water drawn from noise on each segment's own coordinates repeated per segment (rings, then a checkerboard from two crossed wave trains); it now lives on the world's wrapped coordinates. A first bank a quarter of the width wide and darkened to 62% read as a shadow along the river.
- **Debug panel.** "River white water" and "River banks" turn the two shader effects off.

**How it was checked.** `npm run check` passes; a test checks the gradient encoding and that normalized directions and half-widths are unchanged. Previews in clear weather (`SPOTS=falls,lake,canyon,glacial`, and the observer over a large lowland river): sand bars along both banks of the large river and pale bars along the glacial valley's river; on the steep reach of the falls spot, foam broken by the brown water; a faint foam line on the lake's shore. Rendered in clear weather so that cloud does not hide the water; the live weather's clouds are unchanged (decision 146).

**Not done:** nobody has looked at it in a browser or in motion. Lake foam is thin: the band is about one mesh vertex wide at level 7. Bars follow the 48 m samples.

**Reason:** Banks, bars and white water are what make a river read as moving water at low altitude, and each follows data the world already has: the water surface of decision 146 gives the gradient and the level a bar must lie near.

### 149. Helicopters: a rotor-disc flight model, fly-by-mouse, three assist presets, and landings flown by the player (proposal 0004 accepted)

**Date:** 2026-11-15
**Decision:** The owner accepts proposal 0004. Helicopters get their own flight model beside the fixed-wing one and a new post-demo track, H1–H5. The plan is `docs/plans/helicopters.md`.

- **Thrust-disc model.** One rigid body; the main rotor is a disc whose thrust acts along its normal, with no blade-element simulation. Cyclic tilts the disc with a first-order flapping lag; hub stiffness (teetering, articulated, hingeless) sets the control moment beyond the thrust tilt and the behavior at low load factor; power required follows the bucket, with translational lift at 15–25 kt and ground effect within about one diameter; torque is countered by a tail rotor of limited authority (a yaw-authority parameter for tandem and coaxial types); fuselage, fin, stabilizer and stub wings; retreating blade stall, vortex ring state, mast bumping, autorotation and tail rotor loss as modeled hazards. Same 120 Hz step, float64 position and determinism as the fixed-wing model, in `src/sim/flight/`. Type parameters live in the model spec.
- **One director interface.** Fixed-wing and rotary-wing aircraft share one flight director interface and one `Airframe` interface that the camera, HUD, outcomes and Free Flight read. The AI flies helicopters through the same director and model as the player (rule 12).
- **Fly-by-mouse is the default.** Mouse vertical motion commands pitch attitude; horizontal motion commands yaw rate below about 20 kt and a coordinated turn above about 40 kt, blended between (type parameters); W/S collective, A/D lateral cyclic, Q/E pedals, H hover hold. Mouse aim (for gun and rocket runs) and direct control (for sticks) are the other two modes.
- **Three presets over independent assists:** Assisted (default), Standard and Expert, as tabulated in the proposal. Switching an assist off removes protection, never a capability. Envelope protection limits inputs near hazards and never changes the physics; the AI flies with it on.
- **Landing exception.** Helicopter missions extend the jump-in window over their ground phases, and the player may fly every helicopter takeoff and landing. Fixed-wing aircraft keep proposal 0002's rule, apart from Free Flight (decision 134).
- **Track H** follows P1 and uses Free Flight as its test bed: H1 rotor model and fly-by-mouse (Little Bird and Black Hawk analogues), H2 all modes and types, H3 ground and utility, H4 hazards and damage, H5 combat and AI (after P4). H milestones are visual milestones and close after Part I's acceptance checks.

How the plan reads the proposal, for the owner to confirm:

- **"Follows P1"** means P1's framework: the shared airframe and director interfaces, which H1's first step builds from Free Flight's code, and the input and gamepad plumbing. P1's campaign tasks (promotion, jump-in, handback) block only H5.
- **New types stay out of the campaign** until a task adds them with its own decision. The air war's type table has four helicopters (AH-70, CH-60, Ve-28, Ve-36); the Little Bird, Black Hawk, Lynx, Cobra, Huey and Mi-8 analogues are new, and adding them to the order of battle would change every world's cast. H1–H4 fly them in Free Flight.
- **Power from physics, calibrated to the spec's curve.** Momentum theory and a closed-form blade integral give thrust and power; the spec's power-required curve and hover ceilings are the calibration targets the tests check, so translational lift and ground effect emerge rather than come from a table.
- **P5's gunner mode and sling-load tools** move to H5 and H3; P1's rotor discs and rotor wash move to H1 and H3.
- **Wind** needs no new weather work: decision 143 already gives the flight model local wind and gusts. Its 8 m/s cap below 150 m, a runway accommodation for jets, gives way to a surface-layer profile for helicopters in H1.

The proposal's open questions on engine start and door gunners stay open; the plan recommends hot starts through H4 and AI-only door gunners in H5. `docs/design.md` (*Decisions So Far*, *Mission Search and Jump-In*, *Flying*, *Milestones*, *Open Questions*), Part I (*The Controlled Aircraft*, *HUD and Displays*), proposal 0002, `CLAUDE.md` and `TODO.md` change with this decision.

**Reason:** Attack and transport helicopters are a large part of the war Bearing simulates, and their missions end on the ground. A thrust disc with a few physical effects gives each type its character at a cost the browser can carry, and a control layer that changes meaning with speed lets a mouse fly it, as Arma 3's standard model showed. Keeping protection in the control layer, never in the physics, lets one model serve both the new player and the expert.

### 150. The canopy height field, the canopy shell and kit trees that stand on it

**Date:** 2026-11-15
**Decision:** Steps 2–4 of proposal 0003 (decision 148): forests are a canopy height field drawn as a shell over the terrain tiles, with the tree kit (decision 147) in front of and on it. The clumps of decision 45 and the distance thinning of decision 131 are gone.

- **The field** (`worldgen/canopy.ts`): H = stand top where the forest density reaches 0.42, else 0. Stands are cells of a 3D Voronoi diagram on the sea-level sphere (sites jittered in a 220 m lattice, so stands of 100–400 m), each drawing its kind (conifer by the climate's conifer share at the point, as the terrain's canopy shading), an age (conifer 18–26 m, broadleaf 14–22 m, rainforest 28–38 m), a young stand at 55% of the height one time in seven, and a shade (0.86–1.14). Value noise on a 45 m lattice lumps the top by ±12%. Randomness is an integer hash of lattice cells and a per-world seed (`canopySeed`), so `render/common/canopyNode.ts`, the TSL twin, picks the same stands bit for bit; a GPU test checks heights, kinds, shades and lumps against the CPU on 2,000 points (99.5% identical; only points within float32's reach of a boundary may differ). A function taking the cell as a TSL `Fn` parameter, and `.toInt()` on a vector (which yields a scalar), both hashed wrongly in the first attempt; the hash is now inlined and takes an `ivec3`.
- **The shell** (`render/sim/forest/canopyShell.ts`): forested terrain tiles (any vertex with density over 0.30) get a second mesh on the same geometry and userData, drawn within 12 km and flattened over the last 3 km. Vertices rise by H times a lift from 0.30 to 0.44 of density; fragments under 0.42 are discarded, so the shell ends near full height on the contour. Lanes open along roads, runways and taxiways (6 m beyond the pavement, `RoadShading.clearance`) and over towns and industry. Each face takes the stand at its center: conifer, broadleaf or rainforest canopy times the stand's shade; within the near trees' range the shell sinks to 60% of H and darkens as their understory; seen from below it is darker still. Seasons as on trees; snow follows the ground's snow cover, decided per face as on the ground (the first version blended snow in wherever it froze and turned dry winter forests pale gray where the ground had none). GUI: View → Terrain tiles, "Forest canopy (shell)" and "Canopy range (km)"; Status counts canopy tiles.
- **Kit trees** (`render/sim/forest/forestLayer.ts`): placed per quarter of a level-10 tile (about 770 m; tile keys stop at level 10), a lattice row at a time within 4 ms per frame (a dense part takes 60–140 ms in all). Closed forest: an 8 m jittered lattice; each tree takes its stand, conifer stands fir and pine (70/30), broadleaf stands broadleaf, oak and birch, rainforest broadleaf, scaled so its top is the stand's lumpy H (±7%); trees whose neighborhood 11 m out is all closed forest draw crowns only. Open land and the fringe: an 18 m lattice, half full within 0.15 of the threshold and by density in the open (shrubs, birch, broadleaf, oak; fir and birch in the cold; acacia and dead trees in dry heat). The CPU reads the climate texture's half floats (`ClimateTexture.sampleAt`), filtered as the GPU does.
- **Culling and LOD per tree.** A part in view is re-sorted into its meshes whenever the camera has moved 25 m (nearest parts first, 2 ms per frame): only trees within range stay, crowns to 600 m and whole trees to 1.2 km, each in its near mesh (the full model) or, beyond 350 m, its far mesh (`tree-*-lod` specs: one cone or one jittered blob on a trunk, 18–28 triangles). Trees shrink away over the last 30% of their range, into the rising shell. Per-part culling alone drew 1.8 M tree triangles in `treeline`, because a part in range was drawn whole out to 1.4 km; switching models per tree with both meshes on straddling parts drew 2.4 M.
- **Previews.** `treeline` (25 m over a river through dense forest, 700 m back from the forest target, looking along the corridor; the observer camera, since the orbit camera keeps hundreds of meters above the ground) and `canopy` (100 m over the same forest, looking down 18°); `observerBack`, `eyeHeight` and `pitch` place a view's observer behind its target. `SHELL=0`, `TREE_NEAR` and `TREE_EDGE` (m) for comparisons.
- **Measured** (seed 1983, 1024 × 576, software renderer; counts, not GPU time): `treeline` 20,500 trees, 0.46 M tree triangles in 90 draws, terrain and shell 0.58 M in 67; `canopy` 20,100 trees, 0.46 M in 103 draws, terrain and shell 0.53 M in 61; `conifer` (500 m up) 2,300 trees. The software renderer's frame fell from 1.66 s (per-part culling) to 0.41 s in `treeline`.
- **Seen in the previews.** Flying the river corridor at 25 m, both banks are walls of fir and pine with trunks along the edge and a toothed skyline; forested hills keep their mass to the horizon. From 100 m, crowns close into a canopy over the dark understory and stands read as patches of different shade. In midwinter at 45° S, broadleaf stands are leafless brown between dark conifer stands.
- **Not done:** hedgerows by climate, tree rows along roads, gallery woods and lone landmark trees (step 5); the quality governor's tree steps; GPU time on real hardware; the shell's edge is notched where its ramp crosses mesh triangles (hidden by edge trees within 1.2 km, a few pixels beyond); a stand map mode in `npm run maps`; line of sight and tree strikes (step 7).

**Reason:** The owner accepted proposal 0003. Sharing one field between the shell, the trees and later the simulation is what makes the cover on screen the cover in the game; culling per tree, not per part, is what keeps closed-canopy density within Part I's triangle budget.

### 151. Owner's answers on proposal 0004: H1 starts now, hot starts, AI door gunners, and any crew position in the end

**Date:** 2026-11-15
**Decision:** The owner answers the questions decision 149 left open.

- **H1 may start before P1 closes.** It needs only P1's framework (the shared airframe and director interfaces, which H1's first task builds, and the input plumbing); P1's campaign tasks block only H5.
- **New types stay out of the campaign for now,** as the plan proposed; they get roles when they enter it. The owner's roles: the Little Bird analogue for close air support and small-unit warfare (dropping troops); the Cobra analogue as a marine attack helicopter for close air support; the Black Hawk, Huey and Mi-8 analogues as troop and cargo transports, possibly with a fire-support role (an open question for H5).
- **Hot starts only.** Helicopters spawn with the rotor turning; there is no engine start sequence.
- **Door gunners are AI-only** in H5. In the end the player can take any crew position, pilot, gunner, door gunner or systems operator, while the AI fills the others. This generalizes the crew station mode of decision 94 from two-seat jets and attack helicopters to every seat.

`docs/design.md` (*Factions and Sides*, *Open Questions*), proposal 0004's open questions, the plan and `TODO.md` change with this decision.

**Reason:** The owner's answers. One AI that can fill any seat already exists for crew station mode, so letting the player choose the seat costs a seat switch and a view per position rather than a new mechanism.

### 152. The horizon margin widens the tiles' bounding caps; it had culled the sea under a low camera

**Date:** 2026-11-15
**Decision:** The tile selection's horizon test (decision 116) asks its cheap bounding-cap test first, with the horizon margin as `extra`. It passed the cap's angle minus the margin, which shrinks the cap, instead of plus it. Wherever the camera's horizon is shorter than the margin, tiles inside the horizon were culled, the one under the camera included. Over land, terrain height lengthens the horizon and hid the error. Over the sea, flat tiles have bounds at sea level, so from a few meters up the horizon is about 2.4 km against a margin of about 14 km (a tenth of the horizon range, which counts the planet's tallest peaks). The owner saw holes in the sea at a distance when flying low, and with the camera lowest the whole sea vanished, leaving the neighboring tiles' skirts standing as walls shaded like water down toward the planet's center. The cap is now widened by the margin.

**How it was checked.** With the camera 3 m above open sea (`VIEWS=tower`, `OBS_HEIGHT=3`), the preview selected 0 tiles before and draws the sea to the horizon after (7 tiles). A test selects tiles with flat sea-level bounds from 2 to 300 m up and requires a drawn tile under the camera; it fails with the old sign.

**Reason:** A culling test may only remove what cannot be seen; a margin exists to keep more, never less.

### 153. Forests after the owner's first flight: an edge that rises from the ground, a fringe like its forest, fall colors and bare winter trees, conifers in the north

**Date:** 2026-11-15
**Decision:** Changes to decision 150 from the owner's first look in the browser (40–60 fps on the laptop).

- **The shell's edge.** It ended near full height on the density contour and hung, from the side, like a skirt halfway up the edge trees' trunks. It now rises from the ground on the contour to its height EDGE_RISE (0.12) of density inside, below the edge trees' crowns; with the edge at the ground, its notches along mesh triangles are gone too. Edge trees stand at 55% of the stand's height on the contour and grow to full height over the same rise (`edgeRise`, `EDGE_TREES` in `worldgen/canopy.ts`), so the canopy height field H the simulation will read is the trees' tops.
- **The fringe takes after its forest.** Trees within 0.15 of density below the threshold were picked by climate alone, so acacias stood in front of broadleaf forest, lower and in another color. Most of them (70%) now take the stand beside them, its kinds and shade, at 55–75% of its height; open land keeps the climate's kinds, and dead trees only stand in the open, away from forest.
- **Heights.** Young stands came one in seven at 55% of the height, so broadleaf forest read as two levels. They now come one in ten at 75%, and each tree varies 0.85–1.1 (was 0.92–1.06).
- **Seasons** (`render/sim/forest/foliage.ts`, shared by trees and shell). Deciduous crowns turn yellow, orange or red through 12–7 °C of surface temperature, by kind (birch and poplar yellow, oak orange to red, broadleaf any) and tree, or by stand on the shell; then brown through 5–1 °C. Below about 0 °C (±1.5 °C per tree) a tree takes a bare model, `tree-bare` (a branching broadleaf, 50 triangles) or `tree-birch-bare` (pale bark): placement records each tree's annual mean temperature and seasonal range, and the per-tree re-sort routes it to a third mesh, again whenever the season moves a day or the temperature offset changes. The shell over leafless stands takes the gray-brown of bare twigs with half the ground's snow, instead of brown crowns, which read as boulder fields for kilometers. Tropical trees (tropical share over one half) keep their leaves: a negative shade marks them, since the first version turned tropical broadleaf red in a cooled preview while the shell, rightly, stayed green.
- **Conifers in the north.** Stands turn conifer between an annual mean of 11 and 6 °C (was 9 and 3), the terrain's canopy shading with them (`CONIFER_T`); pines join conifer stands only from 4 °C up, to 40% at 9 °C (`pineShare`), so cold forests are all pointed firs, and the cold fringe is firs and shrubs, without birch.
- **Previews.** `woodland` (55 m over the farmland view's woods; seed 1983's is tropical, so `TARGET=mixed` shows a temperate wood) and `TARGET=<name>` for any targeted view. Seen: the river forest at 45° S is now all fir with the shell rising behind the edge's trunks; the temperate wood turns orange, red and yellow at `TEMP_OFFSET=-10`, shell and trees together, and at −20 stands bare with dark and pale birch branches over snow, the town showing through.
- **Measured** (seed 1983, 1024 × 576): `treeline` 0.40 M tree triangles in 45 draws (was 90), `canopy` 0.39 M in 53 draws (was 103): all-fir stands have fewer kinds.

**Reason:** The owner's review. Sharing the edge rise between the shell and the trees keeps the shell under the crowns, and the field H equal to the trees' tops; the leafless swap on the CPU costs nothing per frame and draws winter woods as branches, not brown masses.

### 154. One airframe interface: the Kestrel's flight model split into a rigid body, ground contact and the Airframe every flown aircraft implements

**Date:** 2026-11-15
**Decision:** H1's first task (decision 149, the plan's "One airframe interface, two models"). What the helicopters will share with the Kestrel moves out of `flightModel.ts`, and the code that only watches or follows an aircraft reads an interface instead of the jet. The Kestrel flies bit for bit as before.

- **`sim/flight/rigidBody.ts`**: free functions over a `RigidBodyState` (radius, position, velocity, attitude, body rates, wind, time): `gravityAt`, `airVelocityBody`, `eulerRates`, `integrate` (semi-implicit Euler, the mass read at the substep's start), `attitudeQuat`, `bodyAxisOf`, `attitudeTelemetry`, `pointVelocity`; `FLIGHT_STEP`, `SUBSTEPS` and `modelToBody` move here. Free functions rather than a base class, so `FlightModel` keeps its fields and no class-field semantics change.
- **`sim/flight/contact.ts`**: `GroundQuery`, `SurfaceKind`, `ContactState` (the points an aircraft stands on) and `WheelContact`; `wheelForce` (the strut and the bristle tire of decisions 134 and 136, with the brake passed in), `release`, `hardPointHit`, `supportHeight`. Contact never crashes anything: on water `wheelForce` returns `ON_WATER` with nothing written, and the airframe picks the crash's reason. Skids join as a sibling of `wheelForce` in H3.
- **`sim/flight/airframe.ts`**: `Airframe<C, T>` (kind, rigid body, mass and fuel, gear, crash state, `supports`, `onGround`, `gearHeight`, telemetry, `bodyAxis`, `gearHeightNow`, `place`, `crash`, `step(controls, ground)`, `updateAttitude`) and `AirframeTelemetry` (attitude and speeds, air data as sensed, load factor, radar altitude, forces, weight on the supports, fuel flow, air). `FlightModel implements Airframe<FlightControls, FlightTelemetry>`; `FlightTelemetry` adds the jet's lift and drag coefficients, thrust and control laws.
- **Readers of the interface:** the outcomes monitor (`FlightMonitor`), the landing aid (`destination`, `landingAid`), the chase camera's feed (`followAirframe` in `chaseCamera.ts`, used by Free Flight and the preview tool), Free Flight's wind, and the director's `toward` and `along`. Still the jet's: `flightWarnings`, `buildHudFrame`, spawn, the test pilot, `FlightDirector.fly`, the animated pose and mouse aim. `FreeFlight.model` stays a `FlightModel` until the aircraft choice (H1 item 9) makes it a pair keyed by `kind`.
- **Lockstep test** (`tests/flightLockstep.test.ts`, `tests/helpers/lockstep.ts`). Fifteen scenarios: the test pilot's circuit, random maneuvers with every control and a gear transit, a braked stand and taxi, a gusty crosswind roll, a free-pedal roll, a runway excursion, a braked stand in a rising gale, a gear-up landing, a hard landing, ditching on the wheels and on the belly, a hill strike, a tail slide, the director under mouse-aim targets, and a respawn on a used model. Each hashes about 150 numbers of state (position, velocity, attitude, rates, systems, every telemetry field, the laws' input, output and state, every wheel) and the monitor's events after every step. All were recorded on the code before the split, in a worktree at `632b2bf`. **V8 versions differ in the last bit:** Node 22 and Node 24 part within 5 s and by at most 4·10⁻⁹ m over the 519 s circuit, so the fixture holds a hash per V8 major version (both recorded) and every version must also match the samples every 5 s within a micrometer. A negative control checks that one ulp in one velocity component at one step changes the hash. A change meant to alter the Kestrel's flight re-records the fixture on both versions and says so in its decision (`CLAUDE.md`).
- **Charts.** `tools/lockstep.preview.ts` flies the scenarios again and writes `tools/out/lockstep.html`: each flight's path over the runway from above, height above the ground, airspeed, pitch and bank, with the monitor's events, and a crosshair to read them.

**How it was checked.** Besides the fixture on Node 22 and Node 24: during the work, a frozen copy of the flight code before the split ran beside the new code in one process under random spawns, controls, winds and grounds (hills, water), and every state number agreed exactly at all 184,283 steps compared (a local diagnostic, not committed). `tests/airframe.test.ts` tests the shared pieces (gravity, Euler's equations against torque-free precession, the integrator's energy and momentum, attitude round trips, strut, brake friction cap, water, hard points) and flies a stand-in rotorcraft on skids, which is no `FlightModel`, through the outcomes monitor (liftoff, a smooth touchdown, a crash above 6 m/s), the landing aid and the chase feed. `npm run check` passes.

**Reason:** The helicopters need the same integrator, gravity, wind and ground contact as the Kestrel (rule 12: one flight-model family for AI and player), and the code that follows or judges a flight should not care which kind it follows. Doing the split before the rotor model, under a test that pins every bit of the jet's flight, keeps the owner's tuned Kestrel exactly as it flies today.

### 155. No surf over lake shoals and no white water on standing water

**Date:** 2026-11-15
**Decision:** The owner saw a pale blob with a blocky edge in the middle of a lake, which disappeared up close and now and then turned all white. It was decision 147's lake foam. The mesh measured the distance to a lake's shore as depth over its gradient; over a shoal in the middle of a lake that is small, so the foam band and its moving surf lines were drawn there, with an edge along the mesh's vertices (in the `trees` view, a whole shallow lake was striped with surf lines). Lake shore distance is now taken only at vertices with dry ground within two samples; elsewhere the vertex keeps the sea's distance. Also, rivers run on through lakes to their outlets and their reaches there carry the inflow's gradient, so white water and the falls' foam could be drawn on a lake: both are now off on standing water (lake or sea). The calm slicks of decision 146 also lighten patches of a lake; they stay.

**How it was checked.** The `trees` view in clear weather (its lake has a river flowing in): before, a pale patch with a blocky edge in the lake and surf stripes across the rest; after, calm water mirroring the sky with foam at the shore only. With the gust field off the patch was weaker but still there, and 10 °C warmer it was unchanged, which ruled out slicks and ice as its cause.

**Reason:** Surf belongs where waves meet a shore, and white water where a river runs fast; an estimate that is only valid near the shoreline must not be used away from it.

### 156. One director interface for fixed-wing aircraft and helicopters

**Date:** 2026-11-15
**Decision:** H1's second task. `sim/flight/director.ts` holds the `Director<A, C>` interface (`reset`, `fly(model, target, controls, dt)`), the `DirectorTarget` every director reads, and the geometry helpers `toward` and `along`, which now take any body with a position. `FlightDirector` implements it for the Kestrel; the helicopters' director (`rotor/heloDirector.ts`) will too, so AI pilots, scripted pilots and mouse aim drive either kind the same way (rule 12).

- **The target's rotary-wing fields**, all optional: `heading` (the nose apart from the course: pedal turns, sideward and rearward flight, pointing a gun), `groundVelocity` (north, east, up in m/s, for the hover and hover taxi; replaces course, flight path and speed), `hoverPoint` (a world point to hover over, held by the director) and `height` (altitude or radar height to hold, for nap-of-the-earth flight; replaces the flight path's vertical part). The fixed-wing director ignores them; a test flies the Kestrel through 600 steps with and without them and gets the same controls.
- `flightDirector.ts` re-exports the moved names, so no importer changes. The lockstep test passes unchanged, its `mouse-aim` scenario included.
- **From the review of decision 154:** an adversarial review found the shared interface sound for the rotor model and no defect in the split, but two gaps the later steps must close, now TODO tasks: the outcomes monitor's runway rules would crash a helicopter that lands off the pavement (gate them by kind with the helipads, H1), and contact acts along the local vertical, so nothing slides on a slope until the ground query gives a normal (H3).

**Reason:** The proposal's three control modes and the AI all hand a director a target; one interface with fields only a helicopter reads keeps that a single contract, and the jet's director stays exactly as tuned.

### 157. The canopy shell's edge a cell inside the forest; a patchy snow line; whiter snowy conifers; browner ground in the fall

**Date:** 2026-11-15
**Decision:** Changes to decisions 150 and 153 from the owner's second look in the browser.

- **The shell's edge.** Decision 153 lifted vertices by their own forest density and cut the shell on the interpolated density. Forest density falls steeply at most edges (across one data sample), so the contour runs through the middle of a mesh triangle, and the cut left the shell hanging at about half height: the owner could still see under it. Cutting on the interpolated lift instead (under 4% of the height) brought the shell to the ground, but its slope then spanned a whole cell from inside to outside the forest and stuck out past the edge trees like a ramp. Vertices now carry the least forest density among themselves and their eight grid neighbors (`forestInner` in `tileMesh.ts`, read from the data's border beyond the tile's edge so neighboring tiles agree), and the shell lifts by that: a vertex beside open ground stays on the ground, so the slope lies between the first and second rows of vertices inside the forest, behind the edge trees, and nothing of the shell remains outside the forest. The value rides in the `surface` buffer, interleaved (`canopyEdge`), since WebGPU's eight vertex buffers are all in use; a mesh tile costs one float more per vertex.
- **A patchy snow line.** Each face decided snow at a threshold dithered by ±0.1, so the snow line was nearly a contour, and trees followed it exactly. A first wide dither (±0.4) turned whole regions near the line into salt and pepper from 2 km. Now the terrain's low-frequency detail noise (×0.5, patches of a few hundred meters) and a per-face jitter (±0.175) decide it (`SNOW_PATCH`, `SNOW_DITHER`): a patchy band hundreds of meters wide, every face all snow or all bare. Trees decide with their own random jitter, the shell with each face's.
- **Snowy conifers.** Snow on trees needed upward faces (the normal's up component ×1.5) and mixed in at 80%, so the sloped faces of a fir's tiers stayed half green and read gray. Snow now covers faces whose normal is 0.05–0.4 up, at 95%; the undersides of the tiers stay green.
- **The ground in the fall.** Grass and the forest floor browned from 10 to 2 °C, after the trees had turned (12–7 °C); they now brown from 12 to 4 °C, a little more (0.8).
- **Seen in the previews** (seed 1983): at 25 m and at 6 m over the river, both banks' edge trees stand on the forest floor with the shell behind them, neither hanging nor sticking out; the river forest at −16 °C shows a patchy band of snowy and bare faces and trees, at −20 °C white firs; the `winter` view from 2 km shows snow, a patchy band and bare ground in place of salt and pepper. Tree triangles and draws unchanged (0.40 M, 45 draws in `treeline`).

**Reason:** The owner's review. The least density around a vertex is the cheapest way to move a whole cell's slope inside the forest without finer geometry; patches from noise keep the snow line's band legible from altitude, where per-face randomness alone reads as noise.

### 158. Helicopter models and the rotor in the flown view

**Date:** 2026-11-15
**Decision:** H1's model task (Part I, _Helicopters_; proposal 0004, _Visual Consequences_).

- **Spec format.** A spec may list `rotors`: `{ hub, axis?, radius, blades, chord, direction, group, disc? }` in the model frame. `axis` is a unit vector (default up; a tail rotor about [0, 0, ±1], canted as the type is); `blades` 2–8; `direction` +1 turns right-handed about the axis (counterclockwise seen from its tip, as American main rotors seen from above), −1 the other way; `chord` under half the radius; `group` colors blades and hub, `disc` the spinning disc (default the blade group). Validation names the path, as for parts. At azimuth 0 the first blade points aft, projected into the rotor's plane (over the tail for a main rotor), and the others follow in the direction of rotation.
- **Builder.** Each rotor gives a six-sided hub drum along its axis (20 triangles) and plank blades (12 triangles each, thickness max(4 cm, 0.12 chord) so they do not vanish edge on). `buildModel` includes them at azimuth 0, stopped, and counts them in the budget; models without rotors build byte for byte as before (checked against the previous builder over every library spec). `buildRotors` and `buildAnimatedModel(...).rotors` return per rotor the hub, the blades and the **disc**: a fan to 0.45 R at 42% opacity, rings to 0.75 R at 30% and to 0.94 R at 19%, a tip ring at 32%, and a rim across the plane at the tip path at 26%, 24 sectors (12 under 2 m radius); one alpha per face, no gradient. The rim is an addition to Part I: without it a disc seen edge on, which the chase camera often does in level flight, disappears entirely. The disc costs 216 triangles for a main rotor and 108 for a tail rotor and is outside the 300–800, as the budget table says; Part I's _Helicopters_ said the opposite and now matches the table.
- **The flown view** (`aircraftView.ts`). `AircraftPose.rotors?: RotorPose[]`, in spec order: `azimuth` (rad, growing in the direction of rotation, so the physics integrates Ω ≥ 0 and the view turns the rotor by `direction × azimuth`), `speed` (fraction of governed rotor speed), `tiltForward` (+ leading edge down) and `tiltRight` (+ right side down). Each rotor is a tilt pivot at the hub (main rotors only: axis within 45° of up) holding a spin pivot (hub and blades) and the disc, which tilts but does not spin. Blades fade out and the disc in on a smoothstep between 0.3 and 0.7 of rotor speed; solid blades draw with the body's opaque materials, fading ones with blended copies that still write depth, and the hub stays. The disc is lit like the model, blended without depth writes and has no ink. The shadow keeps the body, the hinged pieces and the hubs; blades and disc shadow as two child meshes at the blades' opacity and at 45% of the disc's alpha. Without `rotors` in the pose the blades stand at azimuth 0 and no disc shows; for a spec without rotors the view is unchanged (the shadow's sources are now listed once instead of found by a traversal each frame, in the same order).
- **Models.** `alliance-scout-helo`, the MH-14 Wren (an MH-6 analogue): an egg-shaped cabin glazed in front, a thin boom, a T-tail with endplates over a fin canted 8°, a ventral fin, bench boards over the skids and a sensor ball, a five-blade main rotor of 4.0 m on a hub 2.6 m above the skids and a two-blade tail rotor of 0.7 m on the left; 7.0 m from nose to tail, 1.44 m wide; 666 triangles. `alliance-utility-helo`, the UH-68 Buzzard (a UH-60A analogue): a long, low cabin with squared sides, side windows, two engine nacelles and a transmission fairing on top, a tail pylon leaning 20° to port with a four-blade tail rotor of 1.68 m on its right, canted 20°, a stabilator of 4.4 m span low on the tail, two main wheels forward and a tail wheel; main rotor four blades of 8.18 m on a hub 4.0 m above the ground (the published 3.76 m to the top of the hub, rounded up within the 3.8–4.4 m asked for); 708 triangles. Both: origin on the ground under the main rotor's hub, x forward, Alliance woodland, blades `#34373A`, navigation lights (red port, green starboard, white tail) and beacons. They carry no flight block; the rotor model adds its own.
- **Previews.** `tools/models.preview.ts` draws helicopters with two more rows, spinning: body and hubs with the discs blended over them, shaded and as silhouettes (`tools/modelRaster.ts` takes translucent triangles), and prints the discs' triangles beside the budget.

**How it was checked.** `tests/rotors.test.ts` (validation errors, hub, blade and disc counts, the disc's plane, bands and rim, the first blade aft and the second toward starboard, the split into body, pieces and rotors, both library helicopters in budget and on the ground, the blend curve). The model previews read as a small scout and a utility helicopter in all four silhouettes, stopped and spinning. The view was rendered on lavapipe by a scratch copy of `tools/freeflight.preview.ts` with each helicopter standing on a runway, its rotors at full and half speed with a tilt, without GPU errors. Free Flight does not fill `rotors` yet: that comes with `RotorcraftModel`.

**Reason:** The rotor is the player's main cue for what the controls do (proposal 0004), so its pose comes straight from the flight model's state and its look follows Part I's rule of faceted, banded translucency; keeping hub and blades in the static model lets the viewer, the budget test and the silhouette check see a helicopter as it parks.

### 159. Helicopters fly in Free Flight: a thrust-disc model, an Assisted control layer, fly-by-mouse, the hover HUD and the helicopter camera

**Date:** 2026-11-15
**Decision:** A first flyable slice of H1 (decision 149, proposal 0004), so the owner can fly a helicopter in Free Flight: the MH-14 Wren (a light scout, MD 500/Little Bird analogue) and the UH-68 Buzzard (a utility transport, UH-60A analogue) on the aircraft choice of the start screen (`&aircraft=scout|utility`), from the ground beside the runway's middle or hovering 150 m up.

- **The flight model** (`sim/flight/rotor/rotorcraftModel.ts`, `rotorAero.ts`, `rotorSpec.ts`) implements the Airframe of decision 154 on the shared rigid body and contact code. The main rotor is a thrust disc: thrust from collective and inflow by the closed-form blade-element integral (uniform inflow, linear twist, tip loss); Glauert's inflow as a state that lags its quasi-steady value with Pitt and Peters' time constant, held from below at half the hover's inflow so a vertical descent through the wake stays finite (vortex ring state proper is H4); Cheeseman and Bennett's ground effect, faded with speed; first-order flapping of the tip-path plane with the time constant 16/(γΩ), lagging the body's rates (the rotor's damping), blowing back and tilting to the advancing side in forward flight; a hub moment from the hub's stiffness plus the thrust's own arm. Power is induced, climb (with parasite through the disc's tilt) and profile; a governed engine with a spool lag and power available by density and temperature, capped by the transmission, drives a rotor whose speed is a state. The torque's reaction yaws the fuselage; the tail rotor is a second disc on the same formulas, at a gear ratio, with its own inflow and power. Fuselage drag areas per body axis; fin and stabilizer as lifting surfaces in the local flow. Skids are `wheelForce` with the brake held (sliding friction both ways); wheels brake and castor. Deterministic: fixed iterations, no random numbers.
- **The figures** are in each model spec's `flight` block (`"kind": "rotorcraft"`), from public sources: UH-60A rotor geometry, speed, hinge offset, engines, transmission limit, inertias, flat-plate area and tail rotor cant (NASA CR-166309, TM-85890, Army manuals as quoted); MD 500E/530F masses, rotor, tail rotor, engine ratings and limits (FAA TCDS H3WE, MDHI) and OH-6A inertias scaled (NASA CR-3144). Hub stiffness, Lock numbers, twist of the scout, drag areas off the x axis and the tail surfaces are tuning values. Hover power out of ground effect comes out at about 207 kW for the scout at 1,300 kg (momentum theory with a figure of merit of 0.65 gives about 190 kW) and about 1.35 MW for the utility at 7.3 t (published: 1.4–1.6 MW).
- **The control layer** (`sim/flight/rotor/heloLaws.ts`, `assists.ts`; rule 12: never in the physics). The Assisted preset: the mouse moves a pitch-attitude target that holds (auto-trim) and turns — the heading below the type's hover speed (20 kt), a coordinated bank above its turn speed (40 kt), blended by ground speed; A/D a sideways speed in the hover (none when let go: drift correction) and bank at speed; Q/E the nose; W/S a climb rate, the altitude holding when let go; H hover hold, which also engages by itself when slow, let go and near the trim attitude. Inner loops: attitude error → angular acceleration → moment → disc tilt through the rotor's control power, with the rotor's lag commanded away (without that, the rotor's own damping slowed the roll to the hover hold's frequency and the hold limit-cycled at ±8° and 1 m); a trim attitude from the body forces' resultant (it holds the 3° of left bank that balances the tail rotor); pedals from the torque's feedforward by inverting the tail rotor; collective by inverting the main rotor's thrust for the vertical acceleration wanted. Protection: a torque limiter that also backs the collective off when the rotor droops below 93% (a drooping rotor takes the tail rotor's authority: a full-collective takeoff had yawed the scout 85°), speed protection past 85% of the never-exceed speed, power protection when the altitude cannot be held, a descent that eases near the ground, and on the gear with S held the collective goes down. The Standard and Expert presets exist as data; their behaviors (lever collective, no protection) are H2.
- **Input** (`ui/flight/heloInput.ts`): fly-by-mouse under pointer lock (a click on the view captures the mouse; Escape gives it back and pauses), mouse forward is nose down, keys in one table, F1 help with the helicopter's bindings and notes. The jet's input is untouched.
- **Outcomes:** the outcomes monitor's runway rules (touched down away from a runway, ran off the runway or the paved field) apply to fixed-wing aircraft only; the Kestrel's lockstep scenarios are unchanged.
- **HUD and camera** (by a parallel agent, merged): the hover HUD of decision 149 (ground-plane velocity vector with an acceleration cue, boxed radar altitude and a vertical-speed bar, TRQ and NR, mode tags and hazard boxes, an LZ marker ready for H1's landing zones; Mach, G, α, throttle stages, speedbrake and the localizer needles left out) built from `hoverSymbols` in `hudFrame.ts`, and `helicopterRig(rotorRadius)`: about three rotor radii back, lifting and tilting down below 40 kt (30–33° down in the hover), following the heading in the hover and the velocity at speed, free look that holds in the hover. The schedule uses ground speed, so a hover over a spot in wind still frames the ground. The jet's camera is unchanged (checked against the previous code over 3,000 frames). The heading tape now skips scale labels within 30 px of its readout (they overlapped at headings ending in 5).
- **Models:** the MH-14 Wren and UH-68 Buzzard of decision 158, their rotors spinning, tilting with the flapping state and fading into the banded disc from `AircraftPose.rotors` (azimuth, rotor speed, tilt).

**How it was checked.** `tests/rotorcraft.test.ts`: spec parsing and errors; hover power against the figures above; translational lift (induced inflow down by a fifth by 25 kt, by under a tenth at 10 kt); ground effect; determinism; rest on skids and wheels without creep for 30 s; hover hold in ground effect for 60 s within a meter (0.13 m measured); a 360° pedal turn within 9 s (scout) and 13 s (utility); takeoff, a circuit at 60–140 kt with turns, and a running landing under 1.5 m/s for both. Scripted flights showed cruise up to about 124 kt at the scout's transmission limit (MD 500E: 135 kt) and coordinated turns with under 1° of sideslip. The browser smoke test gains a helicopter part (takeoff, hover, pedal turn, forward flight, landing in the real app).

**Review.** An adversarial review (four lenses, two skeptics per finding) found and the same night's commits fixed: a steep turn that ran away (the collective asked for up to 4.4 g and the coning tilted the disc further to the advancing side: the thrust command now stops at 1.6 g, the cyclic is commanded net of the rotor's own steady flapping, the bank command moves at most 35°/s); a slow turn in straight cruise (the pedals now null the sideslip, and with the wings level and the cyclic let go the heading holds by banking a little); a tail swap flying backward (the hover-to-turn blend uses forward ground speed); a torque-limiter flag that was almost always set (power protection now acts only at the real limit, in forward flight, by 10° at most); rotor overspeed in flares (a collective floor past 103%, HIGH RPM on the HUD); an air start that sagged (place() primes the hover's inflow and engine power); ground effect at half strength (the factor now applies outside Glauert's fixed point); mouse movement lost on frames without a physics step above 120 Hz; weather and fuel options that did not reach a helicopter; a landing that ended the sortie; the scout's engine (the MD 530F's 485 kW through a 317 kW transmission); the crash sink rate by type (`Airframe.crashSink`). Below 20 kt with the nose level and the mouse let go, the Assisted preset eases to a stop and hover hold takes over: a fraction of a degree of pitch is the difference between a hover and 20 kt. Two tests that passed for the wrong reason (a ground-effect test whose helicopter crashed on its first frame, a translational-lift test that never ran the model) now fly the model.

**In the real app.** `tools/freeflight.session.mjs` flies both helicopters in the real `FreeFlight` class (start screen, W, mouse, pedals, pause, the URL, back to the Kestrel), and the browser smoke test's `helicopter` part flies the Wren in Chromium with WebGPU on lavapipe: from the ground, a hover at 30 m, a pedal turn, 21 kt forward, a landing, with no page, console or WebGPU error. The pictures show the banded disc and the hover HUD. Nobody has flown it with a real mouse yet.

**Not done (H1 tasks still open):** calibration figures in `tools/flight.preview.ts`; running landings on wheels above about 40 kt (the utility rolled over at 50 kt: ground handling at speed is H3's); the collective's low stops, which let a full-down autorotation overspeed the rotor (H4); the Standard and Expert presets' behaviors; landing zone marker and helipads; downwash; hazards (H4); the surface-layer wind profile for rotorcraft (the jets' 8 m/s ground cap applies for now); slopes; the mouse sensitivity and inversion options in the pause menu.

**Reason:** The owner wants to fly a helicopter the next morning. The slice is the plan's H1 in its order, with the physics grounded in public data and every assist in a separate control layer, so the remaining H1 tasks extend it rather than replace it.

### 160. The helicopter's free look stays where it is left; a vertical-speed readout; the Wren's skids

**Date:** 2026-11-16
**Decision:** Three changes from the owner's first flight of the MH-14 Wren (decision 159).

- **Free look** (`chaseCamera.ts`, `heloInput.ts`). A helicopter's free look stays where the player leaves it at any speed, no longer only below 15 kt; V or a middle click eases it back to center (a quarter-second time constant, the short way round), and a new drag cancels the easing. The look point now orbits with the eye in pitch as it already did in yaw, so dragging the eye down lifts the view toward the horizon with the helicopter still in frame; it rises only as far as the eye really went down, and where the ground holds a dragged-down eye close under the helicopter, the view turns toward the helicopter until it sits 20° off the axis (the rig's own framing keeps it within 19°, so this guard stays out of ordinary flight). The mouse wheel scales the rig's distances (`ChaseCamera.zoom`, 0.5–3×, 12% a notch), the look point's included, so the framing's angles hold; a new helicopter sortie recenters the look and keeps the zoom, and a jet sortie resets both. The `lookHoldSpeed` and `lookReleaseSpeed` fields of the hover schedule are gone. The jet's camera is unchanged: its free look springs back as before, and with `zoom` at 1 its arithmetic is the same (the chase tests pass unchanged).
- **Vertical speed** (`hud.ts`). The helicopter HUD writes the vertical speed (fpm, to 10) under the radar-altitude box, at about the box's size, in place of the small figure above the altitude tape; above 1,500 ft, where the box is not drawn, it takes the box's place. It and the vertical-speed bar turn amber when the helicopter sinks faster than 2 m/s with less than 1.6 s to the ground (`sinkWarning`). Both types fly the landing aid's eased descent with at least 2.2 s in hand, so it stays white; without the aid, S held to the ground meets it at about 7.7 m/s after about 1.6 s of amber (a test in `tests/rotorcraft.test.ts` flies both). The types' crash sinks are 4–5 m/s. The HUD composites gain a `sink` case.
- **The Wren's skids.** The struts ended 0.2–0.3 m below the fuselage, and the rear pair outside its width; they now run into the body, and the step that floated beside the cabin sits on them.

**Review.** An adversarial review of the first commit (three lenses, two skeptics per finding) upheld three defects, fixed in the second: on the ground or in a low hover, the ground held a dragged-down eye up while the look point still rose by the full pitch, tipping the view into the sky and the helicopter out of the frame (83° off the axis at −80°); the help card still said the camera springs back at speed; and the first threshold, 2.5 s to the ground, turned amber in the landing aid's own descent, because the laws follow the aid's command (0.3 of the radar altitude per second) with a lag and the flown sink is about twice it. Tests now fly the dragged-down eye on the gear and in 5 m and 20 m hovers at every zoom, the rig's own framing from 1 m to 60 m and the hover to 120 kt, and the warning against both types' real descents.

**Not done.** The owner's other camera proposal, tilting the camera with the flight path marker, waits for their verdict on the sticky free look: in cruise the rig already leans toward the velocity, and the hover's look down is by design. Ground detail that fades in near the ground is recorded in `TODO.md` (V2) as future work, as the owner asked. Proposal 0004's Camera Rig section says free look springs back in cruise; this decision supersedes that sentence.

**Reason:** The owner could not always see ahead and wanted the camera to stay where they left it; they did not find the vertical speed; and the skids visibly floated.

### 161. Terrain-adaptive networks: rivers by regime, roads and railways aligned to the terrain, earthworks as analytic edits, and a bridge at every crossing (proposal 0005 accepted)

**Date:** 2026-11-16
**Decision:** The owner accepts proposal 0005. Rivers, roads and railways adapt to the terrain by their design regime, and the terrain adapts to them through analytic edits; a new track, N1–N8, implements it. The plan is `docs/plans/terrain-networks.md`; nothing is implemented yet.

- **Two tiers.** The **network tier** stays on the coarse pass (decision 65): which places roads and railways link, their classes and route numbers, settlements, and the strategic bridges, the same on every machine. The **alignment tier** runs on the eroded world: each network link aligned between fixed anchors with grades, curves, earthworks, viaducts and tunnels, and every strategic bridge snapped to a crossing of the rendered river (closing the S4 follow-up). Campaign logic reads only the network tier (rule 9). The proposal's generation order holds within each tier.
- **Edits.** Carve, floodplain and build-up run in the tile kernel, as the carve does now; corridors and pads run on the CPU after the render detail, as grading does now, in one function `TerrainEdits.apply(dir, base)` in `worldgen/edits/`, which the meshes, trees, buildings, the camera, the flight model's ground and later line of sight and ground movement all call. Rivers stay last through **protected channels**: inside a river's channel and inner banks the result is the minimum of the edited height and the carved tile height, so no embankment can dam a river. Decision 108's pads migrate onto it first. Its base height is whatever the caller has (tile data, or the global grid in the worker): one edit function over the existing fallback chain.
- **The feature field is the segment lists** of decision 54, extended with a kind and a corridor profile per segment, not a per-chunk texture.
- **Routing** reads level-6 tile heights (96 m) along each link's band (the global grid misses level-7 relief by up to 406 m RMS, level 6 by 12 m; decision 139). A spike decides whether alignment runs eagerly after the global pass or lazily per piece; anchors make both give the same result. Railways are aligned first, then major roads, then minor roads; the coarse pass keeps routing roads before railways.
- **Mountain classes** arise from the network's classes: a railway piece whose grade cannot be met takes the mountain railway's parameters, a secondary road in mountains the mountain road's. Switchbacks and horseshoe curves emerge from the search; **spirals** are a template the aligner inserts where a railway cannot meet its grade, since a planar search cannot cross itself.
- **Meander migration** (Howard and Knutson) with cutoffs and oxbow lakes on large lowland rivers within a floodplain mask; the procedural train of decision 126 stays for small streams.
- **Settlements** gain a habitability term for crossing sites on the coarse rivers. This changes the cast of nearly every seed: `GENERATOR_VERSION` rises when it lands.
- **Bridges.** Every crossing in the alignment tier gets a structure record; only those tied to a network-tier bridge are targets. Network-tier bridges become nodes (polylines cut at them), with a type decided on the coarse pass, span, traffic carried and the detour if they fall.
- **Names** from new streams: `names/bridges`, `names/lines`, `names/reaches` and `names/sections` in id order for the network tier; per-piece forks for tunnels, minor bridges and rail sections. Existing streams are unchanged.
- **Determinism.** New stages draw from new streams and leave earlier outputs byte-identical, except the settlement pull. The alignment tier is deterministic per machine, as the eroded world is.

How the plan reads the proposal, for the owner to confirm: no-humps is checked exactly on the vector profile and with decision 146's 2 m tolerance on the 48 m tile surface; surface agreement under 0.5 m is measured on the formation and needs finer mesh levels along corridors near the camera (level-10 vertices are 24 m apart); tracks and minor roads are local detail generated near the camera, not network facts; minor bridges, viaducts and tunnels that only the alignment tier knows stay scenery until a later decision. The owner's session brief asks for a feature branch and a pull request, which `CLAUDE.md` forbids; that is an open question in the plan, with three others.

`docs/design.md` (*Decisions So Far*, *Scale and Range*, *Architecture*, *World Generation Pipeline*, *Reading the World*, *Rendering*, *Milestones*, *Open Questions*), Part I (*Terrain*, *Polygon Budgets*, *Buildings and Bases*) and Part II (*Base Map*, *Settlements and Infrastructure*), proposal 0001, `CLAUDE.md` and `TODO.md` change with this decision.

**Reason:** Roads that roll over every hill and rivers that run straight down wide valleys break the illusion at the altitudes where the player flies low, and bridges beside the rivers they cross break it for the war. Letting each feature's regime decide its form keeps generation unsteered (rule 10) and gives the campaign named, typed bridges to fight over. Splitting network from alignment keeps the campaign's facts on the CPU coarse pass, where they are identical on every machine, while the alignment can use the fine terrain that only the GPU has.

### 162. Hedgerows by climate along the painted fields, rows of trees along roads, acacias in savanna only

**Date:** 2026-11-16
**Decision:** Step 5 of proposal 0003, with the owner's plan for hedgerows by climate (decision 148).

- **Fields the CPU can see.** The terrain painted fields as a Voronoi diagram over the wrapped fragment position with a sine hash, which the CPU cannot reproduce. Fields are now cells of a 3D Voronoi diagram over points on the sea-level sphere (the face's direction times the radius), with the canopy's integer hash and seed: `voronoi` and `fieldAt` in `worldgen/canopy.ts` (which also return the distance to the boundary with the second-nearest field), `voronoiCellNode` and `fieldCellNode` in `render/common/canopyNode.ts`. Stands use the same `voronoi`. Field layouts change; the farmland GPU test still passes.
- **Hedgerows.** `hedgeShare(halfRange, moisture, meanT, slope, region)` is the share of field boundaries hedged: temperate maritime climates (a seasonal half-range under 6.5–11 K, moisture over 0.3–0.55, an annual mean of 4–16 °C, since the tropics have small ranges too) are bocage, a little less on flat ground, times a regional term (value noise on a 400 km lattice, switching across 0.4–0.6) so similar climates differ; continental plains (half-range over 10–13 K) keep 12% of boundaries as shelterbelts. Placement walks a 3.5 m jittered lattice in parts whose probes find hedges and settled land, keeps points within 1.6 m of a field boundary that are on farmland as the shader decides it (a farmable biome, habitability over 0.35, slope under 0.12, Earth-like elevation under 1.5 km) and out of forest, and hedges a boundary whole or not by a draw on the pair of fields. A hedge is shrubs scaled to about 3 m with one tree in ten (oak, broadleaf, birch; firs in the cold). `ForestLayer.hedgeShareOverride` (preview `HEDGES=x`) fixes the share.
- **Rows of trees along roads.** `InfraScene` indexes road stretches per level-10 tile (`roadsInTile`), with the road's index, class and distance along it, including the tiles 40 m to either side: graph roads pass through coarse-cell centers, which can lie on a tile's edge, and a row on the far side then belongs to the next tile (the preview found a road with its only row in the tile next door, and no trees). A share of roads by class (motorways 8%, trunk 20%, secondary and spurs 30%) carry a row on one side or both, a tree every 11 m, 2.5 m outside the road's clearing (now `ROAD_CLEARING`, 8 m beyond the pavement), with gaps one time in twelve; poplars in temperate land (65% of row roads), broadleaf otherwise and in warm country (evergreen in the tropics), birches in the cold, none where moisture is under 0.12.
- **Acacias in savanna only.** Open-land trees took acacia wherever it was warm and dry, so lone acacias stood before forests of other kinds (owner). They now need the savanna biome at the data sample; elsewhere warm, dry open land has shrubs.
- **Previews.** Targets `hedges` (the settled, farmable open cell anywhere with the highest hedge share times habitability) and `roadrow` (a row road's stretch 4–60 km from that, the farmland or the check-1 town, wet, not savanna, open, 2 km from any site), views `hedgerows` (60 m) and `roadrow` (120 m); a targeted view whose target the world lacks is skipped. Seed 1983 has little hedge country (best share × habitability 0.21): with `HEDGES=0.85`, hedgerows trace every field's edge with trees standing out of them, and follow the painted boundaries exactly. `roadrow` shows a row of poplars along a rural road.
- **Measured:** `hedgerows` with `HEDGES=0.85`: 0.59 M tree triangles in 98 draws (0.39 M and 51 without hedges at seed 1983's own share); placing a farmland part's hedges is incremental, a row of the lattice at a time.

**Reason:** Hedges must follow the fields the player sees, so the fields had to move to a hash both sides compute; climate, not biome, separates bocage from open plains (decision 148).

### 163. Owner's answers on proposal 0005: `main`, seeds may change, every bridge is a target, lazy alignment is acceptable

**Date:** 2026-11-16
**Decision:** The owner confirmed decision 161's readings and answered the plan's four questions.

- **Branch.** Track N commits to `main`, as `CLAUDE.md` says; the session brief's feature branch and pull request do not apply.
- **Seeds may change.** Nothing is frozen while the game is in development: a generator change may change any seed's world, cast and campaign, as the settlement pull will. Future decisions need not preserve seeds, only say which outputs change.
- **Every bridge is a target.** This replaces decision 161's "minor bridges stay scenery". Targets must be the same on every machine (rule 9, decision 65), so the network tier predicts the bridges: N4 records a bridge at every coarse crossing of a river that needs a structure, not only rivers at least 25 m wide, and a viaduct where a railway or major road crosses a valley deeper than its class's threshold on the coarse relief. N5 matches each alignment bridge to the nearest network bridge on its link; those left unmatched (rendered rivers or valleys the coarse pass cannot see) are drawn but not targets, and the metrics count them, aiming to keep them under a tenth of all bridges. Culverts and tunnels are not targets.
- **Lazy alignment** is acceptable if spike N5.0 shows eager alignment to be slow: the map may draw network-tier roads until a region's aligned pieces exist.

`docs/design.md` (*World Generation Pipeline*, *Reading the World*, *Open Questions*), the plan and `TODO.md` change with this decision.

**Reason:** Bridges are what interdiction is about, and a bridge the player can see but not strike would read as a bug. A coarse-pass prediction keeps targets deterministic across machines; counting the mismatches tells us whether it is good enough.

### 164. N1: the terrain edit framework, one height function, and protected river channels

**Date:** 2026-11-16
**Decision:** Track N's first milestone (decision 161): `src/worldgen/edits/` replaces `render/common/terrain/grading.ts`.

- **`TerrainEdits.apply(dir, h)`** is the one height function of rule 13: the unedited height in (tile data with its render detail, or the global grid before tiles load), the edited height out. Tile meshes and their morph targets and slopes, the canopy's clearing, trees and buildings (through `surfaceSampler`), `TerrainRenderer.heightAt` and `displaySurfaceAt`, the camera's clearance and Free Flight's ground all call it. `forTile(t)` keeps only the edits that reach a tile, so other tiles build byte-identical meshes. It lives in `worldgen/`, so `sim/` may use it.
- **Order.** Corridors first, blended where they overlap (each rank of priority weighs four times as much); then protected channels; then pads over them, at exactly their elevation (decision 108's formula, unchanged bit for bit). Only land is edited.
- **Corridors** (`corridor.ts`): a polyline with a design elevation per point, a formation half-width, fill and cut runs (1.5 and 1 by default) and a reach. Outside the formation the ground is clamped between the fill bank below and the cut bank above, one closed form for cut and fill; over the last `fade` meters before the reach the edit blends out. Segments are split to 500 m, so a chord sags at most 3 cm below the sphere, and indexed by level-6 tile. Corridors apply on mesh levels 6 and finer (level-6 vertices are about 380 m apart), and a tile and its own morph target agree because both use the tile's own edits. No corridor exists yet: the aligner (N5) will make them.
- **Protected channels** (`channels.ts`): where an edit would raise the ground inside a carved river channel or its inner bank (the half-width plus a quarter of the width, at least 10 m), the result is held at the unedited, already-carved height, letting go over a further 10 m. It needs only the distance to the river index's segments; the CPU never re-runs the carve, which is not idempotent in its fade band. Rivers without a water surface are not protected, since nothing carved them. **Pads are exempt**, a deviation from rule 13 as decision 161 wrote it: on seed 1983, 6 of the 71 airfields (Neir, Thaarnby, Krorby, Skar, Sikby and Buren Air Base) have a rendered river across the pad itself, between 109 and 1,016 of their 25 m samples, because the coarse pass that places airfields does not see the eroded world's rivers. A held channel would cut their runways, so pads fill rivers as before until airfield placement keeps off rendered rivers (a TODO task). The app and the render and Free Flight previews pass the world's `RiverIndex`.
- **Tests** (`tests/terrainEdits.test.ts`): formation, banks, reach and fade, split segments, cover, malformed records, blending by priority, pads over corridors, the tile restriction, a fill corridor across a river that never raises the channel, cuts that stand, pads that still fill a channel, uncarved rivers unprotected, and pads bit for bit as before where no channel is near. The grading, Free Flight and Kestrel lockstep tests pass unchanged.
- **`tools/edits.preview.ts`** lists the campaign world's airfield pads that reach a carved channel, with the samples in the channels' hold and on the pad itself (seed 1983: the six above, 592 s on lavapipe including the world's generation). The full CPU suite passes (92 files, 835 tests).

**Reason:** Rule 13 asks for one function that every height query uses, with rivers always last; building it before any corridor exists lets the airfields prove it unchanged and gives N5 and N6 a tested target.

### 165. River invariants measured over many seeds; planform smoothing takes rivers off the grid's axes

**Date:** 2026-11-16
**Decision:** N2's first task (decision 161): measure what decisions 146 and 147 promise about the vector rivers before the planform changes, and fix the one invariant that failed.

- **Measurements** (`worldgen/channels/invariants.ts`, `riverInvariants`): on a `RiverIndex`, per polyline, rises of the smooth and stepped water surfaces (1 mm tolerance), tributaries that end lower than the river they join starts or away from its first point, interior maxima of the bed (the surface less the kernel's depth, 1 + 0.02 w), the share of channel length with a heading within 2.5° of a multiple of 45° in the face's own (u, v) frame (where D8 steps lie; 11.1% for an even spread), stair-steps (alternating turns of at least 20° around a segment shorter than two cells) per 1,000 km, and the sinuosity of polylines at least 20 cells long. `RiverIndex.lines` now records each polyline's segment range; nothing else in its output changes from that.
- **Where they run.** `tests/riverInvariants.test.ts` builds ten seeds' networks on the CPU (tectonic heights at 96² per face, CPU drainage, the real `RiverIndex`; 40 s) and asserts no rises, no junction gaps or rises and no bed maxima on any seed, with regression bounds on grid headings and stair-steps. `tools/riverInvariants.preview.ts` measures the eroded worlds as the app builds them (`SEEDS`, `GRES`, `SIGMA`).
- **What they found.** Surfaces, junctions and beds are clean on all ten CPU seeds and on the eroded seed 1983 (71,463 km of channel). The ladder is not: on seed 1983, 51.1% of the channel length lay on grid headings, with 36.7 stair-steps per 1,000 km. Two Chaikin passes over a staircase of cell centers keep its edges' directions.
- **Planform smoothing** (`smoothPlanform`, `PLANFORM_TUNING.sigma`). Before the Chaikin passes, each polyline is smoothed by a Gaussian over arc length, one point spacing wide (the network's median spacing, about a global cell), its displacement tapering to zero over two sigmas at both ends so confluences and mouths stay exactly where they were. On seed 1983 at 1,024²:

  | Sigma (spacings) | On grid headings | Stair-steps / 1,000 km | Displacement p99 (cells) |
  | --- | --- | --- | --- |
  | 0 (before) | 51.1% | 36.7 | – |
  | 0.5 | 35.3% | 30.6 | 0.16 |
  | 1 (chosen) | 21.1% | 18.0 | 0.49 |
  | 1.5 | 17.6% | 16.0 | 0.74 |

  One spacing keeps 99% of the points within half a cell of the cell they drain (at most 0.58), so the river stays on its valley floor; 1.5 halves the remaining gain for half again the displacement. Surfaces stay monotone at every sigma. On the CPU seeds the share fell from 31–58% to 26–45%, the uneroded 16 km cells having long straight D8 runs.
- **What is left.** 21% against an even 11%: long runs of D8 steps straight along one axis, which smoothing cannot bend. The regime and meander work of N2 bends them; the tests' bounds then tighten.
- **Bed walk** (decision 146's `tools/rivers.preview.ts`, now with `SIGMA`), the same 24 rivers on the uncast seed's world: without smoothing 0.23% of 307 km more than 2 m above the bed upstream, largest hump 7.1 m; with it 0.20% of 306 km, largest 8.0 m. The beds do not climb more.

`docs/design.md` (*World Generation Pipeline*, step 6) changes with this decision.

**Reason:** The proposal's constraint 3 asks for no ladder patterns, and a river that runs along the grid in straight 45° runs reads as generated. Measuring first showed the other invariants hold, so the fix could stay in the planform, ahead of the profile, which recomputes the surface on whatever line it is given.

### 166. Woods along rivers, landmark trees, and the shell sloping down before lanes and towns

**Date:** 2026-11-16
**Decision:** The rest of step 5 of proposal 0003 (decision 148), and a fix for the shell's last hanging edge.

- **Woods along rivers.** `ForestLayer` hands the placer the river segments near each level-10 tile (`RiverIndex.forTile` with an 80 m margin, as `RiverStretch` records). Along each stretch, every 7 m on each bank, up to four rows of trees stand out from the water's edge (3 m beyond it, then 7 m apart), with chances 0.85, 0.6, 0.35 and 0.15, so the nearest row is nearly closed and the outer ones thin out. Each tree's draws come from a hash of the segment, the step and the row, not a stream, so a tree does not depend on its neighbors' rejections. They grow only in open land (density under the canopy threshold less 0.1: forest already lines its rivers) below the tree line (not in tundra, alpine land, ice or cold desert, where the first preview put birches and firs along a river through tundra) with moisture of at least 0.05, out of every other stretch's water (a tree at a confluence or a bend), and pick broadleaf, poplar and birch in temperate land, firs with a quarter birches where conifers dominate and only firs in the cold (as open land, decision 153), and evergreen broadleaf in the tropics and over 18 °C. Where a river runs through a lake, its banks are under the lake and get none. The woods are whole trees, as the fringe's are.
- **Landmarks.** Each part (a level-11 cell, about 770 m across) draws one hash: three in ten parts get one lone tree at a jittered point of open land (density under 0.2, 15 m clear of water), below the tree line, scaled 1.55–1.95: an acacia in savanna, a dead tree where moisture is under 0.2, a fir where conifers dominate, an evergreen broadleaf in the tropics, and an oak elsewhere. The hash depends only on the tile, the part and the world, so a landmark stands in the same place on every visit, which is what makes it one.
- **The shell before lanes and towns.** The shell cut road lanes and town clearings per fragment and so ended there at full height, a wall seen from low along a road (open since decision 157). The mesh now treats vertices in a clearing or a built-up patch as open ground for the shell's lift (`MeshOptions.canopyClear`, on meshes with vertex spacing up to 50 m, widened by half the spacing), so the shell slopes down a cell before the lane or the town as it does at a forest edge. Clearings come from `InfraScene.isClear`; towns and industry from the new `InfraScene.isBuiltUp`, because the shell cuts a town per fragment out to its urban outline while the trees' clearing is a disk of 0.6 urban radii: `isBuiltUp` indexes towns and industry by level-7 tile and tests the outline (or disk) where the shader's cut ends at the widest edge noise (1.1 and 1.25 times, at 0.925 of the drawn radius). The first version used the widest drawn radius and left a ring of flat forest shading around the town in check 2's view. The forest trees within the interior reach of a clearing are whole edge trees instead of crowns on the shell. The per-fragment cut stays for the lane itself.
- **Previews.** View `gallery` (40 m over a river 8–80 m wide through open, wet temperate grassland, shrubland, temperate forest or taiga, out of lakes, nearest the farmland target). At seed 1983 it shows a narrow river across green grassland with a closed line of broadleaf and poplars on both banks, thinning outward; the first target lay in a lake the river runs through, with no trees, which is right, and the second in tundra, which the tree line now excludes. Check 2 (`conifer`) shows the shell sloping down to the town's edge where it ended in a wall.

**Reason:** Rivers and lone trees are what a low-flying pilot steers by in open country, and the woods along a river are the cover across it (proposal 0003). A hash per part keeps landmarks fixed without a stored list.

### 167. Natural windings and banks: every river wanders, and its banks swell, narrow and fray in the shader

**Date:** 2026-11-16
**Decision:** The owner asked for natural, noisy banks and windings. Two scales, each where it can be drawn:

- **Wander in the data** (`wander`, `WANDER_TUNING` in `RiverIndex`). After the planform smoothing (decision 165) and before the meander train, every polyline is displaced sideways by two octaves of 1D gradient noise along its arc length: 5.5 and 2.3 point spacings long (about 8 and 3.5 km on the 1,024² grid), 0.3 and 0.14 spacings of swing, and for wide rivers a third octave at 14 widths with 1.2 widths of swing where the points are dense enough to carry it. The displacement is clamped to 0.35 spacings, tapers to zero over the longest wavelength at both ends (half the polyline if shorter), and steep rivers keep half of it (full below a 0.4% bed gradient, half above 3%), so mountain streams stay on their valley floors. Polylines with fewer than nine points are subdivided first, so short tributaries between confluences bend too. Gradient noise rather than value noise: value noise with eased interpolation is flat at its lattice points, where headings lingered on the axis they were meant to leave. Profiles are recomputed on the new line as before, so surfaces stay monotone.
- **Natural banks in the shader** (`RiverShading`, `NATURAL_BANKS`, `RiverStyle.natural`). The coverage loop now keeps the nearest river (least distance to its bank) and its side of the centerline, and evaluates noise once for it: the course swings sideways at about ten widths (typically a half-width, at most 40 m times the noise), the width swells and narrows at six widths (typically 13%, up to about a third), and the edges are ragged at 1.5 and 0.5 widths, each octave only once it spans 4–10 pixels. The dark bank band follows the moved bank and widens and narrows with it. All of it is multiplied by how well the river is resolved (drawn near its true width and at least 3–8 px wide), so distant and widened rivers keep their smooth lines; a GPU test checks that a 40 m river at 30 m per pixel is unchanged. The noise is value noise on the planet-centered position (float32 resolves about 6 cm) with Ashima's mod-289 permutation as the lattice hash, so it does not tile; its wavelengths follow the half-width by octaves blended by where they fall, so a river whose width changes keeps its pattern in place. The blended noise has a standard deviation of about 0.22, which the factors allow for.
- **Debug and previews.** `RiverStyle.natural` (0 draws smooth banks); `NATURAL=0` in `tools/render.preview.ts`.

**How it was checked.** CPU tests: the wander keeps both ends exactly, stays within its cap, is deterministic per river and differs between rivers, scales by the steep share, and bends a two-point polyline; the ten seeds' surfaces, junctions and beds stay clean. GPU test on lavapipe: 160 stations along a 40 m river drawn at 0.25 m per pixel, width 26.5–61.5 m and center −3.75 to +10.5 m over 800 m, banks within the noise's bounds, moving less than 5 m between stations 5 m apart, with the dark band outside the water at most stations; and the unchanged distant river. On seed 1983's eroded rivers the share of channel on grid headings went from 21.1% (decision 165) to 17.3%, stair-steps 18.3 per 1,000 km.

**The side of the river.** The first push split rivers in two under the wander (seen in the `treeline` preview, a straight channel with natural banks off). The shader took the side of the centerline from p · (ua × ub), which near a river is about 1e-9, below float32's rounding of the cross product, so the side flipped at random and the offset moved the water both ways. It now takes the side from the offset to the nearest point against the segment's sideways direction, which float32 resolves to about 1%. The GPU test's river was on the equator, where the old product happened to be exact; the test now uses an oblique river, samples ±80 m, and checks that each station has one channel without a dry gap.

**Not done:** the kernel still carves along the polyline, so on rivers the mesh resolves (wider than about 50 m) the shader's wander can draw water beside the carved channel; the wander is capped at 40 m for that reason. The 17.3% on grid headings is still above an even 11%.

**Reason:** Straight channels with parallel banks read as drawn. Bends at a few kilometers belong in the data, where the carve, the map and later the bridges follow them; bends and frayed edges at tens of meters cost nothing in the data as noise in the shader, which keeps the segment count and the tile synthesis unchanged.

### 168. Ground detail for low flight: stepped micro-facets, chunky cover, soft dust (track G)

**Date:** 2026-11-16
**Decision:** The owner set the direction for ground detail after the first helicopter flights: keep the faceted look and never pursue photorealism; aim for a comic, slightly cartoony look in the spirit of a painted fantasy MMO; fat, chunky grass tufts rather than thin blades; hefty, flat-shaded, low-poly boulders; wispy, soft dust; little or no overhead at altitude, and interesting ground for helicopter low-level flight. The plan is `docs/plans/ground-detail.md`, in five milestones:

- **G1. Micro-facets.** High-frequency relief as a virtual triangle lattice in the ground shader, 0.6–4 m by land cover, with one normal and one shade per micro-triangle: a bump map that keeps the facet rule instead of a smooth or noisy one. It lies on the wrapped coordinates (decision 38) with a tangent frame per cube face, fades below about 4 px per micro-triangle, and a uniform switches it off when the camera is more than about 400 m above the ground.
- **G2. Kit.** Grass tufts, tussocks, reed clumps, bushes, boulders, slabs and pebble clusters as model specs (decision 106), 12–40 triangles each, with no part thinner than 10 cm.
- **G3. Placement.** A pure function in `worldgen/groundCover.ts`, from cell hashes like `canopy.ts`, so the sim can ask it later and no RNG stream changes (rule 5); instances in a ring around the camera, sitting on the triangle the terrain draws, colored from `LandShading` at their ground point, masked off water, pavement, roads, towns and the canopy shell, and switched off above 150–600 m by type.
- **G4. Motion.** Sway from the flight model's gust field, and downwash flattening the cover in rings, so the ground shows height and drift.
- **G5. Dust.** Soft sprites through the particle overlay (decision 142), by surface; it closes H3's downwash task.

Budgets: nothing above 600 m beyond one uniform branch; below 150 m at most 12 draws and 0.35 M triangles at the laptop tier.

`docs/visual-style.md` changes with this decision: principle 6 (detail near a low camera serves helicopter flight), *Terrain* (ground detail near the ground), *What to avoid* (smooth or noisy high-frequency texture, rather than all high-frequency texture) and *Acceptance Checks* (check 11, hovers at 5 m and 30 m). `docs/design.md` gains the ground detail track and its dependencies.

**Open for the owner:** flower accents in meadows; boulders over about 0.8 m as landing obstacles in the sim; sprites or a local density in the volumetric march for dust.

**Reason:** Below about 20 m the terrain changes no faster than its 16 m noise cells and 24 m facets, so a hover gives no cue of height or drift (the owner's note of 2026-11-16 in `TODO.md`). Stepped detail and chunky cover extend the existing style downward in scale instead of adding a second, textured style, and gating every layer on the camera's height keeps working altitude as it is.

### 169. Ground detail: the owner's answers

**Date:** 2026-11-16
**Decision:** The owner accepted the plan of decision 168 and answered its questions:

- **Flowers:** yes, sparse and muted, two or three colors per biome, in meadows.
- **Boulders block landings:** boulders taller than about 0.8 m are landing obstacles in the sim, through `worldgen/groundCover.ts` (H3).
- **Dust:** soft sprites through the particle overlay, not a density in the volumetric march.
- **Snow keeps its sparkle** (decision 139): the micro-facets add only faint shade steps on snow, never a tilted normal.
- **Glints:** wet ground (by the weather's wetness), ice and smooth rock flash per micro-facet where its normal mirrors the sun toward the camera.

`docs/visual-style.md` (*Terrain*, ground detail) and `docs/plans/ground-detail.md` change with this decision.

**Reason:** The owner's review of the plan, 2026-11-16.

### 170. One solid, darker aircraft shadow on the ground's slope

**Date:** 2026-11-16
**Decision:** The flown aircraft's ground shadow (`render/sim/aircraft/aircraftView.ts`) is drawn as one even layer, darker and bluer, on a plane fitted to the drawn ground where it falls. The owner found the helicopter's shadow weird and semi-translucent near the ground and asked for it darker and more robust, without new performance costs.

- **The cause.** Every posed triangle was flattened onto a level plane through the point under the aircraft and blended at 32% black. A closed mesh covers each point of its shadow at least twice (its top and its bottom), and parts stack (canopy over cabin, hub): the cabin reached 54–75%, skids, fins, the tail boom and blades stayed at 32%, and the stacked pieces showed through as separate gray shapes. On a slope, part of the shadow sank into the ground and part floated.
- **One layer.** The body, the hinged pieces, the hubs, the blades and the discs are one mesh in one draw, in that order, with a per-vertex shade (1 for the body, the blades' opacity, the disc's band alpha times its opacity times 0.45). Each fragment writes its pixel's depth on the shadow plane, computed from the screen position and the plane's uniforms (the pixel's ray against the plane, through three's `getViewPosition`), so every triangle at a pixel writes the same bits; with a strict depth test the first triangle shadows the pixel and the rest fail. A strict test on interpolated depths streaked (they differ by rounding), which is why the old shadow blended every layer. A stencil pass would need `depth32float-stencil8`, an optional feature, on the scene target's float depth (decision 112). Hidden sources (stopped discs, faded blades) collapse to a point, so they write no depth.
- **Darker and bluer.** The shadow multiplies the ground by (0.30, 0.33, 0.42) at full strength, about 68% darker and a little less in blue (Part I: shadows deep and blue, never black; a real sunlit shadow is 70–80% darker). It fades in as the sun rises from 3° to 12°, and, as before, under cloud and in terrain shadow.
- **On the slope.** The plane is fitted to the drawn ground where the CG's ray along the sun meets it: first around where the ray meets the level ground under the aircraft, and if the ray meets that fit more than the span away (a knoll, a ridge, a valley), once more around that point. Its slope comes from four samples at the model's planform reach (3–12 m) around the middle one, and it rises to the highest of the five, so the shadow's edges stay above ground that bends up (a gully, the foot of a slope); it is lifted 6 cm plus 0.2% of its distance from the eye against z-fighting. Without a ground query, or on cliffs over 70°, it is level. Where the sun's ray meets a wall, which no plane carries, the shadow may hide in the hill but never hangs in the air. `AircraftPose.ground` carries the query; Free Flight passes its `AirfieldGround`, the drawn surface.
- **Draw order.** The shadow draws first among the transparent draws (render order −1), right after the opaque terrain and aircraft, both faces in one pass. Sorted by distance, its key came from a bounding sphere frozen at its first frame: drawn after the rotor disc or the afterburner flame, its multiply darkened them too, and fading blades, which write depth, blocked it. Water is opaque, so the shadow's depth cannot cut it.
- **Cost.** One draw instead of one plus two per rotor (five for a helicopter, one for the Kestrel as before); the same CPU flattening, now also writing a shade per vertex; four more ground queries a frame (nine over uneven ground), none while the shadow is hidden (`displaySurfaceAt`, which evaluates the render detail at the point); a few vector operations per shadow fragment, which also lose early depth rejection over the shadow's small area.

**How it was checked.** `tests/aircraftShadow.test.ts` builds the Wren's view in Node: on ground rising 0.3 m/m the shadow's vertices lie on one plane within 2 mm, tilted along the slope within half a degree, 2–30 cm above the ground; level at the ground height without a query; shades and collapsed sources at full rotor speed and stopped; hidden below a low sun. `tools/freeflight.preview.ts` gains `HELO=scout|utility` (`HELO_HEIGHTS`, `SLOPE=1` with `SLOPE_KM`, `SUN_SIDE=tail`): the Wren hovering beside the runway with the sun on its side, rendered on Dawn with lavapipe with the old and the new code at 3 m and 10 m, on the level and on the steepest ground near the base (4.8°). The old shadow shows the stacked pieces as separate gray shapes and a paler tail boom; the new one is one solid blue-gray silhouette with the skids' struts, and the spinning disc a faint ring outside it (`docs/reports/screens/helo-shadow-before-after.png`).

**Review.** An adversarial review (three lenses, two skeptics per finding) upheld four findings, fixed before the owner saw it: the draw order above; the plane anchored only where the ray met the level ground, so a knoll there hung the shadow in the air over the valley in front of it; edges sinking under ground that bends up; and the preview's first hover height read before the drawn tiles had loaded. Tests now fly a knoll, a hillside, a gully, the draw order, and each fails without its fix.

**Not done.** Dust does not dim the shadow yet (decision 142; the lighting has no dust term); a steeper slope than 4.8° was not rendered (the unit tests cover 17° and the gully's 22°); the owner's look in the browser.

**Reason:** The shadow is the main height cue near the ground (Part I, The Controlled Aircraft), and the owner flies helicopters there.

### 171. G1, first pass: micro-facets as piecewise-linear fields on turned lattices

**Date:** 2026-11-16
**Decision:** The ground shader draws stepped relief finer than the mesh near a low camera (`render/sim/terrain/microFacets.ts`, decisions 168, 169).

- **The field.** Each octave is a scalar field on a cubic lattice split into six tetrahedra per cube (the Kuhn triangulation), with an integer hash at each lattice point, linear inside each tetrahedron. Its gradient is constant per tetrahedron, so where the ground cuts the lattice it falls into flat cells, triangles and quads about a cell across, each with one tilted normal and one albedo step. The plan's triangular lattice on a tangent frame per cube face is not needed: the field is 3D, so it has no seams at cube faces and no stretch on slopes.
- **Periodic and turned.** The lattice lies on the wrapped coordinates (decision 38) with a whole number of cells per wave period, and each octave's integer matrix maps that period onto itself. The first renders with axis-aligned lattices of 4, 1 and 0.5 m showed diagonal stripes, because nested powers of two share lattice planes; the octaves now have 1024, 2400 and 5400 cells per period (cells about 4, 1.2 and 0.5 m across) under three different integer matrices, and the stripes are mostly gone.
- **Land cover.** Grass takes soft lumps (the 1.2 m octave strongest), dry ground grit (0.5 m), rock chiseled planes (4 m); snow keeps its normal and its sparkle and takes only faint shade steps at 4 m. Water, towns, the canopy and roads keep the facet's normal.
- **Fade and cost.** An octave shows from 3 px per cell and fully from 7 px; all fade out from 360 m to 600 m. A uniform set from the camera's height above the ground skips the evaluation above 600 m, and a per-fragment distance test beyond it.
- **Glints.** A cell flashes where its tilt, and not the facet under it, mirrors the sun toward the camera, on wet ground (by wetness) and on rock polished by glaciation. In the previews rock glints at full polish were too many; their weight is 0.25 against 1.5 for wet ground.
- **Previews.** `tools/render.preview.ts` gains the target `meadow` (open, unsettled grassland or shrubland nearest the main continent, by the global forest density, of 255, under 45 in its cell and 70 around it) and the views `hover` (5 m) and `skid` (20 m) over it and `nap` (60 m) over the farmland; `MICRO=x` and `GLINT=x`. The debug panel's Lighting folder gains "Micro-facets". Seed 1983 on lavapipe: `docs/reports/screens/ground-g1-*.png` (hover with the detail off and on, skid, and a rock face with `TARGET=peak`).

**Not done:** crop furrows, sand ripples, scree and marsh (each needs a direction or a mask the shader does not have yet); timing on a real GPU; ice glints.

**Reason:** Stepped cells extend the faceted style down in scale (the owner's direction, decision 168), and a field on a lattice in space is the cheapest way to get them without seams or a second parameterization of the ground.

### 172. G2: the ground cover kit

**Date:** 2026-11-16
**Decision:** Fifteen model specs of a new class `cover` (8–40 triangles; Part I, *Polygon Budgets*), built by the existing builder with no new part type (decisions 106, 168, 169):

- **Blades** are three-sided cylinders that taper to a point and lean out from a small ring, 18–26 cm wide at the base: three triangles each, so a tuft of seven is 21 triangles and stays fat and chunky in silhouette. A second blade shape (folded, blunt tips) would double the count for little gain at the sizes the ring draws.
- **The kit:** grass tuft and dry tuft (21 triangles), flower tufts in cream, yellow and violet (31–39, flat heads nestled among the blades), tussock (36), reed clump with cattails (40), bush and dry bush (36, three faceted domes), boulders small, medium and large and with lichen (20–40, jittered and flattened icosahedra), a sandstone slab (24) and pebbles (36).
- **Dark bases, light tips.** The builder's ground occlusion darkened the lowest 2.5 m of a model, which would darken a whole tuft; for class `cover` it reaches over 80% of the model's own height.
- **Rock by face.** Boulders, slabs and pebbles color their faces through camouflage schemes (`rock`, `rock-lichen`, `sandstone` in `palettes.ts`), one of three or four shades per face over a 0.3–0.5 m pattern, so they read faceted without extra geometry.
- **Generated specs.** `tools/models/cover.py` writes `specs/cover-*.json` from a fixed layout, as `tools/models/carrier.py` does for the carrier.
- **New model colors:** `grass-dark`, `grass`, `grass-light` (Part I's grassland shades), `grass-dry`, `grass-dry-light`, `reed`, `reed-head`, `flower-cream`, `flower-yellow`, `flower-violet`. In the scene (G3) each instance takes the ground's color under the model's value ramp, so these colors matter mainly in the model viewer.

The contact sheet is `docs/reports/screens/ground-g2-kit.png`. `docs/visual-style.md` (*Polygon Budgets*) and `docs/plans/ground-detail.md` change with this decision.

**Reason:** The owner asked for fat, chunky tufts and hefty, low-poly boulders (decision 168). Built from the existing primitives, the kit needs no new builder code beyond the occlusion's reach, and stays within a budget that lets the ring draw thousands of instances.

### 173. Meander migration with cutoffs and oxbow lakes on large lowland rivers, once per world in the worker

**Date:** 2026-11-16
**Decision:** N2's migration (proposal 0005, decision 161): large lowland rivers evolve their bends by Howard–Knutson migration with neck cutoffs, and the cut-off loops stay as oxbow lakes.

- **Which rivers** (`MIGRATION_TUNING`). A polyline at least 80 m wide on average with a bed gradient under 0.1%. Rivers of 25–80 m keep decision 126's procedural train, every river keeps decision 167's wander, and steep rivers only that. The width threshold is about cost: 40 m would migrate 8,860 km of seed 1983's rivers, 80 m about half. A first version also asked for a floodplain eight widths across: on seed 1983 only 11 of 128 such rivers had one, since at landform gain 12 the global grid's valleys rise 6 m within a few hundred meters (median 3.3 widths across), so that test went and the floodplain edit below makes the room instead.
- **Floodplain** (`floodplainOf`). Every 600 m along the planform, the distance to each side where the global height first rises 3 m plus 2% of the width above the river's cell surface, out to 12 km; the half-width is their mean, smoothed over five samples, and the channel's room is that clamped to 3–8 widths either side (8 is the tile kernel's floodplain).
- **Floodplain edit** (`floodplain*` in `TILE_SYNTH_TUNING`, in the kernel's carve). Around channels at least 60 m wide whose surface falls less than 0.2% per segment, and around oxbows, the carve's profile beyond the bank becomes the lower of decision 146's (the water surface rising at 4%) and a meander belt: 2 m above the water out to three widths, then rising at 8%. It only lowers, the carve stays the minimum, and the result is a flat valley floor around the migrated channel instead of a trench in the valley side.
- **Migration** (`migrate`, in `worldgen/channels/migration.ts`). As meanderpy implements Howard and Knutson (1984): nodes 1.5 widths apart in a gnomonic plane at the polyline's middle; each moves toward its outer bank by R1 = Ω R0 + Γ Σ R0 upstream G / Σ G, with R0 = W × curvature, Ω = −1, Γ = 2.5 and an upstream decay of 0.8 widths; the move per iteration is 0.25 R1 widths, at most 0.15 widths; 300 iterations; resampling every iteration. It starts from the procedural train, so bends are seeded; no random numbers. The channel keeps a width inside the floodplain's edge (measured from the original line, located by each node's valley coordinate), and migration fades in over 12 widths from each end, so confluences and mouths stay exactly where they are. Every third iteration, a neck closer than two widths around a loop of at least eight widths is cut off. Width and water surface come from the original points through each node's valley coordinate, and the profiles are recomputed on the migrated line as for every river, so surfaces stay monotone.
- **Oxbows.** Each cut loop becomes standing water: segments after the network's (`RiverIndex.oxbows`, apart from `lines`), 80% of the river's width, level at the river's surface where it was cut off less 0.3 m. The tile kernel carves them like rivers and the terrain draws them as river water with natural banks; their zero gradient means no white water (decision 155). No silting yet.
- **Where it runs** (`computeChannels`, `Channels`). In `finishWorld`, in the worker, once per world: the result (migrated polylines and oxbows in typed arrays) is transferred and stored with the world, and `RiverIndex` takes it through its `channels` option in place of its own planform for those rivers. `riverPlanforms` is the planform stage both share. `GENERATOR_VERSION` is 15: stored worlds regenerate.
- **Speed.** Typed buffers and a neck search every third iteration took it from about 1 µs to about 0.4 µs per node and iteration.

**How it was checked.** `tests/migration.test.ts`: on 80 km synthetic rivers 100 m wide from three seed lines, both ends exact, sinuosity 1.5–3 with oxbows whose ends are within the neck distance, valley wavelength 7–18 widths and median apex radius 1–5 widths (the proposal's 10–14 and 2–3 as bands, since a single run fluctuates), confinement to a 600 m floodplain, determinism; on two seeds' CPU networks (96² per face) the channel stage runs and `RiverIndex` with its output keeps every invariant of decision 165, with oxbows level and below the network's sentinel. On the synthetic rivers sinuosity settles near 2.2–2.6 with cutoffs, the Howard–Knutson equilibrium; one of four seed lines stayed near 1.2 at 1.5-width spacing.

**On seed 1983's eroded world** (1,024²): 128 rivers migrated, 91 oxbows; every invariant of decision 165 holds (66,610 km of channel, no rises, junction gaps or bed humps; 17.5% on grid headings, 16.3 stair-steps per 1,000 km). The stage took 17 s in a container shared with a render (15.2 s of it migration, 2 µs per node and iteration); replacing `Math.hypot` and per-node allocations in the hot loop took the coarse test worlds from 3.5 s to 2.2–2.6 s, and `GENERATOR_VERSION` is 17 since rounding changed. **The first render** (straight down from 6 km over the river with most oxbows) showed the migrated channel and closed oxbow loops, but beside a lake 125–220 m deep that the river runs through: migration had thrown meanders out across the lake's reach, along both shores. Rivers run on through lakes to their outlets, so reaches in lakes (lake depth over half a meter at the line's points, widened by four widths either way) now get no room and keep their line, and a river with more than half its points in lakes does not migrate (`lakeAlong`, `lakePad`, `maxLakeShare`; a test keeps a reach without room on its line). `GENERATOR_VERSION` is 18. After it, on seed 1983: 116 rivers migrated, 63 oxbows, the stage 6.7 s with the container otherwise idle; every invariant holds (66,780 km, no rises, junction gaps or bed humps); the same view shows the lake without meanders along its shores.

**Reason:** The proposal asks for meanders, cutoffs and oxbows that emerge from a process rather than a drawn pattern, and Howard–Knutson is the standard minimal one: bends skew downstream, migrate down the valley and cut off, as real lowland rivers do. Running it once per world in the worker, and storing the result, keeps its seconds out of the frame loop and off every world load.

### 174. G3: ground cover placed per cell on the drawn triangles, in a ring around a low camera

**Date:** 2026-11-16
**Decision:** The kit of decision 172 stands on the ground near a low camera (decisions 168, 169).

- **Placement** (`worldgen/groundCover.ts`, pure, shared with the sim later). One cell per level-10 sample (about 6 m), named by cube face and global sample index, with five candidate slots. The caller samples a site per cell (tile cover, moisture, annual mean temperature, slope of the drawn triangle, forest density, aridity, farmland from the habitability); `coverMix` gives each kit model a probability per slot: meadows of tufts with flowers and a few bushes, dry grass with tussocks, desert stones, tundra tussocks and lichen rocks, alpine meadow and fell, reeds in marsh, pebbles on gravel bars, nothing under closed forest, verges only in fields, and boulders, pebbles and sandstone slabs blended in with slope. Block patterns of five cells make clumps and boulder fields, and one flower color holds per block of nine cells. Hashes only (seed `rng(seed, "ground-cover")`), so no other stage changes. `isObstacle` marks boulders of 0.8 m and taller for H3's landing zones; `COVER_HEIGHT` lists each model's top, checked against the specs by a test.
- **On the drawn triangle.** A chunk (an eighth of a level-10 tile, 32 samples) computes the mesh's own vertex heights over it with the mesh's sampler and diagonal; every item stores the plane's point as a base on the sphere and a displacement per unit of exaggeration, so the vertex shader follows the exaggeration as the mesh does. A test builds the tile mesh and finds every item within a centimeter of its triangle's plane at exaggerations 1 and 3.
- **Masks.** Sea and lakes (heights and the lake sampler), river water (the river index's stretches, as the woods along rivers), the infrastructure's clearings (roads, airfields, towns; per item only in cells near one), closed forest (the placement). Plants scale to nothing below about −1 to −4 °C, where the ground holds snow; rocks take snow on their tops.
- **Drawing** (`render/sim/ground/groundCoverLayer.ts`). Chunks within reach are placed nearest first, four rows of cells per slice within 3 ms a frame (a chunk is about 10 ms of CPU), and kept while near. One instanced mesh per kind, at most 15 draws, its items in one interleaved buffer (WebGPU allows eight vertex buffers; one attribute per buffer broke the pipeline); the meshes are refilled from an anchor at the eye when it moves 6 m or turns about 11°, with each kind's items within its range and the view cone. Ranges: 120–150 m for tufts, flowers and pebbles, 220–450 m for tussocks, reeds, small boulders and bushes, 650–800 m for boulders and slabs; items shrink into the ground over the last 30%, and above a kind's range the camera sees none.
- **Color.** Each item carries the open ground's color at its cell (the tile vertex color with the land shader's moisture tint). The first renders tinted green parts by the full ratio of that color to Part I's grass: on gray alpine ground the blue ratio clamped high and the tufts turned gray-pink. Plants now take the ground's brightness and half its hue. The season browns them by the ground's greenness, not their own, so they never turn where their meadow does not. Rock schemes are a step lighter than the terrain's rock.
- **Light.** The model frame was a reflection (x × y = −z), which turned every model inside out under front-face culling: bushes showed as hollow shells. It is now a rotation. Faces are lit through a normal bent 45% toward the vertical, plus light bounced from the ground on faces that lean away from the sky: with the sun from the side, a rock's shaded faces had dropped to 5/255.
- **Previews.** `hover` and `skid` over the meadow target (alpine meadow at seed 1983), `TARGET=gallery` (green meadow by a river with its woods) and `TARGET=peak` (scree): 2,100–6,200 items, 0.06–0.18 M triangles in 6–9 draws. `COVER=0` leaves the cover out; GUI → Tiles → "Ground cover". Pictures: `docs/reports/screens/ground-g3-*.png`, in clear weather (the views' default since; the live weather had put the meadow under an overcast deck, which read as dusk).

**Not done:** talus below cliffs, reeds along river banks, denser verges; ranges by quality tier; a test that level 10 draws throughout the ring; timing on a real GPU; trimming the placement's CPU cost.

`docs/plans/ground-detail.md` changes with this decision.

**Reason:** Cover on the drawn facets, colored from the ground it stands on, is what makes low flight read as close to the ground; one draw per kind keeps the cost flat however many chunks are near, and a pure placement function lets the sim treat the same boulders as obstacles.

### 175. Crossing sites on the coarse rivers; settlements drawn to them, bridges cheaper at them

**Date:** 2026-11-16
**Decision:** N4's first task (proposal 0005, generation step 2): crossing sites on the rivers that need bridges, before settlements and roads, in `worldgen/strategic/crossings.ts`.

- **Score** per coarse river cell that needs a bridge, 0..1: a straight reach (the cosine between the reach in and out, from 0.3 to 0.95), firm banks on both sides (reference slope from 0.2% to 1.2%, half again on cliffs steeper than 12–35%, so gorges still score: an arch spans them), one river (a third at a confluence), a narrower river (down by up to 30% from 100 to 600 m wide), and nothing at a mouth or next to a lake or the sea.
- **Sites**: cells scoring at least 0.45, taken best first, each keeping other sites three cells away up- and downstream (a first rule, "beat every cell within three", left a single site on straight reaches of equal score). They join the graph as `crossings` (cells, points, scores, river widths), transferred with it.
- **Settlements**: habitability's water term gains 0.35 × the score of a site at or next to the cell. **Roads and railways**: entering a river cell costs the bridge times (1 − 0.5 × its crossing score).
- **Effect** on six seeds (1–5 and 1983): about a thousand sites per world; settlements at or next to a site up 25–30% (seed 1983: 157 → 199 of about 1,700), bridges at a site from about 8% to about 30% (28 → 89 of 304), about 2% more settlements and 10% more bridges. Every seed keeps its cast seed (no new validity retries). `GENERATOR_VERSION` is 19; casts change, which decision 163 accepts.
- **Tests** (`tests/crossings.test.ts`): on a synthetic valley, sites lie on the river with scores above the threshold and spaced, no score off the river, at the mouth or on flat banks, the pull raises habitability only at sites and their neighbors, and the graph carries and reproduces them. The full CPU suite passes (98 files, 877 tests).

The eroded world's crossing sites, where the alignment snaps bridges (N5), come later.

**Reason:** Towns grow where a river can be crossed (Oxford, Frankfurt, Maastricht), and roads converge there; scoring the crossings before both lets the settlement pattern and the bridges follow the rivers, as the proposal's generation order asks, with changes local to the river cells.

### 176. G4: ground cover in the wind and under the rotor

**Date:** 2026-11-16
**Decision:** The cover moves (decisions 168, 174), so a low pilot reads wind, height and drift from the ground.

- **Wind from the flight model.** The gust field (`sim/flight/wind.ts`) has cells of 320 m, so over the cover's ring it is nearly linear. Each frame the layer calls `airVelocity` at the ground under the eye and 50 m east, west, north and south of it, and hands the shader the wind there and its gradient: a gust that bends the grass is the gust the aircraft feels, at no cost per vertex. The wind across the ground leans each plant from its root, the tip most (the square of its height fraction), and the tip drops as it leans. Waves 9 m long run along the wind, and each plant flutters at its own phase. Stiffness by kind: tufts and reeds 1, flowers 0.9, tussocks 0.8, bushes 0.2; rocks do not move. Lean is 0.05 of the plant's height per m/s, at most 0.85.
- **Downwash** (`sim/flight/rotor/downwash.ts`, pure, for H3 and G5 too). The outwash at the ground is 1.1 times momentum theory's induced velocity √(T/2ρA) from the model's thrust, disc area and air density, at full strength up to a rotor radius of hub height and gone by 1.75 rotor diameters, weaker with the advance ratio (1/(1 + 25μ²)), centered where the disc's axis meets the ground. Free Flight hands it to the layer every frame for a helicopter and clears it for the Kestrel and on exit. Tests: a low hover's outwash lies within 30% of 1.1·v under the hub, weakens with height, is gone above the fade and is stronger under the heavier type.
- **Flattening.** In the shader the outwash runs outward from that center, rising over half a rotor radius, falling as 1.6R/r and cut off from six to ten radii, in rings spaced 0.8 radii that travel outward at half the outwash speed plus 2 m/s. It leans plants 1.8 times as hard as a wind of its speed (it blows down onto them as well as across), and grass laid past a third of its height shows a paler side (up to 35% lighter). The preview's `WASH=speed[,radius]` and `WASH_AT` place a wash ahead of the observer; at seed 1983's alpine meadow (`docs/reports/screens/ground-g4-wash-*.png`) the tufts within a few radii lie over outward and pale. A still picture of sparse cover shows the ring poorly; the motion is for the browser.
- **Clock.** The layer's time runs on the scene's effect clock, so the grass stops when the game is paused.

`docs/visual-style.md` (*Helicopters*, downwash) changes with this decision.

**Not done:** near trees swaying under the rotor; a check in Free Flight in the browser (check 11).

**Reason:** Motion is what turns ground detail into a cue: the rings under a rotor give height and drift at a glance, and grass bending with the flight model's own gusts ties what the pilot sees to what the aircraft feels.

### 177. Trees keep out of the drawn water and line its moved banks; rivers start in the mountains

**Date:** 2026-11-16
**Decision:** Two changes from the owner's look at the natural banks (decision 167): trees stood in the water at the edges, though trees near the water are wanted, and few rivers seemed to start in the mountains.

- **The bank noise on the CPU** (`render/common/water/naturalBanks.ts`). The shader's bank noise (value noise on Ashima's mod-289 lattice hash, octave bands blended by width) in float64, sharing `NATURAL_BANKS` with the shader, and `waterDistance`: the signed distance from a point to the nearest drawn river water, choosing the river as the shader does (least distance to its bank) and taking the side the same way, with the wander, swelling and both ragged octaves at full strength, as the shader draws them near the camera. By default it is the lesser of the natural and the smooth banks, since a distant river is drawn smooth. A GPU test checks it against the shader: on an oblique 40 m river at 160 stations, the banks agree within the test's 0.5 m sampling step. Points farther from the smooth bank than the noise can move it skip the noise.
- **Trees** (`forestLayer.ts`). Every tree site within 1.5 m of the drawn water is dropped (`TREE_WATER_MARGIN`): closed forest, open land, the woods along rivers and landmarks (which keep 15 m). The woods along rivers (decision 166) now stand in rows from the drawn bank: the bank noise at the centerline point moves and swells the bank, and the rows are measured from there, so the trees follow the water's actual edge instead of the polyline. On the forest test's synthetic river 413 of 9,216 closed-forest trees stood in the water; none does now.
- **Headwaters** (`RIVER_TUNING.headwaterDischarge`, `extractRivers`). A river was drawn only where its discharge reached 20 m³/s, which in mountains is well below the ranges' crests. Each river that begins at a source now runs on upstream along its largest tributary while the discharge stays at least 4 m³/s (8 m wide), so it starts high in the mountains as a stream. Only sources are extended: no new polylines, confluences or junctions; the profiles keep their surfaces monotone (the invariant tests over ten seeds pass), and the width tapers with the discharge. `GENERATOR_VERSION` is 20.

**How it was checked.** `npm run check` without the GPU suite: 99 files, 881 tests; the river coverage GPU test with the CPU twin; the forest layer's tests now measure distances to the drawn water. On seed 1983's eroded world the headwaters lengthen the rivers from 66,780 to 86,283 km of channel (+29%), every invariant of decision 165 holding (no rises, junction gaps or bed humps; stair-steps 10.4 per 1,000 km). Not yet seen in a render or the browser.

**Reason:** Trees should crowd a river's bank, which is where a low-flying pilot sees them, and must never stand in its water; the only way to do both with banks the shader moves is to place them with the same function. Rivers that appear from nowhere halfway down a valley read as wrong; their real sources are streams near the crests.

### 178. Micro-facets on 2D triangle lattices (no moiré); darker boulders, larger tufts

**Date:** 2026-11-16
**Decision:** The owner's first look in the browser found moiré in the micro-facets (decision 171) where an octave fades, and asked for darker boulders and perhaps larger grass.

- **Cause.** Each octave was a field on a 3D lattice of tetrahedra cut by the ground. A plane cuts a tetrahedron into cells of any shape, including slivers far thinner than the octave's size, so where the mean cell was the 3–7 px of the fade, slivers fell below a pixel and aliased: swirls of lit and shaded slivers (green-gray dots on tan ground), in a ring at the fade's distance. Not doubled geometry. The previews at one sample per pixel did not show it clearly.
- **Fix.** Each octave is now a height field on a 2D square lattice split along one diagonal, every cell a whole right triangle of the octave's size, on the plane across the world axis nearest the terrain facet's normal. The facet's normal is constant over the facet, so the plane changes only along facet edges, which are shading edges anyway; cells stretch by at most √3 on the steepest faces. Periodicity holds as before (integer 2 × 2 matrices on the wrapped coordinates): cells of 4 m, 1.2 m (turned 45°) and 0.45 m (turned and sheared, det 3). The hash takes the plane as its third coordinate. Three hashes per octave instead of four. The fade starts at 4 px per cell and is full at 9 (was 3 and 7). `docs/reports/screens/ground-g1-skid-triangles.png`: the skid view with the cover off.
- **Boulders.** The `rock` and `rock-lichen` schemes are cool grays a step darker (`#77736E`, `#8A857E`, `#64605B`), so boulders stand out from warm open ground; the bounce light of decision 174 keeps their shaded sides from going black.
- **Grass.** Tufts and dry tufts scale 1.05–1.75 (was 0.8–1.35), tussocks 0.9–1.5, flowers 1.0–1.45: about 30% larger, at no cost in triangles.

`docs/plans/ground-detail.md` changes with this decision.

**Reason:** Thin cells are the one thing a fade by cell size cannot catch; a lattice whose cells are all whole triangles of one size can be faded safely, and keeps the faceted look the owner liked.

### 179. Bridges at every river the world draws, typed, with span, traffic and detour, named, and all of them targets

**Date:** 2026-11-16
**Decision:** N4's bridges (decisions 161, 163), on the coarse pass.

- **Where.** A road or railway needs a bridge over every river carrying `RIVER_TUNING.minDischarge` (20 m³/s, about 18 m wide), the rivers the eroded world draws, no longer only rivers 25 m and wider (`BRIDGE_MIN_DISCHARGE`). The road search charges the bridge there as before (less at crossing sites, decision 175).
- **What** (`worldgen/strategic/bridges.ts`, `describeBridges`; `BridgeList.kind`, `span`, `traffic`, `detour`, `names`). Kind from the river, the valley and what it carries: suspension over rivers wider than 500 m, a viaduct where a railway (or a motorway or trunk road) crosses a valley deeper than 60 m (80 m), an arch between banks steeper than 12% for spans under 250 m, a truss for railways and spans over 120 m, else a beam. Span: 1.4 × the river's width plus 20 m, a viaduct four times its valley's depth, a suspension bridge 1.2 widths. Traffic: the gravity model's on the road carried; on railways, the lines through the cell. Detour: the shortest way round on the same network with the bridge's cell removed, between its neighbors on opposite banks, less the way across, out to 400 km (`DETOUR_NONE` beyond). Spur roads' bridges are described the same way.
- **Names** (`nameBridges`, `names/bridges` and `names/spur-bridges` forks of `rng(seed, "names")`): the nearest town within 20 km ("Godra Bridge", "Faal Rail Bridge", a "Viaduct" for viaducts), else a fresh name in the nearest town's flavor; repeats take numerals ("Deta Bridge II").
- **Targets.** `TargetKind` gains `bridge`: every road, rail and spur bridge in a side's territory, in the theater of the front its cell lies behind (else the strategic theater), named after it, near its town. Value 0.1 + 0.35 × √(traffic / the world's most) + 0.25 × min(1, detour / 150 km), plus 0.1 for railways (a convoy cannot take the road round them): below industry and logistics (0.5–1) except the busiest bridges with no way round, since a world has hundreds of bridges to a few dozen other targets. The map keeps drawing bridges as their marks on roads and railways, not as badges.
- **On six seeds** (1–5, 1983): 430–530 bridges each (road 350–430, rail 64–99, spur 0–3), mostly beams (about 70%) and trusses; arches and viaducts are rare (0–2), since the coarse grid's 6 km cells smooth the valleys. About two thirds have no way round within 400 km, and the median detour of the rest is about 200 km: the coarse network is sparse (a settlement every 25 km or so) and a river is often crossed only once along its course. Bridges are about nine in ten of the targets (seed 1983: 436 of 476). Casts are unchanged in seed.
- **Not yet:** polylines cut at bridges (bridges as network nodes), bridge labels on the map, viaduct prediction from finer relief, and the alignment's bridges matched to these (N5). `GENERATOR_VERSION` is 21.

**How it was checked.** `tests/crossings.test.ts`: every bridge has a kind, a span at least its river's width, traffic, a detour or none, and a unique name of its kind; some bridges can be bypassed; the threshold is the drawn rivers'; on a campaign world every bridge in held territory is a target named after it, valued in (0, 1], on its side's ground, with target ids their indices. The full CPU suite passes (99 files, 884 tests).

**Reason:** Bridges are what interdiction is about (decision 163): every bridge a player can see over a drawn river must exist in the campaign's data, and the planner needs to know which bridges matter: how much they carry and how far the traffic must go round without them.

### 180. The alignment tier's core: a router with 16 headings, plans of arcs, grade-bounded profiles, earthworks and corridor edits

**Date:** 2026-11-16
**Decision:** N5's first pieces (proposal 0005, "Roads and Railways"; plan, conflicts 8 and 9), headless in `worldgen/networks/`, tested on synthetic ground; not yet wired to the world.

- **Router** (`router.ts`). A* on a square lattice in a plane (meters). The state is a node, the heading it was entered by (one of the 16 moves of Galin et al.'s k = 2 neighborhood: axes, diagonals and knight's moves) and the straight moves since the last turn, up to five: with 16 headings the least turn is about 18°, so a wide curve is straight runs with turns between them, and a turn's radius is reckoned from the run before it (run ÷ 2 tan(turn/2)). Turns tighter than the class's minimum radius are forbidden, as are grades above its maximum; grades above a quarter of the maximum cost (grade over maximum)² × a weight, turns their angle² × a weight, and the ground's departure at a move's midpoint from its straight grade stands in for earthworks. Costs are float32 to halve the memory (a 20 × 5 km band at 50 m is about 36 MB). `ROUTE_CLASSES` holds the proposal's table (mainline and mountain railway, motorway, trunk, secondary, mountain road, track). Switchbacks emerge: on a 30% face the mountain road (14%, 12 m radius) zigzags; a mainline railway (2%, 500 m) goes round a 200 m ridge through its gap.
- **Plan** (`alignment.ts`, `fitPlan`). The lattice path's corners rounded with arcs of the minimum radius, tighter only where the straights either side are too short (reported as violations), resampled every 10 m.
- **Profile** (`designProfile`). The ground along the plan, smoothed over 200 m, projected onto grade-bounded curves: the mean of the largest one below and the smallest one above, which keeps the grade exactly and splits cut and fill; a 150 m moving average then rounds crests and sags (an average of grade-bounded curves stays bounded); the ends are pinned to their anchors' elevations.
- **Earthworks** (`earthworks`, `EARTHWORK_LIMITS`). Fill beyond the class's viaduct threshold (12 m railways, 15 m motorways and trunk roads) becomes a viaduct, cut beyond the tunnel threshold (20, 30, 40 m) a tunnel, the rest a corridor; secondary roads and below take no structures and follow the ground more closely instead.
- **A piece** (`pieces.ts`, `alignPiece`). Between two anchors (unit directions), in a gnomonic plane at its middle, within a band around the straight link: route, plan, profile, earthworks, and a `CorridorEdit` per run of corridor points (decision 164), with the class's formation half-width (`FORMATION_HALF_WIDTH`) and banks reaching as far as its deepest cut or fill needs.

**How it was checked.** `tests/router.test.ts` (16 moves; nearly straight across a plain at an odd angle; switchbacks within grade and radius up a 30% face; a railway through a ridge's gap within grade and radius; no route where none meets the grade; determinism), `tests/alignment.test.ts` (arcs no tighter than the radius, ends kept, a corner too tight reported; profiles within grade, pinned and without kinks; a railway viaduct over a 60 m valley and a tunnel under an 80 m ridge, a secondary road with neither; a trunk road piece on the sphere whose corridor edits, applied through `TerrainEdits`, put the ground on the formation within 5 cm of the design). The full CPU suite passes (101 files, 894 tests).

**Next:** spiral loops as a template where a railway cannot meet its grade (conflict 9), river crossings in the router's extra cost with structure records, anchors from the network's links, the routing surface (level-6 tiles; spike N5.0), and the corridors into the app's `TerrainEdits` and the segment tables (N6).

**Reason:** These are the parts every road and railway goes through; building and testing them on ground whose answers are known (a face too steep, a ridge with a gap, a valley too deep to fill) before the world's ground makes failures there legible.

### 181. Spike N5.0: router v2 (the node as state, soft grades, radius-weighted turns); alignment is lazy, near the camera, on the terrain's own tiles

**Date:** 2026-11-16
**Decision:** `tools/networks.preview.ts` aligned 34 pieces (about 12 km each) of seed 1983's roads and railways (the steepest by relief, and a spread of the rest) over the global grid and over level-6 tiles. It changed the router, and settles where alignment runs.

- **Router v1 failed on real ground.** 22 of 34 pieces routed on the global grid and 19 on tiles, at 0.5 and 1.4 s per km, up to 2.9 million expansions per piece: a state per node, heading and straight run is about a hundred per node, and forbidding any move steeper than the class's grade boxed anchors in among mountain slopes of 30–60%.
- **Router v2** (`router.ts`). The state is the node alone, which keeps its best parent's heading for the turn cost (Galin et al.); ground steeper than the class's maximum costs 30 × (excess over maximum)² (the cut and fill the profile will need) up to the class's `maxOver` × the maximum (3 for railways and motorways, 2.5 trunk roads, 2 secondary roads, 2.2 mountain roads and tracks: classes without structures must keep near the ground); a turn costs `curveWeight` × the class's minimum radius × its angle² (the arc it needs), so motorways stop zigzagging (8 switchbacks on one piece before, 0–2 now) while mountain roads still switch back; turns over 90° are forbidden except where the radius is below the lattice spacing. The radius is the plan's: `fitPlan` now simplifies the path to ¾ of a lattice spacing (Douglas–Peucker) before rounding its corners, so the lattice's wiggles become bends. Each class falls back to its mountain class (secondary → mountain road, mainline → mountain railway) where it finds no route.
- **Result** on the same 34 pieces: global grid 32 routed, 16 ms per km, ×1.29 the straight length, 16 switchbacks, 26 km of viaduct and 19 km of tunnel, deepest corridor cut or fill 48 m, 55 corners tighter than their class's radius; level-6 tiles 32 routed, 35 ms per km, ×1.45, 128 switchbacks (19–27 on each steep secondary road taken as a mountain road), 18 km of viaduct and 16 km of tunnel, deepest corridor cut or fill 30 m, 391 tight corners. Tiles take 0.2 s each on lavapipe (39 for the run).
- **Where alignment runs.** At 16–35 ms per km, a world's 50,000 km of roads and railways would take 15–30 minutes: too slow for generation. It runs lazily, near the camera, on the level-6 tiles the terrain renderer has already cached (about 100 km of network within a view's reach is 2–4 s, on a worker), with pieces anchored so results do not depend on order (decision 161, plan conflict 8; decision 163 accepted lazy alignment). The global grid misses the relief that makes switchbacks, so tiles it is.
- **Still wrong.** Mountain railways put too much on viaducts (up to 12–18 km in a 21–27 km piece) where a real line would spiral (the template is a TODO); two secondary pieces of one road found no route either way; corners tighter than the radius remain on rough tiles.

**Reason:** The spike was the plan's gate before wiring alignment into the world; it showed the first router could not be used and gave the numbers for the eager-or-lazy choice.

### 182. G5: dust, grit, snow and spray under the rotor

**Date:** 2026-11-16
**Decision:** What a rotor's downwash (decision 176) raises from the ground, as soft, wispy sprites (decisions 168, 169: sprites, not a density in the volumetric march).

- **Which** (`washSurface`, pure, tested): spray over the sea, lakes and rivers and a little over marsh; snow powder where the surface temperature is under −1.5 °C and the ground is wet enough for snow (not off pavement); ochre dust on deserts and beaches, and on dry grass and scrub (moisture under 0.4); gray grit on gravel, alpine ground, tundra and pavement (the infrastructure's paved clearings); nothing on green ground, where the flattened grass is the cue. Rain-wet ground raises less, none when soaked. Read once per frame at the wash's center from the level-7 data, the climate, the season and the river index.
- **Motion without state** (`render/sim/ground/rotorDust.ts`). Up to 700 instances times the particles' quality factor (`Precipitation.density`), scaled by the outwash (full at 10 m/s) and the surface. Each sprite's life (2.2–4 s), phase, pace, size and, at each rebirth, direction come from a hash of its index; its place is a function of its age: out along the ground from half a rotor radius to about three (fast, then slowing, as the wall jet spreads), up into a billow of up to a radius, and off with the wind at the ground (the flight model's, decision 176). Reborn under the rotor, so the cloud follows the helicopter.
- **Look.** A camera-facing quad, stretched along its motion on screen, swelling and thinning with age; its opacity falls off from the middle and value noise eats its edge, so it reads as a wisp. It fades against the scene's depth over 1.5 m (soft against the ground) and near the lens. Dust takes the ground's color, lightened; grit, snow and spray their own tints. Light from `particleLight`, as the weather's particles: ambient and sun, brighter toward the sun.
- **Drawing.** One instanced mesh in the pipeline's overlay, invisible without a wash or on green ground; a first frame with one empty sprite compiles its material before it is needed.
- **Preview.** `WASH=14,4 WASH_AT=14` over seed 1983's alpine meadow: a soft gray veil of grit rolling out over the flattened grass (`docs/reports/screens/ground-g5-grit-alpine.png`). On dry grass by the beach target the first tuning made a near-uniform brownout; dust's opacity fell from 0.32 to 0.2 (snow's from 0.36 to 0.24), the count follows the strength one to one, and the noise eats more of each sprite's edge, so the cloud reads as wisps with gaps (`ground-g5-dust-beach.png` shows the first tuning).

`docs/visual-style.md` (*Helicopters*, downwash) changes with this decision.

**Not done:** the ring of ruffled water under the rotor (the water shader); leaves on green ground; wheels, vehicles and impacts through the same emitter; a check in Free Flight in the browser.

**Reason:** The owner asked for wispy, soft dust; sprites whose motion is a formula of their age cost no CPU per sprite and need no buffers, and reading the ground once per frame puts the right material under the rotor.

### 183. Crop furrows and sand ripples in the micro-facets; the dots in fields

**Date:** 2026-11-16
**Decision:** The rest of G1's land-cover table (decision 168), and the cause of the dotted fields the owner saw in the browser.

- **Furrows.** On fields, ridged rows along each field's own heading: two faces per row, so each catches the light on one side. The land shader's field lookup now returns the field's crop (0 wheat, 1 fallow, 2 green crop, 3 pasture) and a second bit of its hash for the heading, one of eight integer directions on the micro-facets' plane; rows along an integer direction with a whole number of rows per wave period repeat with it, so they continue across meshes. Spacing and ridge slope by crop: wheat 0.8 m and 0.16, plowed fallow 1.1 m and 0.28, green crop 0.7 m and 0.2, pasture none. The first slopes (0.4–0.6) drew a barcode of black and pale stripes. The lumps of the other octaves step back by 60% in fields and on dunes. Faded by pixels per row as the octaves (4 to 9).
- **Sand ripples.** Where the ground is dry (decision 126's aridity, from 0.35) and not rock: asymmetric ripples 0.9 m apart, a windward face of slope 0.18 over three quarters of each and a steep lee face, along one prevailing heading per world (from its seed). Their crests snake: the phase shifts by two waves along the crests (9 and 3.7 m), at integer frequencies along the integer perpendicular, so they too repeat with the period. Straight crests read as plowing.
- **Dots in fields.** Fields showed single pixels of the neighboring field's crop, scattered in bands near field boundaries and, from height, all over farmland: the dotted and moiré-like texture of the owner's screenshots. Each face takes its field at its center, and that center's direction was `up` extrapolated to it with screen-space derivatives: across a pixel `up` changes by about 1e-8, under float32's resolution, so the extrapolation carried noise of the order of 20 m at the planet's radius, and pixels within that of a boundary picked either field. The face's center now comes from the camera-relative position (precise near the camera) plus the eye, the same for every pixel (`LandInputs.fieldPoint`). With per-face shading off, or fields off, the dots were already gone; with the fix they are gone with both on (`docs/reports/screens/ground-field-dots-fix.png`, before and after).
- **Previews.** `TARGET=farmland VIEWS=hover`: furrows in two fields at their own headings (`ground-g1-furrows.png`); `SPOTS=buttes OBS_HEIGHT=5 OBS_PITCH=-15`: ripples below a butte (`ground-g1-ripples.png`).

`docs/plans/ground-detail.md` changes with this decision.

**Reason:** Fields and dunes are the largest areas a low pilot crosses, and rows give them direction and scale; the dots were the most visible defect in the owner's look at the ground.

### 184. The alignment stage: every road and railway aligned once when the world is built, behind a progress panel, and stored with it

**Date:** 2026-11-16
**Decision:** The owner preferred a build step with a progress bar to lazy alignment near the camera (decision 181). The network tier is aligned once, after the global pass, and the result is stored with the world in IndexedDB. This supersedes 181's choice of where alignment runs; its router stands.

- **Tasks** (`networks/tasks.ts`). One task per polyline of the graph's roads and railway lines and the spur roads: 2,528 roads, 62 railway lines and the spurs on seed 1983, about 72,000 km. Anchors are the polyline's ends (settlements and junctions, which every link meeting there shares) and the first coarse-cell center after each 12 km. Classes: railways are mainlines that fall back to the mountain railway; motorways fall back to trunk roads, then mountain roads; trunk and secondary roads to mountain roads; spurs to mountain roads, then tracks. Tasks are ordered along a Hilbert curve per cube face, so consecutive tasks share tiles.
- **Links assembled whole** (`networks/link.ts`). Each piece between two anchors is routed in its own gnomonic plane and simplified (`routePiece`). The pieces' corners then join into one line: every corner, anchors included, is rounded in a frame at the corner (`roundCorner`, shared with `fitPlan`), and one profile and one set of earthworks run along the link, with the grade bound and structure thresholds of each point's class. Anchors therefore leave no kink and no level step. The ends are pinned to the ground at the link's ends.
- **Router changes.** Weighted A* (heuristic × 1.5) and coarser lattices: 80 m for mainlines and motorways, 60 m for mountain railways and trunk roads, 40 m for secondary roads, 25 m for mountain roads and tracks (the ground is 96 m samples; the plan rounds what the lattice leaves angular). Within 250 m of an anchor any ground may be cut or filled, because anchors sit wherever the network put them, on a summit or a gorge side. Where no class finds a route, the last is searched again over ground of any steepness at 1,000 per meter on top (a *forced* piece), with the viaduct and tunnel thresholds of a trunk road, so a canyon gets a viaduct rather than a bank as tall as it is deep. On the first 20 links of seed 1983 these took the aligner from 87 to 17 ms per km on this machine's core; forced pieces fell from 8 unrouted to 3 forced.
- **The stage** (`networks/build.ts`). Level-6 tiles under each task's search band are synthesized by the terrain's own synthesizer on the GPU, eight per call, kept in a cache of 192 tiles (272 KB each) and copied to a worker with the task. A pool of workers (`workers/alignmentPool.ts`: one per core but one, at most eight) aligns the links, two tasks in flight per worker. Results are packed in task order, so the record does not depend on which worker finished first.
- **The record** (`networks/alignments.ts`). Links are thinned to points where the line leaves a chord by more than 1 m across or 0.25 m in elevation, with segments of at most 500 m and every change of structure or class kept. They are stored as float32 offsets from a float64 origin per link, with design and ground elevation, structure and class per point: under a megabyte per 2,000 km.
- **In the app** (`main.ts`). A build of a new world runs coarse pass, global pass, then the alignment stage, with the progress panel (`ui/buildProgress.ts`) at the bottom of the screen; a world from the cache loads its alignments, and one cached before this decision is aligned on load and stored again. `?align=0` skips the stage. The corridors of every routed stretch on the ground go into the app's `TerrainEdits` with the airfield pads (rule 13); roads are drawn along their alignments and not on viaducts or in tunnels; railways appear in the simulation view for the first time, along their alignments, as 4 m concrete strips until N6 shades ballast and rails. Without alignments the coarse roads are drawn as before.
- **Tools.** `tools/alignment.preview.ts` runs the same stage inline (`NEAR=lat,lon,km`, `LIMIT`, `ALIGN_TUNING`, `SAVE`), and `tools/render.preview.ts` takes the saved record (`ALIGNMENTS=path`); `TARGETS=1` prints the preview targets' coordinates. The browser smoke test passes `align=0` in software modes unless `ALIGN=1`, because level-6 tiles take about a second each on lavapipe.

- **Numbers** (seed 1983, `tools/alignment.preview.ts LIMIT=40`, one core of this cloud machine, tiles on lavapipe): the first 40 links in curve order, 1,551 km, aligned in 26 s with 107 tiles (12.5 ms per km aligning); 9 pieces by a fallback class, 4 forced, none unrouted; 20.8 km of viaduct and 9.2 km of tunnel, mostly on forced pieces and trunk roads; 18,790 points (0.4 MiB). At that rate the whole network is about 15 minutes of one core: two to four minutes on a desktop's pool, plus the tiles on its GPU. A whole-world run on a desktop is a TODO.
- **Preview.** A canyon rim at −21.37°, 56.79° from 700 m (`VIEWS=tower OBS_LAT=-21.3745 OBS_LON=56.79 OBS_HEIGHT=700 OBS_PITCH=-40`, `ALIGNMENTS` from `LIMIT=40 SAVE=…`). Before, the coarse road ran straight over the rim and down the cliff (`docs/reports/screens/networks-n5-canyon-before.png`). After, it crosses the plateau to the rim and descends the wall in a zigzag of cut shelves, with gaps where viaducts carry it (`networks-n5-canyon-after.png`).

**Not done:** anchors at strategic bridges and river crossings in the router (N5); railway spirals; matching alignment structures to network bridges; the shading of N6 (shoulders, markings, ballast, rails, bank faces); the map still draws the network tier's roads; Free Flight's start screen does not yet show the build's progress.

**Reason:** Aligning once gives the same roads everywhere from the first frame (map, terrain, briefings and bridge matching can all read one record), with no pop-in and no edits changing under a visible mesh. The owner accepted the wait of a build step, and a worker pool and a stored record bring it to minutes, once per world.

### 185. Ground cover follows the land: talus below cliffs, reeds on banks, tufts on field verges

**Date:** 2026-11-16
**Decision:** G3's placement learns three things about a cell's surroundings (decision 174), all on the CPU in `placeCoverChunk`, so the sim's `coverInCell` sees the same sites once it asks.

- **Talus.** Each chunk now also samples the mesh's vertices two quads (about 48 m) round it and keeps each quad's steepness and mean height. A cell that is not itself steep (under 0.6) takes `talus` from the steepest quad within two quads that stands at least 2 m above it, fading with distance: boulders of every size and stones (`TALUS`: small 0.14, medium 0.08, large 0.035, pebbles 0.12 per slot), sandstone slabs on arid ground. Rock faces themselves keep the scree mix.
- **Banks.** A cell within 1.5–10 m of a river's water (the river index's stretches, as the woods along rivers) or up to 3 m above a lake's level takes `bank`: reeds at the edge where the annual mean is above freezing (0.4 per slot) and lush tufts.
- **Verges.** In fields, a cell within 1.5–5 m of its field's boundary (`fieldAt`, the hedgerows' fields, decision 162) takes `verge`: it keeps its tufts and gathers more tufts and flowers, so field edges are lines of grass between bare crops.
- **Tests.** Talus turns a meadow mostly to rock with large boulders; a bank grows reeds (none in the cold); verges hold more than five times a field's items; every mix stays under one per slot.
- **Previews.** Over the butte's desert from 20 m (`docs/reports/screens/ground-g3-desert-stones.png`): stones, small boulders and sandstone slabs on sand with ripples. The previews' views did not catch the talus (the butte's foot lies beyond the boulders' 800 m range from the spot), the reeds (the gallery view's bank is behind its trees) or a verge clearly; they are covered by the tests, and the browser check should look for them.

**Not done:** a preview view at a cliff's foot and on a river bank; hedges' own verges along roads.

**Reason:** Where things lie tells the eye how the land works: rocks under cliffs, reeds by water, grass along field edges. All three come from data placement already had.

### 186. A build screen for the world; the alignment stage's tile cache pinned; stations at switchbacks

**Date:** 2026-11-16
**Decision:** After the owner's first run of the alignment stage (decision 184) on a laptop: `Alignment: 2651 links, 86818 km in 126.3 s on 8 workers (6353 tiles), 177 pieces by a fallback class, 129 forced, 0 unrouted, viaducts 1918.2 km, tunnels 1401.2 km, 19.1 MiB; 1022551 height lookups off the tiles`, and about five minutes for the whole build.

- **Build screen** (`ui/buildScreen.ts`, replacing decision 184's panel). The owner asked for a generation screen with messages and progress bars rather than drawing the world and taking input while it is built. A full-screen panel lists the build's phases (planet and campaign; terrain detail, erosion and rivers; roads and railways), each with its bar, its state and, when finished, its time and a summary (land share, settlements, roads, railways; rivers; links, kilometers, workers, viaducts and tunnels), over a log of the last twelve messages with the time since the build began. A stored world shows two phases (the stored world, and its alignments or the stage if it has none). The app's frame loop returns at once while the screen is up: nothing is drawn or simulated behind it, and the screen takes the pointer. lil-gui stays above it, so Cancel is in reach; cancelling, an error and a finished build hide it. It covers Free Flight's start screen while Free Flight's world is built. The alignment phase logs one line and counts links under its bar (`docs/reports/screens/build-screen.png`, the screen alone in Chromium).
- **The tile cache race.** The million lookups were tiles evicted from the stage's cache while a lane waited: a lane found some of its tiles cached and queued the rest, and while it waited, other lanes (sixteen on eight workers) evicted the cached ones, so its task went to the worker without them and read 0 m there. The inline preview runs two lanes and rarely hit it (104 lookups in one of four slices of 40 links). Tiles a lane waits for or is about to hand out are now pinned against eviction, a tile another lane has queued is not queued twice, and a tile that is still missing is an error. A test with forty tasks over shared tiles, a cache of two, eight lanes and a slow synthesizer failed before the change and passes after. The viaduct and tunnel totals above include fills and cuts against 0 m; the owner's next run gives the real ones.
- **Finding the roads.** `roadStations` adds observer stations at the eight most winding stretches of the aligned network (the 2 km with the most stored points, mountain classes counting double, at least 30 km apart), 700 m to the side and 350 m up, looking at them: GUI → Simulation camera → Observer at "Roads · switchbacks n (lat, lon)".

`docs/design.md` (track N, N5) changes with this decision.

**Reason:** A build that takes minutes once per world is better shown as a build than hidden behind a world that is still changing; the race made the stage's output depend on timing, which the stored record must not; and the network's best mountain roads are a few kilometers in a planet's worth of land.

### 187. Ground cover: none on snow or steep faces; furrows and ripples off for now

**Date:** 2026-11-16
**Decision:** The owner's review of the ground cover and micro-facets in the browser (decisions 174, 183, 185).

- **Snow.** Boulders and stones on snowfields did not look right. Stones now sink under lying snow as plants do (scaled to nothing as the surface temperature falls from −1 to −4 °C, the ground's own threshold); while they sink, their tops whiten as before.
- **Steep faces.** Boulders on the steep sides of rocks, buttes and hills did not look as if they would stay. Every kind's probability now falls to nothing between slopes of 0.58 and 0.72 (about 30° to 36°); scree takes rock from 0.35 to 0.55, and talus piles below cliffs (decision 185) are unchanged, since they lie on the gentler ground at a cliff's foot.
- **Furrows and ripples off.** Both read too strong in the browser. `MicroFacets.furrows` and `.ripples` (default 0) switch them; the lumps of the other octaves are only calmed in fields and on dunes while they are on. The previews take `FURROWS=1` and `RIPPLES=1`. The field-dots fix of decision 183 stays.
- **Kept:** reeds on banks and the talus piles, which the owner liked.

`docs/plans/ground-detail.md` changes with this decision.

**Reason:** The owner's review.

### 188. The rotor's ring on water

**Date:** 2026-11-16
**Decision:** Over lakes, rivers and the sea, the downwash (decision 176) draws in the water shader what the flattened grass shows on land: a pilot's cue for height and drift where there is no ground cover.

- **Ripples.** Two trains of short ripples (1.2 m and 0.52 m) run outward from where the wash meets the water, at 1.5 m/s plus a quarter of the outwash speed, added to the waves' slope like any wave: lit, mirrored and glinting as the sea is, and handed over to the roughness where they are too fine to resolve, so a far ring reads as a dull, rough disc. Their strength follows the grass's reach: rising over 0.4 rotor radii, falling as 1.6R/r, gone between five and eight radii, scaled by the outwash (full at 10 m/s, up to 1.5 times).
- **Churn.** A faint, broken white ring between about one and two radii joins the surf's foam (not on rivers' widened ribbons).
- **Where.** `WaterShading.setDownwash` takes the wash's center camera-relative each frame from `GlobeScene` (the same record as the grass and the dust); frozen lakes show their ice, unchanged.
- **Preview.** `TARGET=ocean VIEWS=hover WASH=14,4 WASH_AT=14`: concentric ripples on the open sea behind the spray (`docs/reports/screens/ground-g5-water-ring.png`). The deepest-lake target was frozen at the preview's date.

`docs/visual-style.md` (*Helicopters*, downwash) already asks for the ring.

**Reason:** Over water the ring is the only near cue a hovering pilot has; the waves' own machinery gives it the water's light for free.

### 189. Displays, status strip, master modes and AI crew (proposal 0006 accepted)

**Date:** 2026-11-16
**Decision:** The owner accepts proposal 0006. Bearing stays third-person with a HUD overlay; cockpit functions that need not be heads-up move into docked multifunction displays and a status strip, master modes reconfigure both with the HUD, a cursor mode frees the mouse for the displays, and crewed aircraft get an AI crewmate the player commands. The proposal replaces proposal 0002's *Displays* and *Layout and Style*. The plan is `docs/plans/displays.md`; nothing is implemented yet.

- **Allocation rule.** Every item lives in exactly one place: the HUD (spatial and time-critical information used while looking outside), a display (sensor pictures, selection, configuration, planning) or the status strip (discrete states and warnings).
- **Standardization.** Five docked slots with fixed positions and bindings for every aircraft (left and right MFD, threat, messages, status strip); one layout and button set per format wherever it exists; the avionics profile decides which slots and formats an aircraft has; faction skins change colors, fonts, labels and units, never layout.
- **Slots** are expanded, collapsed to a tab or hidden; they never move, pins beat automation, alerts may claim a slot in place, and transitions take about 300 ms and never cross the central 60% of the screen.
- **Master modes:** ground, navigation, air-to-air, dogfight, air-to-ground, approach and hover, with the proposal's triggers and presets, selectable by key, and preset edits that apply to every aircraft.
- **Status strip** on the dark cockpit principle: items only when relevant, warnings on conflicts, green, amber and red with a label and a shape each, clickable and bound to keys, and a master caution; helicopters end it with torque and rotor gauges.
- **Display frame and formats:** one square frame with bezel buttons; the formats of the proposal's table at their update rates; the moving map in a strategic mode (the strategic view's illustrated rendering, a deliberate full-color anachronism in both factions) and an elevation mode with a relative sub-mode; formats exist only where the aircraft carries the system; datalink tracks on the map and the radar; the Su-27 analogue's HUD-integrated radar.
- **Cursor mode:** hold Left Alt (or toggle) to use the displays while the flight director holds the aim point or attitude and altitude; every display action also has a key.
- **AI crew:** six roles (radar intercept officer, weapon systems officer, bombardier/navigator, copilot/gunner, crew chief, loadmaster), format ownership shown on the bezel, a radial crew command menu, prioritized callouts in the messages slot, skill from the squadron's experience and morale. Crew station mode works through ownership.
- **Serializable display models:** every format is a pure function from the sensor-filtered snapshot and the display state to a display description, with no rendering code (`src/ui/displays/`), so companion displays (P6) and tests use the same models, and input from anywhere returns as the same commands. Chrome in HTML and CSS, scopes in Canvas 2D, map, pod and hook camera from render targets; all displays under 2 ms of CPU per frame.
- **Roadmap:** P2 becomes HUD, displays and status strip; P3 sensors and formats; P5 adds ownership, the command menu, the six roles, callouts and the targeting pod and hook camera formats; a new P6 holds companion displays. The torque and rotor gauges and the hook camera replace proposal 0004's dedicated displays; the hover symbology stays on the HUD.

How the plan reads the proposal, for the owner to confirm (the plan's *How the plan reads the proposal* gives the reasons):

1. Torque and rotor RPM leave the HUD for the strip's gauges; the rest of the hover symbology stays.
2. Warnings that demand an immediate maneuver (PULL UP, STALL, tail strike, the sink cue, the helicopter hazard cues) stay on the HUD; system cautions, warnings and the master caution go to the strip.
3. The throttle readout stays on the HUD; the afterburner moves to the strip.
4. Fuel moves to the engines and fuel format, which P2 builds early for Free Flight; JOKER, BINGO and LOW FUEL go to the strip.
5. Avionics state (what changes what the aircraft does, senses, emits or releases) lives in `sim/avionics/` and changes only by avionics commands; display state lives in `ui/displays/`. Crewmates (`sim/crew/`) and AI pilots issue the same commands and never touch the UI.
6. Cursor mode is a software cursor under pointer lock, since browsers re-grant pointer lock only within a user gesture and a key release is none.
7. Key chords are fixed after a spike: Shift and Ctrl are the throttle, Left Alt is cursor mode, and browsers reserve some digit chords.
8. The moving map draws from 10 to 160 nm, below the strategic zoom floor, with the region band magnified and no trees or buildings (rule 11); elevation mode reads the resident terrain tiles, which already pass through the one height function (rule 13).
9. Map overlays of the war (front, threat rings, contacts) come from the side's picture and the aircraft's sensors, never ground truth (rule 12).
10. P2 starts in Free Flight before P1 closes, as H1 did (decision 151).
11. The hook camera is built by whichever of H3 and P5 comes first, on P2's frame; the gunner sight is the targeting pod format slaved to a turret, so H5's gunner mode builds on P5's.
12. All seven master modes exist in P2 by key; air-to-air, dogfight and air-to-ground fill in with P3 and P4, and their automatic triggers wait for weapons.
13. Proposal 0002's minimal mode becomes the hidden slot state and HUD declutter levels; the clean-mode question stays open.
14. A player's preset edits are saved per viewer in browser storage, with the defaults as fallback.

The proposal's three open questions (voice, single-seat help, spectating) stay open in `docs/design.md`, with the plan's recommendations: text first; a light assistant as avionics assists, each a toggle; read-only displays of the followed aircraft's picture.

`docs/design.md` (*Vision*, *Decisions So Far*, *Factions and Sides*, *Flying*, *Rendering*, *Milestones*, *Open Questions*, *Later*), Part I (*Principles* preamble, *HUD and Displays*, the new *Displays and Status Strip*, *Acceptance Checks*), proposals 0002 and 0004, `CLAUDE.md` and `TODO.md` change with this decision.

**Reason:** Without cockpits, everything a cockpit shows competed for the HUD, and Free Flight's HUD already carried states, fuel and messages beside its flight symbology. One rule for where each item goes, fixed slots that never move, and formats that look the same in every aircraft let a player switch types without relearning the screen, while the avionics profile keeps each type's character. Display models that are plain data keep the crewmate, the tests and later companion screens on the same footing as the player, and keep the displays honest to the sensor picture.
### 190. Roads wander and cross rivers on bridges: ground costs, a seeded wander, rivers in the router, crossing records matched to the network's bridges

**Date:** 2026-11-16
**Decision:** The owner found the aligned roads natural and the switchbacks good, but saw long straight stretches and roads crossing rivers with no bridge. The router now knows the ground and the rendered rivers, roads that wind wander, and every crossing is a bridge record.

- **Ground costs** (`router.ts`, `link.ts`). Each lattice node has a cost per meter, at least 1, and a move pays the mean of its ends: 1 + 0.25 × forest density + a seeded field (`groundField`, `rng(seed, "alignment").fork("ground")`, 0–0.3 over about 2.5 km) for soil and field patterns; open water (a tile's lake bit or the sea's biomes) and river channels cost 61. The tiles now carry a cover byte per sample beside their heights (`groundCover`: water, forest density), from the synthesizer's materials.
- **Wander** (`WANDER_TUNING`). The ground field alone did not bend roads: the lattice's 16 directions and the plan's simplification make straights of any gentle drift, and weighted A* (heuristic × 1.5) ignores cost differences of a few tens of percent. Trunk roads, secondary roads and tracks are displaced sideways by a seeded 1D noise along each link, `rng(seed, "alignment").fork("wander/<network>/<line>")`: secondary roads 35 m at 900 m and 250 m at 6 km, trunk roads 14 m at 1.6 km and 120 m at 7 km, tracks 25 m at 450 m and 40 m at 1.5 km, mountain roads 8 m at 500 m; motorways and railways none. Every amplitude curves at under a tenth of its class's minimum radius. The wander fades over 400 m at a link's ends (junctions stay put), within 450 m of a river crossing (bridges stay square), on side slopes over 8% (a switchback's shelf stays where the slope put it) and where it would reach open water, and the fade is smoothed over 250 m. The profile and earthworks follow the displaced line. On 40 lowland links of seed 1983 the share of road on straights over 2 km fell from 59% to 33%; on the first 120 links, mostly hills and mountains, from 17% to 2%.
- **Rivers in the router** (`riverCrossings.ts`). The stage sends each task the rendered rivers' segments under its tiles (`taskRivers`, from the river index); each piece projects them into its plane and buckets them (250 m). A move that crosses a river pays a bridge: 400 + 30 per meter of span, the span being the width over the crossing angle's sine (at most four widths) plus 10 m of abutments either side, so roads seek square crossings of narrow reaches. A test river 40 m wide, crossed 31° off square by the straight line, is bridged at |sin| over 0.9.
- **Bridge records.** The crossings a link's pieces make are found again on its final plan (the plan within 800 m, against that river segment and its neighbors) and stored per link, then in the record (`Alignments.crossings`, `crossingLink`): arc length, point, river segment, width, span, deck elevation and angle. The deck clears the water surface by 2.5–6 m by class (rail 6, motorway 5.5, trunk 5, secondary 4.5, mountain road 3.5, track 2.5), or the banks by 1 m, whichever is higher; the approaches climb to it within the class's grade (an embankment, or a viaduct where the fill passes the threshold). The points over the span carry the structure `Bridge`: no corridor edit, so the protected channel and the ground under the bridge are untouched (rule 13). Until the bridge kit (N7) the road is still painted across.
- **Matching the network's bridges** (`matchBridges`). Each network bridge (roads, railways, spurs) takes the nearest unmatched crossing of the link that aligns its polyline within 25 km; the record keeps the network bridge per crossing, or −1 for one the network does not know (drawn, no target). On the first 120 links of seed 1983: 34 crossings (widths 9–121 m, median 25 m; spans median 54 m, at most 143 m), 8 of the 18 network bridges on those links matched (6 within 8 km), 26 crossings unknown to the network. **The unmatched network bridges are a data mismatch, not a matching problem:** they sit on coarse-pass rivers with no rendered river nearby (rendered rivers 4–73 km away), and five of their links cross no rendered river at all. The network tier's rivers come from the coarse pass, and the rendered rivers from the eroded world; decision 65 expected a few kilometers between them. Either the network's bridges come from the rendered rivers (the graph is built before the global pass), or bridges over rivers the rendered world lacks stand over a valley as viaducts or are dropped from the targets: an owner decision before N7.
- **Smaller fixes.** A tile can cut a corner into a search band between two of `taskTiles`' samples 2 km apart: the band's border is now walked every 150 m (93 lookups off the tiles in 120 links before, none after). The stored record has a version (`ALIGNMENT_VERSION` = 2); a world cached with an older record is aligned anew on load.
- **Cost.** The ground's costs and the rivers raise the aligner's time by about a third (13 to 17 ms per km on this machine's core).

`docs/visual-style.md` (Part I, roads) and `docs/plans/terrain-networks.md` (router) change with this decision.

**Not done:** the bridge kit (N7); crossing-site discounts on the rendered rivers; railways in mountains still put too much on viaducts and tunnels (one 336 km mainline: about 250 km, the spiral template is a TODO); the owner's decision on network bridges without a rendered river.

**Reason:** Roads in lowland bend for reasons the router cannot see (fields, property, old tracks); a seeded wander within each class's geometry stands in for them, while the costs that can be computed (forest, water, rivers) shape the route itself. A bridge must be where a rendered river is, and the record says where, how long and how high before the kit draws it.

### 191. Rotor dust only when slow and much cheaper; trees sway in the wash

**Date:** 2026-11-16
**Decision:** The owner found a helicopter flying slowly over a road slowing the frame rate badly, and asked that dust be raised only at low speed; and the trees near a hovering rotor now move (decisions 176, 182).

- **Why it slowed.** Over green ground the wash raises nothing, but roads and runways are pavement, which raises grit: up to 700 soft, overlapping transparent sprites several meters across in front of the camera, so the overlay's fill rate, not the CPU, took the frame. The emitter also read the ground under the wash (a river-index query and the clearings) every frame.
- **Slow only.** `rotorDownwash` now reports the helicopter's speed over the ground; dust, grit, snow and spray are raised in full below 30 kt and not at all above 50 kt.
- **Cheaper.** At most 240 sprites (700 before), each a little more opaque (dust 0.32, grit 0.34, snow 0.36, spray 0.38) so the cloud keeps its body; no sprite wider than 0.3 of its distance from the lens; sprites fade in from 3 to 10 m of the lens (0.8 to 3 before), where they filled the screen. The ground under the wash is read again only when the wash has moved 3 m. The alpine meadow's grit veil at seed 1983 is fainter and wispier than before.
- **Trees in the wash.** The forest's vertex shader leans each tree away from where the wash meets the ground and buffets it at its own phase: the tip moves by up to 8% of the tree's height (0.6% per m/s of outwash), the root stays put (the square of the height fraction), over the grass's reach (rising over half a rotor radius, as 1.6R/r beyond, gone between five and eight radii). The buffeting runs on the scene's effect clock. The previews' views do not put a wash near trees; the browser check should.

The Kestrel has no downwash and is unaffected.

**Not done:** a preview view of a hover beside a tree line; the frame time over pavement measured in the browser.

**Reason:** The owner's report and request; dust a pilot sees only in a hover or a slow approach, where it matters, costs nothing in transit.

### 192. The bridge kit, first parts: beam, truss and viaduct structures assembled per record, merged per structure

**Date:** 2026-11-16
**Decision:** Every river crossing of the alignment tier (decision 190) and every stretch of viaduct is drawn as a structure built from kit parts, and roads are no longer painted across the water.

- **Kit specs** (`render/common/models/specs/bridge-*.json`, class `building`): a deck meter (concrete slab, asphalt top, dark girder underneath, so the deck reads from above and in silhouette), a parapet, a wall pier, a column pier, an abutment, a 10 m truss panel of one side (chords, post and diagonal in steel) and a top brace. A new model color `asphalt` (#55565A) tops the deck.
- **Records** (`render/sim/infra/bridgeRecords.ts`). A crossing's structure is the run of `Bridge` points nearest it, and each run of `Viaduct` points is one, cut into pieces of at most 1.2 km; each run takes its neighbors on the ground at both ends, so the deck meets the formation. A bridge matched to a network bridge takes its kind (truss and suspension as truss, viaduct as viaduct, beam and arch as beam); an unmatched one is a truss on a railway over 45 m, else a beam. Deck width is the formation's (secondary road 9 m, motorway 30 m, railway 8 m).
- **Assembly** (`bridgeKit.ts`, pure). Deck segments of at most 20 m follow the record's design elevations and grade, with parapets (none on railways); a beam bridge rests on wall piers at most 35 m apart, a truss spans up to 90 m with panels on both sides and braces over the top, a viaduct stands on column piers every 40 m (two side by side on decks over 10 m wide); abutments close both ends. Piers reach from 4 m below the lowest ground under a bridge (the record's ground is 96 m terrain; carved beds lie deeper) to the girder. Parts are scaled along their own axes only, so normals stay exact.
- **Drawing** (`BridgeLayer`, in `GlobeScene` beside the buildings). Every structure is unique in length, height and grade, so its parts are merged into one mesh per structure, in the planet frame about its first deck point, placed camera-relative; structures within 12 km are built (four per frame at most) and dropped some seconds after leaving the range. Lit like the buildings (diffuse light and aerial perspective); hidden above 15 km and while the terrain is exaggerated, since structures keep true heights. A 100 m beam bridge is about 400 triangles, within Part I's 300–1,500.
- **Roads** are painted on the ground only where the record carries them on it: bridges and viaducts carry them on their decks.
- **Preview.** The longest crossing of seed 1983's first 120 links (a 121 m river, a 143 m beam bridge at −18.4747°, 48.4952°) from 350 m downstream and 40 m up (`VIEWS=tower OBS_LAT=-18.4947 OBS_LON=48.4952 OBS_HEIGHT=40 OBS_PITCH=-4`, `ALIGNMENTS` from `tools/alignment.preview.ts LIMIT=120 SAVE=…`): the deck crosses the river on four wall piers, its dark girder reading against the water (`docs/reports/screens/networks-n7-beam-bridge.png`). On this 1,000 km planet 0.001° is 17 m: frame observers accordingly.

`docs/visual-style.md` (Part I, Bridge kit: merged per structure, not instanced) changes with this decision.

**Not done:** arch ribs, viaduct arches and suspension towers (arch and suspension bridges are drawn as beam and truss bridges until then); tunnel portals; ink outlines on bridges; the model viewer's silhouette check (check 6) for the kit; the `bridge` acceptance view at 300 m.

**Reason:** Bridges are where the alignment says rivers are crossed, at the span and height the record gives, so the kit draws them from the record rather than from the network tier; merging per structure keeps one draw call per bridge, and the few dozen within range cost far less than the buildings.

### 193. Owner's answers on proposal 0006; one capture key for every aircraft; keys only for hot display actions

**Date:** 2026-11-16
**Decision:** The owner answered decision 189's readings, and P2's first step (the input spike) is done with their two changes.

- **Confirmed:** torque and rotor RPM leave the HUD for the strip's gauges (reading 1); warnings that demand an immediate maneuver stay on the HUD (reading 2); fuel leaves the HUD (reading 4); avionics state in the simulation, display state in the UI (reading 5). Readings 3 and 8–14 and the three open questions were not addressed; they stand as the plan's working assumptions until the owner says otherwise.
- **One capture key instead of a software cursor** (replaces reading 6). Tab grabs and frees the mouse's pointer lock in the jet and the helicopters alike; a click on the view also grabs it, and Escape frees it and pauses, as before. A free mouse is cursor mode: the OS cursor clicks the displays (once they exist), and the flight director holds what the mouse last commanded. One `MouseCapture` (`ui/flight/mouseCapture.ts`) owns the lock for both inputs; `mouseCapture: ['Tab']` is in `FLIGHT_BINDINGS` and `HELO_BINDINGS`, and a test keeps it bound to nothing else in either table.
- **The jet flies under pointer lock too.** Mouse stick and mouse aim read a cursor moved by the mouse's relative motion (half the view's width or height is full travel, as the free cursor was) and hold while the mouse is free. M or N centers it and captures the mouse; the HUD draws the mouse stick's position as a cross and adds "TAB TO FLY" to the mode while a mouse mode has no mouse (the helicopter's tag, "CLICK TO FLY", reads "TAB TO FLY" too). P1's world-locked aim point is unchanged as a task.
- **Keys only for hot actions** (replaces reading 7 and the rule that every display action has a key). Bezel buttons and strip items work by mouse in cursor mode, and later by touch on a companion (P6); there is no modifier-plus-digit scheme for the 20 buttons. Single keys go to the actions a pilot needs without looking: master modes and the dogfight override, expanding and collapsing each slot, the master caution, map range, radar lock, step and break, designation, countermeasures, weapon selection, and the crew menu (digits only while it is open). Each format lists its hot actions; the bindings test enumerates those.

**Spike results** (Chromium, headless and new headless, Playwright's trusted input; `tools/freeflight.session.mjs` now drives the real `FreeFlight` through it):

- A key press alone grabs the lock; no click is needed. A key release does not count as a gesture: grabbing on release worked after a 1.5 s hold and failed after 6 s ("a user gesture is required"), because a press's activation lapses after about 5 s. So capture toggles on a press; a hold-to-free mode would strand the mouse after long holds.
- Chromium refuses requests that come too fast ("too many pointer lock requests in a short window"): 6 of 20 toggles 120 ms apart. A refused grab is retried after 0.4, 0.8, 1.2 and 1.6 s while it is still wanted, inside the press's activation; in the probe every burst ended captured. After the last retry the HUD says to click the view.
- A lock dropped by the browser itself (Escape, lost focus) pauses Free Flight; an Escape key event that arrives within 0.3 s of that pause is taken as the one that freed the mouse and does not resume. Headless Chromium does not release the lock on a synthetic Escape, so the session tool drops the lock with `exitPointerLock()` outside `MouseCapture` instead.
- Left Alt, the proposal's default, was not chosen: on Windows a lone Alt press opens Firefox's menu bar, Linux desktops use Alt to drag windows, and Alt+Tab switches windows. Firefox and Safari were not run here.

`docs/plans/displays.md`, `docs/design.md` (*Flying*), `CLAUDE.md` (rule 14) and `TODO.md` change with this decision.

**Reason:** The owner wants one way to take and give back the mouse in every aircraft, and found keyboard control of twenty bezel buttons impractical. A real cursor clicks HTML displays with no hit-testing of our own, and the browser's activation rules favor a toggle on a key press. Keys stay where they pay: actions done many times a minute, eyes outside.

### 194. The ground cover's clearing test gathered per chunk; no micro-facets under pavement

**Date:** 2026-11-17
**Decision:** The owner found the Kestrel's frame rate very low on the ground, better once airborne (after decision 191 fixed the helicopter's dust).

- **Cause, on the CPU.** The ground cover's placement (decision 174) asks for each of a chunk's thousand cells, and for each item near one, whether it lies in a clearing (`InfraScene.isClear`). Clearings are indexed by level-7 tile, about 12 km, so each call looped over every road, runway and taxiway segment in it, and one placement slice of four rows could run far past its 3 ms budget near an airbase or along roads: where a jet sits and rolls, and where new chunks keep coming into range until it climbs above the cover's range.
- **Fix.** `InfraScene.clearTester(center, reach)` gathers the clearings within `reach` of a point once and tests against those alone; the placement asks it for each chunk (`CoverContext.clearNear`), with the chunk's half-diagonal as the reach. A test checks that it answers exactly as `isClear` round an airbase. At the small test world's airbase (seed 7, 64² grid) a chunk's cell tests fell from 1.6 ms to 0.3 ms; the campaign world has many more roads per tile. Placement now yields after every row of cells (was four), so no slice holds a frame for long.
- **On the GPU.** With the camera a few meters over a runway most of the screen is ground within the micro-facets' range (decision 171), and they were evaluated under pavement, which draws over them. Fully paved fragments now skip them (the road coverage moved ahead of them in the terrain shader).

The forest's placement asks `isClear` per tree the same way (decision 148); it has not been changed here.

**Not done:** the frame time on the ground measured in the browser, and with the debug panel's switches, which layer costs what (Tiles → Ground cover, Lighting → Micro-facets, Tiles → Trees).

**Reason:** The owner's report: a parked or rolling jet is where the ground cover's placement works hardest, at an airfield full of clearings.

### 195. The jet's captured mouse flies it; the display slots' layout (P2)

**Date:** 2026-11-17
**Decision:** A fix to decision 193 from the owner's first flight, and P2's slot layout.

- **The bug.** The owner could capture the mouse in the Kestrel but not fly with it. The Kestrel starts in keyboard mode, where a captured mouse moved nothing; only M or N gave it the stick or the aim point, unlike the helicopter, whose captured mouse always flies. The jet also read the motion as `pointermove` on the canvas where the helicopter reads `mousemove` on the document; both carry the motion in Chromium (probed with real X input under Xvfb), and the jet now listens as the helicopter does, so no browser can differ between them.
- **A captured mouse flies the jet.** Tab or a click in keyboard mode switches to the last mouse mode, mouse aim at first, with the cursor at the center; M and N still choose, and going back to the keys frees the mouse. While the mouse is free, the stick or the aim point holds. The start messages say so.
- **The session tool moves a real mouse.** `HEADED=1` (an X server, e.g. Xvfb, and xdotool) runs `tools/freeflight.session.mjs` headed and moves the pointer with xdotool, which delivers relative motion under pointer lock where Playwright's mouse gives none; the page then checks that the aim point and the stick follow the mouse. Headless, those two checks are skipped and the rest run. A headed browser's request for `favicon.ico` is not counted as an error.
- **Slot layout** (`src/ui/displays/layout.ts`): `layout(viewport, uiScale)` gives every slot's rect and collapsed tab from the viewport and the UI scale alone, so a master mode or an aircraft cannot move a slot. Large slots are squares of 28% of the height in the lower corners; the threat slot a square and the messages slot as wide as a large slot, both 60% of a large slot's side high, in the upper corners; the strip bottom center, 4% of the height, at most half the width; the margin 1.5% of the height (at least 8 px). The central column is the middle 60% of the width above the strip; slots never enter it, so on 4:3 and portrait viewports the large slots shrink to the side bands, and the UI scale (0.75–1.5) grows the slots only until they meet it, at about 1.16 on 16:9. Tabs sit on the slot's screen edge at its outer corner, half a large slot wide; the strip has none. At 1920 × 1080 the large slots are 302 px, the threat slot 181 px and the strip 960 × 43 px; at 1280 × 720 the large slots are 201 px.
- **Tests and pictures.** `tests/displayLayout.test.ts` checks 12 viewports from 640 × 360 to 3840 × 2160 and portrait at four scales (inside the screen, whole pixels, no overlaps, nothing in the column, the strip below it, mirrored large slots, tabs on their edges) and pins the rects at 1920 × 1080. `composite.html?…&slots=1` and `SLOTS=1` in `tools/freeflight.screens.mjs` (with `SIZE`, `SCALE`) draw the slots over a HUD composite; `docs/reports/screens/hover-transition-slots-*.png` show them at 1280 × 720, 1366 × 768 and 1920 × 1080. The helicopter HUD fits the column at all three.

`docs/visual-style.md` (*Displays and Status Strip*, Slots), `docs/plans/displays.md`, `CLAUDE.md` (directory map) and `TODO.md` change with this decision.

**Reason:** A capture key is only useful if a captured mouse does something in every aircraft; in the jet it did nothing until a second key. The slots' rects come first in P2 because the frame, the strip and the HUD's retrofit all place themselves against them, and a pure function with pinned values makes "slots never move" a test rather than a convention.

### 196. The mouse's up and down inverted, per aircraft kind

**Date:** 2026-11-17
**Decision:** The owner flew the Kestrel with the captured mouse (decision 195) and found up and down inverted, and asked for a switch between the two regimes.

- **One setting per aircraft kind.** `invertJet` and `invertHelo` in Free Flight's options, so the jet can be inverted without changing the helicopters, whose cyclic convention (mouse forward, nose down) the owner had not questioned. Normal: in the jet, mouse forward raises the aim ring (mouse aim) and pushes the stick forward (mouse stick); in the helicopters it pushes the nose down. Inverted flips the mouse's vertical motion in every mode of that kind: `FlightInput.invertY` for the jet's cursor, the existing `HeloInput.invertPitch` for the helicopters.
- **Where to switch it.** A checkbox, "Invert mouse up and down", on the start screen (for the chosen aircraft) and in the pause menu (for the flown one), each with a line saying what mouse forward does; the key I in flight, in both binding tables, with a HUD message; the URL keeps it (`invert=jet`, `invert=helo` or both), so a reload or a shared link flies the same way. The defaults stay as they were.
- **Checks.** Unit tests for the URL, the inverted cursor and the shared key; the session tool presses I, checks the URL, unticks the pause menu's box, and, headed with a real mouse (decision 195), checks that mouse forward lowers the inverted aim ring.

**Reason:** Whether mouse forward should climb or dive is a matter of habit (an aim cursor against a stick), and players differ; a switch they can flip in flight lets the owner try both. The helicopters and the jet have different conventions, so one switch for both would have broken the one that felt right.

### 197. Micro-facets off by default, a Free Flight option to turn them on

**Date:** 2026-11-17
**Decision:** On the owner's machine the Kestrel parked on a runway ran at 3–4 frames a second with the micro-facets (decisions 171, 178, 183) and recovered without them; the ground cover was fine. The micro-facets are now off by default (`MicroFacets.strength` 0), in the campaign's simulation view as in Free Flight.

- **The option.** Free Flight's start screen and pause menu have "Ground micro-facets (graphics)" beside the wind's switch, off by default, applied at once and on each start; the URL carries `micro=on` when it is on. The debug panel's Lighting → Micro-facets slider still sets the strength directly.
- **Previews.** `tools/render.preview.ts` now draws without them unless `MICRO=1`.
- **Why so costly.** With the camera a few meters over the ground most of the screen is terrain within their range, and every such fragment ran three lattice octaves and their hashes on top of the terrain's own shading; decision 194's skip under pavement did not cover the grass around a runway. They stay available for machines that can afford them; a cheaper form (one octave, a shorter range, or baked per tile) is future work.

`docs/visual-style.md` (*Terrain*, ground detail) and `docs/plans/ground-detail.md` change with this decision.

**Reason:** The owner's report: a frame rate that low makes flying impossible, and the ground cover gives most of the near-ground cue without them.

### 198. Two mouse modes for the jet, a control cursor of its own, and a sticky look

**Date:** 2026-11-17
**Decision:** The owner's review of decisions 195 and 196: mouse aim is fine, but they want a direct mode, the stick held by the cursor's offset from the screen's center and not inverted; the cursor is a game control, not HUD symbology, and should show it; the jet should look around with the right button as the helicopters do.

- **Two jet modes,** chosen on the start screen and in the pause menu ("Mouse: aim / direct"), switched by N in flight and kept in the URL (`control=aim|direct`); mouse aim stays the default. *Direct*: while the mouse is captured, its offset from the screen's center is the stick (full deflection at 0.7 of the half-screen, a 4% dead zone), and a held stick key wins on its axis; freeing the mouse (Tab) centers the stick and the keys fly. *Mouse aim* as before; the keys steer on the wheels. Keyboard-only flying is direct mode with a free mouse. M (mouse as stick, decision 135) is gone.
- **Inversion per mode** (refines decision 196): `invertAim`, `invertStick` and `invertHelo`, the URL's `invert=aim,stick,helo` (the first version's `jet` reads as `aim`, which is what the owner inverted). The menus show the inversion of the mode chosen, and I flips it. Direct's default is a real stick's: mouse forward, stick forward, nose down; the owner's "not inverted".
- **The control cursor** (`ui/flight/controlCursor.ts`) draws in a soft magenta, `#FF8AE2` with a dark halo, apart from the HUD's green. Direct: a faint full-deflection box and dead-zone ring at the center, the line from the center to the cursor, and a cross at the cursor; shown while the mouse is captured. Mouse aim: the ring, projected from its direction in the world; dimmed while the mouse is free (it still holds). `HudFrame.control` replaces `aim`.
- **Sticky free look for the jet.** The right button (or C) looks around and the view stays where it is left; V or a middle click recenters it; the wheel zooms while looking and is the throttle otherwise. `ChaseCamera.stickyLook` (the jet's rig) and `restForward`/`restUp`, the view with the look centered, which mouse aim now reads, so looking around never steers the jet. Pointer capture for the right-button drag is skipped under pointer lock, where browsers refuse it.
- **Checks:** unit tests for the URL, both inversions, the sticky look and its recentering; the session tool switches modes with N, checks that a held key wins, that freeing centers the stick, that RMB and V reach the camera, and, headed with a real mouse, that the direct stick follows it and mouse forward pushes it. `docs/reports/screens/control-direct.png` shows the direct cursor.

`docs/design.md` (*Flying*), Part I (*HUD and Displays*) and `TODO.md` change with this decision.

**Reason:** Direct control is the scheme for players who want to fly the aircraft rather than point it, and with the offset from the center it needs no hardware. The cursor is the player's hand on the controls, not information the aircraft displays, so the allocation rule (decision 189) keeps it out of the HUD's color. A look that stays where it is left serves the jet as it does the helicopter, as long as it never changes where the jet flies.

### 199. P2's display system: avionics state, display models, formats, the status strip, master modes, the HUD's retrofit

**Date:** 2026-11-17
**Decision:** Steps 4–10, 12 and 13 of the displays plan (`docs/plans/displays.md`), in Free Flight; the moving map (step 11) is next and needs the owner's eyes and a GPU.

- **Avionics** (`src/sim/avionics/`): `AvionicsState` (master mode, whether the player chose it, the mode before dogfight, master arm, acknowledged cautions), `AvionicsCommand` and `applyCommand`, pure. `autoMode` applies the proposal's triggers unless the player chose a mode (the ground always wins): ground on the wheels; hover below 20 kt in a helicopter (until 25 kt); approach with the gear down below 3,000 ft (until 3,300 ft); navigation otherwise. Air-to-air and air-to-ground come by command until P4's weapons select them. Free Flight, with no simulation worker, holds the state in its display controller; the campaign will hold it with the aircraft in the simulation.
- **Avionics profiles** (`profiles.ts`) for the Kestrel, the Wren and the Buzzard: skin, systems, the formats each slot may show, rotor gauges, crew. They live in code keyed by model spec until P3's sensor model gives the systems figures, then move into the specs (a deviation from the plan's step 5); `profileProblems` checks that every format's system is carried. The UI's `SlotId` now comes from here.
- **Display models** (`src/ui/displays/model.ts`): `DisplayModel` (20 bezel buttons on a large display, the top row of 5 on a small one, null where blank; screen items: text, lines, arcs, bars and a wrapped log, in 0..1 screen coordinates), `DisplayCommand` (to the avionics, the UI, or the flight controls the strip's items stand for), `DisplayState`. `AircraftSnapshot` (`snapshot.ts`) is plain data; Free Flight builds it from the HUD's frame (`freeflight/snapshot.ts`), so the flight model is read in one place. Joker and bingo are 35% and 20% of the internal fuel until missions set them.
- **Formats built:** engines and fuel (the fuel against joker and bingo in the skin's unit, throttle or power, the afterburner's stage), messages (the log of every HUD message, wrapped, newest at the bottom, dim after 20 s), and the threat warning's scope (rings and the aircraft; emitters come with P3). A large display's bottom row selects among its slot's built formats, the format shown highlighted; the top row's right button pins the slot. Formats name themselves on the screen or by their highlighted button; the bezel's top edge is kept for the owner's tag (P5).
- **Presets** (`presets.ts`) after the proposal's table, by order of preference among the built formats the profile allows; until the moving map exists the left display shows engines and fuel. A slot that could only repeat its neighbor's format stays hidden (both MFDs offered engines and fuel); unused slots are hidden. Pins survive every mode change; a manual change lasts until the next one. Saving preset edits per viewer is still open.
- **Status strip** (`strip.ts`): the dark cockpit. Warnings: GEAR UP when slow and low with the gear up, GEAR SPEED, BINGO. Cautions: JOKER, the parking brake with the throttle up on the ground, the speedbrake with afterburner, the gear in transit. Normal states: GEAR DN (airborne, or in ground mode), PARK BRK, BRAKES, SPD BRK, AB n, HOVER HOLD, ALT HOLD, MASTER ARM, MOUSE FREE (cursor mode is the player's choice, so it is green; it lit the master caution at every start while it was amber). The master caution lights while any caution or warning is unacknowledged; acknowledging (click or K) stops the glow and flashing, not the items. Clicking GEAR, PARK BRK, SPD BRK, HOVER HOLD or MOUSE FREE works that control. Helicopters end the strip with torque, rotor speed and power margin gauges; their fixed gear never shows. The master mode's name sits at the strip's end, with MAN when chosen by hand.
- **The view** (`draw/displaysView.ts`, `displays.css`): HTML and CSS for bezels, buttons, tabs and the strip, Canvas 2D screens redrawn only when their model changes; skins as CSS variables (Part I's tokens); expand and collapse fade and scale toward the slot's screen edge in 300 ms. The controller (`system.ts`) runs the triggers every frame and the models at 10 Hz.
- **Hot keys** (`bindings.ts`, decision 193): 1–4 expand or collapse the left display, the right display, the messages and the threat display; M steps the master mode by hand and back to automatic; F is the dogfight override; K acknowledges the master caution. M is free since decision 198. The help card lists them for both aircraft kinds.
- **The HUD's retrofit** (`HudFrame.panels`): with the displays, the HUD drops fuel, gear, brakes, speedbrake, the control mode and the messages (the jet keeps the throttle, readings 3 and 4 of decision 189), and in helicopters fuel, the hold modes, torque and rotor speed (reading 1); GEAR SPEED moves to the strip; PULL UP, STALL, tail strike, the sink cue and the hazard cues stay (reading 2). The tools that draw the first HUD leave `panels` off.
- **Checks:** `tests/displays.test.ts` (triggers, hysteresis, manual and dogfight, profiles, presets and pins, the strip's dark cockpit, conflicts, acknowledgment and gauges, models as plain data, hot keys bound to nothing else); the session tool checks the displays in flight, the strip's PARK BRK and key 1, and saves `docs/reports/screens/session-kestrel.png` and `session-utility-hover.png` (`SHOT_DIR`), the HUD and displays over the page's empty canvas.

Not yet: the moving map, the UI scale setting in the pause menu, saving preset edits, acceptance checks 12 and 13, the Pact skin seen in an aircraft.

`docs/visual-style.md` (*Displays and Status Strip*), `docs/plans/displays.md`, `CLAUDE.md` (directory map) and `TODO.md` change with this decision.

**Reason:** The frame, the strip and the master modes are the structure every later format plugs into; building them on the two formats Free Flight can feed (fuel and messages) proves the model–view split, the commands and the presets before the costly formats arrive, and moves the states off the HUD as the owner asked.

### 200. The displays' size and saved layouts; acceptance checks 12 and 13 as a tool, and what they found

**Date:** 2026-11-17
**Decision:** P2's remaining work short of the moving map.

- **Displays size.** `uiScale` (0.75–1.5) in Free Flight's options: a slider in the pause menu, `ui=` in the URL (named only when not 1); `layout()` already took it (decision 195).
- **Saved layouts.** Choosing a format or expanding or collapsing a slot edits the current master mode's preset (Proposal 0006: edited once, it applies to every aircraft); an edit that names a format the aircraft lacks is passed over. Pins do not count as edits. The edits are kept per viewer in browser storage (`bearing.displays.presets`), read and written in try/catch, so a private window or blocked storage just starts from the presets; the pause menu's "Reset the displays' layouts" forgets them.
- **Checks 12 and 13** (`tools/displays.screens.mjs` with `npm run dev` up): the real `DisplaySystem` over the stand-in scene (`composite.html?hover=transition&displays=<mode>`, made-up snapshots in `tools/hud/displays.ts`) in every master mode for the Kestrel (ground, navigation, approach, air-to-air, dogfight, air-to-ground) and the Buzzard (ground, navigation, hover), both skins, at 1366 × 768 and 1920 × 1080, the smaller size also as seen with protanopia, deuteranopia and tritanopia through Chromium's own emulation, and a strip with a caution and a warning. It fails a shot with more than two large or two small displays expanded or a slot in the central column; none did. Air-to-air and air-to-ground show no large display yet, since their formats come with P3 and P4. A selection is in `docs/reports/screens/displays/`.
- **What the views found, and the fixes:**
  - The fuel bar's JOKER and BINGO labels collided (the marks sit at 35% and 20%): they are J and B now.
  - With deuteranopia, a warning message and a normal one were both yellow: warning messages carry ▲.
  - With protanopia, the fuel figure in warning red went dark olive on the black screen: warning-tone text on a screen is now inverse video (white on red).
  - In the Pact skin the screens' normal amber is the caution color: caution-tone text on a screen is boxed.
  - The strip already held up: shapes (rounded, notched, ▲) and labels separate its levels under every deficiency.

`docs/visual-style.md` (*Displays and Status Strip*), `docs/plans/displays.md`, `CLAUDE.md` (commands) and `TODO.md` change with this decision.

**Reason:** The owner asked for the rest of the displays up to where their eyes are needed; a scale and saved layouts finish the slots, and running the checks as a tool turned up four places where color was the only cue, which the style guide forbids.

### 201. The moving map: the strategic view drawn straight down into a texture, read back into the display

**Date:** 2026-11-17
**Decision:** P2's step 11, the moving map's strategic mode.

- **The picture.** `StrategicScene.renderMap(target, lat, lon, halfExtent)` lends the scene a second `StrategicCamera` (straight down: no tilt; a floor of 1 km instead of 100 km) and the target's size as its viewport, renders into the target with the zoom bands settled (a long step) and the labels placed at once, then puts the view's camera, viewport and render target back. While flying, the strategic view is not otherwise drawn, so the two never compete. Below the zoom floor the map shows the region band magnified (rule 11).
- **Into the display, not the frame.** `MovingMap` (`render/strategic/movingMap.ts`) reads the 512-pixel sRGB target back (`readRenderTargetPixelsAsync`) every half second while a display shows the map, and `DisplaysView.setMapPicture` keeps it as a canvas that the map format's screen draws, centered on the aircraft and turned for track-up. The plan drew the target into the WebGPU canvas under the slot; reading back keeps the display one HTML element, needs no pass after post-processing, and gives P6's companions a picture to send. The picture is √2 wider than the range, so a turned picture still fills the screen, and the aircraft's motion between pictures is a 2D shift. The read-back's rows run from the top: the lavapipe preview's labels read the right way round.
- **The format.** Ranges 5, 10, 20, 40, 80 and 160 nm from the aircraft to the screen's edge (20 at first; kilometers in the Pact's skin); track-up by default, north-up by the TRK / N-UP button (right edge); RNG▲ and RNG▼ on the left edge with the range under them; the aircraft as a small symbol at the center (along its track on a north-up map); a dashed ring at half the range with its figure. The map item is plain data (center, half extent, rotation, the planet's radius); the snapshot gains the aircraft's position, track and heading. With the map built, the left display shows it and engines and fuel moves to the right display, collapsed in navigation.
- **Glyphs only from 80 nm.** In the preview the mountain glyphs, sized for the zoom floor, covered the map at 40 nm and filled it at 10 nm. The map leaves the glyphs out below a picture of 150 km from center to edge (about 80 nm with the √2 margin); the relief, the labels, roads, rivers and the night lights stay. Elevation mode (P3) is meant for the short ranges. No glyphs showed at 80 nm in the preview either (the scene's bands decide them at the map's altitude); the owner should judge whether the map wants them at all.
- **A halo over the map.** Green symbology and button labels on the pale map were hard to read; on a screen that shows the map they get a dark halo, as Part I asks. `composite.html?…&mapimg=<preview picture>&mapnm=<nm>` puts a preview picture in the display; `docs/reports/screens/displays/map-navigation-1920x1080.png` and `map-navigation-pact-1366x768.png` show it.
- **Preview.** `MAP=1` (with `MAP_NM`, `MAP_SIZE`) in the strategic render preview writes `render-<seed>-strategic-<view>-map-<nm>nm.png` beside each view; on lavapipe a first run needs `--testTimeout=3600000`.

Not yet: the destination runway, route and waypoints, the front and threat rings as the format's own overlays; the wheel over the map for its range; the map's cost on a real GPU (a picture every half second includes the label pass).

`docs/visual-style.md` (*Moving Map*), `docs/plans/displays.md`, `CLAUDE.md` (directory map) and `TODO.md` change with this decision.

**Reason:** The proposal's moving map is the strategic view's own rendering, and the scene could draw it with a borrowed camera at little code cost; reading the picture back trades a fraction of a frame every half second for a display that stays plain HTML and data.

### 202. The destination on the moving map; the wheel over the map steps its range

**Date:** 2026-11-17
**Decision:** Two of decision 201's open items.

- **The destination.** The snapshot carries where the aircraft is going (in Free Flight, the landing aid's runway: `RWY 07`, its true bearing and distance). The map draws a diamond there with the label when it lies inside the range, and a caret at the map's edge pointing to it with the label and the distance (nm or km by skin) when it lies beyond; the bearing turns with the map in track-up. Routes and waypoints, the front and threat rings wait for missions and the sensor model (P3).
- **The wheel.** Over a display showing the map, the wheel steps the range (down widens it), accumulated so a trackpad's small steps do not race through the ranges; it works in cursor mode, since a captured mouse's wheel goes to the view (the throttle, or the zoom while looking around).
- **Checks.** A unit test of the mark inside and beyond the range; the session tool turns the wheel over the map; `docs/reports/screens/displays/map-navigation-*.png` redrawn with the mark.

`docs/visual-style.md` (*Moving Map*) and `TODO.md` change with this decision.

**Reason:** The runway the landing aid already knows is the one place in Free Flight the map can point to, and the proposal names the wheel for the map's range.

### 203. Acceptance check 7 with the full HUD: passed at noon, in snow and at night

**Date:** 2026-11-17
**Decision:** Part I's check 7 (the HUD legible against bright sky, snow and night) with the HUD as the displays leave it (decision 199) and the displays over it, on real renders: `tools/freeflight.preview.ts` on lavapipe (`GRES=512`, 1280 × 720; noon in clear sky, snow at noon, 23:00 in clear sky), composited by `tools/freeflight.screens.mjs` with `QUERY='panels=1&displays=navigation&aircraft=kestrel'` (`composite.html` takes `panels=1` and `displays=` over a render shot now, and the screens tool waits out the displays' 300 ms fade). The pictures are `docs/reports/screens/check7/`.

- **Noon:** the tapes, the heading scale, the landing aid and the flight path marker read over the bright sky and over the town below.
- **Snow:** the green with its dark halo reads on the gray sky and the falling snow; the thinnest tick marks of the tapes are the faintest element against the brightest snow sky.
- **Night:** everything reads; the halo is invisible against the dark, as it should be.
- **The displays** stay opaque and readable over all three; the stand-in map (no picture without the strategic scene's world in this page) shows its loading line.

The gap, the faint thin ticks on a bright snow sky, goes to P2's HUD color task (tune the values) rather than a change now: the owner should see it in the browser first.

`TODO.md` changes with this decision.

**Reason:** Check 7 is the last of P2's checks that does not need the owner's eyes; it ran on the CPU renderer, which draws what the app draws.

### 204. World diversity: provinces, lithology, richer biomes, closed basins, zones and wonders (proposal 0007 accepted)

**Date:** 2026-11-17
**Decision:** The owner accepts proposal 0007. Landform, biome and surface character become separate layers: a **province** map from tectonic history and a **lithology** map set relief, erodibility and which landforms form; an expanded climate with local modifiers sets twenty land biomes; soil, water and disturbance set the surface. **Closed basins** hold salt lakes and playas. Each continent gets a **character**, and a distinctness check redraws the smaller of two look-alike continents. **Zones** of 100–400 km get names and look recipes. **Landform props** carry the shapes a height field cannot (tower karst, pillars, arches, stacks), and 5–15 named **natural wonders** anchor each world. The palette moves brighter. The plan is `docs/plans/world-diversity.md` (track W, W0–W9); nothing is implemented yet beyond the metrics tool `tools/diversity.preview.ts` and the baseline `docs/reports/world-diversity-baseline.md`.

How the plan reads the proposal, for the owner to confirm (the plan's *Where the proposal meets the code* gives the reasons):

1. The radius in the code equals the design's 1,000 km, so the proposal's distances stand as written and its heights stay absolute. Landforms inside a province keep Earth's dimensions (decision 121); zones of 100–400 km give a world roughly 40–120 of them.
2. Heights are physical meters after the landform gain. Provinces scale the uplift amplitude and carry their own soft limit: young collision ranges reach 8–9 km, old mountains top out near 2.5 km. The gain of 12 stays.
3. Provinces, lithology, characters, climate modifiers, biome rules, closed basins, zones and wonder candidates are pure functions evaluated on the coarse pass for the graph and on the global grid for erosion and tiles; the graph reads only the coarse evaluation (rule 9, decision 65).
4. A new `provinces` stage after `boundaries` draws boundary ages, fossil sutures and hotspots from its own stream; plates, crust and boundaries stay byte-identical.
5. Tectonic provinces are assigned before uplift; karst and soft sediment are lithology classes decided after elevation; glaciated lowland is a surface province written after climate. Continents for character are components of continental crust, known before uplift.
6. Rule 10 is amended: a continent's character is drawn from what its tectonics allow, and the distinctness check may redraw the smaller continent's character up to twice from seeded sub-streams. It never rejects a world or favors any geography or theater.
7. Erodibility is a map multiplied into the incision (about 0.3 for granite and basalt to 3 for loess and ash), with the talus angle by rock.
8. Strata and buttes need layered sedimentary rock in a dry climate (a layered-rock mask in the reserved channel of the landform masks), not dryness alone.
9. Drainage gets a water balance on the filled depressions: a lake rises until evaporation meets inflow; below the spill level the basin is closed, its lake salt, or a playa when nothing remains. Decision 130's salt pans become the playa case, with shoreline rings added.
10. Playas over about 25 km² on the coarse pass become `SaltFlat` features and `dry-lake` airstrip sites in the graph; casting's use of them waits for the C track.
11. `Biome` v2 keeps the water values 0–3 and puts the twenty land biomes from 4, under the tile covers at 32. Shrubland splits into Mediterranean scrub, cold desert and steppe, and savanna; alpine becomes alpine meadow below the snow line.
12. The climate gains precipitation seasonality, cold currents and a fog tendency, continentality and stronger orographic effects, in a stream of their own.
13. Aspect and fine ecotones act in the shader and in `canopy.ts`, which the sim shares, so a north-slope forest is an obstacle where it is drawn.
14. Local variety is the entropy of the joint classes a player sees at 1.5 km (biome with altitude zone, province, surface character) on the eroded grid, so coherent zones and local variety do not conflict; the minimum starts at 0.5 bit on 90% of land.
15. Zones are segmented on the coarse pass with boundaries pulled to barriers, upsampled with a distance to the boundary for the 5–15 km blends, and are a feature kind whose labels replace those of the deserts, forests, plains, plateaus and wetlands inside them.
16. Props are obstacles like the canopy: a pure placement function in `worldgen/props.ts` shared by the renderer and the sim, with collision shapes that contact, the camera's clearance and line of sight query. The one height function (rule 13) stays the ground's.
17. Wonder candidates are graph facts; a campaign step after casting's territory and before its briefing selects 5–15 near fronts, lanes and airbases from its own stream; shaping is the tile kernel's or props'; the router keeps alignments out of their footprints and lets scenic routes pass in sight.
18. Part I takes the proposal's palette as starting values; Part II mixes the middle shades toward paper and caps their saturation below the faction colors.
19. Fine gullies are shade lines in the terrain shader, not micro-facets, since those are off by default (decision 197).
20. New streams: `provinces`, `lithology`, `climate-modifiers`, `zones`, `props`, `wonders`, and the forks `names/zones` and `names/wonders`. Every stage from uplift on changes by design, so every seed's world and cast change; `GENERATOR_VERSION` rises with W1.
21. The unattended session the owner briefed works on `feature/world-diversity` and opens a pull request, as the brief asks; every other session follows `CLAUDE.md` (`main`, decision 163).

The verification criteria's open thresholds are set in the plan from the baseline: entropy as in item 14, a Jensen–Shannon divergence of at least 0.25 bit between the two largest continents' joint province and biome distributions, zone diameters of 100–400 km for 90% of zones, and the generation time at most 1.5 times the baseline's.

`docs/design.md` (*Decisions So Far*, *Demo Goals*, *Scale and Range*, *World Generation Pipeline*, *Reading the World*, *Rendering*, *Milestones*, *Open Questions*), Part I (*Principles* preamble, *Terrain*, *Models*, *Palette*, *Performance Budgets*, *What to Avoid*, *Acceptance Checks*, and a new *Zones*), Part II (*Strategic Principles*, *Base Map*, *Geographic Glyphs*, *Labels*, *Strategic Palette*), proposals 0001 and 0005, `CLAUDE.md` (rules 10 and 15) and `TODO.md` change with this decision.

**Reason:** The terrain and erosion already make good ground; what the worlds lack is a reason for one place to differ from another. Tying landforms to tectonic history and rock, biomes to a richer climate, and both to named zones gives each region a cause and an identity, which serves the strategic map, the briefings and the flying alike. Keeping every new stage a pure function on both grids keeps campaign facts the same on every machine, and feeding the existing erosion and kernel new inputs keeps what works.

### 205. Owner's answers on proposal 0007: regional distances scaled to the planet

**Date:** 2026-11-17
**Decision:** The owner accepts decision 204's readings 2–21 and answers reading 1 with "use the appropriate scaling". The appropriate scaling is decision 121's split:

- **Regional extents scale with the landmasses**, by R / R_Earth ≈ 0.157: zones of 100–400 km become **16–63 km**, blends of 5–15 km about **1–2.5 km**, and the local-variety windows of 100 km about **16 km** (radius 8 km).
- **Landforms and heights keep Earth's values**: peaks of 8–9 km, fault-block spacing of 15–30 km, canyons, gullies and props.
- **Counts per world** stay as written: 5–15 wonders.

Consequences:

- A world has a few thousand zones instead of about a hundred.
- **Zones become presentation data.** A 16–63 km zone is three to ten coarse cells across, too coarse to segment or to follow a ridge. Zones are segmented once per world on the eroded global grid in the worker's finish and stored with the world, like the alignment tier (decision 184). Campaign logic never reads them, briefings name wonders rather than zones, and the weather's tendencies come from biome and province. This replaces decision 204's item 15 (zones on the coarse pass, upsampled).
- **Zone labels.** The map shows zones over about 40 km from the Theater band and all of them in the Region band.
- **Measuring local variety.** The entropy is measured on the eroded grid, where a 16 km window holds about 90 cells.
- **Salt-flat airstrips** need a straight run of at least 4 km, because runways keep their real length.

The owner also asked for decision 204's prep commit on `main` (done), and for the track to proceed.

`docs/design.md` (*Scale and Range*, *World Generation Pipeline*, *Reading the World*, *Casting*, *Open Questions*), Part I (*Zones*, check 15), proposal 0007's header, the plan, `TODO.md`, the baseline report and `tools/diversity.preview.ts` change with this decision.

**Reason:** Bearing's continents are Earth's scaled by 0.157 (decision 121), so a region that is a given share of a continent on Earth is the same share here. Landforms and heights are what a pilot sees at working altitude, and they keep Earth's size.

### 206. Mouse aim takes the stick only once the mouse has been captured; the browser smoke test with the displays

**Date:** 2026-11-17
**Decision:** A regression from decision 198, found by the browser smoke test on lavapipe, and that run's other results.

- **The regression.** Decision 198 made mouse aim the jet's default mode. On the wheels the keys steer and rotate, but the moment a keyboard takeoff lifted the wheels, the flight director took the stick and flew toward the aim ring at the screen's center, a point a little below the horizon, so it put the jet back on the runway, again and again: the smoke test's takeoff ran off the runway at 263 kt. Now mouse aim has the stick only once the mouse has been captured in this sortie (Tab or a click); until then the keys fly, as the start message already said. Freeing the mouse afterwards still holds the aim point (cursor mode). The aim ring shows only once mouse aim has the stick.
- **The smoke test** (`MODE=lavapipe`, `WORLD=tools/out/browser/world-1983`) then passes the takeoff (181 kt, 71 m up); the full run before the fix passed the six weather scenes, the helicopter (hover, forward flight, landing) and the campaign's views, map and time controls, with no page, console or WebGPU error. Its page screenshots show the displays and the moving map's picture in the left display: the render target, the read-back and the map format work in Chromium's WebGPU on lavapipe, not only on Dawn.

`TODO.md` changes with this decision.

**Reason:** The keyboard takeoff is how Free Flight starts, and the default mouse mode must not take it over before the player has picked up the mouse.

### 207. The Kestrel slows down and lands straight in: the drag polar retuned, gear overspeed, approach cues

**Date:** 2026-11-17
**Decision:** The owner found the F-21 Kestrel hard to slow down on a straight-in approach: the speedbrake seemed to do little and the gear "refused" to come down above 300 KIAS. A headless diagnostic (`tools/decel.preview.ts`; findings in `docs/reports/kestrel-deceleration-findings.md`) found no bug that blocks the gear or holds the speed up: the gear limit is 154.3 m/s compared with calibrated airspeed, nothing refuses the handle, and no assist touches the throttle. Level at idle the jet decelerated at or above the targets. What the player meets is a descent cancelling the speedbrake (at 350 KIAS on a 10° descent, idle and speedbrake leave 1.6 kt/s at Free Flight's 13.3 t), with nothing on the HUD that shows whether the deceleration is enough. The model was also off its targets near the approach: L/D 3.6 at 13° (target 5–8), CD0 0.0175, idle thrust 4% of military at Mach 0.7, a 6 s gear and a speedbrake without degrees or limits.

- **Drag.** CD = CD0(Mach) + k·CL² + CDsep(|α|) + gear + flaps + speedbrake + stores (`sim/flight/drag.ts`, shared by the model and the energy cue). Subsonic CD0 is 0.020; k = 0.124 (aspect ratio 3.2, Oswald efficiency 0.8); the separated-flow term is a table, zero up to 13° and rising steeply above 15° (0.08 at 20°, 0.20 at 25°, 1.25 at 90°), replacing `cdAlpha·sin²α`, which charged 0.05 at 13°. Gear 0.016 in proportion to its travel, flaps 0.003. The standard load of four air-to-air missiles stays in the CD0 table (tuned to the top speed with it), so `cdStores` is 0: the increment for loads beyond it.
- **Engine.** Idle thrust is net of ram drag and reaches zero by Mach 0.7 (slightly negative above; fuel flow never runs backwards). Spool-down from military to idle takes 2.9 s to 95% (time constant 1 s); spool-up stays 5.4 s.
- **Speedbrake.** Its travel is in degrees: 60° in flight in 1.5 s, 43° with the gear handle down, as on the F-16 (it closes to 43° when the handle comes down). Its drag (0.040 at 60°) and a small nose-up moment (Cm 0.006) scale as sin²δ / sin²60°, so 43° gives 62% of the drag; the pitch law's integrator holds the moment (the flight path moves less than 0.5° as it opens at 350 KIAS).
- **Gear overspeed: a warning and a cost, never a refusal.** The gear takes 4 s and moves at any speed; above 300 KIAS (the extension and retraction limits are separate fields, both 300) the GEAR SPEED warning shows while it is out or moving. Flown more than 20 kt over the limit for 3 s with the gear out, the doors fail: the gear stays down whatever the handle, with 0.012 more drag, until the next sortie. The strip shows GEAR DOORS (caution) and the HUD says it once.
- **Approach cues** (rule 14: spatial and time-critical, so the HUD; states on the strip):
  - On the speed tape: the gear limit (a double bar with a G at 300 KIAS), the approach speed bug (a caret at the speed of 13° in the landing configuration at the present weight) and a speed trend vector to the airspeed 10 s ahead, from the airspeed's rate low-passed over 1 s (`FlightTelemetry.casRate`, telemetry only).
  - On the landing aid: the approach energy cue, a bar of the distance left with the distance needed to slow to the approach speed at idle with the speedbrake, and SLOW OK (green), SLOW MARGINAL (amber, within the last fifth) or TOO FAST (red). The distance needed is flown on paper (`sim/flight/energy.ts`): level to the glide path from below, or down at up to 6° to it from above, then down the 3° path, drag taking the energy and the descent giving some back, gear and 43° below the gear limit. **It runs to the stabilization gate 5 km out, not to the glide path intercept** as first asked: at idle on the 3° path the jet keeps slowing (its idle glide is 6°), so a deadline at the intercept read red at the start of the acceptance approach, which lands on speed with 5 km to spare. It shows in the air on the way in while faster than the approach speed plus 5 kt. Red is new to the HUD; the cue's label carries the state too, so color is never the only cue.
  - On the strip: SPD BRK carries its deflection (SPD BRK 60°, 43°); GEAR SPEED as before; GEAR DOORS.
- **Tests.** `tests/flightDecel.test.ts` holds the plausibility targets at landing weight (fuel 1,000 kg, 11.1 t), the speedbrake and gear behavior, the cues, and the acceptance approach: the test pilot's new straight-in (`TestPilot.straightIn`) from 25 km, 1,500 m and 450 KIAS, gear up, at idle with the speedbrake, gear under 300 KIAS, the final at 13° with the throttle; it must be under 300 KIAS by 12 km, on speed and stable on the glide path at 5 km, and touch down in the zone under 2 m/s. The takeoff, stall and top-speed targets are unchanged and pass; the stall test held 0 m (it read the altitude before the first step) and so descended at 5.7° all along, which only the old drag turned into a stall; it now holds its spawn height.
- **Lockstep.** The fixture is re-recorded under Node 22 and Node 24 (the flight changes on purpose); every scenario keeps its outcome. The tumbling tail slide and the slide in a gale now part between the two versions by more than the closeness check allowed (1.1·10⁻⁵ m in 35 s; a smooth drag term instead of the table parts as far), so those two are compared within a hundred times the tolerance; the hashes per version stay exact.

**Reason:** A pilot has to be able to fly a normal straight-in approach and see whether the energy is under control: the deceleration was mostly there, the cue was not. The drag near 13° was too high for a power-on approach of the right kind, and a gear that blocked or broke without warning would punish a mistake the player cannot see coming; a warning, then a cost that leaves the jet flyable, teaches it.

### 208. The angle-of-attack bracket on the flight path marker replaces the side indexer

**Date:** 2026-11-17
**Decision:** At the owner's request (used to it from DCS), the jet's HUD draws the F-16's angle-of-attack bracket with the gear handle down in the air: an E to the left of the flight path marker whose top is where the marker sits at 11° of angle of attack, its middle tine at 13° and its bottom at 15°. The marker centered is on speed, low in the bracket slow, high fast. The bracket is three world directions (`aoaBracket` in `freeflight/hudFrame.ts`): the velocity's direction turned about the body's lateral axis by the sensed α less 11°, 13° and 15°, projected like the marker, so it has no parallax and tilts with the bank as the marker's wings do. The indexer beside the α readout (a circle on speed, chevrons outside 11.5–14.5°) is gone; the digital α stays. A test flies the straight-in of decision 207 and checks that the marker stays inside the bracket, within 1° of its center, from 5 to 2 km.

**Reason:** On final the eyes are on the flight path marker and the aim point. The indexer sat under the speed tape, about 400 px away, so every check of α was a glance away; with the bracket on the marker, α and the glide path read at one point (the marker in the bracket's middle, on the aim point). One cue for one quantity on the HUD, as the allocation rule asks.

### 209. W1: terrain provinces and lithology; erodibility in the erosion pass

**Date:** 2026-11-17
**Decision:** Two new tectonic-grid stages, and the first input they give the existing erosion.

- **`provinces`** (`worldgen/provinces.ts`, after `boundaries`, `rng(seed, "provinces")` with forks `ages`, `sutures`, `hotspots`, `noise`). Boundary runs (connected cells of one convergent or rift type) are young with a chance from 0.3 to 0.85 by mean strength, and draw a plateau flag (young collisions, 0.4) and a back-arc flag (cordilleras, 0.25). Old continental plates carry a fossil suture with a chance of 0.65 (an arc of 250–600 km through their interior). Three to eight hotspots leave chains of two to five edifices, 70 km apart along the plate's motion, shrinking with age. The province follows, by precedence:
  - young collision within 110 km of a young collision run;
  - volcanic arc within 65 km of a young cordillera or arc;
  - rift within 55 km of a rift;
  - hotspot within 35 km of an edifice;
  - then, on continental crust only: high plateau 120–300 km behind a young collision with the flag; old mountains near old runs or sutures; basin and range within 140 km of a rift or 130–240 km behind a back-arc cordillera; shield at least 250 km from every active boundary; sedimentary basin elsewhere.
  - All widths wobble by ±25% with noise. They are regional extents on the planet (decision 205), near the existing uplift widths.
- **`lithology`** (`worldgen/lithology.ts`, after `climate`, `rng(seed, "lithology")`): nine rocks by province with broad and fine noise. Sandstone, shale and limestone in sedimentary basins and high plateaus carry a `LAYERED` bit; folded ranges do not. The stage finishes the province map: land outside every province becomes sedimentary basin; basins on limestone become karst platforms; basins on loess become soft sediment; shields and basins below 900 m with an annual mean under 3 °C become glaciated lowland on till (or bare granite on shields).
- **Erodibility.** Each rock has a factor (granite 0.35, basalt 0.4, schist 0.6, limestone 0.8, sandstone 1, till 1.4, shale 1.6, ash 2.2, loess 3), smoothed in log space over two passes on the tectonic grid. It is upsampled into the global grid's `erodibility` map, which multiplies the incision factor; the talus slope divides by its square root, clamped to 0.6–1.6. Worlds without lithology, and `runErosion` without the map, erode uniformly as before.
- **Shares over seeds 1–5 at 128²:** young collision 9%, high plateau 8%, old mountains 7%, shield 15%, basin and range 11%, rift 3%, volcanic arc 6%, hotspot 0.7%, sedimentary basin 19%, karst 5%, soft sediment 3%, glaciated lowland 14%. Layered rock covers 28% of land.
- **Views and metrics.** The map modes `provinces` and `lithology` exist in `npm run maps` and in the GUI's "Color by", which also tints the strategic view. `tools/diversity.preview.ts` counts joint classes of biome and province for entropy and divergence. On seeds 1 and 2 the coarse joint entropy reaches 0.5 bit on 86–87% of land (biomes alone: 65–71%), and the divergence between the two largest landmasses is 0.36 and 0.48 bit (biomes alone: 0.11 and 0.29).
- **Unchanged and changed.** Heights, climate, biomes, the graph and the cast are unchanged: the coarse pass gains maps only. The eroded world changes through erodibility, so `GENERATOR_VERSION` is 22.

`TODO.md` changes with this decision.

**Reason:** Provinces and rock are the landform layer's sources (rule 15); the erosion pass is the backbone, so rock reaches it as an input, not a new process. Computing both on the tectonic grid and upsampling follows how every other tectonic map reaches the global pass.

### 210. W2 and W3: relief by province, fault blocks, fjords, terracing on layered rock; closed basins with salt lakes and playas

**Date:** 2026-11-17
**Decision:** The province and rock maps of decision 209 now shape the relief, and drainage gets a water balance. Simplest versions that meet the criteria; what is left is listed below.

**Relief by province (W2).**

- **Uplift** (`elevation.ts`, `PROVINCE_RELIEF`):
  - Collision and cordillera uplift from young runs × 1.25, from old runs × 0.45 with their ridged modulation cut to 30%.
  - High plateaus add 3,700 reference m over the interior crust, about 4.5 km of Earth elevation in all. Like every continental-scale height, this is a reference height (decision 121), so it sets the climate of a high steppe; peaks stay physical meters.
  - Fossil sutures add 1,500 m of rounded relief.
  - Hotspot edifices add a dome of 4,200 m × strength over their 35 km radius.
  - Basin and range and shields sink by 200 and 150 m. More flooded interiors under the sea-level quantile in a first try.
  - Every province term is blurred over three cells.
- **Fault blocks** (`detailStage.ts`). Where the basin-and-range weight (the province, blurred over two tectonic cells) is positive, the detail stage adds tilted blocks: a sawtooth across a regional extension axis, 22 km apart (Earth spacing; a landform, decision 121) and 900 reference m above the basin floors. The blocks have a steep scarp and a long dip slope and break into segments along strike. The extension axis comes from low-frequency noise, so neighboring ranges run parallel.
- **Fjords** (`erosion.ts`, glacial pass). A deep, iced trough (ice over 0.5, valley floor, drainage) whose local floor reaches the sea within the trough radius may sink below sea level, so the sea floods it.
- **Terracing.** Strata and buttes need layered rock as well as a dry climate. The masks' second word carries a layered-rock channel from the lithology, blurred like the aridity. The global finish upsamples province and rock to the global grid, and the tile kernel multiplies the aridity term by it. On seed 1's coarse pass the land the kernel would terrace falls from 23% to the share of dry layered rock; the metric is in `tools/diversity.preview.ts`.
- **Left for later.** A soft limit per province (the baseline's eroded peaks already reach 8.6 and 9.2 km on seeds 1 and 2, so the criterion of peaks above 6 km holds without it). Cirques and arêtes beyond the kernel's alpine crests (decision 126). Separate stratovolcano cones (the arcs keep their ridged uplift). Canyons are left to the erosion of rivers crossing the raised plateaus, with strata in their walls where the rock is layered.

**Closed basins (W3).**

- **Water balance** (`drainage.ts`). With the climate, each depression (a component of cells at least 3 m under the filled surface, three cells or more) compares its inflow, the discharge at its outlet, with the net evaporation of a lake at its spill level. Evaporation is 400 + 60 · T mm/yr, clamped to 150–2,600, minus the precipitation on the lake.
- **Closed basins.** A basin that loses more than flows in is closed. Its lake stands at the balance level, the lowest level where the lake's loss meets the inflow, and is salt. A balance lake shallower than 3 m dries to a playa, whose crust reaches 30% of the way from the floor to the spill level.
- **Routing.** Routing runs again with the lake's or playa's cells as sinks at their level. They are terminals with receiver −1, like a mouth, so rivers end there and nothing leaves the basin; every consumer of the receivers already treats −1 as a mouth. Open depressions keep their lakes as before.
- **Where it runs.** The coarse pass and the global finish both pass the climate: the temperature at each cell's Earth elevation and the precipitation. Seeds 1–6 at 256² give 34–81 closed basins each, of which 55–60% are playas.
- **Graph.** Playas become point features of the new kind `SaltFlat` ("the Oskel Salt Flat", "Oskel Pan"), labeled from the Theater band, and `StrategicGraph.saltFlats` lists them. A playa is an airstrip site when its longest run is at least 4 km (decision 205). Casting's use of the airstrip sites waits for the C track.
- **Tiles.** Salt lakes carry a flag (bit 17) and playas another (bit 18) in the global material, with the playa's level as its lake level. With basins, the kernel's salt pan of decision 130 is the playa, and salt lakes keep their water.
- **Left for later.** Brine colors (pink or turquoise by salinity) and pale shoreline rings between the playa and the spill level. Both need a flag in the tiles' output material that the terrain shader reads.

**Tests.**

- `tests/closedBasins.test.ts`: a wet bowl stays open; a dry bowl closes below its spill level and sends less water to the sea; a very dry one dries to a playa; salt flats and airstrip sites appear in three worlds' graphs.
- `tests/riverInvariants.test.ts` now drains with the climate, so its ten seeds check the invariants with closed basins too.
- `tests/militaryOverlays.test.ts` moves from seed 1 to seed 5, which now has two fronts and sea lanes at 128².
- `GENERATOR_VERSION` is 23.

`TODO.md` changes with this decision.

**Reason:** Feeding the existing uplift, detail and erosion stages new inputs keeps the backbone, and a water balance on the depressions the drainage already finds is the smallest change that closes basins while keeping the river invariants.

### 211. W4: climate modifiers and the twenty biomes; the brighter palette in the code

**Date:** 2026-11-17
**Decision:** The biome table grows to proposal 0007's twenty land biomes, read from the climate, three modifiers, the rock and the ground's shape.

- **Codes.** The existing codes keep their meaning, and seven are appended, rather than renumbering as decision 204's item 11 planned: renumbering would touch every table and stored world for no gain.
  - The appended codes are cloud forest 17, mangrove 18, rocky desert 19, red rock desert 20, fog desert 21, moorland and heath 22, wetland 23. `BIOME_COUNT` is 24, still under the tile covers at 32.
  - The proposal's names map onto the old codes: ice sheet = ice, taiga = boreal forest, temperate forest = temperate deciduous forest, cold desert = cold desert and steppe, hot desert = sand sea, shrubland = Mediterranean scrub, tropical seasonal forest = monsoon forest, alpine = alpine meadow.
  - `LAND_BIOMES` lists the twenty and `DESERT_BIOMES` the five deserts.
- **Climate modifiers** (`climateModifiers.ts`, stage `climate modifiers` after `climate`, `rng(seed, "climate-modifiers")`). They are fields beside the climate, which stays unchanged:
  - **Seasonality**, −1 to +1. Summer-wet in the monsoon belt (about 10–28°). Winter-wet on west coasts at about 30–44°, fading over 600 km inland, measured by a westward search for the sea along the parallel.
  - **Fog** from cold currents on west coasts at about 12–34°, fading over 200 km inland, with a strength that varies along the coast. Fog also takes up to 60% of the moisture, as a cold current dries the air.
  - **Ecotone noise** at about 25 km, which shifts temperature by up to 0.8 K and moisture by 0.04, so boundaries interfinger.
  - Continentality and rain shadows already come from the climate stage. Aspect belongs to the shader and the canopy (left for later).
- **Classification** (`classifyBiome` with a `BiomeContext`; without one it is the old table, so old tests and worlds keep their biomes). In table order:
  - High plateaus are cold steppe (or tundra, or meadow where wet), never ice or alpine meadow.
  - Cloud forest: frost-free, wet (moisture 0.7 and up), 9–20 °C, above 1,000 m Earth elevation.
  - Moorland: acidic rock (granite, sandstone, till), wet (0.6 and up), cool (under 11 °C), upland (over 250 m) or coastal, below 1,600 m.
  - Wetland: flat ground (reference slope under 0.004) that is wet (0.8 and up) and low (under 300 m).
  - Mangrove: hot, wet coasts under 40 m.
  - Deserts: fog desert where the fog passes 0.35; red rock desert on layered sandstone or shale above 500 m; rocky desert on crystalline, volcanic or limestone rock or above 1,100 m; sand sea otherwise (hot) or cold desert and steppe (cold).
  - Winter-wet ground that would be grassland, temperate forest or dry savanna is Mediterranean scrub.
  - Limestone carries grassland where loam would carry forest (moisture under 0.55).
  - The coarse pass and the global finish classify the same way. The global grid reads the province and rock upsampled to the nearest tectonic cell, and the modifiers bilinearly.
- **Consumers.** Every table indexed by biome gains the seven: the debug and terrain palette, open ground, strategic fills, forest density, fertility, movement cost, airbase suitability (no wetland or mangrove), landform masks (deserts arid; mangrove, cloud forest, rocky and red rock desert as warm coasts), rotor dust, ground cover, treeless biomes and feature extraction (all deserts are desert features; cloud forest and mangrove are forest; wetland and mangrove count as wetland).
- **Palette.** `BIOME_COLORS` takes Part I's brighter middle shades for every land biome. The strategic fills of the new biomes are those shades mixed about 35% toward paper.
- **Metrics on the coarse pass (seeds 1–20).**
  - All twenty biomes appear: eighteen in every seed, the ice sheet and mangrove in 19 of 20.
  - The joint biome-and-province entropy reaches 0.5 bit on a median 85% of land over unscaled 100 km windows; on seeds 1–8 after the plateau rule, 88%.
  - The divergence between the two largest landmasses has a median of 0.62 bit (0.68 on seeds 1–8).
  - The land the kernel terraces falls from 33% to 10–13%.
  - The dry share of the highest 5% of land rises from 0 to 2.3% on seeds 1–8.
- **Left for later.**
  - Gully shade lines in the terrain shader.
  - Aspect in the shader and the canopy.
  - Disturbance patches in forests: the global finish has no seed yet.
  - Oases at springs. The tiles' green corridors along desert rivers (decision 126) carry the riparian corridors.
  - The weather reading the fog tendency.
- **Version.** `GENERATOR_VERSION` is 24.

`docs/visual-style.md` (*Palette*) and `TODO.md` change with this decision.

**Reason:** Appending codes keeps every stored table valid and the old classification intact for the tests that pin it. The modifiers sit beside the climate rather than in it, so drainage and the weather keep their inputs, while the biome table gains the rock, the season and the coast, which is where the proposal's biomes differ.

### 212. W5: continental characters by plate, biases within tectonic limits, and the distinctness check

**Date:** 2026-11-17
**Decision:**

- **Continents.** A continent for character is the continental crust of one plate, not a connected region of crust. Continental crust is welded across collisions into one region in most seeds (a first try gave one "continent" of 3.7 M km² and a speck in 16 of 20 seeds), much as Eurasia joins several cratons. Each plate's crust has its own history, so it takes its own character. Continents are known after `boundaries` and before `provinces` (stage `continents`).
- **Characters** (`characters.ts`): mixed, old shield, young mountains, dry extension, tropical platform. Each continent of at least 250,000 km² draws one character from `rng(seed, "provinces").fork("characters")`. The weights:
  - mixed 1;
  - old shield 2 above 40° of latitude, else 0.8;
  - young mountains 1.4, only if a collision, arc or cordillera touches the continent;
  - dry extension 2 between 12° and 45°, else 0.6, only if a rift or cordillera touches it;
  - tropical platform 2.2 below 28°.
- **Biases.** Factors of 1 and offsets of 0 mean no bias.
  - Old shield: young runs × 0.45, shield distance × 0.55, moisture +0.04, karst threshold +0.05.
  - Young mountains: young runs at least 0.9, plateau chance 0.7, moisture +0.02.
  - Dry extension: back-arc chance 0.85, rift extension × 1.6, loess threshold +0.12, moisture −0.09.
  - Tropical platform: young runs × 0.7, shield distance × 1.4, karst threshold −0.14, moisture +0.07.
  - A run takes the character of the continent its first cell lies on or touches. Moisture offsets reach the biome table through a `moistureBias` map, upsampled to the global grid like the other modifiers.
- **Distinctness** (stage `distinctness`). After biomes, the joint province and biome distributions of the two largest continents are compared. Under 0.25 bit, the smaller one's character is redrawn from `characters/nudge-k`, excluding both current characters, and the stages from `provinces` to `biomes` run again, at most twice. `WorldInfo.continents` and `characterRedraws` record the outcome. Plates, crust, boundaries and continents never rerun.
- **Coarse pass, seeds 1–20.**
  - The three largest continents of each seed carry two or three different characters in 18 of 20 seeds.
  - Two seeds needed one redraw.
  - The divergence between the two largest landmasses reaches 0.25 bit in 18 of 20 seeds (the proposal's 90%), against 11 of 20 in the baseline (biomes only), with a median of 0.51 bit.
  - The coarse campaign world takes a median 12.7 s, against 11.9 s in the baseline.
- **Tests.**
  - `tests/characters.test.ts`: characters vary within worlds, redraws stay within their limit, redrawn worlds are deterministic, divergence is in bits.
  - `tests/militaryOverlays.test.ts` now finds the first seed of 1–12 whose cast has corridors and sea lanes rather than pinning one, since every generator change moves fronts between seeds.
- **Version.** `GENERATOR_VERSION` is 25.

`TODO.md` changes with this decision.

**Reason:** The plate is the unit of tectonic history in the generator, so it is the honest unit for a continent's identity; biasing the provinces' draws and thresholds, never their geometry, keeps every character inside what the tectonics allow (rule 10's exception, decision 204).

### 213. W6: zones on the eroded grid with names and look recipes; their palette shift on the terrain; zone labels on the map

**Date:** 2026-11-17
**Decision:**

- **Segmentation** (`worldgen/zones.ts`, in the worker's global finish, as decision 205 placed it).
  - **Seeds.** One per lattice block of about 36 km, jittered from `rng(seed, "zones").fork("seeds")`, on land.
  - **Growth.** Region growing from every seed at once (Dijkstra over 8-neighbors). A step costs four times as much where the class changes (8 biome groups × 4 province groups), 0.6 more per 100 m of height difference, and 4 more across a river carrying 150 m³/s or more. Boundaries settle on class changes, ridges, escarpments and large rivers, and coasts bound zones by themselves.
  - **Islands and small zones.** Land no seed reached (small islands) becomes zones of its own. Zones under 16 km (the equal-area disc's diameter) merge into the neighbor with the longest shared border, smallest first, in up to three passes.
  - **Boundary distance.** A breadth-first search gives the distance to the nearest boundary, up to 4 cells.
- **Records.** Each zone records cells, area, diameter, an anchor (the centroid's direction), its dominant biome and province, a name and a recipe.
  - **Names** draw from `rng(seed, "names").fork("zones")` in zone order. The generic term follows the dominant classes: Highlands or Uplands, Barrens or Fells, Taiga, Woods or Forest, Moors or Heath, Downs or Steppe, Waste, Sands or Badlands, Plains or Veld, Jungle or Wilds, Fens or Marshes. The naming flavor follows the anchor's quarter of longitude, so neighbors share it.
  - **Recipes** draw from `zones/recipe-<id>`: a hue shift within ±10°, saturation and value factors within ±12%, and air by biome group (haze tint and density, sun warmth, cloud regime, ambient particles). Mountains thin the haze, volcanic ground grays it, and fog deserts, cloud forest and moorland take fog.
- **Simulation view.**
  - The terrain's vertex colors pass through the zone's shift (`render/common/zoneLook.ts`, `MeshOptions.zoneShift`), in HSV. The shift fades to a quarter of a cell's worth at a boundary from both sides, so zones meet without a seam and the change sits on the barrier.
  - Haze, sky grading, sun warmth, cloud regime and particles by the camera's position are left for later; the recipes carry them.
  - `ZONES=0` in the render preview leaves the shift out.
- **Map.** `StrategicScene.setZones` takes the stored records. Zone names are area labels in the small landform style, from the Theater band for zones over about 40 km and in the Region band for all, and they replace the labels of the deserts, forests, plains, plateaus and wetlands (decision 204).
- **Measured on a 512² coarse world (seed 3).**
  - A 512² coarse world stands in for the eroded grid: seeds 1 and 3 give 3,391 and a similar number of zones.
  - Every land cell is in a zone, at least 90% of zones (98.6% on seed 1) fall within 16–63 km, the median diameter is 37 km, and names almost never repeat.
  - Segmentation takes 3.2 s at 512², so about 13 s is expected at 1024².
- **Tests.** `tests/zones.test.ts` covers coverage, sizes, names, recipe limits, determinism, and a shift that barely touches boundary cells.
- **Version.** `GENERATOR_VERSION` is 26.

`TODO.md` changes with this decision.

**Reason:** Zones are presentation data at a scale only the eroded grid resolves (decision 205); a growth whose costs follow the barriers puts boundaries where the proposal asks, and a vertex-color shift is the cheapest way to give the faceted terrain each zone's palette without a new texture.

### 214. W8: natural wonders as graph candidates, selected after casting, named, labeled and briefed; landform props (W7) deferred

**Date:** 2026-11-17
**Decision:**

- **Candidates** (`geography/wonders.ts`, in feature extraction on the coarse pass). The detectors read the province, rock, biome, relief, slope, drainage and closed basins that the strategic input now carries:
  - tepui: tropical sandstone with 250 m of local relief;
  - giant waterfall: a river of 300 m³/s dropping 120 m to its receiver;
  - drowned karst bay: a tropical karst coast;
  - sandstone pillar forest: forested sandstone on a slope over 0.04;
  - salt lake on a playa: a closed basin's salt lake beside a desert;
  - travertine terraces: limestone next to a rift, arc or hotspot;
  - caldera crater lake: a lake in a volcanic arc or hotspot;
  - calving glacier: an icy, high-relief coast in a young range or glaciated lowland;
  - rainbow mineral hills: desert slopes on ash, shale or loess;
  - monolith: 200 m of relief alone on a desert or savanna plain;
  - blue hole: a drowned hotspot edifice in warm, shallow water;
  - basalt causeway: a basalt coast.
  - The three best of each kind, 150 km apart, become point features of the new kind `Wonder`, whose `measure` holds the kind. Names come from their own fork, `names/wonders`, so every other name is unchanged: "the Greind Falls", "the Kor Towers", "Kran Crater", "the Painted Hills of Grevith", "the Blue Hole of Debopru".
- **Selection** (`campaign/wonders.ts`, casting's step 8, `rng(seed, "wonders")`). It reads only the graph and the cast (rule 9) and draws a target of 5–15, at most the number of candidates. Weights are importance × (1 + 2 · e^(−d/300 km)), with d the distance to the nearest front start line or sea lane in play. Draws are without replacement, keeping at most two of a kind and 120 km between picks. `Cast.wonders` holds the feature ids. Seeds 1–4 select 13, 15, 11 and 8.
- **Briefing and map.** The briefing ends with the landmarks ("Pilots navigate by the world's landmarks: …"). The map labels only the selected wonders, as point labels in the landform style from the Theater band.
- **Left for later.**
  - **Shaping in the tiles:** tepui walls, a knickpoint for the falls, a caldera, travertine steps, mineral bands.
  - **Protection from earthworks:** the router's extra cost around a wonder's footprint, with scenic routes allowed in sight.
  - **The map's own wonder glyph.**
  - **W7, landform props.** A prop kit of specs, a placement function shared with the sim, an instanced layer with LOD, collision shapes for contact, the camera and line of sight, and budgets in the views. That is a milestone's work and was not started in this session. The karst bay and pillar forest wonders are named and selected, but until W7 they have no towers in the simulation view.
- **Tests.** `tests/wonders.test.ts`: 5–15 named wonders per world, at most two of a kind, the briefing mentions them, and the karst bay, crater lake and blue hole stand where their conditions hold.
- **Version.** `GENERATOR_VERSION` is 27.

`TODO.md` changes with this decision.

**Reason:** As graph facts, wonders reach the briefing and the map on every machine. Selecting them after the territory is cast puts them where the war will be flown, and their own streams leave casting and every other name unchanged.

### 215. W9 fixes: islets join a zone; flatness and mangroves at the eroded grid's resolution

**Date:** 2026-11-17
**Decision:** Two fixes the eroded verification found.

- **Islets.** On seed 1's eroded world, 822 of 4,459 zones were under 16 km, and all but two touched no other zone: islets (5,824 cells in all). A zone still under the minimum after the merges now joins the nearest large zone across up to 30 km of water (`ZONE_TUNING.isletReach`), so an archipelago shares its coast's zone. Seed 1 then has 3,728 zones, 97.6% of them 16–63 km across (`tools/zones.preview.ts`, which recomputes zones on cached eroded worlds without the GPU).
- **Flatness and mangroves.** Wetland and mangrove came out at 0% on the eroded grid, though the coarse pass had them in every seed. The level-ground test (reference slope under 0.004) and the mangrove's coastal height (under 40 reference m) were tuned to 6 km cells. The 1.5 km grid resolves the relief the coarse cells average out, and its Earth elevation counts the landform above the valley floor at Earth's scale. The flat threshold now scales as (6 km / cell)^0.8, so 0.004 at 6 km and 0.012 at 1.5 km. Mangroves need physical height under 12 m. On the coarse pass, seeds 1–8 keep both biomes in every seed (mangrove 0.7%, wetland 2.8%).
- **Not yet measured on the eroded grid.** The eroded metrics in `docs/reports/world-diversity-metrics.md` were measured before this fix. Their wetland and mangrove shares predate it.
- **Version.** `GENERATOR_VERSION` is 28.

**GPU tests on the final generator** (32 files on lavapipe). Two needed updating for the new worlds, and two still fail.

- **Updated: the lake shoreline test.** It took the deepest lake's tile; that lake is now a closed basin's salt lake wider than a tile, so it had no dry margin. It now takes the deepest lake cell on a shore.
- **Updated: the renderer's descent test.** It flew 3 km above sea level over the main continent, whose interior is now a raised plateau (7 km under the test's 10× relief). It now flies 3 km above the eroded ground.
- **Updated: both tests' synthesizers** now take rock and closed basins as the app does.
- **Still failing: "agrees across a cube-face seam"** (0.13 m against 0.05 m). The worst sample lies on the sea floor at −487 m. It is identical with the fault blocks, the provinces and the rock switched off, so it comes from the new world's coast near that seam (the masks' bilinear sampling across faces drives the skerry and coastal sea floor), not from a kernel change.
- **Still failing: "lets river beds fall downstream without humps"** (6.5 m against 4 m on the longest river's first 16 km, with the new, steeper relief).
- Both are left failing for the owner rather than loosening their tolerances; the report lists them as high-severity issues.

**Reason:** Both criteria the zones and the biome table must meet are measured where the player flies, on the eroded grid; thresholds that only made sense at the coarse grid's scale had to follow the cell size.

### 216. Keeping the terrain's character: rugged plateaus, unbroken spines, no rings or seams (owner's concern after track W)

**Date:** 2026-11-17
**Decision:** The owner asked that track W keep what they liked: the ridges and filled-in valleys from erosion, the coastal cliffs, the skerry archipelagos, the continents' spines, and tall, dramatic mountains. A before-and-after comparison of the cached eroded worlds of seeds 1 and 2 (hillshaded maps and relief statistics) found the coasts, valleys and northern ranges intact and the mountains taller, but six artifacts that track W had introduced:

1. **Plateaus as sunken tables.** A smooth 3,700 m high-plateau uplift is a continental-scale height, so at the planet's relief scale (decision 121) it was about 700 m physical. Ringed by its taller collision rim, erosion filled it flat: a green table inside a wall.
2. **Broken spines.** Old collisions at 45% of their uplift broke continuous ranges into rings and boxes. Seed 2's largest connected range above 1.5 km fell from 312,000 to 160,000 km².
3. **A straight scarp along the bisector between two runs.** Each cell took its run's age (young × 1.25, old × 0.45) from its nearest boundary cell, so uplift stepped where the nearest run changed.
4. **Concentric rings and arcs.** High plateaus and back-arc basin-and-range lay in bands at a fixed distance from a boundary, so curved boundaries drew target-like rings and arcs. Plateaus also wrapped both sides of a range.
5. **Uniform worms.** Fossil sutures were smooth ridges of even width.
6. **Perfect domes.** Hotspot shields were round.

Fixes:

- **Plateaus.** The uplift is 1,900 m and rugged: 0.35 + 0.5 × ridged + 0.5 × broad swells, so plateaus are highlands with ranges and basins. They lie on one side only, the plate of the run's first cell, and reach out from the range instead of forming a band.
- **Spines.** Old runs keep 75% of their uplift and 70% of their ridging.
- **Run age.** Youth (1 young, 0 old) is blurred over 8 cells before it scales uplift and ridging.
- **Back-arc basin and range.** It reaches out from the cordillera, like the plateaus. Province edges wander by ±40% at a broad scale, and the province masks blur over 6 cells (was 3).
- **Sutures.** Ridged relief with saddles along the crest, and a width that swells and pinches.
- **Hotspots.** 3,200 m domes broken by ridged noise.
- **Erodibility.** A milder range (0.55 to 2.0) and 6 blur passes, so hard and soft rock never meet in a scarp.
- **Version.** `GENERATOR_VERSION` is 33.

`docs/reports/world-diversity-report.md` (*Terrain character*) has the before-and-after numbers.

**Reason:** Track W is meant to add variety on top of the terrain that worked, not to replace it. Each artifact was a sharp threshold or a smooth analytic shape where the old generator had noise and erosion; blending the thresholds and roughening the shapes gives the erosion pass the same kind of input it carved well before.

### 217. A mouse takeoff in mouse aim; readable messages; a minimize button; a frame-rate gauge

**Date:** 2026-11-17
**Decision:** The owner's review of P2 in the browser: they could not take off with the mouse (once airborne it flew), could not read the messages display, wanted a minimize button beside the pin, saw something hidden behind the upper-left display, and asked for a frame-rate gauge.

- **Mouse takeoff.** On the wheels, mouse aim gave the stick to the keys (decision 206), so the mouse could not rotate. Now, with the mouse captured in mouse aim, the ring's height above the screen's center pulls the stick on the wheels (`FlightInput.aimRotates`; a held key still wins): raising the ring rotates the jet, and at liftoff the flight director takes over toward the raised ring and climbs away. Direct mode already flew the stick on the wheels. The session tool now takes off with the mouse in mouse aim (rotation at about 195 kt, 748 m ten seconds later), updating the chase camera itself, since its page draws nothing and mouse aim reads the camera's rest view.
- **Readable screens.** The messages display drew its log at about 8 px. Screen text now has floors: 12 px for normal text, 11 px for small text and log lines, 10 px for button labels; the log wraps and keeps fewer lines on small displays.
- **MIN.** Every display has MIN beside the pin (top row), collapsing it to its tab; the tab or the hot key brings it back.
- **The frame-rate gauge.** What hid behind the upper-left display was the app's frame-time readout. In Free Flight (`body.ff-flying` while a sortie is on) it becomes a compact gauge at the top center, clear of the slots and above the heading tape: frames per second, the average and the worst frame time. A pause-menu checkbox, "Frame rate", turns it off; the URL keeps that as `fps=off`.

Seen on a clean `main` while checking this, from other work and left to it: `tests/gpu/tileSynth.test.ts` fails its cube-face seam test on lavapipe (0.10 m against 0.05 m), and the Free Flight session's "drizzle: wet at once" check fails. Both are in `TODO.md`'s known issues.

`TODO.md` changes with this decision.

**Reason:** The owner's review.

### 218. P3a: the sensor model, Free Flight traffic, the air-to-air radar and the threat warning

**Date:** 2026-11-17
**Decision:** P3 splits as the plan allowed. P3a is the sensor model, scripted traffic for Free Flight, the air-to-air radar format and the threat warning format; P3b keeps the air-to-ground radar, stores, the complete engines format, comms, the moving map's elevation mode, profiles for the air war's other types and the Su-27 analogue's HUD radar.

- **Sensor model** (`sim/sensors/sensors.ts`, headless and deterministic). A `SensorModel` per aircraft keeps a `SensorPicture` of contacts (radar, visual, datalink) and threats (emitters the RWR hears).
  - Radar range follows the radar equation: R = R₅ (σ / 5 m²)^¼, R₅ being the spec's range for a 5 m² target. A pulse-Doppler radar sees a target 0.7 + 0.3 × its aspect as far (tail-on targets are harder). Inside the scan limits only.
  - A pulse radar looking down (an airborne target below the radar's local horizontal) loses it in the ground clutter. A pulse-Doppler radar looking down loses a target whose own speed along the line of sight is under the notch (40 m/s for the Kestrel): a beaming target hides in the clutter's Doppler band.
  - Between 85% and 100% of the range a detection is a chance falling to zero at the edge, drawn from a hash of the target and the scan number (`scanHash`), so a replay sees the same marginal contacts.
  - Scans come every 2 s in range-while-search (a contact coasts 6 s), every 1 s in track-while-scan (4 s) and every 0.1 s in single-target track (1 s), where only the locked target is scanned.
  - The RWR hears an emitter out to 1.5 times its radar's range, with its state (search, track, launch). Visual detection reaches 1500 m per meter of target size, scaled by daylight (a quarter at night) and capped by the weather's visibility, all round. Every path needs line of sight, which the host supplies.
  - The datalink gives positions a delay old with an error and carries the side; a contact the aircraft's own sensors saw within a second keeps its own source and takes the side.
- **Line of sight** (`sim/sensors/lineOfSight.ts`): 32 samples along the segment against the ground (sea level at least), which also finds the planet's horizon. It is execution-layer terrain reading, allowed by rule 9.
- **Avionics.** The radar's state (power, mode, display range, lock) is avionics state changed by avionics commands: `radar-power`, `radar-mode`, `radar-range` (10, 20, 40 and 80 nm) and `radar-lock`. A lock puts the radar in single-target track; breaking it returns to track-while-scan. The Kestrel's profile carries its radar (pulse-Doppler, 70 km, ±60°, notch 40 m/s).
- **Air-to-air radar format** (`radar-aa`, labeled FCR): a B-scope, azimuth across and range up, with the range scale and tick marks. A contact with no known side is a filled square from the radar and a small circle when only seen; a hostile is a diamond and a friend a circle once the datalink names the side, in the dimmer level when only the datalink has it. Each carries a heading stick relative to the nose and its altitude (thousands of feet; hundreds of meters in Pact skins); the locked contact is ringed, with its range and closing speed, altitude and speed in two lines under the scope, clear of the side buttons' labels. Buttons: mode (RWS, TWS), ON/OFF, range up and down, LOCK (the nearest hostile radar contact in the scan, then the next) and BRK. Hot keys: L locks or steps the lock, U breaks it (rule 14: hot actions only).
- **Threat warning format** (`threat`, labeled RWR): the aircraft at the center, nose up; each emitter by its kind at its bearing, close in and boxed (caution) when it tracks the aircraft, inverse (warning) on a launch, farther out while it searches; a ground radar has a bar beneath. Symbols that would overlap move outward, the tracking and launching ones placed first.
- **The HUD's target box.** The locked contact is a world-anchored box with its range in nautical miles under it: spatial and time-critical, so on the HUD (rule 14's allocation). A lock the radar no longer holds breaks, and the HUD says "Lock lost" once.
- **Free Flight traffic** (`freeflight/traffic.ts`, an option, off by default: the start screen's and the pause menu's "Traffic and radars", `traffic=on` in the URL). Two Pact fighters with radars, a Pact strike aircraft without one and an Alliance fighter circle near the base, and two SA-6-like ground radars stand 35–65 km out. Their layout is a hash of the base, so a base always has the same traffic; positions are analytic in game time. Their radars search, and track the player within 35 km (fighters, in their scan) or 25 km (the sites). Nobody shoots. A notional Alliance early-warning aircraft feeds the Kestrel's datalink with every airborne aircraft within 250 km, 5 s late and 400 m off.
- **Navigation's right display** now opens on the radar (still collapsed), since the radar is built: the preset's preference list was already radar first.
- **Visual style.** Part I's scopes paragraph says how a side known from the datalink changes a track's symbol; `docs/visual-style.md` changes with this decision.

The Kestrel's flight is unchanged; the lockstep test passes as it was. `TODO.md`, `docs/plans/displays.md` and `CLAUDE.md`'s directory map change with this decision.

**Reason:** The owner asked to proceed after P2's review. The sensor model has to exist before any format can show a picture without ground truth (rule 12), and Free Flight has no war, so it needs traffic to sense. The radar and the threat warning are the two formats a fighter needs first; the rest wait for weapons (stores), missions (comms) and the elevation renderer.

### 219. Mouse aim keeps the rudder and the stick keys; the chase camera follows the nose sideways

**Date:** 2026-11-17
**Decision:** The owner flew a straight-in approach in the default weather and found the jet pointing well left or right of the flight path marker, the chase camera apparently not lined up with it, and no keys working in mouse aim. With the wind off the offset went away: the jet was crabbing into a crosswind. The default `fair` preset passes the live weather's wind through (over land at 300 m a median of 11 m/s, 18 m/s one time in ten, stronger aloft), and 15–25 m/s across an approach at 150 kt is a 10–15° crab. The owner keeps that wind (an island airfield may be windy) and asked for no landing assist.

- **The camera follows the nose sideways.** It leaned 85% toward the ground velocity, so in a crab it looked along the track and showed the jet from the side. Now it leans toward the velocity only within the aircraft's vertical plane (the approach's angle of attack still puts the runway above the jet); sideways it follows the nose, so a crab is seen as its pilot sees it: the jet straight from behind, the flight path marker off to the side toward the runway. The helicopters' rigs lean the same way.
- **Rudder in mouse aim.** The flight director zeroes the pedals in the air for its turn coordination, which overwrote the rudder keys on every physics step. Free Flight's mouse aim now keeps the pedals the pilot holds; the director itself is unchanged, so the AI, the test pilot and the lockstep fixture are too.
- **Stick keys in mouse aim.** In the air a held pitch or roll key takes that axis from the director, starting from the director's last command, and hands it back over 0.3 s after release (`FlightInput.keyStick`, `overrideStick`); the director then flies back toward the ring. On the wheels decision 217's mouse rotation stands, with a held key still winning.

**Reason:** A crab is real and the marker showed it correctly; seen side-on it looked like a misaligned camera. Rudder and keys are what a pilot reaches for in a crosswind, and mouse aim had taken both away.

### 220. After the owner's review of track W: airfields sited on the eroded world, wonder stations, fewer zone names, rust-red rock, clouds on the drawn ground, lakes without beads

**Date:** 2026-11-17
**Decision:** Seven follow-ups from the owner's flight over the merged track W (`TODO.md`, *W follow-ups*).

1. **Airfields sited on the eroded world** (`worldgen/edits/siting.ts`). The coarse pass places airbases on its 6 km grid, where a coastal cell can be 7 m of flat land. The eroded 1.5 km grid adds the relief the coarse map lacks, so that cell can turn out to be shallow sea or a mountainside. On seed 1983, the first observer station, Vaureko (the Alliance main base of lowest id), lay wholly under 4 m of water; Topriapia was 78% wet; Hatava, Nodapa, Nupu and Wilito stood on slopes whose pads spanned 1–2 km of height. Siting is the airfields' alignment tier, as rule 13 has it for roads. The coarse record stays the campaign fact. Once the global pass is done, a field whose own pad is dry and graded within 20 m RMS stays exactly where it is. Any other field moves to the candidate that minimizes grading RMS + 0.004 × distance + 10 × turn (rad) + 0.01 × elevation (m), all in m of RMS. The candidates lie on rings every 500 m out to 6 km, about one coarse cell, so spur roads still reach the field, with the heading turned up to 45° from the coarse one in 15° steps. Every pad sample, and a ring of samples around the pad's 400 m blend margin, must stand at 4 m or more and outside lakes. The margin matters because terrain edits leave the sea alone (rule 13): a pad graded to its mean height beside a global sea cell kept the sea's samples at sea level and raised the land's beside them, so the owner saw both Kredoth fields on seed 1983 (pads at 359 m and 77 m on a fjord coast) as vertical walls on the cells' staircase, a bite out of the plateau with the runway paint draped down the wall. Where nothing within 6 km grades within 40 m RMS, the search widens to 15 km. The infra scene, the terrain edits, Free Flight's runways and start screen, and the observer stations take the sited runways. The strategic map, the sim's air operations and the spur roads keep the coarse points for now (`TODO.md`). Measured over seeds 1983, 1, 2 and 3: see *Results* below.
2. **Wonder stations.** The selected wonders (`cast.wonders`) join the observer's dropdown as "Wonders · name (kind)", before the switchbacks. The observer stands 7 km from the anchor, the coarse cell's center, so the whole cell is in view. It takes the side of the lowest ground among eight bearings, 600 m up, and looks down at the anchor. Most wonders are not yet shaped in the tiles (decision 214), so the station shows the place rather than a landmark.
3. **Fewer zone names.** A world has about 3,700 zones. The old rule named every zone over about 40 km in the Theater band (some 1,500) and every zone in the Region band, at importances up to 0.95, above cities. Zone importance is now 0.25–0.65 by size (`zoneImportance`), below the places pilots navigate by. Zones of about 50 km and more enter the Theater band, and of about 25 km and more the Region band. Within a band, a zone name gives way to a larger zone's within 250 km (Theater) or 75 km (Region). Seeds 1 and 1983 name 22 zones in the Theater band and about 470 in the Region band, before collisions.
4. **Rust-red rock.** The red rock desert's base color was `#C9673F`, a hue of 17°. The dry ground's tint (× 1.12, 0.86, 0.72) pushed it further toward red, and a zone's hue shift of up to −10° reached about 7°: salmon, which read as pink. The red rock shades are now `#A85E36`, `#B46A3C` and `#C98552`, and the strata shades `#B06A3A`, `#C4925C`, `#965532`, `#D6BC8E` and `#A0603A` with `#A06A48` shale (hues 21–28°). The tint is × 1.08, 0.9, 0.74. Zone hue shifts on warm hues (under 50° or over 330°) go only toward orange. The map's red rock fill is `#D09A6C`.
5. **Clouds on the drawn ground.** Cloud bases, fog and dust stood on the weather climate's `ground`, the mean of the tectonic map's heights per 65 km weather sample. That map's ranges reach about 2 km, against 10 km on the eroded grid (land mean 213 m against 974 m on seed 2). So decks sat kilometers below the peaks, and the owner never saw cloud at the height of the tallest mountains. Once the global pass is done, the weather texture's ground is the mean eroded height over each sample's footprint (`meanGround` in `sim/weather/climate.ts`), so a range's cloud bases rise with it. The render and Free Flight previews do the same. The sim's own weather (the ceiling the AI and the HUD read) still uses the tectonic ground (`TODO.md`).
6. **Lakes along diagonal valleys stay ribbons.** Most lake cells on seed 1983 join their lake only at a corner. The tile kernel's lake share is bilinear in the lake bit, and between two cells that meet at a corner it falls to 0.5 − 2s² at a distance s (in cells) from the diagonal, so the shore threshold (about 0.42) pinched each joint to a neck about 800 m wide between round lobes: ponds on a thread. `lakeFraction` now takes the larger of the bilinear share and a bridge along each diagonal pair, 1 − 0.7 × the distance off the diagonal, so the kernel does not raise the ground between them, and water stands there wherever the ground is below the lake's level.
7. **Small lakes silt up.** The round lakes linked by rivers were erosion pits. On seed 1983, 1,475 of the 1,889 open lakes (8-connected cells at least 3 m deep) covered fewer than six global cells, typically 20–60 m deep, and many sat on rivers. The drainage filled each pit into a lake, and the tile kernel drew it as a round pond. The drainage now has a sixth step, used only on the global grid (`SILTED_LAKE_CELLS` = 6, about 14 km²): an open lake of fewer connected cells is filled to the Priority-Flood surface, which already slopes toward the outlet, so receivers and discharge are unchanged. A lake is judged by its own cells, not its depression's: a wide, shallow hollow can hold several pits, each drawn as a pond of its own. Seed 1983 keeps 414 open lakes, none smaller. The global pass writes the raised cells back to its height map on the GPU. Closed basins keep their salt lakes and playas. The coarse pass is unchanged, so campaign facts do not move. `GENERATOR_VERSION` is 34.

**Results:** `tools/airbaseWater.preview.ts` measures each base's pad on the eroded grid before and after siting (17 × 5 samples; bad means any sample wet or a grading RMS over 60 m):

| Seed | Bases | Bad before | Moved | Bad after | Left wet | Farthest move |
| --- | --- | --- | --- | --- | --- | --- |
| 1983 | 59 | 11 | 15 | 1 | 0 | 11 km |
| 1 | 75 | 13 | 22 | 0 | 0 | 5.5 km |
| 2 | 75 | 4 | 20 | 0 | 0 | 4.5 km |
| 3 | 56 | 2 | 6 | 0 | 0 | 6 km |

Siting takes 0.3–1.7 s per world on the main thread. On seed 1983, Vaureko moves 6 km onto ground at 75 m, Kredoth Airfield 3 km to 826 m and Kredoth Air Base 11 km to 533 m, all within 26 m RMS. The one base still bad is Hatava Air Base, on a mountainous island (127 m RMS, from 528). Topriapia Air Base takes a flat summit at 4,700 m. Fields like these are the coarse pass's to avoid (`TODO.md`). In renders of seed 1983, overcast lies among the high ridges of the `alpine` view with the summit above it, and the buttes read sienna and burnt orange.

**Reason:** The owner's review of track W.

### 221. Runway shoulders, spur roads to sited fields, the wonders shaped in the tiles

**Date:** 2026-11-17
**Decision:** The next of decision 220's follow-ups, done while the owner was away.

1. **Runway shoulders.** Fields were hard to spot from the air (owner's review). The pavement coverage in the terrain shader (`RoadShading.coverage`) now returns a third channel: a band 12 m wide, and at least 2 px on screen, outside concrete whose half-width exceeds 15 m. That covers runways (22.5 m) and aprons (70 m), not taxiways (11.5 m). The terrain draws the band dark (about `#3C3A37`, wet like the pavement). It costs no extra loop over the segments.
2. **Spur roads to sited fields.** Siting (decision 220) now runs before the alignment stage, on the strategic world the app aligns and draws. Where a field moved, the end of its spur road moves to the sited point (`resiteSpurs`), and the router aligns the last leg over the terrain. A field whose cell lay on the road network had no spur and gets a new one from its coarse point, appended so the spur bridges keep their indices. `ALIGNMENT_VERSION` is 3. The sim, the strategic map and the stored world keep the coarse record. The map stays with the sim on purpose: its flight routes start at the sim's bases.
3. **Not done: the coarse pass avoiding exposed coasts.** After siting, one base in four seeds still grades badly (Hatava on seed 1983). Keeping main bases off coastal cells with sea on most sides would fix such cases at the source, but it moves every world's airbases, a campaign fact. That is left to the owner (`TODO.md`).
4. **The sim's cloud base.** The sim's weather gives the cloud base above the ground, and its readers add the ground under the aircraft, so decision 220's worry about the tectonic ground did not apply there. Free Flight's sensor visibility compared that base with the altitude above the sea; it now subtracts the ground.
5. **Wonders shaped in the tiles** (W8). The selected wonders reach the tile synthesizer as `TileSynthOptions.wonders`: anchor, kind and the eroded height there. The kernel already uses all eight storage bindings, so they are baked into its WGSL as constants.
   - **Siting** (`siteWonders`). A wonder's anchor is a coarse cell's center, and the eroded world can put a mountainside or a valley there. The first renders showed the cost: a monolith raised from its anchor's 2,662 m on a coastal mountain drew a flat cylinder with vertical walls over the plain beside it. The shaped kinds now move up to 8 km, to where the ground on a ring 1.3 shape radii out and under the shape is most even: dry land for a tepui, caldera or monolith, sea 2–40 m deep for a blue hole. The shape stands on the ring's mean height, and the observer's station looks at the sited point. Lower ground counts a little (0.01 per m), as these landmarks rise from plains. Where even the best site varies by more than 60 m RMS, the tiles leave the wonder unshaped: on rough ground the shapes drew walls, not landmarks. No land wonder stands in a lake, salt lake or playa: seed 2's caldera, first sited on a flat 2 m site, was on a lake and now stays unshaped. Over seeds 1983, 1 and 2, that keeps one caldera (Keimen Crater, 38 m) and a blue hole (1 m). Two calderas and three monoliths stay unshaped (83–420 m, or no dry site). In renders, Keimen Crater is a forested cone holding its crater lake. The blue hole is a dark patch a few mesh cells across, not yet a clean circle. Stations now take the bearing (of 16) whose sight line clears the ground best, the lower eye breaking ties, and raise the eye over what still blocks it.
   - **Order.** `shapeWonders` runs after the rivers cut their channels. Run before them, a river's valley cut through a caldera's rim and left its crater lake standing in the air. Only a river's channel keeps its cut, a gorge through a wall or rim, and the crater lake stands only inside the bowl (x³ < 0.6), so a gorge drains none of it (rule 15: a wonder shapes the tiles on top of the layers).
   - **Tepui:** a table of radius 3.2 km (±22% on a warped outline), 900 m above the ground, walled over 160 m.
   - **Caldera:** a rim 3.5 km out and 350 m high, a bowl 300 m deep holding a crater lake at 60% of its depth, through the kernel's lake output.
   - **Monolith:** a dome 1.6 km in radius and 380 m high, with flanks of `(1 − x⁶)^0.3`.
   - **Blue hole:** a shaft of radius 280 m, 125 m deep.

   Falls, travertine and mineral bands, and the prop wonders, wait (`TODO.md`). The global grid does not carry the shapes, so the CPU height function knows them only once a tile has loaded. The render preview frames every selected wonder with `WONDERS=1`.

`docs/design.md` and `docs/visual-style.md` (*Base kit*, *Natural wonders*) change with this decision.

**Reason:** The owner's review asked for visible fields and findable wonders; the station of decision 220 showed the place, and this makes most of the shaped kinds into landmarks.

### 222. The pin and minimize are the frame's icons, not bezel buttons

**Date:** 2026-11-18
**Decision:** The owner's review of P3a: MIN and the pin took two of the top row's bezel buttons on every display (decision 217). They are now small icons in the bezel's top corners, drawn by the frame rather than by the format: the pin at the left, upright and in the phosphor color while the slot is pinned, tilted and gray otherwise; minimize at the right, a bar for the tab the display collapses to. The top row of buttons spans between the icons, so all twenty bezel buttons (five on small displays) belong to the format again. The display model carries `pinned`, and the view issues the same UI commands as before (`pin`, `toggle-slot`). `docs/visual-style.md` (Part I, *Displays and Status Strip*, one frame) changes with this decision.

**Reason:** The owner's review. Pin and minimize act on the slot, not on the format, so they belong to the frame, and the formats need the buttons.

### 223. The radar's second step: air combat mode, click to lock, ranges by skin, the threat warning's calls

**Date:** 2026-11-18
**Decision:** P3b begins with what the radar and the threat warning still lacked after decision 218.

- **Air combat mode.** Dogfight (the F key or M) puts the radar in air combat mode (`acm`): it scans a 10° cone about the nose out to 10 nm every 0.2 s (contacts coast 2 s) and locks the nearest radar contact it finds there, with no key (`acmAcquire`; the host issues the same `radar-lock` command a key would). Breaking a lock in a dogfight returns to the cone; leaving the dogfight, by F or by any other master mode, returns to range-while-search, and a lock held across keeps its single-target track. The scope draws the cone's limits as two dim vertical lines and shows 10 nm (20 km in Pact skins); the HUD draws the cone as a dashed circle about the boresight until the lock, a spatial cue and so the HUD's (rule 14).
- **Click to lock.** A display model may carry hit spots (`ScreenItem` kind `hit`: a point, a radius and a display command), drawn as nothing. A click on the screen within one issues its command. The radar puts one on each radar contact that is not a friend and not locked, so with the mouse free a click on a contact locks it. This is the mouse half of the designation cursor; a cursor moved by keys waits.
- **Ranges by skin.** The radar's range steps are 10, 20, 40 and 80 nm in Alliance skins and 20, 40, 80 and 150 km in Pact skins, one step index for both (`radarDisplayRange`): a skin changes units, never layout (rule 14). The snapshot carries the display range in meters.
- **The threat warning's calls** (`ui/displays/calls.ts`, pure). A new emitter is called once in the messages ("SA6 search radar, 3 o'clock"), with two short beeps; one that starts tracking the aircraft is called again as a warning ("SA6 tracking, 3 o'clock") with three higher beeps; a launch gets a fast warble (no emitter launches until P4). An emitter that goes quiet and returns is new again. The tones are synthesized in the app's one audio context (`WeatherAudio.cue`), at the master volume, silent while paused.

`docs/visual-style.md` (Part I, *HUD*, world-anchored symbols) and `TODO.md` change with this decision.

**Reason:** The owner approved the radar's look and controls and asked to proceed. A dogfight radar that locks by itself is what makes the dogfight master mode worth having, and the RWR's calls let the threat display stay small and collapsed without the pilot missing a new threat.

### 224. Avionics profiles for every type of the air war

**Date:** 2026-11-18
**Decision:** Every type in the air war's table (`sim/air/aircraft.ts`) has an avionics profile, in `sim/avionics/typeProfiles.ts`, keyed by type id. `AVIONICS_PROFILES` keeps model-spec keys only for what Free Flight flies (the Kestrel is the F-21's profile; the two helicopters are not in the table yet). The profiles stay in code rather than moving into the model specs, as decision 199 planned: most types have no model yet, and a spec describes how an aircraft looks.

The complements follow the proposal's examples:
- **Air superiority fighters** (F-15C, F-14A, Su-27, MiG-29 analogues): the air-to-air radar on the right display; moving map, stores and engines on the left; datalink. The Su-27 analogue's profile marks its radar picture for the HUD as well (`hudRadar`); drawing it waits for that aircraft to be flown.
- **Multirole fighters** (F-16C, F/A-18C analogues): the full complement, air-to-air and air-to-ground radar and a targeting pod.
- **The early fighter** (MiG-23ML analogue): no moving map, its radar in a round scope bezel, navigation on the HUD.
- **Strike aircraft with crew** (F-111F, A-6E, Su-24M analogues): the air-to-ground radar first on the right display, the terrain-following system and a targeting pod. The crewmate's ownership of that display waits for P5.
- **Attack aircraft** (A-10A, Su-25, F-117A analogues): no radar; the F-117A's pod.
- **The F-4G analogue**: a pulse radar without look-down and the threat display, which is its weapon.
- **Bombers, AEW, tankers, transports**: the moving map and their radar or airdrop format; crews as roles.
- **Attack helicopters** (AH-64A, Mi-24V analogues): the gunner sight; **heavy helicopters** (CH-47D, Mi-26): the hook camera; both with rotor gauges.

Radar figures are the detection range against a 5 m² fighter, from approximate public figures: 100 km for the F-15C and Su-27 analogues, 150 km for the F-14A's, 80 km for the F/A-18C's, 70 km for the F-16C's and MiG-29's, 55 km for the MiG-23ML's and F-4G's. Pact sets have wider Doppler notches (50–90 m/s against 40), so they lose more beaming targets in look-down. Free Flight's Pact fighters take the MiG-29 analogue's radar (it was a placeholder of 60 km). Two formats join the list without a drawing yet, the gunner sight and airdrop; an aircraft that lists them shows its other formats until they exist. `TODO.md` and `CLAUDE.md`'s directory map change with this decision.

**Reason:** P3's step 2. The sensor model needs each type's radar to be what the AI and a followed aircraft see with, and P5's crews and the follow mode need a profile for whatever aircraft the player picks.

### 225. Landform props, first kinds: tower karst, sandstone pillars, inselbergs; crater lakes with outlets

**Date:** 2026-11-18
**Decision:** W7's first version, and the owner's note on Keimen Crater.

1. **The `column` part.** Model specs gain a vertical column of rings: per ring a height, a radius and an (x, z) offset for lean and bulge, a radial jitter, a closed base and an optional peak. Landform props are a model class of their own, `prop`, at 30–200 triangles (Part I's budgets).
2. **Kit.** Each kind has a full and a far version: karst tower (148 m at scale 1, an undercut base, a lean and a green cap; 80 and 34 triangles), sandstone pillar (88 m, a hoodoo with its darker caprock; 64 and 32) and inselberg (133 m, a dome 250 m across; 70 and 34).
3. **Placement** (`worldgen/props.ts`, pure, `rng(seed, "props")`). One candidate per cell of four level-7 samples (about 190 m), at a hashed spot, with a hashed scale and turn. It reads the landform and biome layers only (rule 15):
   - **Tower karst:** in limestone or karst platform, 0.3 per cell under a wet, warm biome, 0.03 elsewhere.
   - **Drowned towers:** in sea up to 40 m deep with limestone within about a global cell, 0.22 per cell.
   - **Pillars:** in layered sandstone in a dry biome, 0.05 per cell.
   - **Inselbergs:** on granite of shields and old mountains under savanna, desert, scrub or grassland, on slopes under 8%, 0.006 per cell.
   - **Clumping:** a value noise of about 1.5 km scales the chance from none to twice the mean, so props stand in fields with gaps.
   - **Wonders:** karst-bay and pillar-forest wonders raise the chance to 0.5 at the wonder, falling off to 6 km. These two kinds of wonder are now fields of props.
   - **Exclusions:** lakes, river water, and the infrastructure's clearings, widened by a quarter of the prop's height.
4. **Layer** (`render/sim/props/propLayer.ts`). A level-7 data tile is one chunk, placed once when it comes within reach. One instanced mesh per kind and level of detail: full models within 2.5 km, far ones to 8 km, none while the eye is more than 9 km over the ground. A prop sinks to the lowest ground under its footprint, so it stands on slopes. Flat-shaded under the planet's light, with aerial perspective, anchored at the eye (rule 4). At Fust Towers on seed 1983: 1,300 props in 2 draws, 0.05 M triangles.
5. **Props are obstacles.** Each placed prop is also a collision cylinder: its axis, foot and top, and a radius of 21 m (tower), 16 m (pillar) or 105 m (inselberg) times its scale, indexed by prop cell. `PropLayer.obstacleAt` returns the top of the column over a direction, and Free Flight's ground (`AirfieldGround`) takes the higher of the terrain and that top. The same ground serves the flight model's contact, the chase camera's clearance and the sensors' line of sight, so a tower can be hit, the camera rides over it, and it blocks a radar's view. A drowned tower's surface is land, not sea. Only tiles already placed near the eye answer, which covers the flown aircraft. A prop on a neighboring tile is missed within a cell of the edge. The flight model itself is unchanged, and the Kestrel lockstep with it.
6. **Not yet.** Sea stacks, arches and basalt columns, snow on props, zone tints.
7. **Crater lakes with outlets.** On Keimen Crater the owner saw a deep river beside the lake that never reached it: the river's channel kept its full cut through the rim (decision 221). Within a caldera, a river's channel now stays under the lake inside the bowl. Through the rim it starts at the lake's surface and falls 0.12 m per m to the valley. The river fills the lake and leaves by an outlet.
8. **Stations.** A caldera's station stands at least 900 m above the wonder's ground plus 400 m, so its lake shows from above. Other wonders keep 200 m.

`docs/visual-style.md` (*Landform Props*, *Natural wonders*) and `docs/design.md` change with this decision; `TODO.md` lists what is left of W7.

**Reason:** W7 is track W's most striking landscape that the height field cannot hold, and the karst-bay and pillar-forest wonders waited for it.

### 226. The air-to-ground radar's ground map

**Date:** 2026-11-18
**Decision:** The air-to-ground radar format (`radar-ag`, labeled GMR) shows a ground map: a B-scope of the ground ahead, azimuth across (±60°) and ground range up, the returns as the phosphor's intensity.

- **The model** (`sim/sensors/groundMap.ts`, headless and deterministic). Each of 72 columns is a ray along the ground; each of 60 cells along it is in radar shadow when nearer ground stands higher in the radar's view, else it returns by the grazing angle between the beam and the local slope, divided by level ground's at that range (the receiver's gain rises with range, as sensitivity time control does), so level ground paints an even gray, slopes facing the aircraft bright and slopes facing away dark. Water reflects the beam away and paints nearly black, so coasts, lakes and islands stand out. Hard surfaces return strongly: in Free Flight, runways and graded airfield pads. A fixed speckle per 150 m patch of ground gives the grain without flicker. The ground enters through the host's height and water queries, through the one height function (rule 13).
- **In Free Flight** the map is painted from the drawn ground every 2 s of game time while a display shows it (about 4,300 height queries), and carried in the snapshot with its age; a map older than 6 s says NO UPDATE.
- **The format.** The raster fills the scope; range ticks at quarters, the aircraft's mark at the bottom center, the range at the left, the destination as a diamond where it lies on the map. Buttons: RNG▲ and RNG▼ step the range, 5, 10, 20 and 40 nm (10, 20, 40 and 80 km in Pact skins), an avionics command (`ground-radar-range`). Display models gain a `raster` item (intensities 0–255, plain data).
- **A preview** (`tools/groundMap.preview.ts`) paints the map over a generated world's coast beside a height map of the same sector, and writes the map as JSON for the displays page (`&gmr=`).

Moving-target mode waits for ground vehicles, and the terrain-following scope for an aircraft that carries the system to be flown. `docs/visual-style.md` (Part I, scopes), `TODO.md` and `CLAUDE.md` change with this decision.

**Reason:** P3's air-to-ground radar, the format the strike aircraft's profiles (decision 224) put first on their right display. Its picture comes from the same terrain the aircraft flies over, so a pilot can navigate by it at night or in cloud.

### 227. The moving map's elevation modes, sampled; sensors read resident tiles only

**Date:** 2026-11-18
**Decision:** The moving map gets its elevation and relative modes, a third button on its right edge stepping CHRT, ELEV and REL (a UI command, `map-mode`).

- **Sampled, not drawn.** The plan had the simulation view's resident tiles drawn again by an orthographic camera with an elevation material. Instead, Free Flight samples the one height function (rule 13) on an 80 × 80 grid in the map's own frame (turned with the track in track-up), every second, on a new range, or when a track-up map has turned 3°, and carries the heights in the snapshot (`SnapshotTerrain`). The format (`ui/displays/elevation.ts`, pure) colors them: Part I's tints with a gentle hillshade, contours every 100 m (500 ft in Alliance skins, every fifth darker), a spot height at the highest ground in view; in the relative mode, red with a diagonal hatch above the aircraft's altitude, amber within 500 ft below it, gray-green shading clear below, water blue-gray throughout. Display models gain colored rasters. Until the first samples arrive the chart stays. Sampling keeps the format a pure function of plain data, testable without a GPU, and costs no second render pass; an 80-cell picture is coarse at 5 nm (about 230 m a cell), so the camera remains the way to a finer one if the owner wants it.
- **Pact ranges.** The moving map steps 10, 20, 40, 80, 150 and 300 km in Pact skins, as the radars do since decision 223 (`mapRange`).
- **Sensors read resident tiles only.** `TerrainRenderer.displaySurfaceAt` asks for the level-7 tile under any point it has not loaded. The sensors' queries reach tens of kilometers (line of sight to 70 km since decision 218, the ground map to 40 nm since decision 226, the elevation map to 160 nm), so they would have asked the tile synthesizer for hundreds of distant tiles. They now go through `AirfieldGround.sensedHeight`, which reads resident tiles without fetching (`displaySurfaceAt(dir, false)`) and the graded global grid elsewhere. The flight model, the camera and the shadow keep the fetching query.

`docs/visual-style.md` (Part I, *Moving Map*), `docs/plans/displays.md` and `TODO.md` change with this decision.

**Reason:** P3's elevation mode, the low-level pilot's question of which ridge is in the way, done the cheapest way that keeps display models pure. The tile requests were a defect in decisions 218 and 226, found while measuring this one's cost.

### 228. Proposal 0008 accepted: the game loop and campaign; `docs/roadmap.md` replaces the milestone sections

**Date:** 2026-11-18
**Decision:** Proposal 0008 (`docs/proposals/0008-game-loop-and-campaign.md`) is accepted as written. Its decisions hold: a tech demo of one day of war in one theater with CAP, interdiction, CAS and airlift; a ghost player with a named pilot; a survivor and a CSAR mission for every ejection; campaigns of two to four weeks; an aggregate naval war; multiplayer later, kept possible by an event log from the demo on; saves in IndexedDB with export; battalions in aggregate with minimal entity promotion in the demo.

`docs/roadmap.md` is now the source of truth for what to build next. It orders the work in phases R0–R6 (audit, consolidation, one day of war, combat depth, breadth, dynamic campaign, polish), each with milestones, dependencies, exit criteria and sizes, and maps the earlier tracks (F, S, C, V, I, P, H, N, G, W) onto them. `docs/design.md` (revision 12) takes the proposal's game loop, plug-ins, bundles, calibration, player identity, ejection and CSAR, campaign and persistence, adds the utility helicopter role and the new mission types, and replaces its demo goals, milestones and out-of-scope list with pointers. The roadmap sections of proposals 0001–0004 and 0006 become pointers; the plans keep their milestone breakdowns as task lists, scheduled by the roadmap. `TODO.md` is rewritten from the roadmap; the previous one is archived unchanged in `docs/status/todo-2026-11-18.md`. Decisions before this one keep their milestone names.

**Reason:** the world and a flyable aircraft exist; the war that plans, fights and resolves itself does not. The tracks had grown to ten, several marked "after the demo" although the new demo needs parts of them (player flight, weapons, helicopters for CSAR, bridges with damage). One roadmap built around the game loop replaces them.

### 229. The audit of 2026-11-18: status, health and documents reconciled with the code

**Date:** 2026-11-18
**Decision:** `docs/status/audit-2026-11-18.md` records the state of every proposal section and task document (224 items: 89 done, 60 partial, 63 missing, 12 diverged), test and build health, known issues, technical debt, a performance baseline, the divergences between documents and code, and the decisions for the owner. The documents now describe what the code does: `design.md` marks unbuilt features as planned (per-province soft limits, cirques, aspect, oases, shoreline rings, four prop kinds, bridges as network nodes, railway-first alignment and spirals, canopy line of sight and tree strikes, master-mode declutter, the AI's use of the sensor picture, the wonder glyph) and corrects settled ones (one soft limit and 10 km peaks, eager alignment, avionics profiles in code, the centered stick in cursor mode, Free Flight's helicopters and traffic); `CLAUDE.md`'s directory map, `README.md`'s project state and Free Flight bindings, and `visual-style.md` follow. Each proposal 0001–0007 and each plan carries a dated audit note under its header listing what later decisions changed; proposals are not reformatted. Decision numbers used twice (21, 40, 147) are suffixed a and b in their headings. Stale comments in code are listed in the audit, not edited.

Health on 2026-11-18: type check and lint clean; 1,106 CPU tests pass; on lavapipe 97 of 98 GPU tests pass, the cube-face seam test failing as before (0.102 m against 0.05 m); the production build and the last ten deploys succeed. Over seeds 1–20 on generator version 34, 19 worlds have a continental front.

**Reason:** proposal 0008's roadmap needs to start from what exists, and the documents had drifted from the code in both directions: features stated as present that are not, and settled choices still described the old way.

### 230. Mission plug-ins, aircraft bundles by type id, calibration and the event log as rules

**Date:** 2026-11-18
**Decision:** `CLAUDE.md` gains rules 16–19 from proposal 0008. A mission type is a plug-in with eight parts and is complete only with all of them. An aircraft type is a bundle; since avionics profiles live in code (decision 224) and most types have no model spec yet, a type registry keyed by type id joins the parts (spec, profile, air-war entry, calibration values) and its test lists what each type lacks, which meets the proposal's intent of one place per type without moving profiles into JSON. Aggregate tables are fitted from full-fidelity runs by a script and checked by a tolerance test, never tuned by hand. Every player input and campaign decision is a logged event, a full-fidelity session's consequences return as logged events, and sim state is serializable.

**Reason:** these are the parts of proposal 0008 that every later session must follow, so they belong with the other rules rather than only in the design document. The registry reconciles the proposal's bundle with decision 224.

### 231. Provisional scoping of the tech demo, pending the owner's answers to the audit

**Date:** 2026-11-18
**Decision:** The audit lists eighteen decisions for the owner (`docs/status/audit-2026-11-18.md`, *Decisions for the Owner*). Until the owner answers, the roadmap follows the recommendations: the flown or followed aircraft steps on the main thread and its session's consequences return to the worker as logged events; a type registry joins each type's parts; the demo adds a rotary director, an AI helicopter pilot and a utility helicopter role for CSAR, with player-flown campaign helicopters in R4; the UH-68's name changes; the Kestrel, Vo-31 and Vo-35 are flyable, the A-15 and C-150 if time allows; the demo's weapons are a gun, one IR missile per side, unguided bombs with CCIP and rockets; network bridges stay the only targets, drawn at their matched crossing or on their aligned road; full fidelity and the simulation view use sited runways while the campaign keeps coarse points; AI sensing reads the global grid plus edits; interdiction strikes fixed targets until the intelligence picture (R3); the player is a ghost until morale and reputation (R5); following cuts to the chase camera, with the dissolve in R6; fixed-wing jump-in runs from climb-out to approach; mouse aim keeps decision 198's scheme; non-fly-by-wire types get their own control laws; peaks of about 10 km are accepted. The demo seeds are 4, 10 and 7, the highest front fits on generator version 34.

**Reason:** the audit ran unattended. These are the most reasonable choices that keep the roadmap concrete; each answer from the owner that differs becomes its own decision and moves the affected roadmap tasks.

### 232. The owner's answers to the audit: recommendations accepted; every aircraft type one JSON bundle

**Date:** 2026-11-18
**Decision:** The owner answered the eighteen decisions of the audit (`docs/status/audit-2026-11-18.md`). Seventeen follow the recommendation, so decision 231's provisional scoping stands as decided: full-fidelity flight on the main thread with its consequences logged back to the worker (1a); a rotary director, an AI helicopter pilot and a utility helicopter role in the tech demo (3a); the UH-68 renamed (4); the Kestrel, Vo-31 and Vo-35 flyable, the A-15 and C-150 if time allows (5b); the demo's weapons (6); network bridges as the only targets, drawn at their match or on their aligned road (7b); sited runways for full fidelity and the simulation view (8a); AI sensing on the global grid plus edits (9a); fixed interdiction targets (10); a ghost player until R5 (11); a cut into the follow (12); fixed-wing jump-in from climb-out to approach (13); decision 198's mouse aim (14); per-type control laws (15a); validity counting placed airbases in R5 (16); peaks of about 10 km accepted (17); `main` for routine work and pull requests for roadmap-level documentation (18).

On decision 2 the owner chose (b) over the recommended type registry: every aircraft type is one JSON bundle in its model spec, holding geometry, flight data, the avionics profile, pylons and loadouts, role tags, crew roles, the camera rig, calibration values, and faction, name and skin. This supersedes decision 224's placement of the profiles in `src/sim/avionics/typeProfiles.ts` and decision 230's registry; roadmap R1.7 moves the 31 profiles and the air-war table (`src/sim/air/aircraft.ts`) into the bundles, behind one loader that the sim worker and the renderer share, with the air war's determinism hash unchanged. Types without geometry yet get a bundle without it. `CLAUDE.md` rule 17, `docs/design.md`, `docs/roadmap.md` and `TODO.md` change with this decision.

**Reason:** proposal 0008 asks for one place per aircraft type, and the owner prefers that place to be the type's data file rather than a join over code and data.

### 233. Tile samples on a cube-face seam computed alike from both faces

**Date:** 2026-11-19
**Decision:** The tile kernel computes a sample's direction with `tileSampleDir` (`src/worldgen/gpu/tileSynth.ts`) instead of `faceUvDir`. The warped coordinate comes from the sample's integer index, `s = (2k − n) / n`, is evaluated as `sign(s) · tan(π/4 · |s|)` and is exactly ±1 on a face edge. A sample on a seam is then the same float32 vector whichever face's tile computes it, and `tests/gpu/tileSynth.test.ts` now requires the two tiles' edge heights to agree bit for bit (it allowed 5 cm and measured 10.2 cm on lavapipe). This closes R1.1's first task.

**Reason:** the seam's error came from the directions, not from the masks' sampling across faces that decision 215 suspected. `faceUvDir` rounds `tan(π/4)` to a value other than 1 and rounds `u` and `1 − u` apart, so the two faces placed one edge sample about half a meter apart (the float32 resolution of a unit vector times the planet's radius). On the steep sea floor by a coast, half a meter of position is 10 cm of height. With identical directions every later step of the kernel sees identical inputs. Other samples move by at most one float32 step of direction (centimeters on the ground, well below the tile's 48 m spacing at level 7); no hash pins tile heights, and the cell-center directions of the global grid still use `faceUvDir`, so no world changes.

### 234. The front generator's flake is a V8 on-stack-replacement fault on Node 24: the side sums leave their closure

**Date:** 2026-11-19
**Decision:** R1.1's second task found the cause of the front generator's determinism flake (decision 86) and works around it. `lineFromPath` (`src/worldgen/strategic/fronts.ts`) summed each side of a barrier line in a closure mapped over `[0, 1]`, with a loop over every cell of the landmass inside. On Node 24, now and then, one call of that closure returned the sums of another call: side 0 got side 1's area, or side 1 got the area of an earlier line's side. The line's points, path and side assignment were right; its side areas, fractions, centroids and depths were not, which then moved the start line, the cast and the territory. The sums now come from `lineSides`, a top-level function without closures that sums both sides in one pass over the cells. Its results are bit for bit those of a correct run, so no world changes and `GENERATOR_VERSION` stays 34.

Two aids stay. While `frontTrace.sink` is set, `buildFronts` appends one line per step with exact values: hashes of its inputs (grid, labels, height, discharge, slope, forest, lakes, barrier map), the projection, the axis and band, the coastal arcs, and every path search with its end, cost, path, sides and areas. The generator never reads it. `traced` and `firstTraceDifference` (`tests/helpers/syntheticWorld.ts`) wrap a build, and the three determinism tests that failed in CI compare traces before graphs. The deploy workflow gains a `determinism` job (`continue-on-error`, so it never blocks a deploy) that runs those tests and `tests/militaryOverlays.test.ts` in 20 fresh processes. The build job prints the runner's CPU. `riverWorld` moves into the test helpers.

**Evidence.**

- **CI after decision 86** (runs 29–206, 174 completed): 10 runs failed a determinism test with one of three messages, each byte-identical every time it recurred. They were `barrierLines[0].points: length 123 vs 147` (seed 7, 7 runs), `barrierLines[1].sides[0].area: 590961974046.4445 vs 581466718196.9407` (the river world, 2 runs) and a different `settlementSide` (1 run). Five more failed `tests/militaryOverlays.test.ts` with 2 lanes for 3 theaters on seed 1. CI runs Node 24.
- **Reproduced locally.** Two builds of the river world in a fresh process diverged in 9 of 200 processes on Node 24 (v24.22.3) and in none of 200 on Node 22. Fifty runs of the two test files on each version gave two failures on Node 24 and none on Node 22. One failure ran with the trace: the same path, cost and side hash, side 0's area equal to side 1's.
- **The compiler.** With `--no-maglev`, `--no-turbofan`, `--no-maglev-osr` or `--no-use-osr`, 200 of 200 processes agree. The fault needs on-stack replacement into optimized code while the closure's loop runs, during a process's first builds; builds repeated in one process after that run optimized code and never diverge (156 such builds clean).
- **Not rounding.** Raising or lowering every call of each of twenty `Math` functions by one ulp during the build leaves every line, point count and area unchanged. Decision 86's change to the projection could not have fixed the flake, and its fallback (quantizing the band) would not have either.
- **The fix.** With `lineSides`, 1,000 fresh processes on Node 24 agree (the old code's rate predicts about 45 divergences). `tests/militaryOverlays.test.ts` passed 100 of 100 runs on Node 24 both before and after, so whether its CI failures share this cause is open; the CI job runs it too.

**Reason:** the fault is in V8, so the fix avoids the code shape that triggers it. A small closure created per call, holding a hot loop, is what on-stack replacement got wrong. A plain function with explicit arguments gives the same sums without depending on the engine. Other closures with hot loops may hide the same fault, which is why the trace and the CI job stay: the trace names the first step that differs, and fresh processes are what expose this kind of fault. The job can go once CI has been clean for a few weeks.

### 235. Campaign state that can be saved: one structured-cloneable state, checkpoints and an input timeline

**Date:** 2026-11-19
**Decision:** R1.2. Every part of the campaign simulation saves and restores its state, and seeking uses saved states instead of rebuilding the world.

- **State inventory.** What changes as the campaign runs, and where it is saved:

  | Owner | Saved state | Rebuilt from the configuration |
  | --- | --- | --- |
  | `Simulation` | clock, events and ticks run, live queue entries with their sequence numbers (ticks name their process) | handlers, processes |
  | `EventLog` (`sim.log`, new) | every input and decision | — |
  | `WeatherModel` | systems of the latest hour and the hour before, the hour, the next system id | noise, grid, frame cache, view |
  | `AirOps` | squadron strength and availability, base stocks, live missions in launch order, launched and completed counts, aircraft in turnaround, next mission and package ids, revision | order of battle's structure, carrier tracks (analytic) |
  | `InterimTasker` | when each target was last struck, how long each standing station is covered | front stations |
  | `SimHost` | input timeline, checkpoints | rate and auto-slowdown are player settings, not campaign state |

  The flight, avionics and sensor state of Free Flight is not in the campaign yet; R1.5 moves it into the sim.
- **RNG.** Every draw in the campaign sim already comes from a fork keyed by its path (`ato/<side>/hour-<k>`, `weather/h<k>`, the order of battle's forks), and a fork depends only on the seed and the path. No generator state needs saving, so none is exported.
- **Saving.** `Stateful` (`save`, `load`) is implemented by the weather model, the tasker and `AirOps` (registered with `sim.addState('air', …)`); processes with both methods register themselves. `Simulation.save()` returns a `SimState`: format, clock, counters, queue and each part's state by name, copied with `structuredClone`. `Simulation.load()` puts it into a world built from the same configuration and refuses a state with another format, an unknown process or a missing part. `EventQueue.save`/`load` keep sequence numbers, so ties still break in scheduling order.
- **Event log.** `src/sim/eventLog.ts` types the log: player inputs (`alarm` for now) and campaign decisions (`mission-launched`, logged by `AirOps.launch`). Inputs are replayed, decisions only recorded, so a replay that logs another decision has diverged and the log shows where. The log is in the saved state and the state hash.
- **Host.** `SimHost` takes an input handler (`applyInput` in `world.ts`) and records every player input on a timeline. It saves a checkpoint at campaign start and at each multiple of six game hours, keeping at most 64 and thinning every second one past that. A backward seek restores the latest checkpoint at or before the target and replays the timeline's inputs; this fixes the alarms that the rebuild from campaign start used to drop. A seek moves along one timeline and does not branch it: inputs after the target apply again when the clock passes them, and an input made after a backward seek joins the timeline in time order and drops the checkpoints after it. `SimHost.save()`/`load()` hold a whole campaign (the state, the timeline and how much of it is applied); a loaded campaign seeks no further back than its saved time.
- **Flagged stops.** `advanceTo(…, stopOnFlag)` now finishes every entry at the flagged event's time before returning, so a stopped simulation is in a state that `advanceTo(time)` also reaches, and an input made there replays exactly.
- **Worker.** `saveState` asks for the host's state and is answered by a `state` message with the hash (`SimClient.saveState()` returns a promise); `loadState` replaces the campaign and is followed by a snapshot with a hash. Alarms go through `host.input`.

**How it was checked.** `tests/simState.test.ts`: 6 h, save, restore, 6 h more gives the 12 h hash on a generated world with the air war, in steps of 1 s, 16 s (64× at the worker's longest step) and 10 min; a saved state is independent of its simulation and loads twice alike; a mismatched state is refused; a restored run logs the same launches; an alarm survives a backward seek before it goes off and is set again by a seek to before it was made, and a seek back and forth reaches the straight run's hash; auto-slowdown stops at the alarm in the straight run's state; checkpoints are taken and thinned, and a seek to the middle of 17 days reaches the straight state; a saved host loads and runs on alike.

**Reason:** rule 19 asks that nothing outside the log changes campaign state and that replaying the log from a snapshot reproduces it. The sim already kept events as data and drew randomness from keyed forks, so saving needs only each part's mutable data. Checkpoints keep a backward seek short at any campaign length (six game hours of replay at most, about a second of worker time today).

### 236. A headless day of war: the worker's cost on the demo seeds

**Date:** 2026-11-19
**Decision:** R1.3. `tools/war.preview.ts` builds each demo seed's campaign world as the app does (the coarse pass at `COARSE_RESOLUTION`, the weather climate from its maps, the default campaign start) and runs the campaign for 24 game hours twice: stepped as the worker steps it at 64× (30 steps per real second, each new hour's weather fields computed as the worker sends them) and in one jump. It writes `tools/out/war.md` and fails on an error or on two different end states (`SEEDS`, `HOURS`, `RATE`, `OUT`). `tests/war.test.ts` runs the same setup on a small generated world for 12 hours, with the world's own climate; `tests/air.test.ts` keeps its synthetic climate.

Measured on this session's machine (Intel Xeon, Node 22):

| Seed | ms per game hour at 64× | Worst step | One jump | Missions launched (A/P) | Airborne mean / max |
| --- | --- | --- | --- | --- | --- |
| 4 | 11.7 | 65 ms | 2.6 ms | 93/87 | 36.8 / 47 |
| 10 | 9.8 | 40 ms | 1.7 ms | 91/95 | 35.2 / 48 |
| 7 | 7.4 | 13 ms | 1.3 ms | 90/86 | 36.8 / 48 |

The air war and the weather systems take 1–3 ms per game hour; the hourly weather fields take most of the rest, and the worst step is the one that computes them. At 64× a game hour lasts 56 real seconds, so the worker is busy about 0.02% of the time; the stepped and jumped runs end in the same state on all three seeds.

**Reason:** R2 adds the ATO, resolvers and battalions to this loop and needs a baseline to measure them against; the roadmap's benchmark (R2.3) reruns this tool. The worst step shows where a later budget breaks first: the hourly weather fields, which could be computed a part at a time as Free Flight's standalone weather does if a step ever needs to stay short.

### 237. Road and rail graphs, bridge cuts and damage in the sim; bridge aim points on the main thread

**Date:** 2026-11-19
**Decision:** R1.8.

- **Graphs.** `CampaignInput` carries `roads` (the civilian roads with the airbase and port spurs) and `rail`, each a `NetworkInput` built on the main thread by `buildNetworkInput` (`src/sim/ground/network.ts`) from the strategic graph's polylines: plain typed arrays the worker receives with its init message. Nodes are the cells where polylines meet or end, the cells carrying a bridge and their neighbors; edges are the chains of cells between nodes, with length, road class (the best of the polylines there) and points. `NetworkGraph` (the worker's `world.networks`) finds shortest paths with a set of cut bridges and a reach.
- **Bridges as cuts.** A network bridge keeps its source list and index (`bridgeSource`, `bridgeIndex`) and the detour the worldgen recorded. Cutting it closes every edge at its cell, which is what `describeBridges` does when it measures the detour, so the graph's detour equals the recorded one. Polyline points are cell centers and `pointAngle` is `CubeGrid.angleBetween`'s formula, so lengths agree to the bit; only the summation order along a chain differs. The road graph merges the spurs with the civilian roads, as supply to a base needs, so a detour there can be shorter than the one recorded per list.
- **Damage.** `DamageState` (`src/sim/ground/damage.ts`, `world.damage`) holds damage 0..1 per target site; hits combine as independent chances, and a bridge target at `BRIDGE_CUT` (0.5) or more cuts its bridge (`cutBridges`). It is a saved part of the campaign state (decision 235). Bridge targets now name their bridge (`TargetSite.bridge`: list and index), so a target and its bridge no longer have to be matched by cell. The simulation hashes every saved part; `AirOps` is hashed as its own part instead of through the tasker.
- **Aim points.** `bridgeAimPoints` (`src/worldgen/networks/alignments.ts`) places each network bridge at its matched crossing, else at the nearest point of the link that aligns its polyline, else at its coarse point, with how each was found (owner decision 7). It runs on the main thread after `matchBridges`; the campaign keeps the coarse point. R2.6 aims strikes with it.

**How it was checked.** `tests/network.test.ts`: `pointAngle` equals `angleBetween` bit for bit; the road graph covers every road cell, keeps the network's length and joins each edge's end nodes; with a bridge cut, the graph's detour between the banks `bridges.ts` chooses equals the recorded detour for all 15 bridges of the river world, and uncut the way across is the bridge; on a generated world a bridge target at 0.51 damage cuts exactly its bridge, and the damage survives a save and restore with the same hash. `tests/networkLink.test.ts` checks the three kinds of aim point.

**Reason:** interdiction, strike effects and supply (R2.1–R2.3) need the networks as a graph in the worker and a place to record what strikes did; keeping the graph's cut identical to the worldgen's detour makes the recorded detours, which already weigh bridge targets, the same numbers the war will feel.

### 238. Aircraft bundles in src/data/models/aircraft/, read by one loader in the sim

**Date:** 2026-11-19
**Decision:** R1.7's migration. Every aircraft type is one JSON bundle, and its air-war entry, avionics profile and camera rig moved out of code into it.

- **Location.** All model specs move from `src/render/common/models/specs/` to `src/data/models/`, and the aircraft to `src/data/models/aircraft/`. Rule 6 forbids `sim/` any import through a `render` directory, and the sim worker must read the bundles; a data directory both layers may import resolves it, and the subdirectory keeps the worker from bundling every building and tree. Rule 17 and `CLAUDE.md` name the new place. Spec ids are unchanged (`alliance-fighter` is still the Kestrel's model); each bundle's `airWar.id` is its type id (`f21`), and the 26 types without geometry have bundles named by type id. A bundle without parts may name another's geometry (`model`: the Vo-31K draws as the Vo-31). The renderer's library skips bundles without parts.
- **Loader.** `src/sim/air/bundles.ts` parses and validates every bundle (`AIRCRAFT_BUNDLES`, `bundleOfType`, `bundleGaps`) for the worker and the renderer alike. `AIRCRAFT_TYPES` is now the bundles' `airWar` blocks in their `order`; `TYPE_PROFILES` (by type id) and `AVIONICS_PROFILES` (by model spec, every bundle with its own geometry) are the `avionics` blocks; `typeProfiles.ts` is gone.
- **Units.** Rule 1 holds at the loader: keys name their units where they are not SI (`cruiseSpeedKt`, `combatRadiusKm`, `stationTimeMin`, `turnaroundH`; radar `rangeKm`, `azimuthDeg`; rig `fovDeg`), and the loader converts with the same expressions the table used. The generator that wrote the bundles checked every value converts back bit for bit.
- **Rigs.** A bundle's `rig` is a fast jet's numbers or `{ "kind": "helicopter" }`, the rig scaled by the main rotor's radius (`rigFromBundle` in `chaseCamera.ts`). Free Flight takes its rigs from the Kestrel's and the two helicopters' bundles; `FAST_JET_RIG` stays as the camera's default with the Kestrel's numbers.
- **Blocks still empty.** `pylons` (R2.6) and `calibration` (R2.2) are parsed when present. `tests/bundles.test.ts` checks ids, order, sides, profiles, geometry references and rigs, and pins what the demo roster lacks: the Kestrel pylons and calibration; the Vo-31 and Vo-35 flight data, rigs, pylons and calibration; the A-15 and C-150 everything but their air-war entry and avionics. That list is R2.7's checklist.

**How it was checked.** The loaded entries and profiles equal the old tables field for field, and `tools/war.preview.ts` gives the same state hashes on seeds 4, 10 and 7 as before the move (`ec2bbb1b2a70d821`, `3e637c52ed8d1981`, `977b10bc84968b28`).

The sim worker's chunk grows from 58 kB to 104 kB, since the six bundles with geometry come along whole.

**Reason:** decision 232 makes the bundle the one place a type lives; the sim worker can only read it from outside `render/`.

### 239. Utility helicopters in every world's cast; the UH-68 Heron; aircrew by name

**Date:** 2026-11-19
**Decision:** R1.7's roster items (owner decisions 3 and 4). These change every world's order of battle.

- **Rename.** The UH-68 "Buzzard" becomes the **UH-68 Heron**, ending its clash with the A-15 Buzzard (menu, bundle, display tools).
- **Utility role.** A new role, `utility-helicopter`, with two types: the UH-68 Heron (`uh68`, UH-60A analogue; its bundle already had geometry, flight data, avionics and a rig, and now has its air-war entry) and the **Ve-18 Shmel** (`ve18`, Mi-8MT analogue; a bundle without geometry, its Pact avionics a moving map, the hook camera, a navigator and a flight engineer). Loadouts are troops, rescue (hoist and door guns) and sling. Squadrons of 16 (Alliance) and 20 (Pact) aircraft go to every forward base, after its other roles so the earlier picks keep their draws, and each side keeps at least one (special roles). No mission type uses them until CSAR (R2.9); they fly nothing yet, so missions flown on the demo seeds are unchanged.
- **Aircrew.** Every squadron carries its aircrew by name: `PILOTS_PER_SEAT` (1.25) per crew seat of its aircraft, named by `NameGenerator.person(side)` (an initial and an invented surname with a side-flavored ending) from `rng(seed, "orbat")/pilots/squadron-<id>`, so the names draw from nothing else. They are data until R2.2's losses and R2.9's survivors use them.
- **Effect.** The demo seeds gain 4–8 squadrons each (seed 4: 177 → 185, seed 10: 171 → 175, seed 7: 182 → 189), and the state hashes change (`0727ebb98b3b0565`, `0116e1a64fcc4068`, `732e0ae45e9cc621`). The Pact types' table order moves one place to fit the UH-68 after the Alliance's types.

**Reason:** CSAR, which the demo needs (design, *Ejection and CSAR*), and the design's roster both call for utility helicopters on both sides; pilots are what squadrons lose and recover.

### 240. Terrain for the execution layer: the edits in worldgen, a height service, a floor under routes

**Date:** 2026-11-19
**Decision:** R1.6.

- **Edits in worldgen.** The airfield pads, their footprint, the airfield layout constants, `offsetPoint`, `localFrame` and the global-grid samplers move from `render/sim/infra/` into `worldgen/edits/airfields.ts`, and `terrainEditsFor` assembles `TerrainEdits` from a list of sited airfields, the global heights, the corridors and the channels. The renderer's `airfieldGrading` now hands its scene's airbase sites to it, and `siting.ts` uses the shared `offsetPoint` instead of its own copy.
- **Height service.** `HeightService` (`worldgen/edits/heightService.ts`) is the global eroded grid plus the edits, through `TerrainEdits.apply`: about 1.5 km cells on the campaign planet at 1024 per face, with the airfields graded in. After the airfields are sited on the global world, `main.ts` sends the grid and the sited fields to the worker (`terrain` message, `SimClient.setTerrain`); the worker builds the same pads and keeps the service on its world (`world.terrain`), also across restores. Its edits are the pads only: corridors and channels are tens of meters wide, below the grid's cells, and their sources stay on the main thread. The sited fields ride with the service as presentation data for full fidelity (R2.5); the campaign keeps the coarse points (owner decision 8).
- **Line of sight.** Free Flight's sensors test line of sight over the height service and the landform props (`AirfieldGround.sightHeight`), no longer over resident tiles; the ground map and the elevation map keep `sensedHeight` and the tiles (owner decision 9, decision 227). The flown aircraft and the AI thus see over the same ground.
- **Route floor.** `floorRoute` (`sim/air/terrainFloor.ts`) puts a terrain floor under analytic routes: legs are cut into 5 km pieces whose ends rise to the highest ground plus clearance sampled every kilometer, orbits rise whole over their racetrack, fields stand at the ground's height, and the clearance (100 m for jets, 30 m for helicopters, the old low-level altitudes now above the ground) ramps to zero within 4 km of a takeoff or landing point. Times, speeds and fuel do not change. The ground is the coarse world's height map (`SimConfig.ground`, sent with the worker's init), sampled as the highest of the four cells around a point (`globalMaxSampler`), so the floor holds over the smoother coarse surface. The tasker passes `AirOps.ground` into route planning without reading it (rule 9). `routeState` finds its segment by binary search, since floored routes have dozens. The state hash now covers each route's segment times and altitudes.

**How it was checked.** `tests/heightService.test.ts`: the worker's service agrees with the renderer's function bit for bit at 2,000 random points and around every field, runways are flat, and line of sight works over it. `tests/terrainFloor.test.ts`: deep strike, reconnaissance, airdrop and helicopter CAS routes that flew through a 1,800 m ridge clear it by their clearance afterwards, with the same phase times and fuel, continuous in time and altitude. `tests/demoSeeds.test.ts`: over 12 game hours on seeds 4, 10 and 7, no airborne point of any route lies below the coarse ground, sampled every 20 s; without the floor 75–105 points per seed did, up to 103 m below. On the demo seeds the worker's cost rises from about 9 to 15–18 ms per game hour at 64× (0.03% of real time) and the hashes become `6f2d6fd14afdb75f`, `cb8ab9824fe7a992` and `4a82718b784d8ea6`.

**Not yet checked.** That a flight handed to full fidelity anywhere on its route is above the drawn ground (R1.6's second exit criterion) needs the tile surface; the floor is checked against the coarse ground only, and the global grid's smaller hills can rise above it. R2.5's handover test is where it is checked, and the clearance may need to grow with what it finds.

**Reason:** the execution layer needs a ground it can query without the renderer's tiles, built from the one edit function (rule 13), and routes that do not pass through hills.

### 241. Mission search, subscriptions, jump-in windows and side selection

**Date:** 2026-11-19
**Decision:** R1.4.

- **Side selection.** When a campaign starts (not Free Flight), a panel shows the generated briefing with a button per side (`src/ui/sidePanel.ts`). The choice is a campaign input (`side`, logged; the sim's state does not depend on it) and becomes the map's viewing side; the debug GUI's viewing side, with both sides, stays as the developer view.
- **Jump-in windows** are data on the mission profiles (`MissionProfile.jumpIn`): fixed-wing from climb-out to approach (decision 231, `DEFAULT_JUMP_IN`), helicopters from departure to completion, over their ground phases (decision 149, `HELICOPTER_JUMP_IN`). `jumpInWindow(m)` gives a mission's window in game time.
- **Search.** `src/ui/missionSearch/model.ts` is a pure display model: the viewing side's missions as rows with type, aircraft, unit, theater, phase, threat and time until action, filtered by type, aircraft, theater, phase, threat and a time window, sorted with missions in action (on target) first, then those still to reach it by how soon, then those past it, most recent first. Threat is an interim level per mission type until the intelligence picture (R3). The panel (`panel.ts`, M toggles it) draws the rows; choosing one selects the mission on the map, which draws its route, and eases the camera to the theater band's floor over the flight.
- **Subscriptions.** A subscription is a query (side, mission types, aircraft types, theaters: what the sim can match) plus a phase, made from the panel's filters. Subscribing and unsubscribing are campaign inputs (rule 19) that travel in the worker's new `input` message; the list is a saved part of the campaign (`Subscriptions`, `sim/air/subscriptions.ts`). When a matching mission reaches the phase, `AirOps` schedules a flagged event at that moment, so the host's auto-slowdown drops the clock to 1×; the worker names the mission with the flag, and the notice offers to show it (following is R2.4).

**How it was checked.** `tests/missionSearch.test.ts`: rows hold only the viewing side's missions, in the order above; every filter keeps only what it names; jump-in windows match the phases for fixed-wing and helicopter missions, and a row's jump-in state matches its window; time to action is 0 during the action and negative after it. A subscription to Alliance CAS on target, run at 64× in worker-sized steps, stops at 1× at the first such mission's on-target time, in the same state as a run that seeks there, and survives a save and restore.

**Reason:** proposal 0008 makes search the player's way into the war, and subscriptions the way time acceleration and search work together; everything that changes the campaign goes through the log.

### 242. A GPU timing tool behind ?dev; the lavapipe smoke test loses its device in this container

**Date:** 2026-11-19
**Decision:** R1.1.

- **GPU timing.** With `?dev&gputime=1` the app creates its renderer with `trackTimestamp` and `GpuTiming` (`src/render/common/gpuTiming.ts`) resolves the render and compute timestamps every frame, averaging the frame's total and each render call per view (`strategic`, `simulation`, `freeflight`). It logs them every five seconds and exposes them as `window.bearing.gpuTiming`. Three keys a pass by its place in the frame, not by name, so passes are numbered by call order. The device must offer `timestamp-query`; the renderer's device already asks for every feature the adapter has. `tools/browser.smoke.mjs` with `GPU_TIMING=1` adds the flag and saves the last page's figures in `smoke.json`. Lavapipe has no timestamp queries, so the first figures come from the owner's machine (`MODE=gpu`).
- **Smoke test here.** In this session's container the smoke test on lavapipe loses the WebGPU device about 160 s into Free Flight's start screen, while the terrain synthesizes ("A valid external Instance reference no longer exists"). The session's starting commit (`0c81707`) fails the same way at 166 s, so it comes from the container, not from today's changes; a campaign-only run lost its device at 155 s too, while the kernel reported killing processes for lack of memory, so the container's memory limit most likely takes Chromium's GPU process. The WebGPU app could not be checked in a browser in this session; `tools/freeflight.session.mjs` (no WebGPU) ran Free Flight's session instead.

**First run on the owner's GPU** (AMD RDNA 3, Windows, 2026-11-19, the first `MODE=gpu` run of the smoke test): every scene passed but the helicopter's forward flight, whose check counted 70 frames, over ten seconds of flight on lavapipe but under two on a GPU, too short to pass 10 kt from a hover; it now waits for the speed (up to 30 s). At 640 × 360 the simulation view takes 5.0 ms of GPU render time a frame (its main scene pass 4.3 ms) and 0.26 ms of compute, the strategic map 4.3 ms and 0.14 ms. The map's 10–15 fps (70–100 ms a frame) is therefore not GPU time unless it grows far beyond the pixel count at full resolution: R1.1's profiling of the map starts on the CPU (labels, glyphs, the zone list). At 1920 × 1080 the map takes 7–8 ms and the campaign's simulation view 11.4 ms (its main pass 8.4 ms), so the map's frame is CPU time; but Free Flight's helicopter 25 m over the ground takes 35.4 ms of GPU time, almost all in the main scene pass, which caps it near 28 fps at that size. The near-ground layers (trees, ground cover, canopy shell) are the suspects. The timing tool keeps the figures of the last page loaded, so a full smoke run reports the campaign's views only; `ONLY=flight` or `ONLY=helicopter` reports Free Flight's.

**Reason:** R2 needs a GPU baseline per view and per pass, measured on the owner's machine with the same tool that runs the smoke test.

### 243. The flown aircraft leaves Free Flight: FlownAircraft, the avionics state with it, one clock

**Date:** 2026-11-19
**Decision:** R1.5.

- **The split.** Free Flight's responsibilities, mapped: session flow (start screen, pause, summary, URL), input (keys, mouse aim, mouse capture), the airframe and its stepping, the director and scripted pilot, sensors and traffic, the HUD frame, the displays, the chase camera, weather. The airframe and its stepping, the input source, the avionics state and the clock's rules are what a campaign flight needs at full fidelity (R2.4, R2.5); they move out. Session flow, input devices, traffic and the camera stay in `freeflight/` and the UI.
- **FlownAircraft** (`src/sim/flight/flownAircraft.ts`): an airframe of either kind with its controls, an input source (`pilot`: an AI or the scripted pilot, mouse aim, or the helicopter's laws turning the player's command into controls; none: the controls as the player left them), a wind hook, `onStep` (game time, outcomes), the flight time and distance, and the avionics state. `advance` turns real time into whole 1/120 s steps with the cap and step limit Free Flight had; `step` takes one. No DOM, render or worker imports. `fixedWingFromState` builds a jet from a position, velocity and fuel (nose on the flight path plus about the 1-g angle of attack, gear and power by whether it flies, real fuel), as R2.5's promotion will.
- **Free Flight on it.** The jet's and the helicopter's loops and the tools' `advance` were three copies of one step; all three now go through one `FlownAircraft` per sortie, which replaces Free Flight's own accumulator and counters. The `model`/`helo` fields stay for the HUD and the camera, which still read the airframe by kind.
- **Avionics state** lives on the flown aircraft; the display system attaches to it (`DisplaySystem.attach`) and reads and changes it there, keeping its own only until an aircraft attaches.
- **Snapshot and HUD frame** builders move from `freeflight/` to `ui/flight/hudFrame.ts`, `ui/flight/heloHud.ts` and `ui/displays/aircraftSnapshot.ts`: they read an airframe and the sensors, not Free Flight, so a followed aircraft (R2.4) can use them.
- **One clock.** `src/sim/clock.ts` holds the rules both clocks follow: the flight step, the 0.25 s real-step cap, the time rates and `gameStep`, which `SimHost` and `FlownAircraft` both use; the flown aircraft's own rate is 1× until R2.5's cruise acceleration (`FLOWN_MAX_RATE`).

**How it was checked.** `tests/flownAircraft.test.ts`: the scripted pilot's whole circuit, flown through `FlownAircraft` in 60 Hz frames from a lineup built by `fixedWingFromState`, ends bit for bit where the airframe stepped directly ends, fuel included; a jet built from an air state at 320 kt holds course, height and speed under the flight director for a minute; the step cap holds. `tests/flightLockstep.test.ts` passes unchanged. `tools/freeflight.session.mjs` passes everything but the known "drizzle: wet at once" check (decision 217), before and after the change.

**Reason:** proposal 0008 lets the player take over any campaign flight; that needs the flown aircraft, its controls and its avionics as one object outside the sandbox, with the same physics path for the player and the AI (rule 12).

### 244. Two GPU tests' bounds from what the owner's GPU rounds

**Date:** 2026-11-19
**Decision:** The owner's run of the GPU suite on Windows passed 96 of 98 tests, the cube-face seam (decision 233) among them. Two tests that pass on lavapipe failed there, by rounding; neither the tests nor the code they cover had changed since the audit.

- `tests/gpu/faceShading.test.ts` asked a child tile at morph 0 for its parent's face hash bit for bit; on the owner's GPU it differs by 7·10⁻⁹ (one float32 step), as a compiler may fuse the same arithmetic differently where the child inlines it. The jitter picks a facet's shade from [0, 1), so the difference cannot show; the test now asks for six decimals.
- `tests/gpu/skyView.test.ts` bounded the daytime bend of the sky's brightness from one LUT texel to the next at 0.3%, reasoned in the test as less than one 8-bit step, which the dither covers. One step is 1/255 (0.39%); the owner's GPU, whose transcendentals round differently from lavapipe's, gives 0.32%. The bound is now 1/255, the reason the test already gave.

**Reason:** the tests guard visible properties (no facet pops at a split, no texel structure in the sky); their bounds now say what is visible rather than what lavapipe happens to compute. Whether these two failed every time on the owner's GPU or only once is for R1.1's ten runs there to say.

### 245. The map's CPU frame: labels shaped once, redrawn only when something changed; no leak found

**Date:** 2026-11-19
**Decision:** R1.1's strategic map frame rate and session decay.

- **A section timer.** `SectionTimer` (`src/render/common/sectionTimer.ts`) records CPU time per section of `StrategicScene.render`: the world, the camera, the relief, the graph overlay, the military and infrastructure overlays, the air layer, glyphs, labels, weather, the render call and the label overlay. With `?dev&cputime=1` the app logs it every five seconds and starts afresh, beside the app's own frame around it (before the map, the map, after it) and the time between frames, so a section that grows over a session shows as a rising number. `tools/render.preview.ts` prints it for each strategic view (`SCENE=strategic`), and `MOVE=1` adds a panning camera.
- **The hot path.** Placement (the collision pass) already ran only when the camera settled, but every frame the label layer laid out every visible label's glyphs again and rewrote its instance buffers, settled or not: 10–15 ms a frame at the theater band on this session's CPU, with the camera still. Shaping a name (`layoutText`) does not depend on the view, so runs without extra spacing are now kept per atlas and style; and the layer skips the layout and the upload when the camera has not moved, the viewport and the band fades are unchanged, no label is fading and no placement is new. New labels, fonts, hidden layers and `invalidate()` force the next redraw. Measured in the preview: labels 14.5 → 0.02 ms a frame still and 11.1 → 0.5 ms panning at the theater band; 10.4 → 0.02 ms still at the front. The overlays take under 0.1 ms together; the relief's tile selection under 1 ms, besides single frames of about 200 ms on lavapipe (one-off pipeline and buffer work, to be seen on a real GPU).
- **No leak in GPU objects.** `tests/gpu/mapSoak.test.ts` runs the map through 20 cycles of the camera from the ceiling to the floor, game time and missions moving the air war on and the world set again every fifth cycle: the renderer's live geometries and textures stay at 30 and 6 throughout. With terrain tiles, 16 cycles of long pans at the floor fill the tile caches by the third cycle (84 geometries, 11 textures) and stay there.

**Reason:** the map's frame (10–15 fps on the owner's machine) is CPU time, its GPU time 7–8 ms at 1080p (decision 242); the labels were the one section that cost tens of milliseconds every frame. A session-long decay was not reproduced as a growth in GPU objects; the per-section log on the owner's machine is now the way to see which section grows, if one does.

### 246. The map: panning over the poles, opening over the war, label budgets

**Date:** 2026-11-19
**Decision:** three changes to the strategic view after the owner's session with `npm run dev`, and a reading of their timings.

- **Panning without a pole.** Both orbit cameras (`StrategicCamera`, `OrbitCamera`) kept their place as latitude, longitude and a compass heading, stepped in the local east/north frame and clamped the latitude at 89.9°. Near a pole that frame turns with longitude, so a small drag spun the picture, and a pan toward the pole stopped there. `moveOnSphere` (`src/render/common/sphereMove.ts`) now moves the focus along a great circle and carries the screen's up direction with it (parallel transport), reading the heading back afterwards; the map moves as one sheet, over the pole included. The `maxLatitude` limit is gone; only a guard of 10⁻⁹ rad keeps east and north defined. Poles stay reachable; they are rarely of interest, but the map should never misbehave there.
- **The campaign opens on the map.** The default view is now the strategic view (`?view=simulation` opens the simulation view, which Free Flight never did). When the campaign starts, the map centers on the middle of the first continental front's start line, or the first theater's land, or the largest landmass, at 1,000 km (`render/strategic/startFocus.ts`). The browser smoke test asks for the simulation view by URL.
- **Label budgets.** A land area's name (zones, salt pans, hills, wetlands, deserts, forests, plateaus, plains) needs the area to span 120 px on screen (`AREA_MIN_PX`), from its diameter (a zone's) or twice its cap radius (a feature's); so names arrive with zoom, the larger areas first, within a band and not only at band edges. At most eight land-area names (`LABEL_BUDGET.area`) and five peaks (`LABEL_BUDGET.peak`) show at once; within a budget, labels rank by importance plus up to 0.1 for being near the screen's center. In the Region view of seed 1, about twenty salt-pan names and ten peaks became none and five. The zone rows and spacing of decision 220 stay as the first filter.
- **Timings after decision 245** (owner, 1080p): the map's CPU is 7–10 ms a frame (render call about 5 ms, relief 1–4 ms, labels 0.3–0.6 ms), its GPU 15 ms, almost all in the main pass, and frames come every 26–34 ms (30–38 fps, from 10–15). With GPU and CPU work each under 16.7 ms but not together, the frame misses the display's interval; the next gain is the main pass's GPU time (TODO).

**Reason:** the owner found the orbit near the poles finicky, the campaign opening in the simulation view at an airbase, and too many zone names on the map; they suggested ranking by size and screen position with a budget, which this follows.

### 247. Airbase names on the map; R1 closed but for the owner's mission-search check

**Date:** 2026-11-19
**Decision:**

- **Airbase names.** The map drew airbases as badges and never named them, though casting gives each a name ("Gar Air Base", "Kri Airfield"); nothing but the label table left them out. Each airbase now has a point label beside its badge (a gap of 14 px, past the 26 px badge's half width) in 11 px Fira Sans in the holder's faction color (`airbaseAlliance`, `airbasePact`), hidden with the sites layer. They show in the Region band only, budgeted to ten at once (decision 246's ranking, importance 0.66 for main and bomber bases and 0.5 for the rest); at the Theater band about twenty names crowded the front on seed 1, which Part II's "airbases as icons" there already ruled out.
- **The helicopter's smoke check** waited for 10 kt and then compared a speed rounded to whole knots with `> 10`: 10.4 kt read as 10 and failed on the owner's GPU. The report now has one decimal, and the wait asks for 11 kt.
- **R1's state.** R1.1 is done: the map runs at 50 fps and more on the owner's machine (from 10–15) with no decay over a session; a steady 60 fps (the main pass's GPU time) and the desktop alignment rerun move to R6.4, as neither gates R2. R1.6 is done, its handover criterion moving to R2.5, where a flight is first handed over. R1.2, R1.3, R1.5, R1.7 and R1.8 were done. What remains is R1.4's exit criterion, the owner finding the next CAS mission over the front in under ten seconds.

**Reason:** the owner asked whether airbases should be named on the map (they should: they are where missions start and what strikes target) and whether R1 could close.

### 248. The campaign opens on a demo seed; mission search's dropdowns and threat mark

**Date:** 2026-11-19
**Decision:**

- **Default seed.** The campaign opened on world seed 1983, an island campaign without a continental front. The interim tasker flies close air support only over fronts, so the owner's ten-second check (R1.4) found none: in six game hours seed 1983 flies CAP, airlift, deep strikes and escorts, and no CAS. The campaign now opens on `DEMO_SEEDS[0]` (seed 4: a front, a sea lane, the strategic theater) unless the URL names a seed; Free Flight keeps 1983, which its tools and smoke test use. `DEFAULT_PLANET_PARAMS.seed` stays 1983, so tests and caches are unchanged.
- **The war tool counts missions by type** (`tools/war.preview.ts`, every mission seen live, both sides). Six hours: seed 4 flew 13 CAS missions, seed 10 15, seed 7 8, seed 1983 none.
- **Mission search.** The dropdown lists were white text on the browser's white list: the panel now declares `color-scheme: dark` and colors its options. The high-threat mark (▲) was a third flex item in the row's head, which centered the title; the title is now its own span and carries the mark.

- **Support missions are named by their aircraft** in mission search and the flight panel (`missionLabel`): "Airborne early warning" or "Tanker". "Support" alone read as close air support. The type filter lists it as "Support (AEW, tanker)".
- **R1 closes.** On seed 4 the owner found the next CAS mission over the front (Pontiac 35, A-15 Buzzards, Lynvania front), R1.4's exit criterion; every R1 milestone is done.

**Reason:** the owner's R1.4 check on the default world.

### 249. The air tasking order and mission plug-ins; the interim tasker retires

**Date:** 2026-11-19
**Decision:** R2.1. Each side issues one air tasking order per game day and revises it on its doctrine's period; every mission type it flies is a plug-in. `AirTaskingOrders` (`src/sim/command/ato.ts`) replaces decision 132's `InterimTasker` as the sim process named `ato`.

- **Plug-ins** (`src/sim/command/missions/`, rule 16). `MissionPlugin` holds the eight parts: planner rule, package template, aggregate resolver, full-fidelity behavior, jump-in window, success criteria with consequences, briefing template, interface defaults; besides them its weather and daylight minimums and its apportionment category. A part a later milestone builds is a `{ pending: 'R2.x' }` marker. `tests/missions.test.ts` checks every registered type and pins the list of markers so that it only shrinks: the four demo types (CAP, interdiction, CAS, airlift) lack only the resolver (R2.2) and the AI pilots' behavior (R2.5). The interface defaults are data in the plug-in, typed by `sim/avionics`' master modes and formats, so one registry holds all eight parts; R2.6 applies them through `presets.ts`, where the roadmap's table puts them. The briefing templates are in `src/campaign/missionBriefings.ts`; `missionBriefing` writes a live mission's. Success criteria and consequences work on a `MissionOutcome` and name `WorldEffect`s (damage, road damage, stocks, ground attack, station held) that R2.2 applies.
- **Provisional plug-ins.** The interim tasker's other types (AEW and tanker support, escort, SEAD, low-level strikes on airbases, strategic bombing, reconnaissance, attack helicopters) are ported as provisional plug-ins: planner rule and package template as before, a plain briefing, and the resolver, behavior, success criteria and interface pending until the mission catalog (R4.2). Without them the demo would lose its AEW orbits, escorts and strikes on airbases, and rule 16 forbids flying a type outside a plug-in.
- **Needs** are standing stations (CAP over the fronts, the AEW orbit, carriers and fields at sea; AEW and tanker orbits) kept covered by relieving flights to the order's horizon (the day's end plus three hours), or wanted times on target. Fronts are cut into segments of about 80 km (`front.ts`), whose pressure comes from the start line's corridors, which `CampaignInput` now carries with their names, until the ground war (R2.3) gives a force balance. CAS (24 sorties a day for the attacker, 12 for the defender) goes to segments by pressure. Interdiction ranks the enemy's bridges, depots, rail yards and road segments by the supply each carries to the front over the road and rail graphs, with cut bridges left out (`supply.ts`, `NetworkGraph.tree`), and by value, and strikes the top 24 a day. Airlift sends one transport a day to each forward and island field, more when its stocks fall below 80% and 50% of the outbreak's. Needs and missions carry named places (theater, front, corridor, target, nearest town from `CampaignInput.places`, the settlements of 2,000 people and more).
- **Packages** come from the plug-in's template: the lead, an escort for defended sites, SEAD ahead of a strike on an airbase. Each flight takes the first of four candidate squadrons by role preference and distance that reaches the target, meets the minimums, fits the **ledger** (`ledger.ts`: aircraft promised per squadron over time, from departure to the end of turnaround, against strength) and the side's airborne cap.
- **Doctrine** (`doctrine.ts`). The Alliance spreads strikes through their window and revises every two hours; the Pact sends strikes in waves every three hours and revises every four. Both apportion their 24 airborne aircraft between counter-air, support, strike, ground support and airlift (Alliance 50/20/40/40/20%, Pact 50/15/45/45/15%). The shares overlap, so a category may use what another leaves. Without apportionment the day's order let standing CAP, which ranks first, fill the cap for the whole day: CAS, the Pact's interdiction and airlift barely flew.
- **Weather and daylight** (`environment.ts`). Daylight is the sun above −6° at the target at its time on target; the weather is a persistence forecast (the weather view at planning time). Minimums per plug-in: CAS by day with a 600 m ceiling and 5 km visibility at the target; interdiction by day, 900 m and 5 km; airlift 60 m and 800 m at the destination; CAP none; every takeoff needs 150 m, 1.6 km, no storm and wind under 20 m/s at its base (helicopters 100 m and 800 m). **Winds aloft** set each leg's ground speed in `planMissionRoute` (`groundSpeed` in `route.ts`: the airspeed less the crab plus the wind along the track, from the wind at the leg's middle and mean altitude); orbits keep their airspeed; fuel follows the time.
- **Orders and commitment.** A day's order and its revisions keep the planned sorties whose need and request still stand, that still meet the minimums under the newer forecast and still fit the ledger, cancel the rest with a reason, and plan what is missing in rank order (score, then key). Every hour the ATO commits the sorties departing within the hour: it checks the weather and the squadron once more, puts the terrain floor under the route (decision 240; planning routes have none, since the floor changes altitudes only), assigns the mission id and hands it to `AirOps`. Times on target are drawn from forks per side, day and need, so a need keeps its times through a day's revisions. Each revision is an `ato-revised` decision in the log and each cancellation at commitment a `sortie-cancelled` one. The ATO's saved state is its orders, the last strike per target, committed coverage, the day's filled requests and the committed flights' return times; `SIM_STATE_FORMAT` becomes 2.

**How it was checked.** `tests/war.test.ts`: on a generated world, 26 game hours in 1 s steps, at 64× in the worker's steps with the player on the other side, and in one jump give the same orders and air state; each side issued two orders and logged every revision. `tests/demoSeeds.test.ts`: on seeds 4, 10 and 7, over 26 hours, each side issues two orders, revises them, and flies CAP, interdiction, CAS and airlift, and no route passes below the coarse ground. `tests/ato.test.ts`: winds aloft, daylight windows and the night refusal, front segments, supply lines that drop a cut bridge, the ledger, a revision that cancels a strike on a destroyed target and plans another, named places and briefings on every mission. `tests/missions.test.ts`: the registry, the pinned markers, jump-in windows, interface defaults, success and consequences, briefings, wave and spread timing. `tools/war.preview.ts` (24 h, real climate):

| Seed | ms per game hour at 64× | One jump | Missions launched (A/P) | Airborne mean / max | CAP | Interdiction | CAS | Airlift (A/P) | Hash |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 29.1 | 21.3 | 88/64 | 27.9 / 45 | 33/20 | 23/7 | 11/13 | 3/1 | `8183eef4050e6305` |
| 10 | 23.1 | 18.0 | 74/61 | 26.9 / 46 | 25/23 | 5/1 | 12/14 | 3/1 | `cff24b6e6dec86a3` |
| 7 | 21.6 | 16.7 | 86/64 | 27.9 / 42 | 36/22 | 12/7 | 5/13 | 3/1 | `a188a62524abeda2` |

The interim tasker flew 180 missions a day per seed with about 37 aircraft in the air; the ATO flies 135–152 with about 28, within C2's 20–50, and its unfilled requests are mostly apportionment and the airborne cap, with the weather and the night taking a few. The worker's cost is about the interim's (0.04–0.05% of real time at 64×).

**Reason:** proposal 0008's game loop needs a planner whose decisions are legible and that reacts to the war, and rule 16 makes every mission type a plug-in so that R4's catalog adds types without touching the planner.

### 250. Aggregate resolution: interception, point defenses, outcomes and consequences

**Date:** 2026-11-19
**Decision:** R2.2. Missions no one watches resolve at their phase events; their outcomes change the war, and the next revision of the order reacts.

- **Hook.** `AirOps.resolution` (a `PhaseHook`) runs before AirOps handles a phase event. `MissionResolution` (`src/sim/air/resolution.ts`) is built by the world with each type's plug-in parts (engagement, resolver, success and consequences), so `sim/air` does not import the command layer. AirOps keeps each live mission's phase event ids, so a flight that turns home has its later phases cancelled and new ones scheduled.
- **Engagement role** is a new plug-in field: `target` (CAP intercepts it: interdiction, CAS, airlift and the provisional strikes, reconnaissance and attack helicopters), `escort`, `suppression` (SEAD), `cap`, or `none` (support). Outcome and effect types move to `sim/air/outcome.ts`.
- **Interception.** At fence-in (or on target, if a route has none), a `target` flight meets the nearest enemy CAP on station within 100 km of its way in (its last 30 minutes, sampled) or of its target, with a chance of 0.7, each CAP flight at most twice. Forces are aircraft times air value; the package's escorts and SEAD count fully, the strike flight half. Each aircraft is lost with a chance of 0.3 times the enemy's share of the forces, the strike flight's halved behind escorts and raised by 1.3 without them. A flight that has lost half its aircraft turns home; an unescorted strike flight that was engaged jettisons and turns home with a chance of 0.5, and its escorts with it.
- **Point defenses.** On target, an abstract air defense per target (airbases 0.6, industry 0.5, depots 0.45, rail yards 0.4, bridges 0.35, troops at the front 0.4, roads 0.15, own places none) times 0.1, the type's vulnerability (1 − survival) and its exposure (time over the target against ten minutes, 0.5–2), halved when the package's SEAD is airborne. R3.5's sites and belts replace it.
- **Outcomes.** At egress, or when a flight turns home or is lost, the plug-in's resolver gives the outcome (`sim/air/resolvers.ts`): strikes hit with a chance of strike value times the kind's `P_HIT`, each hit doing the kind's `DAMAGE_PER_HIT` (bridges 0.35, so two hits cut one); CAS attacks troops with the survivors' strike value times the share of the time on call held; airlift delivers the share of transports that landed; CAP holds its station. The success criteria judge it and the consequences are applied in one place: damage to sites and to road edges (new in `DamageState`), stocks (airlift moves 15 t of fuel and 4 munition loads per transport from its base to the destination), attacks on troops (`DamageState.attacks`, for R2.3). Each resolution is a `mission-resolved` decision; losses and aborts are `aircraft-lost` and `mission-aborted`. The provisional types' resolvers stay pending (R4.2), so their flights take losses but their strikes do nothing yet.
- **Losses.** `AirOps.lose` lowers the flight's and the squadron's aircraft; each crew member ejects (0.75) as a `Survivor` (pilot, side, squadron, mission, point, time; R2.9 rescues them) or is killed, and leaves the roster. A flight with no aircraft ends. Draws come from rng(seed, "losses") and rng(seed, "resolution"), forked by mission.
- **Combat values** (`sim/air/calibration.ts`): air, strike and survival per type from its bundle's `calibration` block when R2.10 has fitted one, otherwise a prior from its role, with the air value scaled by its radar's range (against 100 km) and kind. The prior is a formula over bundle data, not a table tuned per type; rule 18's fit and tolerance test come with R2.10, which also replaces this decision's constants.
- **Revisions read the outcomes.** Damage drops a target out of use from the interdiction plan and recomputes the supply lines with cut bridges (R2.1); the ledger now reads AirOps' live missions and the aircraft in turnaround with their ready times (`AirOps.ready`, replacing decision 249's returns in the ATO's state), against strengths that losses lower, so a depleted squadron's planned sorties are cancelled and replanned elsewhere; airlift needs read the stocks deliveries raise.
- **Changes to R2.1's planning found here.** Two CAP stations left fronts of 1,000 km open, so flights were almost never intercepted: CAP stations are now spaced one per 250 km of front (two to four), each scored by the pressure on the segment nearest it. Seed 10's Alliance had no depots on its supply lines, so the Pact had one target: each side's three largest cities 100–500 km behind its front now feed its supply lines (no targets themselves). Routine airlift ranked below every combat need and seldom fit under the airborne cap: its base score rises from 0.35 to 0.6, with CAS. `SIM_STATE_FORMAT` becomes 3.

**How it was checked.** `tests/resolution.test.ts`: the prior values; the route home from mid-flight (continuous position and fuel, home sooner with more fuel); the strike resolver's mean damage and nothing for a flight that turned home; a 26-hour war on a generated world with aircraft conserved every ten minutes, losses on both sides, survivors equal to the ejections logged and off the rosters, damage, attacks on troops and deliveries, aborted flights back at their bases, no mission resolved twice; revisions that stop striking a target out of use, cancel a depleted squadron's sorties and ask for more airlift at a field with low stocks. `tests/demoSeeds.test.ts` adds R2.2's exit on seeds 4, 10 and 7. The R2.1 determinism tests (1 s steps, 64×, one jump, either side) pass with resolution. `tools/war.preview.ts`, 24 h with the real climate:

| Seed | Aircraft lost (A/P) | Aircrew killed (A/P) | Intercepts by CAP (A/P) | Sites hit | Bridges cut | Road edges | Attacks on troops | Deliveries (A/P) | Aborts | Hash |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 15/20 | 4/4 | 12/10 | 13 | 1 | 5 | 14 | 4/1 | 18 | `46fd05e1b9ef98ee` |
| 10 | 11/14 | 4/4 | 9/8 | 5 | 1 | 1 | 14 | 3/1 | 12 | `debb779bc9325f65` |
| 7 | 3/6 | 1/4 | 2/3 | 9 | 2 | 5 | 17 | 3/1 | 4 | `eab866289bd38c6c` |

About 150 missions a day per seed lose 9–35 aircraft in all, roughly 1–4% of aircraft sorties, the attrition Cold War planning assumed for the opening days. The worker's cost stays at 0.05–0.06% of real time at 64×.

**Reason:** proposal 0008's loop needs its resolve and consequence steps: without losses, damage and deliveries the order had nothing to react to, and R2.3's ground war needs the attacks and the cut bridges.

### 251. The ground war in aggregate: battalions, Lanchester by segment, supply by road, a moving front

**Date:** 2026-11-19
**Decision:** R2.3. A `GroundWar` process (`src/sim/ground/war.ts`, ticking every game minute) fights each continental front segment by segment and moves it.

- **Order of battle** (`sim/ground/orbat.ts`). Per side and front, one division per 60 km of front (Alliance) or 45 km (Pact: mass), at least two. A division has three brigades (Alliance: an armored brigade of two tank and two mechanized battalions, two mechanized brigades) or regiments (Pact: a tank regiment of three tank battalions, two motor-rifle regiments of three mechanized), and two artillery, one air defense and one logistics battalion. Battalions carry a kind, a strength and a seed from rng(seed, "ground") for R2.8's promotion. Values per battalion: tank 1.2, mechanized 1, artillery 0.9, air defense 0.2, logistics 0.05 battalion equivalents. Seed 4 fields 542 battalions, seed 7 629, seed 10 (a short front) 71.
- **Deployment.** Brigades go to front segments (R2.1's segments of about 80 km) by largest remainder: the attacker by 0.15 + 1.5 · pressure² (a screen everywhere, mass on its main axes at the corridors), the defender by 0.6 + 0.4 · pressure. Support battalions follow their division's first brigade. Battalions stay on their segment; reserves and their commitment wait for R3.6.
- **Combat.** Each minute on each segment, power is value × strength × (0.4 + 0.6 · supply). The defender's multiplier is 1 + 0.8 · terrain + 0.2 (terrain: the start line's barrier strength over the segment, now in `FrontInput.strength`). Losses follow Lanchester's square law at 0.08 per day times the other side's power (the defender's raised by the multiplier on the attacker, the attacker's lowered by it on the defender), times the intensity: 1 on the offensive, 0.15 elsewhere. Offensives open where the corridors' pressure is 0.5 or more and culminate when the attacker there falls below half its starting power.
- **Movement.** A segment's offset changes at 25 km a day × (r − 1)/(r + 1) · 2 (clamped to −0.5..1) × intensity × (1 − 0.6 · terrain), r = attacker / (defender × multiplier), within 200 km of the start line and 60 km of its neighbors. The front line is the start line's points moved toward the defender's (or the attacker's) centroid by the offset interpolated between segment centers.
- **Supply**, hourly per segment and side: the best of the side's depots and rear cities (`supplySources`, shared with R2.1's supply lines) by the road graph with cut bridges: min(1, 1.5 × straight distance / road distance) × the depot's undamaged share × (1 − half the worst road-edge damage on the way), at least 0.25.
- **Air support.** Each attack on troops R2.2 records kills 0.04 battalion equivalents per unit on the enemy's nearest segment; a CAS flight of four is about 0.1. Interdiction acts through supply.
- **The ATO** reads the ground war: segments at the moved line with the pressure of the fighting there (intensity × both sides' power), front points for stations and CAS from the moved line, supply lines to the moved front. `SimConfig.suppressAirSupport` (tools only) keeps one side's strike and ground-support plug-ins out of its orders.
- **The map.** The worker sends a `GroundPicture` hourly (each front's line now, brigades and regiments with their strength behind it); `buildMilitaryOverlays` draws the live line in place of the start line, and `buildGroundOverlays` draws each brigade or regiment, in a grid behind its segment (columns along it and rows deeper, 14 km apart, from 10 km behind the line), as a square badge in its side's color with an oval (armor) or an oval with an X (mechanized), at the Region band, smaller below 60% strength and gone below 15%. The roadmap asked for battalion symbols; at the Region band a view would hold more than a hundred of them, so the map shows their brigades and regiments, tens in a view, and the battalions stay the sim's units. Echelon marks wait for R3.6. The viewing side's filter applies as for flights (decision 48).
- `SIM_STATE_FORMAT` stays 3: the ground war is a new saved part.

**How it was checked.** `tests/groundWar.test.ts`: the order of battle on both sides, the Pact's more divisions, its determinism and the attacker's mass at the pressure; a day that moves the front within its limits and costs both sides strength; the ATO's front points on the moved line; CAS kills where it attacks; supply falling behind cut bridges and damaged depots; a day without the attacker's air support ending with a different front; the map's symbols by side and shape. `tests/demoSeeds.test.ts`: the front moves more than 1 km on each demo seed over 26 hours (synthetic weather) and both sides lose aircraft over the three seeds. `tools/airSupport.preview.ts` (24 h, real climate), the largest segment offset (km, + toward the defender; the Pact attacks on all three):

| Seed | Full air war | Without Alliance air support | Without Pact air support |
| --- | --- | --- | --- |
| 4 | 15.4 | 14.3 | 0.7 |
| 10 | 8.6 | −0.1 | −0.9 |
| 7 | 9.9 | 19.8 | 9.7 |

On seed 4 the Pact's breakthrough at its main corridor depends on its air support; on seed 7 the Alliance's air support halves the Pact's advance. Seed 10's response is not monotonic: without either side's strikes the air war's allocation shifts (more CAP, different intercepts) and the Pact's advance stalls in both runs; this is in TODO.

`tools/war.preview.ts` at 64× and 256× gives the same end states as one jump on all three seeds (`fad81879ba800bb1`, `cae2d1f160e53708`, `7bfa74c80a16f4d3`): 26–38 ms per game hour, 0.05–0.07% of real time at 64× and 0.19–0.24% at 256×; the worst single step is about 200 ms on seed 4, the hour when the weather fields, an order revision and the supply update coincide.

**Reason:** the demo's loop needs a war on the ground that the air war changes and that changes the air war, and R2.4's follow and R2.8's promotion need battalions with seeds at places along a front the player can see move.

### 252. Follow: campaign aircraft in the simulation view, a cut behind the flight, a read-only HUD and displays

**Date:** 2026-11-20
**Decision:** R2.4. The player follows any flight of the war that has started, and the simulation view draws the campaign's aircraft.

- **Follow** (`src/follow/follow.ts`) starts from a row of mission search, from the map's selection panel or from a subscription's offer (now *Show* and *Follow*). It sets the clock to 1×, cuts to the chase camera behind the flight's lead and lets the camera settle in from 2.6 times its rig's distance over 2.5 s (owner decision 12; the eased dissolve through cloud stays R6.6). A bar at the top names the flight, its type, the aircraft followed, the phase and the speed; N steps through the flight's aircraft, C recenters free look, a drag looks around and the wheel moves the camera closer or farther. Escape, M or the bar's button returns to the map, which lands above the flight with it selected. The view returns by itself when the flight lands or its last aircraft is lost, and says why. The followed mission is looked up by id each frame, since the worker replaces the list when a route changes.
- **Poses.** The aircraft fly their analytic routes (`analyticPose`, decision of R2.4's first task): the lead on its route, the others in their formation slots, one per aircraft left in the flight. Routes stand on the coarse ground (decision 240) and on sea level at their bases, while the view draws the tiles, so the drawn aircraft keeps at least 40 m above the drawn ground in the air (rising at once, sinking back over a 4 s time constant) and stands on it, on its wheels, on the ground (`follow/followFlight.ts`). The lift is presentation only; the route and the campaign never see it, and R2.5's handover starts from the route.
- **Models.** Each type is drawn with its bundle's geometry (rule 17). Of the 31 air-war types, 6 have geometry; until R2.7 gives the rest theirs, a type without one is drawn with a **stand-in** of its class and side (fighter: F-21 or Vo-31; strike: F-124 or Vo-35; the large types: the C-150; helicopters: the UH-68), painted in the type's own camouflage, and the bar says so. The **C-150**'s model is new (a C-130 analogue: high wing, four turboprops whose propellers spin into discs, upswept tail; 770 triangles within the bomber budget of 600–1,500, and 216 more per propeller disc), so airlift, a demo type, has its own aircraft to follow.
- **Rigs.** The chase rig comes with the drawn model: the type's own (`rig` in its bundle), a variant's from the geometry it borrows, a stand-in's from the stand-in. The Vo-31, Vo-35 and F-124 bundles get fast-jet rigs scaled by size (20, 23 and 24 m back), and the C-150 a transport rig (70 m back, 14 m up, slower rotation and more stretch). Helicopter rigs scale with the drawn rotor.
- **Other flights** within 25 km of the camera are drawn too, in the chase view and at an observer station alike (`follow/campaignTraffic.ts`): full views (ink, shadow, gear) for the six nearest within 1.5 km (kept out to 2 km), and beyond that one instanced mesh per model, scheme and gear state, lit like the full views but without ink, shadow or moving parts (`render/sim/aircraft/trafficLayer.ts`). Both sides' aircraft show: the view is the world, not a side's picture; the map keeps the viewing side's filter (decision 48).
- **HUD and displays.** The HUD is the flown aircraft's (`Hud`) with a frame built from the pose (`followHudFrame`): airspeed is the route's speed calibrated at the standard atmosphere (the route knows no wind), the load the coordinated turn's 1/cos(bank), no angle of attack, sideslip or warnings, gear down on the ground and below 1,000 ft in departure and arrival, and the mode reads FOLLOW. The displays are the followed type's own formats from its bundle's avionics profile, with the master mode's triggers and the moving map (as Free Flight's, decision 201), read-only: their keys stay off. This answers the design's open question on spectating. Their radar and threat formats stay empty until R2.6's sensors read campaign contacts.
- **The free camera** of the simulation view is now `?dev` only (it was also on the dev server): the view is entered through a unit, as decision 72 says.

**How it was checked.** `tests/follow.test.ts`: every air-war type gets a drawable model, a known scheme and a rig; own geometry, variants and stand-ins by class and side; one pose per aircraft; the drawn altitude over a ridge, on the ground and while the ground is unknown; the lift's easing; the gear; the HUD frame. `tests/bundles.test.ts` lists the C-150's geometry and the three rigs as done. `tools/browser.smoke.mjs` gains a `follow` part (`ONLY=follow`, not in the default run): on seed 4 the war runs at 64× until a flight of each demo type is airborne, mission search's Follow (the first) or the app's handle (the rest) follows it, and each picture must show the HUD, the clock at 1×, the camera above the ground and the aircraft within 25° of the view's axis; Escape must land on the map with the mission selected. Check 10 samples the camera's height over the drawn ground while it follows CAS; check 7's pictures are the HUD against the day's sky, snow and night.

That part could not run here: in Chromium on lavapipe the app stops drawing after its ninth frame in the simulation view (and on the map) while the GPU process grows by about 1 GB every 5–10 s, until the kernel kills it after about 195 s, on seeds 4 and 1983 alike and at the commit before this decision (TODO, known issues). It is for the owner's GPU (`MODE=gpu`). In its place `tools/follow.preview.ts` renders followed flights on Dawn (seed 1983): an analytic route from a base of the type's side, the flight posed and lifted as `follow/` does it, the lead in its full view and the wingmen instanced, the chase camera on the pose; `tools/freeflight.screens.mjs` draws the read-only HUD over them (`docs/reports/screens/follow-*.png`). The F-21 on CAP at 9,000 m, the Vo-35 on CAS banked 21° left in its turn at 4,000 m (the HUD reads 282 kt, 13,123 ft, 21° left) and the C-150 at 7,000 m with its propeller discs are framed 3.5–8° off the view's axis. The wingmen fly 96 m and more behind the lead, so they are behind the chase camera of the lead; free look or N shows them.

**Reason:** proposal 0008's loop has the player find a mission and watch it before taking it over; R2.5's handover needs the followed flight on screen in the same chase view the player will fly in.

### 253. Following, from the owner's first look: formations by phase, altitudes by mission and type, an orbit around the aircraft, panels on request

**Date:** 2026-11-20
**Decision:** The owner followed flights of every demo type on the GPU (`ONLY=follow`, seed 4: all checks passed) and asked for the following; each is done as stated.

- **Formations by phase** (`src/sim/air/formation.ts`). Wingmen fly slots in the lead's level frame (heading and local vertical, so a banked lead no longer tips a wingman 600 m abeam up or down), in wingspans of the drawn model: *close* (fingertip, about a span apart), *route* (5 spans back, 8 aside), *spread* (combat spread line abreast, 60 spans: 600 m for fighters), *trail* (80 spans apart, offset out of the wake) and *stream* (transports and bombers, 30 spans). Each mission plug-in names its formation per phase (`MissionPlugin.formations`, rule 16): fighters and strike aircraft close on the ground and near the field, route in cruise, spread from the fence-in (`TACTICAL_FORMATIONS`); interdiction attacks in trail; CAS works the front in trail with route on the way in and out; airlift, support and bombers fly a stream (`STREAM_FORMATIONS`). A change takes 45 s from the phase's start, eased. R2.5's formation keeping flies the same slots. The old `slotPose` (120 m steps behind the lead) is replaced.
- **Altitudes by mission and type.** A profile may name `lowRoles` that fly it low though its other types do not: interdiction's penetrators (deep-strike and carrier-attack roles: the F-124, A-14 and Vo-37) descend at the low fence-in (120 km out) to low level and fly it at low-level speed, attack and leave low for 60 km (decision 240's terrain floor lifts the legs over the ground). CAS works its station at `CAS_ALTITUDE` (2,500 m), reached by a descent from the fence-in, instead of its type's cruise altitude. Everything else keeps its type's cruise altitude: fighters on CAP at 9–10 km, transports at 7 km, AEW orbits at their types' altitude.
- **The orbit around the aircraft** (`chaseCamera.ts`, `orbitWeight`). A fixed-wing rig looked at a point 25 m ahead of the nose whatever the free look, so turning the eye round the side or front orbited that point. The look point now moves onto the aircraft as the eye turns away from behind, fully at 45°; the resting view is unchanged, and Free Flight's jets get the same orbit.
- **Panels while following** (`Follow.panels`). A spectator sees the HUD alone by default; V steps to the HUD with the aircraft's displays (the flown view) and to a clean view (the bar goes too; Escape still returns). The debug panel is hidden while following unless the URL has `?dev`. The FPS gauge moves under the follow bar (`body.following`), clear of the messages display.
- **Aircraft on their airfields.** The sim's routes start and end at the coarse airbase points, while the view draws the airfields sited on the eroded world (decision 220), up to tens of kilometers away, so an E-5 parked for departure stood in open country. Drawn aircraft near an airbase are now moved onto its sited field: fully within 3 km of the coarse point, fading out by 30 km, so takeoff and landing run on into the route; on the ground the nose turns to the sited runway. Presentation only, like the drawn altitude; the sim keeps the coarse record.
- **The Kestrel's main gear** folded outward about a fore-aft hinge by −88°, leaving the wheels hanging under the wing roots. It now folds inward by 135° about a hinge at the fuselage's side (y −0.5 m, z ±1.2 m), and the wheels stow inside the fuselage's section without the two meeting. The gear down is unchanged, and so is the flight (the flight spec's wheels are separate).

**How it was checked.** `tests/formation.test.ts` (every registered type names a formation for every phase; the eased change; spread 600 m against close under 30 m; wingmen level with a banked lead), `tests/analyticPose.test.ts` (route: #2 left, #3 right), the unit suite (1,208 tests). `tools/war.preview.ts` (24 h, real climate) still gives the same state stepped at 64× and in one jump on the demo seeds (`78161b7d48445bad`, `05c8e9e6e1ec28ff`, `75d06312b92a6e3c`), with aircraft lost (A/P) 18/18, 11/18 and 3/1 against decision 250's 15/20, 11/14 and 3/6. The browser smoke test's `follow` part now finds check 10's flight by its route's leg (a low-level leg with two minutes of it left: a penetrator on interdiction or a low strike) rather than following CAS, waiting at most `LOW_WAIT` (600 s at 64×) and failing with a message if none flies (`LOW=0` leaves it out). Its first version looked for legs below 400 m above sea level, which the terrain floor rarely leaves, and waited 15 minutes on the owner's run. The second still looked hung on the owner's run: it waited silently. A headless day on seed 4 shows why low legs are rare there: interdiction's plug-in takes its squadrons in role order, multirole first, so the F-21 and Ar-23 fly all of it at cruise altitude, and the low legs are the deep strikes' (F-124, Vo-37; 11 a day, from about T+14 h) and reconnaissance's (from T+3.7 h), six to nine game minutes each and split by the terrain floor into legs of under two minutes. The step now joins those legs, logs every 20 s what it waits for and when the next low leg starts, and gives up after `LOW_WAIT`. Whether penetrators should come first for interdiction is the owner's call (TODO).

Left for later, in TODO: the eased dissolve from the orbit into the aircraft (a stretch goal for R6.6, owner), the E-5's own model (R2.7), and check 10 over truly low flight (the GPU run's CAS was climbing out, 1.7 km above the ground).

**Reason:** the owner's review of R2.4's follow on a real GPU.

### 254. Interdiction by the nearest able squadron; the owner's campaign direction (alpha strikes, airfield attack, seizures)

**Date:** 2026-11-20
**Decision:**

- **Interdiction's squadrons.** The owner wants penetrators and multirole types both to fly interdiction, as the war, the aircraft available and the base (a carrier or not) allow. The interdiction profile's roles now rank alike (`MissionProfile.rolesAlike`): the ATO takes the nearest squadron that can fly it, within range, the ledger and its base's stocks, as for every type; against a defended target (the need's `defended`, which also adds the escort) its `lowRoles` (the F-124, A-14 and Vo-37) come first and go in low (decision 253). Before, its role order put the multirole types first, so on seed 4 the F-21 and Ar-23 flew all of it. A headless day now gives interdiction to the F-21 (19), the F-124 (4, low) and the Ar-23 (6) on seed 4, the F-124 (7, low), the Ar-23 (6) and the F-21 (3) on seed 7, and the F-21 and Ar-23 on seed 10, whose Alliance has no penetrator in range; flights with low legs start 1.5–2.5 game hours in on every seed. `tools/war.preview.ts`: the same state stepped and in one jump (`18ce2496b3d85040`, `7fcf7903935f0a21`, `75d06312b92a6e3c`); aircraft lost (A/P) 22/20, 11/18, 3/1.
- **The campaign's direction** (owner, 2026-11-20): *Red Storm Rising* and the novels like it are the model, as the design's opening says. Three operations from it join the roadmap, each with its plug-in when its milestone comes: **airfield attack** with runway-denial weapons (Durandal analogues: cratered runways close a base for hours; shelters, aircraft on the ground and fuel are targets), which replaces the provisional "strikes on airbases" that do nothing yet (R4.2); **carrier alpha strikes**, a whole air wing in one package (R4.2); and **amphibious and airborne seizure** of an island airfield or port, after which a squadron stages forward onto it, as in the novel's Iceland operation with its MiG-29 squadron (R4.6, with R5.1's logistics to keep it supplied). `docs/design.md`'s mission table and `docs/roadmap.md`'s R4.2 and R4.6 say so.
- **The smoke test's check 10** slows the clock to 4× within 15 game minutes of the next low leg: on the owner's run a six-minute leg at T+5.6 h passed in five seconds at 64× between two polls, and the check waited until T+7.3 h.

**Reason:** the owner's review of R2.4's follow on the GPU (all checks passed, check 10's camera 100–106 m above the ground at low level).

### 255. Following, the owner's second look: carriers, gear and pylons, turns, egress, canopy clearance

**Date:** 2026-11-20
**Decision:**

- **Carriers in the simulation view.** Carrier groups within 40 km of the camera are drawn on their tracks (`CampaignTraffic.carriers`, instanced): the carrier (the Pact's uses the Alliance's model until it has its own) with two escorts, destroyers or cruisers, 1.8 km abeam and 1.2 km astern. A carrier flight stands on the deck: its route's ground points (where the carrier was at launch and at the planned landing) are moved to where the carrier is now, with the airfields' fading shift (decision 253), and on the ground it stands at the deck's 23.2 m (`DECK_HEIGHT`). Before, a carrier CAP sat on open sea.
- **Gear and pylons.** The F-124, Vo-35 and Vo-31 had no landing gear, so on the ground they sat on their stores: each now has a tricycle gear on the `gear` channel, retracting into the fuselage. Each fold was found by a search over hinge positions and angles for one that puts every point of the folded wheel inside the fuselage's section; the parts' `anim` blocks carry the result. The Kestrel's nose wheel folded forward and out of the nose: it now folds 110° aft into the fuselage. Underwing stores on the three hung below the wings with a gap: pylons now join them to the wing. Triangles: F-124 690, Vo-35 774, Vo-31 682, within the 300–800 budget.
- **Formation turns.** A formation turns about the vertical at the lead's turn rate, g·tan(bank)/v, so each wingman now has the velocity of its slot: faster outside the turn, slower inside (`slotPose`; the HUD of a followed wingman reads it).
- **Egress.** After a pass, routes reversed at a corner and flew home back over the target, and the analytic pose's smoothed heading slid sideways through the reversal. The route now turns toward home through a real radius (2 g at the attack's speed, legs every 15°, `turnToward` in `missionRoute.ts`) after a pass or a station, so the way home runs about two turn radii abeam of the target. `tests/egress.test.ts`: no corner over 21° in the egress, nothing within half a pass length of the target.
- **Canopy clearance.** The drawn lift kept 40 m over the drawn ground, which is the terrain without its trees (tropical canopy reaches about 43 m). It now keeps 90 m for fixed-wing aircraft and 50 m for helicopters (`FOLLOW_CLEARANCE`, `HELICOPTER_CLEARANCE`).

`tools/war.preview.ts`: the same state stepped and in one jump on the demo seeds (`959aa34f14d3c686`, `d3c185eb6cf58e8b`, `9a6835d99e3b84cb`), aircraft lost (A/P) 21/22, 11/18, 1/3. The unit suite passes; `tests/ato.test.ts`'s wind test now measures the phase's longest leg, the way home, rather than the first leg of the turn.

Left for later (TODO): formation lights at night, off in combat spread; taxi and takeoff in turn; the Pact's own carrier model; the karst towers and other landform props are not in the one height function (R3.6), so low flights pass through them, and whether to keep them is the owner's call.

**Reason:** the owner's second look at R2.4's follow.

### 256. Full fidelity begins: promotion and demotion, an AI pilot that flies the route, the rejoin route, racetracks joined the way a flight arrives

**Date:** 2026-11-20
**Decision:** R2.5's first tasks, headless. The owner checked decision 255's fixes (carriers, gear and pylons, formation turns, egress, canopy clearance) before it began.

- **Promotion** (`src/sim/flight/promotion.ts`) builds one `FlownAircraft` per aircraft of a flight from its pose as the simulation view draws it: the analytic route in formation, on the sited field and lifted over the drawn ground, since full fidelity flies where the view draws (owner decision 8). Position, velocity, heading, bank and flight path (plus the 1-g angle of attack) come from the pose, body rates start at rest, the gear is up and the throttle at cruise power in the air. Fuel goes by share, because the air war's load includes drop tanks (the F-21's 5,800 kg) and the flight model's tanks hold the internal 3,200 kg until R2.6 hangs tanks on pylons. Stores (the loadout, nothing expended) and damage (none) are records the aggregate flight does not have yet; demotion returns them for R2.6.
- **Demotion** reads the flown aircraft back: the survivors, the crashed as losses with where and why, where the flight is (its lowest surviving slot), its track, speed, height and the least fuel of the survivors in the route's terms.
- **The AI pilot** (`src/sim/flight/aiPilot.ts`) flies a reference trajectory through the flight director, so nothing but the flight model moves an aircraft (rule 12). A campaign flight's orders are its analytic route: its legs, climbs, racetrack, pass and turn home are all functions of time, so one law flies every phase. The lead keeps station on the point the route gives for the moment: ground speed is the route's plus 0.02 m/s per meter behind, within ±25%; the course is the route's track 3 s ahead plus the angle to the point over 12 s of flight; the flight path climbs at the route's rate plus 0.08/s of the height error. Speed comes first: as the airspeed falls short of the command the climb gives way (level at 30 m/s short), the bank limit comes down to half and never asks more load than the airspeed gives at 8° of angle of attack, n = (CAS / least)², below the least speed the nose goes down, and short of speed the afterburner may come in. Wingmen fly the same law with tighter gains on their slots of `formation.ts` beside the flown lead, the lead's state carried ahead along its velocity. A route's analytic pose costs hundreds of route lookups, so the lead's reference is sampled at 4 Hz and interpolated (a CAP test flight went from 53 s to 14 s).
- **`PromotedFlight`** (`src/sim/flight/promotedFlight.ts`) holds the aircraft and their pilots and steps them on its own clock, which game time drives (`advanceTo(t)`: a pause holds it, the flight cap of 8× only takes more steps, at most 40 a call), the lead first so the wingmen read its new state. The lead is the lowest surviving slot. `takeOver(slot)` takes that aircraft's AI pilot away and leaves it to the aircraft's own input source (`FlownAircraft.pilot`: mouse aim's hook or the raw controls), and the wingmen keep formation on the player when the player leads; `handBack(reference)` gives it back with a rebuilt route; `remove(n)` drops the highest slots the player does not fly when the campaign loses aircraft.
- **The rejoin route** (`rejoinRoute` in `missionRoute.ts`) rebuilds the mission from where a flight is handed back: the route as flown until then, then from the fix a turn through a real radius and the rest of the plan by the phase there. Before the target it flies the climb (if still low), the ingress, the fence-in and all of the planned work; on target the station time left (none under a minute), or a pass not yet flown over the target; after it, home. The racetrack keeps its center and axis, a station is cut to what the fuel allows, a flight short of fuel goes home, and phases never run backward. Its turns bank 45° rather than the egress's 2 g, which a fighter cannot sustain at 9 km: with 2 g the lead fell 5 km behind its new route in the turn back, with 45° it stays within 400 m. The route builder's stages (`inbound`, `outbound`) are shared with planning, whose routes are unchanged by the split.
- **Racetracks are joined the way a flight arrives.** A flight joined its racetrack at the lower leg's start, which runs toward the base, so every CAP planned from its base reversed by about 170° at the entry, and the analytic pose smoothed the reversal into a 10°/s turn: drawn in the follow view and impossible for the AI to fly. `orbitJoin` picks the point around the racetrack that the flight reaches by a straight leg with the least turning at both ends (64 candidates, a little preference for near points); the segment records where it joined (`around`, 0 in routes saved before). This changes every world's CAP and CAS routes, so the campaign's state too.

**How it was checked.** `tests/promotion.test.ts`: each aircraft placed at its pose with the route's share of fuel, demotion back to the route's state, a crash counted as a loss with the next slot leading; an F-21 CAP pair promoted 30 s into the climb-out and flown by the AI to the approach on a flat world without a crash, the lead within 5 km of its route throughout (the route climbs at the air war's 110 m/s, steeper than the Kestrel sustains at its climb speed: it follows late and catches up by the station) and within 400 m on station, the wingman within 600 m of its combat-spread slot; the player turning 60° off the station with a wingman within 500 m of its slot after 90 s, then the lead within 800 m of its rebuilt route after the handback. `tests/rejoin.test.ts`: the rejoin keeps the route as flown and goes on from the fix in every phase, with phases in order, the mission completing and the fuel feasible; a flight 25 km off its station returns to the same racetrack for the time left with no corner over 25°; under a minute of station left it goes home, and short of fuel its station is cut; the racetrack's join is within 30° of the arriving heading. The unit suite passes (1,225 tests). `tools/war.preview.ts`: the same state stepped and in one jump on the demo seeds (`d738988fb706b882`, `2890fd9a734772fb`, `d99d3dddb11e4460`), aircraft lost (A/P) 18/12, 13/12, 3/4 against decision 255's 21/22, 11/18, 1/3: CAP stations are worked from other points of their racetracks, so interceptions fall differently.

Left for later (TODO): the worker's protocol (a take-over holds the mission; a handback logs the state and rebuilds the route), the follow on full fidelity with its ground, take over and hand back, the flight cap, the session's consequences, the exit test; the abort's own turn home; the route's climb against the Kestrel's.

**Reason:** R2.5 lets the player take over any flight of the war and hand it back; the aircraft must fly at full fidelity on the same physics path whoever flies them (rule 12), and the war must be able to carry a flight on from wherever the player leaves it.

### 257. Taking over and handing back in the worker: the flown flight is held, the handback rebuilds its route

**Date:** 2026-11-20
**Decision:** R2.5's worker protocol (owner decision 1: the flown aircraft steps on the main thread, its consequences return as logged campaign events).

- **Two inputs** join the event log: `take-over` (a mission and the slot the player flies) and `hand-back` (the mission, the fix where the flight is in the route's terms, from `PromotedFlight.demote()`, and the aircraft full fidelity lost with where and why). Both are player inputs, so a replay from a checkpoint applies them again and reaches the same state.
- **Holding** (`AirOps.hold`): inside the mission's jump-in window (`jumpInOpen`) and once only, the mission is marked `flown` (slot and time) and its phase events are cancelled, so its aggregate resolution, subscriptions and completion wait. Resolution also leaves a held flight out as another package's interceptor, escort or suppressor: the player's flight fights at full fidelity (R2.6), not in the tables.
- **Releasing** (`AirOps.release`): the lost aircraft are lost as any loss is (the squadron's strength falls, crews eject or are killed, `aircraft-lost` with the cause, a crash for now), the route is rebuilt from the fix with `rejoinRoute` (decision 256) on the coarse ground's terrain floor, its phases after now are scheduled again, and a `mission-rejoined` decision records the phase it carries on in, its segments and its end. The fix counts as at the worker's time, a frame or so from the main thread's, so the phases after it are scheduled exactly once, on replay too. Winds aloft are left out of the rebuilt route until AirOps can read the planner's weather.

**How it was checked.** `tests/handover.test.ts` on seed 7's campaign world: a CAP taken over a minute after its fence-in is held past its old route's end without resolving or completing; handed back 20 minutes later with #2 crashed, the flight and its squadron are one aircraft short, the crash and the rejoin are in the log, and the mission resolves and completes on its new route; a run with a backward seek past the take-over replays to the same hash as a straight run; a take-over before the climb-out or a second one is refused. The unit suite passes (1,228 tests). `tools/war.preview.ts` (no take-over; the hash now includes the `flown` mark): the same state stepped and in one jump on the demo seeds (`771e7f5ac978d9d2`, `cbc71cc13f9c2da9`, `9d9e377ea91f9131`), aircraft lost (A/P) 18/12, 13/12, 3/4 as in decision 256.

Left for later (TODO): while the player flies, the map and other flights' resolution see the held flight on its old route until fixes are posted as it flies; the follow must not end a held flight at its old route's end.

**Reason:** the war must carry on whatever the player does with a flight, and replay must reproduce it from the log alone (rule 19).

### 258. Combat spread a nautical mile abeam; the owner's air-combat, naval and radio direction for later phases

**Date:** 2026-11-20
**Decision:**

- **Combat spread** is a nautical mile abeam (`SPREAD_ABEAM`, 1,852 m), 30 m back, the second element's wingman two miles out. Decision 253 set it at 60 wingspans, about 570 m for the F-21, which the owner pointed out is far tighter than the doctrine: US Navy combat spread and the US Air Force's line abreast are flown about 1 to 1.5 nm apart, for mutual support by eye and by radar. That distance follows from the tactic, not the airframe, so spread's slots are in meters (`slotMeters`); the other formations stay in wingspans. Formations are presentation and the AI's slots, never campaign facts, so the war's state does not change. The AI wingman in `tests/promotion.test.ts` still holds its slot within 600 m on station at a mile: the racetrack's 1.5°/s turns ask it for about 48 m/s more outside the turn, which it has. A tighter turn at altitude needs combat spread's tactical turns (cross turns, in-place turns) instead of holding the slot; those come with air combat in R3.4.
- **For later phases** (owner, 2026-11-20), now in the roadmap:
  - A living world: the owner wants to see every other flight inside the bubble around the player. The simulation view has drawn every flight within 25 km of the camera since R2.4 (decision 252: full views within 1.5 km, instanced beyond), in the chase view and at an observer station; full fidelity must keep it (R2.5, TODO). Marking the player's own flight on the HUD and on the moving map and radar by intraflight datalink, since a wingman a mile abeam is a speck, goes into R2.6 as a smaller item of the same kind.
  - R3.3: radar missiles as semi-active (Sparrow analogues, Fox 1) for most types, the navy fighter's long-range missile (the F-28's Phoenix analogue) against bombers, and active-radar missiles (Fox 3) as a campaign setting for the late era.
  - R3.4: BVR timelines for the AI and the player's flight (commit, sort, shot, crank, notch, abort and minimum abort ranges by missile and threat) and basic fighter maneuvers in the merge.
  - R4.6: Backfire (Ra-84) raids on carrier groups with heavy anti-ship missiles, the outer air battle against them, and the vampire calls and point defense when the missiles are inbound, as in *Red Storm Rising*.
  - R4.5, now *Crews and radio*: check-ins with the strike lead and with AWACS and ground controllers, air traffic control near airfields, brevity in the comms format. Controllers' callsigns are invented per side like the setting's other names, not the real ones (the owner's Darkstar, Magic and Overlord are examples of the kind).

**Reason:** the owner's review of R2.5's start.

### 259. Urban ground in the terrain shader (Proposal 0009, Phase 1)

**Date:** 2026-11-20
**Decision:** Proposal 0009 (settlements and cities) is accepted and lives in `docs/proposals/0009-settlements-and-cities.md`; `docs/plans/cities.md` plans it. Its first phase replaces the roof-and-wall lattice of the built-up patches (decision 71) with urban ground, drawn by the terrain shader with no geometry:

- **The pattern** (`render/sim/infra/urbanPattern.ts`, `LightShading.urbanGround`). Each town and industrial site carries a street grid in its local frame (east and north at its center, as `localFrame`): turned to the bearing of the busiest road leaving its cell (from the network tier), spaced 90 m in cities (60,000 and up), 105 m in towns and 120 m in villages, a major street on every third line (7 m half-width, else 4.5 m), each edged by a 2.5 m sidewalk. Each block takes one ground class from a hash of its index and the distance of its center from the town's center, as a share of the built-up radius: squares within 0.14, parks and parking lots, paved courtyards within 0.4 and gardens and yards (alternating by parcels a third of a block wide) beyond; industrial sites take concrete and gravel. The pattern's parameters are one vec4 per light record (`InfraScene.townInfo`, read through `LightTables`).
- **One hash on both sides.** The block hash is the canopy's 32-bit integer hash (decision 148, `cellHash` and `cellHashNode`), so the CPU's twin (`urbanClassAt`) picks the same class as the shader bit for bit, and the town buildings (`structureLayer.ts`) keep off streets, sidewalks, squares, parks and parking lots and turn square to the grid. A `fract(sin(…))` hash would differ between float64 and float32.
- **Distance.** Where a block shrinks below about four pixels, or beyond `groundRange` (11 km, about the building range), the ground gives way to `builtAlbedo`'s roofs: the far representation of Part A's detail levels ("shading only: roof colors").
- **Ballast.** Railways were concrete strips; concrete segments narrower than 6 m (railways are the only ones) now draw as ballast (`RoadShading.coverage` returns a fourth component).
- **Views.** `tools/render.preview.ts` gains the standard city views of Proposal 0009: `city5k` and `city1k` over the largest city, `town300` over the settlement nearest 20,000 people, and `citynight`.

**How it was checked.** `tests/urbanPattern.test.ts` (streets on the lines, majors wider, sidewalks, the hash against the canopy's, squares only in the core, buildings off streets); the standard views on seed 4 before and after (`docs/reports/cities-baseline.md`), on lavapipe.

**Reason:** the built-up patch read as a patchwork of colored squares, not as a town, and the buildings stood on it at random. Structure first: even before Phase 3's streets, a town has streets its buildings respect. Settlement plans (Phases 3–5) replace the grid near the camera with their own streets and parcels; the grid stays as the fallback for towns without one.


### 260. The settlement generator: a pure plan per settlement, game-agnostic, built on demand

**Date:** 2026-11-20
**Decision:** Proposal 0009's settlement generator lives in `src/worldgen/settlements/`. `planSettlement(input, seed, options)` turns one settlement's input into a `SettlementPlan` of plain arrays in the settlement's local frame: streets, blocks, parcels, buildings, landmarks, candidate targets, plume sources, pads and the metrics the checks read.

- **Frame.** Gnomonic about the settlement's center, east and north as `localFrame` (`frame.ts`), so the terrain shader can take the same coordinates.
- **Input** (`fromGraph.ts`). The graph's settlements, the land nodes' naming flavors, the urban extents (decision 103; capped at 1.5 built-up radii and 11 km), roads (network tier, or aligned routes when the caller passes them), railways, the drawn rivers, coastlines by marching squares on the water mask, and a height and water function. It reads no cast, territory, fronts or post-casting infrastructure. A lint rule in `eslint.config.js` and a test enforce this: the generator imports no `campaign`, `sim`, `render`, `ui`, `freeflight` or `follow` module, no `strategic/{fronts,territory,infrastructure,sites}`, and nothing named after factions.
- **Tiers** (`tiers.ts`). Cities from 200,000 people (the graph's own `settlementKind` city, about 24 per world on seeds 4 and 10), towns from 15,000 (about 420), villages below (about 1,300). Farmsteads are satellites of villages and towns. The proposal's town view at 20,000 people falls in the town tier.
- **Streams.** `settlements/streets`, `/districts`, `/parcels`, `/buildings`, `/landmarks` and `/farmsteads`, each forked by the settlement's key. A plan therefore depends on nothing but its input and seed, and no earlier stage draws differently.
- **On demand.** Plans are not built with the world. On seed 4's coarse world, the 24 cities took 0.7–8.8 s each (median about 2.5 s; the largest has 200,000 buildings), towns 0.15–0.6 s and villages 10–40 ms. Building all of them would roughly double world generation, against the proposal's limit of 30%. The renderer builds the plans near the camera, off the main thread (decision 266). World generation time is unchanged.

**Reason:** constraint 5 of the proposal (the generator belongs to the world), determinism (constraint 6), and the frame rate: generation cost scales with the area a player can see, not with the world.

### 261. Urban styles by cultural region and climate

*Preferences revised and two styles added by decision 292.*

**Date:** 2026-11-20
**Decision:** Five styles (Western, Eastern bloc, Mediterranean, Nordic, Arid; `styles.ts`) attach to cultural regions, never to sides.

- A naming region is a land node (decision 96). One landmass often holds a whole war, so each node is split into up to three **style regions**: one more per 120 settlements, seeded by farthest-point sampling from the most populous settlement, with no random draws.
- Each flavor lists styles in order: A northern (Nordic, Western, Eastern), B eastern (Eastern, Western, Nordic), C southern (Mediterranean, Western, Arid), D steppe (Arid, Eastern, Mediterranean), E islands (Western, Mediterranean, Nordic). Style region *k* starts at preference *k*.
- **Climate gates** (rule 15: culture picks, climate permits). Arid needs a dry biome, Nordic a cool one, Mediterranean a warm or dry one. A gated style falls through to the next preference; Western and Eastern bloc are never gated.
- Each style has a palette (walls, roofs, flat roofs), roof types and pitch (Nordic 0.85, Mediterranean 0.3), house floors, chimney share, an old core or not (Nordic has none), radial avenues, street spacing (Eastern 1.25×, Nordic 1.35×, Mediterranean 0.85×) and microdistricts (Eastern only).

**Reason:** the proposal keys styles to culture. A single style per continent would make a front-line war look the same on both sides, and the generator may not ask which side holds a town.

### 262. Streets: a tensor field, streamlines, a planar graph, old cores and a grade limit

**Date:** 2026-11-20
**Decision:**

- **Field** (`tensorField.ts`, after Chen et al. 2008). A weak seeded base grid; per arterial the nearest segment's direction with a Gaussian falloff (600 m in cities, 400 m in towns; motorways weigh most); a radial field round the center by style; the nearest river, coast or rail; and a contour field whose weight rises from 3% to 10% slope and dominates there (weight 6). The field is cached on a 20 m lattice and interpolated as a tensor; ground heights are cached on a 30 m lattice.
- **Tracing** (`streets.ts`). Majors are traced first, then minors, each along both eigenvectors, with RK2 steps of 10 m and Jobard–Lefer seeding. Separations are 240 / 95 m in cities and 280 / 115 m in towns, times the style's spacing, widening by up to 1.9× toward the extent's edge. A line stops at water, outside the extent, on slopes above 30%, in the old core, within half a separation of a parallel line of its level, or on closing on itself. On slopes above 10%, a minor line ends where it would step within 60° of the fall line: hill-town minors run along the contours, and majors, paths and stairs cross.
- **Graph** (`graph.ts`). Free ends are extended by 0.45 minor separations to meet streets they stop short of; crossings split edges; nodes merge within 3 m; overshoots are trimmed; faces are walked by turning to the previous edge counterclockwise.
- **Old cores** (`oldCore.ts`). A relaxed Voronoi ward layout within 0.16 built-up radii in cities (300–900 m) and 0.2 in towns (180–420 m), 45 or 18 wards, with the market square as the center cell. A quarter of the inner edges are left out, so blocks merge irregularly. A wobbly ring road meets the traced streets.
- **Grades.** Each edge is sampled every 25 m. Vehicle streets steeper than 10% become paths, and steeper than 25% stairs. Arterials keep their class (the regional network's grades are proposal 0005's).
- Streets over water are dropped; only arterials cross rivers, and those crossings are exported as bridges.

**Reason:** the proposal's street model. Chen et al.'s field gives grids that bend with roads, coasts and contours, without hand-written rules per case.

### 263. Blocks, parcels and districts

**Date:** 2026-11-20
**Decision:**

- **Blocks** (`blocks.ts`) are bounded faces between 500 m² and 250,000 m². Each is inset by its streets' half-widths plus a 2.5 m sidewalk (per-edge miter offsets). A face that cannot be inset cleanly is dropped and counted (about 4–6% of faces in cities).
- **Parcels** (`parcels.ts`, after Vanegas et al. 2012). The smallest box is split across its long axis at the middle ±10% until the district's target area is reached. A cut is kept only if both halves keep street frontage; otherwise the other axis is tried, and if that also fails the piece stays whole. Every parcel thus fronts a street. Targets: old core 240 m², inner grid 520, terraced 170, detached 750, industrial 5,000, rail yard 9,000, port 4,000, times the style's factor (Nordic 1.5, Mediterranean 0.7, Arid 0.6).
- **Districts** (`districts.ts`), in order: old core (inside the core); rail yards (the rail-side blocks nearest the center, three in cities and one in towns); ports (water-side blocks of port settlements); industry (near rail or water beyond 0.3 of the extent, more often in the Eastern bloc); civic and parks (steep blocks, and 5–8% at random); microdistricts (Eastern bloc, 0.3–0.85 of the extent); inner grid (within 0.4 in cities, 0.25 in towns); terraced (by style); detached. Each city has one power-and-utilities block: an outer block, preferring water and industry. The block holding the market square is a civic square.

**Reason:** the proposal's blocks, parcels and districts, with the frontage rule enforced by construction.

### 264. Buildings, landmarks, candidate targets and pads

**Date:** 2026-11-20
**Decision:**

- **Buildings** (`buildings.ts`). One per parcel, turned to the frontage and inset by the district's front and side setbacks, shrunk in 15% steps until all four corners lie inside the parcel. Perimeter blocks sit at the front; houses are 8–14 m long; sheds and warehouses are 7–14 m tall. Floors are 3 m each, with one extra floor in the center. Roofs follow the style (flat in the Mediterranean, Arid and half the Eastern bloc perimeters), and roof rise is span × pitch / 2. Extras: chimneys, dormers (Western perimeters), balconies (Mediterranean and Eastern), water tanks on flat roofs, courtyards (Arid houses). Microdistricts hold rows of five- and nine-story slabs, 55–90 m long, set in parkland 48 m apart. No building stands over water or on slopes above 45%.
- **Landmarks** (`landmarks.ts`), named in the settlement's flavor:
  - a cathedral (cities) or church (towns and villages; a hall in Arid towns) and a town hall on the parcels nearest the square, replacing their buildings;
  - a monument (cities) or market (Mediterranean and Arid towns) on the square;
  - a TV tower on a city's high ground (Western and Eastern bloc), or a water tower on a town's (and in some Eastern bloc villages);
  - a stadium in a city's largest civic block;
  - smokestacks on half the industrial blocks;
  - the power station's hall, two cooling towers and a 110 m stack;
  - cranes at ports.
- **Candidate targets.** Rail yard, power station, factories (the largest building of up to six industrial blocks in a city, two in a town), a depot (an industrial block within 300 m of an arterial), port and bridges. Each has a position, footprint and name. Airfields are not the generator's to export: airbases are placed after casting.
- **Pads.** Structures over 1,500 m² whose corners span more than 3 m of ground get a pad record (the mean corner height, 6 m margin). They are **not** applied as terrain edits yet. `terrainEditsFor` feeds the sim worker's height service as well as the renderer (rule 13), and that is the main line's lane; an edit seen by one but not the other would split the one height function. Until the edits are wired in, large buildings stand on plinths like the rest.

**Reason:** the proposal's buildings and landmarks, with structure checked by construction. Pads are deferred rather than applied on one side only, because rule 13 forbids that.

### 265. Villages and farmsteads

**Date:** 2026-11-20
**Decision:**

- **Villages** (`village.ts`). The main street is the arterial passing within 300 m of the center, or else a lane through it along the contour. Clustered styles get a green with a ring lane: 70% of Mediterranean and Arid villages, 35% of Western and Eastern bloc, 10% of Nordic. One to three side lanes branch off. Plots are strips along every street's frontage, both sides, at the style's width × depth (Western 22 × 45 m, Eastern 26 × 50, Mediterranean 14 × 26, Nordic 32 × 50, Arid 16 × 22). A plot is kept where it stays off water, off every street and off other plots. Each plot holds a house at the front and, on half the plots (a fifth in Mediterranean and Arid villages), a barn behind it. A church stands by the green or the main street.
- **Farmsteads.** Three to seven round a town and two to five round a village, at 1.25–2.25 built-up radii. Each sits at a field corner of the terrain's field Voronoi cells (decision 162): a point on a field boundary with a third field within 30 m, searched within 120 m, turned to the boundary. Two to five buildings stand round a yard: a farmhouse, a barn opposite and sheds at the sides.

**Reason:** the proposal's smallest tiers, built along roads and field boundaries rather than scattered (constraint 2).

### 266. Plans in a worker; the urban ground from per-chunk feature fields

**Date:** 2026-11-20
**Decision:**

- **Worker.** `workers/city.worker.ts` gets the global grid's heights and lake depths once per world and builds plans from inputs that the main thread prepares (`settlementInput` without its ground). It returns them packed into transferable typed arrays (`worldgen/settlements/pack.ts`; parcels stay in the worker). One plan is in flight at a time, nearest settlement first. Where there are no Web Workers (Node previews), `CityCore` runs in process within the frame budget. Meshes are built on the main thread within `buildBudgetMs` (6 ms), because they need the terrain's tile data for plinths: a deviation from Part A, which builds meshes in a worker.
- **Feature fields.** For the chunks (1 km squares of the plan's frame) within 4.5 km of the camera, the worker rasterizes 128² texels (7.8 m). Each u32 texel holds the signed distance to the nearest street's edge (in quarter meters), the block's ground class, the street's class and the district. This is Proposal 0005's per-chunk feature distance field, built for towns, where segment lists would loop over thousands of streets per fragment.
- **Shader.** `CityGround` (`render/sim/city/cityGround.ts`) packs a record → plan slot table, per-slot chunk tables and 128 field slots into **one** u32 storage buffer. The terrain's fragment stage was at WebGPU's default limit of 8 storage buffers, so decision 259's pattern vec4s also move into the outlines buffer. `LightShading.urbanGround` reads the nearest town's plan slot. Within a chunk with a field it draws streets with crisp edges (distance read bilinearly), sidewalks, paths and stairs, and the block's ground (courtyards, gardens alternating lawn and yard by 22 m, parks, squares, parking, concrete, gravel, ballast, sports grounds, cemeteries). Off the blocks and away from the streets, and outside the plan's chunks, it hands the cover back to the natural ground; in a chunk whose field is not built yet it draws neutral built ground, never the interim grid. Unplanned towns keep decision 259's grid.

**Reason:** a plan takes up to 9 s for the largest city and cannot run on the main thread. A town's streets must match its buildings, and a texture lookup per fragment costs far less than a loop over a city's segments.

### 267. City meshes by detail level

**Date:** 2026-11-20
**Decision:** `CityLayer` (`render/sim/city/cityLayer.ts`) draws planned settlements and turns off the town scatter (`StructureLayer.towns`). Airbase and industry sites keep it.

- **Levels** per chunk, by distance from the eye to the chunk minus 0.7 km:
  - a **kit** within 0.6 km: boxes plus chimneys, water tanks and church towers;
  - **boxes** within 2 km: walls and a gable, hip, shed or flat roof, 14–16 triangles, roofs over 0.6 m eaves;
  - **prisms** within 12 km: one extruded block at its mean height times twice its built share, the polygon simplified to 8 m, its base and top following the ground at each corner (a flat top over a sloping block read as a table), merged into one mesh per settlement with its towers and stacks;
  - nothing beyond.

  Part A's ranges were 1 km, 5 km and 15 km. With boxes to 5 km, the largest city put over 1 M triangles in view, against its budget of 0.3 M.
- **Plinths.** Every building's walls start at the highest drawn ground under it (the level-10 surface the structure layer uses) and a plinth band reaches down to the lowest point, plus 1.5, 4 or 12 m by level, because coarser terrain meshes lie lower.
- **One material.** Positions are relative to the chunk's origin, with the ground height in its own attribute, exaggerated as the terrain is. Faces are flat and lit by `shadeDiffuse` with aerial perspective. Window bands come from wall coordinates (3 m floors, 3.2 m bays) within 1.4 km. At night about a third of the panes light up, by hash and scaled by the settlement's lighting level (`setLighting`: 1 lit, 0.4 dimmed, 0 blacked out), with a mean glow beyond window range. Streetlights stand every 40 m along arterial, major and minor streets of the near chunks, as one instanced mesh per settlement.
- **No ink outlines** on city meshes (decision 107 makes them optional): at a draw per chunk they would double the draw calls.
- `tools/render.preview.ts` waits for the city layer, prints its plans, chunks, triangles and draws, and takes `CITIES=0` for the old scatter. It also gains the report's views (`hilltown`, `westcity`, `eastcity`, `village`, `industry`).

**Reason:** the hard budgets of Part A: a draw call per chunk and per settlement keeps a city under 40, and the detail ranges keep triangles in budget.

### 268. Plumes, colliders and the game layer's data

**Date:** 2026-11-20
**Decision:**

- **Plumes** (Phase 7). Each smokestack and cooling tower carries ten soft camera-facing puffs that cycle in age over 40 s. They rise 60 m (steam 90 m), drift 40 s downwind with the ground wind the scene samples (a 2 m/s breeze when calm) and grow fourfold, so a plume shows the wind. Smoke is gray, steam white, and fire smoke from damaged landmarks and targets dark. One instanced mesh per settlement.
- **Colliders** (`worldgen/settlements/colliders.ts`). One oriented box per building, with wall and roof tops above the ground under it. A spatial index answers a segment test (slab test in the box's frame) for line of sight and the height of a flat roof for landings. The caller passes the drawn ground. Nothing reads them yet; R3's line of sight and ground combat are the main line's.
- **Exports** (`worldgen/settlements/exports.ts`). Per settlement: its districts (blocks and area), landmarks and candidate targets as kinds, names, directions and footprints. These are plain types; the generator imports nothing of the planner.

**Reason:** Part A's plumes, colliders and data for a game layer, kept on the world's side of the line.

### 269. Damage states

**Date:** 2026-11-20
**Decision:** `CityLayer.setDamage(settlement, building, state)` sets intact, damaged or rubble.

- **Damaged** buildings are blackened (walls ×0.35, roofs ×0.25), lose 15% of their height and 70% of their roof.
- **Rubble** is a low mound, at most 2.5 m high, in dusty brown.
- States are a byte per building per plan.
- A chunk records each building's triangle range. A new state rewrites that range in place and fills what is left with degenerate triangles, uploading only the changed range, which takes about 0.07 ms in `tests/cityRender.test.ts`. A state that needs more triangles than the range (back to intact from rubble) rebuilds the chunk (about 6 ms for 400 buildings).
- Damaged landmarks, and buildings within 60 m of a candidate target, add fire smoke plumes.

**Reason:** Part A's damage, at full scope. The in-place patch beats its "rebuild the affected block" and its 2 ms budget without a mesh per block.

### 270. The map's city extents from blocks, tinted by district

**Date:** 2026-11-20
**Decision:**

- The map's urban texture becomes RG8: coverage, and the share of industry, rail yards, ports and utilities. The relief shader tints the urban fill toward `#A8A49C` by up to 70% of that share.
- `UrbanTexture.applyPlan` clears a city's graph polygon and rasterizes its plan's blocks instead, scaled as the map scales towns (×1.6). Blocks cover about two thirds of a texel between streets, so their coverage is taken ×1.5.
- In the app, `CityLayer.prefetch` plans every city of 200,000 people or more in the background when the worker is idle, and `onPlan` hands each plan to the map; the texture uploads at most every 3 s.
- **Not done:** major streets and landmark glyphs in the Region band. At the zoom floor (about 100 km) major streets 240 m apart are 2–3 px apart and would read as noise, and landmark glyphs need the label engine's placement. TODO.

**Reason:** Part A's strategic view: extents from block outlines and district tints, within the map's own rules (no individual buildings; decision 105's larger-than-life towns).

### 271. The chase camera's acceleration lag in game time; the analytic pose's speed eased from leg to leg

*Numbered after the cities work of Proposal 0009 (decisions 259–270, on `feature/urban-ground` and `feature/cities`, not yet on `main` when this was written), so the two merge without renumbering.*

**Date:** 2026-11-20
**Decision:** The owner saw a followed aircraft slide backward for a moment just after a racetrack turn, at 16×. The routes' poses never move against the nose (every slot of a CAP flight stepped in 16× frames from climb-out to landing: the slowest is 64 m/s forward, at the landing), so the motion was the camera's. The chase camera lengthens and shortens its distance with the target's forward acceleration (`stretchPerAccel`, 0.25 m per m/s² for fast jets), and it took that acceleration per real second. Under time acceleration a speed change per real second is the rate times harsher: a wingman outside a turn flies faster than the lead (decision 255) and eases back over the 20 s of the turn's end, which at 16× read as hard braking, so the camera closed in on it by 1.6 m (more at a mile abeam, decision 258) and the aircraft seemed to come back toward the eye. The analytic route's speed also stepped from leg to leg (orbit to egress, cruise to climb), which jolted the camera at any rate.

- **The camera** (`ChaseCamera.timeRate`, game seconds per real second, set each frame by the follow from the displayed time; 1 in Free Flight) measures acceleration in game time and smooths it in real time. The same game-time history at 1× and 16× now gives the same distance to within 0.3 m (before: 1.6 m apart).
- **The analytic pose's speed** is the mean over the heading's ±10 s window, from the same samples, so it eases from leg to leg: at most 5 m/s² on a CAP route whose legs step by tens of m/s. Position stays the route's, so a flight still passes its waypoints exactly; the HUD's airspeed and the AI's reference velocity ease the same way.

**How it was checked.** `tests/follow.test.ts` (the camera at 1× and 16×), `tests/analyticPose.test.ts` (the speed has no steps), the unit suite.

**Reason:** the owner's look at following a CAP at 16×.

### 272. Follow at full fidelity: a followed F-21 flight promoted inside its window, its lead on the drawn route

**Date:** 2026-11-20
**Decision:** R2.5's follow on `PromotedFlight` (decision 256), on the main thread (`src/follow/fullFidelity.ts`, wired in `follow.ts`).

- **When.** A followed flight is promoted when its type has fixed-wing flight data (`flightSpecOfType`: the F-21 alone today, the Vo-31 and Vo-35 in R2.7), it is inside its jump-in window (climb-out to approach), every aircraft is in the air and the clock runs at the flight cap (`FLOWN_MAX_RATE`, 8×) or slower. Faster, `PromotedFlight` cannot keep up (40 steps a frame) and the follow stays analytic. It is demoted at the approach, when the clock goes faster, and when its own clock falls more than 5 s behind game time (a seek or a stalled tab), after which it is promoted again from the route. The drawn aircraft then ease from where they flew onto their analytic poses over a 1.5 s time constant, so a demotion does not jump the camera by the AI's few hundred meters.
- **The lead's reference** (`drawnReference` in `followFlight.ts`) is its route as the view draws it: on the sited field near its base (decision 253) and lifted to the drawn altitude's target over the drawn ground (decision 255), not the eased lift, so the AI climbs over a ridge at its tracker's own rate. The mission is looked up live, so a new route (an abort's, the worker's rebuilt route after a handback) becomes the reference when it arrives (`routeKey`; `PromotedFlight.setLead` keeps the pilots). Aircraft the campaign loses in aggregate leave the promoted flight from the highest slots, as decision 250's losses do.
- **The ground** is Free Flight's: `flownGround` in `freeflight/ground.ts` builds the sited runways and the `AirfieldGround` (drawn surface, the height service before tiles load, the airfields' pads, landform props as obstacles) for both modes from the same terrain.
- **Drawing.** The aircraft are drawn from their airframes: position at the CG (`AircraftView.setCg`, the spec's CG at full fidelity and none for analytic poses), the control laws' elevator, aileron and rudder, gear, speedbrake and afterburner; a crashed aircraft is hidden. The HUD frame is `buildHudFrame` of the followed airframe (mode FOLLOW · AI), the displays' snapshot is built from it as Free Flight's is, with the flight model's fuel capacity. Every other flight in the bubble is drawn by `CampaignTraffic` as before.
- **Spectating at full fidelity is presentation.** The worker carries on the flight on its analytic route, which the AI tracks within a few hundred meters (decision 256); only a take-over holds the mission (decision 257).
- **Mouse aim** moved out of Free Flight into `ui/flight/mouseAim.ts` (`aimDirection`, `flyMouseAim`), so a campaign aircraft taken over flies with the same law. Free Flight's behavior is unchanged.

The promoted flight flies in still air: Free Flight's wind from the weather is not yet applied to it (TODO).

**How it was checked.** `tests/fullFidelity.test.ts`: only the F-21 has fixed-wing flight data; promotion is wanted from the climb-out, at 8× but not 16×, and not at the approach; the reference is the route over low ground and the ground plus the clearance over a ridge; a CAP flight at full fidelity loses its highest slot when the campaign does, follows a new route within 400 m, and asks for a new promotion when its clock is a minute behind. The unit suite, the type check and lint pass. Lavapipe cannot run the app in Chromium here (decision 252), so the look is for the owner's GPU.

**Reason:** R2.5: the player takes over a flight that already flies at full fidelity, so the take-over changes only where the inputs come from (design, *Mission Search and Jump-In*).

### 273. Take over and hand back in the view: T, Free Flight's bindings, the worker's inputs

**Date:** 2026-11-20
**Decision:** R2.5's take-over in the follow view (`follow.ts`), on a flight at full fidelity (decision 272).

- **Taking over.** T or the bar's button, while the followed flight is promoted, inside its jump-in window and not held. The followed aircraft's AI pilot leaves (`PromotedFlight.takeOver`) and its input source becomes a `FlightInput` with Free Flight's bindings: mouse aim by default (`ui/flight/mouseAim.ts`, the same law, decision 272), N for direct, G gear, B speedbrake, Shift and Ctrl the throttle, C or a right drag to look. The input starts from the controls the AI left (throttle, gear), so nothing jumps; mouse aim takes the stick once the mouse is captured, as in Free Flight (decision 206). The one `MouseCapture` (Tab, or a click on the view) owns the pointer lock (rule 14). The displays attach to the flown aircraft's avionics state and their bindings come on; the view steps from the HUD alone to the HUD with the displays. While the player flies, the follow's own keys (N, V, C, M, Escape) and its drag and wheel give way to the jet's, and the time controls' Space and digit keys are off (they are the wheel brakes and the display slots). Escape only frees the mouse: the pause menu is Free Flight's, and the war does not stop.
- **The worker.** The take-over posts `take-over` (decision 257). The worker's hold shows in the next mission list (`flown`); if it has not within 3 s (a refusal at the window's edge), the follow hands back at once and says so.
- **Handing back.** T again, the bar's Map button (leaving the view leaves the aircraft), or 3 s after the flown aircraft crashes. `PromotedFlight.handback()` gives the fix in the route's terms and the aircraft full fidelity lost; with none left the fix is where the last fell, with no aircraft. The `hand-back` input is posted after the take-over in every case, since the worker applies them in order. The AI takes the aircraft again; until the worker's rebuilt route arrives (the mission no longer `flown`), the lead flies on along its velocity, then the rebuilt route is its reference.
- **A held flight is not ended at its old route's end**, nor demoted at its old approach: while the player flies or the worker holds it, the follow keeps it at full fidelity whatever the old timeline says.

**How it was checked.** `tests/fullFidelity.test.ts`: a handback carries the fix with three aircraft and the crashed #4 lost; the lead's reference is its own track while the mission is still held and the rebuilt route once the hold is gone; a flight with every aircraft crashed hands back with all four lost. The unit suite, the type check and lint pass. The flying itself is for the owner's GPU.

**Reason:** R2.5: take over inside the jump-in window and hand back with the AI's orders; the player's input only replaces where the controls come from (rule 12).

### 274. The flight cap: 8× in cruise while the player flies, 1× on any threat

**Date:** 2026-11-20
**Decision:** `flightRateCap` (`sim/clock.ts`) gives the fastest rate while the player flies a jet: `FLOWN_MAX_RATE` (8×) in cruise, else 1× with the reason. Cruise is in the air, gear up, at least 300 m (about 1,000 ft) above the ground and more than 40 km from the mission's target or station. A threat is any enemy flight in the air within 120 km (about 65 nm, a fighter radar's reach with some margin), from the missions' analytic positions, until R2.6 gives the sensors campaign contacts and the threat warning can say it. The follow reads it each frame from the flown airframe (`Follow.rateCap`) and the app drops the rate to the cap when it is higher, with a notice of why. The rates on offer stay `TIME_RATES`: 16× or more while flying comes down to 8×, and 4× runs as chosen; a threat drops the clock to 1×, and the player chooses again once clear. `PromotedFlight` takes at most 40 steps a frame, enough for 8× at 30 frames a second.

**How it was checked.** `tests/flightCap.test.ts`: 8× in cruise, 1× with an enemy flight at 100 km, 30 km from the target, at 150 m, with the gear down and on the ground. The unit suite, the type check and lint pass.

**Reason:** design, *Time*: the flight cap; roadmap R2.5.

### 275. A session's consequences at the handback: a logged session record, expended stores kept

**Date:** 2026-11-20
**Decision:** The hand-back input (decision 257) carries what each surviving aircraft has expended (`stores`: slot and store counts, from `PromotedFlight.handback()`; optional, so logs from before replay unchanged). In `AirOps.release`, before the losses and the rebuilt route:

- the survivors' expended stores go on the mission by their slots after the losses (`Mission.expended`, only when anything was expended), and promotion starts each aircraft from them, so a store fired at full fidelity stays fired through any number of sessions; the hash includes them;
- a `flight-session` decision is logged: the slot the player flew and since when, the aircraft lost, the aircraft and fuel per aircraft left, and the stores expended in all.

With the losses (`aircraft-lost`, crash) and the rebuilt route (`mission-rejoined`) these are every consequence a session has until R2.6's weapons and damage: hits on other flights and on targets join the hand-back then. Nothing outside the log changes campaign state (rule 19): the record is in the input, and replay from a checkpoint applies it again.

**How it was checked.** `tests/handover.test.ts`: a CAP handed back with its lead crashed and #1 and #2 having fired one and two stores keeps two for the new lead, one record per survivor, and logs a session with one loss and three stores; a promotion after it starts the new lead with them. The other handover tests (hold, rebuild, replay hash, refusals) pass unchanged; a campaign without a take-over has no `expended`, so `tools/war.preview.ts`'s hashes do not move.

**Reason:** roadmap R2.5: a session's consequences return to the worker as logged campaign events (owner decision 1); the exit asks that stores survive both directions.

### 276. R2.5's exit test: take over and hand back at every phase of a CAP

**Date:** 2026-11-20
**Decision:** `tests/handoverExit.test.ts` runs the roadmap's exit criterion headless on seed 7's campaign world: the first CAP of three or more aircraft after two hours is taken over 20 s into each phase of its jump-in window in turn, on the route as it stands after the previous handback (climb-out, ingress, fence-in, on station, egress), flown at full fidelity for a minute and handed back. Each session promotes the flight from its analytic state as the follow does, the player's aircraft flown by a route tracker through its own input source (as mouse aim would be); each session the lead fires one store, and in the second the last wingman crashes. At every promotion the flight has the campaign's aircraft and the lead the stores fired before; at every handback the mission is released, one aircraft short after the crash, the survivors' stores kept, and its phase never runs backward. The log has one `flight-session` per phase and the crash as a loss, and the mission resolves and completes on its last rebuilt route. The flight flies over sea level: routes stand on the coarse ground's floor (decision 240), and the drawn ground is the renderer's.

**How it was checked.** The test passes in 12 s; the unit suite, the type check and lint pass.

**Reason:** roadmap R2.5's exit (take over and hand back at every phase of a CAP mission, with the mission completing; losses and stores survive both directions). The owner's flight on the GPU remains for the milestone's checkpoint.

### 277. Promoted aircraft with the gear handle up; the AI pilot's speedbrake

**Date:** 2026-11-20
**Decision:** The owner's first take-over found the gear coming down and staying down. Promotion (decision 256) gave each aircraft `neutralControls()`, which stand on a runway with the gear handle down, so every promoted aircraft lowered its gear at once; at cruise speed that is a gear overspeed, which fails the doors and holds the gear down (decision 207). A take-over then copied the AI's controls, gear down included, to the player. Promotion now sets the controls from the pose: gear handle and parking brake down only on the ground, the throttle at the promoted power.

Decision 256's AI checks had run gear down, and the gear's drag had been slowing the wingman after each racetrack turn. With the gear up, a wingman leaving the outside of a turn about 35 kt faster than the lead came out up to 800 m ahead of its slot at idle. The route tracker (`PoseTracker`) now puts the speedbrake out when the airspeed is more than 12 m/s over its command and in again under 4 m/s; the wingman's worst error on station is again within decision 256's 600 m (about 300 m after a turn).

**How it was checked.** `tests/promotion.test.ts`: promoted aircraft have the gear handle up, and a CAP pair flown from the climb-out to the approach keeps its gear up with its doors whole, the lead and the wingman within their bounds. The flight lockstep test passes unchanged (the flight model is untouched); the unit suite, the type check and lint pass.

**Reason:** the owner's report after the first take-over.

### 278. Woods and parks inside planned towns keep their trees and canopy

**Date:** 2026-11-20
**Decision:** Each plan carries a **built mask**: one bit per 40 m cell over its bounds, set on blocks (except parks and cemeteries), on streets with their sidewalks, and on every building's footprint. It is computed in the worker and packed with the plan (`pack.ts`, `builtMask`), and copied into the city ground's buffer with each plan slot (up to 512 Ki cells per plan).

- **Canopy shell.** Over a planned town the shell is cut only where the mask is set. An unplanned town still cuts it over its whole built-up patch (decision 166). The shell's mesh is lowered the same way (`canopyClear`).
- **Trees.** Within a planned town they are cleared where the mask is set and along its roads, not over the town's core as before.
- **Far urban ground.** Where no feature field is loaded yet (beyond 4.5 km), the mask tells built ground (neutral) from natural ground, which shows the terrain's own surface. Before this, the whole chunk drew as neutral built ground.

**Reason:** the owner saw woods inside a town with trees near the camera but no canopy from a distance. Trees were cleared only over a town's core, the shell over its whole patch, so the two disagreed. The plan knows where it builds, so near and far now follow the same mask, and a city keeps its parks and woods at every distance.

### 279. The war's town targets as complexes in their plans; damage by site; a zoom for sensors

**Date:** 2026-11-20
**Decision:**

- **Sites.** A settlement input may carry *sites* (`SiteAnchor`: id, kind, name), plain data a caller passes: works, power station, refinery, rail yard, depot, fuel depot. The generator still imports nothing of the game (rule 20). `anchorsFromTargets` in `render/sim/city/cityLayer.ts` is the adapter: the infrastructure's targets at a settlement (factory, power plant, refinery, rail yard, supply depot, fuel depot) become its sites, under their own ids and names.
- **Placement.** Each site takes an unused block of its preferred district: rail yards nearest a railway, depots nearest an arterial, the largest block for the rest. Failing that, it gets a compound of its own just outside the extent, along a road, off water and steep ground. Refineries and fuel depots refill their block with tanks (a new landmark kind) and flare stacks; power stations gain cooling towers where they lack them. The site becomes the plan's candidate target for that block, carrying the site's id and its buildings, and replaces any target the plan had made of that block.
- **No duplicates.** `InfraScene` no longer draws industrial sites for targets at settlements when plans draw them (`plannedTargets`); targets away from settlements keep their sites.
- **Damage.** `CityLayer.setSiteDamage(id, damage)` breaks that share of the site's buildings, about half of them into rubble, chosen by a fixed hash so that more damage only adds to what is broken. Damage set before the plan arrives is kept and applied when it does. The sim's `DamageState` holds target damage in the worker. Sending damaged targets to the main thread, so the renderer can call this, is a small change to the sim's snapshot and belongs to the main line (TODO).
- **Compaction.** Buildings that give way to landmarks or sites are marked and dropped at the end of the plan, with landmarks and targets renumbered. The old in-place splice could leave a landmark pointing at the wrong building.
- **Zoom.** `CityLayer.zoom` divides the distances that pick a chunk's detail and multiplies the reach for plans. A targeting pod at 8× sees a city 30 km away as boxes, as from about 4 km. Its narrow field keeps the triangle count in the same range.

**Reason:** the owner asked for specific buildings in cities to be strike targets. Campaign logic already plans strikes on the infrastructure's targets (rule 9); this makes each one a particular complex in its town that a pilot can find and see broken. The generator stays the world's: it realizes sites it is given and knows nothing of who asked.

### 280. Wind at full fidelity

**Date:** 2026-11-20
**Decision:** A promoted flight's aircraft fly in the campaign's air: before each step `airVelocity` (Free Flight's, decision 143) sets the wind and gusts at the aircraft from the worker's weather frames on the main thread (`SimClient.weather`), at the flight's own game time and its height above the drawn ground. The route tracker already flies ground speed and track and turns them into airspeed with the wind it feels (decision 256), so the flight keeps its route in wind; the player feels the same air after a take-over. The worker's rebuilt routes still leave winds aloft out (decision 257; TODO).

**How it was checked.** `tests/fullFidelity.test.ts`: a CAP flight on station in a steady 25 m/s west wind has the wind at its aircraft and its lead within 600 m of the route over four minutes. The unit suite, the type check and lint pass.

**Reason:** R2.5 (TODO): the promoted flight flew in still air.

### 281. An abort turns home through a real radius; every route turn aims again after each step

**Date:** 2026-11-20
**Decision:** `returnRoute` (decision 250's abort) takes an optional turn, and AirOps gives it `turnToward` at the rejoin's 45° bank (decision 256): an aborted flight turns from its heading toward home through a real radius instead of reversing at a corner. `turnToward` now aims again after each 15° step and takes the rest in the last, smaller step. Before, it aimed once from where the turn began, and near the point turned to, the turn's own radius moved the flight enough to leave a corner at its end: an abort 45 km from home on the small test planet ended its turn 26° off the way home. The egress turns (decision 255) and the rejoin's (decision 256) turn the same way, so every world's routes change a little after a pass or a station, and the campaign's state with them. *Numbered 280 and 281 (wind) after the cities work's 278 and 279, which reached `main` at the same time.*

**How it was checked.** `tests/rejoin.test.ts`: a CAP aborted on a racetrack leg heading away from home turns at its first leg by under 25° and has no corner over 25° to the approach (the corner route's first leg reverses by more than 150°), and its route completes; the rejoin tests pass unchanged. The unit suite, the type check and lint pass. `tools/war.preview.ts`: the same state stepped and in one jump on the demo seeds (`259dee174838e519`, `0bb125cf3ad63693`, `9fdde4dedb89aa66`), aircraft lost (A/P) 18/12, 13/12, 3/4 as in decision 256.

**Reason:** R2.5 (TODO): an abort still turned home at a corner, which the follow draws and full fidelity cannot fly.

### 282. The mission plug-ins' full-fidelity behavior: the route tracker per phase, weapons states for R2.6

**Date:** 2026-11-20
**Decision:** The `behavior` part of a mission plug-in (rule 16) is a record per phase: how the lead flies (`route`: station keeping on its analytic route, which flies every leg, climb, racetrack, pass and turn home; decision 256), how the wingmen fly (`slots`: the formation's slots beside the flown lead) and which weapons the AI may use (`hold`, `air-to-air`, `air-to-ground`), which R2.6's weapons read. `routeBehavior` fills the airborne phases from the climb-out to the egress. The four demo types have theirs: CAP air-to-air from the fence-in through the egress, interdiction and CAS air-to-ground on target, airlift none. A phase a plug-in leaves out, or a plug-in whose part is still pending (the provisional types, R4.2), is not flown at full fidelity: the follow keeps it on its route (`phaseBehavior`, read by `fullFidelityWanted`). The demo types are now complete in the registry; the pinned list of pending parts holds only the provisional types'.

**How it was checked.** `tests/missions.test.ts`: the registry has no pending part for the demo types. `tests/fullFidelity.test.ts`: a CAP on station has the route law, slots and air-to-air, at the climb-out its weapons are held, and an escort (provisional) is not promoted. The unit suite, the type check and lint pass.

**Reason:** rule 16: a mission type is complete only with all eight parts; R2.5 made the full-fidelity behavior possible.

### 283. The F-21's route climb at 50 m/s, what its flight model sustains

**Date:** 2026-11-20
**Decision:** The F-21's air-war climb rate (`airWar.climbRate` in its bundle) is 50 m/s, down from 110. Its routes climb at 70% of the cruise speed (about 173 m/s), and at that speed the flight model's specific excess power at military power is about 77 m/s at 1 km, 61 at 3 km, 49 at 5 km, 36 at 7 km and 24 at 9 km (in afterburner 160, 130, 106, 83 and 63 m/s): 110 m/s all the way to 9 km was beyond the Kestrel even in afterburner, so the AI followed its climb up to 3 km behind. At 50 m/s, the mean at military power, the lead stays within 1.3 km in the climb (afterburner a quarter of the time near the top). The aggregate route should not ask for more than full fidelity can fly (rule 18); the other types keep their priors until they have flight models (R2.7). The descent from cruise, at the same rate, is longer too. Every world's F-21 routes change, so the campaign's state.

**How it was checked.** `tests/promotion.test.ts`: the AI lead of a CAP pair stays within 2 km of its route from the climb-out (5 km before). `tests/ato.test.ts`'s wind test moves its target 220 km farther out, since the slower climb now reaches the old one's fence-in point before any ingress. The unit suite, the type check and lint pass. `tools/war.preview.ts` (`3c5623019d8c0959`, `5dceaff2ae334be7`, `7dde4a86cbf5f482`; stepped and in one jump the same): aircraft lost (A/P) 18/12, 11/15, 3/4, against 18/12, 13/12, 3/4.

**Reason:** R2.5 (TODO): the route's climb was steeper than the aircraft can fly.

### 284. The flight the player flies is drawn where it is on the map and the moving map

**Date:** 2026-11-20
**Decision:** While the player flies a flight, or the worker still holds it, the strategic scene draws its badge at the flown lead's position and track (`Follow.heldFlight`, set on the scene every frame; `AirViewOptions.held`), and leaves out its old route and its trail, which the route no longer describes. The moving map in the displays draws from the same scene, so the player sees their own flight there. The worker still knows only the old route: other flights' resolution leaves a held flight out (decision 257), and full-fidelity combat around the player is R2.6–R3's; posting fixes to the worker as logged inputs waits until the aggregate needs them.

**How it was checked.** `tests/air.test.ts`: a held flight's badge stands at the given point, and its route and trail are the ones left out. The unit suite, the type check and lint pass.

**Reason:** R2.5 (TODO): the map drew the held flight on its old route.

### 285. Stores and pylons: a stores catalog, pylons in the bundles, loadouts by station

**Date:** 2026-11-20
**Decision:** R2.6 begins with the data its weapons hang from.

- **The stores catalog** (`src/data/stores.json`, read by `sim/air/stores.ts`): each store's name in the setting, the real store its numbers come from, its kind (IR missile, radar missile, bomb, rockets, tank), mass, length, diameter and drag area. Six to start: a short-range and a medium-range missile (AIM-9M and AIM-7M figures), 230 and 900 kg bombs (Mk 82, Mk 84), a 19-rocket pod (LAU-61) and a 1,400 l tank. It lives outside `src/data/models/`, whose every JSON file the model library reads as a spec.
- **Pylons** are a bundle's `pylons` (rule 17): an id, where the store hangs in the model's frame, whether it is mirrored, and which stores it can carry. A mirrored pylon is two stations, `<id>.right` and `<id>.left`.
- **A loadout's `stations`** map pylon ids to store ids; the loader refuses a station on a missing pylon or a store the pylon cannot carry. The air war keeps a loadout's id, text and radius factor as before, so nothing in any world's campaign changes.
- **The F-21** has five pylons (wingtips, outer, middle, inner and centerline) and its two loadouts by station, as their texts say: air-to-air, 4 short-range and 2 medium-range missiles and 2 tanks; strike, 2 900 kg bombs, 2 short-range missiles and 2 tanks. The bundle test's gaps for it are now calibration alone.
- `stationLoads`, `storeCounts`, `remainingStores` and `storesLoad` turn a loadout and what was expended (promotion's `StoresState`, decision 275) into the stores left, their mass and their drag area, for the flight model, the stores format and the drawn stores next.

**How it was checked.** `tests/stores.test.ts`: the catalog; the F-21's loadouts count as their texts; mirrored stations; the strike load's mass; stores left after some are expended; a station on a pylon that cannot carry its store refused. `tests/bundles.test.ts` with the F-21's gaps. The unit suite, the type check and lint pass.

**Reason:** roadmap R2.6, *Pylons and loadouts in the bundles*.

### 286. The owner's direction after R2.5: steerpoint routes, two set pieces, road bases, air refueling, drop tanks

**Date:** 2026-11-21
**Decision:** The owner's feedback after flying a take-over (owner, 2026-11-21), now in the roadmap:

- **Routes with steerpoints** (new R3.7). Missions fly great-circle legs today; the final game plans routes as steerpoints against the threat: low-level legs along valleys and canyons under the radar horizon, ingress through holes in the air defense network, pop-up and initial points. Rule 9 holds: the planner reads the strategic graph and the air defense picture, and fitting a route to the terrain is the execution layer's, as aligning roads is. The steerpoints are what the moving map, the HUD's steering (R2.6) and the AI pilot follow.
- **Two set pieces** (R4.2): the AWACS ambush (a low canyon run under the enemy's radar, a hard climb and an attack on an AEW orbit, after the F-15 campaign mission in DCS) and the deep strike from a road (a light attack aircraft dispersed to a road base, fast and very low deep into enemy territory, after the AJ-37 Viggen's doctrine).
- **Road bases** (new R4.8): highway strips on straight aligned roads near the airbases, dispersal when a base is attacked (decision 254) or by doctrine, takeoff and landing on a road.
- **Air refueling** (new R4.9): the Alliance plans tanker tracks into its packages, extending radius and station time in the aggregate; the Pact's few tankers serve its bombers; at full fidelity the player joins the boom or drogue.
- **Drop tanks carry fuel** (R2.6, decision 285's question): tanks hold fuel the engine burns first and can be jettisoned, so the flight model's fuel matches the air war's load (the F-21's 5,800 kg) instead of mapping it by share (decision 256).

**Reason:** the owner's review of R2.5.

### 287. Stores' mass and drag in the flight model; drop tanks with fuel, jettisoned by key and by the AI before a fight

**Date:** 2026-11-21
**Decision:** The stores a promoted aircraft carries act on its flight model, and its drop tanks hold fuel (owner, decision 286).

- **Beyond the standard load.** A type's flight data names the stores its mass and CD0 table already hold (`standardStores`; the F-21's four short-range missiles). The stores rack (`sim/flight/storesRack.ts`) gives the flight model the difference store by store: mass without the tanks' fuel (`storesMass`) and drag area (`storesDragArea`, added to `cdStores` over the wing area in `drag.ts`). More stores add, fewer than the standard load take away (the strike load hangs two short-range missiles fewer). The center of gravity and the moments of inertia stay the spec's; the control laws hide the difference, and R2.10's calibration may revisit it. The approach energy cue (`energy.ts`) still predicts without stores.
- **Drop tanks.** A tank's catalog entry gives the fuel a full tank holds (`fuel`: 1,120 kg, 1,400 l at 0.8 kg/l, of its 1,260 kg). The flight model's `fuel` is internal plus tanks, and `tankFuel` the part in the tanks, which the engine burns first. A loadout's capacity is internal plus every tank it hangs (`StoresRack.capacity`: the F-21's 3,200 + 2 × 1,120 = 5,440 kg), and promotion and demotion map the route's fuel onto it by share; with a range factor of 1 that is the same number. The internal tanks fill first, so a promoted aircraft's drop tanks hold what is left over.
- **The air war's load.** The F-21's `airWar.fuel` is 5,440 kg (5,800 before), so a full route is full tanks. `tests/storesRack.test.ts` checks that every flown type's air-war fuel equals each loadout's capacity. The routes' cruise flow scales with the fuel, so their times and fuel shares are unchanged; base stocks hold the smaller figure.
- **Release and jettison.** `release` takes the next of a store off (fired, released or dropped) and counts it in the aircraft's expended stores, which the handback already carries (decision 275); which stations an expended count empties is fixed (pylon order, right before left), so a later promotion hangs the same ones. `jettisonTanks` drops every tank with the fuel left in it. The player drops theirs with J (`FLIGHT_BINDINGS.jettison`) or a display button (`ControlsAction` `jettisonTanks`, which the stores format will carry); the follow now passes the strip's control buttons to the jet's actions as Free Flight does. The AI pilots drop theirs when an enemy flight comes within 40 km of the lead (`FIGHT_RANGE`, checked once a game second from the campaign's routes, the flight cap's distance; decision 274), never the player's.
- **The Kestrel** in Free Flight hangs no rack, so its flight is unchanged: `tests/flightLockstep.test.ts` passes without a new fixture.

**How it was checked.** `tests/storesRack.test.ts`: the standard load adds nothing; the air-to-air and strike loads' mass and drag; the drag coefficient's increment; the air-war fuel against every loadout's capacity; the stations an expended count empties; tanks burn first and internal fuel is untouched while they hold any; a jettison takes the tanks' fuel, their dry mass and drag and counts them expended, and a later promotion holds internal fuel at most; the AI keeps its tanks with no enemy near and drops them within 40 km, the player's stay until J. `tests/promotion.test.ts`, retuned because the stores move it: the promoted fuel is a share of 5,440 kg with the tanks holding what exceeds the internal fuel; heavier by about 2.7 t of tanks and fuel at 9 km and 300 kt, a wingman takes 120 s to close within 500 m after the player's turn (90 s before), and the lead stays within 1.2 km of its rebuilt route after the handback (800 m before). `tests/fullFidelity.test.ts` and `tests/handoverExit.test.ts` pass unchanged. The unit suite, the type check and lint pass. `tools/war.preview.ts` (`1777effd4bce9594`, `82614b05ce98377f`, `44c6dc271db1da5d`; stepped and in one jump the same): aircraft lost (A/P) 18/12, 11/15, 3/4, as in decision 283.

**Reason:** roadmap R2.6, *Stores' mass and drag in the flight model* and *Drop tanks with fuel* (owner, decision 286): the flight model's fuel now matches the air war's load instead of mapping a 5,800 kg load onto 3,200 kg of internal fuel.

### 288. Stores drawn on their pylons, gone once released

**Date:** 2026-11-21
**Decision:** The simulation view draws each store an aircraft carries on its station, from its own model spec, and stops drawing it when it is fired, released or jettisoned.

- **Models.** Every store in the catalog has a spec, `src/data/models/stores/store-<id>.json` (a new model class, `store`, 12–120 triangles on top of the aircraft's count; `docs/visual-style.md`, *Polygon Budgets*), centered on the point where it hangs: missiles with cruciform tail fins and a mid-body pair, bombs lofted with four fins, a rocket pod, a drop tank with a pair of tail fins. The F-21's body no longer draws wingtip missiles of its own.
- **Mounts.** `AircraftView` takes the stores that may hang on its stations (`StoreMount`: station, spec, where) and shows them all until `setStores(loaded stations)` says otherwise; they cast the body's shadow, and a hidden store's shadow collapses as a hidden rotor's does (decision 170). `render/sim/aircraft/storeMounts.ts` builds the mounts of a loadout on a bundle's pylons, or of a flight data's standard load (`standardStations`: each store on the first pylons in bundle order that carry it).
- **Who hangs what.** A followed or nearby campaign aircraft hangs its mission's loadout, without what it expended at full fidelity before (`flightStores`, `loadedOf`); a stand-in model hangs nothing, since its pylons belong to another type. At full fidelity the drawn stores are the rack's loaded stations each frame, so a jettison (decision 287) shows at once. The Kestrel in Free Flight and its scripted traffic hang the flight data's standard load: four short-range missiles on the wingtip and outer pylons. The instanced aircraft beyond 1.5 km draw no stores.
- Pylons themselves are not drawn yet, and a released store vanishes rather than falling away (TODO).

**How it was checked.** `tests/aircraftStores.test.ts`: every store has a model; the standard load hangs on the wingtip and outer pylons; the strike loadout's six stores are drawn, a mesh and its ink each, and hiding all but the wingtip missiles leaves two; a stand-in hangs nothing. `tests/models.test.ts` keeps the stores within their budget. `tools/models.preview.ts` renders the six (`tools/out/model-store-*.png`). The unit suite, the type check and lint pass. The owner checks the look on the GPU.

**Reason:** roadmap R2.6, *Stores on pylons that disappear on release; jettison*.

### 289. The stores format, master arm and weapon selection

**Date:** 2026-11-21
**Decision:** The stores format (SMS) is built (rule 14: a pure function from the snapshot to a display model).

- **Snapshot.** `AircraftSnapshot.stores` lists every station of the loadout from the left wing to the right with what it carries and whether it is still loaded, the weapons aboard by store with their counts and master mode, and the tanks with the fuel in them (`storesSnapshot`). The follow fills it from the followed aircraft's rack at full fidelity, else from its loadout less what it expended before, with the tanks' share of the route's fuel; Free Flight from the Kestrel's standard load, on a rack that adds nothing to its flight model (decision 287).
- **Format.** Master arm (SAFE dim, MASTER ARM amber) across the top; the stations evenly along a wing line, labels staggered in two rows (their real spacing crowded them), an empty station a dash, the selected weapon's stations underlined; below, the selected weapon with its mode and count, and the tanks with their fuel in the skin's unit. Buttons: the weapons along the top row, master arm at the top of the right side, JETT at its bottom (the controls' `jettisonTanks`). Each store's label is its catalog `short` (SRM, MRM, B230, B900, RKT, TANK).
- **Weapon selection** is an avionics command (`select-weapon`); the selected weapon is avionics state. A weapon brings its master mode: missiles air-to-air, bombs and rockets air-to-ground (`weaponMode`); an air-to-air weapon keeps a dogfight. Choosing a master mode by hand deselects a weapon of the other mode. With the format built, the air-to-ground preset's left display shows it, and SMS joins the F-21's left display buttons.

**How it was checked.** `tests/storesFormat.test.ts`: selecting bombs brings air-to-ground and a missile air-to-air; a dogfight stays; a hand-chosen mode deselects the other mode's weapon; the snapshot's counts, tanks and station order; the buttons issue their commands; the air-to-ground preset opens the format. `tests/displays.test.ts` now expects SMS among the left display's formats. `tools/displays.screens.mjs` (air-to-ground and air-to-air, both skins, 1366 × 768): within the clutter limits, and the format read at 3× with no overlaps after the labels were staggered. The unit suite, the type check and lint pass.

**Reason:** roadmap R2.6, *Stores format and master arm; weapon selection triggers air-to-air and air-to-ground modes*.

### 290. Urban ground fields name the nearest street; the shader measures exactly

**Date:** 2026-11-21
**Decision:** A chunk's feature field (decision 266) no longer stores the distance to the nearest street's edge. Each texel names the nearest street segment within 40 m: an index into the chunk's own segment table of up to 4,096 segments, with ends in chunk-local meters quantized to 3 cm (two u16 per end) and the half-width and class. The block's ground and district stay in the texel's upper bytes. For each pixel the shader takes the segments the four texels round it name and measures the exact distance to each. A chunk's field grows from 64 KB to 112 KB; the 128 slots hold 14.7 MB.

**Reason:** the owner saw village lanes drawn as a row of lens-shaped patches. The texels are 7.8 m; a lane 6 m wide often has no texel center inside it, so every stored distance was positive, and interpolating between them dipped below zero only where the lane passed near a texel center. A distance to a line cannot be interpolated across the line. Naming the segment and measuring per pixel draws streets of any width whole, with exact ends and junctions.

### 291. Plans take the roads and railways as the terrain draws them

**Date:** 2026-11-21
**Decision:** `InfraScene` records each road, spur and railway as it draws it: smoothed through the network's cell centers, or along its alignment where the world has one (`roadLines`, `railLines`). The city layer passes these to `settlementWorld` as the plans' arterials and rails, in the app and in the render preview. Before, plans took the network tier's coarse polylines.

**Reason:** the owner saw houses standing on a main road. A plan laid out its street village and its grids along the coarse polyline, while the terrain drew the road hundreds of meters away along its smoothed or aligned course.

### 292. Downtowns and business districts; American and Southeast Asian styles

**Date:** 2026-11-21
**Decision:**

- **Towers.** A new district, *business*, holds towers: a new building kind on parcels of about 2,600 m², with squarish footprints of 26–45 m, 12–60 floors of 3.6 m rising toward the district's middle, flat roofs with a setback crown (and a plant room in the kit), walls in glass, stone and concrete, and paved plazas between. Window bands and lit windows as other buildings.
- **Placement by style.** Each style says where towers go:
  - **downtown at the center** (American, Southeast Asian): city blocks within 0.13 of the extent from the center, and the inner 0.06 of large towns;
  - **business district off the center** (Western, Mediterranean, Nordic), in the manner of La Défense: in cities only, the largest block at 0.35–0.7 of the extent within 250 m of a main road, and up to 28 blocks within 650 m of it;
  - **none** (Eastern bloc, Arid).
- **American style.** A gridded city with no organic core and no radial avenues, 15% wider street spacing, a downtown, and suburbs of gabled and hipped houses on lots 35% larger. Walls are siding and brick, roofs asphalt gray. Its cities raise TV towers like the Western and Eastern bloc ones.
- **Southeast Asian style.** Dense: spacing 0.85, parcels 0.55. Rows of pastel shophouses, a floor taller than terraces elsewhere, over an arcade at the street. Hipped and flat tiled roofs, a downtown of towers. The climate gates it to tropical biomes (rain and seasonal forest, mangrove, cloud forest, savanna).
- **Preferences** (decision 261 revised): A northern Nordic, Western, American; B eastern Eastern bloc, Western, Nordic; C southern Mediterranean, Southeast Asian, Western; D steppe Arid, Eastern bloc, American; E islands Southeast Asian, Western, Mediterranean. Over seeds 1, 4, 7 and 10, American appears in 110–450 settlements per world (up to 1.9 million people). Southeast Asian appears in 1–20, where tropical coasts allow it (seed 7 has a city of 240,000).
- Every world's settlement styles change with this; that is presentation only (nothing in the campaign reads styles).

**Reason:** the owner asked for cities whose centers are skylines (American, Southeast Asian) and for European cities whose business centers lie away from the old center.

### 293. Cities at night from afar; chunks culled at their ground

**Date:** 2026-11-21
**Decision:**

- **Culling.** A city chunk's cull sphere stands at the middle of the ground under it, exaggerated as the terrain is, with a radius of 760 m plus half the ground's range plus its tallest rise. It stood at sea level with a 1 km radius, so on high ground a chunk was culled while its buildings were still in view, and buildings popped in and out as the view panned.
- **Far light.** At night the roofs of the far block prisms carry the block's mean light (18% of the window glow, by the settlement's lighting level), and their walls the mean window glow. Streetlights now stand on arterial and major streets of the far chunks too, every other lamp (80 m), out to the prism range. Near chunks keep a lamp every 40 m on all vehicle streets.

**Reason:** the owner saw buildings popping at night and no town lights from a distance: the prisms' dark roofs covered the terrain's town glow (decision 71), and streetlights ended at 2 km.

### 294. The owner's review of the stores: four bombs with a centerline tank, drop tanks as a base stock, falling tanks, read-only spectator displays

**Date:** 2026-11-21
**Decision:** After seeing the stores on the GPU (owner, 2026-11-21):

- **Loadout variants.** A mission profile's loadout may have variants, `<id>/<name>` (`loadoutsFor`), listed heaviest first; the planner hangs the first that reaches the target and that the base has the stocks for, and the mission records which. The F-21's `strike` is now 4 × 900 kg bombs (middle and inner pylons), two wingtip missiles and a 1,100 l (300 gal) centerline tank, radius factor 0.6; `strike/long` is the old load (2 bombs, 2 wing tanks, 0.85). The catalog gains the centerline tank (`tank-1100`: 910 kg of fuel, 1,050 kg full), and the centerline pylon carries it instead of the wing tank.
- **Fuel per loadout.** A loadout's fuel is the flight data's internal fuel plus its tanks where the bundle has both (`Loadout.fuel`, derived by the loader; `loadoutFuel`): 5,440 kg for the air-to-air and long strike loads, 4,110 kg for the heavy strike. Routes, the cruise flow and what a launch draws from the base use it; the type's `fuel` stays the reference for the rest.
- **Drop tanks are a base stock** (`BaseStocks.tanks`; `TANK_SETS` = 3 sets per aircraft that can hang them). A launch takes the tanks its loadout hangs; a completed mission brings back those its surviving aircraft still hang. Every flight in an aggregate fight (the CAP, the escorts, the intercepted flight) drops its tanks (`AirOps.dropTanks`), and tanks jettisoned at full fidelity come back as the handback's expended stores (decision 275), so neither returns. A base without the tanks a loadout needs cannot launch it (`stocked`; the planner falls back to a variant it can hang, or the sortie goes unfilled for stocks). Tanks the AI drops while a flight is only spectated do not reach the campaign (spectating is presentation, decision 257; TODO).
- **Falling tanks.** A store that leaves its pylon at full fidelity falls away from where it hung, pushed clear at 2 m/s, tumbling, under gravity and its drag (`sim/flight/ballistics.ts`, `stepFalling`, which the bombs' fall will use), drawn with its shadow until it reaches the drawn ground or a minute has passed (`render/sim/aircraft/releasedStores.ts`).
- **Read-only spectator displays.** While the player follows without flying, the displays still change formats and slots, but avionics and controls commands (master arm, weapon selection, jettison, gear) are ignored (`DisplaySystem.readOnly`).

**How it was checked.** `tests/resolution.test.ts`: on seed 7, flights in fights have their tanks expended and bring none home, and the bases' tanks plus those hanging on live flights fall short of the start after 26 h. `tests/ballistics.test.ts`: an empty tank dropped at 3 km and 200 m/s lands in 24.7–32 s, slowed by drag. `tests/stores.test.ts`, `tests/aircraftStores.test.ts`, `tests/storesFormat.test.ts` and `tests/storesRack.test.ts` for the new strike load and the per-loadout fuel; `tests/air.test.ts`'s radius test plans with the longest-reaching variant. The unit suite, the type check and lint pass. `tools/war.preview.ts` (`29693ed4a8559e18`, `75791e6763b6d8d7`, `19f0a52c1957e002`; stepped and in one jump the same): aircraft lost (A/P) 18/12, 11/15, 3/4 and launches as before; it now reports loadouts by variant, and on seed 4 the F-21 flies 14 interdictions with the heavy load and 1 with the long one.

**Reason:** the owner's review: an F-16 carries more than two bombs, tanks should drop rather than vanish and should be tracked per airbase so that jettisoning has a cost, and a spectator should not be able to arm or safe the aircraft.

### 295. The gun with a lead-computing pipper

**Date:** 2026-11-21
**Decision:**

- **Data.** A type's internal gun is its bundle's `gun` (rule 17): rounds, rate, muzzle velocity, where the muzzle is, a round's mass and drag area, and one tracer in how many rounds. The F-21's is an M61A1 with PGU-28 figures: 510 rounds at 100 a second, 1,030 m/s, 0.102 kg and 1e-4 m², a tracer in five, its muzzle on the left shoulder.
- **Rounds** (`sim/flight/gun.ts`) leave the muzzle at the muzzle velocity plus the aircraft's own along the boresight, slow with drag in the air's density and fall with gravity, and are followed for 3 s. At 3 km they need about 0.74 s to open 610 m on the shooter. The gun fires while its trigger is held, with master arm on, off the ground, and with the gun selected or the dogfight mode up (`StoresRack.stepGun`, at the flight step); the rounds fired count as expended stores (`gun`), so the handback carries them and a later promotion has the rest (decision 275). The gun is a weapon on the stores format (GUN with its rounds, selected it brings air-to-air).
- **Pipper.** The lead solution flies the rounds fired now and the shooter ahead together, the shooter holding its turn (its body rates), until the rounds are the pipper's range from it: a radar lock's range, or 610 m (about 2,000 ft) without one. The pipper is that point as seen in the shooter's frame turned by then (the classic gunsight's assumption that the target holds the same turn). Level, it sits a few milliradians under the boresight; in a pull it drops further below the nose by the lead. The HUD draws it as a ring with a center dot, world-anchored at its range, with the rounds left under it (and SAFE with master arm off), while the gun is selected or in a dogfight.
- **Trigger.** Enter (`FLIGHT_BINDINGS.fire`), or the left mouse button while the mouse flies, in Free Flight and in a take-over. The AI holds its fire until R3 gives it targets; rounds the player fired fly on after a handback.
- **Tracers** (`render/sim/aircraft/tracers.ts`): each tracer round a short additive streak along its flight, warmer at the head, at least about two pixels wide at range (`docs/visual-style.md`, *Light and Emissives*). Hits, the muzzle flash and the gun's sound are next (TODO). *Fix after the owner's first flight (same day):* the streaks trailed their rounds by a fixed 31 m, so a round one frame out drew its tail behind the aircraft and the tracers seemed to come from behind it; a streak is now never longer than the round has flown from the muzzle at the muzzle velocity.

**How it was checked.** `tests/gun.test.ts`: 1 s of trigger fires 100 rounds with 20 tracers, none safe; a round leaves at about 1,230 m/s and slows and falls; level, the pipper is 0.5–8 mrad under the boresight with a time of flight of 0.4–0.8 s; a 0.2 rad/s pull moves it more than 0.05 rad further down; no solution at 5 km; the rack fires only armed with the gun selected, counts the rounds expended, and a new rack from that state has the rest. The unit suite, the type check and lint pass. The lockstep test is unchanged.

**Reason:** roadmap R2.6, *Gun with a lead-computing pipper*.

### 296. Night: no grain on black, no lit ground without lamps, a darker night

**Date:** 2026-11-21
**Decision:**

- **Grain.** The simulation view's film grain (decision 138) fades out toward black as well as toward white: its amplitude is `grainAmount` × (1 − 0.6 Y) × smoothstep(0.04, 0.2, Y) on the encoded luma Y. It was strongest in the darkest tones, so a night sky and unlit ground crawled with noise. The dither of half a code value stays. The strategic view's paper grain (decision 93) is a separate effect and never reaches the simulation view.
- **Town glow on the ground.** A planned town lights itself with its streetlights, windows and the far prisms' glow (decision 293) out to the prism range. Its light disk (decision 71) now adds to the ground only by smoothstep(10 km, 14 km) of the distance from the camera; unplanned towns keep their disk. The disk had washed the whole town and the fields round it in a warm tan, with the canopy shell's woods cut out of it in black.
- **Far window light.** Beyond the windows' range (1.4 km), a building's walls and the far block prisms' roofs no longer glow evenly with the windows' mean light (decision 293). Lights are points on a 14 m lattice of planet positions: about one cell in ten, by the lighting level, holds a small bright spot; between 5 and 10 km from the camera the spots give way to their mean, about a tenth of the old roof glow. The even glow on roofs read as lit ground.
- **Town light as points.** A town's and an industry's light disk on the terrain (decision 71) now falls in points over its built-up patch: on a 30 m lattice, a third of the cells hold a small bright spot, giving way to their mean, 0.15 of the old even glow, where cells shrink below two pixels: from afar a dim warm glow, not lit ground. The soft halo off the patch fades in only with pixel footprints from 150 m to 1.5 km, from far up. Airbases keep their glow.
- **Rural glow.** The habitability speckles that stand for unplanned villages fade in between 20 and 50 km from the camera (superseded by decision 299: from orbit only). Nearer, they lit kilometer-wide patches of open ground with no lamps in them.
- **A darker night.** The full moon's light (`fullMoon`) is 0.06 (was 0.12, decision 140) and the starlight and airglow floor (`nightLight`) 0.008 (was 0.02). On seed 4's `night` view under a ten-day moon, moonlit open ground went from about (33, 35, 40) to (5, 9, 15) in sRGB: land is a silhouette against the sky, and only a full moon shows it dimly. The night is meant to need a night vision system, which does not exist yet (TODO).
- `tools/render.preview.ts` takes `FULL_MOON` and `NIGHT_LIGHT` to try the night's light.

**Reason:** the owner saw grain on black areas at night and light patches on the ground near towns that read as lit ground, not as lights, and asked for a night dark enough that a night vision system will be needed.

### 297. IR missiles: one per side, a seeker circle, proportional navigation, a proximity fuze

**Date:** 2026-11-21
**Decision:**

- **Data.** An IR missile's catalog entry carries a `missile` block: the seeker's gimbal limit, acquisition cone and lock range, the motor's thrust, burn and propellant, proportional navigation's gain and g limit, the fuze radius and the missile's life. The Alliance's `srm` (AIM-9M figures: 40° gimbal, 2.5° cone, 10 km, 12.5 kN for 5.2 s, 35 g, 8 m fuze) and the Pact's new `srm-p` (R-73 figures: 60° gimbal, 3° cone, 12 km, 14 kN for 5 s, 40 g, 9 m fuze, 105 kg), with its own model (canards forward). The Pact's flies once a Pact fighter has pylons and flight data (R2.7).
- **Heat sources** are the aircraft a seeker can see, refreshed by the app each frame and carried along their velocities between refreshes: in a take-over the other side's airborne flights (each one's lead on its route), in Free Flight the traffic. The seeker is itself a sensor (rule 12): it sees what is hot inside its cone and range, without a display's filtered picture.
- **The aircraft's seeker** (`sim/flight/missile.ts`, `Seeker`) looks along the boresight, or slaved to a radar lock inside its gimbal limit; a source inside its cone and lock range locks, and it tracks that source until it leaves the gimbal limit or the range. The HUD draws its circle at the cone's size (at least a readable ring), dashed while it searches and solid on the target it tracks, with the missile's name and count (and SAFE).
- **The missile** leaves its station with the aircraft's velocity, pushed clear at 3 m/s, at the seeker's target. It burns its motor along its velocity, slows with drag that doubles at a 25 g pull, falls with gravity, and steers by proportional navigation (gain 4), its pull limited by its g limit scaled with dynamic pressure up to 40 kPa. It keeps its target inside its gimbal limit; without one it flies on unguided. Its fuze fires at the closest approach along each step within the fuze radius; past its life, below 150 m/s after burnout, or into the ground, it is spent. From a 250 m/s launch at 5 km it reaches about 1,000 m/s and hits a crossing target 3 km out in 4.9 s. Hits are not yet resolved into damage (the next task); the HUD says "Missile hit" or "Missile missed".
- **Firing.** With an IR missile selected and master arm on, a press of the trigger (Enter or the left button) launches one; the trigger fires the gun only with the gun selected, or in a dogfight with no weapon selected. The rack holds the missiles in flight and steps them at the flight step with the gun (`StoresRack.stepWeapons`); a missile fired counts as an expended store and leaves its rail.
- **Drawn** (`render/sim/aircraft/missileViews.ts`): the store's model along its velocity, a short warm flame at its tail while the motor burns, and a smoke trail, pale gray and lit as a surface turned to the sun, widening and thinning out over 7 s (`docs/visual-style.md`, *Light and Emissives*).

**How it was checked.** `tests/missile.test.ts`: the seeker locks a source in its cone, keeps it 30° off the nose, loses it at 60° and beyond its range; the missile reaches 700–1,100 m/s and hits a crossing target within 6 s; it hits a target turning away at 6 g from 2.5 km and is spent against one 18 km out running away; it never fuzes on its shooter; from the rack, the seeker locks, the launch takes a missile off a station and records it, and the missile hits. `tests/stores.test.ts` for the catalog. The HUD composite (`tools/hud/composite.html?shot=climb&seeker=1` and `seeker=lock`) and the model preview of `store-srm-p` were read. The unit suite, the type check and lint pass.

**Reason:** roadmap R2.6, *IR missile with a seeker circle and simple guidance, one per side*.

### 298. A weapon chosen on the stores format keeps the format up

**Date:** 2026-11-21
**Decision:** Selecting a weapon brings its master mode (decision 289), and a new master mode applies its preset to the displays (decision 199). The first time a weapon was chosen on the stores format, the air-to-air preset put the moving map back on that display; once the player had chosen the stores format in that mode, their edit kept it there, so the jump happened only once (owner). Now a `select-weapon` command that changes the master mode keeps any large display that showed the stores format, expanded, on it; the other slots take the new mode's preset. The display system also takes the new mode as its last snapshot's at once, so the next update does not apply the preset a second time.

**How it was checked.** In headless Chromium on the displays' composite page (`tools/hud/composite.html?hover=transition&displays=navigation`): SMS chosen, then SRM; the stores format stays, where before the change the moving map replaced it. The unit suite, the type check and lint pass.

**Reason:** the owner's report after flying the IR missile.

### 299. No rural glow in the simulation view

**Date:** 2026-11-21
**Decision:** The rural glow (decision 71: habitability broken into 2.5 km speckles inside 30 km clusters, standing for villages too small for the light lists) fades in with the camera's altitude, from 50 to 200 km. The simulation view, at 20 km and below, draws only the settlements' own lights: every graph settlement is in the light lists of the tiles it shows, as points over its built-up patch and their dim mean from afar (decision 296). This supersedes decision 296's fade from 20 to 50 km of distance.

**Reason:** the owner saw warm glow patches over hills and mountains that held no town and turned to dark terrain on approach. They were the speckles beyond 20 km. The speckles serve a view from orbit, where a pixel holds many villages; nearer, they invent light where there is none.

### 300. Unguided bombs with CCIP and rockets; the F-21's CAS loadout

**Date:** 2026-11-21
**Decision:**

- **One projectile model** (`sim/flight/ordnance.ts`) for bombs and rockets: motor (rockets), drag on the drag area in the air's density, gravity, until the ground, where the path is cut at the ground and an impact recorded (where, when, how fast). A bomb leaves its station with the aircraft's velocity, pushed clear at 3 m/s down its axis; a rocket leaves its pod along the boresight at 30 m/s over the aircraft's speed and burns along its velocity. A 230 kg bomb from 1,500 m at 230 m/s falls in 17.5–19 s and lands 3.2–4.0 km on.
- **Rockets** are a pod's `rocket` block in the catalog (`rockets-19`: 19 rockets of 10.4 kg, 0.0023 m², 4.5 kN for 1.05 s, 6.2 kg of propellant, rippled at 10 a second); a 70 mm rocket model draws them. They reach 700–1,000 m/s over the ground. The rockets fired count as expended under `<pod>#fired`; the pods stay on their pylons, their mass unchanged for now (TODO).
- **Release.** With a bomb selected and master arm on, each press of the trigger drops one from its next station; with a rocket pod selected, the trigger held ripples rockets from the pods in turn. The stores format counts a pod's rockets, not the pod.
- **CCIP.** While a bomb or a rocket pod is selected, the same flight run ahead from the aircraft's state now, against the drawn ground, gives the impact point and the time to it (`impactPoint`; 0.02 s steps while a motor burns, 0.1 s after, up to a minute). The HUD draws a small ring with a center dot there, the fall line from the flight path marker to it, and the weapon, its count and the time to impact beside it (SAFE with master arm off; NO CCIP beyond a minute's fall). Its prediction agrees with the flown bomb within 15 m and 0.2 s.
- **Explosions** (`render/sim/aircraft/explosions.ts`): a warm flash and a dark rising cloud, sized by the cube root of the store's mass (a rocket's own), on two instanced meshes (`docs/visual-style.md`, *Light and Emissives*). Hits on targets are the next task.
- **The F-21's CAS loadout** (`cas`): two rocket pods, two 230 kg bombs, two wingtip missiles and a centerline tank, radius factor 0.7. Until now the multirole F-21 flew CAS with its first loadout, the air-to-air one. Seeds 4 and 10 are unchanged; seed 7's state changes (its F-21 CAS reach is shorter).
- **Free Flight's `loadout=`** names one of the F-21's air-war loadouts (`strike`, `strike/long`, `cas`, `air-to-air`); the Kestrel hangs it and fills its tanks, its flight model carrying the stores. Without it, the standard load as before.

**How it was checked.** `tests/ordnance.test.ts`: the bomb's fall time and range against the vacuum's; the CCIP against the flown bomb in a 0.5 rad dive; rockets' top speed and a flatter, quicker path than a bomb's; from the rack, one bomb per press, ten rockets in a second's ripple with the pods kept, eleven impacts, nothing safe. The HUD composite (`tools/hud/composite.html?shot=climb&ccip=1`) was read. The unit suite, the type check and lint pass. `tools/war.preview.ts` (`29693ed4a8559e18`, `75791e6763b6d8d7`, `37a12d2fc1bf5c94`; stepped and in one jump the same): aircraft lost (A/P) 18/12, 11/15 as before, and 2/2 on seed 7 (3/4 before).

**Reason:** roadmap R2.6, *Unguided bombs with CCIP fall lines; rockets*.

### 301. Hits and kills at full fidelity, damage in the campaign, ejection

**Date:** 2026-11-22
**Decision:**

- **Warheads.** Every store that bursts has a `warhead` in the catalog: its explosive, its lethal radius and its reach (srm 9.4 kg, 9 and 20 m; srm-p 7.4 kg, 9 and 20 m; mrm 39 kg, 13 and 28 m; the 230 kg bomb 87 kg, 30 and 90 m; the 900 kg bomb 429 kg, 50 and 150 m; a rocket 1.5 kg, 7 and 18 m). A warhead does its full effect within its lethal radius and (lethal / d)² of it out to its reach (`sim/flight/damage.ts`). The radii are generous on purpose: the owner wants explosives a little more effective and spectacular than real ones.
- **Aircraft** take damage 0..1, summed: a 20 mm round that passes within the target's radius (a fighter's 6 m, or its own) 0.07, a missile's burst or a bomb's its blast, measured from the target's edge. At 1 it is shot down. The rack finds the hits (`StoresRack.hits`): rounds tested along their path each step, bursts and impacts splashing everything within reach.
- **Ground targets** are the flight's own target: a target site where it is drawn (a bridge at its aim point, `bridgeAimPoints`, which main sets on the follow with the sites' kinds) or a road edge, on the drawn ground. A hit's amount is the blast from the target's edge (bridge 25 m, depots 60 m, rail yards and refineries 80 m) times explosive / (explosive + hardness) (bridge 300, road 120, supply depot 150, fuel depot 100, rail yard 200, factory and power plant 250): one 900 kg bomb within its lethal radius cuts a bridge (0.59), three 230 kg bombs do (0.54), a rocket barely scratches it.
- **To the campaign** as logged inputs (rule 19), the moment they happen: `shot-down` (the flight, where, by what, and the flight that shot it down, credited with the kill) loses the aircraft as the aggregate does, with its crew's chances; `target-hit` applies the amount to the site or road edge (`DamageState`, combined as independent chances). The worker sends the damage to the main thread when it changes (`SnapshotMessage.damage`), and the map turns a damaged target's symbol amber (from 0.15) and a destroyed one or a cut bridge red (0.75, or `BRIDGE_CUT` for bridges; `docs/visual-style.md`, *Strategic Palette*).
- **Damage states, minimal:** whole, damaged (counted, not yet shown; smoke and turning home are R3's) and destroyed. A shot-down aircraft's wreck falls from where it was hit with its velocity, burning and trailing smoke, and explodes on the drawn ground (`render/sim/aircraft/wrecks.ts`). In Free Flight the traffic can be shot down the same way, and is gone from the sensors and the sky for the sortie.
- **Ejection.** X twice within two seconds. In a take-over the player's aircraft is lost with the cause `ejected`, whose crew all survive as survivors (`EJECTED`; other causes keep their chances), it goes down unflown, and the flight goes back to the AI with the loss in its hand-back. In Free Flight the sortie ends as a crash the crew survives.

**How it was checked.** `tests/hits.test.ts`: the blast's falloff; one 900 kg bomb or three 230 kg ones cut a bridge, a rocket hardly marks it; the gun hits an aircraft on its line at 300 m round by round; a bomb that lands on a target's point cuts it; in the worker, `shot-down` loses the aircraft, logs it and credits the shooter, `target-hit` damages the site, and an `ejected` loss kills no crew; the map's marks take the damage colors by key. The unit suite, the type check and lint pass. The aggregate war is unchanged (no new draws).

**Reason:** roadmap R2.6, *Hit and kill resolution; minimal damage states; ejection from full fidelity*, and its exit: a CAP kill and a bridge hit, both in the campaign's state.

### 302. Proposal 0012 accepted: the AC-31 Warden gunship, the gunner station and a sensor render mode

**Date:** 2026-11-22
**Decision:** Proposal 0012 (`docs/proposals/0012-gunship-and-sensor-stations.md`) is accepted as written. The Alliance gets a side-firing gunship after the AC-130H (working name **AC-31 Warden**), whose AI pilot flies a left-hand pylon turn while the player works the **gunner station**; the Pact gets none, and the Hind analogue (Mi-24) takes the role as an airborne tank that carries troops. Where the proposal leaves a choice open, this decision makes it:

- **The gunner station** is the one place where the picture is not the chase view: the sensor image fills the screen in place of the scene, and the station's reticle, compass, orbit status, weapon state and markers replace the HUD. Rule 12 holds (no cockpit, no cockpit camera: the image is the sensor's), and so does rule 14: the five slots keep their positions and bindings over the sensor image, the messages slot carries the talk-on requests, the stores format the ammunition, and the optional chase view is a format in a slot, not a free window. Crew station mode elsewhere stays in the chase view. The player moves between the pilot and gunner stations by one key; the AI crew (R4.5) covers the one the player leaves.
- **What the sensor shows.** The image is the rendered scene through the sensor; labels, track boxes, strobes and talk-on markers come only from the sensor model and the side's messages, never from ground truth (rule 12).
- **One sensor render mode** (R3.2) serves the targeting pod format, helicopter gunner sights and the gunner station: a heat value per material, set in the model specs (rule 11's JSON) and per terrain class, shifted by time of day and weather; white-hot, black-hot, low-light TV and color TV treatments; smoke that obscures TV more than infrared. It replaces the main view, so its cost does not add to the scene's.
- **Shells** (R3.3) extend the gun's rounds of decision 295 with time of flight, dispersion growing with range and impact and short-delay fuzes, and their damage uses the warheads of decision 301. Fire control's lead for the orbit and the wind is the AI's and the player's alike.
- **Ground entities** (R3.6) are built to serve the gunship: infantry in treelines and buildings (the settlement colliders, decision 268), vehicles that move, scatter and hide, convoys on aligned roads at night, units that return fire, and friendly infrared strobes.
- **Missions.** Gunship CAS, armed overwatch, night convoy interdiction and CSAR cover are four plug-ins with all eight parts (rule 16). Their planner rules read the side's air defense picture (R3.1, R3.5): no radar SAM coverage, local air superiority, limited AAA. The Hind analogue adds convoy escort and armed reconnaissance to R4.2's catalog.
- **Standing** is a new campaign variable per side, lowered by damage to non-military buildings (the settlement damage states, decision 269, read through the city layer's plain exports, rule 20), and adds to ceasefire pressure. It comes with morale and reputation in R5.2 and enters the end conditions in R5.3. Fratricide costs squadron morale and the named pilot's reputation.
- **Roadmap.** A new milestone, **R4.10 Gunship** (large), holds the bundle, the orbit autopilot, the weapons, the gunner station, the missions and the rules of engagement; R3.2, R3.3 and R3.6 take the parts above. The gunship is a new role in the order of battle, so it changes every world's cast (rule 17) once its bundle exists; this is that decision, and the demo seeds' war will change then.
- **Proposal 0011** (stylized effects), on which the gunship's impact presets build, is not in the repository. Until it is, the presets extend the explosions and tracers of decisions 295 and 300, and the visual style guide lists their looks under *Light and Emissives*.

`docs/design.md` (revision 13), `docs/visual-style.md`, `docs/roadmap.md` and `TODO.md` take the proposal in this commit; proposals 0006 and 0008 get a note.

**Reason:** the owner's proposal. The gunship ties air superiority, air defense suppression, night operations and the ground war together, and its dependence on a safe sky makes the player's earlier missions visibly matter.

### 303. The sensors read the campaign: flights as radar contacts, radars and defended places as emitters, the AEW's datalink

**Date:** 2026-11-22
**Decision:** A followed or flown campaign aircraft runs the sensor model of decision 218 on the war (`follow/campaignSensors.ts`), at 10 Hz, whether it flies at full fidelity or on its analytic route.

- **Flights** within 400 km are radar targets, one per flight at its lead's analytic pose (`m<id>`, the id the missile seeker and the kills use), with a cross-section and size by role (a multirole fighter 4 m², a bomber or an AEW 40–60 m², the stealth striker 0.05 m²). A formation shows as one contact, as at a radar's resolution; each aircraft as its own contact near the aircraft waits for R3 (TODO).
- **Emitters.** A flight of the other side whose type carries an air-to-air radar emits it, labelled by the digits of its name ("Vo-31" → "31"): tracking the aircraft within 80% of its range against a fighter and inside its scan, searching otherwise. The other side's defended places, the target sites with an air defense and the airbases, carry a surface-to-air radar (45 km, tracking within 25 km; SA6 for the Pact, HK for the Alliance), standing for the aggregate's point defenses until R3.5's sites. The own side's radars stay off the threat display.
- **Datalink.** While an early warning aircraft of the own side is airborne, the other side's flights within 350 km of it reach the datalink, 5 s late and 400 m off.
- **Environment.** Visibility and daylight from the campaign's weather and the sun, line of sight over the drawn ground (the follow's airfield ground).
- **What reads it.** The displays' radar and threat formats (the spectator's too, read-only), the HUD's box on the locked contact (carried along its velocity between scans), the gun pipper's range from the lock, the IR seeker slaved to the lock, a lock the radar lost breaking with "Lock lost", air combat mode's lock, the threat warning's calls and tones while the player flies, and the flight cap, which a radar tracking the aircraft or a launch now holds at 1× ("threat warning").

**How it was checked.** `tests/campaignSensors.test.ts` on seed 7's campaign three hours in: every airborne flight in reach is a target at its lead, the own flight left out, emitters exactly on the other side's radar-carrying types; the other side's defended place tracks within 25 km and the own side's is left out; the datalink exists exactly while an own AEW flies and carries only the other side; a flight 20 km ahead becomes a radar contact under its `m<id>`. `tests/flightCap.test.ts` with the threat warning. The update costs about 0.15 ms on seed 4. The unit suite, the type check and lint pass.

**Reason:** roadmap R2.6, *Sensors read campaign contacts*, and the TODOs it closes: the spectator's empty radar and threat formats (R2.4) and the flight cap's threats (R2.5).

### 304. The mission phases' interface defaults applied: the cruise mode, formats, weapons, cues, declutter

**Date:** 2026-11-22
**Decision:** The `interface` part of a mission plug-in (rule 16; master mode, formats and HUD cues per phase, decision 249) now drives the followed or flown aircraft's displays and HUD, through the display system (`DisplaySystem.setPhase`, set by the follow every frame from the mission's phase).

- **Master mode.** In the air the triggers fall back to the phase's mode instead of navigation (`ModeInputs.cruise`): a CAP is in air-to-air from the fence-in, an interdiction in air-to-ground over the target. Ground, the approach (gear down below 3,000 ft) and the hover still win, a phase's `ground` never counts in the air, and a mode or a weapon the player chose stays (`manual`).
- **Formats.** In the phase's master mode its formats come after the player's edits of the mode's preset (decision 200) and before the preset's own (`applyPreset`'s `prefer`), expanded; a new phase applies them at once.
- **Cues.** `aa-reticle` pre-selects the first air-to-air missile left (else the gun) in air-to-air, `ccip` the first bomb or rocket pod left in air-to-ground (`preselectWeapon`), unless the player chose a weapon or a mode, or one of the mode's weapons is selected. `target` and `station` draw a diamond on the HUD with its range: the target where it is drawn (a bridge at its aim point), the station's center on the ground. `steering` waits for the route task; the helicopters' `landing-zone` for R2.9.
- **Declutter.** The landing aid shows on the ground, on the approach, with the `glidepath` cue, or while the triggers have the jet in approach or ground mode; elsewhere a mission's HUD leaves it off. Free Flight, which has no mission, is unchanged.

**How it was checked.** `tests/phaseInterface.test.ts`: the triggers fall back to the phase's mode and still go to ground and approach; a phase's formats win over the preset and lose to the player's edit; the cues pre-select a missile on station, a bomb over the target, the gun once the missiles are gone, and nothing without the cue or after the player's choice; a CAP's station phase is air-to-air with the station cue and no landing aid, its approach shows it. The unit suite, the type check and lint pass. The owner checks it in a take-over on the GPU.

**Reason:** roadmap R2.6, *Interface defaults per mission type and phase*.

### 305. The flight plan on the moving map and the HUD: waypoints from the route, steering, the front, a picture without the war's truth

**Date:** 2026-11-22
**Decision:** A mission's waypoints come from its analytic route's phases (`sim/air/waypoints.ts`), and the followed or flown aircraft's moving map and HUD show them.

- **Waypoints.** The base, the initial point where the fence-in starts (IP), the target of a pass (TGT), the center of a station's racetrack (STN) or a landing's field (LZ), and home. The route between them runs along great circles, so straight legs from point to point are the plan as flown. A waypoint is passed once the mission's phase has gone past it (the IP from the fence-in, the target or station from the egress) or once the aircraft came within 2 nm of it, as an F-16's steerpoints sequence; home is never passed early. The follow keeps the passed set per route, so a handback's or an abort's new route starts afresh.
- **Snapshot.** `AircraftSnapshot.route` carries the waypoints numbered from 1 and the legs sampled at most 10 km apart, as bearing and distance from the aircraft; `fronts` the front lines within 600 km, as the strategic map draws them (`StrategicScene.frontLines`: the live line, its teeth's side and the attacker's color).
- **Projection.** Every symbol on the moving map, the destination's diamond included, is placed by the picture's own projection (`mapPlace`): a camera straight down over the aircraft with the strategic camera's 45° field of view, at the height that shows √2 × the range at the picture's edge. On a 1,000 km planet the flat projection of decision 202 was off by 3% of the range at 80 nm and 7% at 160 nm.
- **Map.** Legs from waypoint to waypoint, flown legs dim and the one to the next waypoint wider; circles with number and name, a triangle for the target, a dashed ring around a station, a square for a landing field; the next waypoint bold and, beyond the range, a caret at the edge with its distance. The front is in the strategic picture already; the elevation modes draw it as Part II does, a dark line on a pale casing with teeth in the attacker's color. Display lines gained a color, a casing, a dash and a fill for this.
- **The picture leaves out the war's truth.** The moving map rendered the whole strategic scene, so every flight, carrier group and unit symbol of both sides showed on it, against rule 12. `renderMap` now hides the air and ground layers; datalink tracks are to come from the sensor picture (the intraflight datalink task).
- **HUD steering** (the plug-ins' `steering` cue: climb-out, ingress, egress and the stations' phases): the next waypoint's diamond on the ground with its number and name, a diamond under the heading tape at its bearing (an arrow at the tape's end beyond ±30°), and the block with the waypoint, distance, bearing and time to go at the ground speed where the landing aid is, which the aid has outside the approach since decision 304.

**How it was checked.** `tests/waypoints.test.ts`: a pass's waypoints are the base, the IP at least the fence-in distance out, the target and home, in time order; a CAP's station is the racetrack's center; sequencing by phase and within 2 nm, and not beyond; the snapshot's numbering and sampling, a bearing and distance that lead back to the waypoint, the fronts within reach and thinned; `mapPlace` against the camera's projection at four distances, north-up and track-up, and off the screen beyond the horizon; the map's legs from each waypoint, the next leg wider, waypoint labels, the edge caret at 5 nm; the front with its teeth in the elevation mode only. `tools/hud/composite.html` gained `&route=1` (with `&terrain=flat&mapmode=elevation`) for the map and `&steering=1` for the HUD; both were looked at in Chromium. The unit suite, the type check and lint pass. The owner checks it in a take-over on the GPU.

**Reason:** roadmap R2.6, *route and waypoints on the moving map and HUD steering*; the map's picture showing every flight was a leak of ground truth onto a display.

### 306. Direct control's hold: altitude or path, track or bank, while the hand is off the stick

**Date:** 2026-11-22
**Decision:** In direct control with the pilot's hand off the stick (the mouse free in cursor mode or for keyboard flying, no stick key held, no gamepad or flight stick deflected; `FlightInput.handsOff`), an assist in the control layer flies the jet through the one flight director (rule 12; `sim/flight/holds.ts`). It takes its references from the attitude it is left in, as the F-16's autopilot does:

- **Pitch:** within 5° of level it holds the altitude (a climb rate of 0.08 per second of the error, at most 20 m/s); steeper it holds the flight path angle (at most 30°).
- **Roll:** within 7° of wings level it levels the wings and holds the track; banked further it holds the bank (at most 60°) in a steady turn, by giving the director the course error that asks for that turn's rate.
- **Bounds:** the throttle and the pedals stay the pilot's. It engages only in the air with the gear up above 60 m radar altitude, so takeoffs, approaches and landings fly on the laws as before; mouse aim releases it, and a stick key or the captured mouse takes the stick back at once, starting from the hold's last stick. It engages again from the new attitude when the hand comes off.
- **Display:** the strip shows ALT HOLD or ATT HOLD while it flies (a discrete state; rule 14). Free Flight and a taken-over campaign jet share it.

Before, freeing the mouse in direct control centered the stick. The pitch law then held 1 g, which keeps a level path but sinks in a bank, and the roll law held whatever bank the jet had: a player who freed the mouse in a turn to click a display came back to a descending spiral.

**How it was checked.** `tests/holds.test.ts` on the Kestrel's flight model: let go nearly level, it levels the wings and holds the track within 1° and the altitude within 15 m over 30 s; let go in a 20° bank it holds the bank within 3° and the altitude within 25 m for 20 s while still turning, where the laws alone sink further; let go in a climb it holds the flight path within 1.5°; it stays out with the gear down. `tests/mouseCapture.test.ts`: the input is hands-off only in direct control, enabled, with the mouse free and no stick key held. `tools/freeflight.session.mjs` flies the real `FreeFlight` class: after the mouse-aim takeoff, direct control with the mouse free and the gear up engages the hold and the strip shows it. The session's check that drizzle wets the ground at once now allows for its two figures' rounding (0.36 against 2.5 × 0.14). The Kestrel's lockstep fixture is unchanged (the test pilot does not use the input). The unit suite, the type check and lint pass.

**Reason:** roadmap R2.6, *direct control in cursor mode*: the free cursor works the displays, so the jet must keep flying sensibly while it does.
