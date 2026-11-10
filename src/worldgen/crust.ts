/**
 * Stage: continental crust from plate types (decision 46).
 *
 * Unsteered: the crust follows the plates' types (drawn in the plates stage),
 * not a planned continent layout.
 * - The base field is the signed great-circle distance to the interface
 *   between continental and oceanic plates: positive inside continental plates.
 * - It is sampled at a domain-warped position, so coasts do not trace plate
 *   boundaries, and roughened with noise.
 * - It is then shifted so that exactly the land fraction of the planet's area
 *   lies above zero.
 *
 * Continental plates cover more than the land fraction (`CONTINENTAL_AREA_MARGIN`
 * in plates.ts), so the threshold falls inside them: most coasts are passive
 * margins, and boundaries between continental plates raise interior ranges.
 * The result is a signed "continentalness": > 0 continental, < 0 oceanic.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { Vec3d } from '../core/vec3d';
import { clamp, distanceFromSources, weightedQuantile } from './fields';
import type { PlanetParams } from './params';
import type { Plate } from './plates';

/**
 * Distance (radians of arc) over which the base field ramps from the plate
 * interface to ±1. Similar in slope to the earlier continent cones.
 */
export const CRUST_DISTANCE_SCALE = 0.9;
/** Amplitude of the domain warp (unit-sphere units) that bends coasts away from plate boundaries. */
const WARP = 0.28;
/** Amplitude of the roughening noise added to the base field. */
const ROUGH = 0.22;

/** Signed angle to the continental/oceanic plate interface; > 0 on continental plates. */
export function plateTypeDistance(
  grid: CubeGrid,
  plates: readonly Plate[],
  plateOf: Uint8Array,
): Float64Array {
  const n = grid.cellCount;
  const continental = new Uint8Array(n);
  const oceanic = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (plates[plateOf[c]]!.continental) continental[c] = 1;
    else oceanic[c] = 1;
  }
  const toContinent = distanceFromSources(grid, continental).angle;
  const toOcean = distanceFromSources(grid, oceanic).angle;
  const out = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    // A cell is at distance 0 from its own type; the other distance is the
    // way to the interface. Infinity (only one type exists) clamps later.
    out[c] = continental[c] ? toOcean[c] : -toContinent[c];
  }
  return out;
}

/** Signed continentalness per cell; positive cells cover (1 − oceanFraction) of the area. */
export function continentalCrust(
  grid: CubeGrid,
  params: PlanetParams,
  plates: readonly Plate[],
  plateOf: Uint8Array,
  r: Rng,
): Float32Array {
  const signed = plateTypeDistance(grid, plates, plateOf);
  const warp = new Noise3(r.fork('warp'));
  const rough = new Noise3(r.fork('rough'));
  const field = new Float64Array(grid.cellCount);
  const x = new Vec3d();
  const w = new Vec3d();
  for (let c = 0; c < grid.cellCount; c++) {
    grid.center(c, x);
    // Domain warp bends the plate interface into irregular coastlines.
    w.set(
      x.x + WARP * warp.fbm(x.x * 2.2 + 11.1, x.y * 2.2, x.z * 2.2, 4),
      x.y + WARP * warp.fbm(x.x * 2.2, x.y * 2.2 + 23.7, x.z * 2.2, 4),
      x.z + WARP * warp.fbm(x.x * 2.2, x.y * 2.2, x.z * 2.2 + 37.3, 4),
    ).normalize();
    const base = clamp(signed[grid.cellOfDirection(w)] / CRUST_DISTANCE_SCALE, -1, 1);
    field[c] = base + ROUGH * rough.fbm(x.x * 5, x.y * 5, x.z * 5, 5);
  }
  const threshold = weightedQuantile(field, grid.areas, params.oceanFraction);
  const out = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) out[c] = field[c] - threshold;
  return out;
}
