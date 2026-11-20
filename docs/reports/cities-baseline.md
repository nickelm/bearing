# Cities: Baseline (Proposal 0009, Phase 0)

_Measured 2026-11-20 on seed 4 (the eroded 1,024² world from the render preview's cache), before any change of Proposal 0009 (`main` at `8d37d2d`), with `tools/render.preview.ts` at 960 × 540, `PERF=5`. This session has no GPU: Dawn ran on lavapipe, Mesa's software Vulkan driver, so wall times per frame are CPU rasterization and only compare runs with each other. CPU per frame is the scene's own CPU time (`scene.render`), median of five frames; triangles and draw calls are counted from the scene graph. The owner's GPU run (`MODE=gpu`) remains the real measure._

## The Standard City Views

`city5k` and `city1k` look at the world's largest city (Skaa, 3.6 million people) from 5 km and 1 km; `town300` at the settlement nearest 20,000 people from 300 m; `citynight` at the largest city from 1.5 km at 22:30.

| View | Wall ms/frame (lavapipe) | CPU ms, median | Terrain draws / M tris | Building draws / M tris | Buildings |
| --- | --- | --- | --- | --- | --- |
| city5k | 1,278 | 11.5 | 40 / 0.35 | 177 / 1.24 | 26,348 |
| city1k | 781 | 13.7 | 47 / 0.41 | 151 / 0.90 | 17,925 |
| town300 | 476 | 7.0 | 43 / 0.37 | 28 / 0.04 | 1,003 |
| citynight | 1,012 | 10.8 | 50 / 0.44 | 170 / 1.07 | 21,949 |

The same views without buildings or trees (`DETAIL=0`), with Phase 1's urban ground:

| View | Wall ms/frame (lavapipe) | CPU ms, median | Terrain draws / M tris |
| --- | --- | --- | --- |
| city5k | 1,025 | 11.1 | 40 / 0.35 |
| city1k | 728 | 7.1 | 47 / 0.41 |

## What the Baseline Shows

- **Buildings are already over Proposal 0009's hard budgets.** The scattered instanced buildings take 150–180 draw calls (budget 40) and 0.9–1.24 M triangles (budget: 15% of the 2 M scene budget, 0.3 M) in the city views. Their first frame after a move costs up to 43 ms of CPU (placement per level-9 tile).
- **Structure.** Buildings stand on a jittered 45 m lattice at random headings, on a 70 m lattice of roof and wall colors (`render-4-city1k.png` in `docs/reports/screens/cities/`). Nothing follows a street.
- **Frame-time noise.** The maxima (200–280 ms) are tile and building builds after the view loads; the medians are the steady state.

## After Phase 1 (urban ground)

| View | Wall ms/frame | CPU ms, median | Building draws / M tris | Buildings |
| --- | --- | --- | --- | --- |
| city5k | 1,118 | 12.5 | 177 / 0.47 | 10,142 |
| city1k | 791 | 10.1 | 148 / 0.34 | 6,790 |
| town300 | 439 | 7.3 | 28 / 0.02 | 440 |
| citynight | 1,221 | 18.2 | 167 / 0.41 | 8,425 |

The urban ground costs no geometry. Buildings fall by about 60%, because the lattice's candidates on streets, sidewalks, squares and parks are dropped; triangles fall with them. Draw calls stay where they were (one instanced mesh per model and tile), which Phase 6 addresses.
