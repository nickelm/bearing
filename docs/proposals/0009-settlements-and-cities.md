# Proposal 0009: Settlements and Cities

*Drafted 2026-11-20. Status: accepted. Affects `docs/visual-style.md`, `docs/proposals/0001-two-views.md`, `docs/proposals/0005-terrain-adaptive-networks.md`, `docs/roadmap.md`, and `CLAUDE.md`.*

## Goals

Settlements currently look sparse, with buildings scattered on a ground texture that does not read as urban. This proposal gives every settlement a structure (streets, blocks, parcels, districts, and buildings) that adapts to terrain, with character by culture, while keeping the frame rate first.

Constraints, in priority order:

1. **Frame rate first.** Cities must not measurably slow the simulation view. Budgets in *Rendering* and *Verification* are hard limits.
2. **Structure over scatter.** Even the smallest hamlet follows roads, field boundaries, and terrain.
3. **Stylized and slightly cartoony.** Flat-shaded, low-poly buildings with chunky proportions (slightly oversized roofs and chimneys), a warm palette, and window bands instead of modeled windows.
4. **Adapt to terrain.** Streets follow contours on slopes; buildings sit on plinths; large structures get pads.
5. **Game-agnostic worldgen.** The settlement generator belongs to the world, not to Bearing's war. It keys urban styles to cultural regions, never to factions, and exposes data (districts, landmarks, candidate targets) that a game layer can read. Do not restructure existing code for this; apply it to the new code.
6. **Determinism.** New named RNG streams (`settlements/streets`, `settlements/parcels`, `settlements/buildings`, and so on); earlier stages stay unchanged.

## Settlement Tiers

Detail scales with size, so effort goes where players see it:

| Tier | Population class | Generation |
|---|---|---|
| City | Large | Full tensor-field streets, districts, landmarks |
| Town | Medium | Simplified tensor field (arterials, one grid or radial field, contours), fewer districts |
| Village | Small | Linear along a road or clustered around a green or church; parcels along road frontage |
| Farmstead | Scattered | Two to five buildings aligned to a road or field boundary, placed at field corners |

Thresholds come from the existing population model and are tuned so that the number of full cities per world stays modest.

## Street Generation

### Tensor Fields

Streets follow a **tensor field** of preferred directions, after Chen, Esch, Wonka, Müller, and Zhang, "Interactive Procedural Street Modeling" (SIGGRAPH 2008). The field blends basis fields:

- **Grid fields** aligned with each arterial entering or crossing the settlement;
- **a radial field** around the historic center;
- **boundary fields** along rivers, coasts, and rail lines;
- **contour fields** on slopes, aligned with terrain contours, so streets on hills run across the slope.

Each basis field has a weight that decays with distance, and slope steepness increases the contour field's weight.

### Tracing

- **Arterials** come from the regional network (proposal 0005) and are fixed.
- **Major streets** are traced as streamlines of the field with a separation of about 150 to 300 m.
- **Minor streets** are traced with a separation of about 60 to 120 m.
- Streamlines snap to nearby intersections, stop at water and steep ground, and respect a grade limit of about 10% for vehicle streets. Steeper links become stairs or footpaths.
- **Old cores** in cultures that have them use an organic ward layout instead (irregular blocks around a market square and a main street, in the spirit of Watabou's Medieval Fantasy City Generator), merging into the traced streets at the core's edge.

### Blocks and Parcels

Blocks are the faces of the street graph. Parcels come from subdividing blocks along their street frontage, following Vanegas et al., "Procedural Generation of Parcels in Urban Modeling" (Eurographics 2012), with parcel size set by district.

## Districts

Each block belongs to a district type, assigned from distance to the center, adjacency to rail, water, and arterials, terrain, and the settlement's culture:

| District | Character |
|---|---|
| Old core | Dense, irregular, mixed heights, landmarks |
| Inner grid | Perimeter blocks of four to six stories |
| Residential, detached | Houses with gardens |
| Residential, terraced | Rows of narrow houses |
| Microdistrict | Five- and nine-story slab blocks in parkland, with a school and shops |
| Industrial | Large sheds, yards, smokestacks, along rail or water |
| Rail yard | Tracks, sheds, platforms |
| Port | Quays, warehouses, cranes |
| Civic and parks | Squares, parks, sports grounds, cemeteries |
| Power and utilities | Power station, cooling towers, water tower, substation |

## Cultural Urban Styles

Styles attach to **cultural regions**, the same regions that drive naming. The game's casting may align factions with cultures; the generator itself knows nothing about factions.

| Style | Character |
|---|---|
| Western | Organic medieval core, a 19th-century grid ring, postwar detached suburbs, industry along the rail line; red tile and slate roofs |
| Eastern bloc | Old core, broad avenues and a large square, microdistricts, industrial combines; gray concrete, tin and tile roofs |
| Mediterranean | Dense core on a hill, ochre and white stucco, flat and low tile roofs |
| Nordic | Low wooden buildings, steep roofs in dark red and black, generous spacing |
| Arid | Flat roofs, courtyard houses, pale earth tones |

Zones from proposal 0007 shift palettes within each style.

## Terrain Adaptation

- **Streets** drape on the terrain and render as shading; arterials keep their corridor edits from proposal 0005.
- **Plinths.** Each building extends down to the lowest ground point under its footprint, giving the stacked look of real hill towns without terrain edits.
- **Pads.** Large structures (factories, rail yards, stadiums, power stations) and terraced squares on steep ground get pad edits from the edit framework.
- **Water.** No building or street crosses a river or coast except at bridges.

## Urban Ground

The terrain shader renders urban ground from the feature distance field (proposal 0005), with no extra geometry: asphalt streets, pale sidewalks, paved plazas, gardens and yards, parks, parking lots, industrial concrete, and rail ballast. District type tints the ground slightly. This replaces the biome shading under settlements.

## Buildings

- **Generation.** One building per parcel from district and style rules: footprint with setback, height by district and distance from the center, roof type by style (gable, hip, flat, shed), and occasional extras (chimneys, dormers, balconies, rooftop water tanks).
- **Look.** Flat-shaded, vertex-colored, slightly chunky. Window bands come from a world-space pattern in the wall shader, visible within about 1 km.
- **Landmarks.** Churches and cathedrals, town halls, TV towers, water towers, stadiums, monuments, and industrial landmarks, placed by district and style, with names from the naming system.
- **Smokestacks.** Industrial chimneys and power station cooling towers, with smoke and steam plumes made of a few soft billboards that drift with the wind. Plumes double as wind indicators.

## Rendering

### Levels of Detail

| Distance | Representation | Budget |
|---|---|---|
| Beyond about 15 km | Shading only: roof colors from parcel data, block shadows, night lights | No geometry |
| 5 to 15 km | One extruded prism per block at average height, merged per terrain tile | About 10 triangles per block |
| 1 to 5 km | Merged block meshes with individual building boxes and roofs | About 12 to 30 triangles per building |
| Under 1 km | Building kits with roof details, chimneys, and balconies, instanced | Within the model budgets of `docs/visual-style.md` |

Meshes are built from settlement data in a worker on demand, cached per tile, and released when far away.

### Hard Budgets

In the standard city test views (a large city from 5 km and 1 km altitude, and a town from 300 m):

- frame time increase at most 1.5 ms compared with the same view without buildings;
- urban triangles at most 15% of the scene triangle budget;
- urban draw calls at most 40.

### Night

Windows light at random through an emissive term in the wall shader, and streetlights render as instanced points along streets. A per-settlement lighting level (lit, dimmed, blacked out) is exposed as a parameter for the game layer to set.

## Damage

Buildings have three states: intact, damaged (blackened, partly collapsed roof), and rubble (an instanced rubble kit). States live in a compact per-tile array; changing a state rebuilds only the affected block mesh. Damaged landmarks and strategic structures add smoke and fire plumes. If rubble for every building proves too costly, limit full damage states to strategic structures and landmarks and use a blackened tint elsewhere.

## Collision and Line of Sight

Building footprints and heights produce box colliders for physics, line of sight, helicopter landings (rooftops, plazas), and later ground combat.

## Strategic View

City extents come from the block outlines. In the Region band, major streets and landmarks appear as glyphs, and districts tint the city fill subtly (industry, rail yards, ports).

## Data for a Game Layer

The generator exports, per settlement: districts, blocks, landmarks, and **candidate targets** (rail yards, power stations, factories, depots, ports, bridges, airfields), each with position, footprint, type, and name. Bearing's planner reads these; the generator does not depend on Bearing.

## Verification Criteria

| Check | Criterion |
|---|---|
| Frame time | Within the hard budgets in the standard city views |
| Triangles and draw calls | Within the hard budgets |
| Structure | No building outside a parcel; every parcel fronts a street or road |
| Terrain fit | No floating buildings; every plinth reaches the ground; no building or street in water |
| Slopes | On slopes above 10%, the majority of minor street length lies within 30° of the contour direction |
| Grades | Vehicle streets respect the grade limit; steeper links are stairs or paths |
| Styles | Each cultural style appears in the 20-seed test set where its regions exist |
| Damage | State changes rebuild only the affected block; rubble swap costs under 2 ms |
| Generation time | Reported per tier; total worldgen time increases by at most 30% |
| Determinism | Same seed, same settlements; earlier stages unchanged |
| Independence | No module under the settlement generator imports game, campaign, or faction code |
