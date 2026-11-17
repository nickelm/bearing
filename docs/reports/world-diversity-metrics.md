# World diversity: metrics

_Measured 2026-11-17 on `feature/world-diversity` with `tools/diversity.preview.ts` and `tools/zones.preview.ts`, against the baseline in [world-diversity-baseline.md](world-diversity-baseline.md). Proposal 0007's verification criteria with the thresholds the plan set (decision 204), regional windows scaled to the planet (decision 205)._

The coarse pass ran seeds 1–20 on generator version 27. Eroded worlds (1024² per face, Dawn on lavapipe, 15–25 minutes each) ran on version 26, which differs from 27 and 28 only in the wonders (graph only) and decision 215 (eroded wetland and mangrove, islets). Zones were recomputed on those worlds with decision 215's code.

## Criteria

| Criterion                | Measure and threshold                                                                      | Baseline                                                                                                          | Now                                                                                                                                                                                                                                                        | Met     |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Local variety            | Joint biome and province entropy ≥ 0.5 bit on ≥ 90% of land, 20 seeds                      | Biomes only: median 70.0% of land over 100 km windows (coarse); 31.4% over 16 km windows on the same eroded seeds | Coarse, 100 km windows: median 86.9% of land, 6 of 20 seeds at 90%; eroded, 16 km windows: 48.5%, 50.3% on seeds 1, 2                                                                                                                                      | No      |
| Continental distinctness | Divergence of the two largest landmasses' joint distributions ≥ 0.25 bit in ≥ 90% of seeds | 11 of 20 seeds (biomes only), median 0.35 bit                                                                     | 18 of 20 seeds, median 0.49 bit (coarse)                                                                                                                                                                                                                   | Yes     |
| Mountain heights         | Worlds with a young collision range have peaks above 6 km                                  | 10 of 10 eroded seeds above 6 km (6.8–9.2 km)                                                                     | 8850 m, 9976 m on seeds 1, 2; land above 4 km 176295, 184601 km² against 42483, 70424                                                                                                                                                                      | Yes     |
| Terracing restriction    | Strata and buttes only on layered rock in a dry climate                                    | Coarse median 32.8% of land terraced, every desert and most shrubland                                             | Coarse median 10.9%; eroded 7.1%, 11.4% against 21.0%, 31.4%; by construction none outside layered rock (the kernel multiplies by the layered-rock mask)                                                                                                   | Yes     |
| Endorheic basins         | Arid worlds have salt lakes or playas; endorheic rivers keep monotone profiles             | None: every depression drained to the sea                                                                         | 16–40 salt flats per world over seeds 1–20 (coarse), 34–81 closed basins per world at 256²; the river invariants pass over ten seeds with closed basins                                                                                                    | Yes     |
| Biome coverage           | Every biome in the table in at least one of 20 seeds                                       | 13 land biomes                                                                                                    | All 20: eighteen in every seed, ice sheet in 18, mangrove in 19 (coarse)                                                                                                                                                                                   | Yes     |
| Zones                    | Every land cell in a zone; sizes in range; names and recipes                               | No zones                                                                                                          | 100% of land zoned; 3,728 and 3,754 zones on eroded seeds 1 and 2, 97.6% and 98.4% of them 16–63 km, median 36 km; every zone named, with a recipe within the limits                                                                                       | Yes     |
| Wonders                  | 5–15 per world, named, placed where conditions hold                                        | None                                                                                                              | 5–15 selected in every seed of 1–20 (32–35 candidates each), all named; conditions checked by `tests/wonders.test.ts`                                                                                                                                      | Yes     |
| Props                    | Prop triangles within budget in the standard views                                         | –                                                                                                                 | W7 not started                                                                                                                                                                                                                                             | Not run |
| Existing invariants      | Existing terrain, river and network tests pass                                             | 1,097 tests                                                                                                       | 1,018 tests outside `tests/gpu/` pass (one network-stage test times out under load and passes alone); on the GPU, 95 of 97 pass: the face-seam (0.13 m against 0.05 m) and river-hump (6.5 m against 4 m) tolerances fail on the new worlds (decision 215) | No      |
| Determinism              | Same seed, same output; earlier stages unchanged except where intended                     | –                                                                                                                 | Tests for provinces, lithology, characters with redraws, zones; plates, crust and boundaries byte-identical                                                                                                                                                | Yes     |
| Generation time          | Total pipeline at most 1.5 × the baseline                                                  | Coarse campaign world 11.9 s (median); global finish 8–15 s on top of 9–18 min of erosion                         | Coarse campaign world 14.3 s (+20%); global finish about 29 s (+15 s for zones and the expanded biomes); erosion unchanged in kind                                                                                                                         | Yes     |

## Coarse pass, seeds 1–20 (100 km windows, joint biome and province classes)

| seed            | land ≥ 0.5 bit | land ≥ 1 bit | entropy median (bits) | divergence of two largest (bits) | strata    | buttes    | dry share of highest 5% | arid lakes |
| --------------- | -------------- | ------------ | --------------------- | -------------------------------- | --------- | --------- | ----------------------- | ---------- |
| 1               | 86.9%          | 76.5%        | 1.85                  | 0.21                             | 8.5%      | 7.8%      | 6.5%                    | 0.96%      |
| 2               | 91.1%          | 79.4%        | 1.90                  | 0.51                             | 12.9%     | 11.9%     | 0.7%                    | 1.10%      |
| 3               | 92.0%          | 81.3%        | 1.98                  | 0.42                             | 10.5%     | 9.7%      | 11.5%                   | 0.56%      |
| 4               | 89.9%          | 77.1%        | 1.78                  | 0.47                             | 11.4%     | 10.6%     | 11.4%                   | 1.35%      |
| 5               | 85.5%          | 72.1%        | 1.75                  | 0.25                             | 6.6%      | 6.0%      | 3.1%                    | 1.03%      |
| 6               | 76.8%          | 60.8%        | 1.36                  | 0.85                             | 7.7%      | 7.2%      | 0.2%                    | 1.26%      |
| 7               | 89.3%          | 75.7%        | 1.77                  | 0.69                             | 11.7%     | 11.0%     | 16.3%                   | 2.62%      |
| 8               | 86.9%          | 75.4%        | 1.78                  | 0.64                             | 12.4%     | 11.7%     | 4.8%                    | 1.49%      |
| 9               | 78.3%          | 59.2%        | 1.34                  | 0.98                             | 8.3%      | 7.8%      | 6.2%                    | 0.41%      |
| 10              | 83.4%          | 69.0%        | 1.63                  | 0.72                             | 7.8%      | 7.2%      | 0.3%                    | 0.37%      |
| 11              | 90.8%          | 78.9%        | 1.80                  | 0.67                             | 11.6%     | 10.7%     | 0.1%                    | 0.86%      |
| 12              | 79.8%          | 66.7%        | 1.57                  | 0.45                             | 11.4%     | 10.5%     | 0.0%                    | 0.23%      |
| 13              | 91.0%          | 79.7%        | 1.87                  | 0.80                             | 13.0%     | 12.0%     | 18.7%                   | 1.31%      |
| 14              | 90.7%          | 77.7%        | 1.79                  | 0.37                             | 12.9%     | 11.9%     | 17.3%                   | 1.71%      |
| 15              | 82.5%          | 66.2%        | 1.52                  | 0.29                             | 7.8%      | 7.2%      | 2.1%                    | 1.19%      |
| 16              | 78.2%          | 60.8%        | 1.37                  | 0.16                             | 7.2%      | 6.7%      | 0.0%                    | 0.71%      |
| 17              | 82.9%          | 70.2%        | 1.66                  | 0.87                             | 6.9%      | 6.3%      | 2.6%                    | 2.33%      |
| 18              | 87.6%          | 73.5%        | 1.73                  | 0.83                             | 12.8%     | 12.0%     | 20.8%                   | 1.50%      |
| 19              | 85.3%          | 71.3%        | 1.61                  | 0.44                             | 14.9%     | 14.0%     | 15.3%                   | 2.08%      |
| 20              | 93.1%          | 82.7%        | 2.00                  | 0.43                             | 10.5%     | 9.7%      | 13.2%                   | 0.48%      |
| **median**      | **86.9%**      | **74.5%**    | **1.76**              | **0.49**                         | **10.9%** | **10.1%** | **5.5%**                | **1.15%**  |
| baseline median | 70.0%          | 42.3%        | 0.95                  | 0.35                             | 32.8%     | 32.1%     | 0.0%                    | 0.98%      |

The baseline counted biomes only; the measure now counts joint biome and province classes, as the plan specifies.

### Biomes, seeds 1–20 (coarse)

| biome                    | mean land share | seeds where present (> 0.1%) |
| ------------------------ | --------------- | ---------------------------- |
| ice sheet                | 5.9%            | 18 of 20                     |
| tundra                   | 16.5%           | 20 of 20                     |
| taiga                    | 9.3%            | 20 of 20                     |
| temperate grassland      | 4.4%            | 20 of 20                     |
| temperate forest         | 3.0%            | 20 of 20                     |
| temperate rainforest     | 3.3%            | 20 of 20                     |
| cold desert              | 10.8%           | 20 of 20                     |
| hot desert               | 2.7%            | 20 of 20                     |
| shrubland                | 3.1%            | 20 of 20                     |
| savanna                  | 8.7%            | 20 of 20                     |
| tropical seasonal forest | 4.7%            | 20 of 20                     |
| tropical rainforest      | 3.9%            | 20 of 20                     |
| alpine meadow            | 6.9%            | 20 of 20                     |
| cloud forest             | 2.4%            | 20 of 20                     |
| mangrove                 | 0.4%            | 19 of 20                     |
| rocky desert             | 3.7%            | 20 of 20                     |
| red rock desert          | 1.2%            | 20 of 20                     |
| fog desert               | 4.0%            | 20 of 20                     |
| moorland and heath       | 2.6%            | 20 of 20                     |
| wetland                  | 2.7%            | 20 of 20                     |

### Provinces, seeds 1–20 (coarse)

| province              | mean land share | seeds where present (> 0.1%) |
| --------------------- | --------------- | ---------------------------- |
| young collision range | 9.2%            | 20 of 20                     |
| high plateau          | 12.6%           | 20 of 20                     |
| old mountains         | 6.5%            | 20 of 20                     |
| shield                | 16.2%           | 20 of 20                     |
| basin and range       | 10.2%           | 20 of 20                     |
| rift                  | 3.6%            | 20 of 20                     |
| volcanic arc          | 4.0%            | 20 of 20                     |
| hotspot               | 0.6%            | 18 of 20                     |
| sedimentary basin     | 15.7%           | 20 of 20                     |
| karst platform        | 5.9%            | 20 of 20                     |
| soft sediment         | 2.6%            | 20 of 20                     |
| glaciated lowland     | 12.9%           | 20 of 20                     |

### Continental characters, wonders and salt flats (decisions 210, 212, 214)

| seed | three largest continents                                                             | redraws | wonder candidates | wonders selected | first wonders                                                  | salt flats (airstrips) |
| ---- | ------------------------------------------------------------------------------------ | ------- | ----------------- | ---------------- | -------------------------------------------------------------- | ---------------------- |
| 1    | mixed (956k km²), young mountains (944k km²), mixed (593k km²)                       | 0       | 34                | 13               | Mount Wogro, the Greind Falls, the Keuloy Falls                | 39 (39)                |
| 2    | mixed (978k km²), tropical platform (725k km²), tropical platform (593k km²)         | 0       | 35                | 15               | Mount Vope, the Chabris Falls, the Modanio Falls               | 28 (28)                |
| 3    | dry extension (883k km²), tropical platform (699k km²), tropical platform (672k km²) | 0       | 34                | 11               | the Sezboz Falls, the Boaruy Falls, the Durnish Pillars        | 28 (28)                |
| 4    | tropical platform (753k km²), young mountains (577k km²), dry extension (576k km²)   | 0       | 33                | 8                | the Robrir Falls, the Krishyr Falls, the Protar Towers         | 34 (34)                |
| 5    | tropical platform (845k km²), tropical platform (676k km²), old shield (633k km²)    | 0       | 34                | 8                | the Belatu Falls, the Marbuler Towers, the Fiada Towers        | 20 (20)                |
| 6    | old shield (1015k km²), dry extension (831k km²), old shield (524k km²)              | 0       | 35                | 10               | Mount Brobre, the Pinsiofo Towers, the Vlanyl Pillars          | 32 (32)                |
| 7    | tropical platform (822k km²), young mountains (812k km²), young mountains (704k km²) | 0       | 33                | 11               | Mount Tutauth, Mount Grarri, the Kaukro Falls                  | 22 (22)                |
| 8    | tropical platform (742k km²), tropical platform (721k km²), old shield (709k km²)    | 0       | 33                | 14               | the Nysin Falls, the Napoky Falls, the Tobro Pillars           | 36 (36)                |
| 9    | young mountains (1141k km²), dry extension (664k km²), young mountains (565k km²)    | 0       | 32                | 7                | the Mist Towers, the Theiske Towers, the Gin Pillars           | 27 (27)                |
| 10   | dry extension (927k km²), tropical platform (923k km²), young mountains (804k km²)   | 0       | 33                | 12               | Mount Weir, Mount Hen, the Rofeist Falls                       | 33 (33)                |
| 11   | young mountains (1092k km²), dry extension (952k km²), young mountains (849k km²)    | 1       | 34                | 14               | the Nodi Falls, the Chujik Towers, the Khol Towers             | 34 (34)                |
| 12   | old shield (1164k km²), mixed (769k km²), mixed (732k km²)                           | 0       | 35                | 13               | Mount Akaishay, the Aruku Falls, the Voamate Towers            | 38 (38)                |
| 13   | dry extension (856k km²), old shield (669k km²), tropical platform (650k km²)        | 0       | 33                | 12               | Mount Zaz, the Nelzupry Falls, the Slyatoz Falls               | 35 (35)                |
| 14   | tropical platform (1135k km²), dry extension (758k km²), mixed (713k km²)            | 1       | 34                | 13               | the Khutariz Falls, the Deraulor Falls, the Noheir Towers      | 32 (32)                |
| 15   | old shield (1235k km²), mixed (746k km²), old shield (555k km²)                      | 0       | 34                | 15               | the Gripiabe Falls, the Trucia Falls, the Sola Towers          | 32 (32)                |
| 16   | old shield (891k km²), old shield (709k km²), dry extension (647k km²)               | 0       | 34                | 5                | the Canva Falls, the Nichykviv Towers, the Tafer Pillars       | 16 (16)                |
| 17   | mixed (1139k km²), dry extension (639k km²), tropical platform (624k km²)            | 0       | 33                | 10               | the Pink Lake of Saul, the Raneren Terraces, the Grau Terraces | 26 (26)                |
| 18   | young mountains (709k km²), young mountains (640k km²), mixed (609k km²)             | 0       | 34                | 8                | the Micuda Falls, the Grelias Falls, the Dildo Towers          | 26 (26)                |
| 19   | mixed (894k km²), mixed (633k km²), young mountains (603k km²)                       | 0       | 34                | 15               | Mount Dren, the Vafa Falls, the Higo Towers                    | 20 (20)                |
| 20   | tropical platform (767k km²), old shield (668k km²), old shield (646k km²)           | 0       | 32                | 10               | Mount Far, Mount Bokdoth, the Kausko Falls                     | 40 (40)                |

## Eroded worlds (1024², 16 km windows)

| seed       | max height (m) | > 4 km (km²) | > 6 km (km²) | land ≥ 0.5 bit | land ≥ 1 bit | divergence (bits) | strata | buttes | dry share of highest 5% |
| ---------- | -------------- | ------------ | ------------ | -------------- | ------------ | ----------------- | ------ | ------ | ----------------------- |
| 1          | 8850           | 176295       | 35303        | 48.5%          | 24.2%        | 0.20              | 7.1%   | 4.5%   | 2.3%                    |
| 1 baseline | 8565           | 42483        | 6571         | 28.5%          | 8.7%         | 0.12              | 21.0%  | 17.0%  | 0.1%                    |
| 2          | 9976           | 184601       | 40587        | 50.3%          | 24.4%        | 0.48              | 11.4%  | 7.6%   | 1.5%                    |
| 2 baseline | 9205           | 70424        | 16007        | 34.3%          | 11.2%        | 0.28              | 31.4%  | 26.0%  | 0.1%                    |

Baseline rows count biomes only. The eroded worlds' wetland and mangrove shares predate decision 215 and read 0%.

### Global pass times (eroded seeds)

| seed | stages                                                                                      |
| ---- | ------------------------------------------------------------------------------------------- |
| 1    | detail + upsample 3 s, erosion 1008 s, readback 0 s, drainage, rivers, biomes (worker) 29 s |
| 2    | detail + upsample 4 s, erosion 822 s, readback 0 s, drainage, rivers, biomes (worker) 36 s  |

### Coarse stage times, median of seeds 1–20 (ms)

| stage                       | median ms |
| --------------------------- | --------- |
| grid                        | 0         |
| plates                      | 523       |
| crust                       | 1235      |
| boundaries                  | 33        |
| continents                  | 58        |
| provinces                   | 466       |
| uplift                      | 754       |
| elevation                   | 425       |
| climate                     | 2308      |
| climate modifiers           | 555       |
| lithology                   | 306       |
| biomes                      | 85        |
| distinctness                | 2         |
| coarse drainage             | 382       |
| graph: landmasses           | 71        |
| graph: sites                | 141       |
| graph: nodes                | 23        |
| graph: sea lanes            | 189       |
| graph: settlements          | 173       |
| graph: roads                | 1181      |
| graph: urban extents        | 94        |
| graph: railways             | 236       |
| graph: fronts               | 1079      |
| graph: features: regions    | 174       |
| graph: features: land       | 42        |
| graph: features: water      | 624       |
| graph: features: relief     | 299       |
| graph: features: cover      | 75        |
| graph: features: rivers     | 17        |
| graph: features: salt flats | 9         |
| graph: features: wonders    | 77        |
| graph: features             | 1316      |
| graph: routes               | 19        |
| graph: names                | 13        |
| theaters and casting        | 153       |
| infrastructure: territory   | 80        |
| infrastructure: ports       | 4         |
| infrastructure: airbases    | 913       |
| infrastructure: spur roads  | 8         |
| infrastructure: targets     | 55        |
| infrastructure              | 1085      |
| campaign world total        | 14301     |
