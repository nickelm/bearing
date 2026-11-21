# Proposal 0010: Terrain Art Direction

*Drafted 2026-11-21. Status: accepted. Affects `docs/visual-style.md`, `docs/proposals/0005-terrain-adaptive-networks.md`, `docs/proposals/0007-world-diversity.md`, `docs/roadmap.md`, and `CLAUDE.md`.*

*Accepted 2026-11-21 (decision 296), with the owner's addendum of the same day: every layer can be scaled and switched off when it costs too much, and the world is configurable, so the same generator can serve other game genres; the common look across them is faceted, retro and cartoony. The implementation plan is [docs/plans/terrain-art.md](../plans/terrain-art.md). The proposal's "relief scale" is `PlanetParams.reliefExaggeration` in the code, because `reliefScale` already names the planet-to-Earth ratio of decision 14 (decision 297).*

## Goals

The terrain, biomes, and towns are in good shape. This proposal adds the layers that make landscapes spectacular in the way World of Warcraft zones are: dramatic shapes, painterly surfaces, rich atmosphere, waterfalls, structures in striking places, and landmarks placed where players see them. All of it stays flat-shaded, stylized, and within the frame budgets.

The guiding observation: WoW's spectacle comes mostly from layers on top of a modest height field. Bearing adds six such layers: **shape, surface, air, water, structures, and composition**.

## Shape

### Relief Scale

A new world parameter, **relief scale**, multiplies terrain height above sea level. The default is **1.3**, with a range of 1.0 to 1.5.

- Relief scale is applied as a worldgen stage **after** erosion, climate, and biomes, and **before** terrain networks, settlements, props, and structures. Climate and biome assignment therefore use unscaled heights and do not change; everything built on the terrain is built on the scaled surface and stays consistent with it.
- All downstream systems (the height sampler, physics, line of sight, radar horizons, HUD altitudes, spot heights on maps) use scaled heights. There is one surface.
- Scaling is monotonic, so river profiles stay monotonic. Road and rail grades are computed on the scaled surface, so grade limits hold.
- The strategic view's own vertical exaggeration applies on top, as before.

### Rock Dressing

A **rock dressing** pass places instanced, flat-shaded rock pieces over steep terrain, so cliffs, gorges, and ridges gain overhangs, ledges, stacked towers, and broken edges that a height field cannot express.

- **Kit:** about 12 to 20 modular pieces built with the procedural model builder: cliff slabs, ledge shelves, buttresses, boulders, scree fans, spires, and crest teeth, in sizes from 5 to 200 m. Each piece takes per-instance scale, rotation, and color from lithology.
- **Placement:** driven by slope, curvature, and province. Cliff slabs line slopes steeper than about 45°; crest teeth follow sharp ridges; buttresses step down canyon walls; scree fans gather at cliff bases; boulders scatter on alpine meadows and moorland. Pieces sink partly into the terrain so they never float.
- **Lithology:** sandstone pieces are blocky and banded, granite rounded and massive, limestone pale and fluted, basalt columnar, schist slabby.
- **Relation to proposal 0007:** rock dressing is generic and dense; the landform props in 0007 (karst towers, sandstone pillars, sea stacks, arches) are specific and sparse. Both share the placement and instancing infrastructure.
- **Collision:** pieces above about 20 m get simple box or capsule colliders for physics and line of sight; smaller pieces are visual only.

## Surface

Three shading effects give terrain its painterly look, all computed in the terrain shader from data baked once per world:

- **Curvature shading.** Concave terrain (valleys, gullies, crevices) darkens; convex terrain (ridges, crests, edges) lightens. A curvature map baked from the height field drives it, so relief reads from any angle and in flat light.
- **Strata bands.** Cliffs and steep slopes in layered rock show horizontal color bands by lithology, aligned to elevation with gentle noise.
- **Color drift.** Hue and value shift with altitude, slope, aspect, and low-frequency noise within each biome's palette, so no biome reads as one flat color. Sun-facing slopes warm slightly; shaded slopes cool.

Rock dressing pieces use the same strata and drift functions, so they blend into the terrain they sit on.

## Air

Each zone's look recipe from proposal 0007 gains atmospheric settings:

- **Valley mist.** Mist pools in low ground at dawn and after rain, thinning through the morning. It renders as a height-limited fog layer that follows terrain, with a soft top.
- **Height fog.** Zone-colored fog that thickens toward low altitudes, separate from distance haze.
- **Light shafts.** Screen-space light shafts from the sun through clouds and gaps between ridges, at low sun angles.
- **Ambient particles.** Pollen and seeds in meadows, falling leaves in deciduous forest, blowing dust in deserts, drifting snow at altitude, fireflies at dusk in humid zones. Particles exist only near the camera.
- **Sky.** A stylized sky dome with a large sun and moon, stars, and aurora at high latitudes.

## Water

- **Waterfalls.** Knickpoints marked by proposal 0005 and cliff edges crossed by rivers become waterfalls: a stylized falling water sheet (a curved strip with scrolling bands), a foam pool, and a mist cloud using the effects system of proposal 0011. Tall waterfalls are named and can be wonders.
- **Rapids.** Steep river reaches get foam bands in the water shader.
- **Lake surfaces.** Calm lakes reflect the sky more strongly than rivers, for mirror-like mountain lakes.

## Structures

### Framework

A **points of interest** framework places structures where they would plausibly be built, scored by site suitability: prominence, view, access, defensibility, and proximity to settlements, roads, coasts, and passes. The framework is game-agnostic. It places and names structures and exports them; a game layer decides their function.

Each point of interest type defines a placement score, a model kit, an optional access road (using the network router of proposal 0005), a pad edit if needed, a name pattern, and a strategic map glyph.

### Initial Kit

No castles or ruins. The initial kit is modern and fits the period:

| Type | Typical site |
|---|---|
| Radar station | Summits and high ridges with wide views; radomes and lattice antennas |
| Early-warning radar | Coastal heights and border ridges; large radomes |
| Relay tower | Hilltops along major roads |
| Bunker complex | Passes, gorges, and approaches to cities |
| Coastal battery | Headlands commanding sea lanes and harbors |
| Observation post | Ridges overlooking valleys and plains |
| Dam and reservoir | Narrow gorges on large rivers, with a lake behind |
| Lighthouse | Headlands and harbor entrances |
| Observatory | High, dry summits |
| Quarry or open-pit mine | Mountain flanks and desert ranges |
| Oil or gas field | Sedimentary basins in arid zones, with derricks and tanks |
| Power line corridor | Between power stations and cities (pylons, as proposed in 0005) |

A game layer can turn these into military functions: a radar station becomes a node of an air defense network, a bunker complex a strongpoint, a dam a strategic target.

## Composition

Landmarks matter most where players look. Placement of wonders (proposal 0007), the most striking points of interest, and the largest waterfalls is biased toward **viewsheds**: places visible from approach paths to airfields, major roads, sea lanes, and broad valleys. Each world should present a dramatic landmark within view of most airfields.

## Budgets

In the standard test views (an alpine valley at 500 m, a canyon at 300 m, a coast at 1 km):

- rock dressing at most 20% of the scene triangle budget and at most 30 draw calls;
- atmospheric effects (mist, height fog, light shafts, particles) at most 1.5 ms per frame together;
- total frame time increase at most 3 ms compared with the same views before this proposal.

## Verification Criteria

| Check | Criterion |
|---|---|
| Relief scale | Downstream systems all use the scaled surface; river, grade, and network invariants pass at scale 1.0, 1.3, and 1.5 |
| Biomes | Biome distribution identical at all relief scales |
| Rock dressing | No floating pieces; cliffs steeper than 45° show dressing in all test views |
| Shading | Curvature, strata, and drift visible in screenshots; no seams across terrain tiles |
| Waterfalls | Every major knickpoint on a large river has a waterfall |
| Structures | Each type appears in the 20-seed test set where its sites exist; every structure has a name and glyph |
| Composition | A dramatic landmark is visible from at least 70% of airfields |
| Budgets | Within the limits above |
| Independence | Structure and dressing code imports no game, campaign, or faction modules |
| Determinism | Same seed, same world |
