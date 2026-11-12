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
  length,
  max,
  mix,
  smoothstep,
  sin,
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
}

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
  readonly snowColor = uniform(new Color(0.82, 0.85, 0.9));
  readonly autumnColor = uniform(new Color(0.24, 0.13, 0.04));
  /** Canopy shades from docs/visual-style.md: conifer, temperate broadleaf, rainforest (decision 71). */
  readonly coniferCanopy = uniform(linearHex(0x2c4434));
  readonly broadleafCanopy = uniform(linearHex(0x3b5a33));
  readonly rainforestCanopy = uniform(linearHex(0x2e5a2e));
  /** Forest density at which the canopy closes; the edge is sharp around it. */
  readonly forestThreshold = uniform(0.42);

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
    const continuous = noise.mul(0.12).add(1);
    if (i.face) {
      const shade = this.faceShade(noise, length(i.slope), i.height, i.climate, i.face.jitter);
      a = a.mul(mix(vec3(continuous), shade, this.facets)) as V3;
    } else {
      a = a.mul(continuous) as V3;
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

    // Rock on steep ground (about 19° to 35°): physical slope, since landforms keep
    // Earth's slopes (decision 121).
    const steep = length(i.slope);
    const rock = smoothstep(0.35, 0.7, steep.add(noise.mul(0.15)));
    a = mix(a, this.rockColor.mul(noise.mul(0.25).add(1)), rock) as V3;

    // Snow below about 0 °C, not on cliffs, thin in deserts.
    const cold = smoothstep(0, -5, t);
    const sticks = float(1).sub(smoothstep(0.9, 1.5, steep));
    const wetEnough = smoothstep(0.03, 0.2, moisture);
    // Snow lies under evergreen canopy more than on it: forests stay dark in winter.
    const snow = cold
      .mul(sticks)
      .mul(wetEnough)
      .mul(float(1).sub(evergreen.mul(0.6)));
    a = mix(a, this.snowColor, snow) as V3;

    return mix(i.albedo, a, this.enabled) as V3;
  }
}
