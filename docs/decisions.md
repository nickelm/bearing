# Architecture decisions

Newest entries go at the bottom. Each entry records the date, the decision and the reason. If a decision is reversed, add a new entry that references the old one rather than editing history.

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

### 21. Provisional climate breaks latitude symmetry

**Date:** 2026-11-09
**Decision:** The milestone-1 climate no longer depends on latitude alone.

- **Latitude warp.** Large-scale noise bends the latitude used for temperature (up to about 22°) and, separately, for the moisture bands.
- **Coasts and interiors.** Continental interiors at high latitudes run up to 7 °C colder. Open ocean far from land runs up to 9 °C warmer, a stand-in for ocean heat transport, so sea ice hugs coasts and enclosed seas.
- **Ice sheets.** Land becomes ice sheet only below −20 °C annual mean. Tundra covers −20 to −6 °C.

**Reason:** The owner's review found circular polar caps, and map previews showed biome stripes following latitude exactly. Real winds and rain shadows remain the climate stage proper in milestone 2.

### 21. Two grid resolutions: tectonic CPU grid and GPU global grid

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

### 40. Static hosting on GitHub Pages; no cross-origin isolation

**Date:** 2026-11-10
**Decision:**

- **Hosting.** The app is fully static and lives on GitHub Pages as a project site, `https://<user>.github.io/bearing/`. `.github/workflows/deploy.yml` runs on every push to `main`: `npm ci`, type check, tests, `vite build`, then `actions/upload-pages-artifact` and `actions/deploy-pages`.
- **Base path.** Vite's `base` is `/bearing/` for `vite build` and `vite preview`, and `/` for the dev server and Vitest.
- **No cross-origin isolation.** Pages cannot send COOP/COEP headers, so `SharedArrayBuffer` and `Atomics.wait` are unavailable. The sim and worldgen workers communicate via `postMessage`, transferring `ArrayBuffer`s instead of sharing memory. Snapshots and generation results are built as transferable buffers.
- **Asset URLs.** Runtime paths must resolve under the base. Workers load via `new URL('./x.worker.ts', import.meta.url)`, which Vite rewrites. Shaders are inline WGSL strings. Any future `public/` file is addressed through `import.meta.env.BASE_URL`, never a root-absolute path.

**Reason:** Static hosting needs no server, costs nothing and deploys from CI. The price is no shared memory between threads. Transferring buffers moves them without a copy, so per-tick sim snapshots and world-generation output can still cross the worker boundary cheaply.

### 40. Lakes from a per-sample lake level; smooth lowlands

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
