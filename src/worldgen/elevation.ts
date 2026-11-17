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
import { Province } from './provinces';
import type { ProvinceMap } from './provinces';

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

/**
 * Relief by province (decision 207), in reference meters. Young collisions
 * rise higher and old ones wear down; plateaus, sutures and hotspot shields add
 * their own uplift; basins and shields sink. Tuning knobs.
 */
export const PROVINCE_RELIEF = {
  /** Amplitude factor of collision and cordillera uplift from young and old runs. */
  youngFactor: 1.25,
  oldFactor: 0.45,
  /** Old ranges are rounded: the ridged modulation keeps this much of its range. */
  oldRidging: 0.3,
  /** High plateaus: uplift on top of the interior crust (about 4.5 km reference in all). */
  plateau: 3700,
  /** Fossil sutures: worn ranges of 1–2.5 km reference. */
  suture: 1500,
  /** Hotspot shields at full strength, as a dome over the edifice's radius. */
  hotspot: 4200,
  /**
   * Basin and range and shields sink a little; more would push them under the
   * sea level quantile and flood the interiors. The basins' depth comes from
   * the fault blocks in the detail stage.
   */
  basinAndRange: -200,
  shield: -150,
  /** Blur passes on each province mask, so changes come over a few cells. */
  blur: 3,
};

/** 1 on cells of province `p`, 0 elsewhere, blurred over `passes` 8-neighbor passes. */
export function provinceWeight(
  grid: CubeGrid,
  province: Uint8Array,
  p: number,
  passes: number,
): Float32Array {
  const n = grid.cellCount;
  let a = new Float32Array(n);
  for (let c = 0; c < n; c++) a[c] = province[c] === p ? 1 : 0;
  let b = new Float32Array(n);
  for (let k = 0; k < passes; k++) {
    for (let c = 0; c < n; c++) {
      let sum = 2 * a[c]!;
      let w = 2;
      for (let q = 0; q < 8; q++) {
        const nb = grid.neighbors8[c * 8 + q]!;
        if (nb >= 0) {
          sum += a[nb]!;
          w++;
        }
      }
      b[c] = sum / w;
    }
    [a, b] = [b, a];
  }
  return a;
}

export function computeUplift(
  grid: CubeGrid,
  params: PlanetParams,
  boundaries: Boundaries,
  r: Rng,
  provinces?: ProvinceMap,
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
      const src = field.nearest[c];
      const s = Math.min(1, boundaries.strength[src] / STRENGTH_SATURATION);
      let v = prof.amplitude * (0.35 + 0.65 * s) * Math.exp(-d * d);
      // Young collisions rise higher, old ones are worn and rounded (decision 207).
      const age = provinces ? provinces.boundaryAge[src]! : 0;
      const ranged = prof.type === BoundaryType.Collision || prof.type === BoundaryType.Cordillera;
      const old = ranged && age === 2;
      if (ranged && age === 1) v *= PROVINCE_RELIEF.youngFactor;
      if (old) v *= PROVINCE_RELIEF.oldFactor;
      if (prof.ridged) {
        grid.center(c, x);
        const rr = 0.45 + 0.9 * ridges.ridged(x.x * 9, x.y * 9, x.z * 9, 4);
        v *= old ? 1 + PROVINCE_RELIEF.oldRidging * (rr - 1) : rr;
      }
      uplift[c] += v;
    }
  }
  if (provinces) addProvinceRelief(grid, params, provinces, uplift, ridges);
  return uplift;
}

function addProvinceRelief(
  grid: CubeGrid,
  params: PlanetParams,
  provinces: ProvinceMap,
  uplift: Float32Array,
  ridges: Noise3,
): void {
  const P = PROVINCE_RELIEF;
  const n = grid.cellCount;
  const x = new Vec3d();
  const plateau = provinceWeight(grid, provinces.province, Province.HighPlateau, P.blur);
  const oldMtn = provinceWeight(grid, provinces.province, Province.OldMountains, P.blur);
  const basin = provinceWeight(grid, provinces.province, Province.BasinAndRange, P.blur);
  const shield = provinceWeight(grid, provinces.province, Province.Shield, P.blur);
  for (let c = 0; c < n; c++) {
    let v = P.plateau * plateau[c]! + P.basinAndRange * basin[c]! + P.shield * shield[c]!;
    if (oldMtn[c]! > 0) {
      grid.center(c, x);
      // Rounded ranges: soft ridges, no sharp crests.
      v += P.suture * oldMtn[c]! * (0.55 + 0.45 * ridges.fbm(x.x * 11, x.y * 11, x.z * 11, 3));
    }
    uplift[c] += v;
  }
  // Hotspot shields: a dome over each edifice, smaller and lower along the chain.
  const d = new Vec3d();
  for (const s of provinces.hotspots) {
    d.set(s.dir[0], s.dir[1], s.dir[2]);
    const reach = s.radius / params.radius;
    const cosReach = Math.cos(reach);
    for (let c = 0; c < n; c++) {
      const cx = grid.centers[3 * c]!;
      const cy = grid.centers[3 * c + 1]!;
      const cz = grid.centers[3 * c + 2]!;
      const dot = cx * d.x + cy * d.y + cz * d.z;
      if (dot < cosReach) continue;
      const t = Math.acos(Math.min(1, dot)) / reach;
      const k = 1 - t * t;
      uplift[c] += P.hotspot * s.strength * k * k;
    }
  }
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
