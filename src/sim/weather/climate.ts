/**
 * Climate input of the weather model (decision 68): the world's climate maps
 * averaged over each weather sample's footprint. The main thread builds it
 * from the tectonic world and transfers it to the sim worker.
 *
 * The weather model is part of the sim's execution layer, which may read world
 * data (rule 9 restricts planning only). It takes plain arrays here, so the
 * sim does not depend on worldgen.
 */
import { CubeGrid } from '../../core/cubeGrid';
import { Vec3d } from '../../core/vec3d';
import { faceDirection } from './grid';
import type { WeatherGrid } from './grid';
import type { CubeFace } from '../../core/coords';

/** The climate maps of a world on its tectonic grid (a structural subset of WorldMaps). */
export interface ClimateSource {
  /** Tectonic grid cells per face edge. */
  resolution: number;
  /** Physical height above sea level (m). */
  height: ArrayLike<number>;
  /** Annual mean temperature at the cell's height (°C). */
  temperature: ArrayLike<number>;
  /** Seasonal half-range (K). */
  temperatureRange: ArrayLike<number>;
  /** Annual precipitation (mm/yr). */
  precipitation: ArrayLike<number>;
  /** Prevailing surface wind, east and north components (m/s). */
  windEast: ArrayLike<number>;
  windNorth: ArrayLike<number>;
  /** Physical elevation per reference meter (decision 14). */
  reliefScale: number;
}

/** Per weather sample; every array has one value per sample of the weather grid. */
export interface WeatherClimate {
  /** Weather grid resolution (samples per face edge, without the border). */
  n: number;
  /** Annual mean surface temperature (°C). */
  temperature: Float32Array;
  /** Seasonal half-range (K). */
  temperatureRange: Float32Array;
  /** Wetness 0..1 from annual precipitation (250 mm/yr → 0, 2,500 mm/yr → 1). */
  wetness: Float32Array;
  /** Land fraction 0..1. */
  land: Float32Array;
  /** Mean ground height above sea level (physical m; 0 at sea). */
  ground: Float32Array;
  /** Gradient of the reference (unscaled) terrain height, east and north (m/m): drives orographic lift. */
  slopeEast: Float32Array;
  slopeNorth: Float32Array;
  /** Prevailing surface wind from the climate stage, east and north (m/s). */
  windEast: Float32Array;
  windNorth: Float32Array;
}

const DRY = 250;
const WET = 2500;
/** Footprint points per sample edge. */
const FOOTPRINT = 5;

/** Averages the climate maps over each weather sample's footprint. */
export function buildWeatherClimate(
  src: ClimateSource,
  grid: WeatherGrid,
  radius: number,
): WeatherClimate {
  const cells = new CubeGrid(src.resolution);
  const count = grid.count;
  const out: WeatherClimate = {
    n: grid.n,
    temperature: new Float32Array(count),
    temperatureRange: new Float32Array(count),
    wetness: new Float32Array(count),
    land: new Float32Array(count),
    ground: new Float32Array(count),
    slopeEast: new Float32Array(count),
    slopeNorth: new Float32Array(count),
    windEast: new Float32Array(count),
    windNorth: new Float32Array(count),
  };
  const reference = new Float64Array(count);
  const m = grid.m;
  const n = grid.n;
  const d = new Vec3d();
  const e = new Vec3d();
  const no = new Vec3d();
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const s = grid.index(f, i, j);
        let t = 0;
        let range = 0;
        let precip = 0;
        let land = 0;
        let ground = 0;
        let ref = 0;
        let we = 0;
        let wn = 0;
        // Footprint points spread over the sample's cell in face coordinates.
        for (let b = 0; b < FOOTPRINT; b++) {
          for (let a = 0; a < FOOTPRINT; a++) {
            const u = (i - 1 + (a + 0.5) / FOOTPRINT) / n;
            const v = (j - 1 + (b + 0.5) / FOOTPRINT) / n;
            faceDirection(f as CubeFace, u, v, d);
            const c = cells.cellOfDirection(d);
            const h = src.height[c]!;
            t += src.temperature[c]!;
            range += src.temperatureRange[c]!;
            precip += src.precipitation[c]!;
            if (h > 0) {
              land += 1;
              ground += h;
              ref += h / src.reliefScale;
            }
            // Wind components are local to each cell; near a sample they share its frame closely enough.
            we += src.windEast[c]!;
            wn += src.windNorth[c]!;
          }
        }
        const k = 1 / (FOOTPRINT * FOOTPRINT);
        out.temperature[s] = t * k;
        out.temperatureRange[s] = range * k;
        out.wetness[s] = clamp01((precip * k - DRY) / (WET - DRY));
        out.land[s] = land * k;
        out.ground[s] = ground * k;
        out.windEast[s] = we * k;
        out.windNorth[s] = wn * k;
        reference[s] = ref * k;
      }
    }
  }
  // Terrain gradient from central differences inside each face's lattice,
  // turned into east and north components through the lattice's tangent vectors.
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const s = grid.index(f, i, j);
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(m - 1, i + 1);
        const j0 = Math.max(0, j - 1);
        const j1 = Math.min(m - 1, j + 1);
        const a0 = grid.index(f, i0, j);
        const a1 = grid.index(f, i1, j);
        const b0 = grid.index(f, i, j0);
        const b1 = grid.index(f, i, j1);
        e.set(grid.east[s * 3]!, grid.east[s * 3 + 1]!, grid.east[s * 3 + 2]!);
        no.set(grid.north[s * 3]!, grid.north[s * 3 + 1]!, grid.north[s * 3 + 2]!);
        // Tangent steps (unit-sphere arc) along i and j, in east/north components.
        const step = (p: number, q: number): [number, number] => {
          const px = grid.directions[q * 3]! - grid.directions[p * 3]!;
          const py = grid.directions[q * 3 + 1]! - grid.directions[p * 3 + 1]!;
          const pz = grid.directions[q * 3 + 2]! - grid.directions[p * 3 + 2]!;
          return [px * e.x + py * e.y + pz * e.z, px * no.x + py * no.y + pz * no.z];
        };
        const [ue, un] = step(a0, a1);
        const [ve, vn] = step(b0, b1);
        const dhu = reference[a1]! - reference[a0]!;
        const dhv = reference[b1]! - reference[b0]!;
        // Solve [ue un; ve vn] · g = [dhu; dhv] for g = (∂h/∂east, ∂h/∂north) per unit arc,
        // then divide by the radius for m/m.
        const det = ue * vn - un * ve;
        if (Math.abs(det) < 1e-12) continue;
        const ge = (dhu * vn - un * dhv) / det;
        const gn = (ue * dhv - dhu * ve) / det;
        out.slopeEast[s] = ge / radius;
        out.slopeNorth[s] = gn / radius;
      }
    }
  }
  return out;
}

/** The transferable buffers of a climate input (for postMessage). */
export function climateBuffers(c: WeatherClimate): ArrayBuffer[] {
  return [
    c.temperature,
    c.temperatureRange,
    c.wetness,
    c.land,
    c.ground,
    c.slopeEast,
    c.slopeNorth,
    c.windEast,
    c.windNorth,
  ].map((a) => a.buffer as ArrayBuffer);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
