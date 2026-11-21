# Terrain Art Direction (Proposal 0010): Report

_Branch `feature/terrain-art`, 2026-11-21. Decisions 296–303. Plan: `docs/plans/terrain-art.md`. Baseline: `docs/reports/terrain-art-baseline.md`. Metrics: `docs/reports/terrain-art-metrics.md`._

This pull request implements all eight phases of Proposal 0010, including the stretch work (points of interest and composition). It also meets the owner's addendum: every layer has an off switch and a quality tier, and the world takes a profile so other genres can use the generator. It ran out of sync with the R2 game loop and stays out of the campaign: the war, the cast and the demo seeds are unchanged at every setting.

## What Works

**Shape.**

- **Relief exaggeration** (decision 297). `PlanetParams.reliefExaggeration` defaults to 1.3 (range 1.0–1.5) and applies after climate, biomes, forest and zones, at the end of the global pass. Everything built afterwards stands on the scaled surface: airfield siting, alignments, settlements, wonders, the height service, line of sight and the flight model's ground.
- **The tile kernel runs unchanged.** It reads the unexaggerated grid and scales its samples on readback, so tiles keep exactly their materials.
- **Climate reads heights divided back**, so snow lines and trees by temperature fall on the same ground at every setting.
- **The campaign's coarse pass stays unexaggerated.** Peak labels on the map show the scaled heights.
- **Rock dressing** (decision 299). Sixteen pieces with far models in each rock's style, placed by slope, curvature, province and rock:
  - slabs and ledges on cliffs, laid on the face;
  - buttresses on layered walls;
  - teeth, spires, pinnacles, columns and tors on crests;
  - scree at cliff feet;
  - boulders on open high ground.

  They are drawn by a generalized `PropLayer` with two LODs, and pieces over 20 m collide.

**Surface** (decision 298). A curvature map is baked once per world. Each facet adds its own curvature (the divergence of the slope across the triangle), which darkens hollows and lightens crests. Layered rock shows strata bands in any climate, and bare rock takes its tone by lithology (granite pale, limestone near white, basalt dark). Color drift varies value and hue with noise and altitude and warms sunward slopes, never leaving the biome's family of colors. The per-vertex data rides in the existing interleaved buffer, because all eight vertex buffers are in use.

**Air** (decision 300).

- **Valley mist and zone height fog** are two analytic fog layers inside aerial perspective, so every material sits in them without a new pass. Height fog takes the zone's haze color and density. Mist pools in the lowest ground around the camera at dawn and after rain, and burns off through the morning.
- **Ambient particles** ride on the precipitation overlay: pollen, leaves, dust, drifting snow on cold heights, and fireflies at dusk.
- **The sky** draws a larger sun and moon by style, and an aurora near the poles.
- **Light shafts** were already in the volumetrics.

**Water** (decision 301). Waterfalls are found on the rivers' stepped surfaces and drawn as a parabolic sheet with stepped scrolling bands, a foam pool and a placeholder mist. The tallest falls are named. Rapids draw foam lines across steep reaches. Lakes are calmer and more reflective than the sea.

**Structures** (decision 302). A game-agnostic framework places twelve modern types by site suitability: radar stations, early-warning radars, relay towers, bunkers, batteries, observation posts, dams, lighthouses, observatories, quarries, oil fields and power lines. Each gets a name, a chunky model with a far model, and a map glyph. The caller passes places and routes as points and polylines and chooses the kit.

**Composition** (decision 303). Viewsheds from the airfields' approaches bias site scores. A landmark pass then raises a relay tower on the most prominent visible ground for any approach that sees no landmark.

**Scaling and configuration** (decision 296).

- `TerrainArtSettings` has quality tiers (`off`, `low`, `medium`, `high`) and styles (`bearing`, `storybook`, `muted`), set by `?art=` and `?artStyle=`, the debug GUI (View → Terrain tiles), and `ART` and `ART_STYLE` in the previews.
- At `off`, none of the new layers draws.
- A second quality governor sheds particles and far rocks, then mist, then rocks, once the atmosphere's governor has stepped all the way down.
- World profiles (`?profile=bearing|natural|heroic`) bundle relief, rock density and the structure kit for other genres.

## Metrics Against Criteria

Over 20 seeds (1–20, two of them retried by the validity check), global grid 256² per face, relief exaggeration 1.3 (`tools/terrainArt.preview.ts`; full tables in `terrain-art-metrics.md`):

| Check | Criterion | Result |
|---|---|---|
| Relief scale | Invariants pass at 1.0, 1.3, 1.5 | 0 river surfaces rising downstream; lakes level in 20/20 seeds; road profiles within grade (unit test) |
| Biomes | Identical at all scales | Identical (biome and forest maps) in 20/20 seeds |
| Rock dressing | No floating pieces; cliffs over 45° dressed | 100% of 166,779 cliff cells have a piece within one cell; 25 of 356,600 pieces (0.007%) stand up to a few meters above the sampled ground at their spot, on curved ground between samples |
| Shading | Visible; no seams | Visible in the screenshots below; seam-free by construction (per-vertex data sampled by direction, per-face curvature from the drawn mesh) |
| Waterfalls | Every major knickpoint on a large river has one | 97% of 81,567 major knickpoints (rivers at least 20 m wide dropping at least 15 m at 5% or steeper) have a fall within 600 m; 237,270 falls in all, 960 named |
| Structures | Each type where its sites exist; each named and with a glyph | All 12 types appear; none unnamed; one `structure` glyph each |
| Composition | A landmark in view of at least 70% of airfields | 100% of 1,448 airfields (lowest seed 99%) |
| Independence | No game, campaign or faction imports | Enforced by an ESLint rule on the new worldgen modules |
| Determinism | Same seed, same world | 20/20 seeds place the same structures twice; placement is hashed per cell |

The 3% of knickpoints without a fall are mostly reaches through lakes and junctions, where the stepped surface is flat.

## Budgets

Measured in the standard views at 1408 × 792 with art `medium` against `off`, relief 1.3, at the baseline's spots:

| View | Rock dressing | Waterfalls | Structures |
|---|---|---|---|
| Alpine valley, 500 m | 9 draws, 0.042 M triangles (2,030 pieces) | 5 in range, 170 triangles | none in view |
| Canyon, 300 m | 9 draws, 0.021 M triangles | — | — |
| Coast, 1 km | 4 draws, 0.003 M triangles | — | — |

- **Rock dressing:** at most 9 draws and 0.042 M triangles, against the budget of 30 draws and 20% of the 2 M triangle budget (0.4 M). Met.
- **Air (mist, fog, particles):** the fog is a few ALU and two texture reads per vertex inside the existing aerial perspective, and the particles reuse the overlay. Not measured in milliseconds here (see below).
- **Total frame time:** not measurable on this machine. The renderer is lavapipe on four CPU cores shared with the metrics run: the art-off frames (1.1–1.5 s) came out slower than the art-on frames (0.5–1.0 s), which says only that the machine was busy. The owner's GPU timing pass (`?dev&gputime=1`, `MODE=gpu GPU_TIMING=1` in the smoke test) is the check for the 1.5 ms and 3 ms budgets.
- **Points of interest:** placing them for a 1024² world takes 2.7 s on the main thread when the world loads (a known issue).

## Screenshots

SCREENS

## Simplifications

- **No access roads, pads or reservoirs.** Points of interest have no access roads and no pads. Dams have no reservoir, because a lake needs a terrain edit and a new lake in the drainage. Power lines are straight rows of pylons, not routed alignments.
- **Waterfall mist is a placeholder** (three soft quads), since Proposal 0011's effects system is not in the repository.
- **Composition leaves the wonders alone.** It biases the points of interest and adds relay towers, but not the placement of wonders: wonders belong to the cast, which this work keeps invariant.
- **Light shafts** are the existing volumetric ones, unchanged.
- **Phases 2–7 landed in one commit**, because they share wiring in `globeScene.ts`, `main.ts` and the render preview.
- **The 20-seed metrics run the global pass at 256² per face**, not the app's 1024². On this software GPU a world at 1024² takes about six minutes. The checks that need full detail (rock dressing) use level-7 tiles.
- **Screenshots come from the Dawn render preview, not headless Chromium.** Chromium's own software WebGPU cannot run Bearing (CLAUDE.md), and the lavapipe browser path takes 14 minutes for the global pass alone. The preview draws the same `GlobeScene`.

## Decisions

- 296: Proposal 0010 accepted with the owner's addendum; art settings; standard views.
- 297: relief exaggeration after climate and biomes; the campaign unexaggerated.
- 298: surface art (curvature, strata by rock, color drift).
- 299: rock dressing on the props' instancing.
- 300: the zones' air (mist, height fog, particles, sky).
- 301: waterfalls, rapids, calm lakes.
- 302: points of interest.
- 303: composition by viewsheds.

## Shared Files Touched

The other session's lanes (simulation, campaign, game loop) are untouched except where noted. Shared files with additive changes:

- `src/main.ts`:
  - the relief and art URL options and world profile;
  - the surface art sampler;
  - the rock, zone-air and points-of-interest wiring;
  - the art governor;
  - the stored world's exaggeration.
- `src/ui/debugGui.ts`: relief exaggeration under World; art quality and style under View → Terrain tiles.
- `src/render/sim/globeScene.ts`: the rock, waterfall and points-of-interest layers, zone air, sky style, and `setTerrainArt`.
- `src/render/sim/props/propLayer.ts`: generalized by options; the props' behavior is unchanged.
- `src/render/sim/terrain/terrainRenderer.ts`, `landShading.ts`, `tileMesh.ts`, `terrainBudget.ts`: the surface art and rapids.
- `src/render/sim/atmosphere/atmosphere.ts`, `skyView.ts`; `src/render/sim/water/waterShading.ts`; `src/render/sim/weather/precipitation.ts`.
- `src/render/strategic/glyphLayout.ts`, `glyphGeometry.ts`, `glyphLayer.ts`, `strategicScene.ts`, `strategicRelief.ts`, `labels/labelModel.ts`: the structure glyph, the climate factor and peak heights.
- `src/render/common/seasons.ts`, `models/spec.ts` (the `rock` budget class); `src/render/sim/forest/forestLayer.ts`, `ground/groundCoverLayer.ts`, `ground/rotorDust.ts` (the climate factor).
- `src/worldgen/params.ts`, `globalPipeline.ts`, `finishWorld.ts`, `gpu/tileSynth.ts`, `gpu/globalGrid.ts`, `worldStore.ts` (`GENERATOR_VERSION` 35).
- `tests/demoSeeds.test.ts`: the version pin moves to 35 (the coarse pass is unchanged).
- `eslint.config.js`: a game-agnostic import rule for the new worldgen modules.
- `tools/render.preview.ts`, `tools/previewWorld.ts`; `docs/design.md`, `docs/visual-style.md`, `docs/decisions.md`, `docs/roadmap.md`, `TODO.md`.

## Known Issues

- **The sim's analytic routes clear the coarse, unexaggerated ground** (`sim.init` in `main.ts`). At 1.3, a route flown low over high ground could pass below the drawn surface. Scaling the coarse heights handed to the sim is a one-line change in the sim's lane, left to that session.
- **POI placement runs on the main thread.** Points of interest are placed when a world loads, which takes 2.7 s at 1024² in the preview; moving it into the worldgen worker is a TODO.
- **Steep cliffs make thousands of small falls.** Mountain streams stepping down the 75 m strata produce thousands of small falls per world. Only falls within 9 km are drawn, and only the 48 most striking are named.
- **Rapids' foam lines follow height contours**, so on a reach that runs across a slope they can cross the channel at an angle.
- **`tests/gpu/mapSoak.test.ts` fails on this software GPU**, as it did before this work.

## Next Steps

- The owner's look at the storybook and muted styles in a browser on a real GPU, and a GPU timing pass (`?dev&gputime=1`) over the standard views.
- Access roads and pads for points of interest, through the router and terrain edits of Proposal 0005; reservoirs behind dams.
- Proposal 0011's effects for waterfall mist and spray.
- Zone grading, sun warmth and cloud regime from the recipes.
- Wonders' placement by viewshed, if the owner accepts a cast that depends on it.
