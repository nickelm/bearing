/**
 * Land albedo in the terrain shader (decision 43): the biome color from the
 * vertex, modified per fragment by
 *
 * - moisture (from the climate texture): drier ground lighter and yellower,
 *   wetter ground darker and greener;
 * - slope: rock on steep ground. Steepness uses the Earth-like reference
 *   slope (physical ÷ reliefScale, as biomes use reference heights, decision
 *   19), so cliffs read as cliffs whatever the exaggeration;
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
import { LAPSE_RATE } from '../../worldgen/climate';
import { WAVE_PERIOD } from '../water/waterShading';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** Season phase of the warmest day after the northern vernal equinox (solstice + ~30 days). */
const WARMEST_PHASE = 0.25 + 30 / 365;

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
    const hRef = max(height, 0).div(this.reliefScale);
    const mean = climate.x.sub(hRef.mul(LAPSE_RATE));
    // Northern summer peaks at WARMEST_PHASE; the south half a year later.
    const hemisphere = clamp(up.y.mul(20), -1, 1);
    const seasonal = cos(this.seasonPhase.sub(WARMEST_PHASE).mul(2 * Math.PI)).mul(hemisphere);
    return mean.add(climate.y.mul(seasonal)).add(this.temperatureOffset) as F;
  }

  /** Detail noise in [-1, 1], faded where its cells are smaller than a few pixels. */
  detailNoise(wrapped: V3): F {
    // fwidth of the wrapped position: meters per pixel.
    const footprint = length(fwidth(wrapped));
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

  /** The land albedo for a fragment. */
  albedo(i: LandInputs): V3 {
    const noise = this.detailNoise(i.wrapped).mul(this.detail);
    const moisture = i.climate.z;

    // Moisture: drier lighter and yellower, wetter darker and greener.
    let a: V3 = i.albedo.mul(
      mix(vec3(1.12, 1.06, 0.9), vec3(0.88, 0.97, 0.9), clamp(moisture.mul(1.6).sub(0.2), 0, 1)),
    ) as V3;
    // Detail: ±12% brightness.
    a = a.mul(noise.mul(0.12).add(1)) as V3;

    // Forest as dark canopy masses with a crisp edge (decision 71): the density
    // is thresholded per fragment, so the edge follows its contour, not the mesh.
    // Shade by the annual mean temperature: conifers in the cold, rainforest in
    // the heat; a value shift (not a hue shift) breaks up large masses.
    let evergreen: F = float(0);
    if (i.forest) {
      const meanT = i.climate.x.sub(max(i.height, 0).div(this.reliefScale).mul(LAPSE_RATE));
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

    // Rock on steep ground (reference slope: about 19° to 35°).
    const steep = length(i.slope).div(this.reliefScale);
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
