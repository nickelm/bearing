# Plan: Stylized Effects (Proposal 0011)

Bearing is a cartoony browser game; the values and systems here serve gameplay (README.md, What Bearing Is; CLAUDE.md rule 22).

_Written 2026-11-22 before any code, for the out-of-sync session that implements `docs/proposals/0011-stylized-effects.md`. One pull request from `feature/stylized-effects`. Decisions 320 onward; renumber them at merge if the main line has taken those numbers (the main line stood at 301 when this plan was written)._

## What Exists (Survey, 2026-11-22)

- **Explosions** (`render/sim/aircraft/explosions.ts`, decision 300). A warm additive flash and a dark smoke ball per impact: two instanced icosahedra, alpha-blended, sized by the cube root of the store's mass, moved on the CPU. Free Flight (`freeflight/freeFlight.ts`) and the follow (`follow/follow.ts`) feed it the rack's `impacts` and the wrecks' ground strikes.
- **Missile smoke** (`render/sim/aircraft/missileViews.ts`, decision 297). Each missile in flight (and each burning wreck, decision 301) leaves box segments every 0.06 s that widen and thin out over 7 s; one instanced mesh of up to 1,200 segments; a warm cone at the tail while the motor burns.
- **Wrecks** (`render/sim/aircraft/wrecks.ts`, decision 301). Ballistic fall on the CPU, drawn as a `Flying` with its motor lit, so `MissileViews` gives it flame and smoke; an explosion at the ground.
- **City plumes** (`render/sim/city/cityLayer.ts`, decisions 268, 269). Ten soft billboards per stack, cooling tower, damaged landmark or hit target, cycling in age over 40 s in the vertex shader; built per plan from `plan.plumes` and the plan's damage array.
- **Rotor downwash** (`render/sim/ground/rotorDust.ts`, decisions 168, 169, 182, 191). Stateless wispy sprites in the pipeline's overlay, placed by a hash of their index; the ground under the wash decides dust, grit, snow or spray (`washSurface`, `surfaceAt`). The flattened grass, the swaying trees and the ring on water are separate effects (decisions 176, 188) and stay.
- **Tracers** (`render/sim/aircraft/tracers.ts`). Not smoke; out of scope.
- **Contrails, wingtip vortices, flares**: none. Roadmap R6.6 lists flight effects (vapor, contrails, heat shimmer); R3.3 lists damage effects (smoke, fire, missing parts) and countermeasures.
- **Weapons and damage events.** The rack (`sim/flight/storesRack.ts`) holds `impacts` (where, when, mass) and the live missiles, rounds and falling stores; hits reach the campaign as `shot-down` and `target-hit` inputs (decision 301); the worker sends target damage to the main thread (`SnapshotMessage.damage`). There is no effect event stream; the views poll the rack.
- **Light.** `PlanetLighting` (one sun, sky, moon, night floor and a lightning flash as a point light), `particleLight` for particles at the camera, `aerialPerspective` per vertex. The renderer uses a reversed depth buffer (decision 112). No local point lights.
- **Proposal 0010** (terrain art direction), named in the session's instructions, was rejected by the owner (decision 328) and added to `docs/proposals/` for the record; nothing here depends on it.

## Architecture

### Event interface (`src/sim/effects/events.ts`)

Plain, serializable types the game engine may produce and the renderer consumes: `launch` (weapon, motor, where, direction), `hit` (where, what), `explosion` (where, explosive mass, kind: air burst, ground, water, fuel), `fire-started` and `fire-extinguished` (a keyed long-lived fire), `damage` (an aircraft's smoke state), plus `EffectSink`, the one method `handle(event)`. The module imports only `core`. Effects never feed back into game state (proposal, _Integration_).

### The puff system (`src/render/sim/effects/`)

| File                     | Contents                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curves.ts`              | Life curves (keys over 0..1 of life) sampled into a table of 16 entries per curve; the table is one storage buffer the compute and the material read                   |
| `presets.ts`             | Puff kinds (look: radius, color, rise, buoyancy, drag, emissive) and the 15 emitter presets of the proposal; explosion sizes; the motor-to-trail lookup for weapons    |
| `puffModel.ts`           | The puff integrator in TypeScript: the reference the compute kernel mirrors, used by tests                                                                             |
| `pool.ts`                | The CPU side of the pool: a ring of 20,000 slots, each slot's death time, the live count, the spawn staging records                                                    |
| `puffCompute.ts`         | Two TSL kernels: spawn (copies the frame's staging records into their slots) and update (forces, life curves, floating-origin shift)                                   |
| `puffMaterial.ts`        | The sphere impostor: camera-facing quad, ray–sphere hit with squash and a radius bump, depth written, three-band toon ramp and rim, ordered-dither fade, emissive fire |
| `emitters.ts`            | Emitter runtime: fixed or moving sources, spacing along a path or rate in time, sub-frame interpolation, distance LOD, prewarm                                         |
| `explosions.ts`          | The five layers: flash, fireball, smoke, debris, ground ring and scorch                                                                                                |
| `debris.ts`, `decals.ts` | Flat-shaded chunks on ballistic paths; scorch discs and shockwave rings on the ground                                                                                  |
| `lights.ts`              | Up to four flash lights a frame, the oldest dropped first, fed to `PlanetLighting`                                                                                     |
| `ribbons.ts`             | Contrails and wingtip vortices: camera-facing strips along recorded paths                                                                                              |
| `effectsSystem.ts`       | The facade: `handle(event)`, emitters by key, `setColumns`, `update(frame)`, `stats`                                                                                   |

**Floating origin.** Puffs are stored in float32 relative to an anchor near the camera; the anchor moves when the camera is 2 km from it, and the next update shifts every puff by the difference (computed in float64 on the CPU). The material adds `anchor − eye`, also computed in float64 (rule 4).

**Ordering.** Spawn, then update, then draw, all in the frame. One draw call for all puffs; dead slots collapse to a degenerate quad.

**Light.** Sun and sky from `particleLight` at the camera (uniforms), aerial perspective per puff at its center, the flash lights added per fragment.

**Budget.** The CPU knows every slot's death time, so it knows the live count. Above 80% of the pool a governor scales every emitter's rate down. Beyond 3 km an emitter's spacing and puff size both grow with the square root of distance.

### Integration

- **GlobeScene** owns one `EffectsSystem` (`globe.effects`) once a renderer is present, updated each frame after `beforeDraw` with the wind and the ground.
- **City plumes.** `CityLayer` keeps finding its sources (stacks, cooling towers, damaged landmarks and targets) and hands them to the effects system as keyed columns instead of building its billboard mesh.
- **Rotor downwash.** `RotorDust` keeps `washSurface` and the ground reading, and drives a downwash emitter instead of its sprites.
- **Weapons.** The views in Free Flight and the follow hand impacts and wreck strikes to the effects system as explosion events, and missiles in flight and burning wrecks drive trail emitters by motor type; `MissileViews` stops drawing its own smoke when the effects system draws trails. These are a few lines in shared files.
- **Long-lived columns.** `setColumns(list)` is declarative: the game layer passes the burning targets it knows (damage states) each time they change; a column the camera comes back to is prewarmed, so it is already tall.

## Phases

0. Survey, proposal, this plan.
1. Puff renderer: the impostor material on a test pool, in the sandbox.
2. GPU compute: curves, pool, the two kernels; the TypeScript reference and a GPU test against it.
3. Sandbox: `effects.html` (a third Vite page), a scene on a patch of planet with the real sky and light, buttons for every preset and explosion size, wind and sun controls, a stress test; `tools/effects.preview.ts` renders the same scene headless.
4. Emitters and explosions: the presets, the five layers, debris, decals, flash lights.
5. Ribbons.
6. Integration as above.
7. Verification: the proposal's checks, `docs/reports/stylized-effects-metrics.md`, screenshots, the _Effects_ section of `docs/visual-style.md`, decisions, `docs/reports/stylized-effects-report.md`.

## Risks

- **No real GPU here.** Lavapipe runs WebGPU on the CPU, so the budget can be checked only as a ratio and by counts (puffs, instances, dispatches); the owner's machine gives the real figures (`?dev&gputime=1`).
- **Depth written from the fragment shader** turns off early depth rejection for the puffs; the dither discards keep overdraw low, and the budget test measures it.
- **Shared files** (`globeScene.ts`, `cityLayer.ts`, `rotorDust.ts`, `freeFlight.ts`, `follow.ts`, `missileViews.ts`, `planetLighting.ts`) are touched as little as possible, and the report lists them.
