# Proposal 0006: Displays, Status Strip, Master Modes, and AI Crew

*Drafted 2026-11-16. Status: accepted 2026-11-16 (decision 189). Affects `docs/design.md`, `docs/visual-style.md`, `docs/proposals/0002-third-person-flight.md`, `docs/proposals/0004-helicopter-flight.md`, `TODO.md`, and `CLAUDE.md`. The implementation plan is [docs/plans/displays.md](../plans/displays.md).*

## Decision

Bearing stays third-person with a HUD overlay. Cockpit functions that do not need to be heads-up move into a small set of standardized **multifunction displays (MFDs)** docked at the screen edges, plus a **status strip** for discrete states. **Master modes** reconfigure the HUD and the displays together, the way they do in fourth-generation fighters. Displays have clickable buttons; a **cursor mode** frees the mouse to use them. Two-seat aircraft and helicopters get an **AI crewmate** the player commands, in the spirit of Jester and George in DCS.

This proposal replaces the *Displays* and *Layout and Style* sections of proposal 0002.

## Allocation Rule

Every piece of information lives in exactly one of three places:

| Location | Content | Examples |
|---|---|---|
| HUD | Spatial and time-critical information used while looking outside | Flight path marker, pipper, target boxes, steering cues, speed and altitude tapes, heading, hover velocity vector |
| Displays | Sensor pictures, selection, configuration, planning | Radar, stores, moving map, targeting pod, comms, fuel |
| Status strip | Discrete states and warnings | Gear, brakes, speedbrake, master arm, afterburner, autopilot, countermeasures, master caution |

When a new item is proposed, the rule decides its place. If it fits nowhere, it probably belongs in a display format.

## Standardization

Players switch aircraft often, so the interface stays familiar across types, while each aircraft keeps its own equipment:

- **Same places and bindings.** Each slot has one fixed position and one set of key bindings for every aircraft and helicopter. An aircraft may leave slots empty, but it never moves them.
- **Same formats everywhere they exist.** A format has the same layout and buttons in every aircraft that carries it. A stores display looks the same in an A-6 analogue and a MiG-27 analogue.
- **Different complements.** The avionics profile decides which displays and formats an aircraft has. An aircraft without radar has no radar format, and an older type may have only one large display.
- **Factions differ in skin**, as described under *Styling*.

## Layout

### Slots

Docked slots only; no free-floating windows.

| Slot | Position | Size | Default use |
|---|---|---|---|
| Left MFD | Lower left | Large | Moving map or stores |
| Right MFD | Lower right | Large | Radar or targeting pod |
| Threat | Upper right | Small | Threat warning |
| Messages | Upper left | Small | Comms log and crew callouts |
| Status strip | Bottom center, below the aircraft | Strip | Discrete states |

These are the maximum slots. Each aircraft's avionics profile lists which slots it uses and which formats each slot can show. Unused slots stay empty and leave the screen clearer.

### Display Complements

Examples of how complements differ:

| Aircraft class | Left MFD | Right MFD | Threat | Notes |
|---|---|---|---|---|
| Air superiority fighter (F-15, Su-27 analogues) | Moving map, stores, engines | Air-to-air radar | Yes | Su-27 analogue adds the HUD-integrated radar |
| Multirole fighter (F-16 analogue) | Moving map, stores, engines | Air-to-air radar, air-to-ground radar, targeting pod | Yes | Full complement |
| Early fighter (MiG-23 analogue) | None | Air-to-air radar in a round scope bezel | Yes | Navigation on the HUD only |
| Strike aircraft with crew (F-111, A-6, Su-24 analogues) | Moving map, stores | Air-to-ground radar, terrain-following scope, targeting pod | Yes | Crewmate owns the right MFD by default |
| Attack aircraft (A-10, Su-25 analogues) | Moving map, stores | Targeting pod (where fitted) | Yes | No radar; datalink tracks on the moving map if equipped |
| Attack helicopter (Apache, Hind analogues) | Moving map, stores | Gunner sight | Yes | Torque and rotor gauges in the status strip |
| Transport helicopter (Black Hawk, Mi-8 analogues) | Moving map | Hook camera | Yes | Crew chief callouts |
| Transport aircraft | Moving map | Airdrop | Optional | Loadmaster callouts |

The central area, roughly the middle 60% of the screen, belongs to the aircraft and the HUD. A large slot is about 28% of the screen height at default scale; a UI scale setting adjusts all slots together.

### Slot States

Each slot is **expanded**, **collapsed** to a small labeled tab at its edge, or **hidden**. Clicking a tab, or pressing its key, expands it.

### Stability Rules

1. **Slots never move.** Mode changes swap a slot's format or change its state; they never relocate it.
2. **Pins beat automation.** A pinned slot keeps its format and state in every master mode.
3. **Alerts may claim a slot.** A radar lock, missile launch, fuel warning, or crew call can bring a format forward in its usual slot, with a highlight on the bezel.
4. **Calm transitions.** Fades and expansions take about 300 ms, and no transition flashes or slides through the central area.

## Master Modes

| Mode | Entered | HUD | Left MFD | Right MFD | Threat | Status strip |
|---|---|---|---|---|---|---|
| Ground | On the ground | Minimal, plus runway and taxi cues | Moving map | Collapsed | Collapsed | Brakes, gear, engines |
| Navigation | Default airborne | Navigation symbology, steering to waypoint | Moving map | Collapsed or radar | Expanded | Dark unless abnormal |
| Air-to-air | Air-to-air weapon selected, or key | Air-to-air symbology, target boxes | Moving map | Air-to-air radar | Expanded | Master arm, countermeasures |
| Dogfight | Override key | Gun and short-range missile symbology only | Collapsed | Collapsed | Expanded | Master arm, countermeasures |
| Air-to-ground | Air-to-ground weapon selected, or key | CCIP or CCRP cues, target designation | Stores | Targeting pod or air-to-ground radar | Expanded | Master arm, countermeasures |
| Approach | Gear down below 3,000 ft, or key | Approach symbology, landing aids | Moving map | Collapsed | Collapsed | Gear, speedbrake, flaps |
| Hover (helicopters) | Below about 20 knots | Hover symbology | Moving map | Hook camera or gunner sight | Expanded | Torque, rotor RPM, hover hold, gear, hook |

The player can always select a mode with a key. Automatic entry follows the triggers above, and leaving dogfight mode returns to the previous mode. Each mode's slot assignments are a preset that the player can edit once; the edit then applies to every aircraft.

## Status Strip

The status strip follows the **dark cockpit** principle: in normal flight, nothing lights up.

- Items appear only when relevant: the parking brake on the ground, the gear on approach or when down, the speedbrake while extended, master arm when armed, afterburner while lit.
- Items warn when a state conflicts with the situation: gear up while slow and low, speedbrake out with afterburner, parking brake set with throttle advanced.
- Colors follow annunciator conventions: green for normal states that matter now, amber for cautions, red for warnings. Every item also carries a short text label and a distinct shape, so color is never the only cue.
- Items are clickable in cursor mode and mapped to keys. Clicking the gear item raises or lowers the gear.
- A master caution light acknowledges and silences active cautions.

## Display Frame and Formats

### Frame

Every display uses one frame: a square screen with option-select buttons along the bezel. Each format labels its buttons on screen next to them. Buttons work by mouse in cursor mode and by keys: a modifier plus a number selects a bezel button on the focused display, and a key cycles display focus.

### Formats

| Format | Contents | Update rate |
|---|---|---|
| Air-to-air radar | B-scope; range-while-search, track-while-scan, single-target track, and dogfight sub-modes; designation cursor; elevation and azimuth coverage; contact altitude and aspect; datalink tracks | 10 Hz |
| Air-to-ground radar | Ground map, moving-target mode; terrain-following scope for the F-111 and Su-24 analogues | 5 Hz |
| Stores | Pylons and weapons, selection, fuzing, release mode (CCIP or CCRP), quantity and ripple, jettison, countermeasure programs | On change |
| Moving map | Full-color map with route and waypoints, front line, threat rings, datalink tracks, bullseye, and range rings, in two modes (see below) | 2–5 Hz |
| Targeting pod | FLIR in white-hot or black-hot, or TV; zoom; point and area track; laser arm and fire | Frame rate when visible |
| Threat warning | RWR symbols by bearing and type, lock and launch indications | 10 Hz |
| Comms | Radio channels, AWACS and controller calls, wingman commands, ATC, message history | On change |
| Engines and fuel | Fuel state, joker and bingo, engine state, damage and failures | 2 Hz |
| Mission | Objectives, time on target, timeline, package members | On change |
| Crew | Crewmate role, current task, owned formats, command menu | On change |
| Hook camera (helicopters) | Downward view for sling loads, with load position and cable tension | Frame rate when visible |
| Torque and rotor (helicopters) | Compact gauges for torque, rotor RPM, and power margin, shown at the end of the status strip rather than in an MFD slot | 10 Hz |

### Moving Map Modes

The moving map has two modes, switched with a bezel button:

- **Strategic mode** uses the strategic view's illustrated rendering: biome colors, relief, settlements, roads, rivers, and labels. It suits navigation and situational awareness.
- **Elevation mode** colors terrain by height, with contour lines and spot heights. A **relative** sub-mode colors terrain against the aircraft's own altitude: red where terrain rises above the aircraft, amber within 500 ft below it, and plain shading where it lies clear below. It suits low-level penetration and nap-of-the-earth flight, where the question is which ridge is in the way.

Both modes carry the same overlays, and both support north-up and track-up orientation with selectable range.

### Capability and Datalinks

A format exists only if the aircraft carries the system behind it; aircraft without a sensor simply lack its format. Aircraft with a datalink receiver show contacts from AWACS or ground control on the moving map, with the lower precision and delay of the sensor model from proposal 0002. Those tracks also appear on the air-to-air radar format, marked as datalink tracks, in aircraft that have both. This makes avionics differences, and datalinks, matter without inventing displays an aircraft never had.

### HUD-Integrated Radar

The Su-27 analogue alone also shows its radar picture integrated into the HUD, as the real aircraft did. All other aircraft use the air-to-air radar format.

## Styling

- **Shared structure.** Faction skins change colors, fonts, labels, and units, never layout or button positions.
- **Alliance.** Dark gray bezels, green monochrome screens, English labels, knots and feet.
- **Pact.** Blue-gray bezels, amber or green screens, transliterated labels, kilometers per hour and meters.
- **Era.** Older types may draw scope formats inside an analog-styled round scope bezel, with the same content and buttons.
- **Moving map.** A deliberate anachronism: full color, rendered by the strategic view's renderer in its illustrated style, in both factions. Beauty and legibility win over period accuracy here.
- **Targeting pod and hook camera.** Grayscale thermal or TV imagery with green or amber symbology, matching the faction.
- **Legibility.** All displays meet the color-vision checks in `docs/visual-style.md`.

Part I of `docs/visual-style.md` gets a *Displays and Status Strip* section with the skins and palette tokens.

## Cursor Mode

Mouse aim flies with the mouse, so clicking displays needs a separate mode:

- **Entering.** Holding a key (default: Left Alt) or toggling with a second key frees the cursor.
- **Flying meanwhile.** The flight director holds the current aim point, or attitude and altitude in direct control, until the player leaves cursor mode. In a helicopter, hover hold engages if the aircraft is slow.
- **Using displays.** The player clicks bezel buttons, status strip items, and contacts, and uses the scroll wheel over a display to change its range or zoom.
- **Leaving.** Releasing the key returns the mouse to flying, with the aim point where it was.
- **Keys always work.** Every display action, including radar cursor slewing and designation, has a key binding, so players can stay in mouse aim.
- **Direct control.** With a flight stick, the mouse stays free and cursor mode is unnecessary.

## AI Crew

### Roles

| Role | Aircraft | Owns by default |
|---|---|---|
| Radar intercept officer | F-14 analogue | Air-to-air radar, datalink |
| Weapon systems officer | F-111, F-4G, Tornado, Su-24 analogues | Air-to-ground radar, targeting pod, terrain-following, navigation |
| Bombardier/navigator | A-6 analogue | Air-to-ground radar, targeting pod, navigation |
| Copilot/gunner | Apache, Cobra, Hind analogues | Gunner sight, turret, missiles |
| Crew chief | Transport helicopters | Sling load and landing guidance callouts |
| Loadmaster | Transport aircraft | Airdrop sequencing and release callouts |

### Ownership

Each format in a crewed aircraft has an owner: the player or the crewmate. The display bezel shows the owner. The player can take any format at any time by using it, and can hand it back from the crew command menu. The crewmate works only the formats it owns, using the same sensor model and the same controls the player would.

### Commands

A **crew command menu** opens with a key as a radial menu. Number keys select its entries, and in cursor mode they are clickable. The entries depend on the role:

- **Radar intercept officer:** search a sector or altitude band, track-while-scan, lock the nearest or the highest-threat contact, lock the target I am looking at, break lock, call out bogeys, manage countermeasures.
- **Weapon systems officer and bombardier/navigator:** navigate to a waypoint, find targets of a type in an area, designate, keep the pod on the target, arm and set fuzing, run terrain-following at a set clearance, call releases.
- **Copilot/gunner:** scan an area, prioritize air defenses, engage with gun, rockets, or missiles, hold fire, slave the turret to my aim.
- **Crew chief and loadmaster:** guide me to the load or the drop zone. Crew chiefs give the classic directive calls ("forward five, down three, steady").

### Callouts

Crewmates speak through the messages slot (and later through voice): contacts, locks, launches, threats, waypoints, fuel, and the results of their tasks. Callouts follow a priority order so that a missile launch interrupts a waypoint call. Crew skill, drawn from the squadron's experience and morale, sets how quickly and accurately crewmates act.

## Companion Displays

Displays can later pop out of the game window:

- **Second window on the same machine:** a display opens in its own browser window and syncs through a broadcast channel.
- **Tablet or phone:** a companion page shows one or more displays as a touchscreen glass cockpit. Since Bearing is a static site, pairing needs a peer-to-peer connection with a handshake through a QR code, or an optional public signaling broker.

To keep this possible, every format renders from a **serializable display model**: a pure function from the sensor-filtered simulation snapshot and the display state to a display description. The game window, a second window, and a tablet all draw from the same model, and input from any of them returns as the same display commands.

## Implementation Notes

- **Chrome and buttons:** HTML and CSS, for crisp text, accessible hit targets, and theming through CSS variables.
- **Scope content:** Canvas 2D at device pixel ratio.
- **Map, targeting pod, and hook camera:** renderer viewports or render targets drawn into their display.
- **Display models:** live in `src/ui/displays/`, read only from sensor-filtered state, and hold no rendering code, so tests can check them as snapshots.
- **Budget:** all displays together take under 2 ms of CPU per frame at default update rates.

## Verification

- Each slot's position is identical across all master modes and all aircraft that use it (layout snapshot test).
- Every aircraft shows only the formats its avionics profile lists, in the slots the profile assigns.
- The relative elevation mode colors terrain correctly against own altitude in scripted low-level scenarios.
- Master mode transitions follow the trigger table, and pins survive every transition.
- Every display action has a key binding; a test enumerates actions against bindings.
- Display model snapshots match expectations for representative states (radar with tracks, stores after release, datalink fallback).
- Status strip items appear and warn according to their rules in scripted Free Flight scenarios.
- A crewmate locks a contact, designates a ground target, and guides a sling load in headless scenario tests.
- Screenshots in each master mode for one fighter, one strike aircraft, and one helicopter, checked against the clutter limits: at most two large and two small displays expanded at once.

## Roadmap Changes

The Piloting track changes as follows:

- **P2. HUD, displays, and status strip.** The allocation rule, the display frame, slots and slot states, the status strip, master modes, cursor mode, faction skins, and the moving map format. Retrofit Free Flight: its discrete indicators move from the HUD into the status strip.
- **P3. Sensors and formats.** The sensor model, avionics profiles with display complements, datalink tracks, the elevation mode of the moving map, and the air-to-air radar, air-to-ground radar, threat warning, stores, engines and fuel, and comms formats. The Su-27 analogue's HUD-integrated radar.
- **P5. Crews and special roles.** Format ownership, the crew command menu, the six crew roles, callouts, the targeting pod and hook camera formats.
- **P6. Companion displays (new, later).** Pop-out windows and the tablet companion.

The helicopter track uses these displays: the torque and rotor format and hook camera replace the dedicated displays in proposal 0004, while the hover symbology stays on the HUD.

## Changes to Existing Documents

- **`docs/proposals/0002-third-person-flight.md`:** mark the *Displays* and *Layout and Style* sections as superseded by this proposal; keep the HUD symbology and the crew station mode, which now works through format ownership.
- **`docs/proposals/0004-helicopter-flight.md`:** point the torque, rotor, and hook camera items to the formats in this proposal.
- **`docs/visual-style.md`:** add *Displays and Status Strip* to Part I, including the faction skins and the full-color moving map exception.
- **`docs/design.md`:** reference this proposal under the player's interface and crews.
- **`CLAUDE.md`:** add the allocation rule, the standardization rule, and the requirement that formats render from serializable display models.
- **`TODO.md`:** update P2, P3, and P5, and add P6.
- **`docs/decisions.md`:** record the decisions in this proposal.

## Open Questions

- **Voice.** Should crew callouts use synthesized speech from the start of P5, or text first?
- **Single-seat help.** Should single-seat aircraft get a light automation assistant (for example, automatic radar mode selection by master mode), or stay fully manual?
- **Spectating.** When the player follows an AI flight without taking control, should displays show that aircraft's picture read-only, as proposal 0002 implies for the HUD?
