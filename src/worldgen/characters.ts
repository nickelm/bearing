/**
 * Continental character (proposal 0007, decision 212).
 *
 * Each continent (a continental plate's crust, known before uplift) gets a
 * dominant identity drawn from what its tectonics allow and its
 * climate belt: an old shield, young mountains, dry extension, a tropical
 * platform, or a mixed continent. The character biases the provinces (how many
 * runs are young, how wide shields and extension reach), the rock (karst,
 * loess) and the moisture the biome table reads, always within the tectonic
 * limits: no collision, no young mountains.
 *
 * A distinctness check compares the two largest continents' joint province and
 * biome distributions; when they diverge by less than `DISTINCT_JSD` bits, the
 * smaller one's character is redrawn from `characters/nudge-k`, excluding the
 * larger one's, at most `MAX_REDRAWS` times (rule 10's exception, decision 204).
 */
import type { CubeGrid } from '../core/cubeGrid';
import type { Rng } from '../core/rng';
import { DEG } from '../core/units';
import { BoundaryType } from './boundaries';
import type { Boundaries } from './boundaries';

export const Character = {
  Mixed: 0,
  /** Old shield: shields, glaciated lowland, lakes, boreal forest. */
  OldShield: 1,
  /** Young mountains: alpine ranges, volcanic arcs, plateaus, fjords. */
  YoungMountains: 2,
  /** Dry extension: basin and range, red rock, sand seas. */
  DryExtension: 3,
  /** Tropical platform: rainforest, karst, deltas. */
  TropicalPlatform: 4,
} as const;
export type Character = (typeof Character)[keyof typeof Character];
export const CHARACTER_COUNT = 5;
export const CHARACTER_NAMES: readonly string[] = [
  'mixed',
  'old shield',
  'young mountains',
  'dry extension',
  'tropical platform',
];

/** Divergence (bits) under which the two largest continents count as too similar. */
export const DISTINCT_JSD = 0.25;
export const MAX_REDRAWS = 2;
/** Continents smaller than this (m²) take no character of their own (mixed). */
export const CONTINENT_MIN_AREA = 250_000e6;

/** How each character biases the stages it touches. Factors of 1 and offsets of 0 change nothing. */
export interface CharacterEffect {
  /** Chance of a young run: multiplied, then raised to at least `youngFloor`. */
  youngFactor: number;
  youngFloor: number;
  plateauChance: number | null;
  backArcChance: number | null;
  /** Multipliers on the shield distance and the rift extension. */
  shieldDistance: number;
  riftExtension: number;
  /** Offsets on lithology's karst and loess thresholds (noise units). */
  karst: number;
  loess: number;
  /** Offset on the moisture the biome table reads. */
  moisture: number;
}

const NONE: CharacterEffect = {
  youngFactor: 1,
  youngFloor: 0,
  plateauChance: null,
  backArcChance: null,
  shieldDistance: 1,
  riftExtension: 1,
  karst: 0,
  loess: 0,
  moisture: 0,
};

export const CHARACTER_EFFECTS: readonly CharacterEffect[] = [
  NONE,
  { ...NONE, youngFactor: 0.45, shieldDistance: 0.55, moisture: 0.04, karst: 0.05 },
  { ...NONE, youngFloor: 0.9, plateauChance: 0.7, moisture: 0.02 },
  { ...NONE, backArcChance: 0.85, riftExtension: 1.6, loess: 0.12, moisture: -0.09 },
  { ...NONE, youngFactor: 0.7, shieldDistance: 1.4, karst: -0.14, moisture: 0.07 },
];

export interface Continents {
  /** Continent id per cell, −1 off continental crust. */
  label: Int32Array;
  /** Per continent: area (m²) and the latitude of its centroid (rad). */
  area: number[];
  latitude: number[];
  /** Per continent: whether a collision or arc and a rift or cordillera touch it. */
  hasConvergence: boolean[];
  hasExtension: boolean[];
}

/**
 * Continents for character: the continental crust of each plate, ids in plate
 * order. Crust is usually welded into one region across collisions, as Eurasia
 * is; each plate's crust (a craton with its own history) takes its own character.
 */
export function labelContinents(
  grid: CubeGrid,
  radius: number,
  continentalness: Float32Array,
  boundaries: Boundaries,
  plate: Uint8Array,
): Continents {
  const n = grid.cellCount;
  let plates = 0;
  for (let c = 0; c < n; c++) plates = Math.max(plates, plate[c]! + 1);
  const label = new Int32Array(n).fill(-1);
  const a = new Float64Array(plates);
  const y = new Float64Array(plates);
  const conv = new Uint8Array(plates);
  const ext = new Uint8Array(plates);
  for (let c = 0; c < n; c++) {
    if (continentalness[c]! <= 0) continue;
    const p = plate[c]!;
    label[c] = p;
    const ca = grid.areas[c]!;
    a[p]! += ca;
    y[p]! += grid.centers[3 * c + 1]! * ca;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0) continue;
      const t = boundaries.type[nb]!;
      if (
        t === BoundaryType.Collision ||
        t === BoundaryType.IslandArc ||
        t === BoundaryType.Cordillera
      )
        conv[p] = 1;
      if (t === BoundaryType.Rift || t === BoundaryType.Cordillera) ext[p] = 1;
    }
  }
  const area: number[] = [];
  const latitude: number[] = [];
  const hasConvergence: boolean[] = [];
  const hasExtension: boolean[] = [];
  for (let p = 0; p < plates; p++) {
    area.push(a[p]! * radius * radius);
    latitude.push(a[p]! > 0 ? Math.asin(Math.max(-1, Math.min(1, y[p]! / a[p]!))) : 0);
    hasConvergence.push(conv[p] === 1);
    hasExtension.push(ext[p] === 1);
  }
  return { label, area, latitude, hasConvergence, hasExtension };
}

/** The weights of each character for continent `k` (zero where its tectonics forbid it). */
function weights(cont: Continents, k: number): number[] {
  const lat = Math.abs(cont.latitude[k]!) / DEG;
  const w = new Array<number>(CHARACTER_COUNT).fill(0);
  w[Character.Mixed] = 1;
  w[Character.OldShield] = lat > 40 ? 2 : 0.8;
  if (cont.hasConvergence[k]) w[Character.YoungMountains] = 1.4;
  if (cont.hasExtension[k]) w[Character.DryExtension] = lat > 12 && lat < 45 ? 2 : 0.6;
  if (lat < 28) w[Character.TropicalPlatform] = 2.2;
  return w;
}

function drawFrom(w: readonly number[], r: Rng): Character {
  const sum = w.reduce((a, b) => a + b, 0);
  let x = r.nextFloat() * sum;
  for (let i = 0; i < w.length; i++) {
    x -= w[i]!;
    if (x < 0) return i as Character;
  }
  return Character.Mixed;
}

/**
 * One character per continent, in continent order, from `r` (one draw each);
 * continents under CONTINENT_MIN_AREA are mixed.
 */
export function drawCharacters(cont: Continents, r: Rng): Character[] {
  return cont.area.map((a, k) => {
    const c = drawFrom(weights(cont, k), r);
    return a >= CONTINENT_MIN_AREA ? c : Character.Mixed;
  });
}

/** Redraws continent `k`'s character excluding `avoid` (and its current one). */
export function redrawCharacter(
  cont: Continents,
  k: number,
  avoid: Character[],
  r: Rng,
): Character {
  const w = weights(cont, k);
  for (const a of avoid) w[a] = 0;
  if (w.every((x) => x === 0)) return Character.Mixed;
  return drawFrom(w, r);
}

/** The two largest continents by area, or fewer. */
export function largestTwo(cont: Continents): number[] {
  return cont.area
    .map((a, k) => [a, k] as const)
    .sort((x, y) => y[0] - x[0] || x[1] - y[1])
    .slice(0, 2)
    .map(([, k]) => k);
}

/** Effect at a cell: its continent's character, or none off continental crust. */
export function effectAt(
  map: { label: Int32Array; character: readonly Character[] } | undefined,
  c: number,
): CharacterEffect {
  if (!map) return NONE;
  const k = map.label[c]!;
  return k >= 0 ? CHARACTER_EFFECTS[map.character[k]!]! : NONE;
}

/**
 * Divergence (bits) between continents `a` and `b`'s joint province and biome
 * distributions over their land cells (cell counts; the tectonic grid's cells
 * are near equal in area).
 */
export function continentDivergence(
  label: Int32Array,
  a: number,
  b: number,
  province: Uint8Array,
  biome: Uint8Array,
  height: Float32Array,
): number {
  const P = 16;
  const p = new Float64Array(32 * P);
  const q = new Float64Array(32 * P);
  for (let c = 0; c < label.length; c++) {
    if (height[c]! <= 0) continue;
    const k = label[c]!;
    if (k !== a && k !== b) continue;
    const cls = (biome[c]! & 31) * P + (province[c]! & 15);
    if (k === a) p[cls]!++;
    else q[cls]!++;
  }
  return jsdBits(p, q);
}

/** Jensen–Shannon divergence (bits) of two distributions over the same classes. */
export function jsdBits(p: Float64Array, q: Float64Array): number {
  const sp = p.reduce((a, b) => a + b, 0) || 1;
  const sq = q.reduce((a, b) => a + b, 0) || 1;
  let d = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]! / sp;
    const b = q[i]! / sq;
    const m = 0.5 * (a + b);
    if (a > 0) d += 0.5 * a * Math.log2(a / m);
    if (b > 0) d += 0.5 * b * Math.log2(b / m);
  }
  return d;
}
