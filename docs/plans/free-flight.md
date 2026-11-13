# Plan: Free Flight mode

*Drafted 2026-11-13 for the overnight Free Flight task. Branch `feature/free-flight`. The decisions this plan leads to are recorded in `docs/decisions.md` (134 onward).*

## Goal

A sandbox mode: pick a seed and an airbase, spawn on the runway in the F-21 Kestrel (the F-16 analogue), take off, fly anywhere, and land at the same or another airbase. No war simulation, no other traffic, no weapons.

## What exists

| Area | State | Where |
| --- | --- | --- |
| Simulation view | Faceted terrain quadtree to 20 km, sky, sea, clouds, trees, buildings; observer and free cameras | `render/sim/globeScene.ts`, `render/sim/terrain/` |
| Terrain heights on the CPU | `TerrainRenderer.displaySurfaceAt` (the finest drawn surface, graded) and `heightAt` | `render/sim/terrain/terrainRenderer.ts` |
| Airbases | Coarse-pass facts: id, name, kind, side, land node, theater, point, runway heading (0..π) and length (2,000–3,600 m) | `worldgen/strategic/infrastructure.ts` |
| Runway geometry | 45 m wide runway, parallel taxiway, apron, links, as pavement segments | `render/sim/infra/infraScene.ts` |
| Runway grading | Flat pad per airbase (runway + 200 m overruns, taxiway, apron) at the mean global height, 400 m smootherstep margin; applied in every tile and in `heightAt` | `render/common/terrain/grading.ts`, `render/sim/infra/airfieldGrading.ts` (decision 108) |
| Runway paint | Threshold bars, designators, aiming points, edge stripes, centerline dashes, taxi lines in the terrain shader | `render/sim/infra/runwayMarkings.ts` (decision 109) |
| Runway lights | Edge lights every 60 m, green threshold and red end rows, fading in at dusk | `render/sim/infra/lightPoints.ts` (decision 110) |
| Base kit | Hangars, shelters, tower, radar, fuel tanks, revetments | `render/sim/infra/structureLayer.ts` |
| F-16 analogue | `alliance-fighter.json` (F-21 Kestrel), 400-odd triangles, one static mesh, no gear, no hinges | `render/common/models/specs/` |
| Aircraft performance table | F-21 entry (speeds, ceiling, fuel) for the analytic air war | `sim/air/aircraft.ts` |
| Camera rig, flight model, flight director, HUD, flight input | None | – |
| Start screen | None: the app opens the simulation view with the debug GUI | `main.ts`, `ui/debugGui.ts` |
| Map click | A click picks a flight icon or a ground point for the range rings | `render/strategic/strategicScene.ts` |

Phase 1's runway generator and most of Phase 2 therefore already exist. The runway heading follows the prevailing winds rather than the flattest axis; Free Flight keeps it, since changing it would change every existing world's airfields.

## What I will build

### Simulation (`src/sim/flight/`, headless, tested in Node)

- `atmosphere.ts`: the 1976 standard atmosphere to 32 km (temperature, pressure, density, speed of sound), and calibrated airspeed from true airspeed.
- `flightSpec.ts`: the flight-model data type and its validation. The data lives in a `flight` block in `alliance-fighter.json`, next to the geometry; the app and the tests pass it in, since `sim` may not import `render`.
- `flightModel.ts`: rigid body, float64 planet-centered position and velocity, a body-to-world quaternion, body rates. Fixed 120 Hz steps with 4 substeps. Gravity along the local radial at g₀·(R/r)². Forces: thrust (idle, military, afterburner tables over Mach and altitude, spool lag), lift from a CL(α) table with a stall break, drag (CD0 by Mach, induced drag, gear and speedbrake increments), side force. Moments: control moments from the control laws, bounded by an authority that scales with dynamic pressure, plus ground contact moments.
- `controlLaws.ts`: the fly-by-wire layer. Pitch stick commands load factor in flight and pitch rate at low speed and on the ground; lateral stick commands roll rate; rudder commands sideslip with turn coordination; α limiter near 25°, load-factor limits +9 / −3 g.
- `gear.ts` (inside the model): three wheels as spring-dampers along the local up, rolling and braking friction, a stiction spring for braked and lateral friction so the aircraft rests without drift, differential braking, nosewheel steering that fades with speed, parking brake; gear transit and limits; body contact points (nose, tail, wingtips, fin) for crashes.
- `runway.ts`: runway records (center, heading, length, width, elevation), the runway frame, the landing end, designators, the 3° glide path.
- `outcomes.ts`: liftoff, touchdown (sink rate, speed, distance from the threshold), full stop, hard landing, crash.
- `flightDirector.ts`: desired direction and speed → stick and throttle. Used by mouse aim and by the scripted test pilot.

### Presentation

- `render/sim/camera/chaseCamera.ts`: spring-damped chase camera, free look on a held button, terrain avoidance, lower and closer on the ground. Float64, tested without three.js.
- `render/sim/aircraft/aircraftView.ts`: the Kestrel mesh with animated parts: control surfaces, gear, speedbrake, afterburner glow; placed camera-relative. `spec.ts` and `builder.ts` gain hinge-animated parts.
- `GlobeScene` gains a third camera mode, `chase`.
- `ui/flight/`: input bindings (one remappable table), the HUD (Canvas 2D), the debug panel (F3), the help overlay (H), the start screen and pause menu, summary cards.
- `src/freeflight/`: the mode's app glue on the main thread: world loading for the seed, the airbase picker, the ground query for the flight model, the fixed-step clock, session flow.

### Entry

- `?mode=freeflight&seed=<seed>&base=<id>` opens the mode; optional `tod=<hours>`, `spawn=runway|air`, `fuel=unlimited|limited`.
- A "Free Flight" button in the debug GUI opens the mode for the current seed.

## What I will reuse

- World generation, caching and the global pass exactly as the app runs them.
- The graded pads: the flight model's ground on a pad is the pad's elevation, the same number the renderer's `surfaceSampler` returns there. Off the pad the ground comes from `TerrainRenderer.displaySurfaceAt`, the same surface the camera and buildings use, with the global height map (graded) as a fallback before tiles load.
- Runway paint and lights as they are.
- The model builder, palettes and lighting (`PlanetLighting.shadeDiffuse`, aerial perspective).
- `withLocalTime` and the calendar to set the time of day.

## Deviations from the docs

1. **Free Flight pulls player flight control forward.** Proposal 0002 and the design keep takeoff and landing with the AI and put player flight control in P1 after the demo. Free Flight adds a first version of P1 (flight model, control laws, direct control, a flight director) and part of P2 (a HUD) now, plus ground handling and landing gear, which the proposal ruled out. Recorded as a decision; the design's *Non-goals* and *Later* sections and the visual style's "No landing gear animation" are amended to name the exception.
2. **Direct control is Free Flight's default**, not mouse aim, because takeoff and landing need direct inputs. Mouse aim exists through the flight director.
3. **The player's flight model runs on the main thread** in Free Flight, at fixed 120 Hz steps, since there is no sim worker in the mode and input latency matters. This answers P1's open item for this mode only.
4. **Rotational dynamics are control-law driven.** The control laws compute the moments that achieve their commanded rates, bounded by an authority proportional to dynamic pressure; there are no aerodynamic moment tables (Cm(α), Cl(β)). This keeps the model stable and tunable at medium fidelity. Departures are not modeled.
5. **No weather in Free Flight.** Without the sim worker there is no weather model, so the sky is clear.
6. **A non-rotating planet.** Coriolis and centrifugal terms from planet rotation are left out.

## Order

Phase 0 (this plan), 3 (flight model and its tests, the riskiest part), the headless flight test, then 1 (entry and picker), 2 (runway checks), 4 (controls, camera, model), 5 (HUD), 6 (session flow), 7 (browser check), 8 (docs and report). Each phase ends with a commit after `npm run check` passes.
