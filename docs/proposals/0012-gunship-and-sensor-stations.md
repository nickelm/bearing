# Proposal 0012: Gunship and Sensor Stations

*Drafted 2026-11-21. Status: accepted 2026-11-22 (decision 302). Affects `docs/roadmap.md`, `docs/visual-style.md`, `docs/proposals/0006-displays-and-crew.md`, `docs/proposals/0008-game-loop-and-campaign.md`, and `docs/proposals/0011-stylized-effects.md`.*

## Decision

The Alliance gets a side-firing gunship, an analogue of the AC-130H Spectre (working name: **AC-31 Warden**). The AI pilot flies a pylon turn around the target while the player works the **gunner station**: a full-screen sensor view with a 105 mm howitzer, a 40 mm autocannon, and 20 mm cannons. The gunship flies only where its side holds the air, which makes it a reward for winning air superiority and suppressing air defenses.

The Pact gets no gunship. Its counterpart is the Hind analogue, flown as an airborne tank: armored, heavily armed, and able to carry troops. This asymmetry is deliberate, like the F-117 analogue.

## Rationale

The gunship ties together systems Bearing already plans: air superiority, the air defense picture, night operations, the ground war, the road network and logistics columns, crews, and the targeting displays. Its gunner station is the most direct way to feel the ground war, and the gunship's dependence on a safe sky makes the player's earlier missions visibly matter.

## The Aircraft

### Bundle

The gunship is an aircraft bundle per proposal 0008: a C-130 analogue airframe with side-mounted guns, sensor turrets, and the gunship crew; a flight model shared with the transport, with added weight and drag; an avionics profile with fire control, sensors, threat warning, and countermeasures; and the stations below.

### Crew and Stations

| Station | Role | Player | AI |
|---|---|---|---|
| Pilot | Flies the orbit and the transit | Yes, in the chase view | Yes |
| Fire control officer | Assigns targets, manages rules of engagement | Through the gunner station | Yes |
| Sensor operators | Infrared and TV sensors | Through the gunner station | Yes |
| Gunners and loaders | Load and service the guns | No | Yes |

The player switches between the pilot station and the gunner station at any time. The AI crew covers the station the player leaves, using the crew system of proposal 0006.

### Orbit

The gunship attacks from a **left-hand pylon turn**: a banked circle around a designated point, so the left-side guns stay on target. An autopilot mode holds the orbit at a set radius and altitude; the pilot or the fire control officer can shift the orbit center, tighten or widen it, and change altitude. Orbit altitude defaults above the typical man-portable missile ceiling. A small gimbal in fire control lets the guns hold a target within the orbit's geometry.

## Weapons

Period weapons, matching the AC-130H, with an earlier variant matching the AC-130A:

| Weapon | Fire | Character |
|---|---|---|
| 105 mm howitzer | Hand-loaded, one round every several seconds | Large burst, shockwave, heavy damage to vehicles and positions |
| 40 mm autocannon | Clips of four, around 100 rounds per minute | Tight clusters of bursts, effective against vehicles and troops |
| 20 mm cannons (two) | Selectable rate, very high | Fast lines of strikes against troops and soft vehicles |
| 7.62 mm miniguns (AC-130A variant) | Very high rate | Dense strike patterns against troops; replaces the 105 mm on the earlier variant |

- **Ballistics:** shells take several seconds to reach the ground. Fire control compensates for the orbit and wind, but moving targets need anticipation.
- **Dispersion and fuzing:** each weapon has dispersion that grows with range; the 105 mm and 40 mm have impact and short-delay fuzes.
- **Ammunition:** limited loads per weapon, tracked in the stores display.

## The Gunner Station

The gunner station is a **full-screen sensor view**. It follows the crew station mode of proposal 0006 (an enlarged targeting display) and keeps the rule that Bearing has no cockpits.

### Sensor Modes

| Mode | Look |
|---|---|
| Infrared, white-hot | Grayscale thermal image, hot objects white |
| Infrared, black-hot | Inverted thermal image |
| Low-light TV | Monochrome image, usable at dusk and with moonlight |
| Color TV | The normal scene in color through a zoomed camera, with a light TV treatment (slight desaturation, scanlines); a deliberate anachronism for daylight use |

Smoke obscures the TV modes more than the infrared modes, so switching sensors is a tactical choice.

### Controls and Overlays

- **Zoom:** wide, medium, and narrow fields of view, with stabilization.
- **Tracking:** point and area track, and a laser rangefinder.
- **Weapons:** selection, ready status, ammunition, rate of fire, time of flight to the aim point.
- **Overlays:** reticle with a weapon-specific aim point, compass and north arrow, orbit status, friendly infrared strobes, talk-on markers from ground units, and target labels when designated.
- **Picture-in-picture:** an optional small chase view of the gunship.

### Ground Talk-On

Friendly units in contact send requests through the messages slot: the type of target, a bearing and distance from a friendly strobe or landmark, and urgency ("troops in contact, enemy vehicles in the treeline 300 m north of the strobe"). Requests appear as markers in the sensor view once the gunner looks at the area.

## Thermal and TV Rendering

A sensor render mode serves the gunner station, the targeting pod format (proposal 0006), and helicopter gunner sights (the Apache and Hind analogues):

- **Heat values per material:** running engines and exhausts hot, fires and impacts very hot, people and animals warm, buildings and roads warm after sunset, terrain and vegetation cool, water cool. Values shift with time of day and weather.
- **Image treatment:** rendered at a modest resolution, with bloom on hot spots, sensor noise, and scanlines; white-hot and black-hot palettes for infrared.
- **Effects:** the puffs of proposal 0011 render in a heat palette in infrared modes. Fireballs bloom white; smoke starts warm and cools to gray.
- **Cost:** the sensor view replaces the main view, so its cost does not add to the scene cost. Picture-in-picture renders at a small size.

## Effects

Gunship presets extend proposal 0011:

| Preset | Look |
|---|---|
| 105 mm impact | Large dirt and fire burst, shockwave ring, debris, scorch decal; a camera kick in the gunner view |
| 40 mm impact | Compact bursts in clusters of four |
| 20 mm and 7.62 mm strikes | Rapid sparkle and dust strikes stitching across the ground |
| Tracers | Bright stylized dashes; at night, cones of tracer fire visible from the chase view and from far away |
| Muzzle flashes | Bright flashes along the left side of the gunship |

Impacts are deliberately punchy: strong enough that each weapon is recognizable at a glance, from the gunner view and from the chase view.

## Missions

| Mission | Planner rule |
|---|---|
| Gunship close air support | Troops in contact in a sector with acceptable threat, preferably at night |
| Armed overwatch | Protecting a sector, a convoy, or a landing zone over time |
| Night convoy interdiction | Enemy logistics columns on roads at night within reach |
| CSAR cover | Protecting survivors and the rescue helicopter (proposal 0008) |

**Threat rules:** the planner creates gunship missions only where its air defense picture shows no radar-guided SAM coverage, local air superiority, and limited anti-aircraft artillery. Gunships break off when the threat warning detects a radar SAM, a fighter threat appears, or anti-aircraft fire becomes heavy. These rules make gunship missions appear where the player's side has won the air.

## Rules of Engagement and Consequences

- **Danger close:** fire control warns when an aim point lies within a weapon-specific distance of a friendly strobe and requires a confirmation input to fire.
- **Fratricide:** shells landing among friendly units cause losses and cost the squadron's morale and the named pilot's reputation.
- **Collateral damage:** strikes that damage non-military buildings in settlements (proposal 0009 damage states) count against the side's **standing**, a campaign variable that adds to ceasefire pressure (proposal 0008).

## Pact Counterpart: The Hind as Airborne Tank

The Hind analogue covers the role on the Pact side with a different style: a fast, armored assault helicopter that attacks in pairs, carries troops, and escorts convoys. Its gunner position uses the same sensor view system with its own sight characteristics (narrower field of view, TV and later infrared). Its mission set includes attack helicopter CAS, helicopter assault, convoy escort, and armed reconnaissance.

## Dependencies and Roadmap

The gunship depends on:

1. **Ground entity behavior (R3):** infantry in treelines and buildings, vehicles that move, scatter, and hide, convoys on roads at night, units that return fire, and friendly infrared strobes.
2. **Weapons and ballistics (R3):** shells with time of flight, dispersion, fuzing, and damage.
3. **The sensor render mode (R3):** shared with targeting pods and helicopter sights.
4. **Stylized effects (proposal 0011).**

The gunship bundle, its missions, the gunner station, and the rules of engagement belong in **R4 (breadth)**. R3 tasks for ground entities, weapons, and the sensor render mode should take this proposal into account, so they serve the gunship without later rework.

## Verification Criteria

| Check | Criterion |
|---|---|
| Orbit | The autopilot holds a pylon turn within tolerance of radius and altitude in wind |
| Ballistics | Fire control hits stationary targets within dispersion; moving targets need lead, as designed |
| Threat rules | No gunship mission is planned inside radar SAM coverage; gunships break off on threat |
| Sensors | All four modes render; smoke obscures TV more than infrared |
| Thermal | Engines, fires, and people read correctly in infrared at night and in daylight |
| Talk-on | Requests produce markers and targets that match the ground situation |
| Danger close | Warnings and confirmation work; fratricide and collateral update morale, reputation, and standing |
| Effects | Each weapon's impacts are distinguishable in screenshots from the gunner view and the chase view |
| Performance | The gunner view stays within the frame budget during sustained fire |
