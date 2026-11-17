/**
 * Stage: climate modifiers (proposal 0007, decision 209), after climate.
 *
 * Local modifiers that break the broad climate bands, as fields the biome table
 * reads; the climate maps themselves are unchanged, so every stage that reads
 * them (drainage, the weather) keeps its inputs.
 *
 *  - **Precipitation seasonality**, −1 winter-wet to +1 summer-wet: the
 *    monsoon belt (about 10–28° of latitude) is summer-wet; west coasts at
 *    about 30–44° are winter-wet (Mediterranean), fading inland over 600 km.
 *  - **Fog** from cold currents on subtropical west coasts (about 12–34°),
 *    fading inland over 200 km and varying in strength along the coast.
 *  - **Ecotones**: noise that shifts temperature and moisture a little, so
 *    biome boundaries interfinger instead of following isolines.
 *
 * Continentality and rain shadows already come from the climate stage
 * (continental chill, orographic rainout); aspect acts in the shader and the
 * canopy, where the faces are. Distances are regional extents on the planet
 * (decision 205). Noise draws from `rng(seed, "climate-modifiers")`.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { DEG, KM } from '../core/units';
import { Vec3d } from '../core/vec3d';
import { smoothstep } from './fields';

export interface ClimateModifiers {
  /** −1 winter-wet … +1 summer-wet. */
  seasonality: Float32Array;
  /** Fog tendency from a cold current, 0..1. */
  fog: Float32Array;
  /** Ecotone noise, about −1..1. */
  ecotone: Float32Array;
  /** Moisture offset from the continent's character (decision 210); absent: none. */
  moistureBias?: Float32Array;
  /** Planet radius (m), for slopes on any grid. */
  radius: number;
}

export const MODIFIER_TUNING = {
  /** Mediterranean reach inland from a west coast, and fog's. */
  mediterraneanReach: 600 * KM,
  fogReach: 200 * KM,
  /** Steps of the westward search for the sea. */
  searchStep: 25 * KM,
  /** Ecotone noise frequency (unit sphere; 40 ≈ features of 25 km). */
  ecotoneFrequency: 40,
};

export function computeClimateModifiers(
  grid: CubeGrid,
  radius: number,
  height: Float32Array,
  r: Rng,
): ClimateModifiers {
  const T = MODIFIER_TUNING;
  const n = grid.cellCount;
  const seasonality = new Float32Array(n);
  const fog = new Float32Array(n);
  const ecotone = new Float32Array(n);
  const currents = new Noise3(r.fork('currents'));
  const eco = new Noise3(r.fork('ecotones'));
  const x = new Vec3d();
  const east = new Vec3d();
  const q = new Vec3d();
  const north = new Vec3d(0, 1, 0);
  const maxSteps = Math.ceil(T.mediterraneanReach / T.searchStep);
  for (let c = 0; c < n; c++) {
    grid.center(c, x);
    const f = T.ecotoneFrequency;
    ecotone[c] = Math.max(-1, Math.min(1, 1.6 * eco.fbm(x.x * f, x.y * f, x.z * f, 3)));
    if (height[c]! <= 0) continue;
    const lat = Math.asin(Math.max(-1, Math.min(1, x.y))) / DEG;
    const alat = Math.abs(lat);
    // Distance to the sea westward along the parallel (Infinity beyond the reach).
    east.copy(north).cross(x);
    let west = Infinity;
    if (east.length() > 1e-6) {
      east.normalize();
      for (let k = 1; k <= maxSteps; k++) {
        const a = (k * T.searchStep) / radius;
        q.copy(x).scale(Math.cos(a)).addScaled(east, -Math.sin(a));
        if (height[grid.cellOfDirection(q)]! <= 0) {
          west = k * T.searchStep;
          break;
        }
      }
    }
    const monsoon = smoothstep(8, 13, alat) * (1 - smoothstep(24, 30, alat));
    const medBand = smoothstep(28, 32, alat) * (1 - smoothstep(40, 46, alat));
    const westMed = west === Infinity ? 0 : 1 - west / T.mediterraneanReach;
    const s = 0.85 * monsoon - 0.95 * medBand * Math.max(0, westMed);
    seasonality[c] = Math.max(-1, Math.min(1, s));
    const fogBand = smoothstep(11, 15, alat) * (1 - smoothstep(30, 35, alat));
    const westFog = west <= T.fogReach ? 1 - west / T.fogReach : 0;
    const strength = 0.65 + 0.35 * currents.noise(x.x * 3, x.y * 3, x.z * 3);
    fog[c] = Math.max(0, Math.min(1, fogBand * westFog * strength));
  }
  return { seasonality, fog, ecotone, radius };
}
