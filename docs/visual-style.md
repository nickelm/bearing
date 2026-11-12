# Bearing: Visual Style Guide

*Revision 3, 2026-11-11. Companion to `docs/design.md`. Revision 3 adds the controlled aircraft, the HUD and displays, and their acceptance checks for third-person flight without cockpits (Proposal 0002, decision 94); revision 2 split the guide into two parts for the two views (Proposal 0001, decision 72).*

## Summary

Bearing shows one world in two views, each with its own visual language.

- **Part I, the simulation view** (ground to about 20 km), renders a faceted, low-poly world under soft, cinematic light. Hard geometry meets soft air: aircraft, trees, buildings, and terrain are built from a small number of flat-shaded polygons with solid colors, while the atmosphere, clouds, haze, and light are smooth, warm, and painterly. The contrast between the two carries the style. The world should read like a sturdy, slightly toy-like model railway layout, photographed at golden hour.
- **Part II, the strategic view** (full globe down to a zoom floor of about 100 km), is an illustrated map in the spirit of Civilization VI and Cold War operational maps. It caricatures the world to convey strategic information: exaggerated relief, painted biomes with patterns, low-poly glyphs, a road hierarchy, and hierarchical labels, with day, night, and weather shown in stylized form.

The two parts share the faction colors and the UI panels, and nothing else is assumed to carry over from one to the other.

# Part I: Simulation View

Everything in Part I applies to the simulation view: chase, target, weapon, flyby, and observer cameras from the ground to about 20 km altitude, with terrain drawn only within the horizon (about 200 km at 20 km). Nothing in it is tuned for orbit; the globe belongs to Part II. Bearing has no cockpits: the player sees their aircraft from outside, with the HUD and displays as 2D overlays (see *HUD and Displays*).

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

The aircraft the player controls or follows uses a higher detail level of 1,500 to 4,000 triangles, still flat-shaded (see *The Controlled Aircraft*). Everything else stays within these budgets.

### Aircraft

- **Construction.** Fuselages are lofts of 6- to 8-sided cross-sections; wings and tails are extruded planforms with a slight thickness and a sharp leading edge. Canopies are separate faceted pieces with a dark, glossy material.
- **Recognition.** Aircraft are fictional analogues, so their proportions carry their identity: the F-111 analogue's swept wings and side-by-side canopy, the A-6 analogue's bulbous nose, the F-117 analogue's black facets. Exaggerate the features that distinguish types.
- **Camouflage.** Large flat color patches assigned per face, following a few faction schemes (see *Palette*). No gradients within a face.
- **Markings.** Fictional national insignia, modex numbers, and squadron codes as simple geometric decals or painted faces. Large numbers on carrier islands and tails are welcome (reference 1).
- **Emissives.** Afterburners glow in a warm core with bloom. Navigation lights (red port, green starboard, white tail) and anti-collision beacons blink at night.

### The Controlled Aircraft

The aircraft the player controls or follows fills the center of the screen for entire missions, so it is the most-viewed asset in the game.

- **Detail level.** 1,500 to 4,000 triangles, still flat-shaded, with the same construction, camouflage, and markings as the standard level. Other aircraft keep the budgets above.
- **Animated parts.** Ailerons, elevators or stabilators, rudders, flaps, slats, airbrakes, and speedbrakes respond to control inputs. Swing wings (the F-111, F-14, Tornado, Su-24, MiG-23, and Tu-22M analogues) animate with speed. Afterburner nozzles open and glow. Helicopter rotors blur into discs.
- **Stores.** Weapons hang visibly on pylons and disappear as they are released. Fuel tanks can be jettisoned.
- **No landing gear animation.** Takeoff and landing stay with the AI, so gear only needs to exist on parked and AI-controlled aircraft.
- **Effects.** Vapor and wingtip vortices at high G, contrails at altitude, heat shimmer behind engines, dust and spray at very low level, rotor wash for helicopters, and smoke, fire, and missing parts for damage.
- **Shadow.** The aircraft's shadow on terrain is a key height cue at low level and must stay visible down to the ground.
- **Crew figures.** The blocky crew figures stay visible through canopies.
- **Model specification.** The aircraft spec adds hinge axes for control surfaces, pivots for swing wings, store stations, nozzles, light positions, crew figure positions, and the camera rig offsets.

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

## HUD and Displays

With no cockpits, the HUD and the cockpit displays draw as 2D elements over the chase view (decision 94). They show only what the aircraft and its crew know.

### Two Kinds of Symbols

The chase camera sits behind and above the aircraft, so HUD symbols cannot sit at fixed screen positions as on a real HUD.

- **World-anchored symbols** are projected from the 3D scene every frame: the flight path marker (from the velocity vector, projected at a great distance so the camera offset causes no parallax), the boresight cross, the gun pipper (at the predicted impact point), CCIP bomb fall lines, target boxes, waypoint and target diamonds, and missile seeker circles.
- **Screen-anchored instruments** sit at fixed positions around the aircraft: airspeed and altitude tapes, a heading tape, a compact attitude indicator, Mach, G, fuel, and the master caution.

A full pitch ladder is confusing when seen from outside the aircraft, so the compact attitude indicator replaces it.

### Displays

| Display | Contents | Notes |
|---|---|---|
| Radar | B-scope for fighter radars, PPI for maritime and AWACS radars, with mode, range scale, and contacts | Content depends on the aircraft's radar and its mode |
| Moving map | The strategic map, centered on the aircraft, with route, threats, and front | Drawn by the strategic renderer in a viewport, so both views share one cartographic language (Part II) |
| Threat warning | RWR display with threat symbols by bearing and type | |
| Stores | Weapons and pylons, selected weapon, quantities, chaff and flares | |
| Targeting sensor | FLIR or TV picture-in-picture from a targeting pod or gunner sight | Thermal post-process on a render target; only aircraft with such a sensor |
| Messages | AWACS, wingman, crew, and ground controller calls as text, later as voice | |
| Systems | Engines, fuel state, damage | Compact; expands on warnings |

### Layout and Style

- **Layout.** The aircraft sits slightly below screen center. Tapes flank it; the radar and moving map occupy the lower corners; the threat warning sits upper right; messages sit upper left; stores sit at bottom center. Each display can be collapsed, and a minimal mode shows only the world-anchored symbols and tapes.
- **HUD symbology.** A single color (green by default, amber as an option) with a thin dark halo, so it stays legible against bright sky, snow, and night. Exact values are tuned with the HUD (milestone P2).
- **Displays.** The dark translucent panels and monospaced type of *User Interface*, with phosphor-colored vector graphics for radar and RWR.
- **Implementation.** A Canvas 2D overlay at device pixel ratio for HUD symbols and vector displays, the strategic renderer in a viewport for the moving map, and render targets for targeting sensors.

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
7. HUD legible against bright sky, snow, and night.
8. The flight path marker and gun pipper stay accurate during hard maneuvers.
9. The aircraft stays readable and centered in a maximum-rate turn.
10. The camera never clips terrain during low-level flight through valleys.

Checks 1–5 are named views in `tools/render.preview.ts`; check 6 runs in the model viewer. Checks 7–10 are scripted flight sequences in `tools/render.preview.ts` and apply from milestone V4 (camera rig and flight path marker); check 9 needs the flight model (P1), and the gun pipper part of check 8 needs guns (P4).

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
- **Tilt.** Straight down at globe scale, pitching smoothly to about 50° at the floor, so relief and glyphs read in perspective up close. Tilt follows the altitude and is never set by hand; the player pans, zooms, and turns the heading (decision 75).
- **Zoom bands.** Content appears and disappears by band, with short fades (about a third of a second). The band changes only once the altitude clears an edge by 8%, so a view resting on an edge does not flicker (decision 76).

| Band | Altitude | Content |
|---|---|---|
| Globe | above 1,500 km | Continents, oceans, theater names, territory tint, front lines, terminator and weather |
| Theater | 400–1,500 km | Mountain ranges, deserts, major forests, major rivers, capitals and cities, motorways, sea lanes, chokepoints, airbases as icons |
| Region | below 400 km | Peaks with elevations, all towns, all roads with route numbers and names, railways, minor rivers, bridges, ports, industry, air defense sites, unit symbols |

## Base Map

- **Relief.** A cube-sphere mesh displaced from the world's heights with 4× vertical exaggeration (tunable), and a moderate quadtree so the floor stays sharp: the terrain tiles capped at level 6, vertices about 380 m apart (decision 77).
- **Hillshade.** A fixed light from the upper left of the screen, following cartographic convention, plus soft ambient light. The relief light never moves with the sun, so ranges always read the same way. It stands low, 20° above the local ground, at every point of the globe, and shading is relative to flat ground at twice the plain strength, so flat land keeps its palette color everywhere and slopes brighten or darken strongly (decisions 78, 79).
- **Biome painting.** A softened, illustrative version of the biome palette (see *Strategic Palette*), with a procedural pattern per biome generated in the shader:
  - stippled canopy for forests;
  - dune ripples for sand deserts;
  - a faint field grid for farmland;
  - tussocks for tundra;
  - reed marks for wetlands;
  - cracked-ice lines for ice caps;
  - rock hatching on steep slopes.
  Biome boundaries blend over a few kilometers. Pattern scale is screen-stable, so a pattern looks the same at every zoom within a band: patterns are anchored to the ground, and each point picks its period from its pixel footprint, crossfading between powers of two. Farmland lies on settled land (the strategic graph's habitability) in open lowland biomes, outside forests; its field grid shows from the Theater band down (decision 80). Dune ripples mark hot (sand) deserts only, not cold deserts. Reed marks wait for data that marks wetlands, since the world has no wetland biome yet (decision 81).
- **Coasts and water.** Water gets depth tints in a few flat bands, a lighter halo along coasts, and the faint parallel coastal lines of old printed maps. The bands split at reference depths of 200 m (shelf) and 3,000 m (deep) (decision 82). Coastlines carry a thin dark outline, about 1.2 px wide. The halo fades out over the first 11 px from the coast, and three faint lines run 7, 14 and 22 px out, measured at the map scale of the screen center so they stay fixed to the ground while the view orbits (decisions 83, 85). Lakes and wide rivers use the same treatment; narrow rivers are blue lines whose width follows discharge, kept at least a pixel wide: 1 px at 25 m wide, a pixel more per fourfold width, at most 3.5 px. A river becomes water once its true width passes about 4 px. Rivers show from the Theater band down: rivers at least 60 m wide at Theater scale, at least 15 m wide in the Region band (decision 84).
- **Graticule.** Optional latitude and longitude lines, and range rings around a selected base or aircraft. There is no hex grid: hexes imply movement rules, and the simulation has none. Lines are a pixel wide at a round spacing (30° down to 0.5°) about 120 px apart, the equator a little stronger; rings fall at multiples of a round distance (25 to 500 km) about 90 px apart, eight of them. Both are dark by day and light by night (decision 91).

## Day, Night, and Weather

Planning sorties needs night and weather, so the map always shows both (an owner amendment to Proposal 0001, decision 72). They are stylized, not physical.

- **Day and night.** The sun from the ephemeris draws a terminator across the map with a soft, warm twilight band. The night side darkens and shifts to a deep blue, but stays bright enough to read relief, coasts, and labels. Day fades into night across civil twilight (±6°), the night tint is a multiply by `#1B2A4A` scaled so its blue channel sits at 0.62 in sRGB, and the warm band peaks on the terminator over about ±4° (decision 87). Settlement, base, and industry lights glow on the night side, sized by population, as small warm points with a soft halo: a core from 0.9 px for villages to 3.5 px for the largest cities, a halo about four times wider, `#FFD27A`, blended additively (decision 88). Lights thin out with scale so they never merge into a glow: at the globe only towns of about 16,000 and up show, at the floor every village (decision 100).
- **Seasons.** The seasonal snow line, sea ice, and frozen lakes show in the base map, from the climate and the season as in the simulation view: snow on land below about 0 °C, sea ice below about −3 °C sea-level air temperature, lake ice below about −1.5 °C. Sea ice is `#E4ECF0`, a little bluer than the snow fill (decision 87).
- **Clouds and precipitation.** Cloud cover from the live weather field draws as soft, translucent white shapes, thick enough to see where a front lies, never so opaque that the map vanishes. Precipitation adds a faint hatching under the cloud. Clouds move with game time. A toggle can hide them for a clean map; they are on by default. The map draws them from the same baked cloud field as the simulation view, with crisp one-pixel edges at two cover levels, 28% above cover 0.5 and 45% above 0.75, and a thin slate outline at the outer edge (decisions 90, 102), with anti-diagonal hatching about 8 px apart under precipitating cloud; both darken with the night tint (decision 89).
- **No physical sky.** No atmosphere scattering, aerial perspective, or limb haze. A thin, pale rim around the globe is enough to separate it from the background.

## Geographic Glyphs

- **Mountains.** Low-poly peak glyphs (faceted pyramids with snow caps above the snow line), instanced along ridge lines detected from uplift and prominence. Glyph size scales with prominence, and spacing keeps ranges legible as chains. Hills get smaller, rounded mounds. Chains space glyphs about half a glyph's width apart along the ridge, zigzagging across it, and the higher parts of a range fill with smaller glyphs; peaks get their own glyph sized by prominence. A glyph is snow-capped where the annual mean temperature at its point is below freezing (decision 97).
- **Forests.** Pattern fill everywhere, plus sparse, oversized forest tokens (clumps of three to seven stylized trees, each token about 2 to 5 km across) in the Region band only. Individual trees never appear.
- **Other landforms.** Dune glyphs in sand deserts: crescents with their horns downwind.
- **Sizes and bands.** Glyphs have a Theater set and a Region set, each fading with its band. Theater mountains are 30–50 km across (peaks up to 60 km), Region mountains 10–17 km (peaks up to 22 km), wider than their spacing so chains overlap into massifs, so a glyph stays roughly the same size in pixels within its band (decision 97).
- **Shading and color.** Flat shading from face normals, lit from the screen's upper left like the hillshade, then the map's night tint and paper finish. Rock `#8C8379` with snow `#F1F3F2`, mounds `#A99B73`, trees `#4E6A48`, dunes `#D8BD8C` with a `#C4A473` slip face.

## Settlements and Infrastructure

- **Cities.** Each settlement's urban extent is a tinted fill. An oversized low-poly building cluster marks its center, with size and style set by class: village, town, city, capital. Capitals carry a star marker. The fill is `#CBB8A0` over the land fills and patterns, under snow, the hillshade, the territory tint and the night, from the Theater band down, with a crisp edge and a 1.3 px `#8E7A64` outline where its texels span several pixels; it comes from the graph's urban polygons rasterized at about 0.8 km, drawn 1.6 times their size and at least 1.6 texels (about 1.3 km) in radius, so towns read larger than life and villages show (decision 105). The glyphs are flat-shaded like the geographic glyphs: three gabled houses for a village, houses round a hall and a church tower for a town, blocks of mixed heights round two towers for a city, and the city's blocks round a domed seat of government for a capital. Walls are `#E9E1D2` with terracotta roofs `#A65E45` in villages and towns, `#E4DDD0` with slate roofs `#7D7A78` in cities and capitals. Cities (20 km across) and capitals (26 km) show from the Theater band; in the Region band villages are 2.6 km, towns 4.8 km, cities 8 km and capitals 10.5 km across. Each side's capital is its largest settlement; its star is 18 px, in the side's faction color, since finding each side's capital is part of reading the war (check 3) (decision 104).
- **Roads.** A road hierarchy (motorway, trunk, secondary) drawn as screen-space ribbons with a darker casing, colored and sized by class. Bridges are marked where roads cross rivers. In the Region band motorways are 3 px, trunk roads 2.3 px and secondary roads 1.4 px, with 0.8, 0.7 and 0.55 px casings; motorways also show from the Theater band at 1.5 px. Roads are smoothed through the coarse grid's cell centers and draped on the relief like the military lines, but below the glyphs, so a building cluster or a mountain covers the road it stands on. Bridge marks are two 13 px bars along the road, either side of it, `#2A2A2A` (rail bridges in the rail color). Route numbers ("M4", "R12") and the names of pass and coast roads run along the road in 10.5 px brown sans (decision 104).
- **Railways.** Thin dark lines with cross-ticks, linking major cities, ports, and industry, with rail yards marked. A 1.2 px line with 6 px ticks every 9 px, in the Region band.
- **Military and industrial sites.** Airbases as runway glyphs with icons, ports as pier glyphs, and factories, refineries, depots, and rail yards as distinct symbols. They double as strike targets in mission search. An airbase is a ring with its runway through it along the runway's heading, 13 px at the Theater band and 19 px in the Region band. Ports (a quay with three jetties), factories (a works with a chimney), power plants (a ring round a dot), refineries (two tanks and a flare stack), supply depots (a framed square), fuel depots (a tank) and rail yards (a frame with two tracks) are 16 px, facing the screen so the map's tilt does not squash them, in the Region band (decision 105). Sites take their holder's faction color with a pale casing; the railways' own yards are in the rail color. Symbols at a town stand on its edge, 1.5 built-up radii out and spread round it, so they do not cover its glyph or name (decision 104).

## Labels

- **Typography.** Cartographic conventions:
  - water features in blue italic;
  - landforms in brown, letter-spaced capitals;
  - settlements in dark type with a light halo, sized by class;
  - military features in faction colors.
  The faces, under the SIL Open Font License and bundled from npm: EB Garamond Medium Italic for water, and Fira Sans Medium (Semibold for cities and theater names) for landforms, settlements and theaters. Panels keep the Part I UI typeface.
  Sizes (CSS px): oceans 22, seas 17, bays, straits and lakes 14, rivers 13; continents 19 with wide letter spacing, ranges, deserts, forests and plateaus 13, hills, plains and wetlands 11, islands 12, peaks 11; capitals 15.5 in spaced Semibold capitals, cities 14, towns 12, villages 10.5; roads 10.5 in brown `#5A3E2B`; theater names 15. Every style has a halo (`#F4EFE4`, or a pale `#E6EFF2` thinner one for water) so text stays legible over glyphs and the night side (decision 98).
- **Placement.** Point labels for cities and peaks ("Mount Kessar 1,210 m", with the peak's true height), curved labels along polylines for rivers, ranges, and roads, and widely spaced area labels across deserts, forests, seas, and regions. Point labels try right, left, above and below their anchor; theater names sit centered on their anchor, or above or below the front or sea lane they name (decision 101); line labels sit at the middle of the visible stretch or at stations either side, never upside down and never bending more than about 30° between letters; area labels spread their letters along the feature's axis to fill about 60% of it, or sit level on the anchor where the axis is short or steep.
- **Band content.** Which labels show in which band, with the least importance each needs, is a table in `render/strategic/labels/labelModel.ts`: oceans, continents and theater names at the Globe band; seas, ranges, major deserts, forests, plateaus and rivers, straits, capitals, cities and the highest peaks at the Theater band; everything, down to hills, wetlands, towns, villages over 10,000 people and roads (route numbers, pass and coast road names), at the Region band (decisions 98, 104).
- **Collision.** A screen-space placement pass, run when the camera settles or changes band, ranks labels by importance and drops those that collide. Labels fade in and out rather than popping. Between passes, placed labels follow the camera with the placement they won.
- **Rendering.** Signed-distance-field text rendered by the WebGPU pipeline, so text stays sharp at any size: an atlas generated at load time from the font files (opentype.js), drawn as instanced screen-space quads by a TSL shader (decision 98). A single-channel field rounds the sharpest corners only at sizes far above the map's 10–22 px.

## Military Overlays

- Territory tint per faction: the faction colors at 22% over dry land, under rivers, weather and the night tint; neutral land `#8C8C8C` at 8%. The tint follows the territory that placed bases and towns, and its edge is as soft as the coarse grid; the front line over it is sharp (decision 101).
- The front line as a bold line with teeth on the attacker's side; defensive lines dashed. The front is 3 px `#2A2A2A` with a 1.5 px pale casing; teeth are 8 px wide and 6 px tall every 20 px, in the attacker's color. Defensive lines are 1.6 px with 14 px dashes.
- Invasion corridors as named arrows: a 4 px shaft and a 16 px arrowhead in the attacker's color, from the attacker's side across the front, named along the shaft in the attacker's color.
- Sea lanes as dashed routes with convoy icons; chokepoints marked. Lanes are 2 px with 12 px dashes in the color of the side that sails them; chokepoints are hollow `#2A2A2A` diamonds, larger for a chokepoint theater. Only the lanes and chokepoints in the cast's theaters show; convoy icons wait for convoys.
- Air defense coverage as faint rings.
- Formations as NATO-style unit symbols in faction colors; flights as small aircraft icons with heading and short trails; convoys and bases as simple vector icons.
- Mission routes as thin dashed lines on hover and selection.
- Every layer can be toggled.
- **Drawing.** Lines and marks are sized in screen pixels and draped on the relief, with a pale casing (`#F4EFE4`) under each. Dashes and teeth are fixed to the ground: their spacing is the pixel target at the screen center's scale, rounded to a power of two in meters, so they keep their size within a factor of two and never swim. Relief and glyphs never hide an overlay. Territory and front lines show at every band (with a sea-lane theater's own lane); defensive lines, corridors, other lanes and chokepoints from the Theater band down (decision 101).

## Strategic Palette

Starting values, tuned on the globe. Land colors are lighter, softer versions of Part I's terrain shades. The world's biomes map onto these rows: taiga takes the conifer fill, temperate and tropical seasonal forest the temperate-forest fill, temperate and tropical rainforest the rainforest fill, hot and cold deserts the desert fill, alpine terrain and displayed slopes steeper than about 31° to 45° the steep-rock fill, and ice sheets the snow fill. Shrubland, which has no row, takes the midpoint of grassland and savanna. Fills blend across biome boundaries over about 9 km (decision 79).

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
| Clouds | `#FFFFFF` at 25 to 45% opacity; precipitation hatching `#7C8FA6` |

### Factions on the Map

| Element | Alliance | Pact |
|---|---|---|
| Symbols, front teeth, labels | `#2F6FB5` | `#D0532B` |
| Territory tint | `#2F6FB5` at about 22% | `#D0532B` at about 22% |

Blue against orange-red stays distinct under protanopia, deuteranopia, and tritanopia; check every overlay against simulated color-vision deficiencies anyway (acceptance check 4). Neutral territory is `#8C8C8C`. The front line itself is `#2A2A2A`.

## Strategic Post-Processing

- A light vignette and a subtle, constant paper grain: corners darken by 20%, and each pixel varies by ±6%, fixed to the screen (decision 93). A thin pale rim (`#D9E4E8`, about 1.5 px) outlines the globe against the background `#1E2630` (decision 92).
- No bloom except a soft halo on night lights, no pixelation, and no physical tone curve per time of day. The map renders with no tone curve at all, so its colors reach the screen as the palette gives them (decision 99).

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