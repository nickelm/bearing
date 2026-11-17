/**
 * Stage: lithology (proposal 0007, decision 204).
 *
 * Rock by province, with noise and layering, after climate. Rock sets
 * erodibility for the erosion pass, soil for biomes, rock colors for shading,
 * and gates landforms: strata, mesas and buttes only in horizontally layered
 * sedimentary rock (the `LAYERED` bit) in a dry climate, karst only in
 * limestone.
 *
 * The stage also finishes the province map: sedimentary basins whose rock is
 * limestone become karst platforms, those on loess soft sediment, and cold
 * shields and basins that an ice age would have covered become glaciated
 * lowland on glacial till.
 */
import type { CubeGrid } from '../core/cubeGrid';
import { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { Vec3d } from '../core/vec3d';
import { effectAt } from './characters';
import { Province } from './provinces';
import type { CharacterMap } from './provinces';

export const Rock = {
  None: 0,
  /** Granite and gneiss. */
  Granite: 1,
  Schist: 2,
  Sandstone: 3,
  Shale: 4,
  Limestone: 5,
  Basalt: 6,
  /** Volcanic ash and tuff. */
  Ash: 7,
  Loess: 8,
  /** Glacial till. */
  Till: 9,
} as const;
export type Rock = (typeof Rock)[keyof typeof Rock];
export const ROCK_COUNT = 10;
/** Bit set on horizontally layered sedimentary rock. */
export const LAYERED = 0x80;

export const ROCK_NAMES: readonly string[] = [
  'none',
  'granite and gneiss',
  'schist',
  'sandstone',
  'shale',
  'limestone',
  'basalt',
  'volcanic ash',
  'loess',
  'glacial till',
];

export const rockOf = (lith: number): Rock => (lith & 0x7f) as Rock;
export const isLayered = (lith: number): boolean => (lith & LAYERED) !== 0;

/**
 * Erodibility relative to today's uniform erosion (1): hard crystalline rock
 * resists, weak deposits wash away. Tuning knobs (decision 204).
 */
export const ROCK_ERODIBILITY: readonly number[] = [
  1, // none (sea floor)
  0.35, // granite and gneiss
  0.6, // schist
  1.0, // sandstone
  1.6, // shale
  0.8, // limestone
  0.4, // basalt
  2.2, // ash
  3.0, // loess
  1.4, // till
];

export const LITHOLOGY_TUNING = {
  /** Sedimentary basins on limestone (noise above) become karst platforms. */
  karstThreshold: 0.16,
  /** Sedimentary basins on loess (noise below) become soft sediment. */
  loessThreshold: -0.24,
  /** Annual mean temperature (°C, at the cell's height) below which an ice age covered low ground. */
  glaciatedBelow: 3,
  /** Glaciated lowland stays low: highest physical height (m). */
  glaciatedMaxHeight: 900,
  /** Smoothing passes for the erodibility field on the tectonic grid. */
  erodibilityBlur: 2,
};

export interface Lithology {
  /** `Rock` per cell, with `LAYERED` on horizontal sedimentary rock. */
  lithology: Uint8Array;
}

/**
 * Assigns rock and finishes the province map in place (karst platform, soft
 * sediment, glaciated lowland).
 */
export function assignLithology(
  grid: CubeGrid,
  province: Uint8Array,
  height: Float32Array,
  temperature: Float32Array,
  r: Rng,
  characters?: CharacterMap,
): Lithology {
  const L = LITHOLOGY_TUNING;
  const n = grid.cellCount;
  const broad = new Noise3(r.fork('broad'));
  const fine = new Noise3(r.fork('fine'));
  const lithology = new Uint8Array(n);
  const x = new Vec3d();
  for (let c = 0; c < n; c++) {
    grid.center(c, x);
    const n1 = broad.fbm(x.x * 5, x.y * 5, x.z * 5, 3);
    const n2 = fine.fbm(x.x * 17, x.y * 17, x.z * 17, 3);
    const land = height[c]! > 0;
    const fx = effectAt(characters, c);
    let rock: number;
    let layered = false;
    // Land outside the tectonic provinces (coastal plains on the shelf's crust) is a sedimentary basin.
    if (land && province[c] === Province.None) province[c] = Province.SedimentaryBasin;
    switch (province[c]) {
      case Province.YoungCollision:
        rock = n2 > 0.35 ? Rock.Limestone : n1 > 0 ? Rock.Granite : Rock.Schist;
        break;
      case Province.HighPlateau:
        if (n1 > -0.2) {
          rock = n2 > 0 ? Rock.Sandstone : Rock.Shale;
          layered = true;
        } else rock = Rock.Basalt;
        break;
      case Province.OldMountains:
        rock = n2 > 0.25 ? Rock.Sandstone : n1 > 0 ? Rock.Schist : Rock.Granite;
        break;
      case Province.Shield:
        rock = n2 > 0.45 ? Rock.Schist : Rock.Granite;
        break;
      case Province.BasinAndRange:
        rock = n2 > 0.3 ? Rock.Granite : n2 < -0.3 ? Rock.Ash : Rock.Sandstone;
        break;
      case Province.Rift:
        rock = n2 > 0 ? Rock.Basalt : Rock.Ash;
        break;
      case Province.VolcanicArc:
        rock = land ? (n2 > -0.2 ? Rock.Ash : Rock.Basalt) : Rock.None;
        break;
      case Province.Hotspot:
        rock = land ? Rock.Basalt : Rock.None;
        break;
      case Province.SedimentaryBasin:
        layered = true;
        if (n1 > L.karstThreshold + fx.karst) {
          rock = Rock.Limestone;
          province[c] = Province.KarstPlatform;
        } else if (n1 < L.loessThreshold + fx.loess) {
          rock = Rock.Loess;
          layered = false;
          province[c] = Province.SoftSediment;
        } else rock = n2 > 0 ? Rock.Sandstone : Rock.Shale;
        break;
      default:
        // Land raised from ocean crust: volcanic.
        rock = land ? Rock.Basalt : Rock.None;
    }
    // Ground an ice age would have covered: shields and basins under till.
    const pv = province[c]!;
    if (
      land &&
      temperature[c]! < L.glaciatedBelow &&
      height[c]! < L.glaciatedMaxHeight &&
      (pv === Province.Shield ||
        pv === Province.SedimentaryBasin ||
        pv === Province.SoftSediment ||
        pv === Province.KarstPlatform)
    ) {
      province[c] = Province.GlaciatedLowland;
      // Thin till over the shield's bedrock; thick till over soft ground.
      rock = pv === Province.Shield && n2 > 0 ? Rock.Granite : Rock.Till;
      layered = false;
    }
    lithology[c] = rock | (layered ? LAYERED : 0);
  }
  return { lithology };
}

/**
 * Erodibility per cell (factor on the incision), smoothed so hard and soft rock
 * meet over a few cells rather than at one edge.
 */
export function erodibilityField(grid: CubeGrid, lithology: Uint8Array): Float32Array {
  const n = grid.cellCount;
  let a = new Float32Array(n);
  for (let c = 0; c < n; c++) a[c] = Math.log(ROCK_ERODIBILITY[rockOf(lithology[c]!)] ?? 1);
  let b = new Float32Array(n);
  for (let p = 0; p < LITHOLOGY_TUNING.erodibilityBlur; p++) {
    for (let c = 0; c < n; c++) {
      let sum = 2 * a[c]!;
      let w = 2;
      for (let k = 0; k < 8; k++) {
        const nb = grid.neighbors8[c * 8 + k]!;
        if (nb >= 0) {
          sum += a[nb]!;
          w++;
        }
      }
      b[c] = sum / w;
    }
    [a, b] = [b, a];
  }
  for (let c = 0; c < n; c++) a[c] = Math.exp(a[c]!);
  return a;
}
