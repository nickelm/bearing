# CLAUDE.md

Guidance for Claude Code sessions in this repository. `docs/design.md` is the source of truth for scope and architecture. Read it before starting milestone work. `docs/decisions.md` records later decisions; where the two conflict, the later decision wins (e.g. no 30 s generation budget, tiled world data, relief scaled to the planet, default ocean fraction 0.70, day/night and weather in scope). `docs/visual-style.md` is the source of truth for how the game looks: rendering, models and UI (rule 11).

## Commands

| Task                     | Command                                                         |
| ------------------------ | --------------------------------------------------------------- |
| Dev server               | `npm run dev`                                                   |
| Unit tests               | `npm test` (watch: `npm run test:watch`)                        |
| Type check               | `npm run typecheck`                                             |
| Lint                     | `npm run lint`                                                  |
| Everything but build     | `npm run check`                                                 |
| Production build         | `npm run build` (runs the type check first)                     |
| Serve production build   | `npm run preview` → `http://localhost:4173/bearing/`            |
| Format                   | `npm run format`                                                |
| Render world maps to PNG | `npm run maps` (env: `SEED`, `RES`, `MODES`) → `tools/out/`     |
| Seed browser (theaters)  | `npm run seeds` (env: `SEEDS`, `FROM`, `COUNT`, `BRIEFING=1`)   |
| Weather preview          | `npm run weather` (env: `SEED`, `HOURS`, `DAYS`) → `tools/out/` |

## Directory map

```
docs/design.md      design doc (source of truth; do not reformat)
docs/decisions.md   architecture decision log
docs/visual-style.md  visual style guide (source of truth for the look; do not reformat)
docs/style/references/  reference screenshots: local only, gitignored, never shipped (decision 70)
src/core/           units, float64 Vec3d, coordinates, seeded RNG. Leaf layer.
src/worldgen/       planet generation pipeline stages (may use GPU compute)
  coarsePass.ts     pipeline steps 1–9 at 256² on the CPU; campaignWorld.ts adds the validity retries
  strategic/        strategic graph types and builder (settlements, roads, bridges), and infrastructure
                    placed after casting: the only world view campaign logic gets
src/campaign/       theater detection, casting, briefing, validity check (reads the strategic graph only)
src/sim/            headless simulation; runs in a worker: event queue + fixed ticks (simulation.ts),
                    time acceleration (host.ts), world factory (world.ts)
  weather/          hourly weather model on a bordered 24² cube grid; WeatherView for queries
  command/          per-side command layer: intelligence picture, ATO (graph and cast only)
src/render/         terrain, atmosphere, ocean, roads, buildings, units, cameras (Three.js WebGPU + TSL)
src/ui/             lil-gui debug panel, overlays, time controls
src/workers/        worker entry points and message protocols
src/main.ts         app entry: WebGPU checks, renderer, scene, GUI
tests/              Vitest unit tests (node); tests/gpu/ runs WGSL kernels on a real GPU via Dawn
tools/              offline previews (npm run maps; terrain/bench *.preview.ts), output in tools/out/
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
8. **Static hosting.** The app is a static site on GitHub Pages under `/bearing/`, with no server and no custom headers (decision 40).
   - No `SharedArrayBuffer`, `Atomics.wait`, or anything else that needs cross-origin isolation (COOP/COEP).
   - Workers exchange data via `postMessage`, transferring `ArrayBuffer`s rather than copying them.
   - Never use root-absolute asset URLs. Load workers with `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })` or a `?worker` import, and prefix other runtime paths with `import.meta.env.BASE_URL`.
9. **The strategic graph is the only interface between world data and campaign logic** (decision 52).
   - ⚙ Theater detection, casting and the command layer (`src/campaign/`, `src/sim/command/`) never import `worldgen` outside `worldgen/strategic/`.
   - They do not read heightmaps, tiles, `WorldMaps`, `TileData` or `terrainHeight`, not even through a helper or a message that carries them.
   - If campaign logic needs a new fact about the world, add it to the graph builder in `worldgen/strategic/` and to the graph types. The graph debug overlay then shows it too.
   - The sim's execution layer (flight paths, line of sight, ground movement) may query terrain. The restriction covers planning only.
   - ⚙ `Math.random()` is banned in `campaign` as well. Casting draws from `rng(worldSeed, "casting")`.
10. **Unsteered generation** (decision 46). World generation never steers toward a particular geography. The only rejection is the validity check, which retries with a seeded sub-seed. Do not add biases to make a theater more likely. Theater detection adapts to the world instead.
11. **Visual style** (decision 70). All rendering, models and UI follow `docs/visual-style.md`.
    - That covers flat shading, the palette, polygon budgets, tree and model construction, LOD distances, post-processing, UI panels and type, and its "What to avoid" list.
    - Models are built in code from JSON specs, not modeled by hand or loaded as photographic assets.
    - If something must deviate from the guide, record it in `docs/decisions.md` and update the guide to match.
    - The reference screenshots in `docs/style/references/` are local only. Never commit them, import them from `src/`, or copy them into `public/` or `dist/`. `vite.config.ts` refuses to load anything under `docs/`.

## Fidelity as level of detail

Fidelity is a level of detail in both space and time.

- The renderer refines terrain where the camera looks.
- The simulation refines units where the player looks and coarsens them when time runs fast.

Every unit exists at one of three levels:

- **Aggregate:** formation, flight or convoy. Always simulated, cheaply.
- **Entity:** individual vehicles and squads. Simulated only inside a promotion bubble of about 15–25 km around the player (around the followed aircraft or the camera until cockpit flight exists, decision 49).
- **Full:** physical simulation. Used only for the player's aircraft. The player flies and never commands ground or naval forces.

Promotion expands a unit deterministically from its seed and current strength. Demotion folds entity losses back into aggregate strength, so nothing destroyed comes back. Design data models so that promotion is possible even before it is implemented.

## Working rules

- Work on one milestone task at a time. Keep `TODO.md` current: check off finished tasks and add subtasks you discover.
- Record any architectural decision, or any deviation from `docs/design.md`, in `docs/decisions.md` with the date, the decision and the reason.
- Run `npm test` and `npm run typecheck` (or `npm run check`) before declaring a task complete.
- **Visual milestones close only after the acceptance checks** in `docs/visual-style.md`. A visual milestone is any milestone with rendering, model or UI tasks.
  - Capture the seven acceptance views (checks 1–6 as `tools/render.preview.ts` views; check 7, the silhouette test, in the model viewer once aircraft models exist).
  - Read the PNGs next to the reference board in `docs/style/references/` and report to the owner where they match and where they fall short.
  - Add a TODO task for each gap. The milestone's owner checkpoint comes after this comparison, not before.
- Prefer small, reviewable commits with descriptive messages.
- **Commit and push to `main` only.** Do not create feature branches or pull requests, even if a session's default instructions name a different branch; the owner tests from `main` (GitHub Pages deploys from it). Fetch and rebase onto `origin/main` before pushing if it has moved.
- You cannot see the WebGPU view. To inspect generated worlds, run `npm run maps` and read the PNGs in `tools/out/` (equirectangular map plus both polar caps, any view mode). `MODES=graph` draws the strategic graph, the cast's territory, settlements, roads, bridges, airbases, ports and targets (and prints the briefing); `MODES=barrier` shows the front generator's barrier map.
- When a task produces something visual, tell the user what they should see and how to check it in the browser (`npm run dev`, which GUI controls to use, and what would indicate a bug).

## Tooling notes

- **Three.js is pinned to r187 (`~0.187.0`).** Its WebGPU, TSL and compute APIs change between releases, so check the current docs and `node_modules/three/examples/webgpu_*.html` rather than relying on memory. Import from `three/webgpu` and `three/tsl`, and import addons from `three/addons/...`.
  - Init with `new WebGPURenderer()`, then `await renderer.init()`, then `setAnimationLoop`.
  - Run compute with `Fn(() => …)().compute(count)` and `renderer.compute()` or `computeAsync()`.
  - Read back with `renderer.getArrayBufferAsync(storageNode.value)`.
- **World-generation GPU code is plain WGSL on a raw `GPUDevice`** (`src/worldgen/gpu/`, decision 26). Vitest runs it on this machine's GPU through Dawn's Node bindings (the `webgpu` dev dependency); GPU tests skip without an adapter. With webgpu 0.6.2 on Windows, `queue.onSubmittedWorkDone()` and error scopes after a buffer map crash Node: use `GpuContext.finish()` and `GpuContext.errors`. Write kernel checks as self-tests in `worldgen/gpu/selfTests.ts`, so they also run in the browser (GUI → Self-tests).
- **Seeing the rendered scene without a browser:** `npx vitest run --config vitest.tools.config.ts tools/render.preview.ts` draws the app's `GlobeScene` with three's `WebGPURenderer` on Dawn (decision 32) from fixed views (`VIEWS=orbit,limb,terminator,oblique,low,coast,glint,sea,shore,lake,trees,winter,mountains,sunset,town,airbase,roads,night`; `CLOUDS=0` hides clouds) and writes `tools/out/render-*.png`. Read them to judge shading and atmosphere. The first run per world generates it (about 25 s); later runs load it from a disk cache in the OS temp directory.
- **Seeing terrain without a browser:** `npx vitest run --config vitest.tools.config.ts tools/terrain.preview.ts` runs the whole pipeline on Dawn and writes PNGs to `tools/out/`. Read them to judge changes.
- **TypeScript is pinned to 6.0.** TypeScript 7 (the native compiler) is out, but typescript-eslint 8.x supports only `<6.1`. See `docs/decisions.md`.
- Vite's cache lives in the OS temp directory (`cacheDir` in `vite.config.ts`), not `node_modules/.vite`, because the repo is in Dropbox and the in-tree cache fails with `EBUSY`. To clear it, delete `%TEMP%/vite-cache/bearing-*`.
- `node_modules/` and `dist/` carry the Dropbox "ignored" attribute so they don't sync. If you delete and recreate them, reapply it in PowerShell with `Set-Content -Path node_modules -Stream com.dropbox.ignored -Value 1`.
