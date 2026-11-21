/**
 * Seasonal surface temperature from the climate texture (decision 42), shared by both
 * views: the simulation view's snow, autumn and frozen lakes (landShading.ts,
 * waterShading.ts) and the strategic map's snow line, sea ice and frozen lakes
 * (decision 87).
 *
 *   T = T_sea − LAPSE_RATE · h_ref + halfRange · cos(2π (phase − WARMEST_PHASE)) · hemisphere
 *
 * with h_ref the Earth-like elevation (m; `earthElevationNode`, decision 122) and the
 * hemisphere sign from the latitude, so the south's summer falls half a year after
 * the north's.
 */
import type { Node } from 'three/webgpu';
import { clamp, cos, max, min, uniform } from 'three/tsl';
import { earthElevation, LAPSE_RATE } from '../../worldgen/climate';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/**
 * `earthElevation` (worldgen/climate.ts) in TSL: the Earth-like elevation (reference m)
 * of a physical height over a valley floor (physical m), the climate texel's w.
 */
export function earthElevationNode(height: F, floor: F, reliefScale: F | number): F {
  // Back to the climate's heights (decision 297): drawn heights are exaggerated.
  const h = max(height, 0).mul(CLIMATE_EXAGGERATION.inverse);
  const f = max(floor, 0).mul(CLIMATE_EXAGGERATION.inverse);
  return min(h, f)
    .div(reliefScale)
    .add(max(h.sub(f), 0)) as F;
}

/**
 * The relief exaggeration of the world on screen (Proposal 0010, decision 297),
 * shared by every renderer that turns a drawn height into a climate: the drawn
 * ground is exaggerated, and climate (snow, seasons, trees by temperature) reads
 * it divided back, so the same ground is as snowy and as wooded at any
 * exaggeration. Set by the renderers when a world arrives (`setClimateExaggeration`).
 */
export const CLIMATE_EXAGGERATION = { value: 1, inverse: uniform(1) };

export function setClimateExaggeration(e: number): void {
  const v = Number.isFinite(e) && e > 0 ? e : 1;
  CLIMATE_EXAGGERATION.value = v;
  CLIMATE_EXAGGERATION.inverse.value = 1 / v;
}

/** A drawn height (m) back at the climate's scale (decision 297). */
export function climateHeight(h: number): number {
  return h > 0 ? h / CLIMATE_EXAGGERATION.value : h;
}

/** `earthElevation` of drawn heights: both divided back first (decision 297). */
export function drawnEarthElevation(height: number, floor: number, reliefScale: number): number {
  return earthElevation(climateHeight(height), climateHeight(floor), reliefScale);
}

/** Season phase (fraction of the year after the northern vernal equinox) of the northern summer peak. */
export const WARMEST_PHASE = 0.25 + 30 / 365;

/** CPU reference: surface temperature (°C) for sea-level mean, half-range, reference height and season. */
export function surfaceTemperature(
  seaLevelMean: number,
  halfRange: number,
  referenceHeight: number,
  upY: number,
  seasonPhase: number,
): number {
  const hemisphere = Math.min(1, Math.max(-1, upY * 20));
  const seasonal = Math.cos((seasonPhase - WARMEST_PHASE) * 2 * Math.PI) * hemisphere;
  return seaLevelMean - Math.max(0, referenceHeight) * LAPSE_RATE + halfRange * seasonal;
}

/** `surfaceTemperature` in TSL, from a climate texel (x: sea-level mean °C, y: half-range K). */
export function surfaceTemperatureNode(climate: V4, referenceHeight: F, up: V3, seasonPhase: F): F {
  const hemisphere = clamp(up.y.mul(20), -1, 1);
  const seasonal = cos(seasonPhase.sub(WARMEST_PHASE).mul(2 * Math.PI)).mul(hemisphere);
  return climate.x.sub(max(referenceHeight, 0).mul(LAPSE_RATE)).add(climate.y.mul(seasonal)) as F;
}
