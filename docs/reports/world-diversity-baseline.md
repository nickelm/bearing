# World diversity: baseline

_Measured 2026-11-17 for [proposal 0007](../proposals/0007-world-diversity.md) (decision 204, track W0) with `tools/diversity.preview.ts` on generator version 21, before any of track W. The plan is [docs/plans/world-diversity.md](../plans/world-diversity.md)._

## How it was measured

Seeds 1–20 run as the app runs them: the campaign world with its validity retries (seed 9 became `6409045966207312319`). The coarse pass is the CPU pass at 256² per face (cells of about 6 km), without erosion; its heights are tectonic reference heights × 0.157, so peak heights need the eroded global grid (1024² per face, about 1.5 km), which runs on the GPU (Dawn on lavapipe here, about ten minutes per world).

- **Entropy:** Shannon entropy (bits) of the biome distribution of the land within 50 km of each land cell, so over windows of 100 km. Decision 205 scales the proposal's windows to the planet (about 16 km); the eroded section below uses the scaled windows, the coarse table the unscaled ones, which on 6 km cells is the only window with enough cells.
- **JSD:** Jensen–Shannon divergence (bits, 0 to 1) between the biome distributions of the two largest landmasses.
- **Strata and buttes:** the land the tile kernel would layer into 75 m benches (aridity mask past 0.35 after its blur, decision 126) and raise buttes on (aridity times flatness past 0.25), from a CPU copy of the mask.
- **Dry share of the highest 5%:** the share of the highest 5% of land, by area, whose biome is desert or shrubland: how often mountains are desert mountains.
- **Arid lakes:** lake cells in deserts and shrubland, which the tiles draw as salt pans (decision 130). Closed basins do not exist: drainage fills every depression to its spill level.

Provinces, lithology, zones and wonders do not exist yet, so their criteria have no baseline; the tool reports them as they arrive.

## Coarse pass, seeds 1–20

| seed       | entropy median (bits) | land ≥ 0.5 bit | land ≥ 1 bit | JSD two largest (bits) | strata    | buttes    | dry share of highest 5% | arid lakes |
| ---------- | --------------------- | -------------- | ------------ | ---------------------- | --------- | --------- | ----------------------- | ---------- |
| 1          | 0.88                  | 65.2%          | 36.7%        | 0.11                   | 23.2%     | 22.5%     | 0.0%                    | 0.94%      |
| 2          | 0.98                  | 71.4%          | 46.7%        | 0.29                   | 34.8%     | 33.8%     | 0.0%                    | 1.34%      |
| 3          | 1.00                  | 73.9%          | 49.1%        | 0.07                   | 29.3%     | 28.3%     | 0.1%                    | 0.50%      |
| 4          | 0.96                  | 70.5%          | 42.8%        | 0.15                   | 34.7%     | 33.7%     | 3.9%                    | 1.52%      |
| 5          | 0.95                  | 68.7%          | 41.9%        | 0.35                   | 27.9%     | 27.0%     | 0.1%                    | 0.91%      |
| 6          | 0.91                  | 66.6%          | 38.7%        | 0.85                   | 27.8%     | 27.0%     | 0.0%                    | 0.70%      |
| 7          | 1.00                  | 74.9%          | 49.6%        | 0.46                   | 34.5%     | 33.5%     | 1.4%                    | 1.59%      |
| 8          | 0.96                  | 69.3%          | 42.7%        | 0.51                   | 31.1%     | 30.2%     | 0.0%                    | 0.59%      |
| 9          | 0.95                  | 70.0%          | 42.3%        | 0.10                   | 32.8%     | 32.1%     | 0.0%                    | 0.77%      |
| 10         | 0.88                  | 64.9%          | 35.5%        | 0.60                   | 23.8%     | 23.1%     | 0.0%                    | 0.32%      |
| 11         | 0.92                  | 68.7%          | 39.8%        | 0.49                   | 36.6%     | 35.6%     | 0.0%                    | 0.52%      |
| 12         | 0.92                  | 65.7%          | 39.8%        | 0.43                   | 21.2%     | 20.4%     | 0.0%                    | 0.17%      |
| 13         | 0.98                  | 73.2%          | 45.7%        | 0.70                   | 35.2%     | 34.1%     | 0.7%                    | 1.06%      |
| 14         | 0.97                  | 74.3%          | 44.2%        | 0.23                   | 36.2%     | 35.0%     | 2.2%                    | 1.04%      |
| 15         | 0.79                  | 60.8%          | 29.2%        | 0.17                   | 21.9%     | 21.3%     | 0.0%                    | 1.88%      |
| 16         | 0.83                  | 62.8%          | 33.1%        | 0.07                   | 16.9%     | 16.2%     | 0.0%                    | 0.17%      |
| 17         | 0.92                  | 68.5%          | 39.6%        | 0.77                   | 21.6%     | 20.8%     | 0.0%                    | 1.36%      |
| 18         | 1.03                  | 78.4%          | 51.3%        | 0.51                   | 33.7%     | 32.6%     | 0.0%                    | 1.12%      |
| 19         | 0.94                  | 70.4%          | 42.3%        | 0.15                   | 35.9%     | 35.0%     | 0.1%                    | 1.73%      |
| 20         | 1.20                  | 79.6%          | 58.1%        | 0.11                   | 37.0%     | 35.8%     | 0.0%                    | 0.98%      |
| **median** | **0.95**              | **70.0%**      | **42.3%**    | **0.35**               | **32.8%** | **32.1%** | **0.0%**                | **0.98%**  |

### Biomes over the 20 seeds

| biome                    | mean land share | seeds where present (> 0.1% of land) |
| ------------------------ | --------------- | ------------------------------------ |
| ice sheet                | 6.7%            | 18 of 20                             |
| tundra                   | 9.6%            | 20 of 20                             |
| taiga                    | 12.4%           | 20 of 20                             |
| temperate grassland      | 6.5%            | 20 of 20                             |
| temperate forest         | 4.8%            | 20 of 20                             |
| temperate rainforest     | 8.2%            | 20 of 20                             |
| cold desert              | 12.4%           | 20 of 20                             |
| hot desert               | 11.4%           | 20 of 20                             |
| shrubland                | 5.3%            | 20 of 20                             |
| savanna                  | 4.6%            | 20 of 20                             |
| tropical seasonal forest | 5.8%            | 20 of 20                             |
| tropical rainforest      | 7.1%            | 20 of 20                             |
| alpine                   | 5.2%            | 20 of 20                             |

### Coarse pass times (median over the 20 seeds, ms)

| stage           | ms    | stage                    | ms          |
| --------------- | ----- | ------------------------ | ----------- |
| plates          | 510   | graph: roads             | 1,521       |
| crust           | 1,270 | graph: fronts            | 1,147       |
| boundaries      | 34    | graph: features          | 1,172       |
| uplift          | 550   | other graph stages       | about 1,100 |
| elevation       | 392   | theaters and casting     | 158         |
| climate         | 2,471 | infrastructure           | 1,129       |
| biomes          | 5     | **campaign world total** | **11,879**  |
| coarse drainage | 161   |                          |             |

The total includes graph, casting and infrastructure, and the retries of seed 9. The stages track W touches or adds between `boundaries` and `biomes` cost about 3.4 s today; the 50% allowance on the whole pass is about 6 s.

## Eroded global grid

The eroded worlds (1024² per face) for peak heights and the eroded biomes were still building on lavapipe when this baseline was committed; `GLOBAL=1 npx vitest run --config vitest.tools.config.ts tools/diversity.preview.ts` produces them (about ten minutes per world, cached afterwards). Decision 122 measured heights of −897 to 8,239 m on the eroded world of seed 1983. W2's first task records the 20-seed peaks here before it changes the uplift.

## What the baseline says

- **Terracing is everywhere dry.** The kernel would layer a median of 33% of all land into benches, and nearly as much carries buttes: every desert, most shrubland and part of the grassland. The proposal's complaint that mesas and buttes appear too widely is measurable: after W2 the share outside layered dry rock must be zero.
- **Desert mountains are rare.** In 13 of 20 seeds none of the highest 5% of land is desert or shrubland, and the median is 0%. High ground is cold, so it becomes alpine, tundra or ice; dry ranges need provinces (basin and range, high plateaus) and the rain-shadow and continentality modifiers.
- **Local variety is moderate.** A 100 km window holds a median of 0.95 bit of biome entropy, and 61–80% of land (median 70%) reaches 0.5 bit. The proposal's 90% needs the joint classes of the plan (altitude zones, provinces, surface character), not more biome noise.
- **Continents often look alike.** The two largest landmasses differ by a median of 0.35 bit; 9 of 20 seeds fall under 0.25 bit and 5 under 0.12.
- **Every current biome appears** in most seeds; the ice sheet is missing in two. The twenty-biome table must be checked the same way.
- **Salt pans exist** on about 1% of land as arid lakes, without a water balance; closed basins do not.
