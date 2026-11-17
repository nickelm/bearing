# Bearing: Design Doc

*Revision 11, 2026-11-17. Adopts Proposal 0007, world diversity (`docs/proposals/0007-world-diversity.md`, decision 204); revision 10 adopted Proposal 0006, displays, status strip, master modes and AI crew (`docs/proposals/0006-displays-and-crew.md`, decision 189); revision 9 adopted Proposal 0005, terrain-adaptive networks (`docs/proposals/0005-terrain-adaptive-networks.md`, decision 161); revision 8 adopted Proposal 0002, third-person flight without cockpits (`docs/proposals/0002-third-person-flight.md`, decision 94); revision 7 adopted Proposal 0001, two views (`docs/proposals/0001-two-views.md`, decision 72); revision 6 brought in decisions 1–71. A decision that changes anything stated here updates this document in the same commit.*

## Vision

Bearing is a late-Cold-War air war on a procedurally generated, Earth-like planet. Two fictional blocs, the **Alliance** and the **Pact**, fight across whatever geography the seed produces: a single supercontinent, two continents divided by an ocean, or a scattered archipelago. Fourth-generation fighters, strike aircraft, attack helicopters, bombers, AWACS, tankers, and transports fly over a ground and naval war that runs under AI control.

The player flies. The war runs itself. At any moment the player can search the ongoing missions of their side (a CAP over the front, a low-level interdiction strike, an attack helicopter CAS sortie, a combat airdrop) and jump into any aircraft involved. When the player leaves, the AI takes the aircraft back and the mission continues. The tone we're aiming for is *Red Storm Rising*: a theater-spanning war in which air power decides whether fronts hold and convoys get through.

Bearing has no cockpits. The player flies every aircraft and helicopter from a third-person chase camera, with the aircraft near the center of the screen. A HUD overlay carries what the pilot needs while looking outside; multifunction displays docked at the screen edges carry the sensor pictures and configuration (radar, moving map, threat warning, stores), and a status strip below the aircraft carries discrete states. Master modes reconfigure all three together, as in fourth-generation fighters. The displays show only what that aircraft and its crew know. Following an AI flight and flying it use the same view: taking control changes who provides the inputs, and the screen stays the same.

The war is seen in two views of the same world. The **strategic view** is an illustrated globe in the spirit of Civilization VI and Cold War operational maps. Exaggerated relief, painted biomes, mountain and city glyphs, a road hierarchy, and labels for cities, ranges, peaks, rivers, and seas show at a glance where the front runs, which roads feed it, and how far the bombers must fly. It also shows day and night and the weather, because both shape every sortie. The **simulation view** is the faceted, low-poly world under soft cinematic light where the player flies, from the ground to about 20 km. The map is where the player plans and chooses; the simulation view is where they fly. A short transition carries the camera from one to the other.

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
- **Sides:** Alliance and Pact are both playable. The player picks a side at campaign start and keeps it for the campaign. The side is a view: the simulation never reads it.
- **Player role:** Pilot, not commander. The player does not command ground or naval forces.
- **Core loop:** Search ongoing missions, jump in, fly, hand back. No takeoff or landing by default, except in helicopters, whose missions end on the ground (decision 149).
- **Flight view:** A third-person chase camera and no cockpits. The HUD, docked displays and status strip are 2D overlays, and every item lives in exactly one of them (decision 189). AI pilots and the player share one flight director and one flight model; helicopters have their own rotor-disc model behind the same director interface (decision 149).
- **Ranges:** Aircraft ranges compressed by a factor that the casting step adapts to each world; speeds stay real.
- **Time:** Variable time acceleration from the first demo.
- **Day, night, seasons, and weather:** In demo scope. They shape air operations: night sorties, weather cancellations, seasonal snow.
- **Terrain-adaptive networks:** Rivers, roads and railways take their form from their design regime, and the terrain takes their earthworks as analytic edits, with river channels always cut last; every crossing has a bridge or culvert (decision 161).
- **World diversity:** Landform, biome and surface character are separate layers: terrain provinces and rock from tectonic history, biomes from a climate with local modifiers, surface from soil, water and disturbance. Continents have a character, regions are named zones with their own look, and each world has a handful of named natural wonders (decision 204).
- **Generation time:** No time budget. Generation may take minutes, and finished worlds are cached.
- **Hosting:** Static site on GitHub Pages. No server, no SharedArrayBuffer.

## Demo Goals

1. Generate a planet from a seed on a mid-range laptop, with per-stage progress, and cache it so each seed is generated once.
2. Produce terrain with geological structure: continents, oceans, mountain ranges, canyons, plains, rivers, and distinct biomes. Track W (decision 204) deepens this after the demo with provinces, rock, closed basins, zones and wonders.
3. Show an illustrated strategic map from the full globe down to its zoom floor (about 100 km altitude), crisp at every zoom.
4. Render a simulation view from the ground to about 20 km altitude without visible seams or distracting popping.
5. Name the world's geography (continents, seas, straits, mountain ranges, peaks, deserts, forests, rivers, lakes, corridors, roads) and label it on the map without overlaps.
6. Build a strategic graph, detect theaters, and cast a campaign for any seed that passes the validity check.
7. Place settlements and roads as world facts, then ports, airbases, and targets according to the cast.
8. Generate air tasking for both sides and fly 20 to 50 aircraft on typed missions.
9. List ongoing missions in a searchable panel, and follow any of them from the map into the simulation view with a chase camera and a read-only HUD.
10. Show ground formations along any continental front and convoys along any sea lane.
11. Run at 1× to at least 64× time acceleration without the simulation diverging.
12. Show day and night, seasons, and live weather in both views, and let weather and daylight constrain flight operations.
13. Run in a desktop browser.

**Non-goals for the demo:** player flight control, HUD, and displays (the demo has only a read-only HUD for followed flights; the Free Flight sandbox, decision 134, is the one exception), combat between individual entities, the campaign economy, naval combat, sound, and multiplayer.

## Scale and Range

We keep a radius of about **1,000 km**, which gives a maximum surface distance of about 3,100 km and a surface area of about 12.6 million km².

Since geography now varies, a fixed range factor no longer fits every world. The casting step chooses a **range factor** between 0.35 and 1.0 per campaign, so that the theaters it detected remain playable. Two targets set it: a medium strike aircraft operating from rear bases must reach the full depth of the enemy side of a front, and a long-range bomber must reach across the widest contested sea lane. The factor scales the fuel load only, and burn rates stay real, so radius scales by the factor (decision 132). Speeds, climb rates, and weapon ranges stay real.

Landmasses are scaled to the planet; landforms are not (decision 121). Regional extents follow the landmasses: proposal 0007's zones, blends and variety windows are its Earth figures times R / R_Earth (decision 205). Elevations and depths at the scale of continents, ranges and plateaus are Earth-like reference values times R / R_Earth ≈ 0.157, so the mean ocean depth is about 600 m. Hills, valleys and ridges, the relief within about 20 km of a valley floor, have Earth-scale height (decisions 121, 122): erosion carves them in reference meters, and their height above the local valley floor is multiplied by a landform gain of 12 when converting to physical meters, so mountain valleys run a kilometer or more deep. Above a soft limit, land rises at 40% of the rate. The limit belongs to the terrain province (decision 204): young collision ranges reach 8–9 km and old mountains top out near 2.5 km; until W2 lands, one limit of 6.5 km serves every range and the highest peaks end near 8 km. Climate (lapse rate, snow, tree line) uses the Earth-like elevation: the valley floor in reference meters plus the height above it in physical meters. The atmosphere, aircraft performance, and service ceilings stay real. The strategic view exaggerates relief about 4× so ranges read on the map; the simulation view shows true scale.

World data is tiled. Processes that need the whole planet (erosion, drainage, climate, rivers, the front) run on a global grid of 1024 × 1024 cells per face, about 1.5 km per cell. Below that, tiles of 256 × 256 samples, addressed by (face, level, x, y), are synthesized on demand on the GPU as a pure function of direction, down to level 7 at about 48 m. Level-7 tiles over the ground-combat regions the casting step marks serve as the high-resolution regional bake. Tiles carve the landforms finer than the global grid from its climate and relief (decision 126): branching gullies and alpine crests in mountains, layered rock with benches, cliffs, buttes and mesas where horizontally layered sedimentary rock meets a dry climate (decision 204; until W2, in all dry land), skerry islands on glaciated coasts, reefs and lagoons on warm ones (decision 129), ragged shores in dry basins (decision 130), salt lakes and white playas with pale shoreline rings in closed basins (decision 204), cliffs on headlands, beaches in coves and marshes on flat, wet ground (decision 146), meanders on lowland rivers (migrating bends with cutoffs and oxbow lakes on large ones, inside their floodplains; decision 161), deltas at the mouths of large ones, green corridors along rivers through deserts, and falls where steep rivers cross the rock layers. Each river carries a water surface that never rises downstream, from the global cells it drains through, and the tiles cut its channel to it last (decision 146). Sand and gravel bars line the banks, and fast reaches run white (decision 147). Landforms that a height field cannot hold (tower karst, sandstone pillars, sea stacks and arches, hoodoos, natural arches, basalt columns, small inselbergs) are instanced props placed by province and rock, with collision shapes for the flight model and line of sight (decision 204). Roads and railways are aligned to the tiles' relief with grades and curves by class; their embankments, cuttings and pads are analytic edits applied after the tiles' own detail, and river channels stay below every edit (decision 161).

## Technology

**TypeScript + Three.js with the WebGPU renderer and TSL shaders**, built with Vite and hosted as a static site on GitHub Pages. Compute shaders handle erosion, tile synthesis, and line-of-sight queries; world-generation kernels are plain WGSL on the render device, tested in Node on Dawn. Long-running CPU tasks run in Web Workers. Workers exchange state with `postMessage` and transferable buffers, since GitHub Pages cannot set the headers that SharedArrayBuffer requires. A Gamepad API binding gives us flight stick support after the demo (P1).

## Architecture

The architecture separates **simulation** from **presentation**.

- **Simulation layer.** A headless model of the world, running in a worker that owns the game clock. It contains two parts: a **command layer** per side that plans missions against that side's intelligence picture, and an **execution layer** that moves and resolves everything (flights, formations, convoys, bases, weather).
- **Presentation layer.** Cameras, renderers, and UI that read simulation state. Two renderers draw the same world in different visual languages:
  - The **strategic view** (`src/render/strategic/`) is an orbit camera from about 3,000 km down to a zoom floor of about 100 km, over an illustrated base map with glyphs, labels, and military overlays.
  - The **simulation view** (`src/render/sim/`) covers 0 to about 20 km with chase, target, weapon, flyby, and observer cameras. It is entered only through a unit: following a flight or jumping into one of its aircraft, both in the same chase view, or an observer camera at a base or ship. It draws terrain only within the horizon: about 200 km at 20 km altitude, plus the distance at which the tallest terrain still shows above it (about 90 km for 4 km peaks at true scale).
  - The mission search panel sits over the strategic view. A transition controller (`src/render/common/`) eases the map camera down toward a flight and dissolves through cloud into the simulation view in under two seconds, and back. Both scenes stay resident.
- **World data.** The global grid's maps (height, biome, moisture, temperature, flow, forest density), tiles synthesized from them on demand, vector data (rivers, roads, railways, settlements, fronts, and the aligned corridors and structures of decision 161), terrain edits (pads, road and rail corridors, protected river channels) that one function applies to every height query, from the meshes to the flight model's ground, and the strategic graph. Campaign logic reads only the strategic graph; the execution layer may also query terrain.

Every unit exists at one of three fidelity levels:

- **Aggregate:** a formation, flight, or convoy with a position, strength, supply, and orders. Always simulated, cheaply.
- **Entity:** individual vehicles, aircraft, and infantry squads with positions, simple behaviors, and damage states. Simulated only inside a **promotion bubble** around the player's aircraft or the simulation view's camera.
- **Full:** physical simulation, used only for the aircraft the player controls or follows, with the flight model, sensor model, and flight director (see *Flying*). Full fidelity arrives with P1; until then a followed aircraft flies its analytic route.

Promotion expands an aggregate deterministically from its seed and current strength. Demotion folds entity losses back into aggregate strength, so a tank company the player destroyed stays destroyed.

Both renderers use **camera-relative rendering**: positions are float64 on the CPU, and we subtract the camera position before uploading to the GPU.

## Time

The simulation combines two clocks:

- **Discrete events** for anything with a predictable outcome. Flight and convoy positions follow analytically from their routes and departure times. Takeoffs, arrivals, mission phase changes, and engagement starts are scheduled events.
- **Fixed ticks** for processes that need iteration: aggregate ground combat (one tick per game minute), front movement, weather (one tick per game hour), the command layer's replanning (every few game hours), and later the economy. Entity simulation inside the promotion bubble ticks at 10 to 30 Hz of game time.

Events and ticks share one priority queue ordered by game time, so their interleaving is exact. Under acceleration, the simulation processes more events and ticks per real second, so the state at a given game time is the same at 1×, 64×, and after a jump. Rates run from pause through 1×, 4×, 16× and 64× to 256×. Above about 16×, the promotion bubble collapses. At 256×, the view falls back to icons.

**Calendar and sun.** A 24-hour solar day, a 23.44° axial tilt, and a 365-day year. The sun direction is an analytic function of game time. The campaign opens in late summer in the main landmass's hemisphere and runs toward winter.

**Weather.** A synoptic model of lows and highs on a coarse cube grid (about 65 km), driven by the climate maps and the season, gives cloud cover and ceiling, visibility, precipitation from drizzle to the downpour of a storm core, thunderstorms, dust storms over arid land, temperature, and winds aloft. Flight operations and the sky on screen read the same fields. Free Flight runs the same model without the war, or a preset derived from it (clear, overcast, rain, storm, snow, fog, dust storm).

- **Auto-slowdown:** the simulation drops to 1× on events the player has subscribed to (see *Mission Search and Jump-In*).
- **Flight cap:** while the player controls an aircraft, acceleration is limited to cruise phases (up to 8×) and cancels on any threat.

## Planet Parameters

| Parameter | Default | Effect |
|---|---|---|
| Seed | random | Reproducible worlds |
| Radius | 1,000 km | Strategic depth |
| Plate count | 14 | Number and size of landmasses |
| Ocean fraction | 0.70 | Sea level, set by height percentile |
| Relief scale | 0.157 (R / R_Earth) | Elevations and depths of landmasses relative to Earth; landforms keep Earth's heights (decision 121) |
| Erosion strength | 1.0 | Erosion iterations and sediment capacity |
| Temperature offset | 0 °C | Ice age to hothouse |
| Moisture scale | 1.0 | Arid to lush |
| Axial tilt | 23.44° | Seasons |

The planet parameters shape the kind of war indirectly. Few plates with a low ocean fraction tend toward a supercontinent and a land war; many plates with a high ocean fraction tend toward archipelagos and an island campaign. The parameters never select a scenario directly.

## World Generation Pipeline

Each stage feeds the next, so features have causes.

1. **Cube-sphere grid.** Six cube faces projected onto the sphere with an equi-angular warp.
2. **Tectonic plates.** Seed points spread over the whole sphere grow into plates by flood fill, with types and drift vectors drawn from `rng("plates")` and no steering. Continental crust follows the continental plates, with coasts inside them. Convergent continental boundaries raise mountain ranges, convergent oceanic boundaries form trenches and island arcs, and divergent boundaries form rifts and mid-ocean ridges.
   - **Terrain provinces** (decision 204). From `rng("provinces")`, each boundary run gets an age (young or old), old continental plates get fossil sutures, and a few hotspots leave tracks along their plate's motion. Every land cell gets one of twelve provinces: young collision range, high plateau, old mountains, shield, basin and range, rift, volcanic arc, hotspot, sedimentary basin, karst platform, soft sediment, glaciated lowland. Provinces set the uplift profile and soft limit, the rock, and which landforms the tiles carve. Each continent, the continental crust of one plate (decision 209), gets a **character** (old shield, young mountains, dry extension, tropical platform and others) drawn from what its tectonics allow and its climate belt; it biases provinces and climate within those limits. If the two largest continents come out too similar, the smaller one's character is redrawn, at most twice, from a seeded sub-stream.
   - **Lithology** (decision 204). From `rng("lithology")`, rock by province with noise and layering: granite and gneiss, schist, sandstone, shale, limestone, basalt, volcanic ash, loess, glacial till. Rock sets erodibility and talus for erosion, soil for biomes, rock colors for shading, and gates landforms: mesas, buttes and stepped canyon walls only in layered sedimentary rock in dry climates, karst only in limestone.
3. **Detail noise.** Ridged multifractal noise amplified by uplift, plus domain warping on coastlines and ridges, on the global grid.
4. **Hydraulic and thermal erosion.** A GPU stream-power pass on the global grid carves drainage networks and canyons and lays down alluvial plains; a talus-angle pass handles thermal erosion. Where an ice age would have reached (an Earth-like annual mean below about 3 °C, spread down the valleys), valleys become U-shaped troughs with overdeepened floors, which hold long lakes behind the old ice fronts (decision 126). Erodibility and the talus angle follow the rock; glacial carving also sharpens arêtes and scoops cirques, and troughs that reach the sea become fjords (decision 204).
5. **Climate and biomes.** Temperature from latitude and altitude with a seasonal range from the axial tilt; moisture from prevailing winds with rain shadows; local modifiers for continentality, cold currents with fog deserts, precipitation seasonality, stronger orographic effects and aspect (decision 204); twenty land biomes (tropical rainforest, cloud forest, monsoon forest, mangrove, savanna, sand sea, rocky desert, red rock desert, fog desert, cold desert and steppe, Mediterranean scrub, temperate grassland, temperate deciduous forest, temperate rainforest, moorland and heath, wetland, boreal forest, tundra, alpine meadow, ice) stacked by altitude on mountains, with soil from the rock, riparian corridors and oases, interfingering ecotones and disturbance patches; forest density and tree line. Farmland stays a land-use overlay.
6. **Rivers.** Drainage recomputed exactly on the CPU after erosion (priority flood, D8), with flow accumulation thresholded into a river network with widths, and lakes. The polylines through cell centers are smoothed in plan (a Gaussian over about a cell, then corner cutting, with confluences and mouths held in place) so they leave the grid's axes (decision 165), and every river wanders gently over a few kilometers, less on steep reaches (decision 167). Each river runs on upstream from its source as a stream along its largest tributary, so rivers start high in the mountains (decision 177). Rivers then take a planform by regime: nearly straight mountain streams, migrating meanders with cutoffs and oxbow lakes on large lowland rivers inside their floodplains (Howard–Knutson migration, run once per world in the worker; decision 173) on a floodplain that a floodplain edit levels, procedural meanders on small streams, and distributaries in deltas. Each carries a water surface that never rises downstream (decisions 146, 161). Depressions fill only to the level where evaporation meets inflow: below the spill level a basin is closed (endorheic), its rivers end at a salt lake, or at a playa when nothing remains (decision 204).
7. **Feature extraction.** The maps become named-feature records, each with geometry (point, polyline, or polygon), extent, and an importance score: continents, oceans, seas, bays, straits, islands and archipelagos, mountain ranges (connected high-uplift ridge regions), peaks (local maxima by prominence), hills, deserts, major forests, wetlands, plains and plateaus, river main stems, and lakes. Polygons are rasters on the coarse grid with a label axis; oceans, seas and bays come from a watershed on the distance to land, so a constriction separates them (decision 95). Extraction runs inside the graph builder, after the land nodes and sea lanes. It also records salt flats and lists natural-wonder candidates where their conditions hold (decision 204). **Zones** of similar province and biome, 16–63 km across (the proposal's 100–400 km scaled to the planet, decision 205), with boundaries on ridges, rivers, coasts and escarpments where they exist and a look recipe each, are segmented on the eroded global grid after the global pass: they are presentation data, which campaign logic never reads.
8. **Naming.** A toponymy generator from `rng("names")` builds names from syllable inventories and phonotactic rules, with one naming flavor per cultural region, so neighboring regions' names sound different without copying real languages. For now a naming region is a land node: landmasses cycle through four flavors, archipelagos take a fifth, and water takes the flavor of the nearest land (decision 96). Generic terms complete each name: "the Varden Range", "Mount Kessar" (labeled with its height, "Mount Kessar 1,210 m"), "the Oskel Waste", "Lake Brann", "the Teller Strait". Settlements and invasion corridors ("the Kessar Gap") are named here too, and land nodes take the names of their continents, islands, and archipelagos. Zones and wonders draw from their own forks, `names/zones` and `names/wonders` ("the Varden Highlands", decision 204).
9. **Strategic graph.** See *Reading the World*. It includes the civilian geography and its hierarchy: settlements with urban extents, roads in classes (motorway, trunk, secondary) from a gravity model of the populations they connect and the traffic routed over them, railways linking major cities, ports, and industry, and bridges. Crossing sites on the rivers (narrow, straight reaches with firm banks) pull settlements toward them and set where roads cross (decision 175). Bridges are nodes of the road and rail networks at every crossing of a river that needs one, and viaducts where a railway or major road crosses a deep valley; they are typed (beam, truss, arch, viaduct, suspension), carry their span, the traffic they carry and the detour if they fall, are all targets (decision 163), and are named after their river, town or feature ("Oskel Viaduct"); rail lines and notable river reaches are named too (decision 161). Invasion corridors get names (in the tradition of the Fulda Gap), major roads get route numbers ("R4", "M12"), and notable roads through passes or along coasts get names ("the Kessar Pass Road").
10. **Theater detection and casting.** See *Theaters* and *Casting*.
11. **Validity check.** The world must hold at least 15 airbase sites in each side's territory and at least one theater besides the strategic one. The per-side count needs the cast, so the check runs after casting. Worlds that fail derive a new sub-seed and regenerate, up to eight times. The retry sequence is seeded, so each seed still maps to exactly one world.
12. **Infrastructure from the cast:** military and commercial ports, airbases, and strategic targets (factories, refineries, depots, rail yards).
13. **Alignment** (decision 161), on the eroded world after the global pass: each road and railway of the graph is aligned between fixed anchors by one router with parameters per class (maximum grade, minimum radius, earthworks against viaducts and tunnels), railways first, then major roads, then minor roads and tracks. The router reads the level-6 tiles' relief and lets switchbacks and horseshoe curves emerge; spirals come from a template where a railway cannot otherwise meet its grade. Each alignment becomes a plan of straights and arcs, a profile with vertical curves, corridor edits with banks, and a structure record for every crossing, viaduct and tunnel; each strategic bridge snaps to a crossing of the rendered river. Campaign logic never reads this step.

Feature extraction, naming, infrastructure and alignment stay headless. Label placement and glyph instancing belong to the strategic renderer.

A coarse pass at 256 × 256 per face runs steps 1 to 12 on the CPU in the worker, without erosion, in about 4 to 6 seconds per world. Campaign facts come from this pass, so they are the same on every machine. The full pass (erosion and the eroded global maps) then runs on the GPU for the seed that passed. Tiles are synthesized on demand from the global maps (see *Scale and Range*). We cache each world, with its graph and cast, in IndexedDB; tiles are cheaper to regenerate than to load.

## Reading the World: The Strategic Graph

The strategic graph abstracts the generated world into the terms a commander uses. Theater detection, casting, and the command layer all query the graph; none of them read the heightmap directly.

- **Landmass nodes.** Every landmass above about 2,000 km². Smaller islands within strike range of each other merge into **archipelago nodes**. Attributes: area, centroid, terrain mix, coastline length, candidate port sites, airbase capacity (flat, low land), and the best barrier lines across it.
- **Sea lane edges.** Between pairs of landmass nodes, a least-cost route over a coarse ocean grid from port site to port site, with its length and the minimum width of water along it.
- **Chokepoints.** Places where a sea lane passes through a narrow strait (under about 150 km) or within about 300 km of an island that could host an airfield. Each chokepoint records which sea lanes it controls.
- **Barrier lines.** For each large landmass, the coast-to-coast lines of high barrier strength (rivers, ridges, forest) found by the front generator described below.
- **Civilian geography.** Settlements with population (city, town, village), habitability and urban extent polygons; the road network in classes (motorway, trunk, secondary) from a gravity model, with numbered routes and named pass and coast roads; railways with their stations, bridges and rail yards; and bridges where roads and railways cross rivers and deep valleys, as nodes of the networks with type, span, traffic and detour, all of them targets (decisions 161, 163). Settlements, roads and railways are world facts placed before casting, so casting and invasion corridors can use them. Each side's capital, its largest settlement, follows from the cast (decision 103).
- **Salt flats and wonders** (decision 204). Salt flats, which are also natural airstrip sites; natural-wonder candidates, from which casting selects 5 to 15 per world. Zones are not in the graph: they come from the eroded world (decision 205).
- **Named features.** The named geography of pipeline steps 7 and 8 joins the graph as a feature list (kind, anchor, geometry, extent, importance, name) with raster layers for its polygons, so briefings and mission names can use it ("interdiction strike on the Kessar Pass Road"). Each land node points to its feature, and each corridor carries its name (decisions 95, 96).

A debug overlay draws the graph on the globe. It is the most important tool for judging whether theater detection makes sense. The strategic view's military overlays draw the same graph for the player.

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
5. **Mark industry, port, base, and ground-combat regions** for each side, consistent with its territory and theaters. Industry regions sit on each side's largest urban clusters. Infrastructure placement (pipeline step 12) then puts the sites inside these regions.
6. **Select the natural wonders** (decision 204). From the graph's candidates, 5 to 15, favoring those near fronts, sea lanes and airbases, drawn from `rng("wonders")` so casting's own stream is unchanged. The tiles shape them, the map labels them, and the alignment keeps roads and railways out of them.
7. **Write the briefing.** A generated summary of the war the world produced: the theaters, the stakes in each, the first expected moves, and the wonders that serve as landmarks.

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

Two-seat aircraft and helicopters keep their crews, represented by displays and callouts instead of seats (proposal 0006, decision 189). An **AI crewmate** fills each role: a radar intercept officer in the F-14 analogue; a weapon systems officer in the F-111, F-4G, Tornado and Su-24 analogues; a bombardier/navigator in the A-6 analogue; a copilot/gunner in attack helicopters; a crew chief in transport helicopters; a loadmaster in transport aircraft. Each format in a crewed aircraft has an owner, the player or the crewmate, shown on its bezel. The crewmate works only the formats it owns, with the same sensor picture and the same commands as the player; the player takes a format by using it and hands it back from a radial **crew command menu** (search a sector, lock the highest threat, find targets in an area, run terrain-following at a set clearance, slave the turret to my aim, guide me to the load). Crewmates call out contacts, locks, launches, threats, waypoints, fuel and the results of their tasks in priority order, and their skill comes from the squadron's experience and morale. In **crew station mode** the player hands the flying to the AI pilot and owns the sensor and weapon formats, still in the chase view. Attack helicopters split pilot and gunner the same way, the gunner working the gunner sight format. In the end the player can take any crew position, pilot, gunner, door gunner or systems operator, while the AI fills the others (decision 151); transport helicopters' door gunners start AI-only.

The table contains two deliberate asymmetries. The A-6 analogue flies only from Alliance carriers, so it appears wherever the cast contains carrier groups. The F-117 analogue is a rare late-war asset with a small fleet, flying single-ship night strikes against the most heavily defended targets. The Pact has no counterpart and relies on mass and SEAD instead. Stealth requires a radar cross-section per aircraft type in the air defense model, which every aircraft gets anyway.

The two sides also differ in doctrine. Pact flights depend more on ground-controlled interception and fly in larger, more tightly controlled formations. Alliance flights rely on AWACS and have more autonomy. These differences live in the command layer and in mission templates, so both sides use the same simulation code.

## Air Tasking

Each side's command layer produces an **air tasking order** (ATO) for each game day and revises it every few game hours. The planner is rule-based and deliberately simple:

1. **Collect needs** from each theater: front segments under pressure need CAS, high-value assets need CAP, enemy logistics and air defenses need strikes, bases low on stock need resupply, convoys need escort or attack.
2. **Rank needs** by a priority score that combines theater weights, target value, and urgency.
3. **Build packages.** Assign flights from squadrons within range, adding escort and SEAD to strikes when the target area is defended.
4. **Schedule** missions so that the result matches the doctrine of the side: Pact strikes in large waves, Alliance missions spread more evenly.

The planner never searches or learns. It must produce a plausible war, and its decisions must be legible to a player browsing missions: each mission records the need it serves and its score. Ties break by stable ids, and random draws come from per-side, per-day forks.

- **Known targets only.** Each side plans against its intelligence picture (see *Intelligence*), not against ground truth. Fixed installations are known from the outbreak; everything that moves must be found first.
- **Weather and daylight.** Missions are cancelled below their weather minimums, winds aloft change ground speeds, and low-level strikes favor night and bad weather.
- **Carriers.** A carrier group is a mobile base on an analytic sea route. Its air wing flies ATO missions, launching and recovering at the group's predicted position, with no deck operations.

## Intelligence

Each side keeps an intelligence picture of contacts (position, type, time last seen, confidence, source), and its confidence decays with age, fastest for moving units. Fixed installations (airbases, industry, depots, rail yards, ports) are known to both sides at the outbreak from peacetime intelligence; the picture tracks what moves and what was hit (decision 132).

- **Reconnaissance satellites** fly fixed circular orbits modeled on Cold War systems (film-return and digital imaging, radar and ELINT ocean reconnaissance, late radar imaging). Optical imaging needs daylight and clear sky. A contact carries its observation time but reaches the picture only after its delivery delay, from minutes for ocean reconnaissance to days for film return.
- **Ground radar and AWACS** give the air picture within the radar horizon and terrain masking. The air picture also drives the Pact's ground-controlled interception.
- **Reconnaissance missions** refresh contacts along their routes.

Pass times are analytic and detection rolls come from per-side forks, so the picture is identical at any time acceleration. An overlay shows the viewing side's contacts and satellite tracks.

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

Mission search is the player's main interface to the war. A panel lists the ongoing and upcoming missions of the player's side, with filters for mission type, aircraft, theater, current phase, threat level, and time until action ("on target in under 5 minutes"). Selecting a mission focuses the map on it and draws its route. *Follow* carries the camera through the transition into the simulation view, with a chase camera behind one of its aircraft; *Jump in* (after the demo) gives the player that aircraft's controls in the same chase view, so only the source of the inputs changes. Returning to the map lands the strategic camera above the flight's position.

- **Jump-in window.** A mission accepts the player from climb-out until approach. Takeoff and landing stay with the AI, so joining puts the player in the air with the package already formed.
- **Helicopter missions** (decision 149). For helicopters, landing is the mission: inserting troops, delivering a sling load, reaching a forward arming and refueling point. Their jump-in window extends over their ground phases, and the player may fly every takeoff and landing.
- **Handback.** Leaving an aircraft returns it to the AI with its current orders, at any phase.
- **Subscriptions.** The player can subscribe to a query, such as "next attack helicopter CAS in corridor 2" or "any strike on our airbases". When a matching mission reaches the chosen phase, auto-slowdown drops time to 1× and offers the jump. Subscriptions combine time acceleration and search into one loop: accelerate, get notified, jump in.

For the demo, the panel, the chase camera, and a read-only HUD are in scope. Player flight control comes after (the Piloting track).

## Flying

*Specified in `docs/proposals/0002-third-person-flight.md` (decision 94), for helicopters `docs/proposals/0004-helicopter-flight.md` (decision 149), and for the displays, status strip, master modes and crews `docs/proposals/0006-displays-and-crew.md` (decision 189; the plan is `docs/plans/displays.md`); `docs/visual-style.md`, Part I, covers the controlled aircraft's model and the look of the HUD and displays.*

- **Camera rig.** A chase camera behind and slightly above the aircraft, attached through a spring-damper so it lags behind rolls, pitch changes, and acceleration while keeping the aircraft near the center of the screen. Each aircraft class gets its own offsets and damping. Free look orbits the camera while the right mouse button (or a key) is held and stays where it is left until the player recenters it; the mouse wheel moves the camera closer or farther while looking (decisions 160, 198). A target camera keeps the aircraft and the selected target in frame, a weapon camera can follow a released missile or bomb, and flyby and cinematic cameras serve transitions, replays, and idle spectating. The camera raycasts against the height map, never clips terrain, and lowers and closes in at low altitude.
- **Flight director and controls.** The flight director is an autopilot that turns a desired direction and speed into control inputs for the flight model. With mouse aim (the default), the mouse steers an aim point in the world and the flight director flies toward it; with direct control, the keyboard, the captured mouse's offset from the screen's center, or a flight stick drive the control surfaces through a stability augmentation layer (decision 198). AI pilots use the same flight director and the same flight model, so handback only gives the flight director an aim point from the AI's orders instead of from the mouse.
- **Flight model.** Table-driven at medium fidelity: per-type thrust, drag, lift, instantaneous and sustained turn rates, specific excess power, roll rate, and the effects of altitude, wing sweep, and stores, with energy management, stalls, and departures in simplified form. The tables live in the aircraft's JSON specification, next to its geometry and avionics profile. The ground model treats the forest canopy as an obstacle: rotor or airframe below the canopy top inside a closed stand strikes the trees, while hovering beside a tree line is safe (decision 148).
- **Helicopters** (decision 149, proposal 0004). A rotor-disc model of medium fidelity beside the fixed-wing one: cyclic tilts the thrust disc with a flapping lag, hub stiffness (teetering, articulated, hingeless) sets low-g behavior, power required follows the bucket with translational lift and ground effect, a tail rotor of limited authority counters torque, and retreating blade stall, vortex ring state, mast bumping, autorotation and tail rotor loss are modeled hazards. Three control modes feed the same flight director: fly-by-mouse (the default; the mouse's horizontal motion yaws in the hover and banks into a coordinated turn in cruise), mouse aim for gun and rocket runs, and direct control for sticks. Assists toggle one by one under three presets (Assisted, Standard, Expert); switching one off removes protection, never a capability. The helicopter HUD adds hover symbology (a ground-plane velocity vector with an acceleration cue, radar altitude, torque, rotor RPM, landing zone marker, hazard cues), and the helicopter camera rig sits closer and higher and lifts and tilts down as airspeed falls.
- **Allocation.** Every item lives in exactly one place: the **HUD** (spatial and time-critical information used while looking outside), a **display** (sensor pictures, selection, configuration, planning) or the **status strip** (discrete states and warnings). A new item takes its place by that rule (decision 189).
- **HUD.** World-anchored symbols are projected from the scene every frame (flight path marker, boresight, gun pipper, CCIP fall lines, target boxes, waypoint diamonds, seeker circles); screen-anchored instruments sit at fixed positions (airspeed, altitude, and heading tapes, a compact attitude indicator instead of a pitch ladder, Mach, G, the throttle). Warnings that demand an immediate maneuver, such as PULL UP, stay on the HUD.
- **Displays.** Five docked slots with fixed positions and bindings in every aircraft: a large multifunction display lower left and lower right, a small threat display upper right, a small messages display upper left, and the status strip at bottom center. The middle 60% of the screen belongs to the aircraft and the HUD. Each slot is expanded, collapsed to a tab or hidden; slots never move, a pinned slot keeps its format in every mode, and an alert may bring a format forward in its own slot. Every display uses one frame, a square screen with bezel buttons. Its formats are the air-to-air and air-to-ground radars (with the terrain-following scope), stores, a moving map (in the strategic view's illustrated style, or by elevation with a mode relative to the aircraft's altitude), targeting pod, threat warning, comms, engines and fuel, mission, crew, and for helicopters the hook camera and torque and rotor gauges at the end of the strip. A format has the same layout and buttons wherever it exists, and an aircraft has a format only if it carries the system behind it; its avionics profile lists its slots and formats. Datalink tracks from AWACS or ground control appear on the moving map and the radar. The Su-27 analogue alone also shows its radar in the HUD.
- **Status strip.** Dark in normal flight: items appear only when relevant (parking brake, gear, speedbrake, master arm, afterburner) and warn when a state conflicts with the situation (gear up while slow and low), in green, amber and red with a label and a shape each, and a master caution acknowledges the cautions.
- **Master modes.** Ground, navigation, air-to-air, dogfight, air-to-ground, approach and, for helicopters, hover reconfigure the HUD, the slots and the strip together. They follow triggers (weight on wheels, gear down below 3,000 ft, a weapon selected, below 20 kt) or a key; each mode's slot preset can be edited once for every aircraft.
- **Cursor mode.** One key (Tab) captures and frees the mouse in every aircraft (decision 193). The free cursor clicks the bezel buttons, strip items and contacts while the flight director holds the aim point, or attitude and altitude in direct control. Keys cover the hot actions a pilot needs without looking (master modes, slot states, radar lock and designation, countermeasures, the crew menu); bezel buttons work by mouse. With a flight stick the mouse stays free.
- **Display models.** Every format draws from a serializable display model, a pure function of the sensor-filtered snapshot and the display state, so the AI crewmate, tests and later companion displays in a second window or on a tablet (P6) work through the same commands as the player. All displays together take under 2 ms of CPU per frame.
- **Sensors.** A sensor model filters simulation state per aircraft: radar by type, mode, range, radar cross-section, aspect, terrain masking, and clutter; RWR; visual detection; datalinks and AWACS with lower precision and a delay; targeting pods and terrain-following radar. Avionics profiles per type set which sensors exist and how good they are. The displays show only this filtered picture, and the AI uses the same one.
- **Crews.** See *Factions and Sides*. Transports add an airdrop format with a drop zone marker and release cue, and transport helicopters the hook camera format for sling loads.
- **Free Flight** (decision 134). A sandbox outside the campaign: pick a seed and an airbase, take off in the F-21 Kestrel, fly anywhere and land at any airbase, with no war, traffic or weapons. Time of day and weather are options: the world's own weather or a preset from clear sky to thunderstorm, blizzard, fog and dust storm, with wind and turbulence on the aircraft; the flight is on a day with a full moon (decision 143). It brings a first version of P1 (flight model, control laws, direct control, flight director) and part of P2 (the HUD) forward, adds ground handling and landing gear, and builds them where P1 and P2 will extend them. Takeoff and landing stay with the AI in the campaign.

## The Ground War

The ground war exists wherever the cast contains a continental front, chokepoint, or island campaign. AI controls it entirely. The player shapes it from the air.

- **Order of battle.** Divisions contain brigades or regiments, which contain battalions. Battalions are the aggregate unit: type (tank, mechanized infantry, motorized infantry, artillery, air defense, logistics), strength, supply, and posture.
- **Aggregate combat.** Lanchester-style attrition each tick, modified by terrain, posture, supply, artillery, and air support. Interdiction cuts supply; CAS reduces strength directly.
- **Entities.** Inside the promotion bubble, battalions expand into tank and IFV platoons, infantry squads with MANPADS teams, artillery, short-range air defense, and logistics columns on roads. Air defense entities matter most, since they decide whether an attack run survives.
- **Line of sight.** Attack helicopters fight by terrain masking and forest cover, so line-of-sight queries use the level-7 tiles (about 48 m) and the canopy height field, batched on the GPU within the bubble. A closed forest is a volume from the ground to its canopy top, and for any sight line from or to an aircraft it is opaque, edges included; how far ground units see into and out of a forest edge is settled with the ground entities (decision 148).

The demo shows battalions as unit symbols moving along the front under the aggregate model. Entity promotion comes later, but the data model supports it from the start.

## Naval Forces

Convoys, carrier groups, and amphibious groups exist wherever the cast contains a sea lane, chokepoint, or island campaign. AI controls them. They are targets and protectees for air missions, and convoy arrivals deliver reinforcements and supplies to the receiving theater. Casting assigns carrier groups to sides, and their air wings fly ATO missions (see *Air Tasking*). A group starts the war on station, patrolling a stretch of a sea lane in its theater (decision 132). The demo shows naval groups as aggregate units on analytic sea routes. Naval combat comes later.

## Rendering

The two views share world data, the simulation, and camera-relative rendering, and differ in everything they draw. `docs/visual-style.md` specifies both.

### Strategic View

*Specified in `docs/visual-style.md`, Part II.* An orbit camera from about 3,000 km down to a zoom floor of about 100 km, pitching from straight down at globe scale to about 50° at the floor. Content fades in and out by zoom band (globe, theater, region). A cube-sphere relief mesh with 4× exaggeration and a cartographic hillshade carries painted biomes with procedural patterns, banded water with coastal lines, low-poly glyphs for mountains, forests, and cities, a road hierarchy with casing, hierarchical labels with collision handling, and the military overlays: territory, the front line, defensive lines, named corridors, sea lanes, chokepoints, air defense rings, unit symbols, and flights. Zone names label regions at the Theater and Region bands, and natural wonders have their own glyph (decision 204). Day and night, seasons, and the live weather are always shown in stylized form: a terminator with a legible night side and settlement lights, and soft cloud shapes from the weather field. Individual trees and buildings never appear.

### Simulation View

*Specified in `docs/visual-style.md`, Part I.* Faceted, flat-shaded terrain at true scale from a quadtree limited to the horizon (about 200 km at 20 km altitude, farther for peaks beyond it), forests as a raised, faceted canopy with the tree kit in front of it near the camera (decision 148), box-building settlements and the base kit, roads and railways drawn in the terrain with their embankments and cuttings, bridges and tunnel portals from a kit (decision 161), procedurally built models, the physical sky with sun, moon and stars and aerial perspective, ocean, terrain shadows, volumetric clouds, fog and dust from the live weather, rain and snow with lightning and thunder, and the full post-processing chain. A governor lowers the atmospheric quality before the frame rate falls under its target (decision 143). Each zone has its own look: a shift of its biome colors, haze, sky grading, sun warmth, cloud regime and ambient particles, blended across boundaries without a barrier; landform props stand where the height field cannot reach (decision 204). The aircraft the player controls or follows gets a higher detail level with animated parts, and the HUD, the docked displays and the status strip draw as 2D overlays.

### Transition

Selecting a flight and choosing *Follow* or *Jump in* eases the strategic camera toward the flight down to the zoom floor. A quick dissolve through a cloud layer hides the switch, and the simulation view opens with a chase camera behind the aircraft. Returning reverses the sequence. The whole transition lasts under two seconds.

## Milestones

The roadmap splits into a foundation and three tracks that can advance in parallel, joined by an integration milestone. `TODO.md` tracks the tasks and their status.

### Foundation

- **F1. Globe skeleton.** Cube-sphere, unsteered plates, uplift, biome coloring, debug orbit camera, parameter sliders.
- **F2. World data.** Erosion, rivers, climate, and biomes baked to the global grid and tiles, and cached.

### Strategic Track

- **S1. Illustrated base map.** Exaggerated relief, hillshade, biome painting with pattern textures, coasts and water bands, camera with zoom floor and tilt, zoom bands, and stylized day and night and weather.
- **S2. Geography and names.** Feature extraction, toponymy, mountain and forest glyphs, and a label engine with typography, placement, and collision.
- **S3. Reading the world.** Validity check, strategic graph, front generator, theater detection, casting, briefing text, the seed browser, and the strategic overlays for theaters, fronts, named corridors, sea lanes, and chokepoints.
- **S4. Settlements and infrastructure.** Settlements with urban extents and city glyphs, road hierarchy with route names, railways, ports, airbases, and industry, with their symbols.

### Simulation Core Track

- **C1. Simulation core.** Worker-based simulation, event scheduler, fixed ticks, time acceleration, and the weather model.
- **C2. Air tasking and mission search.** Rule-based ATO for both sides, intelligence, mission model, flights, the search panel with subscriptions, and flight icons and routes on the map.
- **C3. Ground and naval aggregates.** Battalions and aggregate combat along fronts, convoys and naval groups, all shown as map symbols.

### Flight View Track

- **V1. Local terrain.** Quadtree LOD within the horizon, 0 to 20 km altitude, faceted flat-shaded terrain at true scale, high-resolution regional tiles, observer camera.
- **V2. Atmosphere and nature.** Sky, aerial perspective, ocean, clouds, weather effects, and the tree kit.
- **V3. Models and bases.** Procedural model builders from JSON specs, the model viewer page, settlements, and the base kit in the simulation view.
- **V4. Transition, camera rig, and spectator HUD.** Follow a flight from mission search into the simulation view and back. Chase camera with per-type rigs, free look, and terrain avoidance. Read-only HUD with flight path marker, tapes, and heading for the followed aircraft.

### Integration

- **I1. Polish.** Acceptance checks for both views, performance pass, side selection at campaign start, generation caching, and a short flythrough.

### Piloting Track (after the demo)

- **P1. Flight model and controls.** Table-driven flight model, flight director shared with the AI, mouse-aim and direct schemes, flight stick support through the Gamepad API, take control and hand back.
- **P2. HUD, displays, and status strip.** The allocation rule, the display frame, slots and slot states, the status strip, master modes, cursor mode, faction skins, and the moving map format; Free Flight's discrete indicators move from the HUD into the status strip (decision 189). The plan is `docs/plans/displays.md`.
- **P3. Sensors and formats.** The sensor model, avionics profiles with display complements, datalink tracks, the elevation mode of the moving map, and the air-to-air radar, air-to-ground radar, threat warning, stores, engines and fuel, and comms formats; the Su-27 analogue's HUD-integrated radar.
- **P4. Weapons.** Guns with lead-computing pipper, air-to-air missiles, bombs with CCIP and CCRP, target and weapon cameras, damage states.
- **P5. Crews and special roles.** Format ownership, the crew command menu, the six crew roles, callouts, crew station mode, and the targeting pod, hook camera and airdrop formats. Attack helicopter gunner mode and the sling-load tools move to track H (decision 149); the hook camera format is built by whichever of H3 and P5 comes first (decision 189).
- **P6. Companion displays (later).** Displays popped out into a second window, synced through a broadcast channel, and a tablet or phone companion paired peer-to-peer.

### Helicopter Track (after P1; decision 149)

*Specified in `docs/proposals/0004-helicopter-flight.md`; the plan is `docs/plans/helicopters.md`. Free Flight is the test bed for H1–H4.*

- **H1. Rotor model and fly-by-mouse.** The thrust-disc model, the speed-scheduled controls, the Assisted preset, the hover HUD, the helicopter camera rig, and Free Flight from a helicopter pad with the Little Bird and Black Hawk analogues.
- **H2. All modes and types.** Mouse aim, direct control with flight stick support, all assists and presets, and the remaining types.
- **H3. Ground and utility.** Skids and wheels, slope and confined-area landings, dynamic rollover, sling loads with the hook camera, hoisting, fast-roping.
- **H4. Hazards and damage.** Vortex ring state, mast bumping, retreating blade stall, autorotation, tail rotor loss, and their cues.
- **H5. Combat and AI.** Fixed and turreted weapons, gunner mode, AI nap-of-the-earth and battle-position behaviors, and helicopter missions in the campaign with jump-in over their ground phases.

### Terrain Networks Track (decision 161)

*Specified in `docs/proposals/0005-terrain-adaptive-networks.md`; the plan is `docs/plans/terrain-networks.md`.*

- **N1. Edit framework.** Corridor and pad edits in one function for every height query, protected river channels, airfield pads migrated onto it.
- **N2. River planform.** River invariants as metrics over many seeds, regimes, meander migration with cutoffs and oxbows, floodplain edits, distributaries.
- **N3. River rendering.** Oxbows as water, banks on oxbows and distributaries, generalized rivers on the map.
- **N4. Crossings and settlements.** Crossing sites, the settlement pull, bridges as typed nodes with traffic and detour.
- **N5. Router and alignment.** The router, railways, major and minor roads and tracks aligned, plans, profiles, earthworks, structure records, spirals. The network is aligned once, when the world is built, by a worker pool over level-6 tiles, and stored with the world (decision 184); the world's build runs behind a build screen of phases, bars and messages (decision 186).
- **N6. Corridors in the terrain.** Corridor edits with banks, road and rail shading, refined terrain along corridors near the camera.
- **N7. Structures and names.** The bridge kit and tunnel portals, bridge symbols and labels and dashed tunnels on the map, names for reaches, sections, bridges and tunnels.
- **N8. Verification.** The proposal's criteria over 20 seeds, screenshots, acceptance checks, report.

### Ground Detail Track (decision 168)

*The plan is `docs/plans/ground-detail.md`. Detail near a low camera for helicopter flight, at no cost at working altitude.*

- **G1. Micro-facets.** A virtual triangle lattice in the ground shader, finer than the mesh, with stepped normals and shades by land cover, gated by the camera's height above the ground.
- **G2. Ground cover kit.** Chunky grass tufts, tussocks, reeds, bushes, boulders, slabs and pebbles as model specs.
- **G3. Placement.** A pure placement function shared with the sim, a ring of instances around the camera on the drawn surface, colored from the ground.
- **G4. Motion.** Sway with the flight model's gusts, and downwash flattening the cover in rings.
- **G5. Dust.** Soft, wispy sprites of dust, grit, snow and spray by surface; closes H3's downwash task.

### World Diversity Track (decision 204)

*Specified in `docs/proposals/0007-world-diversity.md`; the plan is `docs/plans/world-diversity.md`.*

- **W1. Provinces and lithology.** Boundary ages, sutures and hotspots, the province and lithology maps, erodibility into erosion, debug overlays.
- **W2. Relief by province.** Uplift and soft limits by province, taller collision ranges, glacial carving with fjords, basin and range, plateau canyons, terracing restricted to layered dry rock.
- **W3. Closed basins.** The water balance, salt lakes and playas with shoreline rings, salt flats and airstrip sites in the graph.
- **W4. Climate and biomes.** Climate modifiers, the twenty biomes, altitude zonation, soil, riparian corridors, ecotones, disturbance, gully shading.
- **W5. Continental character.** Characters, biases within tectonic limits, the distinctness check.
- **W6. Zones and visual style.** Zones, look recipes and names in both views; the brighter palette.
- **W7. Landform props.** The prop kit, placement, collision shapes, budgets.
- **W8. Natural wonders.** Detectors, selection, names, shaping, protection from earthworks, map glyphs and labels.
- **W9. Verification.** The proposal's criteria over 20 seeds against the baseline, screenshots, report.

### Dependencies and Order

S1 and V1 both depend on F2. S3 depends on S2 for named corridors. V3 depends on S4 for settlement and base data. C2 depends on C1 and S4. V4 depends on C2 and V2. P1 depends on V4. P2 depends on P1, and its work in Free Flight may start before P1 closes (decision 189). P3 depends on P2 and S4. P4 and P5 depend on P3, P6 on P3. H1 depends on P1's framework (the shared airframe and director interfaces, input) and Free Flight, and may start before P1 closes (decision 151); H3's hook camera needs P2's display frame; H5 depends on P4, on P1's take control and hand back, and for gunner mode on P5's targeting pod format. In track N, N1, N2 and N4 depend on nothing open; N3 depends on N2, N5 on N1, N2 and N4, N6 on N1 and N5, N7 on N4 and N5. The demo needs none of track N, and N1's single height function is worth having before ground vehicles and line of sight (decision 161). In track G, G1 and G2 depend on nothing open, G3 on G2, G4 on G3 and H1's rotor state, G5 on G4; the demo needs none of it (decision 168). In track W, W1 depends on nothing open; W2, W3 and W4 on W1; W5 on W1 and W4; W6 on W4 and W5; W7 on W1 and W4; W8 on W2–W4, W6 and, for its karst and pillar wonders, W7; W9 on the rest. W8's protection from earthworks uses N5's router; the demo needs none of track W (decision 204).

Suggested order: F1, F2, S1, V1, S2, V2, S3, C1, S4, V3, C2, V4, C3, I1. Alternating between the map and the flight view keeps both looking good as the project grows, and each milestone produces something visible.

When the roadmap was adopted (revision 7), F1, F2, C1, and most of S3 and S4 were done, and V1's LOD and V2's atmosphere, ocean, and clouds existed in a single renderer that served orbit to ground. The remaining order is S1, V1 (adapting that renderer to the simulation view), S2, V2, the rest of S3 and S4, V3, C2, V4, C3, I1.

### Mapping from the Old Milestones

| Old | New |
|---|---|
| M1 Globe skeleton | F1 |
| M2 Erosion, rivers, LOD | F2 (data), V1 (rendering) |
| M3 Atmosphere, ocean, forests | V2 |
| M4 Reading the world | S3 |
| M5 Settlements, roads, ports, airbases | S4 (data and map), V3 (simulation view) |
| M6 Simulation core and weather | C1 |
| M7 Air tasking and mission search | C2, V4 (models to V3) |
| M8 Ground and naval aggregates | C3 |
| M9 Polish | I1 (tree kit and weather effects to V2) |
| (new) | S1, S2 |

**After the demo:** entity promotion and ground behaviors, the Piloting track (P1–P6), the Helicopter track (H1–H5), air combat, naval combat, the campaign economy.

## Open Questions

- **Aggressor.** Should the Pact always attack, or should casting occasionally reverse the roles when the geography favors an Alliance offensive?
- **Thresholds.** What are the right fit thresholds for each theater? The seed browser (S3) tells us how often each theater appears.
- **Range factor.** Does the per-world range factor feel right? We should fly representative sorties once C2 and V4 work. The first seed-browser run gives 1.0 for almost every seed, because fronts are deeper than a medium strike radius.
- **Zoom floor.** Is about 100 km altitude close enough, or should the floor go lower at the cost of more glyph and pattern detail?
- **Vertical exaggeration.** A fixed 4× on the map, or an exaggeration that increases as the camera pulls out?
- **Naming flavor.** How many cultural naming regions per world, and should they follow faction territory or landmasses?
- **Language of labels.** Should Pact-side names appear in a transliterated style, with an optional Cyrillic-like display font as flavor?
- **Strategic animation.** How much motion belongs on the map: moving flight icons only, or also animated front pushes, smoke over battles, and convoy wakes?
- **Free look in combat.** Should free look be limited while the player is in combat, so the chase view gives less of an advantage, or left unrestricted?
- **HUD color.** Green for both factions, or green for the Alliance and a different hue for the Pact, as a subtle cue for the side being flown?
- **Voice.** Should crew callouts and messages use synthesized speech from the start of P5, or text first? (The plan recommends text first; decision 189.)
- **Single-seat help.** Should single-seat aircraft get a light automation assistant (for example, the radar's mode following the master mode), or stay fully manual? (The plan recommends avionics assists, each a toggle.)
- **Spectating.** When the player follows an AI flight without taking control, should the displays show that aircraft's picture read-only, as the HUD does? (The plan recommends yes.)
- **Clean mode.** Should a mode exist that hides all overlays for screenshots and spectating?
- **Wonders in the war.** Are natural wonders strike-free landmarks, or may a war fought around them leave its mark (a bridge over a gorge, a base on a salt flat)? (Decision 204.)
- **Zone count.** At 16–63 km (decision 205) a world has a few thousand zones: should the map name only the largest at the Theater band, and should zones group into larger named regions?
- **Transport helicopters' fire support.** Should the Black Hawk, Huey and Mi-8 analogues also fly fire support (door guns, rocket pods), or only carry troops and cargo? (Decision 151.)

## Later (Out of Scope)

Campaign economy with factories, resources, pilot training, and resupply; air defense networks; player flight control, HUD, displays and status strip, AI crews, and flight stick support (the Piloting track; Free Flight, decision 134, has a first version); player-flown helicopters (the Helicopter track, decision 149); companion displays on a second window or a tablet (P6); CSAR missions; carriers, surface combatants, and submarines in combat; multiplayer. On the map: enemy territory that friendly reconnaissance has not covered recently drawn in a sketched, desaturated style, revealed by reconnaissance missions.