# CLAUDE.md

Guidance for Claude Code sessions in this repository. `docs/design.md` is the source of truth for scope and architecture. Read it before starting milestone work. `docs/decisions.md` records the decisions behind it, with dates and reasons. `docs/visual-style.md` is the source of truth for how the game looks: rendering, models and UI (rule 11). The game has two views of one world (decision 72): the illustrated **strategic view** (globe down to a ~100 km zoom floor; visual-style Part II) and the low-poly **simulation view** (0–20 km, entered through a unit; Part I). Owner proposals live in `docs/proposals/`; an accepted proposal is folded into the design doc and a decision.

**Keep the documents in step with the decisions.** A decision that changes anything `docs/design.md` or `docs/visual-style.md` states must update that document in the same commit. Edit the statement in place rather than leaving the old text for readers to reconcile. If you find a document contradicting a decision anyway, the later decision wins: fix the document.

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
docs/proposals/     owner proposals (do not reformat); 0001-two-views.md (decision 72) and
                    0002-third-person-flight.md (decision 94) are accepted
src/core/           units, float64 Vec3d, coordinates, seeded RNG, invented names. Leaf layer.
src/worldgen/       planet generation pipeline stages (may use GPU compute)
  coarsePass.ts     the design's pipeline at 256² on the CPU; campaignWorld.ts adds the validity retries
  strategic/        strategic graph types and builder (settlements, roads, bridges), and infrastructure
                    placed after casting: the only world view campaign logic gets. Road hierarchy,
                    railways and urban extents go here too, and the types of named features (decision 72)
  geography/        feature extraction (S2): named-feature records with geometry and importance, run by
                    the graph builder; types in strategic/graph.ts
  names/            toponymy generator from rng("names"): flavors, generic terms; names features,
                    settlements and corridors (route numbering in S4)
src/campaign/       theater detection, casting, briefing, validity check (reads the strategic graph only)
src/sim/            headless simulation; runs in a worker: event queue + fixed ticks (simulation.ts),
                    time acceleration (host.ts), world factory (world.ts)
  weather/          hourly weather model on a bordered 24² cube grid; WeatherView for queries
  command/          per-side command layer: intelligence picture, ATO (graph and cast only)
  flight/           (planned, P1) flight model, flight director and sensor model, shared by AI and player
src/render/         Three.js WebGPU + TSL, split by view (decisions 72–74). Both scenes stay resident;
                    the app renders the active one (GUI → View → View). Until V1, sim/'s GlobeScene
                    still draws orbit to ground.
  common/           shared by both views: camera-relative placement, orbit camera, cell-grid debug
                    globe, palette, climate and habitability textures, render scale, cube-sphere
                    geometry, WebGPU checks, terrain/ (tile quadtree, tile meshes, tile cache, budget, prefetch, grading),
                    water/ (river segment tables and river shading), models/ (model spec format,
                    procedural builder, palettes and schemes, specs/*.json; decision 106);
                    later the transition controller
  sim/              simulation view: GlobeScene, camera/ (observer camera and stations), terrain/
                    (TerrainRenderer), atmosphere/, water/ (sea), clouds/, forest/, infra/, lighting/;
                    later the camera rig and the HUD overlay (V4, P2)
  strategic/        strategic view: StrategicScene, StrategicCamera, zoom bands, relief mesh, hillshade,
                    biome fill, patterns, glyphs (glyphLayout, glyphGeometry, glyphLayer), graph debug
                    overlay
    labels/         label engine: SDF font atlas, styles, band content tables, placement, LabelLayer
    overlays/       military overlays (decision 101): territory tint texture, the overlay model
                    (front, defensive lines, corridors, sea lanes, chokepoints) and MilitaryLayer
    infra/          settlements and infrastructure (decision 104): urban fill texture, building
                    glyph placement, the model of roads, railways, bridges and site symbols
src/ui/             lil-gui debug panel, overlays, time controls
src/viewer/         the model viewer page (viewer.html, a second Vite page; decision 106)
src/workers/        worker entry points and message protocols
src/main.ts         app entry: WebGPU checks, renderer, scene, GUI
tests/              Vitest unit tests (node); tests/gpu/ runs WGSL kernels on a real GPU via Dawn
tools/              offline previews (npm run maps; terrain/bench *.preview.ts), output in tools/out/
TODO.md             task list by milestone (F, S, C, V, I tracks, then P after the demo; design.md, Milestones)
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
   - Every world-space object's GPU position is `worldPos − cameraEye`, subtracted in float64 _before_ it is written into float32. Place objects with `placeCameraRelative` / `placePlanetCentered` in `src/render/common/cameraRelative.ts`.
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
11. **Visual style** (decisions 70, 72). All rendering, models and UI follow `docs/visual-style.md`: Part I for the simulation view, Part II for the strategic view.
    - Part I covers flat shading, the palette, polygon budgets, tree and model construction, LOD distances, post-processing, UI panels and type, and its "What to avoid" list.
    - Part II covers the strategic camera and zoom bands, the base map, glyphs, labels, overlays, day/night and weather on the map, its palette, and its own "What to avoid" list.
    - Keep the two views separate. The map never draws individual trees or buildings, and the simulation view never goes above about 20 km.
    - Models are built in code from JSON specs, not modeled by hand or loaded as photographic assets.
    - If something must deviate from the guide, record it in `docs/decisions.md` and update the guide to match.
    - The reference screenshots in `docs/style/references/` are local only. Never commit them, import them from `src/`, or copy them into `public/` or `dist/`. `vite.config.ts` refuses to load anything under `docs/`.
12. **No cockpits; one flight director and one flight model** (decision 94, Proposal 0002).
    - Bearing has no cockpits. Every aircraft and helicopter is flown and followed from a third-person chase camera, and the HUD and displays are 2D overlays (`docs/visual-style.md` Part I, _HUD and Displays_). Do not add cockpit interiors, cockpit cameras or cockpit-only assets.
    - AI pilots and the player share one flight director (desired direction and speed → control inputs) and one flight model. The player's input only replaces where the aim point or stick input comes from. Never give the player's aircraft its own physics path or the AI a shortcut around the flight model.
    - Displays show only what the aircraft's sensor model knows, which is the same filtered picture the AI uses, never ground truth.

## Fidelity as level of detail

Fidelity is a level of detail in both space and time.

- The renderer refines terrain where the camera looks.
- The simulation refines units where the player looks and coarsens them when time runs fast.

Every unit exists at one of three levels:

- **Aggregate:** formation, flight or convoy. Always simulated, cheaply.
- **Entity:** individual vehicles and squads. Simulated only inside a promotion bubble of about 15–25 km around the player (around the followed aircraft or the simulation view's camera until player flight control exists in P1, decisions 49, 72, 94).
- **Full:** physical simulation (flight model, sensor model, flight director). Used only for the aircraft the player controls or follows, from P1; until then a followed aircraft flies its analytic route. The player flies and never commands ground or naval forces.

Promotion expands a unit deterministically from its seed and current strength. Demotion folds entity losses back into aggregate strength, so nothing destroyed comes back. Design data models so that promotion is possible even before it is implemented.

## Working rules

- Work on one milestone task at a time. Keep `TODO.md` current: check off finished tasks and add subtasks you discover.
- Record any architectural decision, or any deviation from `docs/design.md`, in `docs/decisions.md` with the date, the decision and the reason. In the same commit, update whatever `docs/design.md` or `docs/visual-style.md` says on the subject.
- Run `npm test` and `npm run typecheck` (or `npm run check`) before declaring a task complete.
- **Visual milestones close only after the acceptance checks** in `docs/visual-style.md` for the views they touch. A visual milestone is any milestone with rendering, model or UI tasks (all of S1–S4, V1–V4, I1 and P1–P5).
  - Simulation view (Part I): checks 1–5 as `tools/render.preview.ts` views; check 6, the silhouette test, in the model viewer once aircraft models exist; checks 7–10 (HUD and camera rig) as scripted sequences from V4 on.
  - Strategic view (Part II): checks 1, 2, 4 and 5 as preview views (4 through simulated color-vision deficiencies); check 3, the ten-second legibility test, with the owner.
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
- **Seeing the rendered scene without a browser:** `npx vitest run --config vitest.tools.config.ts tools/render.preview.ts` draws the app's `GlobeScene` with three's `WebGPURenderer` on Dawn (decision 32) from fixed views (`VIEWS=oblique,low,coast,glint,sea,shore,lake,trees,winter,mountains,sunset,town,airbase,runway,dusk,tower,tower-dusk,roads,night`; `tower` and `tower-dusk` look through the observer camera; `FLICKER=n` renders n more frames turning `FLICKER_TURN` rad per frame and logs tile counts and brightness per frame, to catch LOD flicker (`FLICKER_FORWARD`, `FLICKER_CLIMB` and `FLICKER_BOOST=1` also move the observer, and `PREFETCH=0` turns the terrain's prefetch off, to compare tiles waiting for data); `CLOUDS=0` hides clouds, `GRADE=0` leaves airfields ungraded) and writes `tools/out/render-*.png`. `SCENE=strategic` draws the strategic view's `StrategicScene` instead from its own views (`globe,night,theater,region,floor,cities,capital,front,winter,sharp`; `cities` and `capital` center on the Alliance capital; `sharp` is 1920 × 1080, `front` centers on the first front line, so use a seed that has one, e.g. `SEED=1`), with clouds, tile counts and frame times; `CVD=1` adds each image as seen with protanopia, deuteranopia and tritanopia (Part II check 4). Read them to judge shading and atmosphere. Until the S1 split these views span both envelopes; S1 and V1 sort them into strategic (≥ 100 km) and simulation (≤ 20 km) sets. The first run per world generates it (about 25 s); later runs load it from a disk cache in the OS temp directory. `LABELS=0` leaves the map's names out.
- **No GPU (cloud sessions):** `apt-get install -y mesa-vulkan-drivers` gives Dawn the lavapipe software Vulkan driver, so the GPU tests and `tools/render.preview.ts` run on the CPU (slowly: about 4 minutes per strategic view).
- **Seeing models without a browser:** `npx vitest run --config vitest.tools.config.ts tools/models.preview.ts` renders every model spec (or `MODELS=a,b`; `SCHEME=` overrides the camouflage) on the CPU into `tools/out/model-<id>.png`: four shaded views over the same four as silhouettes (Part I check 6), and prints triangle counts against the budgets. The carrier's spec is generated by `tools/models/carrier.py`.
- **Seeing terrain without a browser:** `npx vitest run --config vitest.tools.config.ts tools/terrain.preview.ts` runs the whole pipeline on Dawn and writes PNGs to `tools/out/`. Read them to judge changes.
- **TypeScript is pinned to 6.0.** TypeScript 7 (the native compiler) is out, but typescript-eslint 8.x supports only `<6.1`. See `docs/decisions.md`.
- Vite's cache lives in the OS temp directory (`cacheDir` in `vite.config.ts`), not `node_modules/.vite`, because the repo is in Dropbox and the in-tree cache fails with `EBUSY`. To clear it, delete `%TEMP%/vite-cache/bearing-*`.
- `node_modules/` and `dist/` carry the Dropbox "ignored" attribute so they don't sync. If you delete and recreate them, reapply it in PowerShell with `Set-Content -Path node_modules -Stream com.dropbox.ignored -Value 1`.
