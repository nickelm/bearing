# Proposal 0003: Forests for Low Flight

*Drafted 2026-11-15 from the owner's brief. Status: accepted 2026-11-15 (decision 148). Would affect `docs/design.md` (Line of sight, the flight model's ground model), `docs/visual-style.md` Part I (Vegetation, Performance Budgets, Acceptance Checks), and `TODO.md` (V2's tree kit and tree LOD).*

*Audit 2026-11-18 (decision 229): near trees reach 600 m on an 8 m lattice over quarter level-10 tiles and edge trees 1.2 km (decision 150), not 700 m, 7 m, level 11 and 1.5 km as in sections 2 and 6. Line of sight and tree strikes from the canopy field (section 5) are not built. The steps in section 8 are superseded by `docs/roadmap.md` (decision 228).*

## The Brief

An attack helicopter must fly through the world at treetop height, pop up from behind a tree line to attack, and duck back behind cover. At low altitude the player needs enough variation to orient and to remember places. Trees should look slightly cartoonish: low-poly and faceted, in the spirit of the owner's two reference renders, and matching the faceted terrain without becoming a block world. The frame rate must stay above 30 fps on a laptop, ideally on a tablet too. The owner suggests separating forests from individual trees, with areas where treetop canopies alone form a complete cover.

## What We Have, and Why It Falls Short

Today a forest is two things that do not agree (decisions 44, 45, 71, 131):

- **The terrain shading** paints a dark canopy color where the forest density passes 0.42. It is flat: it has no height, so it gives no cover and no skyline.
- **Instanced clumps** of four trees on a 40 m lattice, within 5 km, thinned with distance beyond 1.5 km. A clump is about 40 triangles, so a tree is about ten: a cone or an octahedron on a stick. The lattice is far too sparse to close a canopy, and thinning makes distant forest semi-transparent, which is the opposite of cover.

For a helicopter the second problem matters most. A tree line 2 km away must stand as a solid wall 20 m high, because the whole tactic depends on what it hides. Neither layer provides that wall at that range.

## Proposal in One Paragraph

Treat a forest as a **volume with a canopy height**, and draw that volume in three layers that agree with each other and with the simulation. A **canopy height field** H(p), a pure function of position, gives every point its canopy top: zero in the open, the stand's height inside a forest, with a sharp edge on the existing density contour. A **canopy shell** draws H as a raised, faceted surface from the terrain's own tile meshes, out to many kilometers; it gives the forest its mass, its skyline and its cover at every range for about the cost of the terrain. **Instanced trees** from a new tree kit stand on top of and in front of the shell near the camera: crowns only inside stands, where trunks never show, and whole trees on the forest edge, in hedgerows, tree rows, riverbanks and the open field. The simulation reads the same H for line of sight and for tree strikes, so what hides the player on screen hides them from the AI, and what the rotor hits is what the player sees.

This is the owner's suggestion of separating canopy cover from individual trees, made precise.

## 1. The Canopy Height Field

H(p) = cover(p) × h_stand(p), in meters above the ground.

- **cover** is 1 where the forest density (decision 44) exceeds the canopy threshold (0.42, decision 71's `forestThreshold`) and 0 elsewhere, with the edge on the bilinear density contour of the level-7 tiles. It is already the contour the terrain's canopy shading follows, so nothing moves.
- **h_stand** comes from the stand the point lies in (section 3): a height per stand from its composition and age class, between bounds per biome. Starting values: conifer 18–26 m, temperate broadleaf 14–22 m, birch and young stands 8–12 m, rainforest 28–38 m, savanna woodland 6–10 m, shrubland 2–4 m, krummholz near the tree line 1–3 m.
- **Where it lives.** The function goes in `worldgen/` beside the tile synthesis, written once for the CPU (sim, placement, tests) and once in TSL or WGSL (rendering), with a test that the two agree. Rule 9 holds: line of sight and collision are the sim's execution layer, which may read terrain; the campaign's planning layer keeps reading the strategic graph's forest density.

The field is the contract between three consumers. That is the main design choice here, and the reason the shell and the trees take their heights from it rather than from their own noise.

## 2. Three Layers, Each Doing One Job

| Layer | What it draws | Range (laptop default) | Job |
|---|---|---|---|
| Near trees | Instanced tree kit: crowns only inside stands, whole trees on edges and in the open | 0–700 m | The trees you read as trees: species, silhouettes, crown relief |
| Edge trees | Whole trees along forest edges, hedgerows and tree rows, at a coarser LOD | 0–1.5 km | A toothed, solid tree line at the range where pop-up attacks happen |
| Canopy shell | The terrain tile mesh again, lifted by H, faceted and in the stand's canopy shade | 0–12 km | Mass, skyline and cover at every range; fills gaps between near crowns |

Beyond the shell's range, the terrain's flat canopy shading carries on as today (decision 71). The strategic view is unchanged.

### 2.1 The canopy shell

Each terrain tile within the shell's range draws a second time with a forest material. The vertex shader lifts each vertex by H at the vertex; the fragment shader discards where the interpolated cover falls below one half, so the shell ends at the forest edge. The shell is flat-shaded like the terrain, so its facets read as a lumpy canopy from a distance. It takes its color from the stand: the darkest canopy shade of Part I for the stand's type, with the stand's value shift.

- **Near the camera** the shell sinks to about 60% of H and serves as the dark understory between instanced crowns, so no ground ever shows through a closed stand. The CPU previews show the effect: without it, a broadleaf stand seen from above is a scatter of crowns over brown floor; with it, the stand reads as one closed mass with crowns as relief.
- **Toward the near band's edge** the shell rises to H while the near trees shrink into it, so the hand-off is a canopy that loses its individual crowns, not trees that pop.
- **Edges.** A lifted grid makes a ramp one mesh cell wide at the forest edge (24 m at the finest level, wider on coarser tiles). Inside 1.5 km the edge trees stand on the contour in front of it; beyond, the ramp is a few pixels and reads as an edge under haze.
- **Cost.** Only tiles that contain forest draw it, and the terrain is 0.15–0.3 M triangles in today's views (decision 131), so the shell costs at most as much again, with no new data: the tiles already carry forest density per vertex.

### 2.2 Near trees

- **Density that closes the canopy.** Crowns on a jittered lattice with the spacing of the stand's crowns: about 7 m for conifers and 7.5 m for broadleaf, against 40 m today. A stand of 190 trees per hectare.
- **Crowns only inside stands.** Interior trees never show their trunks: from above you see crowns, and from the side the edge trees hide the interior. Interior instances use the crown parts of the kit model and drop the trunk, 10–20% fewer triangles. Trees within about 15 m of an edge, and all trees in the open, are whole.
- **Placement** moves from level-9 tiles (3 km) to level-11 tiles (about 750 m), so a tile builds in a few milliseconds and the near band holds a dozen tiles. If CPU time or memory per tile turns out too high on the tablet, placement moves to a compute pass that writes instances to a storage buffer for an indirect draw; the output is the same, so this is an optimization rather than a redesign.

### 2.3 Edge trees and linear features

Edges, hedgerows and tree rows are what a helicopter pilot hides behind and navigates by, so they get their own, longer range. They are found by sampling the cover contour and the linear features of section 3, and drawn as whole trees with one coarser LOD past 500 m (crown as one jittered blob or cone, 10–16 triangles).

## 3. Variation You Can Navigate By

Orientation at low altitude comes from structure at three scales, all deterministic from the world seed, so a place looks the same every time you return.

- **Stands** (100–400 m). A forest is a mosaic of stands, Voronoi cells over the existing 500 m clumping noise, each with a composition (pure fir; fir and pine; oak and beech; birch), an age class that sets its height, and a shade. Stand boundaries are steps in the canopy skyline and color patches from above, the way farmland's fields are (decision 127). The preview's conifer stand stands 4–5 m above the broadleaf stand beside it, and the step is the most legible feature in the oblique view.
- **Species by place.** Conifers on cold and north-facing slopes and toward the tree line, broadleaf in warm valleys, birch on edges, in clearings and on riverbanks, krummholz shrubs at the tree line, acacia in savanna, dead trees in burnt or fought-over ground. Each kit type has its own silhouette (the fir's tiers, the pine's umbrella, the poplar's column, the oak's wide mass), so a type reads at a glance.
- **Lines and singles in the open.** Hedgerows along some farmland field boundaries (the Voronoi edges of decision 127), rows of poplars or birches along some roads, gallery woods along rivers and streams, and a lone large tree every few square kilometers of open land. Hedgerows also add cover across open farmland, which the helicopter tactic needs as much as forests.
- **Forest structure.** Clearings (from the density noise, as now), rides and firebreaks as straight lanes through managed temperate and boreal forest, and the existing road and settlement clearings, cut from the shell and the trees alike.
- **Seasons.** Per species: birch yellow, oak brown, conifers green (extending decision 43's autumn), so a mixed forest changes its pattern through the year.

## 4. The Tree Kit

Nine types are built as model specs (decision 106), within Part I's budgets: fir (tiered, 50 triangles), pine (umbrella crown, 58), oak (wide crown of three lumpy masses, 70), broadleaf (two masses, 50), birch (pale trunk, 50), poplar (column, 30), acacia (flat disc on a forked trunk, 44), shrub (20), dead tree (26). Two changes to the builder support them: a `tree` model class with Part I's budget of 12–80 triangles, and a `jitter` on blobs that moves each vertex along its radius by a hash of its position, so crowns are lumpy and faceted while staying closed. Each crown carries two or three of Part I's canopy shades, so value varies within a tree as well as between trees.

`tools/trees.preview.ts` renders the kit in a row and a forest corner (a fir and pine stand, a lower broadleaf stand, an edge fringe of shrubs and birches, a hedgerow, a row of poplars along a track, a lone oak) from a hovering helicopter and from above, on the CPU. A palm waits for the coast work.

The kit uses Part I's canopy shades, which are darker and less saturated than the owner's two references. Part I chose dark forest masses for legibility from altitude (reference board 2 and 5). At treetop height, value contrast between stands and species carries orientation better than overall brightness, so this proposal keeps the guide's shades and spends contrast on stands. That choice is the owner's to confirm (question 1).

## 5. The Simulation Reads the Same Forest

- **Line of sight.** The design already asks for line of sight against level-7 tiles and forest density (design, *Simulation*). With H, a sight line is blocked where it passes below ground + H inside a forest, except within the first 20–30 m beyond an edge, so a target just inside a tree line can still be seen through the edge trees. A helicopter unmasks when its sensor rises above H; its mast-mounted sight would unmask first if P5 models one.
- **Tree strikes.** The ground model (decision 134) adds H as an obstacle: rotor or fuselage below the canopy top inside a stand is a crash, as hitting the ground is today. Hovering beside a tree line is safe. The edge on screen and the edge in the sim come from one contour, so they agree within the edge trees' spread of a few meters.
- **AI.** Attack helicopter AI picks firing positions behind edges and hedgerows from the same field, which makes the AI's cover the player's cover.

## 6. Performance

The budget is 30 fps at the laptop's default settings and on a tablet at a lower tier, with Part I's ceiling of 2 M triangles per frame.

Estimate over continuous forest, for a 70° horizontal field of view (about a fifth of the disk around the camera) and 190 trees per hectare:

| Near radius | Trees in view | Triangles (about 45 per tree) |
|---|---|---|
| 400 m | 1,900 | 0.08 M |
| 700 m | 5,700 | 0.26 M |
| 1,000 m | 11,500 | 0.52 M |
| 1,500 m | 26,000 | 1.2 M |

Edge trees add 0.1–0.3 M and the shell up to the terrain's own count. At the laptop default of 700 m near and 1.5 km edge, trees and shell come to about 0.5–0.8 M triangles in the densest view, and about 1.1 M with the terrain, against 1.69 M today in `trees`. Triangles are not the only cost:

- **Vertex work.** Trees compute aerial perspective per vertex today, six march steps each. At several times today's tree count this is the first thing to measure; a froxel volume of aerial perspective computed once per frame (as in Hillaire's sky model) would replace the per-vertex march for trees and models.
- **Overdraw.** Dense crowns overlap. Tiles are drawn nearest first so the depth test rejects hidden crowns early; the understory shell lets interior crowns stay small.
- **Quality tiers.** The quality governor (decision 143) gains the near and edge radii as its next steps after the atmospheric effects: tablet 400 m and 1 km, laptop 700 m and 1.5 km, desktop 1.2 km and 2.5 km. The shell does not scale; it carries cover at every tier, so a slower machine sees fewer individual trees but never loses a tree line.
- **Measurement.** `PERF=n` in the render preview for counts and CPU time, then the owner's tablet and laptop (the open frame-rate tasks under V1 and I1).

## 7. Changes to the Style Guide

Part I's *Level of Detail* table becomes the three layers of section 2, with ranges set by quality tier. Part I asks for trees within 1.5 km to cast shadows; this proposal defers tree shadows (a shadow map over the near band would draw every tree a second time) and keeps baked occlusion in the crowns and the dark understory shell, which supply most of the depth cue. Acceptance check 2 (500 m over conifer forest with an edge and a road) gains a twin at helicopter height: 30 m over a forest edge with a hedgerow, looking along the tree line.

## 8. Steps

1. Tree kit specs and the builder's blob jitter, with the CPU previews (done with this draft; decision 147).
2. The canopy height field and its stands, CPU and GPU versions, with tests that they agree and a map mode in `npm run maps` to see the stands.
3. The canopy shell from the terrain tiles, with the understory hand-off; preview views at 30 m and 300 m over forest.
4. Near trees on level-11 tiles from the kit: crown-only interiors, whole edge trees, per-instance variation, stands; retire the clumps of decision 45.
5. Edge trees and linear features: hedgerows, tree rows, gallery woods, lone trees.
6. Measure; quality tiers in the governor; aerial perspective for instances if the vertex work shows.
7. Line of sight and tree strikes in the sim from the same field (with P3 and P1).

## Questions for the Owner

1. **Shades.** Keep Part I's dark canopy shades, with contrast spent on stands, or lift the near trees toward the brighter greens of the references?
2. **Tree shadows.** Defer them as proposed, or is a short-range shadow map (about 300 m) worth its cost for the hover-beside-a-tree-line view?
3. **Hedgerows.** How much of the farmland should be hedged? Bocage-like country makes a strong helicopter theater, but it changes the look of every farmed region.
4. **Edge porosity.** Is 20–30 m of see-through beyond a forest edge the right gameplay, or should edges be fully opaque?

## The Owner's Answers (2026-11-15)

1. **Shades.** Keep the shades of the previews, Part I's canopy shades; the owner evaluates them in the game later.
2. **Tree shadows.** Deferred, as proposed.
3. **Hedgerows.** By region, as in Normandy against the Midwest. Biomes cannot separate those two (both are temperate broadleaf or grassland), but climate can: Normandy's months span about 12 K, the Midwest's about 29 K. Hedgerow density therefore follows the climate texture's seasonal half-range (dense below about 6–8 K, none above about 11 K) and its moisture, on farmland, more on rolling ground than on flat plains, times a regional term over a few hundred kilometers so that similar climates still differ. Continental plains get sparse shelterbelts along the field grid instead. Dry-summer climates may later take stone walls and tree rows.
4. **Edge porosity.** For aircraft, dense forest obscures completely: any sight line from or to an aircraft is blocked by a closed forest up to its canopy top, edges included. Ground units' sight at forest edges is left to the ground entities.
