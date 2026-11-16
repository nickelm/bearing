# Proposal 0004: Helicopter Flight Model and Controls

*Drafted 2026-11-15. Status: accepted 2026-11-15 (decision 149); open questions answered (decision 151). Affects `docs/design.md`, `docs/visual-style.md`, `docs/proposals/0002-third-person-flight.md`, `TODO.md`, and `CLAUDE.md`. The implementation plan is [docs/plans/helicopters.md](../plans/helicopters.md).*

## Decision

Bearing's helicopters use a rotor-disc flight model of medium fidelity and three control modes over one flight director. The design has two goals that it treats as equally important:

- **Approachable.** A new player with mouse and keyboard can take off, fly to a landing zone, and land on the first attempt, using the default mode and assists.
- **Complete.** An experienced player can do everything a real helicopter can do: hover, pedal turns, sideward and rearward flight, nap-of-the-earth flight, pop-up attacks, slope and confined-area landings, sling loads, autorotation, and, in the right types, loops and rolls.

Assists bridge the two goals. Every assist can be switched off individually, and switching assists off never removes a capability; it only removes protection.

## References

Two games shaped this design. Arma 3's standard flight model shows that mouse-controlled helicopters can feel natural: the mouse acts as the cyclic, two keys move the collective, and one mouse movement produces a coordinated turn. Its advanced flight model shows the opposite lesson: richer physics without a better control layer made mouse and keyboard flying much harder. War Thunder's instructor shows how a control layer can fly the aircraft toward a direction the player points at, while the physics underneath stay intact. Bearing takes the physics approach of the second and the control ideas of both.

## Flight Model

### Rotor as a Thrust Disc

Each helicopter is one rigid body. The main rotor is a disc that produces thrust along its normal. Blade-element simulation is out of scope. Seven effects give each type its character:

1. **Thrust vector.** Cyclic tilts the disc, with a first-order lag set by the flapping time constant. Collective and available engine power set thrust magnitude. Rotor speed stays governed during normal flight and becomes a state variable in autorotation.
2. **Hub stiffness.** The control moment the rotor produces beyond tilting the thrust vector. It decides how a type behaves at low and negative load factor:
   - *Teetering* rotors (Huey and Cobra analogues) have almost none. Control authority fades near zero g, and pushovers risk mast bumping.
   - *Articulated* rotors (Little Bird, Black Hawk, Apache, Hind, Mi-8 analogues) have a moderate amount.
   - *Hingeless* rotors (Lynx and Bo-105 analogues) have a lot, which allows loops and rolls.
3. **Power curve.** Power required follows the classic bucket: high in the hover, lowest around 60 to 80 knots, rising at high speed. Effective translational lift arrives between 15 and 25 knots. Ground effect reduces power required within about one rotor diameter of the surface. Available power falls with altitude and temperature.
4. **Torque and tail rotor.** Collective changes produce a yaw moment that the tail rotor must counter. Tail rotor authority limits flat-turn rates and weakens at high power and in tailwinds. Tandem and coaxial types use their own yaw mechanisms, modeled as a yaw authority parameter.
5. **Fuselage and fin.** Drag areas for the front, side, and top, plus fin and horizontal stabilizer areas. At speed, the fin weathervanes the helicopter into its flight path, and the stabilizer sets nose attitude.
6. **Wings.** Types with stub wings (the Hind analogue in particular) get wing lift that offloads the rotor at speed, making them fast but sluggish in the hover.
7. **Limits and hazards.** Retreating blade stall acts as a soft never-exceed speed, with roll-off and vibration. Vortex ring state occurs in slow, steep descents. Mast bumping occurs in teetering rotors under low load factor. Engine failure leads to autorotation, and loss of the tail rotor leads to a spin.

### Integration

The helicopter flight model shares the fixed 120 Hz time step, the local tangent frame, the float64 position, and the determinism requirement with the fixed-wing flight model. It lives in `src/sim/` and runs headless.

### Type Parameters

All parameters live in the type's JSON specification, next to its geometry and avionics profile:

| Parameter | Purpose |
|---|---|
| Mass (empty, maximum) | Weight, inertia |
| Rotor radius, blade count | Disc area, visuals |
| Rotor type, hub stiffness | Control power, low-g behavior |
| Flapping time constant | Responsiveness |
| Power available by altitude and temperature | Climb, hover ceiling |
| Power required curve | Speed bucket, translational lift |
| Tail rotor or yaw authority | Flat turns |
| Drag areas, fin and stabilizer areas | Weathervaning, speed |
| Wing area, if any | Lift at speed |
| Never-exceed speed | Retreating blade stall onset |
| Landing gear: skids or wheels, contact points | Ground handling |
| Sling hook, hoist, fast-rope positions | Utility roles |

### Types

| Analogue | Rotor | Character |
|---|---|---|
| Little Bird | Articulated, light | Quick, agile, rooftop landings, special operations |
| Lynx, Bo-105 | Hingeless | Aerobatic with protection off, nimble anti-tank work |
| Cobra | Teetering | Slim and fast, no negative g |
| Apache | Articulated, heavy, powerful | Stable gun platform, strong climb |
| Black Hawk | Articulated, utility | Forgiving, troop transport, sling loads |
| Huey | Teetering, utility | Light utility, classic handling |
| Hind | Articulated, with wings | Fast attack runs, troop carrying, poor hover |
| Mi-8 | Articulated, utility | Workhorse transport |
| CH-47, Mi-26 | Heavy | Momentum, slow inputs, heavy sling loads |

## Controls

All three modes produce commands for the same flight director, which turns them into cyclic, collective, and pedal inputs. AI pilots use the same flight director, so handback works the same way as for jets.

### Fly-by-Mouse (Default)

| Input | Function |
|---|---|
| Mouse up/down | Pitch attitude command; auto-trim holds the attitude on release |
| Mouse left/right | Speed-scheduled: yaw rate below about 20 knots, coordinated bank-to-turn above about 40 knots, blended in between |
| W / S | Collective (behavior depends on assist preset, see below) |
| A / D | Lateral cyclic: side-steps, strafing, drift correction |
| Q / E | Pedals: flat turns and nose pointing at any speed |
| H | Hover hold on or off |
| Hold right mouse button | Free look; with a turreted gun, the gun follows the look direction |

The speed-scheduled mouse turn is the central idea: one control does the right thing in the hover and in cruise. The speed thresholds are type parameters.

### Mouse Aim

The mouse sets an aim point; the flight director points the nose (and a fixed gun or rocket pods) at it while holding altitude. Intended for gun and rocket runs in attack helicopters. A single key switches between mouse aim and fly-by-mouse in flight.

### Direct

Cyclic and pedals command rotation rates through stability augmentation when it is on, or deflect the controls directly when it is off. Collective is manual. Intended for flight sticks, with a throttle axis as the collective and rudder pedals or a twist grip for yaw.

## Assists

Each assist is a separate toggle. Three presets set them together:

| Assist | Assisted (default) | Standard | Expert |
|---|---|---|---|
| Collective behavior | Climb-rate command; release holds altitude | Position with hover-power detent; release holds position | Position, no detent |
| Auto-trim | On | On | Off |
| Pedal trim (torque compensation) | On | On | Off |
| Turn coordination | On | On | Off |
| Hover hold engages automatically when slow and centered | On | Off (manual key) | Off (manual key) |
| Radar-altitude hold | Available | Available | Available |
| Bank and pitch limits | 45° and ±30° | 75° and ±60° | Off |
| Torque limiter | On | On | Off |
| Envelope protection (vortex ring state, mast bumping, retreating blade stall) | On | Warnings only | Off |
| Ground collision warning | On | On | On |

Envelope protection keeps a helicopter out of its hazards by limiting inputs near them. With protection off, the hazards occur as modeled. Loops and rolls in a hingeless-rotor type therefore need Expert or custom settings, and a Cobra pilot who tries them learns about mast bumping.

## Everything a Helicopter Can Do

The flight model and controls must support the following maneuvers. Each one also becomes a scripted headless test (see *Verification*).

- **Hovering:** in and out of ground effect, hover taxi, pedal turns, sideward and rearward flight.
- **Takeoffs and landings:** vertical, running (heavy or hot-and-high), slope landings within type limits, confined areas, rooftops (Little Bird), and ships.
- **Low flying:** nap-of-the-earth flight with radar-altitude hold, terrain masking, pop-up and unmask for attacks, bob-ups.
- **Maneuvering:** quick stops, wingovers and torque turns, high-speed attack runs (Hind), and loops and rolls (hingeless types, protection off).
- **Utility:** sling loads with pendulum dynamics and load drag, hoisting, fast-roping and rappelling troops, and door gunners operated by the AI.
- **Emergencies:** autorotation to a landing after engine failure, recovery from vortex ring state, and a controlled crash after loss of the tail rotor.

## Ground Handling

- **Skids** (Little Bird, Huey, Cobra): friction contact, hover taxi only, slope limits by type.
- **Wheels** (Black Hawk, Apache, Hind, heavy types): ground taxi with brakes and tail or nose wheel steering.
- **Dynamic rollover:** a hazard when one skid or wheel stays on the ground during lateral drift or a slope takeoff; a warning appears when protection is on.

## Takeoff and Landing

Proposal 0002 left takeoff and landing to the AI. For helicopters, landing is the mission: inserting troops, delivering a sling load, or reaching a forward arming and refueling point. Helicopter missions therefore extend their jump-in window to include ground phases, and the player can fly every landing. Fixed-wing aircraft keep the rule from proposal 0002, apart from the Free Flight exception.

## HUD and Camera

### Hover Symbology

Seen from a chase camera, small drift in the hover is hard to judge. The helicopter HUD adds:

- a **velocity vector on the ground plane**, drawn from the helicopter's ground point, with an **acceleration cue** at its tip (adapted from Apache hover symbology);
- **radar altitude** with a vertical speed indicator;
- **torque** as a percentage of maximum, which matters more than airspeed when heavy;
- **rotor RPM**, prominent during autorotation;
  (Proposal 0006, decision 189: torque and rotor RPM, with power margin, become the torque and rotor gauges at the end of the status strip; the rest of this list stays on the HUD.)
- a **landing zone marker** with distance and bearing;
- for sling loads, **cable tension** and the load's position relative to the hook, plus the hook camera display from proposal 0002 (now the hook camera format of [proposal 0006](0006-displays-and-crew.md), with load position and cable tension);
- hazard cues for vortex ring state, mast bumping, retreating blade stall, and dynamic rollover.

### Camera Rig

The helicopter rig sits closer and higher than the jet rig. As airspeed drops, it lifts and tilts down, so the landing zone and the ground beneath stay in view. In the hover, free look orbits freely; in cruise, it springs back as for jets.

## Visual Consequences

- **Rotors:** a blurred, translucent disc while spinning, with visible blades when slow. The disc tilts with cyclic, which gives players a direct visual cue for what the controls are doing.
- **Downwash:** dust, snow, and spray at low height, scaled with power; grass and treetops sway in the near field.
- **Sling loads:** cable and load modeled and rendered, swinging visibly.
- **Damage:** smoke, a spinning fuselage after tail rotor loss, and a slowing rotor in autorotation.

These additions go into Part I of `docs/visual-style.md`.

## AI Integration

AI helicopter pilots use the same flight model and flight director. Their behaviors cover nap-of-the-earth routes with radar-altitude hold, terrain masking in battle positions, pop-up attacks, landing zone approaches, and sling-load deliveries. The AI flies with protection on.

## Verification

Headless tests in `src/sim/`, each a scripted maneuver with pass criteria:

- stable hover in ground effect for 60 seconds with hover hold, drifting less than 1 m;
- power required at hover, at bucket speed, and at maximum speed within type tolerances;
- onset of translational lift between 15 and 25 knots;
- a 360° pedal turn in the hover within a type-specific time;
- a nap-of-the-earth course flown at 30 m radar altitude without terrain contact;
- a slope landing at the type limit, and a rejected landing beyond it;
- a sling load picked up, carried 5 km, and set down within 3 m of its target;
- autorotation from 300 m to a landing with a sink rate under the type's crash limit;
- a loop completed by the Lynx analogue with protection off;
- mast bumping detected in a Cobra analogue pushover with protection off, and prevented with protection on;
- the same maneuver flown by the AI, from the same inputs, to the same result (determinism).

## Roadmap

A new post-demo track, **Helicopters (H)**, follows P1 (flight model and controls framework) and uses the Free Flight mode as its test bed.

- **H1. Rotor model and fly-by-mouse.** The thrust-disc model, the speed-scheduled controls, the Assisted preset, the hover HUD, the helicopter camera rig, and Free Flight from a helicopter pad with the Little Bird and Black Hawk analogues.
- **H2. All modes and types.** Mouse aim, direct control with flight stick support, all assists and presets, and the remaining types.
- **H3. Ground and utility.** Skids and wheels, slope and confined-area landings, dynamic rollover, sling loads with the hook camera, hoisting, fast-roping.
- **H4. Hazards and damage.** Vortex ring state, mast bumping, retreating blade stall, autorotation, tail rotor loss, and their cues.
- **H5. Combat and AI.** Fixed and turreted weapons, gunner mode from proposal 0002, AI nap-of-the-earth and battle-position behaviors.

Dependencies: H1 depends on P1 and the Free Flight mode. H5 depends on P4.

## Changes to Existing Documents

- **`docs/design.md`:** add helicopter mission jump-in windows that include ground phases; reference this proposal under the flight model and controls.
- **`docs/proposals/0002-third-person-flight.md`:** note the helicopter exception to AI-only takeoff and landing, and point to this proposal for the helicopter camera rig and hover symbology.
- **`docs/visual-style.md`:** add rotor discs, downwash effects, sling loads, and helicopter damage to Part I.
- **`CLAUDE.md`:** fixed-wing and rotary-wing aircraft share one flight director interface; helicopter physics live in `src/sim/` beside the fixed-wing model.
- **`TODO.md`:** add track H as unbroken milestone entries.
- **`docs/decisions.md`:** record the thrust-disc model, fly-by-mouse as default, the three presets, and the helicopter landing exception.

## Open Questions

- **Wind.** Wind matters greatly for helicopters (tail rotor authority, landing direction, sling load swing). Should the weather model supply local wind before H1, or can H1 start in calm air?
- **Engine start.** Should helicopters ever spawn cold, with a short start sequence, for missions launched from a forward arming and refueling point?
- **Door gunners.** AI-only, or can the player switch to a door gun seat in transport helicopters?

**Owner's answers (decision 151).** Wind: the weather model already supplies it (decision 143), so H1 flies in wind. Engine start: hot starts only, no start sequence. Door gunners: AI-only for now; in the end the player can take any crew position while the AI does everything else. H1 may start before P1 closes, and the new types stay out of the campaign until they get their roles: the Little Bird for close air support and small-unit warfare, the Cobra as a marine attack helicopter, the Black Hawk, Huey and Mi-8 as transports, perhaps with fire support.
