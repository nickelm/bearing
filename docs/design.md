# Bearing: Design Doc

*Revision 5, 2026-11-10.*

## Vision

Bearing is a late-Cold-War air war on a procedurally generated, Earth-like planet. Two fictional blocs, the **Alliance** and the **Pact**, fight across whatever geography the seed produces: a single supercontinent, two continents divided by an ocean, or a scattered archipelago. Fourth-generation fighters, strike aircraft, attack helicopters, bombers, AWACS, tankers, and transports fly over a ground and naval war that runs under AI control.

The player flies. The war runs itself. At any moment the player can search the ongoing missions of their side (a CAP over the front, a low-level interdiction strike, an attack helicopter CAS sortie, a combat airdrop) and jump into any aircraft involved. When the player leaves, the AI takes the aircraft back and the mission continues. The tone we're aiming for is *Red Storm Rising*: a theater-spanning war in which air power decides whether fronts hold and convoys get through.

## Design Pillars

1. **The world comes first.** Generation is unsteered. The campaign reads the map and adapts to it.
2. **The war runs without the player.** Missions are planned, flown, and resolved whether or not anyone watches.
3. **Any aircraft, any mission, either side.** The player chooses a side and then flies whatever interests them.
4. **Fidelity is a level of detail in space and time.** The simulation refines what the player looks at and coarsens what the player ignores.
5. **Plausible over clever.** The AI must produce a believable war, but it does not need to win one. The player's attention rests on flying.

## Decisions So Far

- **Name:** Bearing.
- **Planet:** Earth-like, about 1,000 km radius, generated from a seed with no steering toward a particular geography.
- **Campaign:** Detected from the generated world as a set of theaters; one world can contain several.
- **Casting:** Automatic and deterministic. Players get the war their seed produces and do not confirm or edit it.
- **Sides:** Alliance and Pact are both playable. The player picks a side at campaign start.
- **Player role:** Pilot, not commander. The player does not command ground or naval forces.
- **Core loop:** Search ongoing missions, jump in, fly, hand back. No takeoff or landing by default.
- **Ranges:** Aircraft ranges compressed by a factor that the casting step adapts to each world; speeds stay real.
- **Time:** Variable time acceleration from the first demo.
- **Hosting:** Static site on GitHub Pages. No server, no SharedArrayBuffer.

## Demo Goals

1. Generate a planet from a seed in under 30 seconds on a mid-range laptop.
2. Produce terrain with geological structure: continents, oceans, mountain ranges, canyons, plains, rivers, and distinct biomes.
3. Render the planet continuously from orbit to 500 m altitude without visible seams or distracting popping.
4. Build a strategic graph, detect theaters, and cast a campaign for any seed that passes the validity check.
5. Place settlements, roads, ports, and airbases according to the cast.
6. Generate air tasking for both sides and fly 20 to 50 aircraft on typed missions.
7. List ongoing missions in a searchable panel and follow any of them with a chase camera.
8. Show ground formations along any continental front and convoys along any sea lane.
9. Run at 1× to at least 64× time acceleration without the simulation diverging.
10. Run in a desktop browser.

**Non-goals for the demo:** cockpit flight, combat between individual entities, the campaign economy, naval combat, sound, and multiplayer.

## Scale and Range

We keep a radius of about **1,000 km**, which gives a maximum surface distance of about 3,100 km and a surface area of about 12.6 million km².

Since geography now varies, a fixed range factor no longer fits every world. The casting step chooses a **range factor** between 0.35 and 1.0 per campaign, so that the theaters it detected remain playable. Two targets set it: a medium strike aircraft operating from rear bases must reach the full depth of the enemy side of a front, and a long-range bomber must reach across the widest contested sea lane. The factor scales fuel capacity and burn rate only. Speeds, climb rates, and weapon ranges stay real.

At 4096 × 4096 texels per cube face, the global bake gives about 380 m per texel. We run a second, higher-resolution bake (about 50 m per texel) over regions the casting step marks as ground-combat areas.

## Technology

**TypeScript + Three.js with the WebGPU renderer and TSL shaders**, built with Vite and hosted as a static site on GitHub Pages. Compute shaders handle erosion, terrain baking, and line-of-sight queries. Long-running CPU tasks run in Web Workers. Workers exchange state with `postMessage` and transferable buffers, since GitHub Pages cannot set the headers that SharedArrayBuffer requires. A Gamepad API binding later gives us flight stick support.

## Architecture

The architecture separates **simulation** from **presentation**.

- **Simulation layer.** A headless model of the world, running in a worker. It contains two parts: a **command layer** per side that plans missions, and an **execution layer** that moves and resolves everything (flights, formations, convoys, bases).
- **Presentation layer.** Cameras, renderers, and UI that read simulation state. The orbit view, the mission search panel, and the future cockpit view are three views onto the same world.
- **World data.** Baked planet maps (height, biome, moisture, temperature, flow), vector data (rivers, roads, settlements, fronts), and the strategic graph, shared by both layers.

Every unit exists at one of three fidelity levels:

- **Aggregate:** a formation, flight, or convoy with a position, strength, supply, and orders. Always simulated, cheaply.
- **Entity:** individual vehicles, aircraft, and infantry squads with positions, simple behaviors, and damage states. Simulated only inside a **promotion bubble** around the player's aircraft or the camera.
- **Full:** physical simulation, used only for the aircraft the player flies.

Promotion expands an aggregate deterministically from its seed and current strength. Demotion folds entity losses back into aggregate strength, so a tank company the player destroyed stays destroyed.

The renderer uses **camera-relative rendering**: positions are float64 on the CPU, and we subtract the camera position before uploading to the GPU.

## Time

The simulation combines two clocks:

- **Discrete events** for anything with a predictable outcome. Flight and convoy positions follow analytically from their routes and departure times. Takeoffs, arrivals, mission phase changes, and engagement starts are scheduled events.
- **Fixed ticks** for processes that need iteration: aggregate ground combat (one tick per game minute), front movement, the command layer's replanning (every few game hours), and later the economy. Entity simulation inside the promotion bubble ticks at 10 to 30 Hz of game time.

Under acceleration, the simulation processes more events and ticks per real second, so the aggregate outcome stays the same at 1× and 64×. Above about 16×, the promotion bubble collapses. Above about 256×, the view falls back to icons.

- **Auto-slowdown:** the simulation drops to 1× on events the player has subscribed to (see *Mission Search and Jump-In*).
- **Cockpit cap:** while the player flies, acceleration is limited to cruise phases (up to 8×) and cancels on any threat.

## Planet Parameters

| Parameter | Default | Effect |
|---|---|---|
| Seed | random | Reproducible worlds |
| Radius | 1,000 km | Strategic depth |
| Plate count | 14 | Number and size of landmasses |
| Ocean fraction | 0.55 | Sea level, set by height percentile |
| Erosion strength | 1.0 | Erosion iterations and sediment capacity |
| Temperature offset | 0 °C | Ice age to hothouse |
| Moisture scale | 1.0 | Arid to lush |

The planet parameters shape the kind of war indirectly. Few plates with a low ocean fraction tend toward a supercontinent and a land war; many plates with a high ocean fraction tend toward archipelagos and an island campaign. The parameters never select a scenario directly.

## World Generation Pipeline

Each stage feeds the next, so features have causes.

1. **Cube-sphere grid.** Six cube faces projected onto the sphere.
2. **Tectonic plates.** Seed points grow into plates by flood fill, with types and drift vectors drawn from `rng("plates")` and no steering. Convergent continental boundaries raise mountain ranges, convergent oceanic boundaries form trenches and island arcs, and divergent boundaries form rifts and mid-ocean ridges.
3. **Detail noise.** Ridged multifractal noise amplified by uplift, plus domain warping on coastlines and ridges.
4. **Hydraulic and thermal erosion.** A GPU compute pass carves drainage networks and canyons and lays down alluvial plains.
5. **Climate and biomes.** Temperature from latitude and altitude; moisture from prevailing-wind bands with rain shadows; biomes from a Whittaker-style table in a stylized palette.
6. **Rivers.** Flow accumulation from erosion, thresholded into a river network with widths.
7. **Validity check.** The world must have enough flat land to host at least 15 airbases per side and must support at least one theater above its fit threshold. Worlds that fail derive a new sub-seed and regenerate. The retry sequence is seeded, so each seed still maps to exactly one world. In practice only extreme parameters (nearly all ocean) trigger it.
8. **Strategic graph.** See *Reading the World*.
9. **Theater detection and casting.** See *Theaters* and *Casting*.
10. **Settlements, roads, ports, and airbases**, placed according to the cast.

A coarse pass at 256 × 256 per face runs steps 1 to 9 in about a second. Only the full pass bakes the high-resolution maps. We cache baked maps, vector data, and the cast in IndexedDB.

## Reading the World: The Strategic Graph

The strategic graph abstracts the generated world into the terms a commander uses. Theater detection, casting, and the command layer all query the graph; none of them read the heightmap directly.

- **Landmass nodes.** Every landmass above about 2,000 km². Smaller islands within strike range of each other merge into **archipelago nodes**. Attributes: area, centroid, terrain mix, coastline length, candidate port sites, airbase capacity (flat, low land), and the best barrier lines across it.
- **Sea lane edges.** Between pairs of landmass nodes, a least-cost route over a coarse ocean grid from port site to port site, with its length and the minimum width of water along it.
- **Chokepoints.** Places where a sea lane passes through a narrow strait (under about 150 km) or within about 300 km of an island that could host an airfield. Each chokepoint records which sea lanes it controls.
- **Barrier lines.** For each large landmass, the coast-to-coast lines of high barrier strength (rivers, ridges, forest) found by the front generator described below.

A debug overlay draws the graph on the globe. It is the most important tool for judging whether theater detection makes sense.

## Theaters

A theater is a module with a precondition on the strategic graph, a fit score, and a set of things it instantiates. One world usually supports several theaters, and the campaign links them through logistics flows: a cut sea lane starves a continental front, and a lost chokepoint island exposes the convoys behind it.

| Theater | Detected when | Instantiates |
|---|---|---|
| **Continental front** | A landmass large enough to split along a barrier line with both sides holding at least 35% of its area | Start line, defensive lines, invasion corridors, ground formations, dense airbases behind the front |
| **Sea lane** | A landmass that can serve as a rear base, connected to a continental front by a sea lane of 800 to 3,000 km | Convoy routes, ports, maritime patrol, anti-shipping strikes, convoy escort |
| **Chokepoint** | A chokepoint on an active sea lane | Island garrison, forward airfield, seizure and defense operations |
| **Island campaign** | Several archipelago or small landmass nodes within mutual strike range and no landmass large enough for a front | Island airfields, carrier groups, amphibious groups, island assaults |
| **Strategic** | Always, once both sides have industry | Industrial and logistics targets, air defense belts, strategic bomber missions |

Two examples show how this plays out. A two-continent world with an island chain between them yields a continental front, a sea lane, a chokepoint, and the strategic theater: the full *Red Storm Rising* war. A supercontinent yields a continental front and the strategic theater only, a Central Front war with deep strikes into the interior. An archipelago world yields an island campaign and the strategic theater, a war of carriers and island airfields that plays more like the Falklands or the Pacific.

### Automatic Front Line

The continental front theater uses the front generator. For each land cell, we compute barrier strength from river width, slope, ridge prominence, and forest density. A constrained shortest-path search finds coast-to-coast paths that maximize barrier strength while splitting the landmass within the required area ratio, repeated with exclusion corridors to yield three or four roughly parallel defensive lines. The start line sits one line forward of the strongest barrier, so the defender starts exposed and has a strong position to fall back to. Weak, well-roaded segments of each line become invasion corridors.

## Casting

Casting turns the detected theaters into a campaign. It draws from `rng("casting")` and never asks the player.

1. **Select theaters.** Keep every theater above its fit threshold.
2. **Assign territory.** The Pact receives mass and interior lines: the larger side of each front, the landmass farthest from the sea lanes, the larger island cluster. The Alliance receives the side adjacent to its rear base and its sea lanes. In island campaigns the Alliance holds a dispersed island network and the Pact assembles the armada.
3. **Set posture.** By default the Pact attacks and the Alliance defends in every theater.
4. **Set the range factor** as described in *Scale and Range*.
5. **Place industry, ports, and bases** for each side, consistent with its territory and theaters.
6. **Write the briefing.** A generated summary of the war the world produced: the theaters, the stakes in each, and the first expected moves.

Casting runs before the player picks a side, and the cast does not depend on that choice. The same seed always produces the same war, and it unfolds identically until the player intervenes.

## Factions and Sides

The Alliance and the Pact use fictional aircraft and vehicles with their own names and silhouettes. Real Cold War types serve as design references for performance, role, and doctrine:

| Role | Alliance reference | Pact reference |
|---|---|---|
| Air superiority | F-15, F-14 | Su-27, MiG-29 |
| Multirole fighter | F-16, F/A-18 | MiG-23, MiG-29 |
| Low-level penetration strike | F-111, Tornado IDS | Su-24 |
| Carrier all-weather attack | A-6 | None |
| Stealth strike | F-117 | None |
| Close air support | A-10 | Su-25 |
| Attack helicopter | AH-64 | Mi-24, Mi-28 |
| SEAD | F-4G | Su-24 with anti-radar missiles |
| Strategic and maritime bomber | B-52 | Tu-95, Tu-22M |
| Airborne early warning | E-3 | A-50 |
| Tanker | KC-135 | Il-78 |
| Tactical airlift | C-130 | An-12 |
| Heavy helicopter | CH-47 | Mi-26 |
| Reconnaissance | RF-4 | MiG-25R |

The F-111, A-6, and Su-24 references share a side-by-side cockpit with a pilot and a weapon systems officer or bombardier/navigator. Their analogues keep that layout, which matters for the later cockpit mode: the player flies while an AI crewmate runs the radar, navigation, and weapons, and calls out targets and threats. Taking the right-hand seat while the AI flies is a possible later variant.

The table contains two deliberate asymmetries. The A-6 analogue flies only from Alliance carriers, so it appears wherever the cast contains carrier groups. The F-117 analogue is a rare late-war asset with a small fleet, flying single-ship night strikes against the most heavily defended targets. The Pact has no counterpart and relies on mass and SEAD instead. Stealth requires a radar cross-section per aircraft type in the air defense model, which every aircraft gets anyway.

The two sides also differ in doctrine. Pact flights depend more on ground-controlled interception and fly in larger, more tightly controlled formations. Alliance flights rely on AWACS and have more autonomy. These differences live in the command layer and in mission templates, so both sides use the same simulation code.

## Air Tasking

Each side's command layer produces an **air tasking order** (ATO) for each game day and revises it every few game hours. The planner is rule-based and deliberately simple:

1. **Collect needs** from each theater: front segments under pressure need CAS, high-value assets need CAP, enemy logistics and air defenses need strikes, bases low on stock need resupply, convoys need escort or attack.
2. **Rank needs** by a priority score that combines theater weights, target value, and urgency.
3. **Build packages.** Assign flights from squadrons within range, adding escort and SEAD to strikes when the target area is defended.
4. **Schedule** missions so that the result matches the doctrine of the side: Pact strikes in large waves, Alliance missions spread more evenly.

The planner never searches or learns. It must produce a plausible war, and its decisions must be legible to a player browsing missions.

### Mission Types

| Mission | Typical aircraft | Notes |
|---|---|---|
| Combat air patrol | Air superiority, multirole | Station over front, base, or convoy |
| Fighter sweep | Air superiority | Offensive counter-air ahead of strike waves |
| Escort | Air superiority, multirole | Attached to a strike package |
| Interdiction | Multirole, strike | Bridges, roads, rail, supply columns behind the front |
| Low-level penetration strike | F-111, A-6, and Su-24 analogues | Deep targets at night or in bad weather, terrain-following; A-6 analogue from carriers |
| Stealth strike | F-117 analogue | Single-ship night strikes on heavily defended high-value targets; Alliance only |
| SEAD | F-4G analogue | Suppresses air defenses for a package |
| Close air support | A-10 and Su-25 analogues | Front segments under pressure |
| Attack helicopter CAS | AH-64 and Mi-24 analogues | Short range, terrain masking, close to the front |
| Anti-shipping | Maritime bombers, strike | Convoys, carrier groups, amphibious groups |
| Strategic bombing | Strategic bombers | Industry and logistics hubs |
| Reconnaissance | RF-4 and MiG-25R analogues | Reveals targets for later strikes |
| Support | AWACS, tankers | Long stations; joinable but rarely eventful |
| Airlift resupply | Tactical airlift | Base to base |
| Combat airdrop | Tactical airlift | Paratroops or supplies over a drop zone |
| Sling-load resupply | Heavy helicopters | Forward positions and island outposts |

Each mission records its type, side, theater, package, target or station, and a timeline of phases: departure, climb-out, ingress, fence-in, on target or on station, egress, approach, and recovery.

## Mission Search and Jump-In

Mission search is the player's main interface to the war. A panel lists the ongoing and upcoming missions of the player's side, with filters for mission type, aircraft, theater, current phase, threat level, and time until action ("on target in under 5 minutes"). Selecting a mission focuses the camera on it; a second action jumps into one of its aircraft.

- **Jump-in window.** A mission accepts the player from climb-out until approach. Takeoff and landing stay with the AI, so joining puts the player in the air with the package already formed.
- **Handback.** Leaving an aircraft returns it to the AI with its current orders, at any phase.
- **Subscriptions.** The player can subscribe to a query, such as "next attack helicopter CAS in corridor 2" or "any strike on our airbases". When a matching mission reaches the chosen phase, auto-slowdown drops time to 1× and offers the jump. Subscriptions combine time acceleration and search into one loop: accelerate, get notified, jump in.

For the demo, the panel and chase camera are in scope. Jumping into the cockpit comes after.

## The Ground War

The ground war exists wherever the cast contains a continental front, chokepoint, or island campaign. AI controls it entirely. The player shapes it from the air.

- **Order of battle.** Divisions contain brigades or regiments, which contain battalions. Battalions are the aggregate unit: type (tank, mechanized infantry, motorized infantry, artillery, air defense, logistics), strength, supply, and posture.
- **Aggregate combat.** Lanchester-style attrition each tick, modified by terrain, posture, supply, artillery, and air support. Interdiction cuts supply; CAS reduces strength directly.
- **Entities.** Inside the promotion bubble, battalions expand into tank and IFV platoons, infantry squads with MANPADS teams, artillery, short-range air defense, and logistics columns on roads. Air defense entities matter most, since they decide whether an attack run survives.
- **Line of sight.** Attack helicopters fight by terrain masking, so line-of-sight queries use the high-resolution heightmap and forest cover, batched on the GPU within the bubble.

The demo shows battalions as unit symbols moving along the front under the aggregate model. Entity promotion comes later, but the data model supports it from the start.

## Naval Forces

Convoys, carrier groups, and amphibious groups exist wherever the cast contains a sea lane, chokepoint, or island campaign. AI controls them. They are targets and protectees for air missions, and convoy arrivals deliver reinforcements and supplies to the receiving theater. The demo shows them as aggregate units on analytic sea routes. Naval combat comes later.

## Rendering

- **Terrain LOD.** A quadtree per cube face, refined by screen-space error, with skirts to hide cracks. High-resolution regional bakes replace the global bake where available.
- **Shading.** Biome color blended by slope, altitude, and moisture, with triplanar mapping on cliffs. Rivers and roads render from vector data.
- **Forests.** Instanced low-poly tree clusters within about 5 km of the camera, from a density map the line-of-sight system also uses.
- **Settlements.** Clusters of low-poly buildings scaled by population.
- **Ocean.** Depth-based color, a wave normal map, and coastal foam.
- **Atmosphere.** Single-scattering shader for the limb glow and aerial perspective.
- **Clouds (stretch).** A 2D cloud shell driven by the moisture map.
- **Strategic overlays.** Theater boundaries, fronts, sea lanes, chokepoints, and mission routes, drawn from orbit.

## Milestones

1. **Globe skeleton.** Cube-sphere, unsteered plates, uplift, biome coloring, orbit camera, parameter sliders.
2. **Erosion, rivers, LOD.** GPU erosion, river extraction, quadtree terrain, flyable down to 500 m.
3. **Atmosphere, ocean, forests.** The milestone where the planet becomes memorable.
4. **Reading the world.** Validity check, strategic graph, front generator, theater detection, casting, briefing text, and the graph debug overlay. Add a seed browser that lists the theaters each seed produces, to check detection across many worlds.
5. **Settlements, roads, ports, airbases**, placed from the cast.
6. **Simulation core.** Worker-based simulation with event scheduler, fixed ticks, and time acceleration.
7. **Air tasking and mission search.** Rule-based ATO for both sides, mission model and phases, flights on routes, the search panel with filters and subscriptions, and the chase camera.
8. **Ground and naval aggregates.** Battalions with aggregate combat along fronts; convoys and naval groups on sea routes.
9. **Polish.** Generation caching, performance pass, side selection at campaign start, a short flythrough for screenshots.

**After the demo:** entity promotion and ground behaviors, cockpit flight, flight stick support, air combat, naval combat, the campaign economy.

## Open Questions

- **Aggressor.** Should the Pact always attack, or should casting occasionally reverse the roles when the geography favors an Alliance offensive?
- **Side switching.** Is the side fixed for a campaign, or can the player switch at any time?
- **Thresholds.** What are the right fit thresholds for each theater? The seed browser in milestone 4 will tell us how often each theater appears.
- **Range factor.** Does the per-world range factor feel right? We should fly representative sorties once milestone 7 works.

## Later (Out of Scope)

Campaign economy with factories, resources, pilot training, and resupply; air defense networks; cockpit flight and flight stick support; CSAR missions; carriers, surface combatants, and submarines in combat; multiplayer.