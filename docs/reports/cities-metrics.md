# Cities: Metrics (Proposal 0009, Phase 10)

Bearing is a cartoony browser game; the values and systems here serve gameplay (README.md, What Bearing Is; CLAUDE.md rule 22).

_Measured 2026-11-20 with `tools/cities.preview.ts` over seeds 1–20 on the coarse campaign world (256² cells, about 6 km): per seed five cities, eight towns and eight villages spread over the population ranking, 420 plans in all. The coarse world's heights are smooth, so few streets lie on slopes above 10%; `tests/settlements.test.ts` checks the slope and grade criteria on a 15% hillside as well. Rivers are not passed to this tool (bridges and river setbacks are covered by the unit tests and the render views). Frame budgets are in the second part, from `tools/render.preview.ts` on seed 4's eroded world._

## Generator over 20 Seeds

```
plans: 100 / 160 / 160 (city / town / village)
generation ms mean: 4218 / 288 / 15, max 10652 / 2085 / 77
buildings mean: 94814 / 8486 / 485
minor streets on slopes > 10%: 4.2 km, 68.6% within 30° of the contour
vehicle streets over the grade limit: 0; buildings outside their parcel: 2; parcels without frontage: 0; buildings in water: 0
blocks: 465805, dropped faces: 29156
street km by class: arterial 2850, major 68057, minor 112391, lane 2540, path 12, stairs 7
styles (settlements): eastern bloc 12069, western 13556, arid 1949, mediterranean 2965, nordic 2030
districts (blocks): industrial 10839, residential, detached 205940, civic and parks 34712, microdistrict 54149, inner grid 101873, old core 4312, rail yard 309, power and utilities 100, residential, terraced 53556, port 15
targets: depot 94, factory 655, rail yard 117, power station 100, port 4
world generation: 12.6 s per seed (coarse pass, casting, infrastructure; unchanged by plans, which build on demand)
```

## Against Part A's Criteria

| Check | Criterion | Result |
| --- | --- | --- |
| Structure | No building outside a parcel; every parcel fronts a street or road | 2 of about 9.5 million buildings had a corner outside their parcel by more than 0.1% (a city each in seeds with Mediterranean and Arid styles; open, see the report). No parcel without frontage. |
| Terrain fit | No floating buildings; every plinth reaches the ground; no building or street in water | No building in water over 420 plans. Plinths reach the lowest drawn ground under every footprint plus 1.5–12 m by level (`cityMesh.ts`), by construction. Streets other than arterials are dropped over water. |
| Slopes | On slopes above 10%, most minor street length lies within 30° of the contour | 68.6% over 4.2 km of sloped minor streets on the coarse worlds; above 50% on the 15% hillside of `tests/settlements.test.ts`. |
| Grades | Vehicle streets respect the grade limit; steeper links are stairs or paths | 0 vehicle streets over 10%; 12 km of paths and 7 km of stairs. |
| Styles | Each style appears where its regions exist | All five: Western 13,556 settlements, Eastern bloc 12,069, Mediterranean 2,965, Nordic 2,030, Arid 1,949 (over all settlements of the 20 seeds). |
| Damage | State changes rebuild only the affected building; rubble swap under 2 ms | 0.07 ms in place (`tests/cityRender.test.ts`); a whole chunk of 400 buildings takes about 6 ms when a state needs more triangles. |
| Generation time | Per tier; total worldgen time up at most 30% | Cities 4.2 s mean (max 10.7 s), towns 0.29 s (max 2.1 s), villages 15 ms (max 77 ms), in the worker, on demand. World generation unchanged (12.6 s per seed for the coarse pass, casting and infrastructure): no plan is built with the world. |
| Determinism | Same seed, same settlements; earlier stages unchanged | `tests/settlements.test.ts`: identical plans with other plans built in between, different with another seed. New streams only (`settlements/…`); the existing suites pass. |
| Independence | No settlement module imports game, campaign or faction code | Lint rule (`eslint.config.js`) and a test over the imports. |

## Plans

| Seed | Tier | Name | Population | Style | Streets | Blocks | Parcels | Buildings | Landmarks | Targets | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | city | Vlasyovo | 3382700 | eastern bloc | 12975 | 5052 | 81162 | 84845 | 51 | 9 | 5054 |
| 1 | city | Woato | 794700 | western | 3690 | 1480 | 42297 | 38500 | 28 | 8 | 1458 |
| 1 | city | Krosle | 425900 | eastern bloc | 7326 | 2671 | 40457 | 41735 | 80 | 9 | 3175 |
| 1 | city | Zhoksu | 314600 | eastern bloc | 3342 | 1075 | 18415 | 18206 | 39 | 9 | 1308 |
| 1 | city | Dreidru | 239000 | western | 4707 | 1731 | 49053 | 43642 | 42 | 9 | 1744 |
| 1 | town | Mavuv | 193700 | eastern bloc | 2212 | 731 | 14147 | 14340 | 17 | 3 | 877 |
| 1 | town | Darava | 72100 | eastern bloc | 739 | 228 | 3978 | 4000 | 2 | 0 | 183 |
| 1 | town | Gaureby | 45200 | eastern bloc | 497 | 143 | 3127 | 2725 | 1 | 0 | 146 |
| 1 | town | Uloqdaysar | 33300 | arid | 824 | 264 | 9503 | 8244 | 3 | 0 | 217 |
| 1 | town | Grindist | 26500 | eastern bloc | 310 | 78 | 1729 | 1441 | 2 | 0 | 71 |
| 1 | town | Zevgograd | 22200 | eastern bloc | 321 | 85 | 1348 | 1148 | 2 | 0 | 64 |
| 1 | town | Bosk | 19000 | eastern bloc | 235 | 51 | 924 | 693 | 1 | 0 | 40 |
| 1 | town | Cholets | 16700 | eastern bloc | 239 | 58 | 966 | 762 | 3 | 0 | 49 |
| 1 | village | Baytsirsar | 14900 | mediterranean | 7 | 12 | 840 | 859 | 1 | 0 | 45 |
| 1 | village | Steirn | 11200 | western | 7 | 10 | 417 | 625 | 1 | 0 | 21 |
| 1 | village | Brar | 9000 | western | 5 | 8 | 173 | 263 | 1 | 0 | 8 |
| 1 | village | Zacha | 7500 | eastern bloc | 6 | 9 | 306 | 462 | 2 | 0 | 13 |
| 1 | village | Mokrok | 6500 | eastern bloc | 5 | 8 | 255 | 394 | 1 | 0 | 10 |
| 1 | village | Sladvo | 5700 | eastern bloc | 5 | 8 | 204 | 315 | 1 | 0 | 7 |
| 1 | village | Zojaqkent | 5100 | eastern bloc | 6 | 10 | 202 | 299 | 1 | 0 | 7 |
| 1 | village | Drilnaal | 4600 | eastern bloc | 4 | 7 | 177 | 283 | 2 | 0 | 7 |
| 2 | city | Sichaso | 3408300 | mediterranean | 27367 | 11196 | 294857 | 272064 | 60 | 9 | 8621 |
| 2 | city | Tecusi | 800700 | mediterranean | 28576 | 11681 | 293407 | 269640 | 141 | 9 | 10652 |
| 2 | city | Gruvia | 429100 | mediterranean | 16157 | 6545 | 167927 | 154127 | 59 | 9 | 6904 |
| 2 | city | Giereve | 317000 | mediterranean | 11834 | 4657 | 120697 | 109139 | 60 | 9 | 3619 |
| 2 | city | Setradus | 240800 | western | 4418 | 1567 | 42811 | 38261 | 48 | 9 | 1319 |
| 2 | town | Betrocio | 195100 | arid | 4858 | 1901 | 61266 | 56596 | 39 | 3 | 1543 |
| 2 | town | Daprosfal | 71700 | western | 1237 | 394 | 17642 | 13565 | 1 | 0 | 353 |
| 2 | town | Tavoata | 45200 | western | 870 | 264 | 11511 | 8722 | 2 | 0 | 207 |
| 2 | town | Tabedon | 33300 | western | 545 | 169 | 7206 | 5065 | 2 | 0 | 136 |
| 2 | town | Dysonav | 26600 | eastern bloc | 339 | 74 | 1510 | 1321 | 1 | 0 | 64 |
| 2 | town | Biarano | 22200 | western | 444 | 134 | 5977 | 4107 | 2 | 0 | 106 |
| 2 | town | Meriarvel | 19100 | mediterranean | 485 | 114 | 4716 | 3196 | 2 | 0 | 114 |
| 2 | town | Kamlo | 16800 | eastern bloc | 278 | 69 | 1061 | 881 | 3 | 0 | 53 |
| 2 | village | Pretrelfezza | 14900 | western | 6 | 8 | 546 | 809 | 1 | 0 | 21 |
| 2 | village | Diobra | 11200 | western | 7 | 11 | 490 | 741 | 1 | 0 | 22 |
| 2 | village | Dado | 9100 | western | 5 | 9 | 376 | 573 | 1 | 0 | 16 |
| 2 | village | Biapra | 7600 | western | 7 | 12 | 369 | 556 | 1 | 0 | 16 |
| 2 | village | Kafordal | 6600 | western | 6 | 10 | 315 | 508 | 1 | 0 | 13 |
| 2 | village | Grioscome | 5800 | western | 6 | 8 | 272 | 411 | 1 | 0 | 13 |
| 2 | village | Fotipusello | 5200 | arid | 5 | 7 | 399 | 403 | 1 | 0 | 11 |
| 2 | village | Pretriana | 4700 | western | 6 | 10 | 267 | 405 | 1 | 0 | 10 |
| 3 | city | Tusun | 3753400 | arid | 13955 | 5630 | 144996 | 135783 | 112 | 9 | 5915 |
| 3 | city | Gaufothdal | 748300 | eastern bloc | 12815 | 5086 | 78028 | 81352 | 81 | 9 | 6237 |
| 3 | city | Kadaiz | 433700 | mediterranean | 15567 | 6226 | 167517 | 151831 | 71 | 9 | 4808 |
| 3 | city | Gotur | 309500 | eastern bloc | 4235 | 1537 | 24306 | 24114 | 39 | 9 | 1934 |
| 3 | city | Sonulkent | 242300 | mediterranean | 9201 | 3546 | 90678 | 81219 | 78 | 9 | 2489 |
| 3 | town | Aroarat | 193300 | mediterranean | 3763 | 1443 | 52610 | 45306 | 17 | 3 | 1216 |
| 3 | town | Dragirn | 71900 | eastern bloc | 794 | 230 | 4204 | 3849 | 2 | 0 | 225 |
| 3 | town | Araylzaz | 45100 | eastern bloc | 475 | 128 | 2732 | 2530 | 1 | 0 | 133 |
| 3 | town | Nukanness | 33400 | eastern bloc | 402 | 111 | 2109 | 1960 | 2 | 0 | 90 |
| 3 | town | Nam | 26600 | eastern bloc | 390 | 92 | 1541 | 1395 | 2 | 0 | 70 |
| 3 | town | Qubekaintai | 22100 | arid | 508 | 145 | 6094 | 4896 | 2 | 0 | 115 |
| 3 | town | Wautheth | 19100 | western | 410 | 99 | 4145 | 2792 | 3 | 0 | 91 |
| 3 | town | Drodal | 16700 | eastern bloc | 278 | 66 | 991 | 804 | 3 | 0 | 44 |
| 3 | village | Geshye | 14900 | eastern bloc | 7 | 9 | 454 | 697 | 1 | 0 | 36 |
| 3 | village | Skurwer | 11100 | eastern bloc | 7 | 11 | 379 | 571 | 1 | 0 | 18 |
| 3 | village | Maikhot | 8900 | arid | 7 | 11 | 523 | 530 | 1 | 0 | 20 |
| 3 | village | Nomolsayq | 7500 | eastern bloc | 5 | 7 | 263 | 397 | 2 | 0 | 9 |
| 3 | village | Tonness | 6400 | western | 6 | 9 | 247 | 369 | 1 | 0 | 9 |
| 3 | village | Gannuskanby | 5700 | eastern bloc | 5 | 5 | 232 | 364 | 1 | 0 | 10 |
| 3 | village | Nadar | 5100 | eastern bloc | 5 | 7 | 184 | 288 | 2 | 0 | 10 |
| 3 | village | Chalmomabad | 4600 | arid | 5 | 10 | 319 | 327 | 1 | 0 | 19 |
| 4 | city | Skaa | 3603400 | nordic | 7041 | 2662 | 76966 | 74181 | 38 | 9 | 3747 |
| 4 | city | Prez | 846500 | eastern bloc | 12987 | 5113 | 78176 | 81979 | 66 | 9 | 5906 |
| 4 | city | Holard | 453600 | eastern bloc | 5101 | 1914 | 30884 | 31842 | 31 | 10 | 1951 |
| 4 | city | Kramikon | 314900 | eastern bloc | 5544 | 1960 | 31211 | 32086 | 49 | 9 | 2600 |
| 4 | city | Tikrak | 243100 | eastern bloc | 2075 | 717 | 11029 | 10364 | 19 | 9 | 811 |
| 4 | town | Shubralets | 198900 | eastern bloc | 1656 | 484 | 10226 | 10551 | 16 | 3 | 698 |
| 4 | town | Storemets | 72300 | eastern bloc | 771 | 243 | 4726 | 4366 | 1 | 0 | 220 |
| 4 | town | Stanokinsk | 45400 | western | 902 | 276 | 11711 | 8982 | 2 | 0 | 284 |
| 4 | town | Dvar | 33300 | eastern bloc | 434 | 111 | 1531 | 1547 | 1 | 0 | 131 |
| 4 | town | Dakbo | 26600 | western | 472 | 119 | 5111 | 3685 | 1 | 0 | 112 |
| 4 | town | Werndal | 22200 | eastern bloc | 341 | 86 | 1682 | 1337 | 2 | 0 | 67 |
| 4 | town | Vauskird | 19000 | eastern bloc | 273 | 63 | 1117 | 979 | 3 | 1 | 57 |
| 4 | town | Mokrun | 16700 | eastern bloc | 278 | 56 | 1013 | 850 | 3 | 0 | 52 |
| 4 | village | Bya | 14900 | western | 6 | 8 | 440 | 669 | 1 | 0 | 18 |
| 4 | village | Byazdava | 11200 | eastern bloc | 7 | 13 | 345 | 522 | 2 | 0 | 18 |
| 4 | village | Nuslivinsk | 9100 | eastern bloc | 6 | 9 | 284 | 413 | 1 | 0 | 10 |
| 4 | village | Marn | 7600 | western | 6 | 9 | 334 | 494 | 1 | 0 | 17 |
| 4 | village | Senmaust | 6600 | nordic | 5 | 8 | 196 | 307 | 1 | 0 | 7 |
| 4 | village | Tyskovo | 5800 | eastern bloc | 5 | 9 | 257 | 391 | 1 | 0 | 8 |
| 4 | village | Sloz | 5200 | eastern bloc | 5 | 9 | 230 | 366 | 1 | 0 | 7 |
| 4 | village | Mokraby | 4700 | nordic | 5 | 7 | 137 | 211 | 1 | 0 | 5 |
| 5 | city | Fonvosa | 3533900 | mediterranean | 28527 | 11794 | 307853 | 282438 | 59 | 9 | 10101 |
| 5 | city | Katsun | 830200 | eastern bloc | 12834 | 5122 | 78938 | 83455 | 45 | 9 | 5599 |
| 5 | city | Guaral | 444900 | eastern bloc | 7109 | 2736 | 40195 | 41532 | 77 | 9 | 3892 |
| 5 | city | Sagre | 308900 | arid | 9458 | 3857 | 98415 | 91698 | 66 | 9 | 3780 |
| 5 | city | Araydesh | 238400 | arid | 8241 | 3155 | 82278 | 75734 | 66 | 9 | 2667 |
| 5 | town | Giediosa | 195000 | mediterranean | 5221 | 1899 | 67210 | 58254 | 33 | 3 | 1987 |
| 5 | town | Faprufezza | 71700 | mediterranean | 2008 | 703 | 24335 | 20234 | 2 | 0 | 569 |
| 5 | town | Shayzaykent | 45200 | eastern bloc | 595 | 180 | 2805 | 2695 | 2 | 0 | 151 |
| 5 | town | Tiadisezza | 33300 | mediterranean | 848 | 254 | 11325 | 8295 | 2 | 0 | 234 |
| 5 | town | Kaykhashe | 26600 | arid | 565 | 153 | 5391 | 4607 | 6 | 2 | 146 |
| 5 | town | Kastukaz | 22200 | eastern bloc | 303 | 68 | 1003 | 980 | 1 | 0 | 62 |
| 5 | town | Sosiello | 19100 | mediterranean | 493 | 129 | 5674 | 4073 | 2 | 0 | 119 |
| 5 | town | Derargie | 16800 | mediterranean | 515 | 130 | 4861 | 3538 | 4 | 0 | 125 |
| 5 | village | Bronliezza | 14900 | mediterranean | 7 | 9 | 851 | 867 | 1 | 0 | 72 |
| 5 | village | Ligiora | 11100 | mediterranean | 8 | 13 | 780 | 791 | 1 | 0 | 29 |
| 5 | village | Khotabad | 8900 | eastern bloc | 3 | 5 | 70 | 104 | 2 | 0 | 4 |
| 5 | village | Fergiape | 7400 | mediterranean | 6 | 11 | 517 | 531 | 1 | 0 | 20 |
| 5 | village | Baybin | 6400 | eastern bloc | 5 | 8 | 211 | 335 | 1 | 0 | 7 |
| 5 | village | Milolain | 5700 | western | 6 | 7 | 237 | 350 | 1 | 0 | 8 |
| 5 | village | Havemeha | 5100 | western | 1 | 1 | 8 | 9 | 1 | 0 | 1 |
| 5 | village | Lato | 4600 | mediterranean | 5 | 9 | 326 | 333 | 1 | 0 | 11 |
| 6 | city | Rykrynograd | 2625100 | eastern bloc | 12657 | 4943 | 74250 | 77928 | 65 | 9 | 5870 |
| 6 | city | Gosloch | 753900 | eastern bloc | 7350 | 2900 | 45141 | 46454 | 85 | 9 | 4681 |
| 6 | city | Slazograd | 455600 | eastern bloc | 7103 | 2703 | 38522 | 39626 | 29 | 9 | 3318 |
| 6 | city | Zamidvo | 303300 | western | 8103 | 3123 | 90418 | 81893 | 54 | 9 | 2570 |
| 6 | city | Zyvivka | 244100 | eastern bloc | 4463 | 1607 | 23253 | 23448 | 26 | 9 | 1536 |
| 6 | town | Chupre | 194700 | western | 3420 | 1226 | 51381 | 42516 | 25 | 3 | 1081 |
| 6 | town | Vuvyn | 72400 | eastern bloc | 849 | 262 | 4935 | 4932 | 2 | 1 | 211 |
| 6 | town | Kapyvograd | 45300 | eastern bloc | 431 | 119 | 2069 | 1739 | 1 | 0 | 101 |
| 6 | town | Vlyastiv | 33300 | western | 473 | 127 | 7259 | 4950 | 1 | 0 | 223 |
| 6 | town | Prya | 26500 | western | 520 | 144 | 6138 | 4075 | 3 | 0 | 139 |
| 6 | town | Lytyinsk | 22200 | nordic | 138 | 43 | 1407 | 1186 | 2 | 0 | 43 |
| 6 | town | Sya | 19100 | western | 361 | 102 | 4879 | 3165 | 3 | 0 | 93 |
| 6 | town | Tovka | 16700 | western | 285 | 63 | 2490 | 1732 | 2 | 0 | 61 |
| 6 | village | Slechomovo | 14900 | western | 7 | 9 | 599 | 913 | 1 | 0 | 22 |
| 6 | village | Krol | 11300 | western | 6 | 8 | 481 | 726 | 1 | 0 | 15 |
| 6 | village | Chulinsk | 9200 | eastern bloc | 7 | 11 | 341 | 516 | 2 | 0 | 13 |
| 6 | village | Nyasatom | 7700 | western | 6 | 9 | 325 | 508 | 1 | 0 | 11 |
| 6 | village | Bokrupro | 6700 | eastern bloc | 5 | 8 | 242 | 377 | 1 | 0 | 7 |
| 6 | village | Minovlyn | 5900 | eastern bloc | 6 | 10 | 288 | 436 | 2 | 0 | 9 |
| 6 | village | Dvuchanograd | 5300 | western | 5 | 8 | 272 | 416 | 1 | 0 | 8 |
| 6 | village | Dorya | 4800 | eastern bloc | 4 | 6 | 181 | 275 | 1 | 0 | 6 |
| 7 | city | Kraatheidal | 3552500 | western | 10443 | 3939 | 106838 | 96076 | 55 | 9 | 3994 |
| 7 | city | Feind | 834600 | nordic | 9278 | 3507 | 100190 | 95192 | 40 | 9 | 4483 |
| 7 | city | Dilberg | 447200 | western | 11728 | 4522 | 132672 | 121741 | 72 | 9 | 4815 |
| 7 | city | Sorford | 310500 | western | 8094 | 3145 | 92011 | 82376 | 39 | 9 | 3230 |
| 7 | city | Kohoanu | 239700 | western | 1013 | 272 | 6635 | 5110 | 16 | 6 | 286 |
| 7 | town | Draafon | 196100 | western | 3519 | 1269 | 52446 | 44440 | 36 | 3 | 1368 |
| 7 | town | Fen | 72100 | western | 1294 | 415 | 18406 | 14594 | 1 | 0 | 361 |
| 7 | town | Ton | 45100 | western | 742 | 221 | 9974 | 7581 | 2 | 0 | 209 |
| 7 | town | Saanandal | 33300 | western | 615 | 164 | 7288 | 5271 | 1 | 0 | 158 |
| 7 | town | Bumun | 26500 | eastern bloc | 309 | 68 | 910 | 765 | 1 | 0 | 56 |
| 7 | town | Vunforberg | 22100 | western | 414 | 101 | 4974 | 3249 | 1 | 0 | 95 |
| 7 | town | Lubira | 19000 | mediterranean | 478 | 137 | 5982 | 4263 | 3 | 0 | 138 |
| 7 | town | Krofeist | 16700 | western | 310 | 71 | 2973 | 1807 | 3 | 0 | 74 |
| 7 | village | Wodraurnby | 14900 | western | 7 | 12 | 557 | 841 | 1 | 0 | 41 |
| 7 | village | Gaa | 11300 | western | 7 | 10 | 492 | 755 | 1 | 0 | 19 |
| 7 | village | Graasor | 9100 | western | 6 | 8 | 416 | 632 | 1 | 0 | 13 |
| 7 | village | Drar | 7700 | eastern bloc | 5 | 9 | 283 | 430 | 2 | 0 | 15 |
| 7 | village | Steileistad | 6600 | western | 5 | 6 | 289 | 427 | 1 | 0 | 15 |
| 7 | village | Brend | 5900 | eastern bloc | 6 | 8 | 262 | 394 | 1 | 0 | 10 |
| 7 | village | Thir | 5300 | western | 4 | 6 | 241 | 361 | 1 | 0 | 7 |
| 7 | village | Stei | 4800 | western | 4 | 7 | 210 | 325 | 1 | 0 | 7 |
| 8 | city | Nose | 3065100 | eastern bloc | 10305 | 3975 | 60551 | 64023 | 47 | 9 | 4340 |
| 8 | city | Dvobyinsk | 720100 | eastern bloc | 7841 | 3084 | 47452 | 48540 | 67 | 9 | 3702 |
| 8 | city | Cheva | 424300 | eastern bloc | 7072 | 2706 | 42367 | 44177 | 53 | 9 | 2269 |
| 8 | city | Pigere | 304700 | eastern bloc | 4030 | 1474 | 21797 | 22166 | 25 | 8 | 1149 |
| 8 | city | Hibondby | 239400 | western | 6094 | 2272 | 68894 | 61247 | 42 | 9 | 2127 |
| 8 | town | Their | 197900 | western | 3704 | 1321 | 53268 | 46010 | 11 | 3 | 1486 |
| 8 | town | Mara | 72600 | western | 1303 | 429 | 18594 | 14554 | 4 | 2 | 401 |
| 8 | town | Biadominosa | 45300 | mediterranean | 1209 | 403 | 15498 | 12316 | 3 | 0 | 269 |
| 8 | town | Khoztut | 33300 | eastern bloc | 416 | 115 | 1865 | 1627 | 3 | 0 | 81 |
| 8 | town | Madyaztymava | 26500 | western | 531 | 157 | 6627 | 4614 | 2 | 0 | 114 |
| 8 | town | Nekypach | 22200 | nordic | 202 | 46 | 2009 | 1661 | 3 | 0 | 59 |
| 8 | town | Stomyrets | 19000 | eastern bloc | 317 | 80 | 1072 | 873 | 3 | 0 | 51 |
| 8 | town | Brodvom | 16700 | western | 429 | 101 | 3159 | 2164 | 2 | 0 | 71 |
| 8 | village | Rulca | 14900 | mediterranean | 8 | 12 | 881 | 893 | 1 | 0 | 33 |
| 8 | village | Vyzho | 11200 | western | 7 | 10 | 388 | 577 | 1 | 0 | 13 |
| 8 | village | Soz | 9000 | western | 6 | 6 | 394 | 606 | 1 | 0 | 13 |
| 8 | village | Dokach | 7600 | western | 7 | 9 | 336 | 509 | 1 | 0 | 13 |
| 8 | village | Sumoshyan | 6500 | nordic | 5 | 8 | 206 | 326 | 1 | 0 | 6 |
| 8 | village | Dvasyr | 5800 | eastern bloc | 6 | 12 | 208 | 323 | 1 | 0 | 8 |
| 8 | village | Dechovo | 5200 | eastern bloc | 5 | 7 | 186 | 276 | 1 | 0 | 6 |
| 8 | village | Chiotil | 4700 | western | 5 | 9 | 222 | 331 | 1 | 0 | 7 |
| 9 | city | Kerik | 2779500 | western | 15488 | 6239 | 178858 | 165388 | 77 | 9 | 6180 |
| 9 | city | Bei | 798200 | eastern bloc | 12911 | 5118 | 79470 | 83979 | 95 | 9 | 4811 |
| 9 | city | Hakanstad | 427700 | western | 8587 | 3221 | 89801 | 81218 | 84 | 9 | 3108 |
| 9 | city | Krifin | 321200 | eastern bloc | 4412 | 1601 | 25291 | 25664 | 16 | 9 | 1487 |
| 9 | city | Nudroth | 242900 | eastern bloc | 4076 | 1453 | 22909 | 22986 | 45 | 9 | 1507 |
| 9 | town | Tanstad | 196400 | western | 3066 | 1102 | 44264 | 36684 | 12 | 3 | 1072 |
| 9 | town | Krimei | 71900 | eastern bloc | 777 | 234 | 5064 | 4988 | 2 | 0 | 252 |
| 9 | town | Sonaa | 45300 | western | 827 | 249 | 10480 | 8016 | 1 | 0 | 197 |
| 9 | town | Von | 33400 | western | 515 | 137 | 7274 | 4704 | 2 | 0 | 135 |
| 9 | town | Kreirbakdal | 26500 | western | 501 | 121 | 5170 | 3366 | 1 | 0 | 125 |
| 9 | town | Son | 22100 | eastern bloc | 337 | 80 | 1341 | 1059 | 2 | 0 | 64 |
| 9 | town | Steimauk | 19000 | western | 378 | 85 | 3887 | 2388 | 2 | 0 | 74 |
| 9 | town | Stosa | 16700 | eastern bloc | 295 | 62 | 913 | 768 | 3 | 0 | 41 |
| 9 | village | Seindal | 14900 | nordic | 6 | 10 | 347 | 530 | 1 | 0 | 13 |
| 9 | village | Farlorn | 11200 | eastern bloc | 6 | 10 | 347 | 543 | 2 | 0 | 20 |
| 9 | village | Badok | 9100 | western | 5 | 7 | 352 | 537 | 1 | 0 | 17 |
| 9 | village | Hohir | 7600 | western | 6 | 10 | 312 | 471 | 1 | 0 | 16 |
| 9 | village | Thon | 6600 | western | 6 | 10 | 340 | 527 | 1 | 0 | 16 |
| 9 | village | Thaankardby | 5800 | western | 7 | 9 | 349 | 525 | 1 | 0 | 15 |
| 9 | village | Iru | 5200 | western | 6 | 10 | 279 | 426 | 1 | 0 | 13 |
| 9 | village | Tern | 4700 | western | 4 | 6 | 197 | 309 | 1 | 0 | 7 |
| 10 | city | Baullon | 3518000 | western | 20732 | 8415 | 237798 | 221752 | 36 | 9 | 8300 |
| 10 | city | Wardberg | 826500 | western | 21403 | 8573 | 234170 | 216964 | 83 | 9 | 8979 |
| 10 | city | Gond | 442900 | western | 11673 | 4591 | 130407 | 118774 | 42 | 9 | 3951 |
| 10 | city | Steirn | 307500 | eastern bloc | 3360 | 1224 | 18854 | 18477 | 22 | 10 | 1411 |
| 10 | city | Vaathorn | 237300 | western | 6512 | 2405 | 66208 | 59630 | 71 | 9 | 2447 |
| 10 | town | Lanu | 194200 | eastern bloc | 1329 | 381 | 7935 | 7691 | 4 | 3 | 495 |
| 10 | town | Nirn | 72200 | eastern bloc | 896 | 271 | 5766 | 5240 | 1 | 0 | 221 |
| 10 | town | Kabrin | 45300 | western | 800 | 215 | 10387 | 7643 | 1 | 0 | 208 |
| 10 | town | Weist | 33400 | western | 588 | 164 | 7329 | 4979 | 1 | 0 | 169 |
| 10 | town | Fumaa | 26600 | western | 495 | 138 | 6043 | 4263 | 2 | 0 | 128 |
| 10 | town | Binby | 22100 | western | 406 | 110 | 5570 | 3533 | 2 | 0 | 99 |
| 10 | town | Steir | 19000 | western | 342 | 85 | 3831 | 2561 | 3 | 0 | 71 |
| 10 | town | Maaldal | 16700 | eastern bloc | 250 | 54 | 578 | 536 | 2 | 1 | 39 |
| 10 | village | Sterder | 14900 | western | 7 | 11 | 479 | 725 | 1 | 0 | 25 |
| 10 | village | Gaund | 11300 | eastern bloc | 7 | 10 | 389 | 619 | 2 | 0 | 13 |
| 10 | village | Semindberg | 9100 | eastern bloc | 7 | 10 | 378 | 582 | 2 | 0 | 14 |
| 10 | village | Thanfothdal | 7700 | eastern bloc | 6 | 7 | 314 | 484 | 1 | 0 | 13 |
| 10 | village | Nudest | 6600 | western | 6 | 8 | 310 | 467 | 1 | 0 | 10 |
| 10 | village | Naaheithberg | 5900 | western | 5 | 8 | 282 | 430 | 1 | 0 | 9 |
| 10 | village | Vala | 5300 | western | 6 | 11 | 280 | 417 | 1 | 0 | 10 |
| 10 | village | Sensor | 4800 | western | 4 | 6 | 226 | 348 | 1 | 0 | 7 |
| 11 | city | Sekhem | 3618400 | eastern bloc | 12800 | 5068 | 76937 | 81001 | 84 | 9 | 5275 |
| 11 | city | Kekabad | 850000 | eastern bloc | 12932 | 4973 | 76444 | 80950 | 66 | 9 | 5886 |
| 11 | city | Yakhul | 455500 | eastern bloc | 7613 | 2871 | 44726 | 46671 | 37 | 9 | 2665 |
| 11 | city | Boz | 316200 | eastern bloc | 5051 | 1828 | 27493 | 26898 | 65 | 9 | 1763 |
| 11 | city | Khachok | 244100 | eastern bloc | 3896 | 1390 | 20706 | 20865 | 45 | 9 | 1639 |
| 11 | town | Arotarazul | 199700 | eastern bloc | 2510 | 847 | 16515 | 17245 | 18 | 3 | 838 |
| 11 | town | Shosaynkent | 72600 | eastern bloc | 686 | 189 | 4642 | 4197 | 7 | 3 | 183 |
| 11 | town | Taytzimgul | 45300 | eastern bloc | 535 | 139 | 3165 | 2946 | 2 | 0 | 117 |
| 11 | town | Saykqaytsar | 33500 | eastern bloc | 435 | 126 | 2340 | 2004 | 1 | 0 | 119 |
| 11 | town | Shaynai | 26600 | eastern bloc | 306 | 80 | 1590 | 1326 | 2 | 0 | 64 |
| 11 | town | Buaramul | 22100 | eastern bloc | 279 | 58 | 1045 | 888 | 2 | 0 | 80 |
| 11 | town | Zuqjarul | 19100 | eastern bloc | 309 | 78 | 1072 | 923 | 3 | 0 | 56 |
| 11 | town | Yugaq | 16700 | eastern bloc | 252 | 64 | 1124 | 809 | 2 | 0 | 42 |
| 11 | village | Taykkent | 14900 | eastern bloc | 6 | 9 | 432 | 661 | 2 | 0 | 18 |
| 11 | village | Kak | 11200 | mediterranean | 8 | 11 | 926 | 941 | 1 | 0 | 28 |
| 11 | village | Nirbayl | 9100 | eastern bloc | 5 | 6 | 260 | 384 | 1 | 0 | 8 |
| 11 | village | Geznet | 7600 | arid | 6 | 10 | 472 | 479 | 1 | 0 | 14 |
| 11 | village | Aruz | 6600 | eastern bloc | 6 | 9 | 268 | 401 | 2 | 0 | 9 |
| 11 | village | Araydair | 5800 | eastern bloc | 7 | 10 | 279 | 435 | 1 | 0 | 9 |
| 11 | village | Chashut | 5200 | arid | 5 | 9 | 386 | 391 | 1 | 0 | 11 |
| 11 | village | Shoqair | 4700 | eastern bloc | 6 | 9 | 188 | 281 | 2 | 0 | 6 |
| 12 | city | Korkaibez | 2925200 | eastern bloc | 11662 | 4491 | 66135 | 68511 | 87 | 9 | 5504 |
| 12 | city | Slor | 840100 | western | 19289 | 7915 | 215761 | 202481 | 57 | 9 | 6680 |
| 12 | city | Chanarom | 450200 | arid | 14856 | 5986 | 152120 | 143052 | 83 | 9 | 5259 |
| 12 | city | Videv | 312500 | western | 4743 | 1867 | 49449 | 45029 | 35 | 9 | 1758 |
| 12 | city | Naakikent | 241200 | eastern bloc | 4244 | 1567 | 21037 | 21594 | 32 | 9 | 1430 |
| 12 | town | Dinovo | 197300 | western | 3575 | 1251 | 53497 | 45009 | 11 | 3 | 1545 |
| 12 | town | Nem | 72300 | eastern bloc | 726 | 205 | 4395 | 4007 | 2 | 0 | 230 |
| 12 | town | Qaygaso | 45100 | eastern bloc | 488 | 144 | 3156 | 2819 | 2 | 0 | 135 |
| 12 | town | Ulaiq | 33400 | arid | 812 | 258 | 9525 | 8049 | 3 | 0 | 186 |
| 12 | town | Dvyapra | 26500 | western | 518 | 135 | 5528 | 3737 | 1 | 0 | 121 |
| 12 | town | Nedijait | 22200 | mediterranean | 582 | 160 | 6682 | 4809 | 2 | 0 | 188 |
| 12 | town | Sar | 19000 | eastern bloc | 328 | 80 | 1497 | 1187 | 1 | 0 | 49 |
| 12 | town | Vlymvets | 16700 | western | 371 | 89 | 3341 | 2257 | 2 | 0 | 78 |
| 12 | village | Taitai | 14900 | arid | 7 | 11 | 824 | 830 | 1 | 0 | 77 |
| 12 | village | Duznay | 11200 | arid | 7 | 11 | 599 | 604 | 1 | 0 | 32 |
| 12 | village | Sutakon | 9100 | arid | 6 | 9 | 529 | 536 | 0 | 0 | 23 |
| 12 | village | Jagazboz | 7600 | eastern bloc | 6 | 10 | 287 | 422 | 1 | 0 | 11 |
| 12 | village | Ulibuaku | 6600 | mediterranean | 5 | 7 | 473 | 482 | 1 | 0 | 18 |
| 12 | village | Vli | 5800 | eastern bloc | 6 | 8 | 236 | 350 | 1 | 0 | 9 |
| 12 | village | Bibu | 5200 | eastern bloc | 4 | 6 | 214 | 321 | 1 | 0 | 7 |
| 12 | village | Aketasuk | 4700 | mediterranean | 6 | 12 | 399 | 412 | 1 | 0 | 13 |
| 13 | city | Vade | 3703500 | eastern bloc | 12999 | 5095 | 79685 | 83904 | 51 | 9 | 5599 |
| 13 | city | Nusolograd | 738400 | nordic | 11131 | 4204 | 126467 | 123270 | 59 | 9 | 5832 |
| 13 | city | Dveslu | 427900 | eastern bloc | 5078 | 1826 | 27666 | 27841 | 61 | 9 | 1567 |
| 13 | city | Zuzdov | 305400 | eastern bloc | 5286 | 1967 | 29458 | 29748 | 54 | 9 | 2590 |
| 13 | city | Makomdask | 239100 | eastern bloc | 3780 | 1360 | 23081 | 22850 | 20 | 8 | 1515 |
| 13 | town | Krun | 197300 | western | 3330 | 1140 | 49655 | 41770 | 14 | 3 | 1349 |
| 13 | town | Goprizho | 71800 | eastern bloc | 848 | 274 | 4423 | 4226 | 2 | 0 | 346 |
| 13 | town | Vlyadvomava | 45100 | eastern bloc | 503 | 144 | 2544 | 2427 | 3 | 0 | 136 |
| 13 | town | Pumava | 33300 | western | 601 | 173 | 7888 | 5657 | 1 | 0 | 155 |
| 13 | town | Rastalinsk | 26500 | eastern bloc | 322 | 73 | 1674 | 1488 | 1 | 0 | 69 |
| 13 | town | Tosograd | 22100 | eastern bloc | 328 | 76 | 1203 | 1070 | 1 | 0 | 57 |
| 13 | town | Vlyto | 19000 | western | 330 | 82 | 3861 | 2497 | 2 | 0 | 77 |
| 13 | town | Zammyroch | 16700 | eastern bloc | 318 | 83 | 1256 | 1054 | 2 | 0 | 49 |
| 13 | village | Slymmy | 14900 | eastern bloc | 6 | 8 | 451 | 678 | 1 | 0 | 19 |
| 13 | village | Tavlyava | 11200 | eastern bloc | 6 | 9 | 306 | 446 | 1 | 0 | 12 |
| 13 | village | Dito | 9100 | western | 6 | 9 | 376 | 572 | 1 | 0 | 11 |
| 13 | village | Rekoz | 7600 | eastern bloc | 7 | 13 | 318 | 499 | 1 | 0 | 12 |
| 13 | village | Zhyarbyrinsk | 6600 | eastern bloc | 7 | 10 | 277 | 426 | 2 | 0 | 10 |
| 13 | village | Slervo | 5800 | western | 5 | 7 | 264 | 395 | 1 | 0 | 8 |
| 13 | village | Binavograd | 5200 | eastern bloc | 5 | 8 | 255 | 383 | 1 | 0 | 8 |
| 13 | village | Krika | 4700 | eastern bloc | 4 | 8 | 187 | 283 | 1 | 0 | 7 |
| 14 | city | Satgaz | 4294500 | eastern bloc | 1986 | 686 | 13155 | 12583 | 22 | 7 | 608 |
| 14 | city | Nekrirdal | 745300 | western | 19432 | 7774 | 220185 | 202172 | 71 | 9 | 6714 |
| 14 | city | Dreirn | 426900 | western | 11217 | 4494 | 130327 | 119393 | 34 | 9 | 4825 |
| 14 | city | Lokvanby | 303400 | western | 7981 | 3079 | 90246 | 82288 | 29 | 9 | 3430 |
| 14 | city | Hau | 237000 | western | 5259 | 1946 | 57049 | 51060 | 31 | 9 | 1573 |
| 14 | town | Stibraath | 195300 | western | 3542 | 1239 | 51634 | 43982 | 33 | 3 | 1307 |
| 14 | town | Braunsen | 72000 | western | 1387 | 461 | 18735 | 15276 | 2 | 0 | 349 |
| 14 | town | Hukaststad | 45100 | western | 843 | 258 | 11610 | 8596 | 1 | 0 | 272 |
| 14 | town | Sogardby | 33300 | nordic | 328 | 74 | 3114 | 2689 | 3 | 0 | 97 |
| 14 | town | Wurdberg | 26500 | eastern bloc | 345 | 81 | 1787 | 1451 | 2 | 0 | 75 |
| 14 | town | Zadaishsar | 22200 | eastern bloc | 275 | 59 | 1045 | 762 | 3 | 0 | 60 |
| 14 | town | Mokdal | 19000 | western | 253 | 65 | 3187 | 1976 | 2 | 1 | 60 |
| 14 | town | Jirgurtai | 16700 | arid | 412 | 97 | 4115 | 3122 | 2 | 0 | 83 |
| 14 | village | Skond | 14900 | eastern bloc | 6 | 8 | 391 | 563 | 1 | 0 | 16 |
| 14 | village | Sheqakir | 11200 | eastern bloc | 7 | 11 | 429 | 639 | 1 | 0 | 16 |
| 14 | village | Tin | 8900 | western | 6 | 9 | 370 | 562 | 1 | 0 | 12 |
| 14 | village | Gukreirness | 7500 | western | 6 | 10 | 339 | 520 | 1 | 0 | 11 |
| 14 | village | Skahekha | 6500 | western | 7 | 10 | 264 | 385 | 1 | 0 | 10 |
| 14 | village | Skaaness | 5700 | eastern bloc | 5 | 10 | 207 | 325 | 1 | 0 | 8 |
| 14 | village | Thurlurd | 5100 | western | 5 | 8 | 296 | 463 | 1 | 0 | 13 |
| 14 | village | Lanmein | 4600 | western | 5 | 11 | 193 | 299 | 1 | 0 | 9 |
| 15 | city | Navi | 2910000 | mediterranean | 26676 | 10910 | 297579 | 275597 | 55 | 9 | 9656 |
| 15 | city | Pifiosa | 835700 | mediterranean | 28420 | 11663 | 301644 | 279189 | 112 | 9 | 9722 |
| 15 | city | Gilordal | 447800 | nordic | 4552 | 1701 | 53248 | 50802 | 35 | 9 | 2325 |
| 15 | city | Giechiezza | 310900 | mediterranean | 11647 | 4662 | 117993 | 106457 | 102 | 9 | 4387 |
| 15 | city | Biagienezza | 240000 | western | 6038 | 2279 | 70460 | 62753 | 32 | 9 | 1996 |
| 15 | town | Lena | 196300 | mediterranean | 5212 | 1971 | 68687 | 59703 | 48 | 3 | 2085 |
| 15 | town | Melsello | 72000 | western | 1219 | 396 | 17893 | 14210 | 2 | 0 | 404 |
| 15 | town | Gotash | 45300 | eastern bloc | 492 | 153 | 2829 | 2656 | 1 | 0 | 149 |
| 15 | town | Sopriornira | 33400 | mediterranean | 885 | 263 | 11148 | 8570 | 2 | 0 | 253 |
| 15 | town | Brugiucho | 26500 | western | 519 | 131 | 5596 | 3810 | 2 | 0 | 148 |
| 15 | town | Prubopren | 22100 | western | 393 | 110 | 4708 | 3238 | 1 | 0 | 137 |
| 15 | town | Branano | 19100 | western | 400 | 111 | 4395 | 2997 | 3 | 0 | 96 |
| 15 | town | Bripredezza | 16800 | mediterranean | 442 | 104 | 4976 | 3255 | 3 | 0 | 93 |
| 15 | village | Pibrelello | 14900 | mediterranean | 7 | 10 | 1040 | 1057 | 1 | 0 | 40 |
| 15 | village | Gaulol | 11200 | arid | 7 | 10 | 738 | 745 | 0 | 0 | 26 |
| 15 | village | Tema | 9000 | western | 5 | 10 | 336 | 522 | 1 | 0 | 13 |
| 15 | village | Riafon | 7500 | western | 5 | 7 | 306 | 457 | 1 | 0 | 10 |
| 15 | village | Ulukumul | 6500 | eastern bloc | 6 | 10 | 250 | 367 | 1 | 0 | 9 |
| 15 | village | Guko | 5700 | eastern bloc | 7 | 13 | 249 | 372 | 2 | 0 | 9 |
| 15 | village | Raur | 5100 | nordic | 4 | 7 | 153 | 229 | 1 | 0 | 8 |
| 15 | village | Ulaulemsar | 4700 | eastern bloc | 5 | 8 | 199 | 295 | 1 | 0 | 7 |
| 16 | city | Grogius | 2332600 | mediterranean | 23341 | 9358 | 239793 | 218243 | 81 | 9 | 8597 |
| 16 | city | Zadvyan | 669900 | eastern bloc | 8689 | 3246 | 50131 | 50976 | 85 | 9 | 4360 |
| 16 | city | Tonira | 404800 | mediterranean | 14756 | 5928 | 151236 | 137478 | 113 | 9 | 6325 |
| 16 | city | Tudo | 293700 | eastern bloc | 4993 | 1847 | 29671 | 30263 | 32 | 9 | 1766 |
| 16 | city | Fabriosa | 231900 | western | 4318 | 1545 | 41476 | 37047 | 35 | 9 | 1586 |
| 16 | town | Greprefosa | 192400 | western | 3414 | 1230 | 51546 | 42493 | 29 | 3 | 1414 |
| 16 | town | Prurpo | 71600 | mediterranean | 1874 | 648 | 24330 | 20124 | 3 | 0 | 492 |
| 16 | town | Bynyets | 45200 | eastern bloc | 490 | 132 | 3035 | 2603 | 2 | 0 | 121 |
| 16 | town | Hemard | 33400 | western | 605 | 153 | 5925 | 4407 | 4 | 2 | 152 |
| 16 | town | Regu | 26500 | eastern bloc | 403 | 97 | 1745 | 1516 | 3 | 0 | 108 |
| 16 | town | Brya | 22100 | eastern bloc | 307 | 74 | 1415 | 1263 | 3 | 0 | 64 |
| 16 | town | Nyznask | 19000 | eastern bloc | 300 | 67 | 1418 | 1105 | 2 | 0 | 66 |
| 16 | town | Biogiunir | 16800 | western | 382 | 94 | 3881 | 2479 | 3 | 0 | 83 |
| 16 | village | Braribri | 14900 | mediterranean | 7 | 10 | 887 | 901 | 1 | 0 | 49 |
| 16 | village | Macele | 11300 | western | 7 | 8 | 457 | 702 | 1 | 0 | 14 |
| 16 | village | Tustar | 9100 | western | 6 | 10 | 385 | 576 | 1 | 0 | 13 |
| 16 | village | Triamomu | 7600 | western | 7 | 10 | 383 | 575 | 1 | 0 | 12 |
| 16 | village | Sich | 6600 | western | 5 | 9 | 291 | 426 | 1 | 0 | 9 |
| 16 | village | Slavomava | 5800 | eastern bloc | 5 | 10 | 238 | 361 | 2 | 0 | 8 |
| 16 | village | Muykent | 5200 | eastern bloc | 4 | 8 | 190 | 308 | 1 | 0 | 12 |
| 16 | village | Cegiupriano | 4700 | western | 5 | 7 | 213 | 328 | 1 | 0 | 8 |
| 17 | city | Baaberg | 3063100 | western | 16002 | 6462 | 183919 | 169634 | 30 | 9 | 6150 |
| 17 | city | Rinnaa | 719600 | western | 18944 | 7652 | 220306 | 203955 | 35 | 9 | 7399 |
| 17 | city | Stan | 424000 | eastern bloc | 7574 | 2913 | 43100 | 44378 | 53 | 9 | 3022 |
| 17 | city | Ken | 304500 | western | 6469 | 2464 | 74986 | 67800 | 47 | 9 | 2798 |
| 17 | city | Waihure | 239200 | western | 2431 | 767 | 22050 | 18541 | 11 | 7 | 584 |
| 17 | town | Drelaard | 197800 | western | 3828 | 1419 | 55393 | 46790 | 24 | 3 | 1605 |
| 17 | town | Thaheinness | 72500 | western | 1289 | 420 | 19697 | 14457 | 1 | 0 | 425 |
| 17 | town | Munkedal | 45300 | western | 693 | 203 | 8721 | 6610 | 2 | 2 | 180 |
| 17 | town | Skathstad | 33300 | western | 664 | 182 | 7370 | 5613 | 1 | 0 | 162 |
| 17 | town | Baanhuth | 26500 | western | 390 | 97 | 4679 | 2787 | 2 | 0 | 95 |
| 17 | town | Graun | 22200 | eastern bloc | 321 | 84 | 1728 | 1457 | 3 | 0 | 76 |
| 17 | town | Beirndal | 19000 | western | 419 | 115 | 4285 | 3039 | 2 | 0 | 82 |
| 17 | town | Draul | 16700 | western | 254 | 57 | 1776 | 1165 | 2 | 2 | 52 |
| 17 | village | Riwaathberg | 14900 | western | 6 | 8 | 569 | 840 | 1 | 0 | 25 |
| 17 | village | Skauduth | 11300 | western | 7 | 12 | 446 | 681 | 1 | 0 | 18 |
| 17 | village | Lur | 9100 | western | 6 | 10 | 369 | 541 | 1 | 0 | 16 |
| 17 | village | Braanby | 7700 | eastern bloc | 5 | 6 | 271 | 409 | 2 | 0 | 10 |
| 17 | village | Hendal | 6600 | eastern bloc | 7 | 12 | 290 | 432 | 1 | 0 | 9 |
| 17 | village | Ganoberstad | 5800 | western | 5 | 9 | 280 | 434 | 1 | 0 | 9 |
| 17 | village | Werer | 5200 | western | 5 | 6 | 201 | 310 | 1 | 0 | 7 |
| 17 | village | Limi | 4800 | western | 4 | 4 | 39 | 58 | 1 | 0 | 2 |
| 18 | city | Chudofira | 3386200 | mediterranean | 26447 | 11173 | 291281 | 269105 | 84 | 9 | 9631 |
| 18 | city | Lenfo | 795500 | mediterranean | 26213 | 10576 | 278696 | 254749 | 128 | 9 | 10254 |
| 18 | city | Pefezza | 426300 | mediterranean | 16117 | 6688 | 167097 | 153290 | 38 | 9 | 4801 |
| 18 | city | Gieru | 314900 | mediterranean | 11458 | 4565 | 119150 | 106210 | 65 | 9 | 4813 |
| 18 | city | Vusbio | 239200 | western | 6246 | 2406 | 69488 | 63313 | 36 | 9 | 2470 |
| 18 | town | Dionoria | 193900 | mediterranean | 3488 | 1251 | 46576 | 39812 | 14 | 3 | 1311 |
| 18 | town | Prania | 72100 | mediterranean | 1757 | 622 | 25087 | 19897 | 2 | 0 | 612 |
| 18 | town | Rafo | 45200 | mediterranean | 1120 | 371 | 14869 | 11622 | 2 | 0 | 350 |
| 18 | town | Biatafa | 33300 | western | 620 | 180 | 7665 | 5864 | 1 | 0 | 220 |
| 18 | town | Datrio | 26500 | western | 509 | 137 | 5616 | 4114 | 1 | 0 | 132 |
| 18 | town | Vorezza | 22200 | mediterranean | 577 | 159 | 6898 | 4860 | 3 | 0 | 161 |
| 18 | town | Tobemira | 19100 | western | 345 | 89 | 3910 | 2577 | 1 | 0 | 82 |
| 18 | town | Triagrire | 16700 | mediterranean | 497 | 137 | 5357 | 3684 | 3 | 0 | 108 |
| 18 | village | Dobronbosa | 14900 | western | 6 | 8 | 501 | 740 | 1 | 0 | 21 |
| 18 | village | Vigrezza | 11300 | mediterranean | 7 | 10 | 494 | 505 | 1 | 0 | 15 |
| 18 | village | Loslacia | 9100 | western | 6 | 8 | 357 | 552 | 1 | 0 | 14 |
| 18 | village | Pediochello | 7700 | mediterranean | 6 | 9 | 541 | 552 | 1 | 0 | 21 |
| 18 | village | Fuma | 6600 | arid | 6 | 11 | 481 | 494 | 1 | 0 | 19 |
| 18 | village | Ciopramia | 5900 | mediterranean | 5 | 7 | 446 | 456 | 1 | 0 | 14 |
| 18 | village | Radono | 5300 | western | 5 | 7 | 266 | 408 | 1 | 0 | 9 |
| 18 | village | Priorodello | 4800 | western | 5 | 7 | 263 | 391 | 1 | 0 | 12 |
| 19 | city | Graanmaul | 3724600 | western | 19997 | 8075 | 230463 | 213157 | 36 | 9 | 10012 |
| 19 | city | Gru | 742600 | nordic | 7476 | 2729 | 88085 | 84868 | 42 | 9 | 5734 |
| 19 | city | Skarfaath | 430400 | eastern bloc | 4283 | 1547 | 23167 | 23318 | 68 | 9 | 2254 |
| 19 | city | Gadrer | 307200 | western | 7981 | 3165 | 91034 | 83166 | 30 | 9 | 3390 |
| 19 | city | Feirunstad | 240500 | western | 6586 | 2502 | 71426 | 63614 | 34 | 9 | 3234 |
| 19 | town | Shukuabad | 198400 | eastern bloc | 2317 | 760 | 14429 | 15031 | 16 | 3 | 1041 |
| 19 | town | Hand | 72200 | eastern bloc | 760 | 221 | 4873 | 4774 | 2 | 0 | 225 |
| 19 | town | Zibush | 45400 | eastern bloc | 508 | 142 | 3619 | 3057 | 3 | 0 | 137 |
| 19 | town | Daurmaath | 33400 | western | 654 | 175 | 7278 | 5498 | 3 | 0 | 157 |
| 19 | town | Gand | 26500 | western | 509 | 129 | 5752 | 4021 | 1 | 0 | 130 |
| 19 | town | Wobird | 22200 | western | 481 | 129 | 5425 | 3775 | 3 | 0 | 185 |
| 19 | town | Tharvithstad | 19100 | eastern bloc | 280 | 71 | 1597 | 1381 | 2 | 0 | 137 |
| 19 | town | Kuzqek | 16800 | arid | 419 | 117 | 4717 | 3909 | 4 | 0 | 212 |
| 19 | village | Feirnstad | 14900 | western | 6 | 8 | 498 | 752 | 1 | 0 | 38 |
| 19 | village | Skakgendal | 11200 | western | 7 | 8 | 470 | 687 | 1 | 0 | 29 |
| 19 | village | Gralvend | 9000 | eastern bloc | 5 | 7 | 307 | 462 | 2 | 0 | 19 |
| 19 | village | Maul | 7600 | eastern bloc | 6 | 10 | 277 | 431 | 1 | 0 | 18 |
| 19 | village | Bursir | 6500 | western | 7 | 10 | 314 | 478 | 1 | 0 | 23 |
| 19 | village | Stebith | 5800 | eastern bloc | 7 | 12 | 271 | 422 | 1 | 0 | 15 |
| 19 | village | Kraan | 5200 | western | 5 | 6 | 293 | 451 | 1 | 0 | 15 |
| 19 | village | Bakoberg | 4700 | eastern bloc | 5 | 8 | 180 | 271 | 1 | 0 | 11 |
| 20 | city | Saado | 3584800 | western | 20003 | 8192 | 224367 | 208497 | 60 | 9 | 8012 |
| 20 | city | Daurke | 842200 | western | 19428 | 7988 | 226038 | 210095 | 49 | 9 | 7953 |
| 20 | city | Mobrello | 451300 | mediterranean | 9219 | 3590 | 89713 | 80689 | 80 | 9 | 2757 |
| 20 | city | Tekvan | 313300 | western | 8216 | 3076 | 92050 | 82739 | 57 | 9 | 3912 |
| 20 | city | Veik | 241800 | western | 6355 | 2471 | 72341 | 64694 | 45 | 9 | 2912 |
| 20 | town | Gauness | 197800 | western | 3430 | 1267 | 53678 | 44612 | 11 | 3 | 1290 |
| 20 | town | Skul | 71900 | western | 599 | 169 | 7710 | 5897 | 2 | 1 | 186 |
| 20 | town | Brifeiness | 45200 | western | 817 | 244 | 10417 | 8100 | 2 | 0 | 225 |
| 20 | town | Mivathness | 33300 | western | 525 | 141 | 6591 | 4859 | 1 | 0 | 145 |
| 20 | town | Tauwo | 26500 | western | 468 | 120 | 5946 | 3826 | 1 | 0 | 131 |
| 20 | town | Mektarnness | 22100 | western | 427 | 108 | 4830 | 3205 | 1 | 0 | 95 |
| 20 | town | Konmand | 19000 | western | 366 | 87 | 3734 | 2493 | 2 | 0 | 79 |
| 20 | town | Volkirakstad | 16700 | nordic | 74 | 18 | 634 | 420 | 3 | 0 | 25 |
| 20 | village | Lifu | 14900 | western | 6 | 9 | 498 | 759 | 1 | 0 | 24 |
| 20 | village | Rokhauk | 11200 | western | 7 | 10 | 495 | 745 | 1 | 0 | 16 |
| 20 | village | Gror | 9000 | western | 7 | 11 | 447 | 678 | 1 | 0 | 14 |
| 20 | village | Legrok | 7500 | nordic | 5 | 8 | 202 | 311 | 1 | 0 | 7 |
| 20 | village | Wubaurdstad | 6500 | eastern bloc | 6 | 8 | 263 | 409 | 1 | 0 | 8 |
| 20 | village | Nidast | 5700 | western | 5 | 8 | 259 | 394 | 1 | 0 | 10 |
| 20 | village | Kreda | 5100 | western | 5 | 10 | 222 | 336 | 1 | 0 | 8 |
| 20 | village | Kaval | 4700 | western | 6 | 10 | 238 | 372 | 1 | 0 | 8 |
