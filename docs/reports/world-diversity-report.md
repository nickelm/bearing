# World diversity: report (track W, proposal 0007)

_Branch `feature/world-diversity`, 2026-11-17. Proposal: [docs/proposals/0007-world-diversity.md](../proposals/0007-world-diversity.md). Plan: [docs/plans/world-diversity.md](../plans/world-diversity.md). Decisions 204–212. Baseline: [world-diversity-baseline.md](world-diversity-baseline.md). Metrics: [world-diversity-metrics.md](world-diversity-metrics.md)._

## Summary

Track W gives the generated worlds a cause for one place to differ from another. Each part is listed with its decision:

- **Terrain provinces and rock** come from tectonic history (decision 207).
- **The relief follows the province.** Plateaus rise, old ranges wear down, basin-and-range blocks stand in rows, troughs reach the sea as fjords, and strata and buttes appear only in layered rock under a dry climate (decision 208).
- **Closed basins** keep salt lakes and playas, and the playas become salt flats and airstrip sites in the graph (decision 208).
- **Twenty land biomes** come from the climate, three local modifiers, the rock and the ground's shape, in a brighter palette (decision 209).
- **Continents take a character**, checked for distinctness (decision 210).
- **The land divides into zones** with names and look recipes. They shift the terrain's colors and label the map (decision 211).
- **5–15 named natural wonders** are selected per war (decision 212).

Landform props (W7) were not started, and several presentation pieces wait for later work. Both are listed under _Simplified, stubbed or deferred_.

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

## Metrics against the criteria

The full tables are in [world-diversity-metrics.md](world-diversity-metrics.md); the baseline is [world-diversity-baseline.md](world-diversity-baseline.md).

| Criterion                | Result                                                                                                                                                                                                                                                                     | Met     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Local variety            | Joint biome and province entropy reaches 0.5 bit on a median 87% of land over 100 km windows on the coarse pass (baseline, biomes only: 70%), and on 7 of 20 seeds the full 90%. Over the planet-scaled 16 km windows on eroded worlds, 48–50% of land (baseline: 29–34%). | No      |
| Continental distinctness | 18 of 20 seeds at 0.25 bit or more, median 0.49 (baseline 11 of 20, median 0.35)                                                                                                                                                                                           | Yes     |
| Mountain heights         | Eroded peaks of 8.9 and 10.0 km on seeds 1 and 2. Land above 4 km is 4.2× and 2.6× the baseline's.                                                                                                                                                                         | Yes     |
| Terracing restriction    | Only layered rock in a dry climate, by construction. Terraced land is 11% (coarse median) against 33%, and 7–11% (eroded) against 21–31%.                                                                                                                                  | Yes     |
| Endorheic basins         | 34–81 closed basins per world; 16–40 salt flats per world, each an airstrip site; the river invariants hold with them                                                                                                                                                      | Yes     |
| Biome coverage           | All twenty land biomes over seeds 1–20, eighteen of them in every seed                                                                                                                                                                                                     | Yes     |
| Zones                    | All land zoned; 97.6–98.4% of zones within 16–63 km on eroded worlds; all named, with recipes                                                                                                                                                                              | Yes     |
| Wonders                  | 5–15 per world in every seed, named, conditions tested                                                                                                                                                                                                                     | Yes     |
| Props                    | W7 not started                                                                                                                                                                                                                                                             | Not run |
| Existing invariants      | Every test passes; one network-stage test times out only under load                                                                                                                                                                                                        | Yes     |
| Determinism              | Tested per stage; plates, crust and boundaries byte-identical                                                                                                                                                                                                              | Yes     |
| Generation time          | Coarse pass +20% (14.3 s against 11.9 s); global finish +15 s on 15–25 minutes of erosion                                                                                                                                                                                  | Yes     |

**Local variety falls short of the proposal's 90%.** Coherent zones and high local entropy pull against each other, as the plan foresaw. The plan's measure counts altitude zones and surface character (riparian, lakes, ecotones) in the joint classes. The tool counts only biome and province so far, and adding those classes is the next step before tuning anything.

## Simplified, stubbed or deferred

- **Landform props (W7)**: not started. This leaves out the prop kit, placement, the instanced layer, collision shapes and budgets. The karst bay and pillar forest wonders are selected and named but have no towers.
- **Wonder shaping and protection**: no tepui walls, falls, calderas, travertine or mineral bands in the tiles; no router cost around wonders; no map glyph of their own (labels only).
- **Zones in the simulation view**: only the palette shift, per vertex. Haze, sky grading, sun warmth, cloud regimes, particles and vegetation kit weights by zone are in the recipes but not yet applied. Zones' weather tendencies are not read by the weather model.
- **Closed basins**: brine colors (pink and turquoise by salinity) and pale shoreline rings wait for a flag in the tiles' output material for the terrain shader. Salt lakes draw as ordinary lakes, playas as white crust.
- **Relief**: no soft limit per province (peaks already reach 8–10 km); cirques and arêtes rest on the kernel's existing alpine crests; canyons are left to erosion; no separate stratovolcano cones.
- **Biomes and surface**: aspect in the shader and canopy, disturbance patches in forests, oases, gully shade lines, and the weather reading the fog tendency are not done. Strategic patterns for the new biomes (heather, salt crust, towers, banding) are not done; the new fills are.
- **Screenshots**: globe maps of three seeds from the coarse pass only. The simulation view's renders on lavapipe (`tools/render.preview.ts`, seed 1: range, alpine, mixed, farmland) had not finished when this report was written. The browser smoke test was not run.

## Decisions and deviations from proposal 0007

- **Decision 204**: the proposal accepted, with 21 readings.
- **Decision 205**: the owner's answers. Regional distances scale with the planet (zones 16–63 km, blends 1–2.5 km, windows 16 km); landforms and heights keep Earth's values. Zones became presentation data on the eroded grid.
- **Decision 207 (W1)**: provinces and lithology; erodibility.
- **Decision 208 (W2, W3)**: relief by province, fault blocks, fjords, terracing on layered rock; closed basins, salt flats and airstrip sites.
- **Decision 209 (W4)**: the modifiers and twenty biomes. _Deviation:_ seven codes appended instead of renumbering.
- **Decision 210 (W5)**: characters. _Deviation:_ a continent is a plate's crust, because crust is one welded region in most seeds.
- **Decision 211 (W6)**: zones, recipes, names, the palette shift and labels.
- **Decision 212 (W8)**: wonders. W7 deferred.
- **Decision 213**: islets join a zone; flatness and mangroves at the eroded grid's resolution.
- **Further deviations**:
  - Salt flats are point features, not polygons.
  - Wonders are selected weighted toward fronts and sea lanes, not airbases. Airbases are placed after casting, from the cast.
  - The proposal's per-province soft limit was not needed for the height criterion.

## Known issues

**Moderate**

- Local variety misses the 90% target (see above).
- Eroded peaks reach 10.0 km on seed 2, above the proposal's 8–9 km, from young collisions × 1.25 under the shared soft limit.
- Tundra covers 16.5% of land on the coarse pass (baseline 9.6%), because cold plateaus are tundra below −12 °C. Alpine meadow rose from 5% to 7%.
- Eroded wetland and mangrove shares were measured before decision 213's fix; the eroded run that would confirm it is still to do.

**Minor**

- Every salt flat counts as an airstrip site on the coarse grid: a 6 km cell is longer than the 4 km run. The test is meaningful only at finer resolution.
- Zone names take their naming flavor from the quarter of longitude, not the land node, so a zone's names can differ in flavor from the towns around it.
- The basin-and-range sink and the plateau uplift change sea level's quantile slightly. Inland seas were present in the baseline too.
- `tests/networkLink.test.ts` "never hands a task a tile another lane evicted" times out when the machine is loaded (it did before track W).

## Generation time

| Stage                                                             | Baseline (median) | Now (median)                       |
| ----------------------------------------------------------------- | ----------------- | ---------------------------------- |
| Coarse: continents, provinces, lithology, modifiers, distinctness | –                 | 0.06 + 0.47 + 0.31 + 0.56 + 0.00 s |
| Coarse: uplift + elevation                                        | 0.94 s            | 1.18 s                             |
| Coarse: climate + biomes                                          | 2.48 s            | 2.39 s                             |
| Coarse: drainage (with closed basins)                             | 0.16 s            | 0.38 s                             |
| Coarse: features (salt flats, wonders)                            | 1.17 s            | 1.32 s                             |
| Coarse campaign world, total                                      | 11.9 s            | 14.3 s                             |
| Global: erosion (lavapipe, under load)                            | 9–18 min          | 17–25 min (under heavier load)     |
| Global: finish in the worker (drainage, rivers, biomes, zones)    | 8–15 s            | 29 s                               |

Times are medians on a 4-core cloud machine while other generation jobs ran. Erosion did not change in kind, apart from one more buffer read per iteration; its longer times come from the heavier load. A comparison on an idle machine is still to do.

## Next steps

1. **Measure local variety as the plan defines it.** Add altitude zones and surface character (riparian cells, lakes, ecotone bands) to the joint classes, then tune. This decides whether the 90% target needs more generation or only a better measure.
2. **Give zones their air in the simulation view.** Haze, sky grading, sun warmth and particles blended by the camera's position, and the weather's fog and low-cloud tendencies. Zones should read within seconds of arriving, which the palette shift alone does not achieve.
3. **Build W7's landform props** (karst towers first) with collision shapes. Tower karst is the proposal's most striking landscape and helicopter environment, and the karst bay and pillar wonders wait for it.
