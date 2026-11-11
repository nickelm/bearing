# Proposal 0001: Illustrated Strategic Map and Simulation View

*Drafted 2026-11-11. Status: accepted 2026-11-11 with one amendment (decision 72). Amended by Proposal 0002 (decision 92): Bearing has no cockpits, so the simulation view is entered through a chase view or an observer camera. Affects `docs/design.md`, `docs/visual-style.md`, and `TODO.md`.*

## Summary

Bearing gets two distinct views of the same world, each with its own renderer and visual language.

- **The strategic view** is an illustrated globe in the spirit of Civilization VI and Cold War operational maps. It caricatures the world to convey strategic information: exaggerated relief, painted biomes with pattern textures, low-poly mountain and city glyphs, a hierarchy of roads, and labels for cities, roads, mountain ranges, peaks, deserts, forests, rivers, and seas. Zoom stops at a floor where the map still looks crisp. Individual trees do not appear.
- **The simulation view** is the high-fidelity, low-poly world from `docs/visual-style.md`: faceted terrain, the tree kit, atmosphere, clouds, water, and ground detail. It covers altitudes from the ground to about 20 km and is entered only through a unit.

The two views share world data and the simulation, and differ in everything they draw. A short transition connects them.

## Rationale

**Clarity.** A strategic view must answer questions at a glance: where the front runs, which roads feed it, which mountains shield which bases, how far the bombers must fly. Photographic rendering hides these answers among detail. A map that abstracts, exaggerates, and labels shows them directly. Civilization VI does this for a game board, and the NATO planning maps and 1980s board wargames that shaped *Red Storm Rising* did it for real campaigns.

**Risk.** The current plan requires one renderer that zooms continuously from orbit to 500 m with consistent atmosphere, terrain LOD, and vegetation. That is the hardest rendering problem in the project. Splitting the views removes it. The strategic renderer never gets closer than its zoom floor, and the simulation renderer never climbs above the aircraft ceiling.

**Bounded simulation rendering.** On a planet with a 1,000 km radius, the horizon distance at altitude *h* is about √(2Rh). At 20 km altitude the horizon lies about 200 km away; at 500 m, about 32 km. The simulation view therefore never needs terrain beyond 200 km, which bounds its terrain streaming, LOD depth, and memory.

**Identity.** Two clearly different looks make each mode feel purposeful: the map is where you plan and choose, and the simulation view is where you fly.

## Comparison of the Two Views

| Aspect | Strategic view | Simulation view |
|---|---|---|
| Purpose | Read the war, find missions, follow events | Fly, fight, watch |
| Camera | Orbit, from full globe down to a zoom floor of about 100 km altitude | Chase and observer cameras, 0 to about 20 km altitude |
| Terrain | Smooth stylized relief, 4× vertical exaggeration, baked hillshade | Faceted flat-shaded terrain at true scale |
| Ground color | Painted biome colors with procedural pattern textures | Quantized biome shades per face, field patchwork |
| Mountains | Low-poly mountain glyphs along ranges, labeled peaks | Real terrain |
| Forests | Pattern fill, oversized forest tokens at close zoom | Tree kit with LOD |
| Settlements | Urban extent fill, oversized building-cluster glyphs by city class | Box buildings, base kit |
| Roads | Cartographic hierarchy with casing and route names | Thin road lines on terrain |
| Lighting | Fixed cartographic light from the upper left, optional night overlay | Physical sun, sky, day-night cycle |
| Weather | Optional stylized cloud-cover overlay | Volumetric clouds |
| Units | Symbols and icons | Models |
| Labels | Hierarchical, zoom-dependent | None, apart from HUD |
| Post-processing | Light vignette, subtle paper grain | Full chain from `visual-style.md` |

## Strategic View

### Camera and Zoom

- **Range.** From about 3,000 km altitude, where the full globe fills the screen, down to a floor of about 100 km altitude, where the view spans roughly 200 km of ground. The floor value gets tuned so that glyphs, patterns, and labels stay sharp at the closest zoom.
- **Tilt.** Straight down at globe scale, pitching smoothly to about 50° at the floor, so relief and glyphs read in perspective when the player is close.
- **Zoom bands.** Content appears and disappears by band, with short fades.

| Band | Altitude | Content |
|---|---|---|
| Globe | above 1,500 km | Continents, oceans, theater names, territory tint, front lines |
| Theater | 400–1,500 km | Mountain ranges, deserts, major forests, major rivers, capitals and cities, sea lanes, chokepoints, airbases as icons |
| Region | below 400 km | Peaks with elevations, all towns, named roads, minor rivers, bridges, ports, industry, air defense sites, unit symbols |

### Base Map

- **Relief.** A cube-sphere mesh displaced from the baked height map with 4× vertical exaggeration (tunable), and a moderate quadtree so the floor zoom stays sharp. Shading uses a baked hillshade with a fixed light from the upper left of the screen, following cartographic convention, plus soft ambient light.
- **Biome painting.** A softened, illustrative version of the biome palette. Each biome gets a procedural pattern texture generated in the shader: stippled canopy for forests, dune ripples for deserts, a faint field grid for farmland, tussocks for tundra, rock hatching on steep slopes. Biome boundaries blend over a few kilometers. Patterns use screen-stable scaling so they look the same at every zoom within a band.
- **Coasts and water.** Water gets depth tints in a few flat bands, with a lighter halo along coasts and the faint parallel coastal lines of old printed maps. Coastlines carry a thin dark outline. Lakes and wide rivers use the same treatment.
- **Graticule.** Optional latitude and longitude lines, plus range rings around a selected base or aircraft. There is no hex grid: hexes imply movement rules, and the simulation has none.

### Geographic Glyphs

- **Mountains.** Low-poly peak glyphs (faceted pyramids with snow caps above the snow line), instanced along ridge lines detected from uplift and prominence. Glyph size scales with prominence, and spacing keeps ranges legible as chains. Hills get smaller, rounded mounds.
- **Forests.** Pattern fill everywhere, plus sparse, oversized forest tokens (clumps of three to seven stylized trees, each token about 2 to 5 km across) in the Region band only.
- **Other landforms.** Dune glyphs in sand deserts, reed marks in wetlands, and cracked-ice patterns on ice caps.

### Settlements and Infrastructure

- **Cities.** Each settlement has an urban extent polygon from the settlement growth model, drawn as a tinted fill. An oversized low-poly building cluster marks its center, with size and style set by city class: village, town, city, capital. Capitals carry a star marker.
- **Roads.** A road hierarchy (motorway, trunk, secondary) derived from a gravity model: a road's class grows with the populations it connects and the traffic routed over it. Roads render as screen-space ribbons with a darker casing, colored and sized by class, with bridges marked where they cross rivers.
- **Railways.** Recommended addition: a rail network linking major cities, ports, and industry. Rail yards and bridges were central interdiction targets in Cold War planning.
- **Military and industrial sites.** Airbases as runway glyphs with icons, ports as pier glyphs, and factories, refineries, depots, and rail yards as distinct symbols. These double as strike targets in mission search.

### Named Geography

- **Feature extraction.** A new worldgen stage turns the baked maps into named features: continents, oceans, seas, bays, straits, islands and archipelagos, mountain ranges (connected high-uplift ridge regions), individual peaks (local maxima by prominence), deserts, major forests, wetlands, plains and plateaus, rivers (main stems from flow accumulation), and lakes. Each feature stores its geometry (point, polyline, or polygon), its extent, and an importance score.
- **Toponymy.** A seeded name generator (`rng("names")`) builds names from syllable inventories and phonotactic rules, with one naming flavor per cultural region. Each landmass or region gets its own flavor, so names on the Alliance side and the Pact side sound different without copying real languages. Generic terms complete each name: "the Varden Range", "Mount Kessar (4,210 m)", "the Oskel Waste", "Lake Brann", "the Teller Strait". The invasion corridors from the front generator get names too, in the tradition of the Fulda Gap.
- **Road names.** Major roads get route numbers from a fictional numbering scheme (for example "R4" and "M12"). Notable winding roads through passes or along coasts get names, such as "the Kessar Pass Road".

### Labels

- **Typography.** Cartographic conventions: water features in blue italic; landforms in brown, letter-spaced capitals; settlements in dark type with a light halo, sized by class; military features in faction colors.
- **Placement.** Point labels for cities and peaks, curved labels along polylines for rivers, ranges, and roads, and widely spaced area labels across deserts, forests, seas, and regions.
- **Collision.** A screen-space placement pass, run when the camera settles or changes band, ranks labels by importance and drops those that collide. Labels fade in and out to avoid popping.
- **Rendering.** MSDF text, rendered by the WebGPU pipeline. The library choice must be checked against current Three.js WebGPU support.

### Military Overlays

Territory tint per faction; the front line as a bold line with teeth on the attacker's side; defensive lines dashed; invasion corridors as named arrows; sea lanes as dashed routes with convoy icons; chokepoints marked; air defense coverage as faint rings; formations as NATO-style unit symbols; flights as small aircraft icons with heading and short trails; mission routes on hover and selection. Overlay layers can be toggled.

### Time and Weather

The base map keeps its fixed cartographic lighting regardless of time. Since night and weather matter for missions, two optional overlays show them: a night overlay that tints the dark side of the terminator in deep blue, and a stylized cloud-cover layer of soft, translucent shapes from the simulation's weather field.

> **Amendment (owner, on acceptance; decision 72).** Planning sorties needs night and weather, so the map always shows day and night, seasons, and weather and clouds in stylized form. They are not optional overlays. Only the relief hillshade keeps the fixed cartographic light. See `docs/visual-style.md`, Part II.

### Later Idea: Intelligence

Enemy territory that friendly reconnaissance has not covered recently could render in a sketched, desaturated style, similar to the unexplored areas of Civilization VI. Reconnaissance missions would then reveal the map. This depends on an intelligence model in the simulation and is out of scope for the demo.

## Simulation View

- **Altitude envelope.** From the ground to about 20 km. The renderer only handles terrain within the horizon, at most about 200 km away.
- **Entry.** Only through a unit: following a flight from mission search or jumping into one of its aircraft, both in the same chase view (Proposal 0002), or an observer camera at a base or ship. There is no free camera in the simulation view.
- **Content.** Unchanged from `docs/visual-style.md`: faceted terrain, the tree kit, settlements and the base kit, models from the procedural builders, atmosphere, clouds, water, and the full post-processing chain.
- **Removed requirements.** The orbit-level parts of `docs/visual-style.md` move to the strategic view or disappear: the limb glow at orbit, terrain LOD above 20 km, and the acceptance check for an orbit view at golden hour.

## Transition Between Views

Selecting a flight and choosing *Follow* or *Jump in* starts a transition. The strategic camera eases toward the flight down to the zoom floor; a quick dissolve through a cloud layer hides the switch; and the simulation view opens with a chase camera behind the aircraft. Returning to the map reverses the sequence, landing the strategic camera above the flight's position. The whole transition lasts under two seconds. Both scenes stay resident: the strategic scene is light, and the simulation scene keeps streaming terrain around the active unit.

## Architecture Impact

- `src/render/strategic/`: base map, glyphs, overlays, label engine.
- `src/render/sim/`: local terrain LOD, vegetation, models, atmosphere, clouds, water.
- `src/render/common/`: camera-relative rendering, shared materials, transition controller.
- `src/worldgen/geography/`: feature extraction, producing named-feature records with geometry and importance.
- `src/worldgen/names/`: toponymy generator and route numbering.
- `src/worldgen/infrastructure/`: settlement extents, road hierarchy, railways.

Feature extraction, naming, and infrastructure stay headless in `worldgen`. Label placement and glyph instancing belong in `render/strategic`. The strategic graph remains the only interface between world data and campaign logic. Named features join it as attributes, so briefings and mission names can use them ("interdiction strike on the Kessar Pass Road").

## Revised Roadmap

The roadmap splits into a foundation and three tracks that can advance in parallel, joined by an integration milestone.

### Foundation

- **F1. Globe skeleton.** Cube-sphere, unsteered plates, uplift, biome coloring, debug orbit camera, parameter sliders. *(Old M1, unchanged.)*
- **F2. World data.** Erosion, rivers, climate, and biomes baked to maps and cached. *(Old M2 without terrain LOD rendering.)*

### Strategic Track

- **S1. Illustrated base map.** Exaggerated relief, hillshade, biome painting with pattern textures, coasts and water bands, camera with zoom floor and tilt, zoom bands.
- **S2. Geography and names.** Feature extraction, toponymy, mountain and forest glyphs, label engine with typography, placement, and collision.
- **S3. Reading the world.** Validity check, strategic graph, front generator, theater detection, casting, briefing text, and the strategic overlays for theaters, fronts, named corridors, sea lanes, and chokepoints. *(Old M4, now drawn on the map.)*
- **S4. Settlements and infrastructure.** Settlements with urban extents and city glyphs, road hierarchy with route names, railways, ports, airbases, and industry, with their symbols. *(Old M5, extended.)*

### Simulation Core Track

- **C1. Simulation core.** Worker-based simulation, event scheduler, fixed ticks, time acceleration. *(Old M6.)*
- **C2. Air tasking and mission search.** Rule-based ATO for both sides, mission model, flights, search panel with subscriptions, and flight icons and routes on the map. *(Old M7, minus the chase camera.)*
- **C3. Ground and naval aggregates.** Battalions and aggregate combat along fronts, convoys and naval groups, all shown as map symbols. *(Old M8.)*

### Flight View Track

- **V1. Local terrain.** Quadtree LOD within the horizon, 0 to 20 km altitude, faceted flat-shaded terrain, high-resolution regional bakes, observer camera. *(Rendering part of old M2.)*
- **V2. Atmosphere and nature.** Sky, aerial perspective, ocean, clouds, and the tree kit. *(Old M3.)*
- **V3. Models and bases.** Procedural model builders from JSON specs, the model viewer page, settlements, and the base kit in the simulation view.
- **V4. Transition and chase camera.** Follow a flight from mission search into the simulation view and back.

### Integration

- **I1. Polish.** Acceptance checks for both views, performance pass, side selection at campaign start, generation caching, and a short flythrough.

### Dependencies and Suggested Order

S1 and V1 both depend on F2. S3 depends on S2 for named corridors. V3 depends on S4 for settlement and base data. C2 depends on C1 and S4. V4 depends on C2 and V2.

Suggested order: F1, F2, S1, V1, S2, V2, S3, C1, S4, V3, C2, V4, C3, I1. Alternating between the map and the flight view keeps both looking good as the project grows, and each milestone produces something visible.

### Mapping from the Old Milestones

| Old | New |
|---|---|
| M1 Globe skeleton | F1 |
| M2 Erosion, rivers, LOD | F2 (data), V1 (rendering) |
| M3 Atmosphere, ocean, forests | V2 |
| M4 Reading the world | S3 |
| M5 Settlements, roads, ports, airbases | S4 (data and map), V3 (simulation view) |
| M6 Simulation core | C1 |
| M7 Air tasking and mission search | C2, V4 |
| M8 Ground and naval aggregates | C3 |
| M9 Polish | I1 |
| (new) | S1, S2 |

## Changes to Existing Documents

**`docs/design.md`**

- *Vision* and *Architecture:* describe the two views and the transition.
- *Demo Goals:* replace "render from orbit to 500 m" with two goals, an illustrated strategic map down to its zoom floor and a simulation view from 0 to 20 km. Add a goal for named geography and labels.
- *World Generation Pipeline:* add stages for feature extraction, naming, and infrastructure hierarchy.
- *Rendering:* split into a short pointer to each view's specification.
- *Milestones:* replace with the revised roadmap above.

**`docs/visual-style.md`**

- Restructure into *Part I: Simulation View* (the current content, minus orbit-level material) and *Part II: Strategic View* (the strategic sections of this proposal, with palette and typography details).
- Move the orbit acceptance check to Part II and add strategic acceptance checks:
  1. A screenshot at each zoom band with no overlapping labels.
  2. A legibility test: a new viewer finds the front line, the three largest mountain ranges, and the capital of each side within ten seconds.
  3. Faction colors and overlays distinguishable under common color-vision deficiencies.
  4. Glyphs, patterns, and text sharp at the zoom floor on a 1080p display.
- Add Civilization VI screenshots and Cold War operational maps to the private reference board.

## Open Questions

- **Zoom floor.** Is about 100 km altitude close enough, or should the floor go lower at the cost of more glyph and pattern detail?
- **Vertical exaggeration.** A fixed 4×, or an exaggeration that increases as the camera pulls out?
- **Naming flavor.** How many cultural naming regions per world, and should they follow faction territory or landmasses?
- **Language of labels.** Should Pact-side names appear in a transliterated style, with an optional Cyrillic-like display font as flavor?
- **Strategic animation.** How much motion belongs on the map: moving flight icons only, or also animated front pushes, smoke over battles, and convoy wakes?