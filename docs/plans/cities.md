# Plan: Settlements and Cities (Proposal 0009)

_Written 2026-11-20 before any code, for the out-of-sync session that implements `docs/proposals/0009-settlements-and-cities.md`. Two pull requests: Phase 1 on `feature/urban-ground`, the rest on `feature/cities`, branched from it. Decisions 259 onward; renumber them at merge if the main line has taken those numbers._

## What Exists (Survey, 2026-11-20)

- **Placement and population** (`worldgen/strategic/settlements.ts`). Habitability per coarse cell; one settlement per 350 km² of weighted land, capped at 3,000, at least 7 km apart; port towns at port sites; rank-size populations (Zipf 0.9). Stream `settlements` and its fork `names`. Kinds follow from population (`settlementKind` in `graph.ts`).
- **Urban extents** (`worldgen/strategic/urban.ts`, decision 103). A radial polygon of `URBAN_VERTICES` per settlement, grown along leaving roads, slowed uphill, cut short of water. Built-up radius 10 m × √population, 0.5 to 9 km.
- **Naming regions** (`worldgen/names`, decision 96). One flavor per land node (`LandNode.flavor`): four land flavors (A northern, B eastern, C southern, D steppe) shuffled over the landmasses, E for archipelagos. A front often runs through one landmass, so one naming region can hold both sides.
- **Regional roads** (`worldgen/strategic/roads.ts`, `networks/`). The network tier (coarse polylines, classes 0–2) and, where the world has them, the alignment tier (decision 184). `InfraScene` turns both into drawn segments.
- **The "feature distance field"** is not a texture: decision 54 draws rivers and roads by exact distance to per-tile segment lists (`RiverTables`, `RoadShading`). Proposal 0005's per-chunk field was never built (audit, decision 229).
- **Urban ground today** (`render/sim/infra/roadShading.ts`, decision 71). `LightShading.sample` returns town and industry cover from each record's outline; `builtAlbedo` paints a 70 m lattice of roof and wall colors over it. The terrain shader mixes that over the biome ground. Rails draw as concrete.
- **Buildings today** (`render/sim/infra/structureLayer.ts`, decisions 65, 106). Within 12 km and below 15 km altitude, per level-9 tile: candidates on a jittered 45 m lattice, kept with a Gaussian falloff inside the urban extent, instanced from the house, block and tower-block specs. No streets, no orientation to roads: the scatter the proposal names.
- **Heights.** The planet has a 1,000 km radius. The global grid is about 1.5 km per cell; `HeightService` adds the terrain edits to it; level-6 tiles sample 96 m and level-9 tiles 12 m. Buildings sit on level-10 tile data.
- **Strategic map.** `render/strategic/infra/urbanTexture.ts` rasterizes the urban polygons at about 0.8 km; `cityGlyphs.ts` draws a cluster glyph per class.

## Architecture

### The settlement generator (`src/worldgen/settlements/`)

A pure, deterministic function per settlement, game-agnostic (constraint 5):

```
planSettlement(input: SettlementInput, seed) → SettlementPlan
```

- **Input** (`types.ts`): center direction, population, tier, style, the urban extent radii, arterials and rails as polylines in the settlement's local frame (meters, gnomonic about the center), river and coast obstacles, and a `ground` with `height(x, y)` and `water(x, y)`. `fromGraph.ts` builds inputs from the strategic graph's settlement list, nodes (flavor), roads and railways, the river index and a height function. Nothing reads factions, territory, casting or infrastructure placed after casting.
- **Output**: streets (polylines with class: arterial, major, minor, lane, path, stairs), blocks (polygons with district), parcels (polygons with frontage), buildings (oriented footprint, height, floors, roof, style palette, extras), landmarks (kind, position, footprint, name), candidate targets (kind, position, footprint, name), and metrics for the checks.
- **Streams**: `settlements/streets`, `settlements/parcels`, `settlements/buildings`, `settlements/landmarks`, `settlements/styles`, each forked by the settlement's key, so plans do not depend on the order in which they are built and earlier stages stay unchanged.
- **Where it runs.** On demand, by settlement, near the camera (renderer) and in tools (metrics). A plan for a large city takes tens of milliseconds, so the world's generation time stays as it is; per-tier timings go in the metrics report. If the main thread stalls, move `planSettlement` into a worker; the function is already pure and its output is plain arrays.

### Tiers and styles

- **Tiers** from population: city at 60,000 and up, town at 8,000, village below. Farmsteads are scattered satellites of villages and towns on settled land, placed at the corners of the field Voronoi cells the terrain draws (decision 162). Thresholds are tuned in Phase 2 against the population model over the 20 seeds so that full cities stay few (target: under about 15 per world).
- **Styles** key to cultural regions. A naming region (land node flavor) is split into up to three style regions by farthest-point seeds over its settlements (`settlements/styles`), since one landmass often holds a whole war. Each flavor has a preference order of styles; each style region takes the next. Climate gates a style (Arid needs a dry biome, Nordic a cool one, Mediterranean a warm one); a gated style falls through to the next preference. Western and Eastern bloc are never gated.

### Streets

- **Tensor field** (`tensorField.ts`): a sum of weighted basis tensors (cos 2θ, sin 2θ): grid fields per arterial segment, a radial field round the center, boundary fields along rivers, coasts and rails, contour fields where slope exceeds about 3%, and a seeded base grid. Weights decay with distance (Gaussian); the contour weight rises with slope and dominates above 10%.
- **Tracing** (`streets.ts`): streamlines with an RK2 step of 10 m along the major and minor eigenvectors, alternating, seeded from arterials and existing streets. Separation 150–300 m for major and 60–120 m for minor streets by tier and style; a spatial hash rejects points closer than half the separation to a street of the same family. A line stops at water, outside the extent, on ground steeper than 30%, or near another street, to which it then snaps.
- **Graph** (`graph.ts`): planar graph from all polylines: intersection splitting, node merging within 3 m, dangling ends extended to the nearest street within 25 m, short spurs pruned.
- **Grades**: each edge's grade from the ground; vehicle streets steeper than 10% become paths, steeper than 25% stairs.
- **Old cores** (`oldCore.ts`): a ward layout from a relaxed Voronoi diagram inside a core radius, a market square at the center cell, the arterial as main street, a ring at the core's edge where the traced streets meet it.
- **Villages**: linear along the arterial through the center, or a green with a ring lane for clustered styles; lanes off the main road. **Farmsteads**: two to five buildings round a yard, turned to the nearest road or field edge.

### Blocks, parcels and districts

- Blocks are the bounded faces of the street graph (`blocks.ts`), inset by half the street width.
- Parcels (`parcels.ts`): recursive oriented-bounding-box splits after Vanegas et al. (2012), across the longest side, with jitter, until the parcel area falls below the district's target; a split is kept only if both halves keep street frontage.
- Districts (`districts.ts`): from distance to the center (normalized by the extent), adjacency to rail, water and arterials, slope and style.

### Buildings and landmarks

- One building per parcel (`buildings.ts`): footprint inset by the district's setback and turned to the frontage, floors by district and distance, roof by style (gable, hip, flat, shed), extras by style (chimneys, dormers, balconies, water tanks). Microdistricts place slabs in parkland instead of one per parcel; industry places sheds and stacks.
- Plinths are the renderer's: a building's base extends to the lowest drawn ground under its footprint.
- Landmarks (`landmarks.ts`) by district and style, named from the settlement's flavor.
- **Pads**: `pads.ts` returns pad edits for large structures on steep ground, in the edit framework's form. They are not added to `terrainEditsFor` in this session, because that function feeds the sim worker's height service (the other session's lane, rule 13); large structures prefer flat sites and use plinths until then. Recorded as a decision.

### Rendering (`src/render/sim/city/`)

- **Urban ground** (Phase 1 interim, Phase 5 final). Phase 1 paints the built-up patch as urban ground: a procedural street grid per town, turned to its main road, with asphalt streets, pale sidewalks, plazas in the core, gardens and yards, parks, parking lots, industrial concrete, and rail ballast on railways. Beyond a few pixels per block it fades to roof colors, the far representation. Phase 5 replaces the procedural grid near the camera with a **per-chunk feature distance field** built from the plan: 1.5 km chunks of 256² texels (about 6 m), each texel the signed distance to the nearest street edge, the street class, the ground class (yard, garden, park, plaza, parking, industrial concrete, ballast) and the district, in slots of a storage buffer that the terrain shader reads through a per-town chunk table. Far towns keep the procedural fallback.
- **Buildings**: four detail levels per 1.5 km chunk, merged into one mesh per chunk with one material (vertex colors, flat facets, window bands and night windows from world position in the wall shader): beyond 15 km none; 5–15 km block prisms; 1–5 km building boxes with roofs (12–30 triangles); under 1 km boxes with roof detail, chimneys and balconies. One draw per visible chunk, so draw calls stay within 40.
- **Night**: lit windows by hash in the wall shader; streetlights as instanced points along streets; a lighting level per settlement (lit, dimmed, blacked out) as a parameter.
- **Colliders**: oriented boxes per building in the plan, with a query for line of sight and landings.
- **Plumes**: a few camera-facing soft billboards per stack and cooling tower, drifting with the wind.
- **Damage** (stretch): a state byte per building in a per-chunk array; a change rebuilds that chunk's mesh only; rubble as a low mound; smoke and fire plumes on damaged landmarks and targets.

### Strategic view and exports

- City extents from block outlines for the cities and towns whose plans exist; districts tint the fill (industry, rail yards, ports); major streets and landmark glyphs in the Region band.
- `exports.ts`: candidate targets per settlement through a plain interface; nothing in the generator imports Bearing's planner.

## Verification

- Unit tests for each stage (field, tracing, graph faces, parcels, districts, buildings, styles, determinism, independence lint).
- `tools/cities.preview.ts`: the metrics over 20 seeds into `docs/reports/cities-metrics.md` (structure, terrain fit, slopes, grades, styles, generation time per tier, determinism).
- `tools/render.preview.ts` views `city5k`, `city1k`, `town300` and `citynight` with `PERF` and `CITIES=0` for the budgets, against `docs/reports/cities-baseline.md`.

## Risks and Fallbacks

- **Planar graph robustness.** Streamline graphs produce slivers and dangling edges. Fallback: drop faces below a minimum area or with poor compactness, and keep the streets.
- **Frame budget.** If chunks exceed it, drop the near kit to boxes and shorten the ranges.
- **GPU-less session.** Frame times come from lavapipe on the CPU; they compare runs, not machines. The owner's GPU run is the real measure.
