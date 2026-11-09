# CLAUDE.md

Guidance for Claude Code sessions in this repository. `docs/design.md` is the source of truth for scope and architecture. Read it before starting milestone work. `docs/decisions.md` records later decisions; where the two conflict, the later decision wins (e.g. no 30 s generation budget, tiled world data, relief scaled to the planet, day/night and weather in scope).

## Commands

| Task                     | Command                                                     |
| ------------------------ | ----------------------------------------------------------- |
| Dev server               | `npm run dev`                                               |
| Unit tests               | `npm test` (watch: `npm run test:watch`)                    |
| Type check               | `npm run typecheck`                                         |
| Lint                     | `npm run lint`                                              |
| Everything but build     | `npm run check`                                             |
| Production build         | `npm run build` (runs the type check first)                 |
| Format                   | `npm run format`                                            |
| Render world maps to PNG | `npm run maps` (env: `SEED`, `RES`, `MODES`) → `tools/out/` |

## Directory map

```
docs/design.md      design doc (source of truth; do not reformat)
docs/decisions.md   architecture decision log
src/core/           units, float64 Vec3d, coordinates, seeded RNG. Leaf layer.
src/worldgen/       planet generation pipeline stages (may use GPU compute)
src/sim/            headless simulation; runs in a worker
src/render/         terrain, atmosphere, ocean, units, cameras (Three.js WebGPU + TSL)
src/ui/             lil-gui debug panel, overlays, time controls
src/workers/        worker entry points and message protocols
src/main.ts         app entry: WebGPU checks, renderer, scene, GUI
tests/              Vitest unit tests (node environment, no GPU)
tools/              offline tools (map preview PNGs); run via vitest.tools.config.ts
TODO.md             milestone task list
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
   - Every world-space object's GPU position is `worldPos − cameraEye`, subtracted in float64 _before_ it is written into float32 (see `src/render/globeScene.ts`).
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

## Fidelity as level of detail

Fidelity is a level of detail in both space and time.

- The renderer refines terrain where the camera looks.
- The simulation refines units where the player looks and coarsens them when time runs fast.

Every unit exists at one of three levels:

- **Aggregate:** formation, flight or convoy. Always simulated, cheaply.
- **Entity:** individual vehicles and squads. Simulated only inside a promotion bubble of about 15–25 km.
- **Full:** physical simulation. Used only for the player's unit.

Promotion expands a unit deterministically from its seed and current strength. Demotion folds entity losses back into aggregate strength, so nothing destroyed comes back. Design data models so that promotion is possible even before it is implemented.

## Working rules

- Work on one milestone task at a time. Keep `TODO.md` current: check off finished tasks and add subtasks you discover.
- Record any architectural decision, or any deviation from `docs/design.md`, in `docs/decisions.md` with the date, the decision and the reason.
- Run `npm test` and `npm run typecheck` (or `npm run check`) before declaring a task complete.
- Prefer small, reviewable commits with descriptive messages.
- You cannot see the WebGPU view. To inspect generated worlds, run `npm run maps` and read the PNGs in `tools/out/` (equirectangular map plus both polar caps, any view mode).
- When a task produces something visual, tell the user what they should see and how to check it in the browser (`npm run dev`, which GUI controls to use, and what would indicate a bug).

## Tooling notes

- **Three.js is pinned to r187 (`~0.187.0`).** Its WebGPU, TSL and compute APIs change between releases, so check the current docs and `node_modules/three/examples/webgpu_*.html` rather than relying on memory. Import from `three/webgpu` and `three/tsl`, and import addons from `three/addons/...`.
  - Init with `new WebGPURenderer()`, then `await renderer.init()`, then `setAnimationLoop`.
  - Run compute with `Fn(() => …)().compute(count)` and `renderer.compute()` or `computeAsync()`.
  - Read back with `renderer.getArrayBufferAsync(storageNode.value)`.
- **TypeScript is pinned to 6.0.** TypeScript 7 (the native compiler) is out, but typescript-eslint 8.x supports only `<6.1`. See `docs/decisions.md`.
- Vite's cache lives in the OS temp directory (`cacheDir` in `vite.config.ts`), not `node_modules/.vite`, because the repo is in Dropbox and the in-tree cache fails with `EBUSY`. To clear it, delete `%TEMP%/vite-cache/bearing-*`.
- `node_modules/` and `dist/` carry the Dropbox "ignored" attribute so they don't sync. If you delete and recreate them, reapply it in PowerShell with `Set-Content -Path node_modules -Stream com.dropbox.ignored -Value 1`.
