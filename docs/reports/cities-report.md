# Settlements and Cities: Report (Proposal 0009)

_2026-11-20, out-of-sync session. Phase 1 (urban ground) is [nickelm/bearing#5](https://github.com/nickelm/bearing/pull/5) on `feature/urban-ground`; this report covers `feature/cities`, branched from it, Phases 2–10. Decisions 259–270, the range the main line left free (it continues at 271). The baseline is `docs/reports/cities-baseline.md`, the generator's metrics over 20 seeds `docs/reports/cities-metrics.md`, the screenshots `docs/reports/screens/cities/`._

## What Works

- **A settlement generator that belongs to the world** (`src/worldgen/settlements/`). It plans any settlement from world data alone: tiers (city from 200,000 people, town from 15,000, village below, farmsteads round them). Five cultural styles key to naming regions, which are split into style regions and gated by climate. Streets come from a tensor field (arterial grids, radial, boundary and contour fields) traced as streamlines, with organic old cores of Voronoi wards. Blocks are the street graph's faces between curbs; parcels come from frontage-keeping subdivision; districts are assigned by distance, rail, water, slope and style. Each parcel holds one building by district and style (gable, hip, shed and flat roofs, chimneys, dormers, balconies, water tanks, courtyards), and Eastern bloc microdistricts hold slabs in parkland. The generator also places named landmarks, candidate targets (rail yards, power stations, factories, depots, ports, bridges), villages of strip plots along their roads, and farmsteads at field corners. A lint rule and a test keep it free of game, campaign and faction code.
- **Plans off the main thread.** A settlement worker plans the settlements near the camera, nearest first. The largest cities take 3–11 s there; towns take 0.3 s and villages 15 ms. World generation is unchanged: no plan is built with the world.
- **Urban ground** in the terrain shader, with no geometry:
  - Phase 1's street grid for towns without a plan;
  - near the camera, the plan's own streets, sidewalks, paths, stairs and block grounds (courtyards, gardens, parks, squares, parking, concrete, gravel, ballast, sports grounds, cemeteries), from per-chunk feature distance fields with crisp street edges;
  - off the blocks, the natural ground.
- **City meshes by distance**, one draw per 1 km chunk: kits within 0.6 km, boxes and roofs within 2 km, block prisms that follow the ground to 12 km, merged per settlement. Every building stands on a plinth to the lowest drawn ground. Window bands appear within 1.4 km. At night about a third of the windows light up, scaled by each settlement's lighting level (lit, dimmed, blacked out, for a game layer to set), and streetlights stand every 40 m.
- **Landmarks and plumes.** Churches and cathedrals with towers, town halls, TV and water towers, stadiums, monuments, markets, smokestacks, cooling towers and cranes. Stacks and cooling towers carry soft plumes that drift with the ground wind.
- **Damage states** (the stretch phase, at full scope): intact, damaged (blackened, roof broken) and rubble. A change rewrites the building's own triangles in place (0.07 ms) and adds fire smoke at damaged landmarks and targets.
- **Colliders and exports.** Building boxes with a segment test for line of sight and a landing height on flat roofs; per-settlement districts, landmarks and candidate targets in planet directions.
- **The map.** Cities of 200,000 and more are planned in the background. The map's urban fill then takes their extent from their blocks and tints industry, rail yards, ports and utilities gray.

## Against Part A's Verification Criteria

| Check | Criterion | Result |
| --- | --- | --- |
| Frame time | +1.5 ms at most in the standard views | **Not measured on a GPU.** This session has none: Dawn ran on lavapipe, which rasterizes on the CPU. The scene's CPU time, median of five frames, with buildings and without: city5k 8.2 / 7.3 ms, city1k 7.0 / 7.5 ms (noise), town300 8.9 / 7.2 ms (the town view also adds 2,873 trees with `DETAIL=1`, so it overstates the cost). Baseline (scattered buildings): 11.5, 13.7 and 7.0 ms. On lavapipe the wall time per frame rises about 20% in city1k, from rasterizing 0.14 M triangles in software; this does not carry over to a GPU. The owner's `MODE=gpu` run with `?dev&gputime=1` is the real measure. |
| Triangles and draw calls | 0.3 M triangles (15% of 2 M) and 40 draws at most | Met: city5k 0.02 M / 3 draws, city1k 0.14 M / 13, town300 0.01 M / 6, citynight 0.07 M / 9; also westcity 0.22 M / 13, eastcity 0.10 M / 12, industry 0.13 M / 14. Baseline: 1.24 M / 177, 0.90 M / 151, 0.04 M / 28. |
| Structure | No building outside a parcel; every parcel fronts a street | 2 of about 9.5 million buildings over 20 seeds (one Mediterranean, one Arid city) have a corner outside their parcel; open. No parcel without frontage. |
| Terrain fit | No floating buildings; plinths reach the ground; nothing in water | Plinths reach the lowest drawn ground plus 1.5–12 m by level, by construction. No building in water over 420 plans. Streets other than arterials are dropped over water. |
| Slopes | Most minor street length on slopes above 10% within 30° of the contour | 68.6% on the 20 coarse worlds (4.2 km of such streets); above 50% on a 15% hillside in the unit tests. |
| Grades | Vehicle streets within the grade limit; steeper links are stairs or paths | 0 over 10%; 12 km of paths and 7 km of stairs. |
| Styles | Each style appears where its regions exist | All five over the 20 seeds (Western 13,556 settlements, Eastern bloc 12,069, Mediterranean 2,965, Nordic 2,030, Arid 1,949). |
| Damage | Rebuild only the affected block; rubble swap under 2 ms | 0.07 ms, patching the building alone; a chunk rebuild (400 buildings) about 6 ms. |
| Generation time | Per tier; worldgen up 30% at most | Cities 4.2 s mean (max 10.7), towns 0.29 s (max 2.1), villages 15 ms (max 77), in the worker. World generation +0%. |
| Determinism | Same seed, same settlements; earlier stages unchanged | Tested: identical plans with other plans built in between; only new `settlements/…` streams. |
| Independence | No settlement module imports game, campaign or faction code | Lint rule and test. |

## Screenshots

In `docs/reports/screens/cities/`, all on seed 4 through `tools/render.preview.ts` on Dawn and lavapipe (the same `GlobeScene` the app draws):

- `before-city1k.png` and `before-town300.png` (the baseline)
- `phase1-city1k.png` and `phase1-town300.png` (urban ground only)
- `cities-city5k.png` and `cities-city1k.png` (the largest city, Nordic, from 5 km and 1 km)
- `cities-hilltown.png` (the steepest town, in clear weather)
- `cities-west-east.png` (the largest Western city and an inland Eastern bloc city, side by side)
- `cities-village.png` (a street village and farmsteads)
- `cities-citynight.png`
- `cities-industry.png` (sheds, stacks and plumes by the power station)
- `cities-town300.png`
- plan drawings from `tools/cities.preview.ts`: `plan-4-city.png`, `plan-1-town.png` and `plan-1-village.png`

Screenshots in headless Chromium with WebGPU were not taken. Chromium's own software WebGPU cannot run Bearing (`CLAUDE.md`), and the lavapipe shim needs a 14-minute world pass per run; the previews draw the same scene.

## Simplified or Deferred

- **Meshes are built on the main thread** (within 6 ms per frame), not in a worker, because plinths need the terrain's tile data. Plans and fields are in the worker (decision 266).
- **Detail ranges shrank** from 1 / 5 / 15 km to 0.6 / 2 / 12 km to hold the triangle budget (decision 267).
- **Building kits are merged per chunk, not instanced**, and city meshes carry no ink outlines (decision 267).
- **Pads** for large structures on slopes are recorded but not applied as terrain edits. `terrainEditsFor` feeds the sim worker too (rule 13), and that is the main line's lane (decision 264).
- **Strategic view:** major streets and landmark glyphs in the Region band are not drawn; at the zoom floor major streets are 2–3 px apart (decision 270).
- **Ground for plans** is the global grid (about 1.5 km cells) in the app and the coarse grid (about 6 km) in the metrics tool. Streets follow contours at that scale; the drawn ground has finer relief.

## Decisions and Deviations

- 259: urban ground (Phase 1)
- 260: the generator: a pure plan per settlement, game-agnostic, on demand; tiers
- 261: styles by cultural region and climate
- 262: streets (tensor field, streamlines, graph, old cores, grades)
- 263: blocks, parcels, districts
- 264: buildings, landmarks, targets; pads deferred
- 265: villages and farmsteads
- 266: plans in a worker; feature fields; one storage buffer
- 267: meshes by detail level; shorter ranges; meshes on the main thread; no ink
- 268: plumes, colliders, exports
- 269: damage states patched in place
- 270: map extents from blocks with district tints; Region-band glyphs deferred

## Shared Files Touched

- `src/render/sim/infra/roadShading.ts`:
  - `LightShading.urbanGround`, with the plan ground;
  - pattern info folded into the outlines buffer;
  - `RoadShading.coverage` returns a vec4 with ballast.
- `src/render/sim/infra/infraScene.ts`: `townInfo`, `BuiltSite.grid`.
- `src/render/sim/infra/structureLayer.ts`: the town scatter keeps off streets; `towns` switch.
- `src/render/sim/terrain/terrainRenderer.ts`: the urban ground and ballast; `cityGround`.
- `src/render/sim/globeScene.ts`: `cities` (CityLayer), `citiesOn`, wind for plumes.
- `src/render/strategic/infra/urbanTexture.ts`: RG8, `applyPlan`, `flush`.
- `src/render/strategic/strategicRelief.ts`: industry tint.
- `src/main.ts`: the city layer's world, the map's plans, the prefetch.
- `tools/render.preview.ts`: city views and targets, `CITIES=0`, city statistics.
- `eslint.config.js`: the settlement rule.
- `CLAUDE.md`: rule 20, directory map, command.
- `docs/decisions.md`, `docs/visual-style.md`, `docs/roadmap.md` (an out-of-sync section), `TODO.md` (a section at the end), and proposals 0001 and 0005 (notes after their audit lines).

New files: `src/worldgen/settlements/`, `src/render/sim/city/`, `src/render/sim/infra/urbanPattern.ts`, `src/workers/city*.ts`, `tests/settlements.test.ts`, `tests/cityRender.test.ts`, `tests/urbanPattern.test.ts`, `tools/cities.preview.ts`, `tools/cityDraw.ts`, `docs/proposals/0009-…`, `docs/plans/cities.md`, and the reports.

## Known Issues

- **Night.** The terrain's town glow (decision 71) still lights the whole built-up patch, so at night planned cities read as dark blocks on glowing ground (`cities-citynight.png`). The glow belongs on streets and windows for planned towns.
- **Two buildings** outside their parcel over 20 seeds (Mediterranean and Arid cities): probably landmark or stadium placement against a non-convex parcel.
- **Nordic cities read dark** from 1 km: black roofs and dark wooden walls, as the style says, in a city of 3.6 million (seed 4's largest). Nordic may want a lighter palette for its large cities.
- **Faces dropped** at about 6% of graph faces (insets that fail on thin or folded faces): the gaps show as natural ground.
- **Unit suite.** `tests/gpu/mapSoak.test.ts` fails under lavapipe (geometries 274 > 234), as on an unmodified `main`; the other 1,357 tests pass after the rebase on `main`.
- **Plans per seed.** The 20-seed metrics plan five cities, eight towns and eight villages per seed, and run without rivers.

## The Three Most Valuable Next Steps

1. **Measure on the owner's GPU.** Run `npm run dev` with `?dev&gputime=1` over the largest city at 1 km and 5 km, and run `tools/browser.smoke.mjs` with `MODE=gpu`. Tune `boxRange`, `prismRange` and `buildBudgetMs` from the real frame times. This is the one hard budget not yet shown.
2. **Night and ground detail for planned towns.** Move the town glow onto lit streets and windows, and let the feature field carry parcel edges (hedges, fences, walls) and the plan's trees.
3. **Join the game layer.** Wire pads into `terrainEditsFor` with the main line, so the sim's height service and the renderer share them. Hand the candidate targets to the planner through an adapter in `worldgen/strategic/` (rule 9), and let strikes set damage states and air raids the lighting level.
