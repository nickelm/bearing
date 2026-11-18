# Proposal 0007: World Diversity

*Drafted 2026-11-17. Status: accepted (decision 204). Affects `docs/design.md`, `docs/visual-style.md`, `docs/proposals/0001-two-views.md`, `docs/proposals/0005-terrain-adaptive-networks.md`, `TODO.md`, and `CLAUDE.md`. The implementation plan is [docs/plans/world-diversity.md](../plans/world-diversity.md). Regional distances below (zones, blends, windows) are Earth figures; on Bearing's planet they scale by R / R_Earth ≈ 0.157, while landforms and heights keep Earth's values (decision 205).*

*Audit 2026-11-18 (decision 229): one soft limit of 6.5 km serves every province and young collision ranges reach about 10 km (decisions 210, 216); erodibility spans 0.55–2.0 (decision 216); zones are 16–63 km (decision 205) with the palette shift per vertex (decision 213); wonders are weighted by fronts and sea lanes only. This proposal has no roadmap section; `docs/roadmap.md` schedules its remaining work (decision 228).*

## Goals

The current terrain and erosion are good and stay as the backbone. What the worlds lack is variety: large regions look the same, mesas and buttes appear too widely, desert mountains are rare, and mountains are not tall enough. This proposal adds variety at every scale, from continents down to individual hillsides, and pushes the look toward majestic and memorable places. Slightly outlandish scenery is welcome, as long as it plausibly extends something that exists on Earth.

Four ideas carry the proposal:

1. **Landform, biome, and surface character are separate layers.** Landform comes from tectonics and rock type, biome from climate, and surface character from soil, water, and disturbance. Memorable landscapes are specific combinations of all three.
2. **Continents have character.** Each continent gets a dominant tectonic and climatic identity, so worlds feel distinct at globe scale.
3. **Zones have art direction.** Each region gets a coherent visual identity (palette, light, haze, vegetation, landmarks), in the spirit of the zones in World of Warcraft.
4. **Wonders anchor memory.** Each world has a handful of rare, named natural wonders that serve as landmarks, briefing names, and strategic map features.

## Layer 1: Terrain Provinces and Lithology

### Province Map

A new worldgen stage assigns every land cell a **terrain province** from its tectonic history: plate boundary type, distance from the boundary, the age of the collision or rift, and hotspot positions. Provinces set the uplift profile, rock hardness, and which erosion post-processes apply.

| Province | Tectonic origin | Uplift and relief | Landforms |
|---|---|---|---|
| Young collision range | Active continental collision | Peaks up to 8–9 km | Jagged ridges, glacial cirques, arêtes, horns, U-shaped valleys, glaciers |
| High plateau | Behind a collision zone | Plateau at 4–5 km | Flat high steppe, deep canyons at the edges |
| Old mountains | Ancient collision | Rounded ridges of 1–2.5 km | Forested hills and mountains, deep soil, gentle valleys |
| Shield | Ancient continental core | Under 600 m | Scoured bedrock, thousands of lakes, low ridges |
| Basin and range | Continental extension | Ranges of 2–4 km, basins near sea level or below | Parallel fault-block ranges, alluvial fans, playas and salt flats |
| Rift | Active rifting | Escarpments of 1–2 km | Long graben valleys, deep lakes, volcanoes |
| Volcanic arc | Subduction | Cones of 3–6 km | Stratovolcano chains, calderas, lava fields, crater lakes |
| Hotspot | Mantle plume | Shields of 2–5 km | Shield volcanoes, island chains, atolls on older islands |
| Sedimentary basin | Subsidence | Low | Plains; in dry climates, plateaus with mesas, buttes, and canyons |
| Karst platform | Limestone | Low to moderate | Sinkholes, dry valleys, gorges; tower karst in wet tropics |
| Soft sediment | Loess or weak deposits | Low to moderate | Dense gully networks, badlands in semi-arid zones |
| Glaciated lowland | Former ice sheets | Low | Moraines, drumlins, lakes; fjords on high-latitude coasts |

### Lithology Map

A **lithology map** assigns rock types by province, with noise and layering: granite and gneiss, schist, sandstone, shale, limestone, basalt, volcanic ash, loess, and glacial till. Lithology sets erodibility for the existing erosion pass, soil type for biomes, and rock colors for shading. It also gates landforms: mesas, buttes, and stepped canyon walls only form in horizontally layered sedimentary rock in dry climates; karst only forms in limestone.

### Province-Specific Processing

- **Taller ranges.** Young collision ranges get uplift up to 8–9 km before erosion, so erosion carves real alpine relief from them.
- **Glacial carving.** A glacial erosion pass above the snow line and at high latitudes widens valleys into U shapes, sharpens ridges into arêtes, and scoops cirques. Where glaciated valleys reach the sea, they become fjords.
- **Basin and range.** Extensional provinces in arid zones get parallel tilted fault blocks, with alluvial fans spreading into flat basins.
- **Canyons.** Rivers crossing uplifted plateaus incise deep canyons, with stepped walls where the rock is layered.
- **Restricted terracing.** Terracing that produces mesas and buttes applies only in layered sedimentary provinces with dry climates.
- **Gullies and badlands.** Soft-sediment provinces in semi-arid climates get dense gully networks. Gullies finer than the height grid render as flow-aligned detail in the terrain shader at close range.

## Layer 2: Climate and Biomes

### Climate Modifiers

The climate model gains local modifiers that break up broad bands:

- **Continentality.** Interiors get larger seasonal swings and drier air.
- **Cold ocean currents.** West coasts in the subtropics get cold currents that create fog deserts.
- **Orographic effects.** Windward slopes get wetter, and rain shadows get stronger behind tall ranges.
- **Aspect.** Sun-facing slopes run warmer and drier, so vegetation differs between the two sides of a ridge.
- **Altitude zonation.** Biomes stack by elevation on mountains, from foothill forest through alpine meadow to rock and ice.

### Biome Set

The biome table grows to the following set. Each biome has a palette (see *Palette*), a vegetation kit weighting, and a signature feature:

| Biome | Climate | Signature |
|---|---|---|
| Tropical rainforest | Hot, very wet | Unbroken canopy, brown meandering rivers, valley mist |
| Cloud forest | Tropical mountains | Mossy, wet, often in cloud |
| Monsoon forest | Hot, seasonally wet | Lighter canopy, seasonal tones |
| Mangrove | Tropical coasts and deltas | Dense coastal forest threaded by channels |
| Savanna | Hot, seasonally dry | Golden grass, scattered acacias, gallery forest along rivers |
| Sand sea | Hot, very dry, sandy | Dune fields in orange and ochre |
| Rocky desert | Hot, very dry, rocky | Stony plains, inselbergs, bare desert mountains |
| Red rock desert | Dry, layered sandstone | Red cliffs, canyons, mesas, arches |
| Fog desert | Dry coast with cold current | Pale ground, coastal fog banks |
| Cold desert and steppe | Cold, dry, high or continental | Wide open land, sparse grass |
| Mediterranean scrub | Dry summers, mild winters | Olive and sage tones, maquis on hills |
| Temperate grassland | Temperate, semi-dry | Prairie and steppe |
| Temperate deciduous forest | Temperate, moist | Broadleaf forest, the European default |
| Temperate rainforest | Cool, very wet coasts | Dark, mossy, giant conifers |
| Moorland and heath | Cool, wet, windy uplands, acidic soils | Heather in purple and brown, peat bogs, open ridges |
| Wetland | Flat and waterlogged | Marsh, bog, and fen with open pools |
| Boreal forest | Cold, moist | Dense conifers, lakes |
| Tundra | Very cold | Low scrub, thermokarst lakes |
| Alpine meadow | High mountains below the snow line | Bright green slopes, scattered rock |
| Ice | Permanent snow and ice | Glaciers, ice caps |

Farmland stays a land-use overlay on suitable biomes, as it is now.

### Surface Character

- **Soil from lithology.** Heath on sandy and acidic soils, grassland on chalk and limestone, forest on loam, sparse cover on thin soils over granite.
- **Riparian corridors.** Green bands along rivers through deserts, steppe, and savanna, including oases at springs.
- **Ecotones.** Biome boundaries interfinger with noise and follow terrain (forest on north slopes extends into grassland, for example) instead of meeting along clean lines.
- **Disturbance.** Fire scars, clearings, and wind-thrown patches in forests, with seeded frequency per biome.

## Layer 3: Water in Dry Lands

**Endorheic basins** are drainage basins that never reach the sea. Flow routing identifies them. Where a closed basin's evaporation exceeds its inflow, its floor fills to a balance level:

- **Salt lakes** where water remains, with brine colors from turquoise to pink depending on salinity.
- **Playas and salt flats** where the lake dries out: a perfectly flat white crust, with pale rings of former shorelines on the surrounding slopes.

Rivers flowing into endorheic basins end at the lake level and keep the monotonic profile from proposal 0005. Salt flats register in the strategic graph as natural airstrip sites, which casting can use for emergency or secret bases.

## Continental Character

Each continent receives a **character** from its tectonic history and its climate belt, with seeded variation: for example, an old shield continent with lakes and boreal forest; a young mountain continent with alpine ranges, volcanic arcs, and fjords; a dry continent of basin and range, red rock, and sand seas; a tropical continent of rainforest, karst, and deltas. Character biases province assignment and climate parameters within what the tectonics allow.

Continents in a world should differ visibly. A distinctness check compares the province and biome distributions of the largest continents and nudges continental parameters, through seeded sub-streams, when two continents come out too similar.

## Zones

### Zone Identity

A **zone** is a contiguous region of similar province and biome, typically 100 to 400 km across. Each zone gets a **look recipe**:

- a palette shift (hue, saturation, and value) applied to its biome colors;
- haze color and density;
- sky grading and sun warmth;
- vegetation kit weights;
- a landform prop kit (see below);
- a cloud regime and ambient particles (dust, mist, drifting snow, pollen);
- a name from the naming system ("the Oskel Waste", "the Varden Highlands").

Zones should be recognizable within seconds of arriving by air, the way World of Warcraft zones are.

### Zone Boundaries

Zone boundaries follow natural barriers where possible: ridges, rivers, coasts, and escarpments. Where no barrier exists, the transition blends over 5 to 15 km. Strategic map labels at the Theater and Region bands include zone names.

## Landform Props

Some of the most striking landforms cannot exist in a height field: tower karst has near-vertical sides and undercut bases, and arches have holes. These become **landform props**: instanced, flat-shaded, low-poly meshes placed on the terrain by province and lithology, each with a simple collision shape for physics and line of sight.

| Prop | Where | Scale |
|---|---|---|
| Karst towers | Karst in wet tropics, including drowned towers at sea (Ha Long Bay style) | 100–400 m tall |
| Sandstone pillars | Humid sandstone gorges (Zhangjiajie style) | 100–300 m tall |
| Sea stacks and arches | Cliffed coasts | 20–150 m |
| Hoodoos | Soft layered rock in dry climates | 10–60 m |
| Natural arches | Red rock deserts | 30–150 m span |
| Basalt columns | Lava plateaus and coasts | Clusters of 10–50 m |
| Inselbergs (small) | Rocky desert and savanna | 50–300 m; large ones stay in the height field |

Slight exaggeration is welcome: karst towers may stand taller and denser than on Earth. Props use instancing and LOD, and their triangle budget counts against the scene budget in `docs/visual-style.md`. For helicopters, tower karst creates a spectacular nap-of-the-earth environment.

## Natural Wonders

Each world gets 5 to 15 **natural wonders**: rare, named landmarks placed where generation conditions suit them, and favored where they will be seen (near fronts, sea lanes, and airbases). Candidates, all heightened versions of Earth features:

- a tepui (table mountain) with a waterfall falling from its rim;
- a giant waterfall where a large river drops off an escarpment;
- a drowned karst bay with hundreds of towers;
- a forest of sandstone pillars;
- a pink or turquoise salt lake on a white playa;
- travertine terraces with turquoise pools;
- a crater lake in a caldera;
- a calving glacier at the head of a fjord;
- rainbow-banded mineral hills;
- a monolith rising alone from a plain;
- a blue hole in a reef lagoon, or an atoll ring;
- a field of basalt columns on a coast.

Wonders appear on the strategic map with a distinct glyph and label, in briefings, and as navigation landmarks. They are protected from road and rail earthworks (proposal 0005) except for scenic routes that pass by them.

## Gameplay Consequences

- **Mountains as barriers.** Tall ranges exceed helicopter hover ceilings and create radar shadows, which shape helicopter routes and low-level penetration.
- **Terrain types matter.** Jungle limits landing zones and visibility, moors and steppe offer open ground with little cover, karst and canyons offer masking for helicopters.
- **Zone weather.** Cloud forests, fog deserts, and moorland carry weather tendencies (low cloud, fog, wind) that affect missions.
- **Dry lake bases.** Salt flats can host emergency airstrips.

## Palette

Visual style moves brighter. The following starting values replace and extend the terrain palette in `docs/visual-style.md` Part I. Part II (strategic view) derives its softened palette from the same values.

| Surface | Shades |
|---|---|
| Tropical rainforest | `#1F7A3A`, `#2A8C45`, `#3FA052` |
| Cloud forest | `#3E8C5A`, `#5BA37A` |
| Monsoon forest | `#4E8F3A`, `#6FA04A` |
| Mangrove | `#2F6E4A`, `#3E7F55` |
| Savanna | `#C9B458`, `#B8A24A`, `#D6C46A` |
| Sand sea | `#E3A35A`, `#D98C45`, `#EDB873` |
| Rocky desert | `#B9825A`, `#A0694A`, `#C99A70` |
| Red rock | `#B8553A`, `#C9673F`, `#D98552` |
| Fog desert | `#C8B9A0`, `#B5A58C` |
| Cold desert and steppe | `#B7A77C`, `#A39468` |
| Mediterranean scrub | `#8A9A5B`, `#9FA86A`, `#7C8B50` |
| Temperate grassland | `#8DB255`, `#7FA34A`, `#A3C266` |
| Temperate deciduous forest | `#3F7A35`, `#4E8C3F`, `#5E9C48` |
| Temperate rainforest | `#22593A`, `#2E6B44` |
| Moorland and heath | `#8A6A7A`, `#9C7F8C` (heather), `#7A6248`, `#4A3B2E` (peat) |
| Wetland | `#5E8A55`, `#6E9A60`, pools `#4D7A80` |
| Boreal forest | `#2C5236`, `#355E3E` |
| Tundra | `#9A9A70`, `#8A8A62`, `#B0A27A` |
| Alpine meadow | `#7DAA5A`, `#96BC6E` |
| Glacier and ice | `#CFE6F0`, `#A9D3E6` |
| Salt flat | `#F1EEE6`, `#E6E1D3` |
| Brine | `#E59AA8` (pink), `#5FC7C2` (turquoise) |
| Travertine | `#F3EBDD`, pools `#6FD3D0` |
| Volcanic rock and black sand | `#2E2B2B`, `#3A3634`, `#4A3F3A` |
| Coral lagoon | `#3FD1C7`, `#7FE3D6`, atoll sand `#F2E6C8` |
| Mineral bands | `#C65A4A`, `#E0A35A`, `#D9C27A`, `#8FA36A`, `#B58AA0` |

Zone look recipes shift these values within limits, so zones differ while the world stays coherent.

## Verification Criteria

| Check | Criterion |
|---|---|
| Local variety | Biome and province entropy over 100 km windows meets a minimum on at least 90% of land, across 20 seeds |
| Continental distinctness | Province and biome distributions of the two largest continents differ by at least a set Jensen–Shannon divergence in 90% of seeds |
| Mountain heights | Each world with a young collision range has peaks above 6 km |
| Terracing restriction | Mesa and butte landforms appear only in permitted provinces and climates |
| Endorheic basins | Arid worlds contain salt lakes or playas; every endorheic river keeps a monotonic profile |
| Biome coverage | Over 20 seeds, every biome in the table appears at least once |
| Zones | Every land cell belongs to a zone; zone sizes fall within range; each zone has a name and look recipe |
| Wonders | Each world has 5 to 15 wonders, each named and placed where its conditions hold |
| Props | Prop triangle counts in the standard test views stay within budget |
| Existing invariants | All existing terrain, river, and network tests pass |
| Determinism | Same seed, same output; earlier stages unchanged except where this proposal intends changes |
| Generation time | Reported per stage; total pipeline time increases by at most 50% |
