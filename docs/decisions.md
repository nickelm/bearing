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
