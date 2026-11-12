/**
 * Land albedo in the terrain shader (decision 43): the biome color from the
 * vertex, modified per fragment by
 *
 * - moisture (from the climate texture): drier ground lighter and yellower,
 *   wetter ground darker and greener;
 * - slope: rock on steep ground. Steepness is the physical slope, since
 *   landforms keep Earth's slopes (decision 121), so cliffs read as cliffs
 *   whatever the exaggeration;
 * - season: the surface temperature is the sea-level mean, lapse-corrected
 *   to the reference height, plus the seasonal half-range times a cosine
 *   peaking about 30 days after the summer solstice (sign by hemisphere).
 *   Snow covers ground from 0 °C (full by −5 °C), except on cliffs and in deserts.
 *   Vegetation (detected by a green albedo) browns as it cools;
 * - detail noise: periodic value noise on the wrapped coordinates of decision
 *   38. It varies albedo at 16–256 m and fades with pixel footprint, standing
 *   in for triplanar textures: 3D noise needs no projection, so it cannot
 *   stretch on cliffs.
 *
 * `surfaceTemperature` is shared with the water shader (frozen lakes) and the
 * forest layer.
 */
import { Color } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  cos,
  dot,
  float,
  floor,
  fract,
  fwidth,
  If,
  length,
  max,
  min,
  mix,
  select,
  smoothstep,
  sin,
  step,
  uniform,
  vec3,
} from 'three/tsl';
import { LAPSE_RATE } from '../../../worldgen/climate';
import { earthElevationNode } from '../../common/seasons';
import { WAVE_PERIOD } from '../water/waterShading';
import { WARMEST_PHASE } from '../../common/seasons';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** Season phase of the warmest day after the northern vernal equinox (solstice + ~30 days). */

export interface LandInputs {
  /** Biome albedo (linear), from the vertex. */
  albedo: V3;
  /** Physical surface gradient (tangent vector, m/m). */
  slope: V3;
  /** Raw surface height (m). */
  height: F;
  /** Unit radial direction. */
  up: V3;
  /** Climate texture sample at `up`. */
  climate: V4;
  /** Fragment position modulo the wave period (decision 38). */
  wrapped: V3;
  /** Forest density 0..1, interpolated from the vertices (decision 44). */
  forest?: F;
  /**
   * Per-face shading (decision 124): the other inputs (except `forest`) are
   * then sampled at the face's center, and the ground takes one of a few
   * shades per face instead of continuous detail noise.
   */
  face?: {
    /** Facet size (m): sets the noise's finest visible octave. */
    spacing: F;
    /** Per-face random value in [0, 1): dithers the shade thresholds. */
    jitter: F;
  };
  /** Landform masks: aridity and glaciation, 0..1 (decision 126), and farmable biome, 0..1 (decision 127). */
  landform?: V3;
  /** The strategic graph's habitability, 0..1: farmland lies on settled land (decision 127). */
  settled?: F;
}

/** Strata on dry ground (decision 126): layer thickness (m), as tileSynth's strataThickness. */
export const STRATA_THICKNESS = 75;

/** sRGB hex to a linear color. */
function linearHex(h: number): Color {
  return new Color().setHex(h);
}

/** Hash of an integer lattice point in [0, 1) (inputs are small integers, so sin is precise). */
function hash3(p: V3): F {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as F;
}

/**
 * Value noise in [-1, 1], periodic with `period` lattice cells along each axis,
 * so it tiles with WAVE_PERIOD when `period · cell = WAVE_PERIOD`.
 */
function periodicValueNoise(p: V3, cell: number): F {
  const period = WAVE_PERIOD / cell;
  const q = p.div(cell);
  const i = floor(q);
  const f = fract(q);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const at = (dx: number, dy: number, dz: number) => {
    const c = i.add(vec3(dx, dy, dz));
    // Wrap the lattice so the noise repeats every `period` cells.
    return hash3(c.sub(floor(c.div(period)).mul(period)) as V3);
  };
  const x00 = mix(at(0, 0, 0), at(1, 0, 0), u.x);
  const x10 = mix(at(0, 1, 0), at(1, 1, 0), u.x);
  const x01 = mix(at(0, 0, 1), at(1, 0, 1), u.x);
  const x11 = mix(at(0, 1, 1), at(1, 1, 1), u.x);
  const y0 = mix(x00, x10, u.y);
  const y1 = mix(x01, x11, u.y);
  return mix(y0, y1, u.z).mul(2).sub(1) as F;
}

/** Field lattice (m): one Voronoi site per cell, so fields are about this wide (decision 127). */
export const FIELD_CELL = 256;

/**
 * The Voronoi field containing wrapped position `p`: its site's lattice cell,
 * wrapped like the detail noise, so neighboring fragments of one field agree
 * and the pattern tiles with WAVE_PERIOD. 3D cells cut by the ground read as
 * irregular polygons, some smaller where the ground slices a cell's corner.
 */
function fieldCell(p: V3): V3 {
  const period = WAVE_PERIOD / FIELD_CELL;
  const q = p.div(FIELD_CELL);
  const i = floor(q);
  const f = fract(q);
  const best = float(1e9).toVar();
  const cell = vec3(0).toVar();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const d = vec3(dx, dy, dz);
        const c = i.add(d);
        const w = c.sub(floor(c.div(period)).mul(period));
        const h = hash3(w as V3);
        const site = d.add(
          vec3(h, fract(h.mul(7.13)), fract(h.mul(13.71)))
            .mul(0.8)
            .add(0.1),
        );
        const r = site.sub(f);
        const dist = dot(r, r);
        cell.assign(select(dist.lessThan(best), w, cell));
        best.assign(min(best, dist));
      }
    }
  }
  return cell as unknown as V3;
}

export class LandShading {
  /** 1 applies rock, snow, seasons and detail; 0 in debug color modes. */
  readonly enabled = uniform(1);
  /** World relief scale (decision 14). */
  readonly reliefScale = uniform(0.157);
  /** Fraction of the year since the northern vernal equinox (calendar.seasonPhase). */
  readonly seasonPhase = uniform(0.4);
  /** Shifts every surface temperature (°C), e.g. to preview a harsher winter. */
  readonly temperatureOffset = uniform(0);
  /** Albedo detail-noise strength (0 = flat colors). */
  readonly detail = uniform(1);
  /** 1 shades each terrain triangle flat with its own normal, 0 smooth (decision 123). */
  readonly facets = uniform(1);
  /** Ground shades per biome when faceted (decision 124; the guide asks for three to five). */
  readonly shades = uniform(4);
  /** Albedo multipliers of the darkest (lush) and palest (dry, high, steep) shade. */
  readonly shadeDark = uniform(new Color(0.84, 0.89, 0.84));
  readonly shadePale = uniform(new Color(1.14, 1.09, 0.97));
  readonly rockColor = uniform(new Color(0.13, 0.12, 0.105));
  /** Dry rock: the cliff-forming sandstones and the slope-forming shales between them (decision 126). */
  readonly cliffRock = [0xb8693c, 0xc98d58, 0x9c4b2c, 0xd9bb8c, 0xa65a36].map((h) =>
    uniform(linearHex(h)),
  );
  readonly slopeRock = uniform(linearHex(0xa8664a));
  readonly snowColor = uniform(new Color(0.82, 0.85, 0.9));
  readonly autumnColor = uniform(new Color(0.24, 0.13, 0.04));
  /** Canopy shades from docs/visual-style.md: conifer, temperate broadleaf, rainforest (decision 71). */
  readonly coniferCanopy = uniform(linearHex(0x2c4434));
  readonly broadleafCanopy = uniform(linearHex(0x3b5a33));
  readonly rainforestCanopy = uniform(linearHex(0x2e5a2e));
  /** Forest density at which the canopy closes; the edge is sharp around it. */
  readonly forestThreshold = uniform(0.42);
  /** Farmland on (1) or off (0), and the crop colors of Part I's palette (decision 127). */
  readonly farmland = uniform(1);
  readonly wheat = uniform(linearHex(0xc8a85a));
  readonly greenCrop = uniform(linearHex(0x6e8b3d));
  readonly fallow = uniform(linearHex(0x8a6a45));
  readonly pasture = uniform(linearHex(0x7f944f));

  /**
   * How much of a point is farmland, 0..1 (decision 127): settled land (the
   * strategic graph's habitability from 0.25 to 0.45, as the map's farmland,
   * decision 80) in farmable biomes, on flat (under about 5–9°) lowland
   * (Earth-like elevation under about 1.2–1.8 km). Faceted, whole faces are
   * fields or not, dithered by the jitter.
   */
  farmCover(settled: F, farmable: F, steep: F, elevation: F, jitter: F, faceted: F): F {
    const m = smoothstep(0.25, 0.45, settled)
      .mul(farmable)
      .mul(smoothstep(0.16, 0.08, steep))
      .mul(smoothstep(1800, 1200, elevation))
      .mul(this.farmland);
    const smooth = smoothstep(0.35, 0.65, m);
    const face = step(0.5, m.add(jitter.sub(0.5).mul(0.3)));
    return mix(smooth, face, faceted) as F;
  }

  /**
   * The crop color of the field at wrapped position `p`: wheat, fallow, green
   * crop or pasture, with more wheat on drier land, and ±6% per field. Where
   * the footprint (facet size or pixel) outgrows the fields, the colors draw
   * toward their mean, so distant faces do not speckle.
   */
  fieldColor(p: V3, moisture: F, footprint: F): V3 {
    const cell = fieldCell(p);
    const r = hash3(cell.add(vec3(3.1, 5.7, 1.3)) as V3);
    const wheatShare = mix(float(0.45), float(0.2), clamp(moisture.mul(1.5), 0, 1));
    const fallowEnd = wheatShare.add(0.15);
    const greenEnd = fallowEnd.add(0.25);
    const crop = select(
      r.lessThan(wheatShare),
      this.wheat,
      select(
        r.lessThan(fallowEnd),
        this.fallow,
        select(r.lessThan(greenEnd), this.greenCrop, this.pasture),
      ),
    );
    const varied = crop.mul(fract(r.mul(53.7)).sub(0.5).mul(0.12).add(1));
    const crops = [this.wheat, this.fallow, this.greenCrop, this.pasture] as unknown as V3[];
    const mean = crops[0]!.add(crops[1]!).add(crops[2]!).add(crops[3]!).mul(0.25);
    const blur = smoothstep(FIELD_CELL * 0.5, FIELD_CELL * 3, footprint).mul(0.6);
    return mix(varied, mean, blur) as V3;
  }

  /** Surface temperature (°C) today at a height (m) and direction, from the climate sample. */
  surfaceTemperature(climate: V4, height: F, up: V3): F {
    // Earth-like elevation over the valley floor in the texel's w (decision 122).
    const hRef = earthElevationNode(height, climate.w, this.reliefScale);
    const mean = climate.x.sub(hRef.mul(LAPSE_RATE));
    // Northern summer peaks at WARMEST_PHASE; the south half a year later.
    const hemisphere = clamp(up.y.mul(20), -1, 1);
    const seasonal = cos(this.seasonPhase.sub(WARMEST_PHASE).mul(2 * Math.PI)).mul(hemisphere);
    return mean.add(climate.y.mul(seasonal)).add(this.temperatureOffset) as F;
  }

  /**
   * Detail noise in [-1, 1], faded where its cells are smaller than a few
   * footprints: meters per pixel by default (fwidth of the wrapped position),
   * or the facet size, so that noise sampled at face centers stays coarser
   * than the faces (decision 124).
   */
  detailNoise(wrapped: V3, footprint: F = length(fwidth(wrapped)) as F): F {
    let n: F = float(0);
    let total = 0;
    for (const [cell, weight] of [
      [256, 0.5],
      [64, 0.3],
      [16, 0.2],
    ] as const) {
      const visible = smoothstep(2, 6, float(cell).div(max(footprint, 1e-3)));
      n = n.add(periodicValueNoise(wrapped, cell).mul(weight).mul(visible)) as F;
      total += weight;
    }
    return n.div(total) as F;
  }

  /**
   * Which of `shades` ground shades a face takes (decision 124), as an albedo
   * multiplier. Steep, high and dry faces lean pale; wet ones dark; the
   * low-frequency noise makes patches several faces wide, and the per-face
   * jitter breaks their edges along facets.
   */
  faceShade(noise: F, steep: F, height: F, climate: V4, jitter: F): V3 {
    const elevation = earthElevationNode(height, climate.w, this.reliefScale);
    const score = float(0.5)
      .add(noise.mul(0.9))
      .add(clamp(steep.mul(0.5), 0, 0.25))
      .add(clamp(elevation.div(8000), -0.05, 0.2))
      .sub(climate.z.sub(0.4).mul(0.3))
      .add(jitter.sub(0.5).mul(0.35));
    const n = max(this.shades, 2);
    const k = clamp(floor(score.mul(n)), 0, n.sub(1));
    return mix(this.shadeDark, this.shadePale, k.div(n.sub(1))) as V3;
  }

  /**
   * Rock cover 0..1 on steep ground (about 19° to 35°): physical slope, since
   * landforms keep Earth's slopes (decision 121). Faceted, a face is all rock
   * or none, switching at about 27° with the noise and jitter dithering the
   * line along facets (decision 125); smooth, it blends.
   */
  rockCover(steep: F, noise: F, jitter: F, faceted: F): F {
    const smooth = smoothstep(0.35, 0.7, steep.add(noise.mul(0.15)));
    const face = step(0.52, steep.add(noise.mul(0.15)).add(jitter.sub(0.5).mul(0.12)));
    return mix(smooth, face, faceted) as F;
  }

  /**
   * Snow cover 0..1 from the surface temperature (°C), slope and moisture:
   * below about 0 °C, not on faces steeper than about 30–45° (decision 126),
   * thin in deserts. Faceted, a face is
   * snow-covered or bare, switching where the smooth cover would be half
   * (about −2.5 °C on gentle, wet ground), dithered by the jitter (decision 125).
   */
  snowCover(t: F, steep: F, moisture: F, jitter: F, faceted: F): F {
    const cold = smoothstep(0, -5, t);
    // Snow slides off faces steeper than about 30–45° (decision 126): high ranges show rock.
    const sticks = float(1).sub(smoothstep(0.55, 1.0, steep));
    const wetEnough = smoothstep(0.03, 0.2, moisture);
    const smooth = cold.mul(sticks).mul(wetEnough);
    const face = step(0.5, smooth.add(jitter.sub(0.5).mul(0.2)));
    return mix(smooth, face, faceted) as F;
  }

  /** The land albedo for a fragment. */
  albedo(i: LandInputs): V3 {
    // Per face, noise finer than a few facets would only speckle (decision 124).
    const footprint = i.face
      ? (mix(length(fwidth(i.wrapped)), i.face.spacing, this.facets) as F)
      : undefined;
    const noise = this.detailNoise(i.wrapped, footprint).mul(this.detail);
    const moisture = i.climate.z;

    // Moisture: drier lighter and yellower, wetter darker and greener.
    let a: V3 = i.albedo.mul(
      mix(vec3(1.12, 1.06, 0.9), vec3(0.88, 0.97, 0.9), clamp(moisture.mul(1.6).sub(0.2), 0, 1)),
    ) as V3;
    // Detail: ±12% brightness, or one of a few shades per face.
    const continuous = vec3(noise.mul(0.12).add(1));
    const shadeMul = (
      i.face
        ? mix(
            continuous,
            this.faceShade(noise, length(i.slope), i.height, i.climate, i.face.jitter),
            this.facets,
          )
        : continuous
    ) as V3;
    a = a.mul(shadeMul) as V3;
    const faceted = (i.face ? this.facets : float(0)) as F;
    const jitter = (i.face ? i.face.jitter : float(0.5)) as F;
    const steep = length(i.slope);

    // Farmland (decision 127): a patchwork of crop colors on settled, flat lowland,
    // a field per Voronoi cell, faintly shaded per face. Only farmed points pay for
    // the cell search.
    if (i.settled && i.landform) {
      const elevation = earthElevationNode(i.height, i.climate.w, this.reliefScale);
      const farm = this.farmCover(i.settled, i.landform.z, steep, elevation, jitter, faceted);
      // Derivatives stay outside the branch (decision 69).
      const fieldFootprint = (footprint ?? length(fwidth(i.wrapped))) as F;
      const field = vec3(0).toVar();
      If(farm.greaterThan(0), () => {
        field.assign(this.fieldColor(i.wrapped, moisture, fieldFootprint));
      });
      a = mix(a, field.mul(mix(vec3(1), shadeMul, 0.35)), farm) as V3;
    }

    // Forest as dark canopy masses with a crisp edge (decision 71): the density
    // is thresholded per fragment, so the edge follows its contour, not the mesh.
    // Shade by the annual mean temperature: conifers in the cold, rainforest in
    // the heat; a value shift (not a hue shift) breaks up large masses.
    let evergreen: F = float(0);
    if (i.forest) {
      const meanT = i.climate.x.sub(
        earthElevationNode(i.height, i.climate.w, this.reliefScale).mul(LAPSE_RATE),
      );
      const conifer = smoothstep(9, 3, meanT);
      const tropical = smoothstep(18, 24, meanT);
      const shade = mix(
        mix(this.broadleafCanopy, this.coniferCanopy, conifer),
        this.rainforestCanopy,
        tropical,
      ).mul(noise.mul(0.18).add(1));
      const canopy = smoothstep(
        this.forestThreshold.sub(0.03),
        this.forestThreshold.add(0.03),
        i.forest.add(noise.mul(0.08)),
      ) as F;
      evergreen = max(conifer, tropical).mul(canopy) as F;
      a = mix(a, shade, canopy) as V3;
    }

    // Vegetation browns as it cools (deciduous autumn and winter).
    const t = this.surfaceTemperature(i.climate, i.height, i.up).add(noise.mul(1.5));
    const green = clamp(a.y.sub(max(a.x, a.z)).mul(12), 0, 1);
    const autumn = smoothstep(10, 2, t).mul(green).mul(0.75).mul(float(1).sub(evergreen));
    a = mix(a, this.autumnColor.mul(noise.mul(0.2).add(1)), autumn) as V3;

    // Rock and snow switch per face when faceted (decision 125), and blend otherwise.
    const rock = this.rockCover(steep, noise, jitter, faceted);
    // Three rock shades per face, or continuous noise.
    const rockShade = clamp(floor(noise.mul(0.8).add(jitter).mul(3)), 0, 2)
      .mul(0.18)
      .add(0.82);
    const rockTone = mix(noise.mul(0.25).add(1), rockShade, faceted);
    // Dry rock is layered and red (decision 126): each stratum's cliff in one of the
    // sandstone shades, its foot in the shale; moist rock stays gray.
    const dryRock = i.landform
      ? smoothstep(0.3, 0.75, i.landform.x)
      : smoothstep(0.32, 0.14, moisture);
    const layer = i.height.div(STRATA_THICKNESS);
    const k = floor(layer);
    const inLayer = fract(layer);
    const pick = hash3(vec3(k, k.mul(0.37), 7));
    let cliff: V3 = this.cliffRock[0]! as unknown as V3;
    for (let c = 1; c < this.cliffRock.length; c++) {
      cliff = mix(cliff, this.cliffRock[c]!, step(c / this.cliffRock.length, pick)) as V3;
    }
    const banded = mix(this.slopeRock, cliff, smoothstep(0.08, 0.2, inLayer));
    // Dry ground below the cliffs takes the rock's tint too: talus and red sand.
    a = mix(a, a.mul(mix(vec3(1), vec3(1.12, 0.86, 0.72), dryRock.mul(0.6))), dryRock) as V3;
    a = mix(a, mix(this.rockColor, banded, dryRock).mul(rockTone), rock) as V3;

    // Snow lies under evergreen canopy more than on it: forests stay dark in winter.
    const snow = this.snowCover(t, steep, moisture, jitter, faceted).mul(
      float(1).sub(evergreen.mul(0.6)),
    );
    // Two snow shades per face: sunlit faces still differ, as in the reference board.
    const snowTone = mix(float(1), step(0.5, jitter).mul(0.06).add(0.94), faceted);
    a = mix(a, this.snowColor.mul(snowTone), snow) as V3;

    return mix(i.albedo, a, this.enabled) as V3;
  }
}
