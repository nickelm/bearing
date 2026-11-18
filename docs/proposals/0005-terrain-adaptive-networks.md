# Proposal 0005: Terrain-Adaptive Networks

*Drafted 2026-11-15. Status: accepted (decision 161). Affects `docs/design.md`, `docs/visual-style.md`, `docs/proposals/0001-two-views.md`, `TODO.md`, and `CLAUDE.md`. The implementation plan is [docs/plans/terrain-networks.md](../plans/terrain-networks.md). Extended by [proposal 0007](0007-world-diversity.md) (decision 204): rivers into closed basins end at their lake's surface and keep the monotone profile, and alignments keep out of natural wonders' footprints except for scenic routes that pass in sight.*

*Audit 2026-11-18 (decision 229): features are drawn from segment lists, not a per-chunk distance field (decision 161); airfield pads are exempt from "rivers always last" until siting keeps them off rivers (decision 164); links are aligned independently in a spatial order (decision 184), not railways first; bridges are not yet nodes that a strike can cut, and fewer than half of the network's bridges match a drawn crossing (decision 190). This proposal has no roadmap section; `docs/roadmap.md` schedules its remaining work (decision 228).*

## Principle

Every linear feature has a **design speed or flow regime**, and that regime decides how the feature and the terrain adapt to each other. A slow lowland river wanders and carves a floodplain. A minor mountain road yields to the slope and switches back. A motorway cuts, fills, and bridges to keep its grade and curves. A mainline railway accepts long detours, horseshoe curves, spiral loops, viaducts, and tunnels before it accepts a steep grade. A power line ignores the terrain.

Adaptation runs in both directions. Features bend to the terrain, and the terrain bends to the features: rivers carve channels and floodplains, roads and railways get embankments, cuttings, and banks, and canals step down through locks. Meanders, switchbacks, loops, and bridges should emerge from these rules, not be drawn in by hand.

## Constraints from Earlier Decisions

The current river generation already embodies decisions that this work must preserve:

1. **Monotonic rivers.** River water surfaces never rise downstream.
2. **No humps.** River beds have no local bumps along the flow.
3. **No ladder patterns.** Rivers show no stair-stepping or grid-aligned zigzags from the underlying height grid.
4. **Darkened banks.** Rivers keep their darkened bank band in the terrain shading.
5. **Heightfield fidelity.** The height grid is far coarser than a river channel or a road. Detail finer than the grid must come from analytic edits and shading, never from pretending the grid is finer.

Two further constraints apply:

6. **Triangle budget.** Rivers, roads, railways, and their earthworks add no separate geometry. They render through the terrain shader and through edits to existing terrain vertices. Only discrete structures (bridges, tunnel portals, locks, pylons) add instanced geometry, within the model budgets in `docs/visual-style.md`. A modest local refinement of terrain LOD along corridors near the camera is allowed if it stays within 10% of the terrain triangle count in the standard test views.
7. **Determinism.** All new stages draw from new named RNG streams. Adding them must not change the output of any earlier stage.

## Generation Order

Rivers come first, and everything else adapts to them:

1. **Rivers:** vectorized, meandered, carved, with floodplains, oxbow lakes, and deltas.
2. **Crossing sites:** candidate bridge and ford sites along rivers, preferring narrow, straight reaches with firm banks.
3. **Settlements:** existing placement, now also pulled toward confluences and crossing sites.
4. **Railways:** the most constrained network, routed first among the transport networks.
5. **Major roads:** motorways and trunk roads.
6. **Minor roads:** secondary roads, mountain roads, and tracks, branching from the existing network.
7. **Canals (stretch):** level pools linked by locks.
8. **Structures:** bridges, viaducts, tunnels, culverts, and locks, generated from the routed corridors.
9. **Names:** for river reaches, road and rail sections, bridges, tunnels, and locks.

Each stage claims a corridor and registers terrain edits. Later stages treat earlier corridors as obstacles or attachment points.

## Terrain Edits

Earthworks are **analytic terrain edits**: vector corridors and areas with cross-section profiles, evaluated whenever the terrain height is sampled. The runway flattening from Free Flight already works this way; this proposal generalizes it.

### Edit Types

| Edit | Effect | Used by |
|---|---|---|
| Carve | Lowers terrain to a channel profile; never raises | River channels |
| Floodplain | Lowers and smooths toward a gently sloping surface; never raises | Lowland rivers |
| Corridor | Sets terrain to a design surface with side slopes; may raise (fill) or lower (cut) | Roads, railways, canals |
| Pad | Flattens an area | Runways, aprons, lock chambers, rail yards |
| Build-up | Raises terrain slightly toward sea level | Delta lobes only |

### Composition Rules

Edits compose in a fixed order with fixed priorities:

1. Base terrain.
2. Corridor and pad edits, blended where they overlap.
3. River carve and floodplain edits, applied **last** as a minimum. A river channel always cuts through any road or rail fill.

Rule 3 guarantees that no embankment can ever dam a river, and therefore that the monotonic river profile survives every later stage. Where a road or railway crosses a river, its deck is separate bridge or culvert geometry, never terrain.

### One Sampler

A single height sampler, with a spatial index over all edits, serves rendering, physics, line of sight, and the AI. The rendered mesh samples the same function at its vertices. Close to the camera, the terrain LOD must be dense enough that the rendered surface and the analytic surface differ by less than 0.5 m along corridors.

## Rivers

### Vectorization and Profile

- Extract the existing river network as polylines from flow accumulation. Smooth them in plan view to remove grid artifacts.
- Compute the water surface along arc length and force it to be monotonically non-increasing downstream (a running minimum), then smooth it without breaking monotonicity.
- Derive bed elevation from the water surface minus a depth that grows with discharge. Channel width also grows with discharge.

### Planform by Regime

- **Mountain streams** (steep gradient): nearly straight, incised, locked to the valley floor. Sinuosity 1.0 to 1.3.
- **Lowland rivers** (low gradient, within a floodplain): meandering. Run a meander-migration simulation in the style of Howard and Knutson (1984): bends migrate according to upstream-weighted curvature, and when two loops come within about one channel width, the neck cuts off and leaves an **oxbow lake**. Keep the river inside a floodplain mask derived from valley walls. Meander wavelength should come out at about 10 to 14 channel widths and bend radii at about 2 to 3 widths. Target sinuosity 1.5 to 2.5 for large lowland rivers.
- **Small lowland streams:** procedural meanders, with displacement along the normal, wavelength tied to width, and amplitude scaled by flatness and available floodplain width.
- **Braided channels (stretch):** on steep, sediment-rich outwash plains.

Meandering lengthens a river between fixed endpoints, which lowers its gradient. Recompute the profile on the final planform; monotonicity holds because the endpoints do not move.

### Floodplains, Deltas, and Knickpoints

- **Floodplains:** a floodplain edit flattens the valley floor around meandering reaches. Oxbow lakes, abandoned channels, and wetland patches sit on it.
- **Deltas:** where a meandering, sediment-rich river reaches the sea at low gradient, generate a distributary network that bifurcates downstream, with a lobe-shaped plain built up to just above sea level and a marsh or wetland biome. Rivers that reach the sea elsewhere end in estuaries.
- **Knickpoints:** where the profile steepens sharply, mark rapids or waterfalls for shading (foam, spray). They add no geometry.

### Rendering

Rivers render in the terrain shader from a per-chunk **feature distance field** generated on the GPU from the vectors. This gives crisp channel edges independent of mesh density, plus the darkened bank band, which this proposal keeps and extends to oxbows and distributaries. Water surfaces of rivers and oxbow lakes follow the computed water elevation. On the strategic map, rivers are generalized (simplified and smoothed) with exaggerated width, so major meanders stay legible.

## Roads and Railways

### Routing

Roads and railways use the same router with different parameters per class:

- **Anisotropic cost:** grade measured along the direction of travel, with a cost that rises steeply toward the class's maximum grade and becomes prohibitive above it. On steep faces, switchbacks emerge because zigzagging is cheaper than climbing directly.
- **Extended neighborhood:** the search uses 16 or 32 directions so paths are not restricted to grid angles, following Galin et al., "Procedural Generation of Roads" (Eurographics 2010).
- **Curvature cost:** a penalty on heading change, scaled by the class's minimum radius.
- **Obstacles and attractors:** river crossings cost the price of a bridge and prefer marked crossing sites; existing corridors attract minor roads; mountain passes (saddle points between drainage basins) attract routes across ranges.
- **Structure options:** for each candidate edge, compare following the terrain, cut or fill, a viaduct, and a tunnel, with costs per class, and keep the cheapest.

### Design Parameters

Approximate values, to be tuned:

| Class | Max grade | Min radius | Viaduct above fill of | Tunnel above cut of | Behavior |
|---|---|---|---|---|---|
| Mainline railway | 1.5–2% | 500 m | 12 m | 20 m | Long valley detours, horseshoe curves, spirals |
| Mountain railway | 3.5–4% | 250 m | 12 m | 20 m | Spiral loops, many tunnels |
| Motorway | 4–5% | 700 m | 15 m | 30 m | Heavy earthworks |
| Trunk road | 6–7% | 300 m | 15 m | 40 m | Follows major valleys, moderate earthworks |
| Secondary road | 8–10% | 100 m | none | none | Follows terrain, some switchbacks |
| Mountain or minor road | 12–15% | 12 m at hairpins | none | none | Switchbacks, hugs contours |
| Track | 20% | 8 m | none | none | No earthworks beyond a shallow bed |

### Geometry and Profile

- **Plan:** fit the routed path with straights and circular arcs (with simple transition curves where cheap) that respect the minimum radius. Hairpins get the tight radius and a small pad edit for a retaining shelf.
- **Profile:** compute a smooth design elevation along the corridor that respects the maximum grade, using vertical curves at crests and sags.
- **Earthworks:** the difference between design elevation and terrain gives cut or fill. The corridor edit produces a flat formation (road crown or ballast bed) with **banks**: side slopes of about 1:1.5 for fill and 1:1 for cuts in rock. Where fill or cut exceeds the class thresholds, the segment becomes a viaduct or tunnel instead.

### Rendering

Roads and railways render in the terrain shader from the same feature distance field: asphalt or gravel, shoulders, lane markings at close range, rail ballast with rails visible below about 1 km altitude, and lighter or darker shading on embankment and cutting slopes. They add no ribbon geometry in the simulation view. On the strategic map, they render as cartographic lines per proposal 0001, with tunnels as dashed segments.

## Structures

### Bridges

Bridges matter for the strategic war: they are interdiction targets, chokepoints for logistics, and named places. Every crossing of a river by a road or railway produces a bridge or culvert record:

- **Data:** id, name, type, span, deck elevation, the route and class it carries, the feature it crosses, its strategic value (traffic carried, alternatives nearby), and a damage state for later use.
- **Type by span and class:** culverts for streams narrower than about 5 m (no visible structure); beam bridges for short spans; truss bridges for railways and longer spans; arch bridges in gorges; viaducts over dry valleys; a rare suspension bridge across estuaries.
- **Geometry:** assembled from an instanced low-poly kit (piers, deck segments, truss panels, arches, abutments) in the style of `docs/visual-style.md`. Budgets: about 300 triangles for a short beam bridge, up to about 1,500 for a long truss or viaduct.
- **Strategic graph:** bridges register as nodes on the road and rail graphs, and the strategic map shows them with a bridge symbol and, in the Region band, a label.

### Tunnels

Tunnels are visual and named: portal geometry at each end (about 100 to 200 triangles), the route drawn as a dashed segment on the strategic map, and terrain left intact above them. Vehicles in the ground simulation traverse them; aircraft cannot enter them.

### Locks and Canals (Stretch)

Canals follow contours at constant water level in pools, with locks where the level steps. Each lock is a pad edit for the chamber plus a small kit model with gates. Locks are numbered along each canal. Where a canal crosses a river, it uses an aqueduct.

### Other Structures (Later)

Power lines run nearly straight with pylons on high ground and span valleys; they add a wire-strike hazard for helicopters. They are out of scope for this proposal but should use the same corridor framework.

## Names

Names come from new streams derived from the naming stream (for example `names/rivers`, `names/routes`, `names/bridges`), so they never perturb existing names:

- **River reaches:** major rivers keep one name; notable reaches can get their own ("the Brann Narrows").
- **Road and rail sections:** route numbers remain; notable sections get names, such as passes ("the Kessar Pass Road"), gorges, coastal stretches, and named rail lines ("the Northern Line") with named sections like spirals and inclines.
- **Bridges:** named after the river, the nearest town, or the feature ("Brann Bridge", "Oskel Viaduct").
- **Tunnels:** named after the mountain or pass.
- **Locks:** numbered along their canal ("Lock 7").

Names appear on the strategic map by zoom band and in briefings and mission names ("interdiction strike on Oskel Viaduct").

## Verification Criteria

| Check | Criterion |
|---|---|
| River monotonicity | Water surface non-increasing downstream at every sample (tolerance 1 mm) |
| No humps | No local maxima in bed elevation along any river |
| No ladders | No significant clustering of river headings at multiples of 45°; no stair-step segments shorter than two grid cells |
| Sinuosity | Large lowland rivers 1.5–2.5; mountain streams 1.0–1.3 |
| No dams | No road or rail edit raises terrain inside any river channel |
| Crossings | Every road or rail crossing of a river has a bridge or culvert record |
| Grades | Final profiles respect each class's maximum grade within 0.5 percentage points |
| Radii | Final plans respect each class's minimum radius |
| Switchbacks | At least one mountain road with switchbacks appears in each of the test seeds that have mountains |
| Surface agreement | Rendered and analytic surfaces differ by less than 0.5 m along corridors within 2 km of the camera |
| Triangle budget | Terrain triangle count in the standard test views rises by at most 10%; structures within their budgets |
| Determinism | Same seed, same output; earlier stages unchanged by the new stages |
| Generation time | Reported per stage; total pipeline time at most doubled |
