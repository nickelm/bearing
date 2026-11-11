# Bearing: Visual Style Guide

*Revision 2, 2026-11-11. Companion to `docs/design.md`. Revision 2 splits the guide into two parts for the two views (Proposal 0001, decision 72).*

## Summary

Bearing shows one world in two views, each with its own visual language.

- **Part I, the simulation view** (ground to about 20 km), renders a faceted, low-poly world under soft, cinematic light. Hard geometry meets soft air: aircraft, trees, buildings, and terrain are built from a small number of flat-shaded polygons with solid colors, while the atmosphere, clouds, haze, and light are smooth, warm, and painterly. The contrast between the two carries the style. The world should read like a sturdy, slightly toy-like model railway layout, photographed at golden hour.
- **Part II, the strategic view** (full globe down to a zoom floor of about 100 km), is an illustrated map in the spirit of Civilization VI and Cold War operational maps. It caricatures the world to convey strategic information: exaggerated relief, painted biomes with patterns, low-poly glyphs, a road hierarchy, and hierarchical labels, with day, night, and weather shown in stylized form.

The two parts share the faction colors and the UI panels, and nothing else is assumed to carry over from one to the other.

# Part I: Simulation View

Everything in Part I applies to the simulation view: chase, cockpit, and observer cameras from the ground to about 20 km altitude, with terrain drawn only within the horizon (about 200 km at 20 km). Nothing in it is tuned for orbit; the globe belongs to Part II.

## Principles

1. **Hard geometry, soft air.** Geometry is faceted and flat-shaded; atmosphere, clouds, and light are soft and continuous.
2. **Silhouette first.** Every model must be identifiable from its outline alone. A player should tell a fighter from a strike aircraft, and a conifer from a broadleaf, at a glance and at a distance.
3. **Color by face, not by texture.** Models carry color in vertex colors or a small palette texture. We use no photographic textures and no normal maps on models.
4. **Sturdy and slightly cartoony.** Proportions are chunky: thick trunks, broad canopies, wide stances, blocky people. Nothing is spindly. Thin features that would alias or flicker get thickened or removed.
5. **Light does the drama.** Scenes look best at low sun angles. Haze, bloom on emissive lights, and long shadows give scale and mood without adding polygons.
6. **Readable at working distance.** The style must hold at 500 m altitude and 900 km/h, which is where players spend their time. Detail that only reads at 10 m gets cut.

## Reference Board

Five screenshots supplied on 2026-11-10 define the target. Store them in `docs/style/references/` as an internal mood board; they come from another project and must never ship with the game or appear on the public site.

1. **Carrier at sunset.** A carrier deck in near-silhouette against an orange sky, warm deck lights, a fighter launching. The sun's reflection forms a soft column on calm, faintly faceted water. The far shore dissolves into haze. *Takeaways:* silhouettes against a bright sky, small emissive points, strong aerial perspective.
2. **Fighter over a river valley.** A dark, flat-shaded fighter with glowing afterburners banks over forested hills, meandering rivers, a patchwork of fields, and a town of simple box buildings. Distant ridges fade to pale violet. *Takeaways:* terrain readability from altitude, patchwork farmland, forests as dark masses with crisp edges, rivers as bright ribbons.
3. **Hangar apron in the desert.** Faceted desert mountains with clearly visible triangles, a large flat-shaded hangar, parked aircraft in camouflage, and blocky crew figures with simple faces and helmets. *Takeaways:* terrain facets read as a deliberate style, people as toy-like figures, camouflage as large flat color patches.
4. **Aerial refueling.** A tanker and receivers above a cloud layer. *Takeaways:* clouds soft and volumetric beneath hard-edged aircraft.
5. **Airbase overview.** A woodland airbase at dusk: hangars, tower, radar on a lattice mast, aircraft on the apron, and dense blocky conifers framing the field. A translucent dark panel lists available aircraft in a monospaced typeface; the screen is letterboxed. *Takeaways:* tree style, base layout, UI tone, cinematic framing.

Across all five, edges show slight stair-stepping and the image has faint grain, which suggests a reduced internal resolution or a pixelation pass. We treat this as an optional effect (see *Post-Processing*).

## Rendering Model

- **Flat shading.** All models and terrain use per-face normals. In Three.js, `MeshStandardNodeMaterial` with `flatShading: true` derives normals from screen-space derivatives, so terrain chunks need no special geometry.
- **Color source.** Models use vertex colors (`vertexColors: true`). Terrain colors come from the biome maps, quantized to a small number of shades per biome so adjacent faces read as distinct facets.
- **Materials.** Mostly rough, non-metallic surfaces (roughness 0.8 to 1.0). Canopies, water, and wet surfaces get lower roughness for specular highlights. Bare-metal bombers get a modest metalness.
- **Lighting.** One directional sun plus hemispheric sky light, with the sky light's colors taken from the current sky gradient so shadows pick up the sky's tint. Shadows use cascaded shadow maps within a few kilometers of the camera; beyond that, the haze hides their absence.
- **Ambient occlusion.** Bake per-vertex AO into model vertex colors at build time. Screen-space AO is optional and off by default.
- **No outlines.** The references use no ink lines or cel shading, and neither do we.

## Terrain

- **Facets by design.** Flat shading makes the LOD mesh's triangles visible. At low altitude, target facets of roughly 20 to 60 m, so mountains look carved (reference 3). With distance, facets shrink below a pixel and the haze takes over, so terrain smooths out naturally.
- **Shade quantization.** Each biome has three to five shades. The shader picks a shade from slope, altitude, moisture, and a low-frequency noise term, then holds it constant per face. This produces the mottled, painted look of reference 2 without textures.
- **Rock and snow.** Steep faces switch to rock shades; high faces switch to snow. Transitions follow face boundaries rather than blending smoothly.
- **Farmland.** Near settlements and on flat lowland, a Voronoi field pattern assigns each cell a crop color (wheat, green crop, fallow, pasture). Field cells are a few hundred meters across with slight color variation.
- **Rivers.** Rivers render as bright ribbons that mirror the sky color, with a narrow darker bank. They should be the most visible terrain feature from altitude, since they matter tactically.
- **Roads.** Thin, muted gray-brown lines from vector data, visible below about 3 km altitude.
- **Settlements.** Towns are grids of box buildings with pitched or flat roofs in a narrow palette of plaster and roof colors. Cities add a few taller blocks at the center. Beyond building range, towns are built-up patches in the terrain: blocks of the same roof and wall colors, with no building meshes (decision 71). The strategic view draws settlements its own way (Part II).

## Vegetation

Trees are the defining element of the landscape and deserve the most care. They are blocky, sturdy, and slightly cartoony.

### Tree Kit

| Type | Biomes | Construction | Triangles |
|---|---|---|---|
| Conifer | Taiga, temperate, mountains | Two or three stacked 5- or 6-sided pyramids on a short, thick trunk | 30–60 |
| Broadleaf | Temperate, savanna edges | One to three chunky low-poly blobs (beveled box or coarse icosphere) on a thick trunk | 40–80 |
| Birch / poplar | Temperate, river banks | Tall narrow faceted column, pale trunk | 20–40 |
| Palm | Tropical coasts | Short segmented trunk, four to six flat blade fronds | 30–50 |
| Acacia | Savanna | Flat, wide, faceted canopy disc on a forked trunk | 30–50 |
| Shrub | All | Single low faceted blob | 12–24 |
| Dead / burnt | Battle damage, tundra | Trunk with two or three angular branches | 12–30 |

### Proportions and Variation

- **Sturdy proportions.** Canopy width at least half the tree's height; trunk width at least a tenth. No thin branches.
- **Variation per instance.** Random scale (0.8 to 1.3), yaw, a small tilt (under 4°), and a hue and value shift within the biome's canopy shades. Shift value more than hue: dark and light greens side by side read better than green and yellow.
- **Placement.** Trees grow in clusters with clear forest edges, as in references 2 and 5. Forest boundaries follow the density map with a sharp threshold, and a thin band of scattered trees and shrubs softens the edge.

### Level of Detail

| Distance from camera | Representation |
|---|---|
| 0–1.5 km | Individual instanced meshes, casting shadows |
| 1.5–5 km | Merged cluster meshes (groups of 10 to 30 trees as one mesh), no shadows |
| Beyond 5 km | Terrain color only, darkened under forest, with a slight canopy height offset in the shading |

The transition at 5 km must be hidden by haze and by matching the cluster colors to the terrain's forest shade.

Beyond 5 km, forests are dark canopy masses in the terrain shading with a sharp edge on the forest density contour (decision 71). The strategic view draws no individual trees at all (Part II).

## Water

- **Ocean.** Calm, deep-colored water with faint, large facets from a low-frequency normal pattern (reference 1). Color shifts from deep blue-green offshore to teal in shallows, with a pale foam line at the coast.
- **Reflections.** Fresnel blend toward the sky color, plus a stretched sun glint that forms a soft column at low sun angles. Planar or screen-space reflections are a later option; the sky blend carries most of the effect.
- **Rivers and lakes.** Same material, calmer, with stronger sky reflection.

## Sky, Atmosphere, and Clouds

- **Aerial perspective.** The single most important effect for scale. Distant terrain fades toward the horizon color of the sky, with a slight violet cast at dusk (references 2 and 5). Tune haze so ridges 30 to 60 km away read as layered silhouettes.
- **Sky gradient.** A physically motivated single-scattering sky, then color-graded toward warm, painterly tones.
- **Time of day.** Full day-night cycle. Golden hour and dusk are the showcase; midday uses a pale, slightly hazy sky (reference 3); night relies on emissive lights, moonlight, and a dark blue ambient.
- **Clouds.** Soft, volumetric-looking cumulus and stratus layers that contrast with the hard geometry (references 2 and 4). Start with a raymarched 2.5D cloud layer at quarter resolution, driven by the live weather field (cover, cloud base, precipitation) with finer detail noise inside each weather cell. Clouds catch warm light on top and stay cool and gray underneath.

## Models

### Polygon Budgets

| Model | Triangles |
|---|---|
| Fighter, strike aircraft | 300–800 |
| Bomber, tanker, transport, AWACS | 600–1,500 |
| Helicopter | 300–800, plus a translucent rotor disc when spinning |
| Tank, IFV, SAM vehicle | 150–400 |
| Truck, light vehicle | 80–200 |
| Person | 60–150 |
| Building | 12–200 |
| Carrier | 2,000–5,000 including deck details |
| Other ships | 400–2,000 |

The player's own aircraft in a future cockpit view may exceed these budgets. Everything else stays within them.

### Aircraft

- **Construction.** Fuselages are lofts of 6- to 8-sided cross-sections; wings and tails are extruded planforms with a slight thickness and a sharp leading edge. Canopies are separate faceted pieces with a dark, glossy material.
- **Recognition.** Aircraft are fictional analogues, so their proportions carry their identity: the F-111 analogue's swept wings and side-by-side canopy, the A-6 analogue's bulbous nose, the F-117 analogue's black facets. Exaggerate the features that distinguish types.
- **Camouflage.** Large flat color patches assigned per face, following a few faction schemes (see *Palette*). No gradients within a face.
- **Markings.** Fictional national insignia, modex numbers, and squadron codes as simple geometric decals or painted faces. Large numbers on carrier islands and tails are welcome (reference 1).
- **Emissives.** Afterburners glow in a warm core with bloom. Navigation lights (red port, green starboard, white tail) and anti-collision beacons blink at night.

### Ground Vehicles and People

- **Vehicles.** Boxy hulls, simple turrets, and chunky wheels or track blocks. Faction camouflage in two or three flat colors.
- **People.** Toy-like figures (reference 3): box torso, block head with a few painted face details, helmets and flight suits as simple shapes. Deck crews wear color-coded jerseys. People appear only at close range: on airbases, carrier decks, and in cinematic views.

### Buildings and Bases

- **Base kit.** Hangars, hardened aircraft shelters, control towers, radar towers on lattice masts, radar domes, fuel tanks, revetments, and taxiway and runway markings.
- **Style.** Plain boxes and arched shells in pale concrete and muted paint, with large openings that create deep shadow (references 3 and 5).
- **Night.** Runway edge lights, apron floodlights, and tower windows as emissive points.

### Procedural Model Builders

Aircraft, vehicles, ships, buildings, and trees should be generated in code from small JSON specifications rather than modeled by hand. A fuselage spec lists cross-sections along its length; a wing spec lists its planform, sweep, and dihedral; a camouflage spec maps colors to face groups. This approach suits the low-poly style, keeps assets reviewable as text, lets Claude Code author and adjust models, and makes new fictional types cheap to add. A small model viewer page in the debug UI should render any spec with turntable and lighting controls.

## Palette

Starting values; final values get tuned in the model viewer and on the globe.

### Terrain and Water

| Element | Shades |
|---|---|
| Deep ocean | `#1E3A4C` |
| Shallow water | `#2F6B73` |
| Beach and sand | `#C9B48A`, `#B9A276` |
| Grassland | `#7A8C4A`, `#6B7C40`, `#8A9A55` |
| Farmland | `#C8A85A` (wheat), `#6E8B3D` (green crop), `#8A6A45` (fallow), `#7F944F` (pasture) |
| Temperate forest | `#2F4A2A`, `#3B5A33`, `#466B3B` |
| Conifer forest | `#24382A`, `#2C4434`, `#35503C` |
| Rainforest | `#2E5A2E`, `#3A6B35` |
| Savanna | `#A89A5A`, `#97894E` |
| Desert | `#C49A6C`, `#B07F55`, `#D2AE80` |
| Tundra | `#8C8A6E`, `#7A7860` |
| Rock | `#6E665E`, `#857B70`, `#5C554F` |
| Snow | `#E8ECEF`, `#D5DCE2` |
| Roads | `#7A7062` |
| Settlements | `#C9BFAF`, `#B5A898` (walls), `#8E5A48`, `#5E5E62` (roofs) |

### Factions

| Scheme | Colors | Use |
|---|---|---|
| Alliance air superiority | `#8A9199`, `#6F7780` | Fighters |
| Alliance woodland | `#3E4A36`, `#2E3328`, `#55594F` | Strike, CAS, ground vehicles |
| Alliance naval | `#B4B7B8` over `#E6E6E2` | Carrier aircraft |
| Alliance stealth | `#1C1D20`, `#26282C` | F-117 analogue |
| Pact air superiority | `#7F8C96`, `#A3B1B9` | Fighters |
| Pact tactical | `#8B7350`, `#5E6B45`, `#A39070` | Strike, CAS, ground vehicles |
| Pact bomber | `#A7ABAE` | Bare-metal bombers |

### Light and Emissives

| Element | Color |
|---|---|
| Golden-hour sun | `#FF9A4D` |
| Dusk sky, horizon to zenith | `#F6B07A` to `#7C6A8A` |
| Midday sky | `#C9D8E3` |
| Afterburner core | `#FFB347` |
| Runway and deck lights | `#FFD27A` |
| Navigation lights | `#FF3B30` (red), `#34C759` (green), `#FFFFFF` (white) |

## Post-Processing

- **Tone mapping.** AgX or ACES filmic, with exposure tied to time of day.
- **Color grading.** A lookup table per time-of-day band (dawn, day, golden hour, dusk, night), blended as the sun moves.
- **Bloom.** Thresholded so only the sun, emissive lights, afterburners, and bright sky glints bloom.
- **Film grain.** Faint, constant, and cheap.
- **Pixelation (optional).** Render at 50 to 75% internal resolution and upscale with nearest-neighbor sampling, optionally with ordered dithering on sky gradients. This reproduces the stair-stepped edges of the references and doubles as a performance setting for weaker devices. Default to 75% on desktop and offer a toggle.
- **Letterboxing.** Only in cinematic views: base arrivals, mission briefings, and replays.

## User Interface

- **Typeface.** A clean monospaced or pixel-style face under an open license (for example Share Tech Mono or JetBrains Mono for body text, with a pixel face for headings).
- **Panels.** Dark translucent backgrounds (`#000000` at 55 to 70% opacity), white text, amber (`#FFB347`) for highlights and selected items. Square corners, no drop shadows.
- **Map symbology.** See Part II, *Military Overlays*. The panels and typeface here serve both views.
- **Cinematic cards.** A short label line (base name, location) in the lower right, a status card (day, available aircraft) in the lower left, and an action hint at the bottom center (reference 5).

## Performance Budgets

Targets for a mid-range laptop in a desktop browser at 1080p:

- 60 fps at the default 75% internal resolution.
- Under 500 draw calls per frame, through instancing and merged cluster meshes.
- Under 2 million triangles per frame in the densest view (low altitude over forest near a base).
- Up to about 50,000 individual tree instances within 1.5 km.

## What to Avoid

- Smooth shading on models or close terrain.
- Photographic or noisy high-frequency textures.
- Saturated primary colors outside emissives and UI highlights.
- Ink outlines and cel-shading bands.
- Thin geometry such as antennas, pitot tubes, and fine branches that alias at distance; omit them or thicken them.
- Uniform scatter of identical trees; forests need clusters, edges, and value variation.
- Real national insignia, unit badges, or manufacturer markings.

## Acceptance Checks

Before a visual milestone with simulation-view work closes, capture these views and compare them with the reference board. The former orbit check moved to Part II.

1. 5 km altitude over a mixed landscape of forest, farmland, a river, and a town.
2. 500 m altitude over conifer forest with a forest edge and a road.
3. A mountain range at low sun, with faceted rock faces and layered haze.
4. An airbase at dusk with lit runway and parked aircraft.
5. Coastline with shallow water, a beach, and sun glint.
6. Silhouette test: every aircraft model rendered solid black against a pale sky, where each type must be identifiable.

Checks 1–5 are named views in `tools/render.preview.ts`; check 6 runs in the model viewer.

# Part II: Strategic View

The strategic view is where the player reads the war, finds missions, and follows events. It answers questions at a glance: where the front runs, which roads feed it, which mountains shield which bases, how far the bombers must fly. Photographic rendering hides these answers among detail; a map that abstracts, exaggerates, and labels shows them directly. Part I's facets, physical sky, aerial perspective, and post-processing chain do not apply here.

## Strategic Principles

1. **Abstract, exaggerate, label.** Show what a commander needs and drop what only reads up close. Relief, rivers, roads, and cities are drawn larger and clearer than life.
2. **Illustrated, not photographic.** Painted fills, procedural patterns, and low-poly glyphs. Glyphs are flat-shaded with solid colors, the same model language as Part I at map scale.
3. **Crisp at every zoom.** Patterns, glyphs, line widths, and text are sized in screen pixels within each zoom band, so nothing blurs or swims at the zoom floor.
4. **Time and weather are information.** Night and cloud decide which sorties fly, so the map always shows them, styled so that the geography beneath stays readable.
5. **Color carries meaning.** Faction colors are reserved for military information. Geography uses muted, natural tones.

## Reference Board (Strategic)

Civilization VI screenshots and Cold War operational maps (NATO planning maps, 1980s board wargames such as those behind *Red Storm Rising*) are to be added by the owner to `docs/style/references/`. Like the Part I board, they are local only and never ship (decision 70). Record each one's takeaways here once it is added.

## Camera and Zoom

- **Range.** From about 3,000 km altitude, where the full globe fills the screen, down to a floor of about 100 km, where the view spans roughly 200 km of ground. The floor is tuned so that glyphs, patterns, and labels stay sharp at the closest zoom.
- **Tilt.** Straight down at globe scale, pitching smoothly to about 50° at the floor, so relief and glyphs read in perspective up close.
- **Zoom bands.** Content appears and disappears by band, with short fades.

| Band | Altitude | Content |
|---|---|---|
| Globe | above 1,500 km | Continents, oceans, theater names, territory tint, front lines, terminator and weather |
| Theater | 400–1,500 km | Mountain ranges, deserts, major forests, major rivers, capitals and cities, sea lanes, chokepoints, airbases as icons |
| Region | below 400 km | Peaks with elevations, all towns, named roads, minor rivers, bridges, ports, industry, air defense sites, unit symbols |

## Base Map

- **Relief.** A cube-sphere mesh displaced from the world's heights with 4× vertical exaggeration (tunable), and a moderate quadtree so the floor stays sharp.
- **Hillshade.** A fixed light from the upper left of the screen, following cartographic convention, plus soft ambient light. The relief light never moves with the sun, so ranges always read the same way.
- **Biome painting.** A softened, illustrative version of the biome palette (see *Strategic Palette*), with a procedural pattern per biome generated in the shader:
  - stippled canopy for forests;
  - dune ripples for sand deserts;
  - a faint field grid for farmland;
  - tussocks for tundra;
  - reed marks for wetlands;
  - cracked-ice lines for ice caps;
  - rock hatching on steep slopes.
  Biome boundaries blend over a few kilometers. Pattern scale is screen-stable, so a pattern looks the same at every zoom within a band.
- **Coasts and water.** Water gets depth tints in a few flat bands, a lighter halo along coasts, and the faint parallel coastal lines of old printed maps. Coastlines carry a thin dark outline. Lakes and wide rivers use the same treatment; narrow rivers are blue lines whose width follows discharge, kept at least a pixel wide.
- **Graticule.** Optional latitude and longitude lines, and range rings around a selected base or aircraft. There is no hex grid: hexes imply movement rules, and the simulation has none.

## Day, Night, and Weather

Planning sorties needs night and weather, so the map always shows both (an owner amendment to Proposal 0001, decision 72). They are stylized, not physical.

- **Day and night.** The sun from the ephemeris draws a terminator across the map with a soft, warm twilight band. The night side darkens and shifts to a deep blue, but stays bright enough to read relief, coasts, and labels. Settlement, base, and industry lights glow on the night side, sized by population, as small warm points with a soft halo.
- **Seasons.** The seasonal snow line, sea ice, and frozen lakes show in the base map.
- **Clouds and precipitation.** Cloud cover from the live weather field draws as soft, translucent white shapes, thick enough to see where a front lies, never so opaque that the map vanishes. Precipitation adds a faint hatching under the cloud. Clouds move with game time. A toggle can hide them for a clean map; they are on by default.
- **No physical sky.** No atmosphere scattering, aerial perspective, or limb haze. A thin, pale rim around the globe is enough to separate it from the background.

## Geographic Glyphs

- **Mountains.** Low-poly peak glyphs (faceted pyramids with snow caps above the snow line), instanced along ridge lines detected from uplift and prominence. Glyph size scales with prominence, and spacing keeps ranges legible as chains. Hills get smaller, rounded mounds.
- **Forests.** Pattern fill everywhere, plus sparse, oversized forest tokens (clumps of three to seven stylized trees, each token about 2 to 5 km across) in the Region band only. Individual trees never appear.
- **Other landforms.** Dune glyphs in sand deserts.

## Settlements and Infrastructure

- **Cities.** Each settlement's urban extent is a tinted fill. An oversized low-poly building cluster marks its center, with size and style set by class: village, town, city, capital. Capitals carry a star marker.
- **Roads.** A road hierarchy (motorway, trunk, secondary) drawn as screen-space ribbons with a darker casing, colored and sized by class. Bridges are marked where roads cross rivers.
- **Railways.** Thin dark lines with cross-ticks, linking major cities, ports, and industry, with rail yards marked.
- **Military and industrial sites.** Airbases as runway glyphs with icons, ports as pier glyphs, and factories, refineries, depots, and rail yards as distinct symbols. They double as strike targets in mission search.

## Labels

- **Typography.** Cartographic conventions:
  - water features in blue italic;
  - landforms in brown, letter-spaced capitals;
  - settlements in dark type with a light halo, sized by class;
  - military features in faction colors.
  Candidate faces under open licenses: a humanist serif italic for water (for example EB Garamond), and a sans with small caps for landforms and settlements (for example Fira Sans or Source Sans 3). Panels keep the Part I UI typeface.
- **Placement.** Point labels for cities and peaks ("Mount Kessar 4,210 m"), curved labels along polylines for rivers, ranges, and roads, and widely spaced area labels across deserts, forests, seas, and regions.
- **Collision.** A screen-space placement pass, run when the camera settles or changes band, ranks labels by importance and drops those that collide. Labels fade in and out rather than popping.
- **Rendering.** MSDF text rendered by the WebGPU pipeline, so text stays sharp at any size. Check the library choice against three's current WebGPU support.

## Military Overlays

- Territory tint per faction.
- The front line as a bold line with teeth on the attacker's side; defensive lines dashed.
- Invasion corridors as named arrows.
- Sea lanes as dashed routes with convoy icons; chokepoints marked.
- Air defense coverage as faint rings.
- Formations as NATO-style unit symbols in faction colors; flights as small aircraft icons with heading and short trails; convoys and bases as simple vector icons.
- Mission routes as thin dashed lines on hover and selection.
- Every layer can be toggled.

## Strategic Palette

Starting values, tuned on the globe. Land colors are lighter, softer versions of Part I's terrain shades.

### Land and Water

| Element | Fill | Pattern or line |
|---|---|---|
| Grassland | `#A3AE78` | none |
| Farmland | `#C9B57A` | field grid `#B3A066` |
| Temperate forest | `#6E8A5A` | stipple `#556F45` |
| Conifer forest | `#5E7A5C` | stipple `#465F46` |
| Rainforest | `#5F8A55` | stipple `#4A7142` |
| Savanna | `#C2B57E` | none |
| Desert | `#DCC195` | dune ripples `#C9AA7A` |
| Tundra | `#B1AD94` | tussocks `#99957C` |
| Wetland | `#8FA083` | reeds `#6F8366` |
| Steep rock | `#9C948A` | hatching `#7E766D` |
| Snow and ice cap | `#F1F3F2` | cracks `#C9D3D8` |
| Urban extent | `#CBB8A0` | none |
| Shelf water | `#8DB5C4` | coastal lines `#A9C9D4` |
| Mid-depth water | `#6C97AC` | none |
| Deep water | `#4F7A93` | none |
| Coastal halo | `#B9D5DC` | coastline `#2F4756` |

### Lines, Labels, and Time

| Element | Color |
|---|---|
| Motorway | `#C0563A`, casing `#6A2E20` |
| Trunk road | `#D99A4E`, casing `#7A5428` |
| Secondary road | `#F2E6C8`, casing `#8A7B62` |
| Railway | `#3E3A36` |
| River | `#5D8FB0` |
| Water labels | `#2F5F86` |
| Landform labels | `#6B4A2E` |
| Settlement labels | `#22252A`, halo `#F4EFE4` |
| Night tint | `#1B2A4A`, as a multiply that keeps relief visible |
| Twilight band | `#E3A06A` |
| Night lights | `#FFD27A` |
| Clouds | `#FFFFFF` at 35 to 60% opacity; precipitation hatching `#7C8FA6` |

### Factions on the Map

| Element | Alliance | Pact |
|---|---|---|
| Symbols, front teeth, labels | `#2F6FB5` | `#D0532B` |
| Territory tint | `#2F6FB5` at about 15% | `#D0532B` at about 15% |

Blue against orange-red stays distinct under protanopia, deuteranopia, and tritanopia; check every overlay against simulated color-vision deficiencies anyway (acceptance check 4). Neutral territory is `#8C8C8C`. The front line itself is `#2A2A2A`.

## Strategic Post-Processing

- A light vignette and a subtle, constant paper grain.
- No bloom except a soft halo on night lights, no pixelation, and no physical tone curve per time of day.

## Strategic Performance

Targets for the same mid-range laptop at 1080p: 60 fps at every band, with glyphs instanced, under 300 draw calls, and the label placement pass within a few milliseconds when it runs.

## What to Avoid on the Map

- Photographic textures or physical haze that hides the map.
- Individual trees and buildings.
- A hex grid.
- Overlapping or popping labels.
- Faction colors on geography, and saturated fills outside the military overlays.
- Night or cloud so dark or opaque that relief, coasts, and labels disappear.

## Strategic Acceptance Checks

Before a visual milestone with strategic-view work closes, capture and check:

1. The Globe band with the terminator in view: a legible night side with settlement lights, weather clouds over the map, and readable theater names, territory tint, and front lines. This replaces the former orbit check.
2. A screenshot at each zoom band with no overlapping labels.
3. A legibility test: a new viewer finds the front line, the three largest mountain ranges, and the capital of each side within ten seconds.
4. Faction colors and overlays distinguishable under common color-vision deficiencies.
5. Glyphs, patterns, and text sharp at the zoom floor on a 1080p display.

Checks 1, 2, 4, and 5 are named views in `tools/render.preview.ts`; check 4 renders them through simulated color-vision deficiencies, and check 2 also asserts that the placement pass reports no overlaps. Check 3 needs a person: the owner, at the milestone checkpoint.