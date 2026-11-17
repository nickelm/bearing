# World diversity: report (track W, proposal 0007)

_Branch `feature/world-diversity`, 2026-11-17. Proposal: [docs/proposals/0007-world-diversity.md](../proposals/0007-world-diversity.md). Plan: [docs/plans/world-diversity.md](../plans/world-diversity.md). Decisions 204–211. Baseline: [world-diversity-baseline.md](world-diversity-baseline.md). Metrics: [world-diversity-metrics.md](world-diversity-metrics.md)._

## Summary

Track W gives the generated worlds a cause for one place to differ from another. Each part is listed with its decision:

- **Terrain provinces and rock** come from tectonic history (decision 206).
- **The relief follows the province.** Plateaus rise, old ranges wear down, basin-and-range blocks stand in rows, troughs reach the sea as fjords, and strata and buttes appear only in layered rock under a dry climate (decision 207).
- **Closed basins** keep salt lakes and playas, and the playas become salt flats and airstrip sites in the graph (decision 207).
- **Twenty land biomes** come from the climate, three local modifiers, the rock and the ground's shape, in a brighter palette (decision 208).
- **Continents take a character**, checked for distinctness (decision 209).
- **The land divides into zones** with names and look recipes. They shift the terrain's colors and label the map (decision 210).
- **5–15 named natural wonders** are selected per war (decision 211).

Landform props (W7) were not started, and several presentation pieces wait for later work. Both are listed under *Simplified, stubbed or deferred*.

## What works

- **Provinces** (`worldgen/provinces.ts`). Every land cell has one of twelve provinces. Over 20 seeds the shares are: young collision 9%, high plateau 13%, old mountains 7%, shield 16%, basin and range 10%, rift 4%, volcanic arc 4%, hotspot 0.6%, sedimentary basin 16%, karst 6%, soft sediment 3%, glaciated lowland 13%.
  - Boundary runs are young or old, old plates carry wandering fossil sutures, and hotspots leave chains along their plate's motion.
  - Plates, crust and boundaries are byte-identical to before (a test).
- **Lithology** (`worldgen/lithology.ts`). Nine rocks, plus a layered bit on horizontal sedimentary rock. Erodibility (0.35 for granite to 3 for loess) multiplies the GPU erosion's incision, and the talus angle follows the rock.
- **Relief.**
  - High plateaus stand at about 4.5 km of Earth elevation. Land above 4 km grows from 42,000 to 176,000 km² on seed 1's eroded world.
  - Old ranges are lower and rounded, sutures and hotspot shields add their own relief, and basin-and-range blocks stand 22 km apart.
  - Glaciated troughs that reach the sea sink below it as fjords.
  - Strata and buttes need layered rock: the land the kernel terraces falls from a median of 33% to 11% of land on the coarse pass, and from 21% to 7% on seed 1's eroded world.
- **Closed basins** (`worldgen/drainage.ts`). A water balance on every depression gives each seed 34–81 closed basins at 256². Each is a salt lake at its balance level or a playa.
  - Rivers end at them like mouths, and the river invariants hold over ten seeds with them.
  - Playas become `SaltFlat` features ("the Oskel Salt Flat", "Oskel Pan") and airstrip sites (16–40 per world).
- **Biomes** (`worldgen/biomes.ts`, `climateModifiers.ts`). All twenty land biomes appear over 20 seeds: eighteen in every seed, ice sheet and mangrove in 18 and 19.
  - Precipitation seasonality makes Mediterranean scrub and monsoon forest.
  - Cold currents make fog deserts.
  - Ecotone noise interfingers the boundaries.
  - The rock decides between sand seas, rocky deserts and red rock, and gives moorland on acid rock and grassland on limestone.
  - High plateaus are steppe, not ice.
- **Continental character** (`worldgen/characters.ts`). Each continental plate's crust is an old shield, young mountains, dry extension, a tropical platform or mixed. The three largest continents of a seed carry two or three different characters in 18 of 20 seeds.
  - The distinctness check redrew a character in 2 of 20 seeds.
  - The two largest landmasses diverge by at least 0.25 bit in 18 of 20 seeds (baseline 11 of 20).
- **Zones** (`worldgen/zones.ts`, in the global finish).
  - Every land cell is in a zone. Seed 1's eroded world has 3,728 zones, 97.6% of them 16–63 km across, with a median of 36 km.
  - Every zone has a name ("the Biote Taiga", "the Checigria Forest", "the Chiodia Downs") and a recipe within the guide's limits.
  - The terrain's vertex colors take each zone's shift, fading to nothing at boundaries. The map labels zones and drops the area labels of the cover and plains inside them.
- **Wonders** (`geography/wonders.ts`, `campaign/wonders.ts`). Detectors for the twelve kinds give 32–35 candidates per world. Casting selects 5–15 (5 to 15 over seeds 1–20), weighted toward the fronts and lanes in play.
  - Examples: "Mount Wogro" (a tepui), "the Greind Falls", "the Kor Towers", "the Pink Lake of Thauhaul", "Kran Crater", "the Painted Hills of Grevith".
  - They are named in the briefing and labeled on the map.
- **Tools.**
  - `tools/diversity.preview.ts` measures every criterion on the coarse pass and on eroded worlds.
  - `tools/zones.preview.ts` recomputes zones on cached eroded worlds without the GPU.
  - `npm run maps` gains the modes `provinces` and `lithology`, which the GUI's "Color by" also shows in both views.

### Pictures

Globe maps (coarse pass, equirectangular above both polar caps) of three contrasting seeds are in `docs/reports/screens/world-diversity/`:

- **Seed 5** (two tropical platforms and an old shield): `seed5-biome.png`, `seed5-provinces.png`.
- **Seed 9** (young mountains and dry extension): `seed9-biome.png`, `seed9-provinces.png`.
- **Seed 16** (two old shields and dry extension): `seed16-biome.png`, `seed16-provinces.png`.
