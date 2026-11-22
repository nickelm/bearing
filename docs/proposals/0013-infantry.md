# Proposal 0013: Infantry

*Drafted 2026-11-22. Status: accepted 2026-11-22 (decision 331). Affects `docs/roadmap.md`, `docs/visual-style.md`, `docs/proposals/0008-game-loop-and-campaign.md`, `docs/proposals/0011-stylized-effects.md`, and `docs/proposals/0012-gunship-and-sensor-stations.md`.*

## Decision

Bearing's infantry are **blocky, Minecraft-like, cartoony soldiers with oversized helmets**, in large numbers, with real squad behavior, and with splash damage that makes air power visibly devastating against them. There is no gore: soldiers are blasted into tumbling arcs, lose their helmets, fall, turn gray, and vanish in a toon puff. Downed pilots and prisoners use the same figures. **There are never civilians.**

## Rationale

Infantry fails in most flight and tank simulators because soldiers are too few, too small to see, too static, and too expensive to animate. The blocky style removes the cost problem: rigid boxes animate in the vertex shader without skinning, so the budget goes into numbers, readability, and behavior. Infantry matters to Bearing because close air support, the gunship (proposal 0012), attack helicopters, and CSAR all revolve around soldiers on the ground.

## The Figure

### Construction

- **Six boxes:** head, torso, two arms, two legs; about 72 triangles, flat-shaded and vertex-colored.
- **Oversized helmet:** a seventh shape, deliberately large, sitting on the head. It defines faction silhouette and can pop off.
- **Proportions:** chunky and toy-like, with a slightly large head and helmet, short legs, and broad shoulders.
- **Scale:** **1.3 to 1.5 times life size** (default 1.4), applied to rendering, collision, and hit detection alike.
- **Equipment:** rifle, machine gun, launcher tube, or radio as a small attached box per role.

### Faction Looks

| | Alliance | Pact |
|---|---|---|
| Helmet | Large, rounded, low-brimmed | Large, tall dome |
| Uniform | Woodland green with darker patches | Khaki and brown |
| Kit | Olive webbing, square pack | Brown webbing, round pack |

Specialists differ by a visible prop: a long tube for MANPADS teams, a short tube for RPG teams, a baseplate and tube for mortars, a radio aerial for forward observers.

### Downed Pilots

Ejected pilots use the same figure with a flight suit, an oversized flight helmet, a survival vest, and a parachute for the descent. See *Downed Pilots* below.

### Levels of Detail

| Distance | Representation |
|---|---|
| Under about 600 m | Full figure with helmet and props |
| 600 m to 2 km | Three boxes (head and helmet, body, legs) |
| 2 to 5 km | One box per soldier |
| Beyond 5 km | Squad blobs as small clusters of sprites, or none |

**Readability scaling:** beyond about 1 km, rendered figures grow slightly with distance so they never fall below a few pixels in height. This affects rendering only, and it can be switched off.

## Animation

Each limb is a rigid box rotating around a joint, driven in the vertex shader by per-soldier state, phase, and speed. Recipes:

- idle, walk, run, crouch-run, crawl;
- kneel and fire, prone and fire, throw;
- mount and dismount vehicles, board helicopters, fast-rope, parachute;
- carry a wounded comrade, hands up (surrender);
- knocked down, tumble (blast), get up dazed, fall (death).

Muzzle flashes and tracers come from the effects system (proposal 0011).

## Simulation Levels

The fidelity ladder of proposal 0008 gains a level between battalions and individuals:

| Level | Range | Content |
|---|---|---|
| Battalion aggregate | Everywhere | Strength, supply, posture, attrition |
| Squad simulation | Within about 20 km of the camera | Squad positions, formations, suppression, morale, ammunition, casualties |
| Individual soldiers | Within about 3 to 5 km | Rendered figures with per-soldier position, animation state, and simple behavior |

Battalions promote whole companies into squads near the camera, not a token squad. Squads promote into individuals nearer still. Demotion folds casualties back up.

**Presentation follows simulation.** Combat between AI forces resolves at squad level; the individual figures act it out, and the renderer chooses which soldiers fall. Player weapons work the other way round: shells, bullets, and bombs hit individual soldiers physically, and the losses feed back to the squad and the battalion.

A GPU compute pass updates individual soldier positions and animation states, so thousands of soldiers stay affordable.

## Squad Behavior

Squads (fire teams of 4, squads of 8 to 12, platoons of 30 to 40) follow simple, legible rules:

- **Movement:** formations, bounding overwatch, movement along cover, mounting and dismounting from vehicles.
- **Cover:** cover points from vegetation, ditches, rubble, and buildings (proposal 0009); squads seek them when under fire.
- **Suppression:** incoming fire raises suppression; suppressed squads go prone and slow down; heavy suppression pins them.
- **Fire:** squads return fire at visible enemies, producing tracers and muzzle flashes that the air war can see.
- **Morale states:** advancing, holding, pinned, falling back, routed, surrendering.
- **Specialists:** MANPADS teams engage helicopters and low jets; RPG teams engage vehicles and hovering helicopters; mortar teams fire on positions; forward observers call for support and send talk-on requests (proposal 0012).
- **Air assault:** squads board helicopters, fast-rope or land at landing zones, and jump as paratroopers from transports in combat drops.

## Splash Damage

Air weapons affect infantry mostly through blast and fragments. Every explosive weapon has a **splash profile**:

- **Lethal radius:** soldiers inside fall.
- **Casualty radius:** soldiers inside fall with a probability that decreases with distance.
- **Knockdown radius:** survivors are blasted off their feet; inside it, soldiers are launched in tumbling arcs with an impulse that decreases with distance.
- **Suppression radius:** squads inside gain heavy suppression.

Modifiers: prone soldiers and soldiers in cover take less; buildings protect occupants until they collapse; treelines protect partially; airbursts ignore ground cover.

Starting gameplay values, deliberately generous so that air power is visible and decisive. These are tuning values, not real weapon data:

| Weapon | Lethal | Casualty | Knockdown | Suppression |
|---|---|---|---|---|
| 20 mm HE | 1 m | 3 m | 3 m | 15 m |
| 30 mm HE (A-10 analogue) | 2 m | 6 m | 6 m | 25 m |
| 40 mm HE | 3 m | 8 m | 8 m | 30 m |
| Unguided rocket | 4 m | 12 m | 12 m | 40 m |
| 105 mm shell | 8 m | 25 m | 25 m | 80 m |
| 250 kg bomb | 15 m | 45 m | 45 m | 150 m |
| 500 kg bomb | 20 m | 60 m | 60 m | 200 m |
| Cluster bomb | Pattern of bomblets over about 150 × 100 m, each with a small profile | | | 250 m |

Machine gun and cannon fire without explosive rounds hits soldiers individually and adds suppression along its path.

## Reactions and Death

- **Blast:** soldiers in the knockdown radius tumble through the air with limbs flailing and land in a puff of dust. Helmets pop off and bounce away.
- **Survivors:** knocked-down soldiers stay down briefly, stagger up dazed, and scramble for cover.
- **Death:** a fallen soldier lies still, **desaturates to gray within a few seconds, and vanishes in a small toon puff**. No bodies accumulate, which keeps the frame rate up and the tone cartoony.
- **No gore:** dust, debris chunks, and smoke puffs only. No blood, no dismemberment.

## Prisoners

- **Surrender:** routed squads that are cut off, surrounded, or pinned with no line of retreat may surrender. Soldiers raise their hands and stop fighting.
- **Escort:** prisoners walk toward the rear with an escort when friendly forces are near; otherwise they wait in place.
- **Campaign:** prisoners count in the campaign. They lower the losing side's morale, raise the capturing side's, and can be exchanged in a ceasefire (proposal 0008).
- **Rules of engagement:** firing on surrendering or captured soldiers is a violation that costs the side's standing (proposal 0012).

## Downed Pilots

Survivors from proposal 0008 use the infantry figures:

- **Descent:** a parachute canopy and a swinging figure.
- **On the ground:** the survivor hides in cover, moves toward friendly lines or a pickup point when safe, and signals rescuers with smoke by day and flares or a strobe by night.
- **Injury:** an injured survivor moves slowly or not at all.
- **Search parties:** nearby enemy units send squads to hunt survivors, which gives CSAR cover missions targets.
- **Capture:** a captured pilot becomes a prisoner and leaves the pilot pool; a captured named pilot loses reputation (proposal 0008).

## No Civilians

Bearing never models civilians. Settlements (proposal 0009) contain buildings and military units only. This rule is permanent.

## Sensors

- **Thermal:** soldiers are warm and glow in infrared; muzzle flashes and fires flare hot; friendly infrared strobes blink.
- **TV:** uniform colors and helmet silhouettes separate the sides in low-light and color TV.
- **Visual detection:** squads in the open are visible from the air by movement, muzzle flashes, tracers, and dust; squads in cover are hard to see until they fire.

## Budgets

- Up to 5,000 individually rendered soldiers within range, at most about 400,000 triangles across all detail levels.
- GPU update of individual soldiers under 0.5 ms; squad simulation under 1 ms per tick on the simulation worker.
- In a stress scene (a battalion attack with 1,500 soldiers visible from a gunship orbit), the frame stays within the budgets of `docs/visual-style.md`.

## Dependencies and Roadmap

Infantry belongs in **R3 (combat depth)**, as part of ground entity behavior. It depends on the effects system (proposal 0011) for muzzle flashes, tracers, dust, and death puffs, and it serves the gunship (proposal 0012), attack helicopters, combat airdrops, helicopter assault, and CSAR. The demo's minimal promotion (proposal 0008) may use a reduced version: a few squads per battalion near the player, with the figures and death behavior of this proposal.

## Verification Criteria

| Check | Criterion |
|---|---|
| Readability | Squads are visible and recognizable by side from 1 km in TV and infrared screenshots |
| Numbers | The stress scene runs within budget |
| Behavior | Squads take cover, return fire, get pinned, and rout in scripted scenarios |
| Splash | Casualty counts from test strikes match the splash profiles within tolerance; prone and covered soldiers take less |
| Reactions | Knocked-down survivors get up; the dead turn gray and vanish within the set time |
| Consistency | Squad-level outcomes match individual-level results within calibration tolerance |
| Prisoners | Surrender occurs only under its conditions; prisoners count in the campaign; firing on them costs standing |
| Pilots | Survivors hide, signal, and move; search parties hunt them; capture works |
| No civilians | No civilian entities exist in any system |
