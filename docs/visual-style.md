# Bearing: Visual Style Guide

*Revision 6, 2026-11-17. Companion to `docs/design.md`. Revision 6 moves the terrain palette brighter and extends it to the twenty biomes and the surfaces of closed basins, volcanic rock and lagoons, adds zones with their own look, landform props and their budgets, salt lakes and playas, glaciers and fjords, gullies and natural wonders, with their checks in both parts (Proposal 0007, decision 204); revision 5 adds the displays and status strip: the allocation rule, slots, the display frame, faction skins and their palette tokens, the full-color moving map, and their acceptance checks (Proposal 0006, decision 189); revision 4 adds meanders and floodplains, roads and railways with their earthworks in the terrain, the bridge kit and its budgets, and bridge labels, dashed tunnels and generalized rivers on the map (Proposal 0005, decision 161); revision 3 adds the controlled aircraft, the HUD and displays, and their acceptance checks for third-person flight without cockpits (Proposal 0002, decision 94); revision 2 split the guide into two parts for the two views (Proposal 0001, decision 72).*

## Summary

Bearing shows one world in two views, each with its own visual language.

- **Part I, the simulation view** (ground to about 20 km), renders a faceted, low-poly world under soft, cinematic light. Hard geometry meets soft air: aircraft, trees, buildings, and terrain are built from a small number of flat-shaded polygons with solid colors, while the atmosphere, clouds, haze, and light are smooth, warm, and painterly. The contrast between the two carries the style. The world should read like a sturdy, slightly toy-like model railway layout, photographed at golden hour.
- **Part II, the strategic view** (full globe down to a zoom floor of about 100 km), is an illustrated map in the spirit of Civilization VI and Cold War operational maps. It caricatures the world to convey strategic information: exaggerated relief, painted biomes with patterns, low-poly glyphs, a road hierarchy, and hierarchical labels, with day, night, and weather shown in stylized form.

The two parts share the faction colors and the UI panels, and nothing else is assumed to carry over from one to the other.

# Part I: Simulation View

Everything in Part I applies to the simulation view: chase, target, weapon, flyby, and observer cameras from the ground to about 20 km altitude, with terrain drawn only within the horizon (about 200 km at 20 km, farther for peaks that rise above it). Nothing in it is tuned for orbit; the globe belongs to Part II. Bearing has no cockpits: the player sees their aircraft from outside, with the HUD, docked displays and status strip as 2D overlays (see *HUD and Displays* and *Displays and Status Strip*).

## Principles

1. **Hard geometry, soft air.** Geometry is faceted and flat-shaded; atmosphere, clouds, and light are soft and continuous.
2. **Silhouette first.** Every model must be identifiable from its outline alone. A player should tell a fighter from a strike aircraft, and a conifer from a broadleaf, at a glance and at a distance.
3. **Color by face, not by texture.** Models carry color in vertex colors or a small palette texture. We use no photographic textures and no normal maps on models.
4. **Sturdy and slightly cartoony.** Proportions are chunky: thick trunks, broad canopies, wide stances, blocky people. Nothing is spindly. Thin features that would alias or flicker get thickened or removed.
5. **Light does the drama.** Scenes look best at low sun angles. Haze, bloom on emissive lights, and long shadows give scale and mood without adding polygons.
6. **Readable at working distance.** The style must hold at 500 m altitude and 900 km/h, which is where players spend their time. Detail that only reads at 10 m gets cut, except the ground near a low camera, which serves helicopter flight: it shows height and drift below a few hundred meters and costs nothing above (decision 168).
7. **Every place has a look** (decision 204). A region should be recognizable within seconds of arriving by air: zones carry their own palette shift, haze, light, vegetation and landforms, and each world has a few memorable wonders. The palette leans brighter than the reference board's muted ground, and slightly outlandish scenery is welcome where it plausibly extends something on Earth.

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
- **Lighting.** One directional sun plus hemispheric sky light, with the sky light's colors taken from the current sky gradient so shadows pick up the sky's tint. Terrain casts shadows through a height-field shadow baked around the camera, with soft edges that widen with distance and reach of hundreds of kilometers at low sun (decision 139); trees, buildings and aircraft receive them and cast none yet. Shadows are deep and blue, never black: under a low sun, surfaces are exposed up to 1.7× over the sky so the ground stays readable under a bright dusk sky. Sunlit snow sparkles toward a low sun, and rain darkens the ground and leaves a sheen on pavement.
- **Ambient occlusion.** Bake per-vertex AO into model vertex colors at build time. Screen-space AO is optional and off by default.
- **Ink outlines on models, no cel shading.** Models (aircraft, vehicles, ships, buildings) carry a dark ink outline, `#1A1B1D` and about 1.5 to 2 px wide, around their silhouettes and where their parts meet, drawn by an inflated back-face hull. It is an owner's choice beyond the references, on by default and switchable in the GUI; terrain, trees and clouds stay unoutlined, and shading keeps its flat facets without cel bands (decision 107).

## Terrain

- **Facets by design.** Flat shading makes the LOD mesh's triangles visible. At low altitude, target facets of roughly 20 to 60 m, so mountains look carved (reference 3); the finest tile level gives 24 m. With distance the LOD coarsens the mesh at the rate it shrinks on screen, so facets stay about 20 to 40 px across while growing in meters; haze softens them toward the horizon (decision 123).
- **Shade quantization.** Each biome has three to five shades (four by default). The shader picks a shade from slope, altitude, moisture, and a low-frequency noise term, then holds it constant per face, with the whole land albedo evaluated at the face's center. This produces the mottled, painted look of reference 2 without textures (decision 124).
- **Rock and snow.** Steep faces switch to rock shades (three per face); cold faces switch to snow (two shades), which slides off faces steeper than about 30–45°, so high ranges show gray rock between snowfields. Transitions follow face boundaries rather than blending smoothly. Near the snow line, low-frequency noise and a per-face jitter make a patchy band hundreds of meters wide, each face all snow or all bare, and trees decide the same way at their own spot in the band (decisions 125, 126, 157).
- **Dry rock.** In horizontally layered sedimentary rock under a dry climate (red rock deserts above all), rock is layered: each 75 m stratum is a cliff in one of the sandstone shades over a foot of red shale, and the dry ground below the cliffs takes a red tint (decision 126). Rocky deserts and sand seas have no benches; their mountains are bare, faceted rock in the rocky desert's shades. Since decision 210 only layered sedimentary rock is terraced.
- **Rock by lithology.** Rock faces take their shades from the rock beneath: granite pale gray, schist darker and greenish, sandstone in the strata shades, limestone near white, basalt and volcanic ash near black (`#2E2B2B` to `#4A3F3A`), with black sand on volcanic coasts (decision 204).
- **Natural wonders** (decision 221). The tiles shape the war's wonders that a height field can hold, heightened from Earth: a tepui is a table some 6 km across, 900 m above the ground on sheer walls; a caldera is a rim 350 m high round a bowl holding a crater lake; a monolith is a dome 380 m high on near-vertical flanks over a plain; a blue hole is a round shaft 125 m deep in shallow sea. A wonder stands on the most even ground within 8 km of its place, and where none is even enough it stays unshaped rather than drawing walls. Falls, travertine terraces and mineral bands wait for river and color work, and the basalt causeway for its props; the karst bay and pillar forest are fields of props (decision 225).
- **Glaciers and fjords.** Glaciers fill the heads of high troughs in the glacier shades, below arêtes and cirques; troughs that reach the sea are fjords with steep walls and deep, dark water (decision 204).
- **Closed basins.** Salt lakes in brine colors, turquoise to pink with salinity, and playas as perfectly flat white crust (`#F1EEE6`, `#E6E1D3`), with pale rings of former shorelines on the slopes around them (decision 204).
- **Gullies.** Soft rock under a semi-arid climate is cut by dense gullies and badlands; gullies finer than the mesh are darker shade lines along the downslope direction, fading in below about 2 km (decision 204).
- **Water in motion.** River water on steep facets (falls and rapids) is drawn as white water rather than a reflecting surface (decision 126).
- **Silt.** Warm rivers' water is brown under its sky reflection (decision 126); cold and temperate rivers stay clear.
- **Shallows and reefs.** Water color counts the first few tens of meters of depth at Earth depth, so lagoons, reef flats, skerry sounds and lake margins read turquoise over sand and deeper water darkens as before; warm coasts carry reefs with a surf line on the crest (decision 129). Lakes keep a darker water color so shallow ones still read as water, and lakes in dry land are white salt pans (decision 130), which become the playas of closed basins (decision 204).
- **Coasts.** Headlands of coasts with relief end in cliffs, with rocks and stacks offshore; the coves between them hold sand beaches (`#C9B48A`) over a pale, shallow shelf. Glaciated coasts keep their bare-rock skerries, and islets raised from the sea are bare rock (decision 146).
- **Wetlands.** Flat, wet ground at a river's, a lake's or the sea's level is olive marsh (`#6B7A4E`) with dark pools drawn as water; warm, low coasts grow mangroves (decision 146).
- **Rivers run downhill.** A river's water surface never rises downstream, through canyons, confluences and falls alike (decision 146).
- **River banks and white water.** Bars of sand on lowland rivers and gravel on steep or glacial ones lie along the water, and a narrow darker band marks the bank where a river is drawn at its true width. Fast reaches foam along their banks and, on the steepest, across the channel; lakes have a faint foam line at the shore (decision 147).
- **Natural banks.** No river runs straight: every channel wanders a little and narrows and swells along its course, and its banks are ragged at a few widths and finer, from noise fixed to the ground. The detail shows where a river is drawn near its true width and gives way to a smooth line at a distance, so far rivers do not shimmer (decision 167). Trees grow to the drawn water's edge but never stand in it, and the woods along a river follow its moved banks (decision 177).
- **Meanders and floodplains.** Large lowland rivers wind across level floodplains in bends about 10–14 widths long, with oxbow lakes and abandoned channels left by cutoffs; mountain streams run nearly straight in their valleys. Oxbows and delta distributaries keep the river's darker bank (decisions 161, 173).
- **Farmland.** Near settlements and on flat lowland, a Voronoi field pattern assigns each cell a crop color (wheat, green crop, fallow, pasture). Field cells are a few hundred meters across with slight color variation. Fields lie where the strategic map puts its farmland (settled land in farmable biomes, decision 80), on flat lowland; each face takes the field at its center, so field edges follow facets, and distant fields draw toward their mean color (decision 127). Fields are cells of a Voronoi diagram on the sea-level sphere with an integer hash the CPU shares, so hedgerows follow their boundaries (decision 162).
- **Rivers.** Rivers render as bright ribbons that mirror the sky color, with a narrow darker bank. They should be the most visible terrain feature from altitude, since they matter tactically.
- **Roads and railways.** Thin, muted gray-brown lines from vector data, visible below about 3 km altitude, drawn in the terrain shader with no ribbon geometry. Closer in, roads are asphalt or gravel with shoulders, with center and edge lines below about 1 km, antialiased like the runway markings; railways are a ballast band with two rails below about 1 km (planned, track N6; today railways draw as plain strips and banks are unshaded). Embankments and cuttings are terrain shaped by analytic edits, their banks a little lighter (fill) or darker (cut) than the ground beside them, and mountain roads climb in switchbacks. Lowland roads wind gently, a few tens of meters at a few hundred meters' scale and a few hundred meters over several kilometers, and cross rivers squarely; motorways and railways keep long straights and wide curves (decision 190). Tunnels draw nothing between their portals, and bridges draw nothing on the ground (decision 161).
- **Ground detail near the ground.** Below a few hundred meters the ground gains detail in the same faceted, slightly cartoony style, never photographic (decision 168; `docs/plans/ground-detail.md`). Fine relief is stepped: virtual micro-facets about 0.5–4 m across by land cover, each with one normal and one shade, as a bump map that keeps the facet rule; they are costly near the ground and off by default, a graphics option in Free Flight (decision 197). Snow keeps its own normal and sparkle; wet ground, ice and smooth rock glint per micro-facet toward the sun (decision 169). Ground cover is fat and chunky: grass in tufts of a few wide, blunt blades with dark bases and light tips, sparse, muted flower tufts in meadows, tussocks, reed clumps and lumpy bushes, and hefty low-poly boulders of a dozen to forty faces; each takes its color from the ground under it. Cover sways with the gusts and flattens under a rotor's downwash. Dust, grit and spray kicked up from the ground are wispy and soft, like the rest of the air.
- **Settlements** (Proposal 0009, decisions 259–270). Settlements are planned: streets follow a tensor field of arterials, rings, coasts, rails and contours, with organic old cores in the cultures that have them; blocks are split into parcels with street frontage; each parcel holds one building by district and cultural style (Western red tile and slate, Eastern bloc gray concrete and microdistrict slabs, Mediterranean ochre and white stucco under flat and low roofs, Nordic wooden houses under steep dark roofs, Arid flat roofs and courtyards; American grids with a downtown of towers and suburbs on large lots; Southeast Asian pastel shophouses round a skyline, decision 292). Towers stand in business districts: a downtown at the center for American and Southeast Asian cities, a business district off the center, near a main road, for European ones (decision 292). Buildings are flat-shaded, vertex-colored and slightly chunky, with oversized eaves and chimneys, window bands in the wall shader within about 1.4 km, and plinths down to the lowest ground under them. Detail by distance: building kits within 0.6 km, boxes and roofs within 2 km, block prisms to 12 km, and beyond that only the ground's roof colors. The urban ground is drawn in the terrain: asphalt streets with pale sidewalks, paths and stairs, courtyards, gardens, parks, squares, parking, concrete, gravel and ballast from per-chunk feature fields; off the blocks the natural ground shows, and woods and parks inside a town keep their trees and canopy at every distance (decision 278). The war's targets at a town are particular complexes in it: works, power stations with cooling towers, refineries and fuel depots with tank farms, rail yards and depots (decision 279). Towns without a plan near the camera draw an interim street grid turned to their main road (decision 259): asphalt `#7A7062`, sidewalks `#B8B0A2`, squares `#C9BCA4`, parks `#6F8A4E`, lawns `#7E9456`, yards `#A69A80`, courtyards `#A89F8E`, parking `#8C877E`, concrete `#9A968E`, gravel `#8A8172`, ballast `#6E665C`. Landmarks (churches, town halls, TV and water towers, stadiums, monuments, stacks, cooling towers, cranes) stand out; stacks and cooling towers carry plumes of solid puffs that drift with the wind (*Effects*, decision 326). At night about a third of windows light up, scaled by each settlement's lighting level, and streetlights line the streets; from afar the blocks show their windows as scattered points of light and the main streets keep their lamps out to about 12 km (decision 293). The ground itself is not lit where no lamp stands: a planned town's soft glow on the terrain shows only beyond about 12 km, and the countryside's speckled village glow only from orbit, never in the simulation view (decisions 296, 299). Damaged buildings are blackened with broken roofs; rubble is a low mound. The strategic view draws settlements its own way (Part II).

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

The kit is built from model specs of class `tree` (decision 147): fir (tiered cones), pine (umbrella crown), oak (three lumpy masses), broadleaf, birch, poplar, acacia, shrub and dead tree, 20–70 triangles each, with far models of five of them (decision 150) and two bare winter models, a branching broadleaf and a birch (decision 153). Crowns are jittered icospheres, lumpy and faceted, and carry two or three of the canopy shades below, so value varies within a tree as well as between trees. A palm follows with the coast work.

### Proportions and Variation

- **Sturdy proportions.** Canopy width at least half the tree's height; trunk width at least a tenth. No thin branches.
- **Variation per instance.** Random scale (0.8 to 1.3), yaw, a small tilt (under 4°), and a hue and value shift within the biome's canopy shades. Shift value more than hue: dark and light greens side by side read better than green and yellow.
- **Placement.** Trees grow in clusters with clear forest edges, as in references 2 and 5. Forest boundaries follow the density map with a sharp threshold, and a thin band of scattered trees and shrubs softens the edge. Inside a forest, crowns stand on a jittered 8 m lattice, about the width of a crown, so the canopy closes, and each tree's top stands at its stand's canopy height (decisions 148, 150).
- **Stands.** A forest is a mosaic of stands 100–400 m across, each with a composition, a height and a shade, so stand boundaries are steps in the canopy skyline and patches from above. Conifers take cold and north-facing slopes and the ground toward the tree line, broadleaf warm valleys, birch edges, clearings and riverbanks. Below an annual mean of about 6 °C forests are all conifer, and in the cold all pointed firs, without birch (owner, decision 153); pines join conifer stands as it warms. A forest's edge trees stand lower and grow to the stand's height a little inside, and the fringe in front of a forest takes after its stands (decision 153).
- **Seasons.** Deciduous crowns turn yellow, orange or red as the surface temperature falls through about 12–7 °C (birch yellow, oak orange to red, broadleaf any), brown through 5–1 °C, and below about 0 °C each tree, at its own threshold, takes a bare branching model; the canopy shell over leafless stands is the gray-brown of bare twigs with the ground's snow showing through. Conifers and tropical forest keep their leaves (decision 153). Grass and the forest floor brown from 12 °C on, with the trees' turning; snow covers the sloped faces of conifers' tiers, so a snowy conifer reads white (decision 157).
- **Lines and singles.** Hedgerows on field boundaries, rows of poplars or birches along some roads, woods along rivers and streams, and a lone large tree every few square kilometers of open land: what a low-flying pilot navigates by and hides behind. Hedgerows follow a region's climate, not its biome: temperate maritime climates (a small seasonal range, wet all year, an annual mean of about 4–16 °C) on rolling farmland are hedged like bocage, continental plains with large seasonal ranges keep a few shelterbelts on their field edges, and a regional term over a few hundred kilometers lets regions of similar climate differ (decision 148). A hedge is a line of shrubs about 3 m tall with a tree every ten meters or so, on the boundary of the fields the terrain paints, whole boundaries hedged or not. Rows of trees stand just outside a road's clearing on one side or both, on a fifth to a third of the roads, poplars in temperate land, birches in the cold, broadleaf in warm country, none in arid land (decision 162). Woods along rivers and streams in open land stand in up to four rows on each bank, the nearest nearly closed and the outer ones thinning: broadleaf, poplar and birch in temperate land, birch and fir in the cold, evergreen broadleaf in the tropics, none in desert. About one in three cells of open land about 770 m across holds a landmark: one lone tree 1.6–2 times the usual size, an oak (a fir in the cold, broadleaf in the tropics, an acacia in savanna, a dead tree in arid land), the same in every visit (decision 166).
- **Shades.** Near trees keep the canopy shades of the palette (owner, decision 148); contrast comes from stands and species rather than brighter greens.

### Level of Detail

A forest is a volume with a canopy height H: zero in the open, the stand's height inside a forest, with the edge on the forest density contour. The simulation's line of sight and tree strikes read the same H (decision 148). Three layers draw it:

| Layer | Representation | Range (laptop default) |
|---|---|---|
| Near trees | Instanced tree kit: crowns only inside stands, whole trees on edges and in the open | 0–600 m |
| Edge trees | Whole trees along forest edges, in the fringe and in the open | 0–1.2 km |
| Canopy shell | The terrain tile mesh drawn again, lifted by H, faceted, in the stand's canopy shade | 0–12 km |

Beyond 350 m every tree takes its far model, one cone or one lumpy blob on a trunk (18–28 triangles, decision 150).

- **Understory.** Near the camera the shell sinks to about 60% of H and fills the gaps between instanced crowns, so no ground shows through a closed stand; toward the near band's edge it rises to H as the near trees shrink into it.
- **Edges.** The shell rises from the ground a mesh cell inside the forest's edge to its height a cell further in, behind and below the edge trees' crowns: it follows the least forest density around each vertex, so it neither hangs over the edge trees' trunks nor sticks out past them (decisions 153, 157). Lanes open through it along roads, runways and taxiways, and over towns and industry.
- **Ranges scale with the machine** (quality tiers below); the shell does not, so a slower machine sees fewer individual trees but keeps every tree line.
- **Shadows.** Trees cast none for now; baked occlusion in the crowns and the dark understory carry the depth cue (decision 148).

Beyond the shell's range, forests are dark canopy masses in the terrain shading with a sharp edge on the forest density contour (decision 71). The strategic view draws no individual trees at all (Part II).

## Water

- **Ocean.** Calm, deep-colored water with faint, large facets from a low-frequency normal pattern (reference 1). Color shifts from deep blue-green offshore to teal in shallows, with a pale foam line at the coast. From altitude the sea must not read as one repeating texture: gusts and calms that do not repeat break its glint into patches and streaks along the wind, while the sun's sparkle off resolved waves stays in low views, a long swell runs at sea, broad patches shift its color slightly, and storms raise whitecaps (decision 146).
- **Reflections.** Fresnel blend toward the sky color, plus a stretched sun glint that forms a soft column at low sun angles. Rivers drawn wider than a pixel for legibility reflect only their true width, so distant rivers do not glitter. Planar or screen-space reflections are a later option; the sky blend carries most of the effect.
- **Rivers and lakes.** Same material, calmer, with stronger sky reflection.

## Sky, Atmosphere, and Clouds

- **Aerial perspective.** The single most important effect for scale. Distant terrain fades toward the horizon color of the sky, with a slight violet cast at dusk (references 2 and 5). Tune haze so ridges 30 to 60 km away read as layered silhouettes. Clear air shows about a third of the physically consistent haze over ground nearer than about 20 km, so the ground keeps its palette, and the full amount toward the horizon; weather raises it (decision 140).
- **Sky gradient.** A physically motivated sky from a sky-view lookup table with multiple scattering, soft and free of facets, then color-graded toward warm, painterly tones: in-scattered light gains saturation around sunrise and sunset (decision 140). The sun is a small white-hot disk with a halo; the moon shows its phase; stars come out in deep twilight and turn with the planet.
- **Time of day.** Full day-night cycle. Golden hour and dusk are the showcase; midday uses a pale, slightly hazy sky (reference 3); night relies on emissive lights, moonlight, and a dark blue ambient, and is dark enough to need a night vision system: under a moonless sky the land is a silhouette, under a full moon it shows dimly (decision 296).
- **Clouds.** Soft, volumetric cumulus, stratus decks and storm towers that contrast with the hard geometry (references 2 and 4). They are marched in 3D at a third of the resolution (a quarter and a half at the other quality levels), shaped by the live weather field (cover, cloud base, precipitation, storm cells) and by tiling noise volumes; the weather decides how deep a cloud grows, from 700 m heaps with flat bases to anvil towers of 11 km. Cloud bases stand on the mean height of the ground as drawn, so over high ranges cloud hangs among the peaks and summits break through it, not kilometers below them (decision 220). Clouds catch warm light on top and stay cool and gray underneath; at low sun their sides turn gold, then pink, and a thin cirrus sheet high up keeps color above the horizon after the ground is in shade. Their shadows drift over the terrain under them, and under a closed deck the sky light turns gray and dim. The camera flies below, through and above them. Clouds never flicker or crawl: the march samples at fixed offsets that the filter averages, with no per-frame jitter (decision 141).
- **Fog, haze and dust.** Fog lies on the low ground and thins with height, in banks and flat wisps that drift with the wind; it takes the light's color, gold toward a low sun, blue-gray in shade, and dark at night. Mountain and cloud shadows cut through it as shafts at low sun. A dust storm is an ochre layer with a billowing wall, and from inside it the sun is a dull disk. Clear air costs nothing (decision 141).
- **Rain and snow.** Far precipitation is gray veils that hang from the cloud base and lean with the wind. Near the camera it is particles: drizzle as sparse fine dashes, rain as steady streaks, a skyfall as a dense leaning sheet in gust bands; snow as soft flakes that sway, a blizzard as flakes streaming flat. Streaks follow the particle's motion relative to the camera, so rain from a fast aircraft radiates from the direction of flight. Particles take the light of the air they fall through and never glow against it; nothing falls above the cloud (decision 142).
- **Lightning.** A jagged, branching bolt with bloom from the cloud base to the ground, a short pulse of blue-white light on the ground and in the cloud and rain around it, and thunder after the delay its distance gives. A flash lights the murk toward the strike and never turns the frame white (decisions 141, 142).

## Zones

A zone is a named region 16–63 km across (decision 205: the proposal's 100–400 km scaled to the planet) with a coherent look (decision 204). Its recipe shifts the biome colors within limits (hue by up to ±10°, warm hues of rock and sand only toward orange so red never turns pink; saturation and value by up to ±12%; decision 220), and sets the haze color and density, the sky grading and the sun's warmth, the weights of the tree and ground cover kits, the landform props, the cloud regime, and ambient particles (dust, mist, drifting snow, pollen). Where a ridge, river, coast or escarpment divides two zones, the change happens there; elsewhere it blends over about 1–2.5 km (the proposal's 5–15 km, scaled). The palette shift applies per fragment from a zone texture; haze, grading, warmth, clouds and particles blend by the camera's position. Today the palette shift is applied per vertex, and haze, grading, warmth, clouds and particles are stored in the recipe but not yet applied (decision 213). Zones keep the world coherent: the shift never takes a biome outside its own family of colors, and every zone stays under the same sun and sky.

## Models

### Polygon Budgets

| Model | Triangles |
|---|---|
| Fighter, strike aircraft | 300–800 |
| Store on a pylon (missile, bomb, rocket pod, drop tank) | 12–120, on top of its aircraft's count (decision 288) |
| Bomber, tanker, transport, AWACS | 600–1,500 |
| Helicopter | 300–800, plus a translucent rotor disc when spinning |
| Tank, IFV, SAM vehicle | 150–400 |
| Truck, light vehicle | 80–200 |
| Person | 60–150 |
| Building | 12–200 |
| Ground cover (tufts, reeds, bushes, boulders, slabs, pebbles) | 8–40 (decision 172) |
| Bridge, viaduct | About 300 (short beam) to 1,500 (long truss or viaduct) |
| Tunnel portal | 100–200 |
| Landform prop: karst tower, sandstone pillar | 30–200, far versions near 30 (decisions 204, 225) |
| Landform prop: sea stack or arch, hoodoo cluster, natural arch, basalt column cluster, small inselberg | 30–200 |
| Carrier | 2,000–5,000 including deck details |
| Other ships | 400–2,000 |

The aircraft the player controls or follows uses a higher detail level of 1,500 to 4,000 triangles, still flat-shaded (see *The Controlled Aircraft*). Everything else stays within these budgets.

### Aircraft

- **Construction.** Fuselages are lofts of 6- to 8-sided cross-sections; wings and tails are extruded planforms with a slight thickness and a sharp leading edge. Canopies are separate faceted pieces with a dark, glossy material.
- **Recognition.** Aircraft are fictional analogues, so their proportions carry their identity: the F-111 analogue's swept wings and side-by-side canopy, the A-6 analogue's bulbous nose, the F-117 analogue's black facets, the AC-31 gunship's guns and sensor turrets along the left side of a transport's fuselage. Exaggerate the features that distinguish types.
- **Camouflage.** Large flat color patches assigned per face, following a few faction schemes (see *Palette*). No gradients within a face.
- **Markings.** Fictional national insignia, modex numbers, and squadron codes as simple geometric decals or painted faces. Large numbers on carrier islands and tails are welcome (reference 1).
- **Emissives.** Afterburners glow in a warm core with bloom. Navigation lights (red port, green starboard, white tail) and anti-collision beacons blink at night.

### The Controlled Aircraft

The aircraft the player controls or follows fills the center of the screen for entire missions, so it is the most-viewed asset in the game.

- **Detail level.** 1,500 to 4,000 triangles, still flat-shaded, with the same construction, camouflage, and markings as the standard level. Other aircraft keep the budgets above.
- **Animated parts.** Ailerons, elevators or stabilators, rudders, flaps, slats, airbrakes, and speedbrakes respond to control inputs. Swing wings (the F-111, F-14, Tornado, Su-24, MiG-23, and Tu-22M analogues) animate with speed. Afterburner nozzles open and glow. Helicopter rotors blur into discs that tilt with the cyclic (see *Helicopters*).
- **Stores.** Weapons hang visibly on pylons and disappear as they are released. Fuel tanks can be jettisoned; they fall away tumbling (decision 294). Pylons themselves are not drawn yet.
- **Landing gear.** In the campaign, takeoff and landing stay with the AI, so gear only needs to exist on parked and AI-controlled aircraft. The Free Flight sandbox (decision 134) flies from the runway, so its aircraft animates gear extension and retraction from hinges in its model spec. Helicopters land in the campaign too (decision 149), so their skids and wheels touch the ground under the player's control.
- **Effects.** Vapor and wingtip vortices at high G, contrails at altitude, heat shimmer behind engines, dust and spray at very low level, downwash for helicopters (see *Helicopters*), and smoke, fire, and missing parts for damage. Smoke, fire, contrails and vortices follow *Effects* below.
- **Shadow.** The aircraft's shadow on terrain is a key height cue at low level and must stay visible down to the ground. It is one even, solid shade wherever any part of the aircraft covers the ground, about 68% darker and a little bluer than the sunlit ground, never black; it lies along the ground's slope and fades under cloud, in terrain shadow and toward a low sun. A spinning rotor's disc adds a faint shade outside the body's (decision 170).
- **Crew figures.** The blocky crew figures stay visible through canopies.
- **Canopies** are dark tinted glass (`#1E2A33`); the F-16 and F-22 analogues' coated canopies are a muted gold (`#8A713F`, decision 310).
- **Model specification.** The aircraft spec adds hinge axes for control surfaces, pivots for swing wings, store stations, nozzles, light positions, crew figure positions, and the camera rig offsets; helicopter specs add their rotors (hub, axis, radius, blade count) and the hook, hoist and fast-rope points.

### Helicopters

Helicopters are flown to the ground and hovered close to it (decision 149, proposal 0004), so the rotor is the player's main cue for what the controls are doing.

- **Rotors.** Below about a third of rotor speed the blades show as thin flat-shaded blades. As the rotor spins up they fade into a translucent disc: a faceted fan in the blades' color with two or three rings of falling opacity and a faint tip ring, never a smooth gradient or a motion-blur texture, and a thin rim at the tip path so a disc seen edge on still shows as a line (decision 157). The disc tilts with the flight model's flapping state, so cyclic inputs show at once. Tail rotors and the second rotor of tandem and coaxial types follow the same rule. Hub and blades count in the helicopter's 300–800 triangles; the disc comes on top, as *Polygon Budgets* says (about 220 triangles for a main rotor, 110 for a tail rotor).
- **Downwash.** Below about one and a half rotor diameters the rotor raises dust on dry ground (in the ground's own color), gray grit on rock, gravel and pavement, snow where snow lies, and spray and a ring of ruffled water on lakes and the sea, scaled with the outwash. They are low, solid, toon-shaded puffs of the effects system that roll out from under the rotor in a low billow and drift off with the wind, dissolving by the puffs' dither (*Effects*; decisions 182, 326). Green ground raises nothing; its flattened grass is the cue. Grass, reeds and flowers lie down in rings that spread out from under the rotor and show their paler side, so the ring's size tells the height and its offset the drift; near trees sway in the near field (decision 176).
- **Sling loads.** The cable is a thin line from the hook, and the load a low-poly model of its own; both swing as the simulation moves them, never on a canned animation.
- **Damage.** Smoke from a hit engine, a fuselage that spins after tail rotor loss, and a rotor that visibly slows in autorotation, blades returning as it slows.

### Ground Vehicles and People

- **Vehicles.** Boxy hulls, simple turrets, and chunky wheels or track blocks. Faction camouflage in two or three flat colors.
- **People.** Toy-like figures (reference 3): box torso, block head with a few painted face details, helmets and flight suits as simple shapes. Deck crews wear color-coded jerseys. People appear only at close range: on airbases, carrier decks, and in cinematic views.

### Buildings and Bases

- **Base kit.** Hangars, hardened aircraft shelters, control towers, radar towers on lattice masts, radar domes, fuel tanks, revetments, and taxiway and runway markings. Markings are paint in the pavement shader: threshold bars, two-digit designations, aiming points, edge stripes and centerline dashes in white, taxi lines in yellow (decision 109). Fields are graded flat into the terrain (decision 108). Runways and aprons have dark shoulders, 12 m wide and at least 2 px on screen, so a field reads from the air (decision 221).
- **Style.** Plain boxes and arched shells in pale concrete and muted paint, with large openings that create deep shadow (references 3 and 5).
- **Night.** Runway edge lights, apron floodlights, and tower windows as emissive points.
- **Bridge kit.** Abutments, wall and column piers, beam deck segments, truss panels, arch ribs, viaduct arches, suspension towers and tunnel portals, built from model specs and assembled per bridge record by type, span and deck elevation. Each structure is unique in length, height and grade, so its parts are merged into one mesh per structure rather than instanced, drawn within about 12 km of the camera (decision 192). Pale concrete like the base kit and steel trusses in a muted gray, with a dark deck underside so a bridge reads from above and in silhouette from a low pass. Culverts under streams narrower than about 5 m have no model (decision 161).

### Landform Props

Tower karst, sandstone pillars, sea stacks and arches, hoodoos, natural arches, basalt columns and small inselbergs are props: instanced, flat-shaded meshes from model specs, placed on the terrain by province and rock, taking their rock colors from the lithology (decision 204). Today three kinds exist (tower karst, sandstone pillars, inselbergs; decision 225) and use their specs' colors; the other kinds and lithology colors are planned. They are tall and chunky, never spindly: towers lean and bulge with undercut bases, arches keep thick spans, and columns cluster in hexagonal blocks. Karst towers may stand taller and denser than on Earth, and drowned towers rise from shallow sea. Props have levels of detail like the trees and count against the scene's triangle budget. Tower karst grows in limestone under a wet, warm climate and stands in clumped fields with gaps, scattered towers on other limestone; pillars stand in layered sandstone in dry country, inselbergs alone on old granite under open, warm country. Karst-bay and pillar-forest wonders crowd them within 6 km (decision 225).

### Procedural Model Builders

Aircraft, vehicles, ships, buildings, and trees should be generated in code from small JSON specifications rather than modeled by hand. A fuselage spec lists cross-sections along its length; a wing spec lists its planform, sweep, and dihedral; a camouflage spec maps colors to face groups. This approach suits the low-poly style, keeps assets reviewable as text, lets Claude Code author and adjust models, and makes new fictional types cheap to add. A small model viewer page in the debug UI should render any spec with turntable and lighting controls.

The specs live in `src/data/models/` (decision 106). A spec names its budget class and a color per face group (a hex color, a named model color, or `camo` for its scheme), and lists parts: lofts through 4- to 8-sided cross-sections, wings and fins as thin diamond-section planforms with a sharp leading edge, and boxes (optionally beveled), frustums, cylinders, icosphere blobs and domes, arched shells with a dark door wall, gabled houses and lattice masts, any of them mirrored across the centerline. Helicopter specs list their `rotors` (hub, axis, radius, blade count, chord, direction), which the builder turns into a hub and plank blades and, for the flown aircraft, the disc (decision 157). The builder bakes per-vertex ambient occlusion (eight short rays per vertex, plus darkening toward the ground for buildings) and lays camouflage as large patches from a smooth noise over face centers, one color per face. The model viewer is `viewer.html`, reached from the debug GUI (View → Model viewer), with a silhouette mode for check 6; `tools/models.preview.ts` renders the same views and silhouettes to PNG without a GPU.

## Palette

Starting values; final values get tuned in the model viewer and on the globe.

### Terrain and Water

The land shades are proposal 0007's brighter starting values (decision 204); the terrain takes each biome's middle shade since decision 211. Zones shift them within the limits of *Zones*.

| Element | Shades |
|---|---|
| Deep ocean | `#1E3A4C` |
| Shallow water | `#2F6B73` |
| Coral lagoon | `#3FD1C7`, `#7FE3D6`, atoll sand `#F2E6C8` |
| Beach and sand | `#C9B48A`, `#B9A276` |
| River gravel | `#999185` |
| Tropical rainforest | `#1F7A3A`, `#2A8C45`, `#3FA052` |
| Cloud forest | `#3E8C5A`, `#5BA37A` |
| Monsoon forest | `#4E8F3A`, `#6FA04A` |
| Mangrove | `#2F6E4A`, `#3E7F55` |
| Savanna | `#C9B458`, `#B8A24A`, `#D6C46A` |
| Sand sea | `#E3A35A`, `#D98C45`, `#EDB873` |
| Rocky desert | `#B9825A`, `#A0694A`, `#C99A70` |
| Red rock | `#A85E36`, `#B46A3C`, `#C98552` (sienna and burnt orange, never salmon; decision 220) |
| Fog desert | `#C8B9A0`, `#B5A58C` |
| Cold desert and steppe | `#B7A77C`, `#A39468` |
| Mediterranean scrub | `#8A9A5B`, `#9FA86A`, `#7C8B50` |
| Temperate grassland | `#8DB255`, `#7FA34A`, `#A3C266` |
| Temperate deciduous forest | `#3F7A35`, `#4E8C3F`, `#5E9C48` |
| Temperate rainforest | `#22593A`, `#2E6B44` |
| Moorland and heath | `#8A6A7A`, `#9C7F8C` (heather), `#7A6248`, `#4A3B2E` (peat) |
| Wetland | `#5E8A55`, `#6E9A60`, pools `#4D7A80` |
| Marsh (tile cover) | `#6B7A4E`, dark pools |
| Boreal forest | `#2C5236`, `#355E3E` |
| Tundra | `#9A9A70`, `#8A8A62`, `#B0A27A` |
| Alpine meadow | `#7DAA5A`, `#96BC6E` |
| Glacier and ice | `#CFE6F0`, `#A9D3E6` |
| Salt flat | `#F1EEE6`, `#E6E1D3` |
| Brine | `#E59AA8` (pink), `#5FC7C2` (turquoise) |
| Travertine | `#F3EBDD`, pools `#6FD3D0` |
| Volcanic rock and black sand | `#2E2B2B`, `#3A3634`, `#4A3F3A` |
| Mineral bands | `#C65A4A`, `#E0A35A`, `#D9C27A`, `#8FA36A`, `#B58AA0` |
| Farmland | `#C8A85A` (wheat), `#6E8B3D` (green crop), `#8A6A45` (fallow), `#7F944F` (pasture) |
| Rock | `#6E665E`, `#857B70`, `#5C554F` |
| Dry rock (strata) | `#B06A3A`, `#C4925C`, `#965532`, `#D6BC8E`, `#A0603A` (cliffs), `#A06A48` (shale) (decision 220) |
| Snow | `#E8ECEF`, `#D5DCE2` |
| Roads | `#7A7062` |
| Runway paint | `#E6E4DC` (white), `#D9A92E` (taxi lines; decision 109) |
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
| Alliance ship | `#8C949B`, waterline `#3A3E42` | Ships (decision 106) |
| Pact ship | `#7E8A86`, waterline `#3A3E42` | Ships (decision 106) |

### Light and Emissives

| Element | Color |
|---|---|
| Golden-hour sun | `#FF9A4D` |
| Dusk sky, horizon to zenith | `#F6B07A` to `#7C6A8A` |
| Midday sky | `#C9D8E3` |
| Afterburner core | `#FFB347` |
| Missile motor flame, while it burns; its trail is a chain of puffs by its motor (*Effects*; decisions 297, 326) | `#FF8C26` |
| An aircraft shot down: its wreck falls tumbling, burning with a flame, fire puffs and a black trail, and strikes the ground as a fuel fire that burns on (decisions 301, 326) | the missiles' flame; *Effects* |
| Bomb and rocket impacts: the five layers of an explosion (*Effects*), sized by the cube root of the warhead's explosive (decisions 300, 326) | flash `#FFF9E7`, fire `#FFEDB3` to `#ED7C3F`, glowing |
| Gun tracers: short additive streaks along the round's flight, brighter at the head, at least about two pixels wide at any range, one round in five (decision 295) | `#FF9E38` to `#FFB347` |
| Gunship impacts (decision 302; to be restyled with proposal 0011's effects): the 105 mm a large dirt and fire burst with a shockwave ring, debris and a scorch mark, and a camera kick in the gunner view; the 40 mm compact bursts in clusters of four; the 20 mm and 7.62 mm rapid sparkle and dust strikes stitching across the ground. Each weapon must be recognizable at a glance from the gunner view and the chase view | the bombs' flash and smoke, scaled per weapon |
| Gunship tracers and muzzle flashes: bright dashes, at night cones of fire visible from the chase view and from far away; flashes along the gunship's left side | the gun tracers' colors |
| Runway and deck lights | `#FFD27A` |
| Navigation lights | `#FF3B30` (red), `#34C759` (green), `#FFFFFF` (white) |

## Effects

Smoke, fire, explosions, contrails and vortices (Proposal 0011, decisions 320–327). One effects system draws every source, from missile trails to chimneys (`src/render/sim/effects/`).

- **Puffs.** Smoke and fire are solid, round puffs: sphere impostors that write depth, so they cut into each other, the ground, buildings and aircraft without sorting. Each is lit in three bands of the sun's light (highlight, midtone, shadow) with a thin rim of sky light, takes the terrain's and the clouds' shadows like the ground, and is slightly squashed with a lumpy outline. Puffs fade by an ordered 4 × 4 dither, never by alpha blending; the visible dissolve is part of the look. No soft photographic smoke textures.
- **Life.** A puff swells fast, grows slowly, rises, drifts with the wind (weaker near the ground), darkens, and shrinks away. Columns fan out into cones as they rise, so their outline is a chain of lumps, not a tube.
- **Color.** Fire is emissive, in saturated yellow, orange and red, cooling to dark gray smoke. Smoke runs from white or light gray (motors `#EDEDED`, steam `#F6F6F6`) through mid gray (stacks `#B3B3B3`, burning buildings `#818181`) to near black (fuel fires `#3F3F3F`); dirt thrown up by an impact is brown `#958169`. These are albedos before light; the toon bands darken their shadow sides. Downwash dust takes the ground's own color.
- **Silhouettes.** A missile trail reads as a chain of balls against the sky and the terrain. A puff is never drawn smaller than about a pixel, so a SAM's trail stays a line from 20 km.
- **Explosions** are punchy and short; columns are tall and slow. An explosion has five layers, scaled by the cube root of the explosive: a brief bright flash with a short point light (at most four at once) that lights the ground, a fireball of glowing puffs going yellow to orange to red, a smoke cluster (dirt on the ground, dark gray in the air, white water and black smoke on water), a few flat-shaded debris chunks on ballistic paths, some trailing puffs, and on the ground a dark ragged scorch (minutes) and, for large blasts, a pale ring running out in half a second.
- **Sources.** Solid motors leave dense white trails with a bright core; reduced-smoke motors a short, thin trail; a SAM a large white column at the launcher, then a thick trail. A damaged aircraft trails gray to black smoke with orange flicker; one on fire, dense black smoke with fire at the source. Burning targets stand as steady gray or black columns leaning with the wind; fuel fires as tall black columns over a bed of fire. Chimneys shed gray puffs downwind; cooling towers large white steam puffs; waterfalls soft white mist; flares a bright point shedding small white puffs. A weapon's motor decides its trail.
- **Ribbons.** Contrails and wingtip vortices are thin white strips along the path, never thinner than about a pixel and a half, widening and dissolving with age. Contrails form only above the contrail altitude (about −40 °C, from the surface temperature down the standard lapse rate) and last longer in moist air; vortices only above a load factor (6 g in dry air, 3.5 g in saturated air).
- **Persistence.** Columns come from the game layer's damage states: a burning depot is already tall when the camera comes back.
- **Budget.** At most 20,000 puffs in one draw, two triangles each, stepped by one compute pass; far emitters shed fewer, larger puffs, and a governor scales every emitter down as the pool fills. Target: compute under 0.5 ms, puffs under 1.0 ms with 10,000 on screen.

## Post-Processing

- **Tone mapping.** AgX, with exposure tied to time of day: the pipeline's exposure is constant and the sun's illuminance carries a twilight gain instead, so lamps and moonlight keep their level (decision 140).
- **Color grading.** A grade per time-of-day band (dawn, day, golden hour, dusk, night: gain tint, saturation, gamma and lift), blended as the sun moves (decision 138).
- **Bloom.** Thresholded so only the sun, emissive lights, afterburners, lightning bolts, and bright sky glints bloom. The threshold follows the time of day, low at night and high by day.
- **Film grain.** Faint, constant in strength, and cheap, with a dither of half a code value so sky gradients never band. It fades out toward black, so night skies and unlit ground stay clean (decision 296).
- **Pixelation (optional).** Render at 50 to 75% internal resolution and upscale with nearest-neighbor sampling, optionally with ordered dithering on sky gradients. This reproduces the stair-stepped edges of the references and doubles as a performance setting for weaker devices. Default to 75% on desktop and offer a toggle.
- **Letterboxing.** Only in cinematic views: base arrivals, mission briefings, and replays.

## User Interface

- **Typeface.** A clean monospaced or pixel-style face under an open license (for example Share Tech Mono or JetBrains Mono for body text, with a pixel face for headings).
- **Panels.** Dark translucent backgrounds (`#000000` at 55 to 70% opacity), white text, amber (`#FFB347`) for highlights and selected items. Square corners, no drop shadows.
- **Map symbology.** See Part II, *Military Overlays*. The panels and typeface here serve both views.
- **Cinematic cards.** A short label line (base name, location) in the lower right, a status card (day, available aircraft) in the lower left, and an action hint at the bottom center (reference 5).

## HUD and Displays

With no cockpits, the HUD and the cockpit displays draw as 2D elements over the chase view (decision 94). They show only what the aircraft and its crew know. Every item lives in exactly one of three places (decision 189): the **HUD** holds spatial and time-critical information used while looking outside, the **displays** hold sensor pictures, selection, configuration and planning, and the **status strip** holds discrete states and warnings (*Displays and Status Strip*).

### Two Kinds of Symbols

The chase camera sits behind and above the aircraft, so HUD symbols cannot sit at fixed screen positions as on a real HUD.

- **World-anchored symbols** are projected from the 3D scene every frame: the flight path marker (from the velocity vector, projected at a great distance so the camera offset causes no parallax), the boresight cross, the gun pipper (at the predicted impact point), CCIP bomb fall lines, target boxes, waypoint and target diamonds, and missile seeker circles. The other aircraft of the player's own flight carry a small ring with their number in the flight (decision 308), so a wingman a mile abeam, a speck at that range, is found at a glance. Steering to the next waypoint (decision 305) adds its diamond on the ground with its number and name, a small diamond under the heading tape at its bearing (an arrow at the tape's end when it lies beyond), and in the landing aid's place, which it takes when the aid is off, the waypoint with its distance, bearing and time to go. Where the phase marks the target or the station, the steering goes to it, so its distance always shows (decision 310). In a dogfight the radar's air combat mode shows its 10° search cone as a dashed circle about the boresight until it locks (decision 223). With the gear down the jet's angle-of-attack bracket (11°, 13°, 15°) stands beside the flight path marker, as on the F-16 (decision 208).
- **Screen-anchored instruments** sit at fixed positions around the aircraft: airspeed and altitude tapes, a heading tape, a compact attitude indicator, Mach, G, and the throttle with its detent. The jet's speed tape carries the gear limit, the approach speed bug and a trend vector to the speed 10 s ahead; the landing aid carries the approach energy cue (decision 207). Fuel moves to the engines and fuel format, and gear, brakes, speedbrake, afterburner and the master caution move to the status strip.
- **Warnings that demand an immediate maneuver** (PULL UP, STALL, tail strike, the sink cue, and the helicopter hazard cues) stay on the HUD in amber; system cautions and warnings go to the strip.

A full pitch ladder is confusing when seen from outside the aircraft, so the compact attitude indicator replaces it.

**Helicopters** add hover symbology (decision 149), because small drift in the hover is hard to judge from a chase camera: a velocity vector on the ground plane from the helicopter's ground point, with an acceleration cue at its tip (world-anchored); radar altitude with vertical speed, ground speed, and a landing zone marker with distance and bearing (screen-anchored, the marker also world-anchored); the load's position under the hook for sling loads; and hazard cues for vortex ring state, mast bumping, retreating blade stall, and dynamic rollover. Torque and rotor RPM are gauges at the end of the status strip, the rotor RPM gauge highlighted in autorotation (decision 189).

### HUD Style

- **Layout.** The aircraft sits slightly below screen center, the tapes flank it, and the HUD keeps within the middle 60% of the screen, clear of the display slots. On a mission the phase's cues add and take away symbols (decisions 304, 305): the landing aid shows only on the ground and the approach, and the target or station diamond and the steering cue only in the phases that ask for them. Declutter levels down to the world-anchored symbols and tapes alone are planned.
- **HUD symbology.** A single color (green by default, amber as an option) with a thin dark halo, so it stays legible against bright sky, snow, and night. Free Flight's first HUD (decision 135) starts from green `#6CFF8A` with a halo of `rgba(0, 18, 6, 0.75)` and amber `#FFB347` for warnings; exact values are tuned with the HUD (milestone P2). Red `#FF3B30` appears on the HUD only in the approach energy cue's TOO FAST, beside its label (decision 207).
- **Implementation.** A Canvas 2D overlay at device pixel ratio.
- **Control cursor.** The mouse's hold on the controls is a game control, not HUD symbology, so it draws in its own soft magenta, `#FF8AE2`, with a dark halo (decision 198): in direct control a faint full-deflection box and dead-zone ring at the screen's center, the line from the center to the cursor, and a cross at the cursor; in mouse aim a ring where the aircraft flies, dimmed while the mouse is free.

## Displays and Status Strip

Multifunction displays docked at the screen edges and a status strip carry what the HUD should not (Proposal 0006, decision 189). Players switch aircraft often, so the screen stays the same across types while each keeps its own equipment.

### Slots

| Slot | Position | Size | Default use |
|---|---|---|---|
| Left MFD | Lower left | Large: a square about 28% of the screen height | Moving map or stores |
| Right MFD | Lower right | Large | Radar or targeting pod |
| Threat | Upper right | Small: a square 60% of a large slot's side | Threat warning |
| Messages | Upper left | Small: as wide as a large slot, 60% of its side high | Comms log and crew callouts |
| Status strip | Bottom center, below the aircraft | Strip | Discrete states |

- **Fixed.** Each slot has one position and one set of bindings in every aircraft and helicopter. An aircraft may leave a slot empty, never move it, and an empty slot leaves the screen clearer. No free-floating windows.
- **Central area.** The middle 60% of the width, above the strip, belongs to the aircraft and the HUD (at the gunner station, to the sensor image and its overlays; *Sensor Images*). Slots never enter it: on narrow screens they shrink to the side bands. A UI scale setting (0.75–1.5) resizes all slots together, until they meet the central column (at about 1.16 on 16:9). The rects come from `src/ui/displays/layout.ts` (decision 195).
- **States.** Expanded, collapsed to a small labeled tab at its edge, or hidden. At most two large and two small displays are expanded at once.
- **Calm.** Fades and expansions take about 300 ms and grow from the screen edge; nothing flashes or slides through the central area. An alert that brings a format forward highlights the bezel in amber instead.

### Frame and Formats

- **One frame.** A square screen in a bezel with 20 option-select buttons, five per side. Each format labels its buttons on the screen beside them, in the format's type, and grays the ones that do nothing now; the format shown is highlighted among the bottom row's format buttons, and small displays name their format at the screen's top left. The owner (a crewmate's role, such as `WSO`) is a short tag on the bezel's top edge (decision 199). The frame itself carries two small icons in the bezel's top corners, outside the button rows: a pin at the left (upright and in the phosphor color while pinned, tilted and gray otherwise) and minimize at the right, which collapses the display to its tab (decision 222). The top row of buttons spans between them.
- **Same format, same look.** A format has the same layout and buttons in every aircraft that carries it.
- **Scopes** (radar, threat warning, stores, engines and fuel, comms, mission, crew, messages): phosphor vector graphics on a near-black screen, one color with a dimmer second level for secondary items, at device pixel ratio. Datalink tracks draw hollow, own-sensor tracks solid. The air-to-ground radar's ground map is a raster of the same phosphor, its intensity the return: slopes facing the aircraft bright, level ground an even gray, water and radar shadow dark (decision 226). A track whose side the datalink names takes the side's symbol instead (a diamond for a hostile, a circle for a friend), in the dimmer level while only the datalink has it (decision 218).
- **Era bezels.** Older types may draw scope formats in a round, analog-styled scope bezel with the same content and buttons.

### Skins

Faction skins change colors, fonts, labels and units, never layout or button positions. The values are starting points, tuned in P2.

| Token | Alliance | Pact | Use |
|---|---|---|---|
| `--bezel` | `#2B2E31` | `#3A4650` | Bezel face |
| `--bezel-edge` | `#1A1C1E` | `#25303A` | Bezel rim and button wells |
| `--screen` | `#050A07` | `#06090C` | Screen background |
| `--phosphor` | `#6CFF8A` | `#FFB04A` (amber), or `#7CF29A` (green) by type | Symbology and labels |
| `--phosphor-dim` | `#6CFF8A` at 45% | `--phosphor` at 45% | Secondary symbology, grayed buttons |
| `--alert` | `#FFB347` | `#FFB347` | Bezel highlight when an alert claims a slot |
| Labels | English | Transliterated | Button and screen labels |
| Units | Knots, feet, nautical miles | Kilometers per hour, meters, kilometers | All readouts and map ranges |

Both skins use the monospaced type of *User Interface*.

### Moving Map

- **Strategic mode** is a deliberate anachronism: full color, drawn by the strategic view's renderer in its illustrated style (Part II), in both factions. Beauty and legibility win over period accuracy here. At ranges below the strategic zoom floor it shows the region band's content, magnified; it never draws individual trees or buildings. Ranges run 5, 10, 20, 40, 80 and 160 nm from the aircraft at the center to the screen's edge (10, 20, 40, 80, 150 and 300 km in the Pact's skin; decision 227); the aircraft is a small phosphor symbol, with a dashed ring at half the range and its figure; RNG▲ and RNG▼ on the left edge (or the wheel over the map), TRK or N-UP on the right (decision 201), and below it CEN or DEP: the own ship at the center, or three quarters down with more of the map ahead (decision 310). STPT▲, STPT▼ and AUTO/MAN at the left edge's foot choose the steerpoint. The destination is a diamond with its label, or a caret at the edge with its distance when it lies beyond the range (decision 202).
- **Elevation mode** tints terrain by height (starting values: `#5E7F5A` at sea level, `#8A9A62` at 500 m, `#B5A46E` at 1,000 m, `#A88660` at 2,000 m, `#8F7A6E` at 3,000 m, `#D8D4CC` above 4,000 m; water `#3D5A73`), with thin dark contours every 100 m (500 ft in Alliance skins, every fifth darker), a gentle hillshade, and a spot height at the highest ground in view (decision 227). The **relative** sub-mode colors terrain against the aircraft's altitude: red `#D9483B` with a diagonal hatch where terrain rises above the aircraft, amber `#E8A33D` within 500 ft below it, plain gray-green shading where it lies clear below. The hatch keeps red and amber apart for color-vision deficiencies.
- **Overlays** on both modes: own ship, route and waypoints, range rings, bullseye, the front line and threat rings in the faction colors of Part II, and datalink tracks, in the phosphor color with a dark halo. North-up or track-up. The route (decision 305) draws its legs from waypoint to waypoint, flown legs dim and the leg to the next waypoint wider; each waypoint is a circle with its number and name (a triangle for the target, a dashed ring around a station, a square for a landing field), the next one bold, and a caret at the edge with its distance when it lies beyond the range. The route and every symbol over the picture are placed by the picture's own projection, a camera straight down over the aircraft, so they sit on the ground the picture draws. The strategic picture carries the front itself; the elevation modes draw it as Part II does, a dark line on a pale casing with teeth in the attacker's color. The picture leaves out the map's flights, carrier groups and unit symbols: the displays show only what the aircraft knows (rule 12). The own flight's other aircraft come by the intraflight datalink as small rings, with their numbers once every number clears the own ship and the others (at long range a flight in combat spread is a cluster of rings; decision 308); the radar scope shows them as friends with their numbers.

### Sensor Images

The targeting pod and the hook camera show grayscale thermal (white-hot or black-hot) or TV imagery, slightly noisy and low in resolution, with symbology in the skin's phosphor color.

One sensor render mode draws them, the helicopter gunner sights and the gunship's gunner station (decision 302, proposal 0012):

| Mode | Look |
|---|---|
| Infrared, white-hot | Grayscale thermal image, hot objects white |
| Infrared, black-hot | The same, inverted |
| Low-light TV | Monochrome, usable at dusk and by moonlight |
| Color TV | The scene in color through the zoomed camera, slightly desaturated, with scanlines; a deliberate anachronism for daylight |

- **Heat.** Each material carries a heat value in its model spec or terrain class: running engines and exhausts hot, fires and impacts very hot, people and animals warm, buildings and roads warm after sunset, terrain and vegetation cool, water cool. Values shift with time of day and weather.
- **Treatment.** A modest resolution, bloom on hot spots, sensor noise and scanlines. Fireballs bloom white; smoke starts warm and cools to gray, and obscures the TV modes more than infrared.
- **The gunner station** fills the screen with the sensor image; its reticle with the weapon's aim point, compass and north arrow, orbit status, weapon state, friendly strobes, talk-on markers and target labels take the HUD's place in the skin's phosphor color, and the five slots stay where they are. It is the one full-screen picture that is not the chase view, and it is still no cockpit.

### Status Strip

- **Dark cockpit.** In normal flight the strip is empty. Items appear only when relevant (the parking brake on the ground, the gear on approach or while down, the speedbrake while extended, master arm when armed, the afterburner while lit) and warn when a state conflicts with the situation.
- **Annunciators.** Green `#34C759` for normal states that matter now, amber `#FFB347` for cautions, red `#FF3B30` for warnings. Every item carries a short text label and a shape (rounded for normal, notched for cautions, capped with a triangle for warnings), so color is never the only cue. Warnings flash at 2 Hz until acknowledged; nothing else flashes.
- **Master caution.** An amber item at the strip's left end, lit while a caution is unacknowledged.
- **Master mode.** Its short name (GND, NAV, APPR, HOVER, A-A, A-G, DGFT; MAN when chosen by hand) in light gray at the strip's right end (decision 199).
- **Gauges.** Helicopters end the strip with compact torque, rotor RPM and power margin gauges.

### Legibility

All displays and the strip pass the color-vision check of Part II (check 4's simulated deficiencies) and stay legible at 1366 × 768 with the default UI scale. On the screens, warning-tone text is inverse video (white on red), caution-tone text is boxed, and warning messages carry ▲, so color is never the only cue (decision 200); `tools/displays.screens.mjs` draws every master mode in both skins with the three deficiencies.

## Performance Budgets

Targets for a mid-range laptop in a desktop browser at 1080p:

- 60 fps at the default 75% internal resolution.
- Under 500 draw calls per frame, through instancing and merged cluster meshes.
- Under 2 million triangles per frame in the densest view (low altitude over forest near a base).
- Trees: near and edge radii by quality tier, to be stepped by the quality governor after the atmospheric effects: tablet 400 m and 1 km, laptop 600 m and 1.2 km (the defaults), desktop 1 km and 2 km. Over dense forest at the laptop tier, trees take about 0.46 M triangles in about 100 draws, and terrain with canopy shell about 0.55 M (decision 150). At least 30 fps on a laptop over forest at treetop height, and on a tablet at its tier.
- Settlements (Proposal 0009): in the standard city views (a large city from 5 km and 1 km, a town from 300 m) at most 40 draw calls and 0.3 M triangles for buildings, and at most 1.5 ms of frame time over the same view without them (decision 267).
- Landform props: within about 6 km of the camera, instanced by kind, with two levels of detail; together at most 0.3 M triangles and 40 draw calls in the densest karst view (decision 204).
- Atmospheric effects scale with the machine: the volumetric stage marches a quarter, a third (default) or a half of the resolution, and a governor steps its quality and then the particle count down before the frame rate falls under the target, and back up when there is headroom (decision 143). In clear weather the volumetric stage and the particle overlay leave the frame; the pipeline's bloom and grade remain (decision 144).

## What to Avoid

- Smooth shading on models or close terrain.
- Photographic textures, and smooth or noisy high-frequency texture; fine ground detail is stepped micro-facets and chunky cover (decision 168).
- Saturated primary colors outside emissives and UI highlights. The brightest natural surfaces (brine, travertine pools, coral lagoons) stay small in area, and zone shifts never push a biome out of its color family (decision 204).
- Cel-shading bands, and ink lines on terrain, trees or clouds (models carry their optional outline, decision 107). Smoke and fire puffs are the one toon-shaded element (*Effects*, decision 320).
- Soft, photographic smoke textures and alpha-blended smoke sprites (decision 320).
- Thin geometry such as antennas, pitot tubes, and fine branches that alias at distance; omit them or thicken them.
- Uniform scatter of identical trees; forests need clusters, edges, and value variation.
- Real national insignia, unit badges, or manufacturer markings.
- Free-floating windows, displays that move between modes, transitions through the central area, and color as the only cue on displays and the strip (decision 189).

## Acceptance Checks

Before a visual milestone with simulation-view work closes, capture these views and compare them with the reference board. The former orbit check moved to Part II.

1. 5 km altitude over a mixed landscape of forest, farmland, a river, and a town.
2. 500 m altitude over conifer forest with a forest edge and a road, and 30 m above a forest edge with a hedgerow, looking along the tree line (decision 148).
3. A mountain range at low sun, with faceted rock faces and layered haze.
4. An airbase at dusk with lit runway and parked aircraft.
5. Coastline with shallow water, a beach, and sun glint.
6. Silhouette test: every aircraft model rendered solid black against a pale sky, where each type must be identifiable.
7. HUD legible against bright sky, snow, and night.
8. The flight path marker and gun pipper stay accurate during hard maneuvers.
9. The aircraft stays readable and centered in a maximum-rate turn.
10. The camera never clips terrain during low-level flight through valleys.
11. Helicopter hovers at 5 m and 30 m over grassland, scrub and scree: the ground shows height and drift, with no visible repetition, shimmer, or cover that floats, sinks or does not match the ground (decision 168).
12. Each master mode for one fighter, one strike aircraft and one helicopter: slots in the same places in every shot, at most two large and two small displays expanded, the central 60% clear of display chrome, and the strip dark in normal cruise (decision 189).
13. Displays and the strip in both faction skins at 1366 × 768 and 1920 × 1080: labels and symbology legible, and every item distinguishable under simulated protanopia, deuteranopia and tritanopia.
14. The moving map's relative elevation mode in a scripted low-level run through a valley: terrain above the aircraft red and hatched, terrain within 500 ft below amber, both matching the ridges seen in the chase view.
15. Zones: two adjacent zones from 2 km and 10 km, one across a barrier and one across a blend; each recognizable at a glance, the boundary at the barrier or soft over 1–2.5 km, never a seam (decisions 204, 205).
16. Landmarks: an alpine range with glacial valleys, a basin-and-range desert with a salt flat, a moorland, a jungle river, a karst bay at 300 m with props within budget, and one natural wonder (decision 204).
17. Sensor images: each of the four sensor modes over a convoy, a fire and people by night and by day; engines, fires and people read correctly in infrared, and smoke hides more in TV than in infrared (decision 302).
18. Gunship fire: the 105 mm, 40 mm and 20 mm impacts and the tracers, each distinguishable from the gunner view and the chase view, and the gunner view within the frame budget during sustained fire (decision 302).

Checks 1–5 are the views `mixed`, `conifer`, `range`, `dusk` and `beach` in `tools/render.preview.ts` (`VIEWS=checks`), aimed at places the preview finds in each world (decision 128); check 6 runs in the model viewer. Check 11 is the views `hover` and `skid` in `tools/render.preview.ts` and a Free Flight hover, from G1 on. Checks 7–10 are scripted flight sequences in `tools/render.preview.ts` and apply from milestone V4 (camera rig and flight path marker); for a followed campaign flight, checks 7 and 10 run in the `follow` part of `tools/browser.smoke.mjs` (decision 252); check 9 needs the flight model (P1); the gun pipper part of check 8 is a scripted 6-g turn in `tests/pipperTurn.test.ts`, whose rounds pass within 10 mils of a target holding the turn under the pipper (decision 309), and the owner's look at the pipper on a target in a hard turn. Checks 12–14 apply from P2 (14 from P3): 12 and 13 as composites in `tools/hud/` and browser shots, 14 as a scripted Free Flight sequence. Checks 15 and 16 apply from W6 and W7 as `tools/render.preview.ts` views and spots (`zones`, `alpine`, `basin`, `moor`, `jungle`, `karst`, `wonder`). Check 17 applies from R3.2's sensor render mode and check 18 from R4.10, the gunship.

# Part II: Strategic View

The strategic view is where the player reads the war, finds missions, and follows events. It answers questions at a glance: where the front runs, which roads feed it, which mountains shield which bases, how far the bombers must fly. Photographic rendering hides these answers among detail; a map that abstracts, exaggerates, and labels shows them directly. Part I's facets, physical sky, aerial perspective, and post-processing chain do not apply here.

## Strategic Principles

1. **Abstract, exaggerate, label.** Show what a commander needs and drop what only reads up close. Relief, rivers, roads, and cities are drawn larger and clearer than life.
2. **Illustrated, not photographic.** Painted fills, procedural patterns, and low-poly glyphs. Glyphs are flat-shaded with solid colors, the same model language as Part I at map scale.
3. **Crisp at every zoom.** Patterns, glyphs, line widths, and text are sized in screen pixels within each zoom band, so nothing blurs or swims at the zoom floor.
4. **Time and weather are information.** Night and cloud decide which sorties fly, so the map always shows them, styled so that the geography beneath stays readable.
5. **Color carries meaning.** Faction colors are reserved for military information. Geography uses natural tones, brighter since decision 204 but always softer and less saturated than the faction colors.

## Reference Board (Strategic)

Civilization VI screenshots and Cold War operational maps (NATO planning maps, 1980s board wargames such as those behind *Red Storm Rising*) are to be added by the owner to `docs/style/references/`. Like the Part I board, they are local only and never ship (decision 70). Record each one's takeaways here once it is added.

## Camera and Zoom

- **Range.** From about 3,000 km altitude, where the full globe fills the screen, down to a floor of about 100 km, where the view spans roughly 200 km of ground. The floor is tuned so that glyphs, patterns, and labels stay sharp at the closest zoom.
- **Tilt.** Straight down at globe scale, pitching smoothly to about 50° at the floor, so relief and glyphs read in perspective up close. Tilt follows the altitude and is never set by hand; the player pans, zooms, and turns the heading (decision 75).
- **Panning** moves the map as one sheet anywhere on the globe, over the poles included: the camera travels along great circles and carries the screen's up direction with it, so the heading never spins near a pole (decision 246).
- **Opening view.** A campaign opens on the map, over the middle of its first front (or its first theater) at about 1,000 km in the Theater band; `?view=simulation` opens the simulation view instead (decision 246).
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
  Biome boundaries blend over a few kilometers. Pattern scale is screen-stable, so a pattern looks the same at every zoom within a band: patterns are anchored to the ground, and each point picks its period from its pixel footprint, crossfading between powers of two. Farmland lies on settled land (the strategic graph's habitability) in open lowland biomes, outside forests; its field grid shows from the Theater band down (decision 80). Dune ripples mark hot (sand) deserts only, not cold deserts. Reed marks wait for data that marks wetlands, since the world has no wetland biome yet (decision 81); W4's wetland biome brings them. The biomes of decision 204 add heather stipple for moorland, a polygonal crust for salt flats, sparse tower dots for tower karst, and banding for mineral hills.
- **Coasts and water.** Water gets depth tints in a few flat bands, a lighter halo along coasts, and the faint parallel coastal lines of old printed maps. The bands split at reference depths of 200 m (shelf) and 3,000 m (deep) (decision 82). Coastlines carry a thin dark outline, about 1.2 px wide. The halo fades out over the first 11 px from the coast, and three faint lines run 7, 14 and 22 px out, measured at the map scale of the screen center so they stay fixed to the ground while the view orbits (decisions 83, 85). Lakes and wide rivers use the same treatment; narrow rivers are blue lines whose width follows discharge, kept at least a pixel wide: 1 px at 25 m wide, a pixel more per fourfold width, at most 3.5 px. A river becomes water once its true width passes about 4 px. Rivers show from the Theater band down: rivers at least 60 m wide at Theater scale, at least 15 m wide in the Region band (decision 84). Each band's rivers are generalized, simplified to a fraction of a pixel at the band's scale, so major meanders stay legible and the small bends drop out (decision 161).
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
- **Natural wonders** (decision 204). Each wonder has a glyph of its own kind (a tepui, a falls, a cluster of towers, a caldera), larger than the mountain glyphs around it and drawn on top of them, with a small star mark, from the Theater band down.
- **Sizes and bands.** Glyphs have a Theater set and a Region set, each fading with its band. Theater mountains are 30–50 km across (peaks up to 60 km), Region mountains 10–17 km (peaks up to 22 km), wider than their spacing so chains overlap into massifs, so a glyph stays roughly the same size in pixels within its band (decision 97).
- **Shading and color.** Flat shading from face normals, lit from the screen's upper left like the hillshade, then the map's night tint and paper finish. Rock `#8C8379` with snow `#F1F3F2`, mounds `#A99B73`, trees `#4E6A48`, dunes `#D8BD8C` with a `#C4A473` slip face.

## Settlements and Infrastructure

- **Cities.** Each settlement's urban extent is a tinted fill; planned cities take their extent from their blocks and tint industry, rail yards and ports toward `#A8A49C` (decision 270). An oversized low-poly building cluster marks its center, with size and style set by class: village, town, city, capital. Capitals carry a star marker. The fill is `#CBB8A0` over the land fills and patterns, under snow, the hillshade, the territory tint and the night, from the Theater band down, with a crisp edge and a 1.3 px `#8E7A64` outline where its texels span several pixels; it comes from the graph's urban polygons rasterized at about 0.8 km, drawn 1.6 times their size and at least 1.6 texels (about 1.3 km) in radius, so towns read larger than life and villages show (decision 105). The glyphs are flat-shaded like the geographic glyphs: three gabled houses for a village, houses round a hall and a church tower for a town, blocks of mixed heights round two towers for a city, and the city's blocks round a domed seat of government for a capital. Walls are `#E9E1D2` with terracotta roofs `#A65E45` in villages and towns, `#E4DDD0` with slate roofs `#7D7A78` in cities and capitals. Cities (20 km across) and capitals (26 km) show from the Theater band; in the Region band villages are 2.6 km, towns 4.8 km, cities 8 km and capitals 10.5 km across. Each side's capital is its largest settlement; its star is 18 px, in the side's faction color, since finding each side's capital is part of reading the war (check 3) (decision 104).
- **Roads.** A road hierarchy (motorway, trunk, secondary) drawn as screen-space ribbons with a darker casing, colored and sized by class. Bridges are marked where roads cross rivers. In the Region band motorways are 3 px, trunk roads 2.3 px and secondary roads 1.4 px, with 0.8, 0.7 and 0.55 px casings; motorways also show from the Theater band at 1.5 px. Roads are smoothed through the coarse grid's cell centers (or are to follow their aligned routes, generalized, where those exist; decision 161; today they draw the network tier) and draped on the relief like the military lines, but below the glyphs, so a building cluster or a mountain covers the road it stands on. Bridge marks are two 13 px bars along the road, either side of it, `#2A2A2A` (rail bridges in the rail color). Route numbers ("M4", "R12") and the names of pass and coast roads run along the road in 10.5 px brown sans (decision 104). In the Region band each bridge carries its name ("Brann Bridge", "Oskel Viaduct"), and tunnels draw as dashed stretches of their road or railway (decision 161).
- **Railways.** Thin dark lines with cross-ticks, linking major cities, ports, and industry, with rail yards marked. A 1.2 px line with 6 px ticks every 9 px, in the Region band.
- **Military and industrial sites.** Airbases as runway glyphs with icons, ports as pier glyphs, and factories, refineries, depots, and rail yards as distinct symbols. They double as strike targets in mission search. Each site is a badge (decision 133): a pale rounded tile with a 2 px rim in its holder's faction color and the symbol in that color, filling about two thirds of the tile, facing the screen so the map's tilt does not squash it. An airbase is a ring with its runway through it, turned to the runway's heading as seen on screen, on a 20 px tile at the Theater band and 26 px in the Region band. In the Region band an airbase's name ("Gar Air Base", "Kri Airfield") sits beside its badge in 11 px sans in the holder's faction color, at most ten at once; the Theater band shows the badges alone (decision 247). Ports (a quay with three jetties), factories (a works with a chimney), power plants (a ring round a dot), refineries (two tanks and a flare stack), supply depots (a framed square), fuel depots (a tank) and rail yards (a frame with two tracks) are on 22 px tiles in the Region band (decision 105). The railways' own yards take the rail color. Symbols at a town stand on its edge, 1.5 built-up radii out and spread round it, so they do not cover its glyph or name (decision 104).

## Labels

- **Typography.** Cartographic conventions:
  - water features in blue italic;
  - landforms in brown, letter-spaced capitals;
  - settlements in dark type with a light halo, sized by class;
  - military features in faction colors.
  The faces, under the SIL Open Font License and bundled from npm: EB Garamond Medium Italic for water, and Fira Sans Medium (Semibold for cities and theater names) for landforms, settlements and theaters. Panels keep the Part I UI typeface.
  Sizes (CSS px): oceans 22, seas 17, bays, straits and lakes 14, rivers 13; continents 19 with wide letter spacing, ranges, deserts, forests and plateaus 13, hills, plains and wetlands 11, islands 12, peaks 11; capitals 15.5 in spaced Semibold capitals, cities 14, towns 12, villages 10.5; roads 10.5 in brown `#5A3E2B`; theater names 15. Every style has a halo (`#F4EFE4`, or a pale `#E6EFF2` thinner one for water) so text stays legible over glyphs and the night side (decision 98).
- **Placement.** Point labels for cities and peaks ("Mount Kessar 1,210 m", with the peak's true height), curved labels along polylines for rivers, ranges, and roads, and widely spaced area labels across deserts, forests, seas, and regions. Point labels try right, left, above and below their anchor; theater names sit centered on their anchor, or above or below the front or sea lane they name (decision 101); line labels sit at the middle of the visible stretch or at stations either side, never upside down and never bending more than about 30° between letters; area labels spread their letters along the feature's axis to fill about 60% of it, or sit level on the anchor where the axis is short or steep.
- **Zones and wonders** (decision 204). Zone names ("the Oskel Waste", "the Varden Highlands") are area labels in the landform style at 13 px in the Theater band and 12 px in the Region band; they replace the labels of the deserts, forests, plains, plateaus and wetlands inside them. A world has thousands of zones, so the map names few of them and ranks them below the places pilots navigate by: zones of about 50 km and more, at least 250 km apart, in the Theater band; zones of about 25 km and more, at least 75 km apart, in the Region band; the larger zone keeps its name (decision 220). Wonders take a point label in italic landform brown, 12 px, next to their glyph.
- **Band content.** Which labels show in which band, with the least importance each needs, is a table in `render/strategic/labels/labelModel.ts`: oceans, continents and theater names at the Globe band; seas, ranges, major deserts, forests, plateaus and rivers, straits, capitals, cities and the highest peaks at the Theater band; everything, down to hills, wetlands, towns, villages over 10,000 people, roads (route numbers, pass and coast road names) and bridges, at the Region band (decisions 98, 104, 161).
- **Budgets** (decision 246). Names of land areas (zones, salt pans, hills, wetlands, deserts, forests, plateaus, plains) show only where the area spans at least 120 px on screen, so the larger areas carry names when the map is far out and smaller ones join as it closes in. At most eight of them and five named peaks show at once, the most important first; among near equals, those nearer the screen's center win (up to 0.1 of importance). Seas, oceans, continents, islands, ranges, rivers, settlements and military labels are not budgeted.
- **Collision.** A screen-space placement pass, run when the camera settles or changes band, ranks labels by importance and drops those that collide. Labels fade in and out rather than popping. Between passes, placed labels follow the camera with the placement they won.
- **Rendering.** Signed-distance-field text rendered by the WebGPU pipeline, so text stays sharp at any size: an atlas generated at load time from the font files (opentype.js), drawn as instanced screen-space quads by a TSL shader (decision 98). A single-channel field rounds the sharpest corners only at sizes far above the map's 10–22 px.

## Military Overlays

- Territory tint per faction: the faction colors at 22% over dry land, under rivers, weather and the night tint; neutral land `#8C8C8C` at 8%. The tint follows the territory that placed bases and towns, and its edge is as soft as the coarse grid; the front line over it is sharp (decision 101).
- The front line as a bold line with teeth on the attacker's side; defensive lines dashed. The front is 3 px `#2A2A2A` with a 1.5 px pale casing; teeth are 8 px wide and 6 px tall every 20 px, in the attacker's color. Defensive lines are 1.6 px with 14 px dashes.
- Invasion corridors as named arrows: a 4 px shaft and a 16 px arrowhead in the attacker's color, from the attacker's side across the front, named along the shaft in the attacker's color.
- Sea lanes as dashed routes with convoy icons; chokepoints marked. Lanes are 2 px with 12 px dashes in the color of the side that sails them; chokepoints are hollow `#2A2A2A` diamonds, larger for a chokepoint theater. Only the lanes and chokepoints in the cast's theaters show; convoy icons wait for convoys.
- Air defense coverage as faint rings.
- Formations as NATO-style unit symbols in faction colors; flights as aircraft icons with heading and short trails; convoys and bases as simple vector icons.
- **Icons stand out and can be clicked** (decision 133). Forces that move are badges too, but filled: a disc in the faction color with a dark 1.5 px rim and a pale symbol turned to the unit's heading on screen. Flights are 26 px discs with a four-minute trail (2.5 px, pale casing), carrier groups 30 px discs. Fixed sites are pale tiles (see above), so a glance tells moving forces from places. Every badge has a pale 1.5 px halo, keeps its size at every zoom, and is picked by a click within its radius plus 6 px; the cursor shows a pointer over it. The selected icon grows by a quarter, takes a 3 px amber rim (`#FFC83D`) and draws on top.
- Mission routes as dashed lines (1.5 px; 2.5 px for the selected mission) on selection; every route at once is a debug view.
- Every layer can be toggled.
- **Drawing.** Lines and marks are sized in screen pixels and draped on the relief, with a pale casing (`#F4EFE4`) under each. Dashes and teeth are fixed to the ground: their spacing is the pixel target at the screen center's scale, rounded to a power of two in meters, so they keep their size within a factor of two and never swim. Relief and glyphs never hide an overlay. Territory and front lines show at every band (with a sea-lane theater's own lane); defensive lines, corridors, other lanes and chokepoints from the Theater band down (decision 101).

## Strategic Palette

Starting values, tuned on the globe. Land colors are lighter, softer versions of Part I's terrain shades. With the biome table of decision 204 each biome gets its own fill, derived from Part I's middle shade mixed about 35% toward paper `#F4EFE4` with its saturation capped below the faction colors', and its pattern darker in the same hue; W6 fills in the rows. Until then: The world's biomes map onto these rows: taiga takes the conifer fill, temperate and tropical seasonal forest the temperate-forest fill, temperate and tropical rainforest the rainforest fill, hot and cold deserts the desert fill, alpine terrain and displayed slopes steeper than about 31° to 45° the steep-rock fill, and ice sheets the snow fill. Shrubland, which has no row, takes the midpoint of grassland and savanna. Fills blend across biome boundaries over about 9 km (decision 79).

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
| Damaged target: its site symbol or bridge mark, and its badge's rim (decision 301) | `#D9922E` |
| Destroyed target or cut bridge (decision 301) | `#B0302A` |
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