# Plan: Ground detail for low flight (track G)

Bearing is a cartoony browser game; the values and systems here serve gameplay (README.md, What Bearing Is; CLAUDE.md rule 22).

_Drafted 2026-11-16 from the owner's direction of the same day (decision 168). The tasks are in `TODO.md` under the ground detail track; later decisions record what each milestone changes._

_Audit 2026-11-18 (decision 229): the downwash this plan left to H3 is built (decisions 176, 182, 188, 191), and the micro-facets are off by default (decision 197). Milestones are scheduled by `docs/roadmap.md` (decision 228)._

## Goal

Make the ground within a few hundred meters of a low camera worth looking at, and make it tell a helicopter pilot their height and drift, without adding cost at working altitude. The look stays faceted and slightly cartoony, in the spirit of a painted fantasy MMO rather than a photograph: fat, chunky grass tufts; hefty, flat-shaded, low-poly boulders; soft, wispy dust.

## The owner's direction

1. **Keep the facets; never pursue photorealism.** Fine detail must read as more of the same faceted world, not as a texture laid over it.
2. **Comic, slightly cartoony.** Chunky shapes, few colors per object, light tips and dark bases, broad value steps.
3. **Fat tufts, hefty boulders.** Grass comes in clumps of a few wide blades; rocks are a dozen to forty faces, never sculpted.
4. **Soft air.** Dust, spray and kicked-up snow are wispy and soft, as the clouds and fog are (Part I, principle 1).
5. **Pay only near the ground.** Above a few hundred meters the frame costs what it costs today.

## What exists

| Area                                | State                                                                                                                     | Where                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Terrain facets                      | Face normals from screen-space derivatives; the finest tile level gives 24 m facets                                       | `render/sim/terrain/facets.ts` (decision 123)                |
| Per-face shading                    | Albedo evaluated at the face's center, one of a few shades per face                                                       | `faceShading.ts` (decision 124)                              |
| Detail noise                        | Periodic value noise on the wrapped coordinates at 16–256 m, ±12% brightness, faded by pixel footprint                    | `landShading.ts` (decisions 38, 124)                         |
| Land cover                          | Biome, moisture, slope (rock), snow, seasons, farmland cells, marsh, sand and gravel bars, roads, pavement                | `landShading.ts`, `canopyNode.ts`, `water/`, `infra/`        |
| Instanced placement near the camera | Per quarter of a level-10 tile, deterministic, masked by water, roads, towns and clearings, heights from `surfaceSampler` | `render/sim/forest/forestLayer.ts` (decisions 148, 150, 166) |
| Shared placement fields             | Canopy height and stands as pure functions the game engine can call                                                               | `worldgen/canopy.ts`                                         |
| Model kit                           | JSON specs built in code, baked occlusion, far models                                                                     | `render/common/models/` (decision 106)                       |
| Wind                                | Hashed gusts, no random numbers, capped near the ground                                                                   | `sim/flight/wind.ts` (decision 143)                          |
| Particles                           | Rain, snow and dust with wind, lit by the air they fall through                                                           | `render/sim/weather/precipitation.ts` (decision 142)         |
| Downwash                            | Planned for H3: dust, snow, spray and a water ring by surface and power                                                   | `TODO.md`, H3                                                |

Below about 20 m nothing in the terrain changes faster than the 16 m noise cell, and a 24 m facet is one flat color. That is why a hover gives no sense of height or drift today.

## Design

Three layers, each switched off well before it stops paying for itself.

### 1. Micro-facets in the ground shader (G1)

_Off by default since decision 197 (too costly near the ground on the owner's machine); a Free Flight graphics option turns them on._

A virtual mesh, finer than the real one, drawn only in the shader. Each octave is a height field on a square lattice split along its diagonal, with a hashed value at each lattice point and linear inside each triangle, laid on the plane across the world axis nearest the terrain facet's normal. Its gradient is constant inside a triangle, so the ground falls into small flat triangles about a cell across. A fragment tilts the face normal by its cell's gradient and takes its cell's shade step. Every fragment of a cell shares one normal and one shade, so the result is a bump map that obeys the facet rule: stepped, never smooth or noisy. Three octaves (4, 1.2 and 0.45 m) are weighted by land cover (`render/sim/terrain/microFacets.ts`, decisions 171, 178). A first version cut a 3D lattice of tetrahedra with the ground; its slivers aliased into moiré.

| Land cover                | Cell           | Tilt           | Character                                                                                                                               |
| ------------------------- | -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Grass, pasture            | 1.5 m          | ±8°            | Soft lumps, two or three greens                                                                                                         |
| Scrub, dry grass          | 1.2 m          | ±10°           | Mottled straw and soil                                                                                                                  |
| Soil, fallow              | 1 m            | ±6°            | Clods; on fields, stretched across the furrows                                                                                          |
| Crop fields               | 0.7–1.1 m rows | stepped ridges | Furrows along each field's own heading (from its Voronoi cell hash, decision 162), by crop (decision 183); off for now (decision 187)   |
| Gravel, river bars, scree | 0.6 m          | ±18°           | Sharp, high contrast                                                                                                                    |
| Rock faces                | 3 m            | ±20°           | Chiseled planes; strata keep their bands (decision 126)                                                                                 |
| Sand, desert              | ripples, 0.9 m | two faces      | A long windward and a short lee face, crests snaking, along one prevailing heading per world (decision 183); off for now (decision 187) |
| Snow                      | 4 m            | none           | Faint shade steps only; the normal and the sparkle stay as they are (decision 139)                                                      |
| Marsh                     | 1 m            | ±4°            | Hummocks around the pools                                                                                                               |

- **Coordinates.** The lattice lies on the wrapped coordinates of decision 38, with every cell a divisor of the wave period, so the pattern stays nailed to the ground as the camera moves, continues across meshes and keeps float32 precision. The projection plane is chosen per terrain facet, so it changes only along facet edges, and stretches cells by at most √3 on the steepest faces (decision 178).
- **Fade.** Tilt and shade steps fade where a micro-triangle shrinks below about 4 px, so nothing shimmers; the derivatives are taken before any branch (decision 69).
- **Cost gate.** A uniform switches the evaluation off while the camera is more than 600 m above the ground, and a per-fragment distance test skips it beyond 600 m; the detail fades out from 360 m. At altitude the cost is one uniform branch.
- **Glints.** Wet ground, ice and smooth rock take a specular flash per micro-facet when its normal mirrors the sun toward the camera, scaled by wetness for wet ground (decision 169).

### 2. Ground cover kit (G2)

As built (decision 172; `tools/models/cover.py` writes the specs, class `cover`, 8–40 triangles):

| Model                                  | Triangles | Size       | Notes                                                                                                    |
| -------------------------------------- | --------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| Grass tuft, dry tuft                   | 21        | 0.3–0.5 m  | Seven fat blades, each a three-sided spike 20 cm wide at the base, leaning out; dark base, light tip     |
| Flower tufts (cream, yellow, violet)   | 31–39     | 0.4 m      | Five blades with two or three flat heads nestled among them (decision 169)                               |
| Tussock                                | 36        | 0.7 m      | Eight wide blades round a low dome                                                                       |
| Reed clump                             | 40        | 1.1–1.4 m  | Eight tall blades and two cattails                                                                       |
| Bush, dry bush                         | 36        | 1–1.2 m    | Three faceted domes in three leaf shades                                                                 |
| Boulder (small, medium, large, lichen) | 20–40     | 0.8–3.4 m  | Jittered, flattened icosahedra, sunk a little; per-face shades from the `rock` and `rock-lichen` schemes |
| Slab                                   | 24        | 2.6 m      | Two stacked sandstone strata, the upper set back                                                         |
| Pebbles                                | 36        | 0.5 m wide | Three low four-sided stones                                                                              |

- **Color from the ground.** Each item takes the open ground's color at its cell (the tile vertex color the terrain starts from, with the land shader's moisture tint), computed on the CPU at placement; green parts of plants take its brightness and half its hue under the model's own light and dark shades, and brown with the season where the ground is green. Rocks keep their own shades. Mismatched cover is the most common reason ground cover looks pasted on (decision 174).
- **No thin parts.** Blades are at least 10 cm wide at the base (Part I, principle 4).

### 3. Placement and the ring (G3)

- **A shared, pure placement function** in `worldgen/groundCover.ts`, beside `canopy.ts`: given a point, it returns what grows or lies there from integer cell hashes, biome, moisture, slope, snow and the masks below. No RNG stream is drawn, so no other stage changes (rule 5), and the game engine can ask the same question later.
- **Cells.** One cell per level-10 sample (about 6 m on the campaign world), five candidate slots each; clumps of grass and fields of boulders from patterns over blocks of five cells, and one flower color per block of nine (decision 174).
- **Masks.** None in water or protected channels, on roads, runways, taxiways, pads or rail ballast, in built-up patches, or where the canopy shell covers the ground; tufts thin into snow and vanish under full snow; road verges and field edges get a denser band.
- **On the drawn surface.** Each instance sits on the triangle the terrain actually draws, interpolated from the finest level's mesh vertices on the mesh's own diagonal, and with the terrain's height exaggeration. A 0.5 m tuft on the smooth height instead of the facet would float or sink visibly. The ring must stay inside the range where the finest level is guaranteed; a test asserts it.
- **The ring.** Chunks of an eighth of a level-10 tile are placed a few rows per frame; one instanced mesh per kind holds the items within the kind's range and the view cone, refilled from an anchor at the eye whenever the eye moves 6 m or turns about 11° (decision 174).

| Layer                                   | Full density to | Fades out by | Off above (camera height above ground) |
| --------------------------------------- | --------------- | ------------ | -------------------------------------- |
| Micro-facets                            | 360 m           | 600 m        | 600 m                                  |
| Tufts, flowers, pebbles                 | 84–105 m        | 120–150 m    | 120–150 m                              |
| Tussocks, reeds, small boulders, bushes | 154–315 m       | 220–450 m    | 220–450 m                              |
| Boulders, slabs                         | 455–560 m       | 650–800 m    | 650–800 m                              |

Instances shrink into the ground over the last stretch of their range, as trees do. Ranges scale with the quality tiers of _Performance Budgets_.

### 4. Motion (G4)

Motion is what turns ground detail into a height and drift cue.

- **Wind sway.** Tufts, tussocks, reeds and bushes lean and bob with the wind's gusts, evaluated per instance from the same hashed gust field the flight model uses, so a gust visible in the grass is the gust the aircraft feels.
- **Downwash.** Under a rotor, cover within about one and a half rotor diameters flattens outward from the rotor's ground point, in rings that travel out and pulse with power. Flattened blades show their lighter side, so the ring is visible in the shading too. The ring's radius and strength follow height and disc loading; a pilot reads height from its size and drift from its offset.

### 5. Dust, spray and snow (G5, with H3's downwash task)

- **Soft sprites.** Wispy, low-opacity sprites with noise-eroded edges, faded against the depth buffer so they never cut a hard line into the ground, and stretched along their motion. They roll outward from the rotor's ground point in a low toroidal billow and drift with the wind.
- **By surface.** Ochre dust on dry soil and sand, gray grit on gravel, white powder over snow, spray and a ruffled ring over water, and on wet or green ground nothing but a few leaves and blades.
- **Lit like the air.** The sprites take the light of the air they are in, as rain and dust particles do (decision 142), and go through the weather's particle overlay, which already has the quality governor's control over its count (decision 143).
- Later sources (wheels on dirt strips, vehicles on gravel roads, impacts) use the same emitter.

## Budgets

| Camera height above ground | Extra draw calls | Extra triangles                    | Extra GPU time at 1408 × 792 |
| -------------------------- | ---------------- | ---------------------------------- | ---------------------------- |
| Above 600 m                | 0                | 0                                  | one uniform branch           |
| 150–600 m                  | ≤ 6              | ≤ 0.05 M                           | ≤ 0.3 ms                     |
| Below 150 m                | ≤ 15             | ≤ 0.35 M (laptop), 0.15 M (tablet) | ≤ 1 ms                       |

The densest view (hover at 10 m over grass by a forest edge) must still fit the 2 M triangle and 500 draw-call budgets with the trees. `PERF=n` in `tools/render.preview.ts` measures each row.

## Milestones

| Milestone        | Steps                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1. Micro-facets | Lattice in the land shader, cover table, mid-scale noise, fades and gate; preview views `hover` (5 m), `skid` (20 m), `nap` (60 m) over grass, scrub, scree, field and dune; `PERF` at 1 km proving no cost    |
| G2. Kit          | The model specs above; `tools/models.preview.ts` sheets; triangle counts against the table                                                                                                                     |
| G3. Placement    | `worldgen/groundCover.ts` with tests (determinism, masks, no cover in channels or on pavement, density by biome); the ring layer; heights on the drawn triangle with a test; color from `LandShading`; budgets |
| G4. Motion       | Wind sway from the gust field; downwash flattening from the helicopter's rotor state; a Free Flight check in a hover at 5, 15 and 30 m                                                                         |
| G5. Dust         | Soft sprites by surface through the particle overlay; closes H3's downwash task                                                                                                                                |

Each is a visual milestone: it closes after Part I's acceptance checks and the new check 11 below.

## Changes to the style guide

Decision 168 makes these in `docs/visual-style.md`:

- Principle 6 keeps working distance as the priority, and adds that detail near a low camera serves helicopter flight and must cost nothing above it.
- _What to avoid_ forbids smooth or noisy high-frequency texture and keeps stepped detail.
- _Terrain_ gains a _Ground detail near the ground_ item.
- _Acceptance checks_ gain check 11: hovers at 5 m and 30 m over grassland, scrub and scree, where the ground shows height and drift, without visible repetition, shimmer or pasted-on cover.

## The owner's answers (decision 169)

1. **Flowers: yes.** Sparse, muted flower tufts in meadows, two or three colors per biome, in G2 and G3.
2. **Boulders block: yes.** The game engine treats boulders taller than about 0.8 m as landing obstacles through the shared placement function (H3's landing zones).
3. **Dust: sprites** through the particle overlay.
4. **Snow keeps its sparkle.** The micro-facets add only faint shade steps on snow and leave its normal and its sparkle (decision 139) alone.
5. **Light on wet ground, ice and smooth rock.** Each micro-facet can glint: on wet ground (with the weather's wetness), on ice and on smooth or polished rock, a micro-facet whose tilted normal mirrors the sun toward the camera lights up as one small flat flash, the stepped counterpart of the snow's sparkle.

## Risks

- **Finest level near the camera.** The placement assumes the finest tile level draws within the ring at every height under the gate. If the quadtree can draw a coarser level there, cover floats or sinks. G3 tests it first.
- **Repetition.** Hash-based kits repeat if the kit is small. Each model gets scale, rotation, lean and shade jitter, and clusters vary in count.
- **Cube-face seams.** The lattice's frame switches at seams; the blend must be checked on a seam view.
