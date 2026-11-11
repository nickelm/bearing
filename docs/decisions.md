# Architecture decisions

Newest entries go at the bottom. Each entry records the date, the decision and the reason. If a decision is reversed, add a new entry that references the old one rather than editing history.

When an entry changes something `docs/design.md` or `docs/visual-style.md` states, update that document in the same commit, so the documents always describe the current plan. As of 2026-11-11, decisions 1–91 are reflected in both.

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

### 91. Third-person flight without cockpits; one flight director for AI and player (Proposal 0002)

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
