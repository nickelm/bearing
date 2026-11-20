/**
 * Cultural urban styles (proposal 0009, decision 261). Styles attach to cultural
 * regions, the naming regions of worldgen/names (one flavor per land node), never to
 * sides: the generator knows nothing of the war.
 *
 * - **Style regions.** One landmass often holds a whole war and so a single naming
 *   region. Each land node with enough settlements is split into up to three style
 *   regions by farthest-point seeds over its settlements, the largest first, with no
 *   random draws (`styleRegions`).
 * - **Preference.** Each flavor lists styles in order; style region k takes the k-th.
 * - **Climate gates** (rule 15: the biome comes from climate; culture picks, climate
 *   permits): Arid needs a dry biome, Nordic a cool one, Mediterranean a warm or dry
 *   one. A gated style falls through to the next preference; Western and Eastern bloc
 *   are never gated.
 */
import { Biome } from '../biomes';
import { Roof, Style } from './types';

/** Style preference per naming flavor (worldgen/names/flavors.ts: A–D land, E islands). */
export const FLAVOR_STYLES: readonly (readonly Style[])[] = [
  [Style.Nordic, Style.Western, Style.Eastern],
  [Style.Eastern, Style.Western, Style.Nordic],
  [Style.Mediterranean, Style.Western, Style.Arid],
  [Style.Arid, Style.Eastern, Style.Mediterranean],
  [Style.Western, Style.Mediterranean, Style.Nordic],
];

const DRY = new Set<number>([
  Biome.HotDesert,
  Biome.ColdDesert,
  Biome.RockyDesert,
  Biome.RedRockDesert,
  Biome.FogDesert,
  Biome.Shrubland,
  Biome.Savanna,
]);
const COOL = new Set<number>([
  Biome.Taiga,
  Biome.Tundra,
  Biome.Alpine,
  Biome.Moorland,
  Biome.TemperateRainforest,
  Biome.TemperateForest,
  Biome.Wetland,
]);
const WARM = new Set<number>([
  Biome.Shrubland,
  Biome.Savanna,
  Biome.TropicalSeasonalForest,
  Biome.TemperateGrassland,
  Biome.TemperateForest,
  Biome.HotDesert,
  Biome.RockyDesert,
  Biome.FogDesert,
  Biome.Mangrove,
]);

/** Whether a settlement's biome permits a style. */
export function climateAllows(style: Style, biome: number): boolean {
  switch (style) {
    case Style.Arid:
      return DRY.has(biome);
    case Style.Nordic:
      return COOL.has(biome);
    case Style.Mediterranean:
      return WARM.has(biome);
    default:
      return true;
  }
}

/** The style of a settlement in style region `region` of a naming region of `flavor`. */
export function styleFor(flavor: number, region: number, biome: number): Style {
  const prefs = FLAVOR_STYLES[flavor] ?? FLAVOR_STYLES[0]!;
  for (let k = 0; k < prefs.length; k++) {
    const s = prefs[(region + k) % prefs.length]!;
    if (climateAllows(s, biome)) return s;
  }
  return Style.Western;
}

/** Settlements per extra style region of a land node, and the most regions. */
export const SETTLEMENTS_PER_REGION = 120;
export const MAX_STYLE_REGIONS = 3;

/**
 * Style region per settlement: within each group (land node), seeds by farthest-point
 * sampling from the most populous settlement, each settlement in its nearest seed's
 * region. `points` are unit directions, xyz interleaved.
 */
export function styleRegions(
  group: ArrayLike<number>,
  population: ArrayLike<number>,
  points: ArrayLike<number>,
): Uint8Array {
  const n = group.length;
  const out = new Uint8Array(n);
  const byGroup = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const g = group[i]!;
    let l = byGroup.get(g);
    if (!l) byGroup.set(g, (l = []));
    l.push(i);
  }
  const dot = (a: number, b: number) =>
    points[a * 3]! * points[b * 3]! +
    points[a * 3 + 1]! * points[b * 3 + 1]! +
    points[a * 3 + 2]! * points[b * 3 + 2]!;
  for (const members of byGroup.values()) {
    const k = Math.min(MAX_STYLE_REGIONS, 1 + Math.floor(members.length / SETTLEMENTS_PER_REGION));
    let first = members[0]!;
    for (const i of members) if (population[i]! > population[first]!) first = i;
    const seeds = [first];
    while (seeds.length < k) {
      let far = -1;
      let farDot = Infinity;
      for (const i of members) {
        let best = -Infinity;
        for (const s of seeds) best = Math.max(best, dot(i, s));
        if (best < farDot) {
          farDot = best;
          far = i;
        }
      }
      if (far < 0) break;
      seeds.push(far);
    }
    for (const i of members) {
      let best = -Infinity;
      let r = 0;
      seeds.forEach((s, j) => {
        const d = dot(i, s);
        if (d > best) {
          best = d;
          r = j;
        }
      });
      out[i] = r;
    }
  }
  return out;
}

/** A style's look: wall and roof colors (sRGB hex), roofs and proportions. */
export interface StylePalette {
  walls: readonly number[];
  roofs: readonly number[];
  /** Roof colors of large and industrial buildings. */
  flatRoofs: readonly number[];
  /** Roof types of houses with their weights. */
  houseRoofs: readonly [Roof, number][];
  /** Roof rise as a share of the building's width, for pitched roofs. */
  pitch: number;
  /** Floors of a detached house: least and most. */
  houseFloors: [number, number];
  /** Share of houses with chimneys. */
  chimneys: number;
  /** Has an organic old core. */
  oldCore: boolean;
  /** Radial avenues weight in the tensor field. */
  radial: number;
  /** Spacing scale (1 = the tier's spacing). */
  spacing: number;
  /** Builds microdistricts in its middle ring. */
  microdistricts: boolean;
}

export const PALETTES: readonly StylePalette[] = [
  // Western: red tile and slate, brick and plaster.
  {
    walls: [0xd8cbb4, 0xcdbfa6, 0xe2d7c3, 0xa86a52, 0xc4a98a],
    roofs: [0x9e4e3a, 0x8e5a48, 0x5e5e62, 0x4f5258, 0xa65e45],
    flatRoofs: [0x7a7672, 0x8a857e],
    houseRoofs: [
      [Roof.Gable, 0.65],
      [Roof.Hip, 0.35],
    ],
    pitch: 0.55,
    houseFloors: [1, 2],
    chimneys: 0.6,
    oldCore: true,
    radial: 0.5,
    spacing: 1,
    microdistricts: false,
  },
  // Eastern bloc: gray concrete, tin and tile.
  {
    walls: [0xb9b6ae, 0xa9a69e, 0xcfc5b0, 0xc2b79c, 0x9c9a94],
    roofs: [0x7f858a, 0x8e5a48, 0x6a6e70, 0x5e5e62],
    flatRoofs: [0x6e6e6e, 0x7c7a76],
    houseRoofs: [
      [Roof.Gable, 0.5],
      [Roof.Hip, 0.5],
    ],
    pitch: 0.5,
    houseFloors: [1, 2],
    chimneys: 0.4,
    oldCore: true,
    radial: 0.9,
    spacing: 1.25,
    microdistricts: true,
  },
  // Mediterranean: ochre and white stucco, low tile and flat roofs.
  {
    walls: [0xd9b37a, 0xede6d6, 0xe3c9a0, 0xd8a273, 0xf0ead9],
    roofs: [0xb0603f, 0xa65e45, 0xc07050],
    flatRoofs: [0xcfc4b0, 0xd8cfbd],
    houseRoofs: [
      [Roof.Flat, 0.45],
      [Roof.Hip, 0.4],
      [Roof.Gable, 0.15],
    ],
    pitch: 0.3,
    houseFloors: [2, 3],
    chimneys: 0.1,
    oldCore: true,
    radial: 0.3,
    spacing: 0.85,
    microdistricts: false,
  },
  // Nordic: low wooden houses, steep dark roofs, generous spacing.
  {
    walls: [0x8e3b2e, 0xc49a55, 0xe5e0d3, 0x3e3a38, 0x9a4a36],
    roofs: [0x2f3033, 0x6e2e28, 0x3a3c40],
    flatRoofs: [0x5a5a5c],
    houseRoofs: [[Roof.Gable, 1]],
    pitch: 0.85,
    houseFloors: [1, 2],
    chimneys: 0.7,
    oldCore: false,
    radial: 0.2,
    spacing: 1.35,
    microdistricts: false,
  },
  // Arid: flat roofs, courtyard houses, pale earth.
  {
    walls: [0xd8c3a0, 0xcdb48c, 0xe2d2b4, 0xc9ad84],
    roofs: [0xcdbb98, 0xd4c4a4],
    flatRoofs: [0xc8b898, 0xd2c3a6],
    houseRoofs: [[Roof.Flat, 1]],
    pitch: 0.2,
    houseFloors: [1, 2],
    chimneys: 0,
    oldCore: true,
    radial: 0.2,
    spacing: 0.9,
    microdistricts: false,
  },
];
