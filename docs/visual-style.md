# Bearing: Visual Style Guide

*Revision 1, 2026-11-10. Companion to `docs/design.md`.*

## Summary

Bearing renders a faceted, low-poly world under soft, cinematic light. Hard geometry meets soft air: aircraft, trees, buildings, and terrain are built from a small number of flat-shaded polygons with solid colors, while the atmosphere, clouds, haze, and light are smooth, warm, and painterly. The contrast between the two carries the style. The world should read like a sturdy, slightly toy-like model railway layout, photographed at golden hour.

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
- **Settlements.** Towns are grids of box buildings with pitched or flat roofs in a narrow palette of plaster and roof colors. Cities add a few taller blocks at the center. In the strategic view, towns are built-up patches in the terrain: blocks of the same roof and wall colors, with no building meshes (decision 71).

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

The table applies to the simulator's views. The strategic view (the globe) draws no individual trees: forests are dark canopy masses in the terrain shading at every distance, with a sharp edge on the forest density contour (decision 71).

## Water

- **Ocean.** Calm, deep-colored water with faint, large facets from a low-frequency normal pattern (reference 1). Color shifts from deep blue-green offshore to teal in shallows, with a pale foam line at the coast.
- **Reflections.** Fresnel blend toward the sky color, plus a stretched sun glint that forms a soft column at low sun angles. Planar or screen-space reflections are a later option; the sky blend carries most of the effect.
- **Rivers and lakes.** Same material, calmer, with stronger sky reflection.

## Sky, Atmosphere, and Clouds

- **Aerial perspective.** The single most important effect for scale. Distant terrain fades toward the horizon color of the sky, with a slight violet cast at dusk (references 2 and 5). Tune haze so ridges 30 to 60 km away read as layered silhouettes.
- **Sky gradient.** A physically motivated single-scattering sky, then color-graded toward warm, painterly tones.
- **Time of day.** Full day-night cycle. Golden hour and dusk are the showcase; midday uses a pale, slightly hazy sky (reference 3); night relies on emissive lights, moonlight, and a dark blue ambient.
- **Clouds.** Soft, volumetric-looking cumulus and stratus layers that contrast with the hard geometry (references 2 and 4). Start with a raymarched 2.5D cloud layer at quarter resolution, driven by the moisture map and a weather noise field. Clouds catch warm light on top and stay cool and gray underneath.

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
- **Map symbology.** NATO-style unit symbols for formations, with faction colors and simple vector icons for flights, convoys, and bases. Mission routes as thin dashed lines.
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

Before a visual milestone closes, capture these views and compare them with the reference board:

1. Orbit view at golden hour, showing a terminator and limb glow.
2. 5 km altitude over a mixed landscape of forest, farmland, a river, and a town.
3. 500 m altitude over conifer forest with a forest edge and a road.
4. A mountain range at low sun, with faceted rock faces and layered haze.
5. An airbase at dusk with lit runway and parked aircraft.
6. Coastline with shallow water, a beach, and sun glint.
7. Silhouette test: every aircraft model rendered solid black against a pale sky, where each type must be identifiable.