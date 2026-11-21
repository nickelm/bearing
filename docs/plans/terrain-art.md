# Plan: Terrain Art Direction (Proposal 0010)

_Started 2026-11-21 on branch `feature/terrain-art`, out of sync with the R2 game loop work (decision 296). Proposal: [docs/proposals/0010-terrain-art-direction.md](../proposals/0010-terrain-art-direction.md). Baseline: [docs/reports/terrain-art-baseline.md](../reports/terrain-art-baseline.md)._

## Owner's Addendum

The owner added three requirements on 2026-11-21:

1. **Scalable and switchable.** Every layer has an off switch and a quality tier, and the quality governor can shed the costly ones before the frame rate drops.
2. **Configurable for other genres.** The world generator and the art layers take a configuration, so the same world can serve a flight game, a ground game or a fantasy game. Nothing in the new code assumes Bearing's war: structures are game-agnostic and their kit is a list the caller chooses.
3. **One look.** Across genres the look stays faceted, retro and cartoony: flat-shaded facets, a limited palette per surface, chunky shapes, no photographic texture.

The plan meets them with two configuration objects:

- **`TerrainArtSettings`** (`src/render/common/terrainArt.ts`): per-layer `enabled` flags and strengths, plus a quality tier (`off`, `low`, `medium`, `high`) and a style preset (`bearing`, `storybook`, `muted`). It is read from the URL (`?art=low`, `?artStyle=storybook`), the debug GUI and the preview's `ART`/`ART_STYLE`, and the governor steps it down after the volumetrics and particles.
- **World options** (`src/worldgen/`): `PlanetParams.reliefExaggeration` (decision 297), the rock dressing's density (`DRESSING_TUNING`), and the points-of-interest kit (`PoiOptions.kinds`), all of which a game passes in. The defaults are Bearing's.

## Survey (Phase 0)

What exists and where each layer goes in:

| Layer | Exists | Insertion point |
|---|---|---|
| Relief scale | `PlanetParams.reliefScale` is decision 14's planet-to-Earth ratio, a different thing; `exaggeration` is a view-only vertex-shader factor | A worldgen stage at the end of `buildGlobalWorld` (`globalPipeline.ts`), after `finish` (biomes, forest, zones); the tile kernel's detail amplitude scales with it |
| Curvature | None | Baked on the global grid once per world (`worldgen/curvature.ts`); sampled per vertex into the terrain's interleaved `surface` buffer (all eight vertex buffers are in use, decision 157), plus the mesh's own curvature per face from the slope attribute's derivatives |
| Strata | Dry-rock bands, 75 m, gated by aridity (decision 126) | Gated by lithology as well (layered rock everywhere, faint in humid climates), with gentle height noise; lithology goes per vertex in the same interleaved buffer |
| Color drift | Shade quantization per face (decision 124); zone shift per vertex (decision 213) | A drift term in `LandShading` (altitude, aspect to the sun, low-frequency noise) applied to the albedo before quantization |
| Rock dressing | Landform props (`props.ts`, `PropLayer`, decision 225); talus and slab ground cover (decision 185) | A new placement module `worldgen/rockDressing.ts` and new prop kinds instanced by `PropLayer`'s machinery, in a separate layer so the props' budget stays theirs |
| Valley mist, height fog | Weather fog in the volumetrics (one layer at the mean ground, decision 141) | An analytic two-layer height fog in `AtmosphereNodes.aerialPerspective`, which every material calls; driven per frame by the zone at the camera, the time of day and the wetness |
| Light shafts | Cloud and terrain-shadow shafts in the air march (decision 141) | Already met; expose them to the quality tier |
| Ambient particles | Rain, snow, dust (`precipitation.ts`, decision 142); zone `particles` stored, unread | New kinds in the precipitation overlay, picked from the zone at the camera |
| Sky | LUT sky, sun, moon, stars (decision 140) | A larger stylized sun and moon by style preset; an aurora band at high latitudes in the sky background |
| Waterfalls | Steep river facets foam (decision 126); stepped river profiles (decision 146) | Drop points found on the stepped profiles and the global rivers (`worldgen/waterfalls.ts`); a `WaterfallLayer` draws a sheet, a foam pool and a mist puff (placeholder until Proposal 0011, which is not in the repository) |
| Rapids, lakes | White water by gradient (decision 147) | Foam bands across steep reaches in the river shading; lakes reflect more sky in the water shading |
| Structures | Wonders, airbases, cities; no generic sites | `worldgen/poi/`: scoring on the global grid, names from `rng("poi")`, plain exports; a `PoiLayer` of simple models; a map glyph |
| Composition | Wonders weighted by fronts and sea lanes | Viewsheds over the global grid from airfields, roads and sea lanes; the score of POIs and waterfalls takes them |

## Decisions Taken Up Front

- **The campaign does not see the exaggeration.** The coarse pass and its strategic graph keep unscaled heights, so the cast, the front and the war are the same at every relief scale (rule 9 keeps planning on the graph). The graph's reported heights (peak spot heights) are multiplied for display. Everything the execution layer and the renderer read (tiles, `HeightService`, siting, alignments, settlements, line of sight) is built on the scaled surface (decision 297).
- **Climate stays on unscaled heights.** Biomes, forest, treeline, zones and the shader's snow line read the height divided by the exaggeration, so the same ground is snowy or forested at every scale.
- **No new vertex buffers.** New per-vertex data rides in the interleaved `surface` buffer.
- **Each layer is off at quality `off`** and costs nothing then (uniform branches or hidden meshes).

## Phases

0. Survey, baseline, plan (this document). Standard test views added to `tools/render.preview.ts`: `art-valley` (alpine valley, 500 m), `art-canyon` (canyon, 300 m), `art-coast` (coast, 1 km).
1. Relief exaggeration: the stage, the kernel's detail amplitude, the shader's climate heights, the graph's displayed heights, invariant tests at 1.0, 1.3 and 1.5.
2. Surface shading: curvature bake, curvature shading, strata by lithology, color drift.
3. Rock dressing: kit specs, placement rules by slope, curvature, province and lithology, colliders for pieces over 20 m, instancing with two LODs, budget check.
4. Air: two-layer height fog with valley mist, zone-driven particles, sky style and aurora, budget check.
5. Water: waterfalls, rapids bands, lake reflection.
6. Structures (stretch): POI framework and kit.
7. Composition (stretch): viewsheds and the landmark bias.
8. Verification: `tools/terrainArt.preview.ts` over 20 seeds → `docs/reports/terrain-art-metrics.md`; screenshots; the report.

## State

All eight phases are built (2026-11-21); the report is `docs/reports/terrain-art-report.md` and the metrics `docs/reports/terrain-art-metrics.md`. Open items are under *Out of sync: Proposal 0010* in `TODO.md`.

## Lane

Changes stay in `src/worldgen/` (new stages and their wiring), `src/render/` (terrain, atmosphere, water, props, strategic glyphs), `src/data/models/` (new specs), `tools/` (previews) and `docs/`. Shared files touched are listed in the report.
