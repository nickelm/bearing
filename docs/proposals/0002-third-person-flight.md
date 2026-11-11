# Proposal 0002: Third-Person Flight Without Cockpits

*Drafted 2026-11-11. Status: accepted. Affects `docs/design.md`, `docs/visual-style.md`, `docs/proposals/0001-two-views.md`, and `TODO.md`.*

## Decision

Bearing models no cockpits. The player flies every aircraft and helicopter from a third-person chase camera, with the aircraft near the center of the screen. The HUD and the key cockpit displays (radar, moving map, threat warning, weapons) appear as 2D elements on screen. Spectating an AI flight and flying it use the same view: taking control changes who provides the inputs, and the screen stays the same.

The simulation remains a simulation of a specific aircraft. The player sees the world from outside, but every display shows only what that aircraft and its crew know.

## Rationale

- **Cost.** Each cockpit is a modeling, texturing, and interaction project of its own, and Bearing has more than twenty aircraft types across two factions. Without cockpits, a new type needs one exterior model, a flight model, and an avionics profile.
- **Style.** The flat-shaded, low-poly style looks best from outside, against terrain and sky. Low-poly cockpit interiors at arm's length would be its weakest point.
- **Jump-in.** Players enter missions already in flight, often minutes before contact. A chase view with clear 2D displays gives them situational awareness within seconds, where a cockpit would demand time to orient.
- **Spectator parity.** Following an AI flight from mission search and flying it become the same experience, which makes taking control and handing back seamless.
- **Browser budget.** One exterior model and a 2D overlay cost far less than a detailed interior with its own lighting and render pass.

The cost is immersion and some realism. A chase camera gives the player more awareness of the surroundings than a real pilot has, especially to the rear. We accept this advantage in a single-player game against AI.

## The Camera Rig

The camera rig becomes the most important piece of the simulation view's presentation.

- **Chase camera.** Positioned behind and slightly above the aircraft, attached through a spring-damper so the camera lags behind rolls, pitch changes, and acceleration. Lag conveys speed and maneuvering; tuning must keep the aircraft near screen center during hard turns.
- **Per-type rigs.** Each aircraft class gets its own offsets and damping: further back and looser for fast jets, closer and tighter for helicopters, further back and higher for bombers and transports.
- **Free look.** Holding a key or mouse button orbits the camera around the aircraft; releasing it springs the camera back.
- **Target camera.** Keeps both the player's aircraft and the selected target in frame, with the aircraft in the foreground. This view is essential for dogfights and attack runs.
- **Weapon camera.** Optionally follows a released missile or bomb, as picture-in-picture or full screen.
- **Terrain awareness.** The camera raycasts against the height map and never clips through terrain. At low altitude it lowers and closes in, so terrain clearance stays readable.
- **Flyby and cinematic cameras.** Used for transitions, replays, and an idle mode while spectating.

## Controls

Two control schemes share one underlying component, the **flight director**: an autopilot that turns a desired direction and speed into control inputs for the flight model.

- **Mouse aim (default).** The mouse steers an aim point in the world, the camera follows it, and the flight director flies the aircraft toward it. The keyboard handles throttle, rudder overrides, weapons, and displays. War Thunder popularized this scheme for third-person flight with mouse and keyboard.
- **Direct control.** Keyboard, mouse-as-stick, or a flight stick drive the control surfaces through a stability augmentation layer. This is the scheme for flight stick players.

AI pilots use the same flight director and the same flight model. Handback hands the flight director a new aim point from the AI's orders instead of from the mouse. This symmetry keeps the AI and the player on equal physical terms and makes handback trivial.

## Flight Model

Without a cockpit to sell realism, the flight model carries the feeling of the aircraft. It is table-driven at medium fidelity: per-type data for thrust, drag, lift, instantaneous and sustained turn rates, specific excess power, roll rate, and the effects of altitude, wing sweep, and stores. Energy management, stalls, and departures follow the tables in simplified form. The data lives in the aircraft's JSON specification, next to its geometry and avionics profile.

## HUD and Displays

### Two Kinds of Symbols

The chase camera sits behind and above the aircraft, so HUD symbols cannot simply be drawn at fixed screen positions as they would be on a real HUD. Bearing separates two kinds:

- **World-anchored symbols** are projected from the 3D scene every frame: the flight path marker (from the velocity vector, projected at a great distance so the camera offset causes no parallax), the boresight cross, the gun pipper (projected at the predicted impact point), CCIP bomb fall lines, target boxes, waypoint and target diamonds, and missile seeker circles.
- **Screen-anchored instruments** sit at fixed positions around the aircraft: airspeed and altitude tapes, a heading tape, a compact attitude indicator, Mach, G, fuel, and the master caution.

A full pitch ladder is confusing when it is seen from outside the aircraft, so a compact attitude indicator replaces it.

### Displays

| Display | Contents | Notes |
|---|---|---|
| Radar | B-scope for fighter radars, PPI for maritime and AWACS radars, with mode, range scale, and contacts | Content depends on the aircraft's radar and its mode |
| Moving map | The strategic map, centered on the aircraft, with route, threats, and front | Renders with the strategic view's renderer in a viewport, so the two views share one cartographic language |
| Threat warning | RWR display with threat symbols by bearing and type | |
| Stores | Weapons and pylons, selected weapon, quantities, chaff and flares | |
| Targeting sensor | FLIR or TV picture-in-picture from a targeting pod or gunner sight | Thermal post-process on a render target; only aircraft with such a sensor get it |
| Messages | AWACS, wingman, crew, and ground controller calls as text, later as voice | |
| Systems | Engines, fuel state, damage | Compact; expands on warnings |

### Layout and Style

The aircraft sits slightly below screen center. Tapes flank it; the radar and moving map occupy the lower corners; the threat warning sits upper right; messages sit upper left; stores sit at bottom center. Each display can be collapsed, and a minimal mode shows only the world-anchored symbols and tapes.

HUD symbology uses a single color (default green, with amber as an option) with a thin dark halo, so it stays legible against bright sky and snow. Displays use the dark translucent panels and monospaced type from the UI style, with phosphor-colored vector graphics for radar and RWR.

Implementation: a Canvas 2D overlay at device pixel ratio for HUD symbols and vector displays, the strategic renderer in a viewport for the moving map, and render targets for targeting sensors.

## Sensors and Information

Since the displays carry what a cockpit would, they must show what the aircraft knows rather than ground truth. A **sensor model** filters simulation state per aircraft:

- **Radar.** Detection depends on radar type (none, ranging only, pulse, pulse-Doppler with look-down), mode, range, target radar cross-section, aspect, terrain masking, and clutter. Stealth enters here.
- **RWR.** Detects emitting radars by bearing and type.
- **Visual.** Detection by range, size, aspect, contrast, and light conditions.
- **Datalinks and AWACS.** Contacts reported by AWACS or ground control appear with lower precision and a delay; Pact aircraft depend more on ground control, Alliance aircraft more on AWACS.
- **Targeting sensors.** FLIR and TV pods, terrain-following radar.

Avionics profiles per type define which sensors exist and how good they are. This is where aircraft differ most once cockpits are gone: an F-15 analogue sees a clean radar picture at long range, while an early MiG-23 analogue sees far less.

The sensor model also benefits the AI, which uses the same filtered information as the player.

## Crews and Roles

Two-seat aircraft keep their crews, represented by displays and callouts instead of seats.

- **AI crewmate.** In the F-111, A-6, and Su-24 analogues, an AI weapon systems officer or bombardier/navigator runs the radar and targeting sensor, manages terrain-following, and calls out threats, waypoints, and releases.
- **Crew station mode.** The player can hand the flying to the AI pilot and operate the radar, targeting sensor, and weapons themselves, still in the chase view with the targeting display enlarged. This replaces the earlier idea of taking the right-hand seat.
- **Attack helicopters.** The same split applies to pilot and gunner. Gunner mode enlarges the gunner sight display.
- **Transports and heavy helicopters.** Airdrops show a drop zone marker and release cue. Sling-load missions add a downward-looking hook camera display for pickup and placement.
- **Crew figures.** The blocky crew figures stay visible through canopies, which adds life to the chase view at low cost.

## Consequences for Models and Visuals

The player's aircraft fills the center of the screen for entire missions, so it becomes the most-viewed asset in the game.

- **Budget.** The controlled aircraft uses a higher detail level of 1,500 to 4,000 triangles, still flat-shaded. Other aircraft keep the budgets in `docs/visual-style.md`.
- **Animated parts.** Ailerons, elevators or stabilators, rudders, flaps, slats, airbrakes, and speedbrakes respond to control inputs. Swing wings (F-111, F-14, Tornado, Su-24, MiG-23, and Tu-22M analogues) animate with speed, which pays off strongly in a third-person view. Afterburner nozzles open and glow. Helicopter rotors blur into discs.
- **Stores.** Weapons hang visibly on pylons and disappear as they are released. Fuel tanks can be jettisoned.
- **No landing gear animation.** Takeoff and landing stay with the AI, so gear only needs to exist on parked and AI-controlled aircraft.
- **Effects.** Vapor and wingtip vortices at high G, contrails at altitude, heat shimmer behind engines, dust and spray at very low level, rotor wash for helicopters, smoke, fire, and missing parts for damage.
- **Shadow.** The aircraft's shadow on terrain is a key height cue at low level and must stay visible down to the ground.
- **Model specification.** The JSON format for procedural aircraft gains hinge axes for control surfaces, pivots for swing wings, store stations, nozzles, light positions, crew figure positions, and the camera rig offsets.

## Changes to Existing Documents

**`docs/design.md`**

- *Vision* and *Decisions So Far:* state that flying happens in a third-person chase view without cockpits, with HUD and displays as 2D overlays.
- *Architecture:* the *Full* fidelity level means "the aircraft the player controls or follows", with the flight model, sensor model, and flight director.
- *Time:* rename the cockpit cap to the **flight cap**: while the player controls an aircraft, acceleration is limited to cruise phases (up to 8×) and cancels on any threat.
- *Factions and Sides:* replace the side-by-side cockpit paragraph with the crew station description above.
- *Non-goals* and *Later:* replace "cockpit flight" with "player flight control, HUD, and displays".

**`docs/visual-style.md`**

- *Part I:* add a section on the controlled aircraft's detail level, animated parts, and effects, and a section on HUD and display styling.
- Replace "The player's own aircraft in a future cockpit view may exceed these budgets" with the controlled-aircraft budget above.
- Add acceptance checks: HUD legible against bright sky, snow, and night; the flight path marker and gun pipper stay accurate during hard maneuvers; the aircraft stays readable and centered in a maximum-rate turn; the camera never clips terrain during low-level flight through valleys.

**`docs/proposals/0001-two-views.md`**

- *Simulation View:* entry happens by following or jumping into a unit, both in the same chase view. The observer camera at bases and ships remains.

## Roadmap Changes

The tech demo includes the camera rig and a read-only HUD for followed flights, since milestone V4 already provides a chase camera. Player flight control comes after the demo.

**Extended demo milestone**

- **V4. Transition, camera rig, and spectator HUD.** Follow a flight from mission search into the simulation view and back. Chase camera with per-type rigs, free look, and terrain avoidance. Read-only HUD with flight path marker, tapes, and heading for the followed aircraft.

**New post-demo track: Piloting (P)**

- **P1. Flight model and controls.** Table-driven flight model, flight director shared with the AI, mouse-aim and direct schemes, flight stick support through the Gamepad API, take control and hand back.
- **P2. HUD and display framework.** Canvas overlay, layout system, world-anchored and screen-anchored symbology, message log, collapsible displays.
- **P3. Sensors and displays.** Sensor model, avionics profiles, radar, RWR, moving map from the strategic renderer, stores display.
- **P4. Weapons.** Guns with lead-computing pipper, air-to-air missiles, bombs with CCIP and CCRP, target and weapon cameras, damage states.
- **P5. Crews and special roles.** AI crewmate and callouts, crew station mode, attack helicopter gunner mode, targeting sensor display, airdrop and sling-load tools with the hook camera.

**Updated dependencies.** P1 depends on V4. P2 depends on P1. P3 depends on P2 and S4. P4 and P5 depend on P3.

## Open Questions

- **Free look in combat.** Should free look be limited while the player is in combat, so the chase view gives less of an advantage, or left unrestricted?
- **HUD color.** Green for both factions, or green for the Alliance and a different hue for the Pact, as a subtle cue for the side being flown?
- **Voice.** Text-only messages at first, or early voice callouts with synthesized speech?
- **Minimal mode.** Should a "clean" mode exist that hides all overlays for screenshots and spectating?