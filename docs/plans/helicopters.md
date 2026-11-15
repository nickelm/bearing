# Plan: Helicopters (track H)

_Drafted 2026-11-15 for [proposal 0004](../proposals/0004-helicopter-flight.md) (decision 149); the owner's answers are decision 151. The tasks are in `TODO.md` under the helicopter track; later decisions record what each milestone changes._

## Goal

Rotor-disc helicopters in the one flight-model family that AI and player share (rule 12): approachable with fly-by-mouse and the Assisted preset, complete with assists off. Free Flight is the test bed for H1–H4; H5 brings helicopters into the campaign.

## What exists

| Area                                              | State                                                                                                                                                      | Where                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Fixed-wing flight model                           | Rigid body, float64 position, body-to-world quaternion, 120 Hz in four substeps, gravity on the local radial, standard atmosphere, bit-for-bit determinism | `sim/flight/flightModel.ts` (decision 134)                     |
| Ground model                                      | Spring-damper wheels with a bristle grip spring, braking, steering, hard points that crash the aircraft, ground query as an interface                      | `flightModel.ts`, `freeflight/ground.ts`                       |
| Control laws                                      | F-16-style laws; the rotational dynamics come from the laws' moment requests within an authority (no moment tables)                                        | `sim/flight/controlLaws.ts` (decisions 134, 136)               |
| Flight director                                   | Course, flight path angle and speed → stick and throttle; inverts the pitch law by bisection                                                               | `sim/flight/flightDirector.ts`                                 |
| Scripted test pilot                               | Flies the Kestrel's circuit from a generated airbase in Node                                                                                               | `sim/flight/testPilot.ts`, `tests/freeFlight.test.ts`          |
| Wind                                              | Air-relative forces, hashed gusts (no random numbers), the aircraft's wind capped at 8 m/s on the ground and full at 150 m                                 | `sim/flight/wind.ts` (decision 143)                            |
| Chase camera                                      | Springs, free look, terrain clearance; `ChaseRig` exists but every aircraft uses the jet's values                                                          | `render/sim/camera/chaseCamera.ts` (decision 135)              |
| Animated model                                    | Hinged parts from the model spec (`anim` channels)                                                                                                         | `render/common/models/`, `render/sim/aircraft/aircraftView.ts` |
| HUD                                               | Canvas 2D at device pixel ratio, frames built without the DOM                                                                                              | `ui/flight/hud.ts`, `freeflight/hudFrame.ts`                   |
| Input                                             | One remappable binding table, keyboard stick, mouse as stick, simplified mouse aim, basic gamepad axes; no pointer lock                                    | `ui/flight/flightInput.ts`                                     |
| Particles                                         | Rain, snow and dust particles with wind                                                                                                                    | `render/sim/weather/` (decision 142)                           |
| Air war types                                     | Four helicopters: AH-70 Lancer (AH-64A), CH-60 Mule (CH-47D), Ve-28 Shershen (Mi-24V), Ve-36 Bizon (Mi-26); no models                                      | `sim/air/aircraft.ts`                                          |
| Missions                                          | Helicopter CAS and sling-load resupply, flown analytically at 30 m                                                                                         | `sim/air/mission.ts`, `missionRoute.ts`                        |
| Canopy height field                               | Built for rendering (decision 150); line of sight and tree strikes not yet; needed for both                                                                | `worldgen/canopy.ts`                                           |
| Helipads, landing zones, rooftop and deck contact | None                                                                                                                                                       | –                                                              |

Two gaps shape the plan. The Little Bird and Black Hawk analogues that H1 names are not in the air war's type table, and adding a type to the order of battle changes every world's cast. And `FlightModel` is a fixed-wing class that the camera, HUD frame, outcomes and director all read directly.

## Architecture

### One airframe interface, two models

Step 0 of H1 extracts what both models share, without changing the Kestrel:

- `sim/flight/airframe.ts`: the `Airframe` interface the rest of the code reads (position, velocity, attitude, body rates, wind, time, crash state, common telemetry such as radar altitude, ground speed, heading, pitch, bank), plus `step(controls)`.
- `sim/flight/rigidBody.ts`: state, gravity and the substep integrator.
- `sim/flight/contact.ts`: the spring-damper and bristle friction for wheels, and for skids, which are contact points that slide but do not roll.
- A lockstep test that the Kestrel's scripted circuit, air maneuvers and braked stand stay bit-identical to the model before the split, as in decision 143.

`RotorcraftModel` in `sim/flight/rotor/` implements `Airframe`. Free Flight, the chase camera, the HUD frame and the outcomes take an `Airframe`.

### The rotor model (`sim/flight/rotor/`)

Each substep, in body axes:

- **Inflow and thrust** (`inflow.ts`). Uniform inflow from momentum theory with Glauert's forward-flight form, solved by a fixed number of Newton steps so the result is deterministic. Thrust coefficient from collective and inflow through the closed-form blade integral (uniform inflow, linear twist). Effective translational lift is not a table: induced velocity falls as the disc meets clean air, so it emerges between 15 and 25 kt, and a test pins it. Ground effect follows Cheeseman and Bennett, T/T∞ = 1 / (1 − (R/4z)²), within about one diameter. In steep descents, where momentum theory has no solution, an empirical induced-velocity curve takes over; it carries vortex ring state (H4) and autorotation.
- **Disc tilt** (`flapping.ts`). Longitudinal and lateral flapping as first-order states with the type's flapping time constant, driven by cyclic and lagging the fuselage's rates, which gives the natural pitch and roll damping. Hub moment = (hub stiffness + thrust × hub height) × tilt: a teetering rotor has no stiffness term, so its control moment vanishes with thrust.
- **Power and rotor speed** (`powerplant.ts`). Power required = induced + profile + parasite + climb. Power available by altitude and temperature from a spec table, capped by the transmission limit (the torque limiter assist acts on collective). Rotor speed is a state, I·Ω̇ = Q_engine − Q_rotor, under a governor; it droops when demand exceeds supply and floats free in autorotation.
- **Yaw** (`tailRotor.ts`). Main-rotor torque Q = P/Ω, countered by tail rotor thrust on its arm, with an authority limit that shrinks at high power and with relative wind from behind or the advancing side. Tandem and coaxial types use one yaw-authority parameter instead.
- **Airframe**. Fuselage drag areas for front, side and top; fin and horizontal stabilizer as small lifting surfaces (weathervaning, nose attitude at speed); stub wings with a CL(α) table for the Hind analogue.
- **Calibration.** The spec carries the type's power-required curve and hover ceilings. The model derives power from physics, and `tools/flight.preview.ts` fits the induced factor, profile drag and flat-plate area to that curve. The tests then check hover, bucket and maximum-speed power against the curve within the type's tolerance. This way the curve stays data in the spec, as the proposal asks, and the physics stays continuous across regimes, which a lookup table would not.

The spec gains a `rotor` flight block beside the fixed-wing `flight` block, parsed and validated in `rotor/rotorSpec.ts` (SI except degrees, as for the Kestrel).

### Controls, director and assists

- `RotorControls`: longitudinal and lateral cyclic, collective, pedals, wheel brakes, and the engine and governor state.
- `rotor/heloLaws.ts`: stability and control augmentation. Attitude command, attitude hold for pitch and roll; rate command for yaw with pedal trim; translational rate command near the hover (A/D); collective as climb-rate command or position by preset; hover hold as a ground-velocity and position loop. With augmentation off, controls pass straight to the model.
- `rotor/heloDirector.ts` implements the shared director interface (`sim/flight/director.ts`). `DirectorTarget` gains optional rotary fields: heading separate from course, a ground-velocity command for the hover, and a height reference (barometric or radar). The fixed-wing director ignores them. The rotary director turns the target into the laws' commands, and the laws into controls, so the AI and the player meet at the same place.
- `rotor/assists.ts`: one record of independent toggles and the three presets of the proposal. Envelope protection lives here, never in the physics: a descent-rate floor at low speed (vortex ring state), a load-factor floor of about 0.5 g in teetering types (mast bumping), a speed limit below retreating blade stall, bank and pitch limits, and the torque limiter.
- **Fly-by-mouse** in `ui/flight/`: pointer lock for relative mouse motion. Vertical motion sets a pitch-attitude command; horizontal motion feeds a blend of yaw rate and turn rate (coordinated bank) by speed between the type's two thresholds (about 20 and 40 kt). Which speed drives the blend (ground speed or airspeed) is a tuning question for hovering in wind; the tests in wind settle it.

### Ground

Skids are four contact points on the skid tubes with friction but no rolling. Wheeled types reuse the wheel model with a castoring tail wheel or a steered nose wheel. Slope limits are type data. Dynamic rollover emerges from the contact physics (a pivot about one skid or wheel); the warning watches one-sided contact with roll rate toward the pivot. Rooftops and ship decks need the ground query to include structures and moving surfaces (H3).

### Wind

Wind already exists (decision 143). The 8 m/s cap below 150 m is a runway accommodation for jets and would make a helicopter's low hover nearly calm in a gale. H1 replaces it for rotorcraft with a surface-layer profile (logarithmic, with roughness from land cover), and keeps `&wind=off`. Whether jets keep the cap is decided then.

### Presentation

- **Model specs.** A `rotors` list per spec (hub, axis, radius, blade count, chord, direction). The animated model spins the hub, tilts the disc by the flight model's flapping state, and crosses from blades to a translucent disc as rotor speed rises.
- **Camera.** A helicopter `ChaseRig` from the spec: closer and higher than the jet's; as airspeed drops, the camera lifts and tilts down; in the hover, free look does not spring back.
- **HUD.** A helicopter layout in `hud.ts`, built by `hudFrame.ts` from the `Airframe`: ground-plane velocity vector with an acceleration cue, radar altitude with vertical speed, torque, rotor RPM, landing zone marker, hazard cues.
- **Downwash** (H3). The particle system emits dust, snow or spray under the rotor by surface and power; near trees sway once proposal 0003's near trees exist.

## Milestones

Each milestone ends with tests, previews, Part I's acceptance checks for what it draws, and an owner checkpoint in a browser.

### H1. Rotor model and fly-by-mouse

1. Step 0: `Airframe`, `rigidBody.ts`, `contact.ts`, the Kestrel lockstep test.
2. `rotorSpec.ts` and the spec block; specs for the Little Bird and Black Hawk analogues (names and figures from public data, marked as tuning values).
3. Inflow, thrust, ground effect, flapping, hub moment, power, governed rotor speed, tail rotor, fuselage, fin and stabilizer.
4. Calibration in `tools/flight.preview.ts`: power-required curves, translational lift, hover ceilings in and out of ground effect.
5. `heloLaws.ts`, `assists.ts` with the Assisted preset, `heloDirector.ts`, a scripted helicopter test pilot.
6. Surface-layer wind for rotorcraft.
7. Fly-by-mouse with pointer lock; key bindings in the existing table.
8. Model specs with rotors, the rotor disc and blades, the helicopter camera rig, the hover HUD.
9. Free Flight: an aircraft choice on the start screen and in the URL (`&aircraft=`), helipads on airbase aprons (painted, on the graded pad), a landing zone marker at a picked point.
10. Tests: 60 s hover in ground effect within 1 m with hover hold; power at hover, bucket and maximum speed; translational lift between 15 and 25 kt; a 360° pedal turn within the type's time; hover hold in a 10 m/s crosswind; a nap-of-the-earth course at 30 m radar altitude over synthetic ridges; the director and the same recorded inputs giving the same result.
11. Owner checkpoint: take off from a pad, fly to a landing zone and land, first attempt, with mouse and keyboard.

### H2. All modes and types

Mouse aim and its in-flight switch; direct control with augmentation on and off; flight stick, throttle and twist or pedal axes through the Gamepad API (shared with P1's task); the Standard and Expert presets and every toggle in the pause menu; the remaining types (Lynx or Bo-105, Cobra, Apache, Huey, Hind with wings, Mi-8, CH-47 and Mi-26 with tandem and heavy yaw). Tests: the Lynx analogue's loop with protection off; per-type power and pedal-turn figures.

### H3. Ground and utility

Skids and wheels with type slope limits; dynamic rollover and its warning; slope and confined-area landings; rooftop contact (structures in the ground query); ship decks as moving ground where a ship is in the simulation view; sling loads (a slack-capable cable, a load with mass and drag, pickup and release) with cable tension on the HUD and the hook camera as a render-target display; hoist and fast-rope as cable-length states with crew figures; downwash particles. Tests: a slope landing at the limit and a rejected one beyond it; a sling load carried 5 km and set down within 3 m.

### H4. Hazards and damage

Vortex ring state, mast bumping, retreating blade stall, engine failure and autorotation, tail rotor loss, with the HUD's cues and envelope protection's limits; smoke, a spinning fuselage, a slowing rotor. Tests: autorotation from 300 m to a landing under the crash sink rate; mast bumping detected in a Cobra pushover with protection off and prevented with it on; recovery from vortex ring state.

### H5. Combat and AI

Fixed and turreted weapons on P4's guns, rockets and missiles; the turret following free look; gunner mode (moved here from P5); AI nap-of-the-earth routes, battle positions with line of sight through the canopy height field, pop-up attacks, landing zone approaches and sling-load deliveries, all with protection on; the campaign: helicopter missions' jump-in window extended over their ground phases, handback on the ground, and, with its own decision, any new types and mission types in the order of battle.

## Dependencies

- H1 reads "follows P1" as needing P1's framework: the shared airframe and director interfaces (step 0 builds them) and the input and gamepad plumbing. Free Flight already has a first version of both. P1's campaign tasks (promotion, jump-in, handback, the flight cap) are needed only by H5. This reading lets H1 start before P1 closes; the owner confirmed it (decision 151).
- H3's tree strikes and H5's battle positions need the canopy height field (decisions 148, 150) to reach the simulation: line of sight and tree strikes are its step 7.
- H3's ship landings need a ship in the simulation view; H5's weapons need P4; H5's jump-in needs P1's take control and hand back.

## Risks

- **Feel cannot be judged headless.** Decision 136 showed that a pilot's first flights find what tests miss. Plan an adversarial probe workflow, as for the jet, before each owner checkpoint.
- **Stiff states.** Flapping (time constants of 0.05–0.1 s) and the sling cable run inside the 480 Hz substeps; the cable may need a constraint rather than a spring.
- **Momentum theory's singular regions.** The descent branch must be continuous and deterministic, or vortex ring state and autorotation will jitter.
- **Pointer lock.** Escape releases it and the browser shows a banner; the pause menu must take over cleanly.
- **The refactor.** Step 0 touches the Kestrel's code path; the lockstep test guards it.

## Open questions, answered (decision 151)

- **Wind.** No new weather work is needed: the weather model already supplies local wind and gusts, and the forces are air-relative, so tail rotor authority and weathervaning follow. H1 should fly in wind from the start, with the surface-layer profile above in place of the jet's ground cap.
- **Engine start.** Hot starts only: every spawn has the rotor turning, and there is no start sequence.
- **Door gunners.** AI-only in H5. In the end the player can take any crew position while the AI does everything else, which generalizes crew station mode (P5): build the crew so that every seat has an AI and the player's input can replace any one of them.
- **New types.** Out of the campaign for now. Their roles when they enter it: the Little Bird for close air support and small-unit warfare (dropping troops), the Cobra as a marine attack helicopter, the Black Hawk, Huey and Mi-8 as transports, perhaps with fire support (still open).
