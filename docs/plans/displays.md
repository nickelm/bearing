# Plan: Displays, status strip, master modes and AI crew (P2, P3, P5, P6)

_Drafted 2026-11-16 for [proposal 0006](../proposals/0006-displays-and-crew.md) (decision 189). The tasks are in `TODO.md` under the piloting track; later decisions record what each milestone changes. Nothing is implemented yet._

## Goal

One display system for every aircraft and helicopter: a HUD for what the pilot needs while looking outside, docked displays for sensor pictures and configuration, and a status strip for discrete states, all reconfigured together by master modes. Every format draws from a serializable display model of the sensor-filtered picture, so an AI crewmate, a second window and a tablet work through the same commands as the player. Free Flight is the test bed for P2 and most of P3, as it is for track H.

## What exists

| Area                                                    | State                                                                                                                                                                                                                                                                                                        | Where                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| HUD                                                     | Canvas 2D at device pixel ratio; world-anchored flight path marker, boresight, runway outline; tapes, attitude, G, α and indexer, throttle and afterburner stage, fuel, gear, speedbrake and brake states, landing aid, messages, warnings; the helicopter layout with hover symbology, torque and rotor RPM | `ui/flight/hud.ts` (decisions 135, 159, 160)                  |
| HUD frame                                               | `HudFrame`, built each frame without the DOM, so tools draw it headless                                                                                                                                                                                                                                      | `freeflight/hudFrame.ts`, `freeflight/heloHud.ts`             |
| Warnings                                                | gear speed, tail strike, stall, pull-up; helicopter hazards (VRS, mast bumping, rollover, low RPM)                                                                                                                                                                                                           | `sim/flight/outcomes.ts`, `ui/flight/hud.ts`                  |
| Input                                                   | One remappable binding table (`FLIGHT_BINDINGS`), keyboard stick, mouse as stick, simplified mouse aim, pointer lock for helicopters; Shift and Ctrl are the throttle                                                                                                                                        | `ui/flight/flightInput.ts`, `ui/flight/heloInput.ts`          |
| Panels and cards                                        | Start screen, pause menu, summary cards in HTML and CSS                                                                                                                                                                                                                                                      | `ui/flight/freeFlightMenu.ts`, `flightCards.ts`, `flight.css` |
| Strategic scene                                         | Resident in Free Flight (the start screen's map); one camera, drawn to the main canvas                                                                                                                                                                                                                       | `render/strategic/strategicScene.ts`                          |
| Terrain tiles                                           | Resident around the chase camera, vertices through the one height function (rule 13)                                                                                                                                                                                                                         | `render/sim/terrain/`, `worldgen/edits/`                      |
| Air war types                                           | Every type has a role, a reference type and a crew count (the F-21 Kestrel is an F-16C analogue, crew 1)                                                                                                                                                                                                     | `sim/air/aircraft.ts`                                         |
| Sensor model, avionics profiles, stores, weapons, crews | None                                                                                                                                                                                                                                                                                                         | –                                                             |
| HUD previews                                            | Composites of the HUD, cards and session without WebGPU                                                                                                                                                                                                                                                      | `tools/hud/`                                                  |

## How the plan reads the proposal

These readings shape the plan; decision 189 lists them for the owner to confirm.

1. **Torque and rotor RPM leave the HUD** for the torque and rotor gauges at the end of the status strip, as the format table and the hover master mode say. The rest of the hover symbology stays on the HUD: the ground-plane velocity vector with its acceleration cue, radar altitude with vertical speed, ground speed and the landing zone marker. Rotor RPM's prominence in autorotation becomes a highlighted gauge plus the HUD's LOW RPM warning (reading 2).
2. **Time-critical warnings stay on the HUD.** Warnings that demand an immediate maneuver (PULL UP, STALL, tail strike, the sink cue, and the helicopter hazard cues such as VRS, MAST BUMP, ROLLOVER and LOW RPM) are "spatial and time-critical"; system cautions and warnings (gear speed, gear up while slow and low, low fuel, bingo, failures) and the master caution go to the strip.
3. **The throttle readout stays on the HUD.** A keyboard throttle has no feel, so the lever's position and its detent are time-critical while looking outside. The afterburner moves to the strip as a discrete state.
4. **Fuel leaves the HUD** for the engines and fuel format, with JOKER, BINGO and LOW FUEL on the strip. P2 builds that format early, since Free Flight needs it the day the HUD loses fuel; P3 completes it with engine states, damage and failures.
5. **Avionics state belongs to the simulation; display state to the UI.** Anything that changes what the aircraft does, senses, emits or releases (master mode, master arm, radar mode and range, the radar cursor, locks, designations, selected stores, fuzing, terrain-following clearance, countermeasure programs) lives in `sim/avionics/`, changed only by avionics commands. Anything that changes only what the screen shows (slot states, pins, the format in a slot, the map's range and orientation, declutter) lives in `ui/displays/`. A bezel button maps to one or the other. The AI crewmate and AI pilots issue the same avionics commands, never touch the UI, and so stay headless and deterministic (rules 5, 6, 12).
6. **One capture key for every aircraft** (decision 193, replacing the software cursor first planned here). Tab grabs and frees the pointer lock in the jet and the helicopters; a click on the view also grabs it, and Escape frees it and pauses. A free mouse is cursor mode: the real cursor clicks the displays, and the flight director holds what the mouse last commanded. The capture toggles on a key press, because a key release is no user gesture and a press's activation lapses after about 5 s.
7. **Keys only for hot actions** (decision 193). Bezel buttons and strip items work by mouse; single keys go to the actions a pilot needs without looking (master modes, dogfight, slot expand and collapse, master caution, map range, radar lock, step and break, designation, countermeasures, weapon selection, the crew menu with digits while it is open). No modifier-plus-digit scheme for the bezel, which also sidesteps the browsers' reserved digit chords.
8. **The moving map goes below the strategic zoom floor.** The strategic renderer draws a top-down map in a render target at ranges from 10 to 160 nm, with the region band's content magnified below the floor. It draws no individual trees or buildings (rule 11). Elevation mode reads the simulation view's resident terrain tiles, whose vertices already pass through the one height function (rule 13), and the global grid beyond them.
9. **Map overlays come from the side's picture.** Terrain, settlements, roads and airbases are a priori map data. The front line, threat rings and contacts come from the side's intelligence picture and the aircraft's sensor and datalink tracks, never from ground truth (rule 12).
10. **P2 starts in Free Flight before P1 closes**, as H1 did (decision 151): it needs Free Flight's HUD, input and session, not P1's campaign tasks.
11. **The hook camera is built by whichever of H3 and P5 comes first**, as a format on P2's display frame. H3's sling-load task therefore depends on P2's frame. The gunner sight is the targeting pod format slaved to a turret, so H5's gunner mode builds on P5's targeting pod format.
12. **All seven master modes exist in P2**, selectable by key. Air-to-air, dogfight and air-to-ground show their formats and symbology as P3 and P4 supply them; their automatic triggers wait for weapons (P4).
13. **Proposal 0002's minimal mode** becomes the hidden slot state plus the HUD's declutter levels. The design's _clean mode_ question (hide everything for screenshots) stays open.
14. **Preset edits are per viewer.** A player's edits to the master modes' slot presets are saved in browser storage, wrapped so a private window or blocked storage falls back to the defaults.

## Architecture

### Layers

```
sim/avionics/   AvionicsState per aircraft, AvionicsCommand, apply(state, cmd), avionics profiles
sim/sensors/    (P3) the sensor model: per-aircraft SensorPicture (radar, RWR, visual, datalink)
sim/crew/       (P5) crewmates: role, owned formats, tasks, callouts; act through AvionicsCommand
      │
      ▼  AircraftSnapshot: own ship + avionics + stores + systems + sensor picture (plain data)
ui/displays/    DisplayState, DisplayCommand, formats (snapshot, state) → DisplayModel,
                layout, master modes, status strip rules, bindings, cursor
ui/displays/draw/  HTML and CSS chrome, Canvas 2D scopes, render-target screens
```

- **`AircraftSnapshot`** is the only thing a format reads: plain, structured-clone-able data (no class instances), built once per frame for the controlled or followed aircraft. It holds the sensor-filtered picture, never ground truth (rule 12). A test serializes snapshots and display models through `structuredClone` and JSON, which is what P6 needs.
- **Formats** are pure functions `format(snapshot, displayState) → DisplayModel`. A display model holds the 20 bezel buttons (label, state, enabled, the command each issues), the owner tag, and the screen's content as primitives: vector items for scopes (lines, arcs, symbols, text at screen-square coordinates), a map description (center, range, orientation, mode, overlay items), or a reference to a render-target screen. No DOM, canvas or three.js in a model, so tests snapshot them.
- **Commands.** A `DisplayCommand` is either an avionics command, sent to the simulation, or a UI command that changes `DisplayState`. Keys, clicks, the crewmate and later a companion all produce commands; nothing else changes either state.
- **Avionics profiles** join the model spec beside the `flight` and `rotor` blocks (decision 106): the slots used, the formats each slot may show, the systems behind them (radar type, RWR, datalink receiver, pod, terrain-following radar), the faction skin, the era bezel, crew roles and their default formats. `rotorSpec.ts`'s pattern applies: parse, validate, test.

### Layout

A pure function `layout(viewport, uiScale, profile) → SlotRects`. Large slots are squares about 28% of the viewport height, docked lower left and lower right; small slots upper left and upper right; the strip at bottom center below the aircraft; the middle 60% stays clear. The rects depend on the viewport and the UI scale only, never on the master mode or the aircraft, which is what the layout snapshot test checks. The HUD's tapes move inward if a 16:10 or 4:3 viewport would put them under a slot.

### The display frame

HTML and CSS, one element per slot over the WebGPU canvas: the bezel with 20 option-select buttons (five per side, numbered clockwise from the top left, as in the F-16), the labels drawn on the screen beside them, the owner tag, the focus ring and the alert highlight. Skins are CSS variables (Part I, _Displays and Status Strip_); era bezels are a second frame shape with the same buttons. Expanded, collapsed (a labeled tab at the slot's edge) and hidden states, with 300 ms fades and expansions that grow toward the screen edge, never across the central area.

Screens draw in one of three ways:

- **Scopes** (radar, threat warning, stores, engines and fuel, comms, mission, crew, messages): a Canvas 2D element per expanded display at device pixel ratio, redrawn at the format's update rate, not every frame.
- **Map, targeting pod and hook camera**: a render target, drawn by the renderer into the WebGPU canvas under the slot's rect after post-processing, with the HTML screen left transparent above it; the format's overlay items draw on a canvas on top. No readback.
- **Strip gauges**: small canvases in the strip.

### The moving map

- **Strategic mode.** `StrategicScene` drawn by a second, top-down camera into a render target at 2 Hz (5 Hz below 20 nm), larger than the display by the diagonal, so track-up rotation and own-ship motion between refreshes are a texture transform each frame. Ranges 10, 20, 40, 80 and 160 nm. Labels and glyphs come from the band the range falls in; below the zoom floor the region band magnifies.
- **Elevation mode** (P3). The simulation view's resident terrain tiles drawn again from an orthographic camera above the aircraft with an elevation material: hypsometric tints, contours every 100 m (or 500 ft in Alliance skins) from the height's fraction, and spot heights from the named peaks and the highest sample per map cell. The relative sub-mode takes the aircraft's altitude as a uniform: terrain above it red with a hatch, within 500 ft below amber, the rest plain shading. The hatch keeps the red and amber apart for deuteranopes (Part II check 4's method). Beyond the resident tiles the global grid fills in.
- **Overlays** (both modes): own ship, route and waypoints, range rings, bullseye, the front line and threat rings from the side's picture, datalink tracks; Free Flight shows airbases and the destination runway.

### Master modes

A pure state machine `nextMode(mode, previous, snapshot, event) → mode` with the proposal's triggers: ground on weight on wheels; approach with the gear down below 3,000 ft; hover below 20 kt in a helicopter; navigation otherwise; air-to-air and air-to-ground when a weapon of that kind is selected (P4); dogfight by key, returning to the previous mode. A short hysteresis keeps a touch-and-go or a hover at 20 kt from flickering. Each mode carries a preset: HUD declutter level, the format and state per slot, the strip's emphasis. Pins override the preset per slot. Mode and pins are display state, except the master mode itself, which is avionics state, since it changes weapon and radar behavior.

### Status strip

Items are rules over the snapshot: `stripItems(snapshot, mode) → StripItem[]`, each with a label, a shape (rounded for normal, a notched rectangle for cautions, a triangle-capped one for warnings), a level (green, amber, red), whether it flashes, and the command a click issues. The dark cockpit holds: an empty list in normal cruise. The first items come from Free Flight: GEAR (down, transit, up when slow and low), PARK BRK, BRAKES, SPD BRK, AB, the control mode when it is not the default, HOVER HOLD and ALT HOLD, JOKER, BINGO, LOW FUEL, GEAR SPEED, the conflicts the proposal names (speedbrake with afterburner, parking brake with throttle), and the master caution, which acknowledges and silences the active cautions. Helicopters end the strip with the torque and rotor gauges (torque, rotor RPM, power margin) at 10 Hz.

### Cursor mode and bindings

`MouseCapture` (`ui/flight/mouseCapture.ts`, decision 193) owns the pointer lock for every input: Tab toggles it, a click on the view grabs it, a lock the browser drops (Escape, lost focus) pauses, and a refused grab is retried four times within the press's activation. While the mouse is free, the jet's mouse stick and aim point hold where they were and the helicopter's mouse commands stop, so hover hold takes over when it is slow (Assisted preset); the HUD shows TAB TO FLY. The wheel over a display changes its range or zoom. Each format lists its hot actions, and those are named entries in the binding table; a test enumerates them against the table. Bezel buttons need no keys. With a flight stick the mouse stays free.

### Crew (P5)

- **`sim/crew/`.** A crewmate per crewed seat of the controlled or followed aircraft: role, owned formats, a task from the command menu or its role's default, and a behavior per role that reads the sensor picture and issues avionics commands with the delays and errors that crew skill sets. Skill comes from the squadron's experience and morale (added to the order of battle if it lacks them). Randomness from a fork of the aircraft's stream, so a crewmate's work is the same at every time rate (rule 5).
- **Ownership** is simulation state, since the crewmate must know what it may touch. Using a format takes it; the crew menu hands it back. The bezel shows the owner.
- **Callouts** are events with a priority (launch over lock over threat over contact over waypoint over fuel over task results) into one queue, shown in the messages slot; a higher priority interrupts a lower one. Voice, when it comes, speaks the same queue.
- **The crew command menu** is a radial menu in HTML with numbered entries; its entries per role are data.
- **Crew station mode** is format ownership with the AI pilot flying: the player owns the sensor formats, and the AI pilot flies through the same director (rule 12).

### Budgets

All displays together under 2 ms of CPU per frame at default rates (the proposal), measured in the browser smoke test. GPU: the map's render target at 2–5 Hz and a visible pod or hook camera at frame rate draw at reduced quality (no volumetric march for the map; the pod at a quarter of the resolution, with clouds); the quality governor (decision 143) counts them. A target for the GPU cost is set after the map spike.

## Milestones

Each milestone ends with tests, previews, Part I's acceptance checks for what it draws (checks 7 and 12–14), and an owner checkpoint in a browser.

### P2. HUD, displays and status strip

1. Spike and capture key (done, decision 193): pointer lock grabbed and freed by Tab in both aircraft kinds, retries, pause on a lost lock; the jet's mouse modes under pointer lock. Open: Firefox and Safari, and Escape in a real browser.
2. Allocation inventory: every item of Free Flight's HUD classified by the rule (the table below) and recorded with the decision that closes P2.
3. `layout()` with the slot rects, the UI scale, and the layout snapshot test (done, decision 195; the slots over the HUD in `docs/reports/screens/hover-transition-slots-*.png`). Before it, decision 195 also made a captured mouse fly the jet.
4. Display model types, `DisplayCommand`, `DisplayState`, the format registry, and the serialization test (done, decision 199; steps 5–10, 12 and 13 too, with the notes there).
5. `sim/avionics/`: state, commands, `apply`, and avionics profiles in the specs of the Kestrel, the Wren and the Buzzard, with validation.
6. The display frame in HTML and CSS: bezel, 20 buttons, labels, owner tag, focus, slot states and transitions; Alliance and Pact skins as CSS variables; the round era bezel.
7. The status strip: item rules, levels, shapes and labels, clicks and keys, the master caution; the helicopter gauges.
8. Master modes: the state machine, presets, pins, per-viewer preset edits; HUD declutter levels.
9. Cursor mode with the displays (clicks on bezel buttons and strip items with the free cursor; the wheel over a display); the hot-action bindings and their enumeration test; the help overlay lists them.
10. Messages format in the messages slot (Free Flight's messages move there; session cards stay).
11. Moving map, strategic mode: the render target, ranges, north-up and track-up, own ship, airbases, the destination runway, range rings. (Done but the overlays, decision 201: the picture is read back into the display's canvas instead of drawn into the WebGPU canvas under the slot.)
12. Engines and fuel format, first version: fuel state, joker and bingo (reading 4).
13. Retrofit Free Flight: states, fuel, messages, torque and rotor RPM leave the HUD; the HUD follows the master mode.
14. Tests: master mode transitions and pins; strip items in scripted Free Flight scenarios (gear up slow and low, speedbrake with afterburner, parking brake with throttle, hover hold); display model snapshots.
15. Previews: `tools/hud/` composites with the displays and strip for the Kestrel and a helicopter in each master mode; `tools/freeflight.screens.mjs` shots; the browser smoke test checks that displays and strip exist and measures their CPU time.
16. Acceptance checks 7, 12 and 13; owner checkpoint. (12 and 13 as `tools/displays.screens.mjs`, decision 200, with the UI scale and saved layouts; the moving map, step 11, is what remains.)

### P3. Sensors and formats

1. Sensor model in `sim/sensors/`: radar by type, mode, range, radar cross-section, aspect, terrain masking and clutter; RWR; visual detection; datalink and AWACS tracks with lower precision and a delay; deterministic, with tests. The AI reads the same picture.
2. Avionics profiles for every type of the air war's table, with their display complements (the proposal's examples as the first cases).
3. Free Flight targets: scripted traffic and emitters (an option on the start screen), since Free Flight has no war to sense.
4. Air-to-air radar: B-scope with range-while-search, track-while-scan, single-target track and dogfight sub-modes, designation cursor, coverage, contact altitude and aspect, datalink tracks.
5. Threat warning: RWR symbols by bearing and type, lock and launch.
6. Air-to-ground radar: ground map, moving-target mode, the terrain-following scope for the F-111 and Su-24 analogues.
7. Stores: pylons and weapons, selection, fuzing, release mode, quantity and ripple, jettison, countermeasure programs (the release itself is P4's).
8. Engines and fuel, complete: engine states, damage and failures. Comms: channels, AWACS and controller calls, wingman commands, ATC, history.
9. Moving map, elevation mode with the relative sub-mode; datalink tracks and threat rings on both modes.
10. The Su-27 analogue's HUD-integrated radar.
11. Tests: every aircraft shows only its profile's formats in its profile's slots; display model snapshots (radar with tracks, stores after a scripted release, datalink fallback when the receiver loses its source); relative elevation colors in scripted low-level scenarios.
12. Acceptance checks 12–14 for a fighter and a strike aircraft; owner checkpoint across aircraft with very different avionics.

### P5. Crews and special roles

1. `sim/crew/`: crewmates, ownership, tasks, skill, callouts and their priority queue.
2. The crew command menu and the crew format.
3. The six roles: radar intercept officer, weapon systems officer, bombardier/navigator, copilot/gunner, crew chief, loadmaster.
4. Targeting pod format: FLIR white-hot and black-hot, TV, zoom, point and area track, laser arm and fire, from a render target with a thermal post-process.
5. Hook camera format, unless H3 built it (reading 11); airdrop format with the drop zone marker and release cue.
6. Crew station mode through ownership.
7. Headless scenario tests: a crewmate locks a contact, designates a ground target, and guides a sling load.
8. Blocky crew figures through canopies.
9. Acceptance checks 12–14 for a crewed strike aircraft and a transport helicopter; owner checkpoint of crew station and airdrop sorties.

### P6. Companion displays (later)

1. A display in a second window, synced through a `BroadcastChannel`: display models out, commands back.
2. A companion page for a tablet or phone, paired peer-to-peer by WebRTC with the offer and answer exchanged through QR codes (no server, rule 8), or an optional public signaling broker.
3. Render-target screens on a companion: the map from its display model drawn by a light 2D renderer, or the render target sent as compressed frames at 2 Hz; decided when P6 starts.

## Allocation of Free Flight's HUD

| Item                                                                                                                | Now | Under the rule                                                           |
| ------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------ |
| Flight path marker, boresight, runway outline and aim point                                                         | HUD | HUD                                                                      |
| Airspeed, Mach, altitude, radar altitude and heading tapes; compact attitude; G; α and indexer                      | HUD | HUD                                                                      |
| Landing aid: distance, bearing, localizer and glideslope                                                            | HUD | HUD (approach symbology)                                                 |
| Throttle and its detent                                                                                             | HUD | HUD (reading 3)                                                          |
| Afterburner stage                                                                                                   | HUD | Strip                                                                    |
| Fuel                                                                                                                | HUD | Engines and fuel format; JOKER, BINGO, LOW FUEL on the strip (reading 4) |
| Gear, speedbrake, brakes, parking brake                                                                             | HUD | Strip                                                                    |
| Control mode                                                                                                        | HUD | Strip, when not the default                                              |
| PULL UP, STALL, tail strike, the sink cue                                                                           | HUD | HUD (reading 2)                                                          |
| GEAR SPEED                                                                                                          | HUD | Strip                                                                    |
| Messages (airborne, touchdown, crash reasons)                                                                       | HUD | Messages slot                                                            |
| Helicopter velocity vector, acceleration cue, landing zone marker, radar altitude with vertical speed, ground speed | HUD | HUD                                                                      |
| Torque and rotor RPM                                                                                                | HUD | Strip gauges (reading 1)                                                 |
| Hover hold and altitude hold tags                                                                                   | HUD | Strip                                                                    |
| VRS, MAST BUMP, ROLLOVER, LOW RPM                                                                                   | HUD | HUD (reading 2)                                                          |
| F3 debug panel                                                                                                      | HUD | Outside the rule: a developer tool                                       |

## Dependencies

- P2 depends on Free Flight's HUD, input and session, and may start before P1 closes (reading 10). P3 depends on P2 and S4; P4 on P3; P5 on P3, and on P4 for the gunner's and the weapon systems officer's releases; P6 on P3.
- H1's retrofit of torque and rotor RPM lands with P2's step 13. H3's hook camera needs P2's frame; H5's gunner mode needs P5's targeting pod format (reading 11).
- Spectator displays (open question 3) need V4's follow and P3's sensor model running for the followed aircraft, which full fidelity already covers.

## Risks

- **Browser input.** Pointer lock was probed in Chromium only (decision 193); Firefox and Safari may differ in rate limits and in how Escape reaches the page.
- **GPU budget.** The map and the pod add render passes to a frame already near its budget over forest and in weather; low update rates, reduced quality and the governor contain it, and the browser smoke test measures it.
- **The strategic map below its floor.** The base map's textures come from the 1.5 km global grid, which may look blocky at 10 nm on a 400-pixel display. If it does, strategic mode stops at 20 nm and elevation mode serves the short ranges.
- **HTML over the canvas.** The browser smoke test on lavapipe reads the scene back through the device, and its page screenshots show the HTML over an empty canvas; the display checks need both composited.
- **Small screens.** At 1366 × 768 a large slot is about 215 pixels square; the type and the 20 buttons must stay legible there (check 13), or the UI scale's default rises.
- **Scope.** P3 holds seven formats and the sensor model; it may split into P3a (sensor model, radar, threat warning) and P3b (the rest).

## Open questions, with recommendations

- **Voice.** Text first in P5. Callouts are data with a priority and a short phrase, so a voice layer can speak them later; synthesized speech varies by platform, and recorded voice would be the first sound files in a game whose audio has none (decision 142).
- **Single-seat help.** A light assistant as avionics assists, each a toggle and on by default, as for the helicopters (decision 149): the radar's mode follows the master mode, dogfight mode locks the nearest contact in the boresight. Switching an assist off removes help, never a capability. No crewmate persona and no callouts beyond the warnings.
- **Spectating.** Yes, read-only: the displays show the followed aircraft's own picture (spectator parity, proposal 0002). Display-state commands (slot, range, format) work; avionics commands do not until the player takes control, which keeps the display state as it was.
