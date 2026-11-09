/**
 * Stages: uplift, base elevation and sea level.
 *
 * Heights are first built as Earth-like *reference* elevations in meters:
 * crust base plus boundary uplift plus gentle noise. Sea level is the
 * area-weighted `oceanFraction` quantile. The result is then multiplied by
 * `reliefScale` to give physical heights on this planet (decision 14).
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { KM } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { BoundaryType } from './boundaries';
import type { Boundaries } from './boundaries';
import { distanceFromSources, smoothstep, weightedQuantile } from './fields';
import type { PlanetParams } from './params';

interface UpliftProfile {
  type: BoundaryType;
  /** Peak reference elevation change at strength 1 (m). */
  amplitude: number;
  /** Gaussian half-width (m of surface distance). */
  width: number;
  /** Modulate with ridged noise to break ranges into peaks and passes. */
  ridged: boolean;
}

/** Profiles per boundary type, in Earth-like reference meters. Tuning knobs. */
export const UPLIFT_PROFILES: readonly UpliftProfile[] = [
  { type: BoundaryType.Collision, amplitude: 4500, width: 160 * KM, ridged: true },
  { type: BoundaryType.Cordillera, amplitude: 3500, width: 110 * KM, ridged: true },
  { type: BoundaryType.Trench, amplitude: -3500, width: 45 * KM, ridged: false },
  { type: BoundaryType.IslandArc, amplitude: 3200, width: 55 * KM, ridged: true },
  { type: BoundaryType.Ridge, amplitude: 1800, width: 180 * KM, ridged: false },
  { type: BoundaryType.Rift, amplitude: -900, width: 60 * KM, ridged: false },
  { type: BoundaryType.Transform, amplitude: 250, width: 40 * KM, ridged: false },
];

/** Strength above which uplift saturates (relative plate speeds are roughly 0..2). */
const STRENGTH_SATURATION = 1.2;

export function computeUplift(
  grid: CubeGrid,
  params: PlanetParams,
  boundaries: Boundaries,
  r: Rng,
): Float32Array {
  const n = grid.cellCount;
  const uplift = new Float32Array(n);
  const ridges = new Noise3(r.fork('ridges'));
  const x = new Vec3d();
  const sources = new Uint8Array(n);
  for (const prof of UPLIFT_PROFILES) {
    let any = false;
    for (let c = 0; c < n; c++) {
      const s = boundaries.type[c] === prof.type ? 1 : 0;
      sources[c] = s;
      if (s) any = true;
    }
    if (!any) continue;
    const maxAngle = (2.5 * prof.width) / params.radius;
    const field = distanceFromSources(grid, sources, maxAngle);
    for (let c = 0; c < n; c++) {
      const a = field.angle[c];
      if (a === Infinity) continue;
      const d = (a * params.radius) / prof.width;
      const s = Math.min(1, boundaries.strength[field.nearest[c]] / STRENGTH_SATURATION);
      let v = prof.amplitude * (0.35 + 0.65 * s) * Math.exp(-d * d);
      if (prof.ridged) {
        grid.center(c, x);
        v *= 0.45 + 0.9 * ridges.ridged(x.x * 9, x.y * 9, x.z * 9, 4);
      }
      uplift[c] += v;
    }
  }
  return uplift;
}

/** Reference elevation of bare crust as a function of signed continentalness. */
export function crustBaseElevation(c: number): number {
  return (
    -4200 +
    4050 * smoothstep(-0.22, -0.02, c) + // abyssal plain → continental slope → shelf
    200 * smoothstep(-0.02, 0.02, c) + // shelf → coastal lowland
    800 * smoothstep(0.02, 0.5, c) // lowland → interior plateau
  );
}

export interface Elevation {
  /** Physical height above sea level (m), already scaled by reliefScale. */
  height: Float32Array;
  /** Sea level in reference meters, before shifting to zero. */
  seaLevelReference: number;
}

export function computeElevation(
  grid: CubeGrid,
  params: PlanetParams,
  continentalness: Float32Array,
  uplift: Float32Array,
  r: Rng,
): Elevation {
  const n = grid.cellCount;
  const noise = new Noise3(r.fork('noise'));
  const ref = new Float64Array(n);
  const x = new Vec3d();
  for (let c = 0; c < n; c++) {
    grid.center(c, x);
    const gentle = 180 * noise.fbm(x.x * 7, x.y * 7, x.z * 7, 5);
    ref[c] = crustBaseElevation(continentalness[c]) + uplift[c] + gentle;
  }
  const seaLevelReference = weightedQuantile(ref, grid.areas, params.oceanFraction);
  const height = new Float32Array(n);
  for (let c = 0; c < n; c++) height[c] = (ref[c] - seaLevelReference) * params.reliefScale;
  return { height, seaLevelReference };
}
