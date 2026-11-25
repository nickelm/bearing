# Stylized Smoke, Fire and Explosions (Proposal 0011)

Bearing is a cartoony browser game; the values and systems here serve gameplay (README.md, What Bearing Is; CLAUDE.md rule 22).

_Branch `feature/stylized-effects`, 2026-11-22. Decisions 320–327 (numbered past the main line's 301; renumber at merge if it has taken them). Plan: `docs/plans/stylized-effects.md`. Metrics: `docs/reports/stylized-effects-metrics.md`._

## Summary

One effects system now draws all smoke, fire, explosions, contrails and wingtip vortices in the simulation view. Smoke and fire are solid, round, toon-shaded puffs: one quad each, drawn as a sphere impostor that writes depth and fades by ordered dithering. A compute pass steps up to 20,000 of them. The city's plumes, the rotor's downwash, weapon impacts, wreck strikes and missile trails all use it.

## What Works

- **Puffs** (`src/render/sim/effects/puffMaterial.ts`). The quad is sized to the sphere's silhouette. The fragment shader finds the ray–sphere hit, with a squash along the local up and a lumpy radius, and writes its depth, so no sorting is needed. Light comes in three bands with a rim, all from `PlanetLighting.at`, so puffs take the terrain's and clouds' shadows, the moon and the night floor. Aerial perspective is applied per puff. Fire glows. A puff is never drawn smaller than about a pixel.
- **GPU simulation** (`puffCompute.ts`). An update kernel applies buoyancy, drag toward the wind, wind shear near the ground, turbulence and a per-puff fan, so columns widen as cones. It also applies the life curves for radius, color, glow, coverage and rise, keeps puffs out of the ground, and moves them with the floating origin. A spawn kernel then writes the frame's new puffs. `puffModel.ts` is the same step in TypeScript, and `tests/gpu/puffs.test.ts` checks the GPU against it on Dawn.
- **Pool and governor** (`pool.ts`). Slots come from a free list, so short-lived puffs never evict long-lived ones. Above 60% occupancy, every emitter's rate is scaled down.
- **Emitters** (`emitters.ts`, `presets.ts`). All 15 sources in the proposal exist. Moving sources lay puffs evenly along their path, including between frames. Far emitters shed fewer, larger puffs. Long-lived columns are full height the moment they come into range.
- **Explosions** (`effectsSystem.ts`, `debris.ts`, `flashLights.ts`). Each has the proposal's five layers: flash, fireball, smoke (dirt on the ground, gray in the air, spray and black smoke on water), debris with smoke trails, and a scorch with a shockwave ring. Up to four flash lights at once light the ground and buildings through a new `PlanetLighting.localLight` hook.
- **Ribbons** (`ribbons.ts`). Contrails form above the contrail altitude, which comes from the surface temperature; humid air makes them last longer. Vortices form above a load-factor threshold that drops in humid air. Ribbons stay at least 1.5 pixels wide.
- **Event interface** (`src/sim/effects/events.ts`). It defines `launch`, `hit`, `explosion`, `fire-started`, `fire-extinguished` and `aircraft-smoke` as plain, serializable records, plus a queue. Long-lived columns come whole from damage states through `setColumns`.
- **Integration.** `GlobeScene` owns the system (`globe.effects`). City plumes are fixed emitters. The downwash keeps its ground reading and drives an emitter. Impacts explode according to their warhead, wrecks strike as fuel fires that burn for ten minutes, and missiles trail according to their motor.
- **Sandbox.** `effects.html` has buttons for every preset, explosion size and kind, and scripted actor. It also has wind, sun and air controls, camera stations with a mouse orbit, the stress scene, and GPU timing with `?gputime`. `tools/effects.preview.ts` renders the same scene headless; `tools/effects.screens.mjs` captures the built page in Chromium.

## Metrics

These come from a software renderer (lavapipe), so the budget itself is unverified. The stress scene keeps 17,447 puffs alive with none evicted and the governor at 0.44, in 2 compute dispatches and 1 puff draw call a frame. At 960 × 540 under lavapipe, the effects add 23 ms to a 43 ms frame, and a step without drawing takes 1.2 ms. These are CPU times. The owner's GPU check is described in the metrics report.

| Check | State |
|---|---|
| Budget | Open: needs a GPU |
| Correctness (no sorting; intersections) | Met by design and in the renders |
| Readability (SAM from 20 km) | Met in `effects-sam-20km.png` |
| Persistence | Met in tests |
| Ribbons | Conditions tested; not yet called by the game |
| Integration (plumes, downwash) | Met |

Screenshots are in `docs/reports/screens/effects/`. The suite has 1,441 tests, of which 1,440 pass. The failure is `tests/gpu/mapSoak.test.ts` (the strategic map's soak on lavapipe), which also fails on the base commit. The new tests are `tests/effects.test.ts` (27), `tests/gpu/puffs.test.ts` (2) and `tests/gpu/effectsScene.test.ts` (1).

## Simplifications

- **One wind** at the camera with a fixed shear near the ground, not a wind per puff from the weather grid.
- **Ground under a puff** is the ground at its birth. A puff drifting over a hill can pass into it; its depth still clips it correctly.
- **Sun and sky light** are evaluated per fragment at the hit. The toon bands come from the sun's direction only; there is no self-shadowing within a cluster.
- **Debris, scorches and rings** are stepped on the CPU (at most 256 chunks and 128 marks). Scorches are flat discs with a polygon offset, so they can float or sink a little on slopes.
- **Contrail altitude** uses one temperature threshold (−40 °C), not the full Schmidt–Appleman criterion. Humidity is a 0–1 input the caller supplies.
- **Motors** are listed per store in `effects/weapons.ts` rather than in the stores catalog, which belongs to the main line.

## Decisions

| No. | Decision |
|---|---|
| 320 | Toon-shaded sphere-impostor puffs with depth and dithered fade; *Effects* in `docs/visual-style.md` |
| 321 | The GPU pool, its TypeScript reference, free-list slots and the governor |
| 322 | Emitters: rate or spacing, sub-frame placement, distance detail, prewarm |
| 323 | Explosions in five layers; debris and ground marks |
| 324 | Flash lights through `PlanetLighting.localLight` |
| 325 | Contrails and wingtip vortices as ribbons |
| 326 | The event interface; city plumes, downwash and weapons on the effects system |
| 327 | The effects sandbox and its tools |

## Shared Files Touched

| File | Change |
|---|---|
| `src/render/sim/globeScene.ts` | Owns and steps `effects` and `flashLights`, hooks `localLight`, clears on a cut; the city layer's wind uniform and the downwash's overlay group are gone |
| `src/render/sim/lighting/planetLighting.ts` | `localLight` hook, added to the sky term in `at()` |
| `src/render/sim/city/cityLayer.ts` | Plumes are effects emitters (`placePlumes`); the billboard mesh, material and `wind` are gone |
| `src/render/sim/ground/rotorDust.ts` | Sprites replaced by the effects' emitter; `washSurface` and the ground reading are unchanged |
| `src/render/sim/aircraft/explosions.ts` | Takes the effects system; `impact(x)` and `wreck(at, t)`; the old meshes remain as a fallback |
| `src/render/sim/aircraft/missileViews.ts` | Takes the effects system; trails go through it, with the old box segments as a fallback |
| `src/freeflight/freeFlight.ts`, `src/follow/follow.ts` | Pass `globe.effects`; call `impact` and `wreck`; one unused import removed from each |
| `vite.config.ts` | Third page, `effects.html` |
| `docs/visual-style.md` | *Effects* section; the downwash, settlement plumes, *Light and Emissives* rows and *What to Avoid* updated in place |
| `docs/roadmap.md`, `TODO.md`, `CLAUDE.md`, `docs/decisions.md` | Out-of-sync section, tasks, directory map and commands, decisions 320–327 |

## Known Issues

- **No GPU numbers.** The budget check waits for the owner's machine.
- **Chromium screenshots failed here.** Chromium's WebGPU device is lost at start in this container under both lavapipe and SwiftShader, including for the existing model viewer. The screenshots are Dawn renders of the same scene.
- **Fire at night** blooms toward white, and smoke columns at night are black silhouettes, because fire puffs do not light the smoke around them.
- **Downwash dust** reads somewhat like a heap of stones at close range. Its puffs are small and squashed, but they are opaque.
- **Ribbons** are built but nothing in the game calls them yet, and nothing sends `setColumns` or `aircraft-smoke` yet (TODO). Only the city's damaged buildings produce columns in the game today.
- **The free-list reclaim** scans all 20,000 slots on the CPU every frame; it is not timed separately (it is inside the 1.2 ms step).

## Next Steps

1. Measure the budget on the owner's GPU (`effects.html?gputime`, *stress test*, *Measure*), and run `tools/effects.screens.mjs` with `MODE=gpu`.
2. Game layer: `setColumns` from the worker's target damage (decision 301), `aircraft-smoke` for damaged aircraft, ribbons for the flown and followed aircraft, and `launch` events once SAMs fire (R3.4).
3. Move each missile's `motor` into `src/data/stores.json`.
4. At night, let fire light the smoke around it, and cap fire glow under the bloom threshold.
5. Once every scene has an effects system, drop the fallback meshes in `explosions.ts` and `missileViews.ts`.
