# Bearing: Tech Demo Design Doc

*Draft of 2026-11-09, revision 3.*

## Vision

Bearing pits fictional analogues of NATO and the Warsaw Pact against each other in a late-Cold-War war on a procedurally generated, Earth-like planet. Fourth-generation fighters, bombers, attack aircraft, attack helicopters, AWACS, tankers, and transports fly over a ground war with a real front line, while convoys carry reinforcements across an ocean from a second continent. The war runs continuously. An AI command layer plans and flies sorties whether or not the player intervenes, and the player watches from orbit, accelerates time, and drops into any airborne unit at any moment. The tone we're aiming for is *Red Storm Rising*: a defender falling back under a massive offensive, trading space for time while holding open the sea lanes that bring reinforcements.

This document covers the **tech demo** in detail and sketches the ground and naval systems that the demo's architecture must support.

## Decisions So Far

- **Name:** Bearing.
- **Planet:** Earth-like, about 1,000 km radius, generated entirely from a seed.
- **Geography:** A main continent split between the two factions, plus a second continent across an ocean that supplies the defender by convoy.
- **Front line:** Chosen automatically along natural barriers (rivers, mountain ranges).
- **Ranges:** Aircraft ranges compressed by a common factor; speeds stay real.
- **Ground war:** A moving front with tanks, infantry, artillery, and air defenses. The player cannot command these units but can attack them from attack aircraft and helicopters.
- **Airbases:** Density modeled on Cold War Central Europe.
- **Time:** Variable time acceleration from the first demo.

## Demo Goals

1. Generate a planet that satisfies the geography constraints from any seed in under 30 seconds on a mid-range laptop.
2. Produce terrain with geological structure: continents, oceans, mountain ranges, canyons, plains, rivers, and distinct biomes.
3. Render the planet continuously from orbit to 500 m altitude without visible seams or distracting popping.
4. Choose a front line, defensive lines, and invasion corridors automatically.
5. Place airbases, settlements, and roads, and fly 20 to 50 aircraft between bases.
6. Show ground formations moving along the front under a scripted offensive.
7. Run at 1× to at least 64× time acceleration without the simulation diverging.
8. Run in a desktop browser.

**Non-goals for the demo:** cockpit flight, combat between individual entities, the campaign economy, naval units, sound, and multiplayer.

## Scale and Range

Planet size sets strategic depth. We keep a radius of about **1,000 km**, which gives a maximum distance of about 3,100 km and a surface area of about 12.6 million km². To restore the strategic depth a real Cold War theater had, we **compress aircraft ranges** by a common factor (initially 0.5) by scaling fuel capacity and burn rate. Speeds, climb rates, and weapon ranges stay real, so the cockpit feels right and air combat geometry stays authentic. Compressed ranges also shorten sorties, which helps pacing: a deep strike that took four hours over Europe takes about two over Bearing.

The same logic applies at sea. An ocean 1,200 to 1,800 km wide gives a convoy at 15 knots a crossing of two to three days of game time, long enough for a campaign of interdiction and escort.

At 4096 × 4096 texels per cube face, this radius gives about 380 m per texel. Shader detail noise covers the gap at low altitude. We run a second, higher-resolution bake (about 50 m per texel) over the main continent's contested region, where ground combat and low-level flight happen.

## Technology

We recommend **TypeScript + Three.js with the WebGPU renderer**, built with Vite. WebGPU ships in all major desktop browsers, and its compute shaders let us run erosion, terrain baking, and line-of-sight queries on the GPU. A Gamepad API binding later gives us flight stick support with no engine dependency. Long-running CPU tasks run in Web Workers so the render loop never stalls.

## Architecture

The architecture separates **simulation** from **presentation**.

- **Simulation layer.** A headless model of the world: formations, entities, flights, convoys, airbases, the front line, and (later) the campaign economy. It runs in a worker and knows nothing about rendering.
- **Presentation layer.** Cameras and renderers that read simulation state. The orbit view and the future cockpit view are two cameras on the same world.
- **World data.** Baked planet maps (height, biome, moisture, temperature, flow) plus vector data (rivers, roads, settlements, the front line), shared by both layers.

The design rests on one principle: **fidelity is a level of detail, in both space and time.** The renderer refines terrain where the camera looks. The simulation refines units where the player looks and coarsens them when time runs fast. Every unit exists at one of three levels:

- **Aggregate:** a formation, flight, or convoy with a position, strength, supply, and orders. Always simulated, cheaply.
- **Entity:** individual vehicles, aircraft, and infantry squads with positions, simple behaviors, and damage states. Simulated only inside a **promotion bubble** around the player's unit or the camera.
- **Full:** physical simulation (flight dynamics, weapons ballistics), used only for the unit the player controls.

Promotion and demotion must be lossless in the direction that matters. When a battalion promotes, it expands into entities deterministically from its seed and its current strength. When it demotes, the simulation folds entity losses back into aggregate strength. A tank company the player destroyed stays destroyed.

Planet-scale coordinates exceed 32-bit float precision, so the renderer uses **camera-relative rendering**: we store positions in 64-bit doubles on the CPU and subtract the camera position before uploading to the GPU.

## Time

The simulation combines two clocks:

- **Discrete events** for anything with a predictable outcome. Flight and convoy positions follow analytically from their routes and departure times. Takeoffs, arrivals, refueling, and engagement starts are scheduled events.
- **Fixed ticks** for processes that need iteration: aggregate ground combat (1 tick per game minute), front-line movement, and later the economy. Entity-level simulation inside the promotion bubble ticks faster (10 to 30 Hz of game time).

Under acceleration, the simulation processes more events and ticks per real second. Because routes are analytic and ticks have fixed game-time length, the aggregate outcome stays the same at 1× and 64×. Above about 16×, the promotion bubble collapses and everything runs at the aggregate level; above about 256×, the view falls back to icons only.

Two rules borrowed from wargames like *Harpoon* keep acceleration usable:

- **Auto-slowdown:** the simulation drops to 1× on events the player has flagged, such as a raid detected, a convoy under attack, or a breakthrough on the front.
- **Cockpit cap:** when the player flies a unit, acceleration is limited to cruise phases (up to 8×) and cancels on any threat.

## Planet Parameters

| Parameter | Default | Effect |
|---|---|---|
| Seed | random | Reproducible worlds |
| Radius | 1,000 km | Strategic depth |
| Range factor | 0.5 | Scales aircraft fuel, not speed |
| Plate count | 14 | Number and size of landmasses |
| Ocean fraction | 0.55 | Sea level, set by height percentile |
| Ocean gap | 1,200–1,800 km | Width between the two continents |
| Erosion strength | 1.0 | Erosion iterations and sediment capacity |
| Temperature offset | 0 °C | Ice age to hothouse |
| Moisture scale | 1.0 | Arid to lush |

## World Generation Pipeline

Each stage feeds the next, so features have causes. The pipeline runs in two passes. A **coarse pass** at 256 × 256 per face takes about a second and lets us check the geography constraints. If the coarse world fails a check, we derive a new sub-seed and retry. Only an accepted world goes through the **full pass**. Players see a deterministic world per seed, since the retry sequence is itself seeded.

1. **Cube-sphere grid.** Six cube faces projected onto the sphere.
2. **Tectonic plates.** Seed points grow into plates by flood fill. We steer the seeding: two large continental plate clusters, roughly 90 to 130 degrees of arc apart, with oceanic plates between them. Convergent continental boundaries raise mountain ranges, convergent oceanic boundaries form trenches and island arcs, and divergent boundaries form mid-ocean ridges. A ridge crossing the ocean gap can surface as an island chain, which gives us a GIUK-gap analogue for free.
3. **Detail noise.** Ridged multifractal noise, amplified where uplift is high, plus domain warping on coastlines and ridges.
4. **Hydraulic and thermal erosion.** A GPU compute pass carves drainage networks and canyons and lays down alluvial plains.
5. **Climate and biomes.** Temperature from latitude and altitude; moisture from prevailing-wind bands, with rain shadows behind mountains; biomes from a Whittaker-style table in a stylized palette.
6. **Rivers.** Flow accumulation from erosion, thresholded into a river network with a width per segment.
7. **Geography check.** Identify the two largest landmasses, measure the ocean gap between them, and confirm that the main continent is large enough to hold a front with depth on both sides. Reject and retry if not.
8. **Front line.** See below.
9. **Settlements and roads.** Place cities at river confluences, coasts, and fertile lowlands, with ports on the coasts facing the ocean gap. Connect them with a road network computed as least-cost paths over a slope-and-terrain cost map, merged where paths overlap. Roads cross rivers at bridges, which become targets.
10. **Airbases.** Place bases on flat, low terrain near roads, densest 100 to 400 km behind the front and sparser in the rear, plus strategic bomber bases far from the front.

We cache the baked maps and vector data in IndexedDB.

## Automatic Front Line

The front generator answers three questions for the main continent: where the border runs, where the defender can fall back to, and where the attacker will push. NATO's planning for Central Europe followed the same pattern, with the inner German border as the start line, successive river lines as defensive positions, and corridors such as the Fulda Gap and the North German Plain as expected axes of attack.

**Barrier map.** For each land cell, we compute a barrier strength from river width, slope, ridge prominence, and forest density. Wide rivers and mountain ridges score high; open plains score low.

**Defensive lines.** We find coast-to-coast paths across the main continent that maximize barrier strength along their length. Concretely, we run a shortest-path search on the cell graph with edge cost inversely related to barrier strength, constrained so that the path splits the continent into two parts with an area ratio between 35/65 and 50/50 (the attacker gets the larger share). We take the best path and then repeat, excluding a corridor around previous results, to get three or four roughly parallel lines.

**Start line.** We place the initial border one line forward of the strongest barrier, so the defender starts in exposed terrain and has a strong position to fall back to. This produces the *Red Storm Rising* dynamic of an early retreat to a defensible line.

**Invasion corridors.** Along each defensive line, segments with low barrier strength and good road access become corridors. The Pact AI concentrates its offensive there, and the NATO AI concentrates its reserves there. We mark them on the strategic map.

**Faction placement.** NATO holds the part of the main continent closer to the second continent, so convoys arrive at its ports. The Pact holds the far side and the interior.

## The Ground War

The ground war needs individual tanks and infantry because attack aircraft and helicopters fight them directly. It follows the same fidelity levels as everything else.

**Order of battle.** Divisions contain brigades or regiments, which contain battalions. Battalions form the aggregate unit of simulation. Each battalion has a type (tank, mechanized infantry, motorized infantry, artillery, air defense, logistics), a strength, a supply level, and a posture (attack, defend, delay, retreat, reserve).

**Aggregate combat.** Opposing battalions in contact resolve combat each tick with a Lanchester-style attrition model, modified by terrain, posture, supply, artillery support, and air support. Front segments move according to the local balance of force, slowed by barriers. Air interdiction cuts supply; close air support and battlefield air interdiction reduce strength directly. This coupling is how the air war decides the ground war.

**Entity types.** When a battalion promotes, it expands into vehicles and squads:

- Main battle tanks and infantry fighting vehicles, in platoons.
- Dismounted infantry squads, including MANPADS teams.
- Self-propelled and towed artillery, and rocket launchers.
- Short-range air defense: radar-guided gun systems (Shilka and Gepard analogues) and short-range SAMs.
- Trucks and fuel tankers in logistics columns on roads.

**Entity behavior.** Entities follow simple behaviors: move in formation along roads or across terrain, halt in treelines, engage targets in range and line of sight, scatter under air attack. Air defense entities matter most to the player, since they decide whether an attack run survives.

**Line of sight.** Helicopters fight by terrain masking: popping up from behind a ridge or treeline, firing, and dropping back. Line-of-sight queries must therefore account for the high-resolution heightmap and forest cover. We batch these queries on the GPU within the promotion bubble.

**Promotion bubble.** About 15 to 25 km around the player's aircraft or the camera, capped at a few hundred entities. Beyond it, the battle continues at the aggregate level.

**Demo scope.** The demo shows battalions as NATO-style unit symbols moving along the front under a scripted offensive, with the defensive lines and corridors drawn on the map. Entity promotion comes after the demo, but the data model supports it from the start.

## Convoys and the Second Continent

Convoys leave ports on the second continent, cross the ocean gap, and unload at NATO ports on the main continent. Each convoy carries reinforcements (fresh battalions, aircraft, munitions) that enter the ground and air simulation on arrival. The Pact tries to cut this lifeline with long-range bombers carrying anti-ship missiles (Backfire analogues) and, later, submarines; NATO escorts with fighters, maritime patrol aircraft, carriers, and surface escorts.

For the demo, convoys appear as aggregate units on great-circle sea routes with analytic positions, like flights. Naval combat comes later.

## Rendering

- **Terrain LOD.** A quadtree per cube face, refined by screen-space error, with skirts to hide cracks. The high-resolution regional bake replaces the global bake where available.
- **Shading.** Biome color blended by slope (rock), altitude (snow), and moisture, with triplanar mapping on cliffs. Rivers and roads render from vector data as decals or a mask texture.
- **Forests.** Instanced low-poly tree clusters within about 5 km of the camera, placed by a density map that the line-of-sight system also uses.
- **Settlements.** Clusters of low-poly buildings around city centers, scaled by population.
- **Ocean.** Depth-based color, a wave normal map, and coastal foam.
- **Atmosphere.** Single-scattering shader for the limb glow and aerial perspective.
- **Clouds (stretch).** A 2D cloud shell driven by the moisture map.

## Units in the Demo

- **Flights and convoys.** Analytic great-circle routes with climb and descent for aircraft.
- **Formations.** Unit symbols along the front, moving under the aggregate combat model.
- **Display.** Faction-colored icons and route lines from orbit; low-poly aircraft and ship meshes below about 50 km altitude.
- **Camera.** Orbit-and-zoom with the mouse, with a smooth transition to a chase camera when the player selects a flight.
- **Time controls.** Pause, 1×, 4×, 16×, 64×, 256×, with auto-slowdown on flagged events.

## Milestones

1. **Globe skeleton.** Cube-sphere, steered plates, uplift, biome coloring, orbit camera, parameter sliders.
2. **Erosion, rivers, LOD.** GPU erosion, river extraction, quadtree terrain, flyable down to 500 m.
3. **Atmosphere, ocean, forests.** The milestone where the planet becomes memorable.
4. **Geography and front.** Coarse-pass constraint checks, barrier map, defensive lines, start line, corridors.
5. **Settlements, roads, airbases.**
6. **Simulation core.** Worker-based simulation with event scheduler, fixed ticks, and time acceleration.
7. **Flights, convoys, formations.** Scheduled flights and convoys, battalions with aggregate combat, a scripted offensive.
8. **Polish.** Generation caching, performance pass, a short flythrough for screenshots.

**After the demo:** entity promotion and ground behaviors, cockpit flight for attack aircraft and helicopters, air combat, naval combat, the campaign economy.

## Open Questions

- What range factor feels right? We should tune it by flying a few representative sorties once the simulation exists.
- How much of the second continent do we simulate: a full war economy, or an abstract reinforcement pipeline that feeds its ports?
- Does the Pact have its own sea lanes to protect, or does the naval war run in one direction only?
- How many battalions can the aggregate simulation handle at 256× in a browser worker? A quick benchmark in milestone 6 will tell us whether we need to aggregate further at high speeds.

## Later (Out of Scope)

Campaign simulation with factories, resources, pilot training, and resupply; deep strikes and interdiction; air defense networks; AWACS and tankers; mission search and jump-in; cockpit flight and flight stick support; helicopter sling loads and airdrops; carriers, surface combatants, and submarines.