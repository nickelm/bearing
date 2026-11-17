/**
 * Zones (proposal 0007, decisions 204, 205, 211): named regions of similar
 * province and biome, 16–63 km across (the proposal's 100–400 km scaled to the
 * planet), each with a look recipe. Presentation data, like the alignment tier:
 * segmented once per world on the eroded global grid in the worker's finish and
 * stored with the world. Campaign logic never reads zones (rule 9).
 *
 *  1. Seeds on a jittered lattice of `seedSpacing` over the land.
 *  2. Region growing from every seed at once (Dijkstra): a step costs more
 *     where the class changes (biome group and province group), across steep
 *     height differences (ridges, escarpments) and across large rivers, so
 *     boundaries settle on those barriers. Coasts bound zones by themselves.
 *  3. Land no seed reached (small islands) becomes zones of its own.
 *  4. Zones under `minDiameter` merge into the neighbor they share the
 *     longest border with.
 *  5. A distance to the nearest boundary per cell, for the renderer's blends.
 *
 * Names come from `rng(seed, "names").fork("zones")` and recipes from
 * `rng(seed, "zones")`, both in zone order.
 */
import { MinHeap } from '../core/heap';
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { Biome } from './biomes';
import { neighbors8 } from './drainage';
import { Toponymy } from './names/toponymy';
import { LAND_FLAVORS } from './names/flavors';
import { Province } from './provinces';
import { cellCenterDirection } from './rivers';

/** No zone (sea). */
export const NO_ZONE = 0xffff;

export const ZONE_TUNING = {
  /** Lattice spacing of the seeds (m): zones grow to about this size. */
  seedSpacing: 36_000,
  /** Zones smaller than this diameter (m, of the equal-area disc) merge into a neighbor. */
  minDiameter: 16_000,
  /** Step cost added per change of class, per 100 m of height difference, and across rivers. */
  classCost: 3,
  heightCost: 0.6,
  riverCost: 4,
  /** Rivers carrying at least this (m³/s) are barriers. */
  riverDischarge: 150,
  /** Cells of boundary distance kept (beyond, the zone's own look). */
  edgeCells: 4,
  /** Islets too small for a zone join the nearest zone within this distance across water (m). */
  isletReach: 30_000,
};

/** Limits of a zone's palette shift (docs/visual-style.md, *Zones*). */
export const RECIPE_LIMITS = { hue: 10, saturation: 0.12, value: 0.12 };

export type CloudRegime = 'clear' | 'cumulus' | 'low' | 'fog';
export type AmbientParticles = 'none' | 'dust' | 'mist' | 'snow' | 'pollen';

/** A zone's look (decision 211): shifts within the limits, and its air. */
export interface ZoneRecipe {
  /** Hue shift (degrees), saturation and value factors applied to the biome colors. */
  hue: number;
  saturation: number;
  value: number;
  /** Haze tint (sRGB 0..1) and a density factor. */
  haze: [number, number, number];
  hazeDensity: number;
  /** Sun warmth, −1 (cool) … 1 (warm). */
  sunWarmth: number;
  clouds: CloudRegime;
  particles: AmbientParticles;
}

export interface ZoneRecord {
  id: number;
  name: string;
  cells: number;
  /** Area (m²) and the diameter of the equal-area disc (m). */
  area: number;
  diameter: number;
  /** Unit direction of the cell nearest the zone's centroid. */
  anchor: [number, number, number];
  /** Most common biome and province. */
  biome: number;
  province: number;
  recipe: ZoneRecipe;
}

export interface Zones {
  /** Zone id per global cell, NO_ZONE at sea. */
  zone: Uint16Array;
  /** Cells to the nearest zone boundary (0 on it), capped at `edgeCells`. */
  edge: Uint8Array;
  records: ZoneRecord[];
}

/** Coarse biome groups for zone classes. */
function biomeGroup(b: number): number {
  switch (b) {
    case Biome.IceSheet:
    case Biome.Tundra:
    case Biome.Alpine:
      return 0;
    case Biome.Taiga:
      return 1;
    case Biome.TemperateForest:
    case Biome.TemperateRainforest:
    case Biome.CloudForest:
      return 2;
    case Biome.TemperateGrassland:
    case Biome.Shrubland:
    case Biome.Moorland:
      return 3;
    case Biome.ColdDesert:
    case Biome.HotDesert:
    case Biome.RockyDesert:
    case Biome.RedRockDesert:
    case Biome.FogDesert:
      return 4;
    case Biome.Savanna:
      return 5;
    case Biome.TropicalSeasonalForest:
    case Biome.TropicalRainforest:
    case Biome.Mangrove:
      return 6;
    case Biome.Wetland:
      return 7;
    default:
      return 8;
  }
}

/** Coarse province groups: mountains, lowlands, extension, volcanic. */
function provinceGroup(p: number): number {
  switch (p) {
    case Province.YoungCollision:
    case Province.OldMountains:
    case Province.HighPlateau:
      return 0;
    case Province.BasinAndRange:
    case Province.Rift:
      return 2;
    case Province.VolcanicArc:
    case Province.Hotspot:
      return 3;
    default:
      return 1;
  }
}

/** Generic term of a zone's name by its dominant classes. */
function zoneTerm(t: Toponymy, biome: number, province: number): string {
  const g = biomeGroup(biome);
  const mountains = provinceGroup(province) === 0;
  const pick = (...xs: string[]) => xs[t.chance(0.5) ? 0 : xs.length - 1]!;
  if (mountains && g !== 4) return pick('Highlands', 'Uplands');
  switch (g) {
    case 0:
      return pick('Barrens', 'Fells');
    case 1:
      return pick('Taiga', 'Pinewoods');
    case 2:
      return pick('Woods', 'Forest');
    case 3:
      return biome === Biome.Moorland ? pick('Moors', 'Heath') : pick('Downs', 'Steppe');
    case 4:
      return mountains ? 'Badlands' : pick('Waste', 'Sands');
    case 5:
      return pick('Plains', 'Veld');
    case 6:
      return pick('Jungle', 'Wilds');
    case 7:
      return pick('Fens', 'Marshes');
    default:
      return 'Lands';
  }
}

/** The look of a zone by its classes, varied within the limits (decision 211). */
function zoneRecipe(biome: number, province: number, r: ReturnType<typeof rng>): ZoneRecipe {
  const g = biomeGroup(biome);
  const L = RECIPE_LIMITS;
  const hue = r.range(-L.hue, L.hue);
  const saturation = 1 + r.range(-L.saturation, L.saturation);
  const value = 1 + r.range(-L.value, L.value);
  const vary = r.range(-0.15, 0.15);
  const air: Record<
    number,
    Pick<ZoneRecipe, 'haze' | 'hazeDensity' | 'sunWarmth' | 'clouds' | 'particles'>
  > = {
    0: {
      haze: [0.78, 0.84, 0.92],
      hazeDensity: 0.8,
      sunWarmth: -0.6,
      clouds: 'low',
      particles: 'snow',
    },
    1: {
      haze: [0.74, 0.8, 0.86],
      hazeDensity: 0.95,
      sunWarmth: -0.3,
      clouds: 'cumulus',
      particles: 'none',
    },
    2: {
      haze: [0.78, 0.84, 0.86],
      hazeDensity: 1.05,
      sunWarmth: 0.1,
      clouds: 'cumulus',
      particles: 'pollen',
    },
    3: {
      haze: [0.84, 0.84, 0.82],
      hazeDensity: 0.9,
      sunWarmth: 0.2,
      clouds: 'cumulus',
      particles: 'pollen',
    },
    4: {
      haze: [0.92, 0.82, 0.68],
      hazeDensity: 1.2,
      sunWarmth: 0.8,
      clouds: 'clear',
      particles: 'dust',
    },
    5: {
      haze: [0.9, 0.85, 0.72],
      hazeDensity: 1.1,
      sunWarmth: 0.6,
      clouds: 'cumulus',
      particles: 'dust',
    },
    6: {
      haze: [0.82, 0.88, 0.84],
      hazeDensity: 1.25,
      sunWarmth: 0.3,
      clouds: 'low',
      particles: 'mist',
    },
    7: {
      haze: [0.8, 0.86, 0.86],
      hazeDensity: 1.2,
      sunWarmth: 0,
      clouds: 'fog',
      particles: 'mist',
    },
    8: {
      haze: [0.82, 0.84, 0.86],
      hazeDensity: 1,
      sunWarmth: 0,
      clouds: 'cumulus',
      particles: 'none',
    },
  };
  const a = { ...air[g]! };
  // Thin, clear air over mountains; a gray cast over volcanic ground.
  const pg = provinceGroup(province);
  if (pg === 0) a.hazeDensity *= 0.85;
  if (pg === 3) a.haze = [a.haze[0] * 0.95, a.haze[1] * 0.95, a.haze[2] * 0.97];
  const fog = biome === Biome.FogDesert || biome === Biome.CloudForest || biome === Biome.Moorland;
  return {
    hue,
    saturation,
    value,
    haze: a.haze,
    hazeDensity: a.hazeDensity * (1 + vary),
    sunWarmth: Math.max(-1, Math.min(1, a.sunWarmth + vary)),
    clouds: fog ? 'fog' : a.clouds,
    particles: a.particles,
  };
}

export function segmentZones(
  n: number,
  height: Float32Array,
  biome: Uint8Array,
  province: Uint8Array,
  discharge: Float32Array,
  radius: number,
  seed: WorldSeed,
): Zones {
  const T = ZONE_TUNING;
  const count = 6 * n * n;
  const cellSize = ((Math.PI / 2) * radius) / n;
  const cellArea = (4 * Math.PI * radius * radius) / count;
  const land = (c: number) => height[c]! > 0;
  const cls = (c: number) => biomeGroup(biome[c]!) * 4 + provinceGroup(province[c]!);
  const zone = new Int32Array(count).fill(-1);
  const cost = new Float64Array(count).fill(Infinity);
  const heap = new MinHeap(1 << 16);
  const nb = new Int32Array(8);
  const zr = rng(seed, 'zones');
  const jitter = zr.fork('seeds');

  // 1. Seeds: one per lattice block, jittered, on land.
  const block = Math.max(2, Math.round(T.seedSpacing / cellSize));
  let zones = 0;
  for (let f = 0; f < 6; f++) {
    for (let bj = 0; bj < n; bj += block) {
      for (let bi = 0; bi < n; bi += block) {
        const ji = Math.floor(jitter.nextFloat() * block);
        const jj = Math.floor(jitter.nextFloat() * block);
        const i = Math.min(n - 1, bi + ji);
        const j = Math.min(n - 1, bj + jj);
        const c = (f * n + j) * n + i;
        if (!land(c) || zone[c]! >= 0) continue;
        zone[c] = zones++;
        cost[c] = 0;
        heap.push(0, c);
      }
    }
  }
  // 2. Growth.
  const DIAG = Math.SQRT2;
  while (heap.size > 0) {
    const c = heap.pop();
    const k0 = cost[c]!;
    neighbors8(n, c, nb);
    for (let k = 0; k < 8; k++) {
      const m = nb[k]!;
      if (m < 0 || !land(m)) continue;
      let step = k < 4 ? 1 : DIAG;
      step *= 1 + (cls(m) !== cls(c) ? T.classCost : 0);
      step += (T.heightCost * Math.abs(height[m]! - height[c]!)) / 100;
      if (discharge[m]! >= T.riverDischarge !== discharge[c]! >= T.riverDischarge)
        step += T.riverCost;
      const v = k0 + step;
      if (v < cost[m]!) {
        cost[m] = v;
        zone[m] = zone[c]!;
        heap.push(v, m);
      }
    }
  }
  // 3. Land no seed reached: zones of their own, by connected component.
  const stack: number[] = [];
  for (let s = 0; s < count; s++) {
    if (!land(s) || zone[s]! >= 0) continue;
    const id = zones++;
    zone[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const c = stack.pop()!;
      neighbors8(n, c, nb);
      for (let k = 0; k < 8; k++) {
        const m = nb[k]!;
        if (m < 0 || !land(m) || zone[m]! >= 0) continue;
        zone[m] = id;
        stack.push(m);
      }
    }
  }
  // 4. Merge small zones into their longest-bordering neighbor, smallest first.
  const minCells = Math.ceil((Math.PI / 4) * (T.minDiameter / cellSize) ** 2);
  const size = new Int32Array(zones);
  for (let c = 0; c < count; c++) if (zone[c]! >= 0) size[zone[c]!]!++;
  const parent = Int32Array.from({ length: zones }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (let pass = 0; pass < 3; pass++) {
    const border = new Map<number, Map<number, number>>();
    for (let c = 0; c < count; c++) {
      if (zone[c]! < 0) continue;
      const a = find(zone[c]!);
      if (size[a]! >= minCells) continue;
      neighbors8(n, c, nb);
      for (let k = 0; k < 4; k++) {
        const m = nb[k]!;
        if (m < 0 || zone[m]! < 0) continue;
        const b = find(zone[m]!);
        if (b === a) continue;
        let row = border.get(a);
        if (!row) border.set(a, (row = new Map()));
        row.set(b, (row.get(b) ?? 0) + 1);
      }
    }
    const small = [...border.keys()].sort((x, y) => size[x]! - size[y]! || x - y);
    let merged = 0;
    for (const a of small) {
      if (find(a) !== a || size[a]! >= minCells) continue;
      let best = -1;
      let bestLen = 0;
      for (const [b, len] of border.get(a)!) {
        const rb = find(b);
        if (rb === a) continue;
        if (len > bestLen || (len === bestLen && rb < best)) {
          best = rb;
          bestLen = len;
        }
      }
      if (best < 0) continue;
      parent[a] = best;
      size[best]! += size[a]!;
      merged++;
    }
    if (merged === 0) break;
  }
  // Islets: a zone still under the minimum with no zone beside it joins the nearest
  // large zone across the water, within `isletReach` (decision 211).
  {
    const reach = Math.max(1, Math.round(T.isletReach / cellSize));
    const near = new Int32Array(count).fill(-1);
    const dist = new Uint16Array(count).fill(0xffff);
    let frontier: number[] = [];
    for (let c = 0; c < count; c++) {
      if (zone[c]! < 0) continue;
      const root = find(zone[c]!);
      if (size[root]! < minCells) continue;
      near[c] = root;
      dist[c] = 0;
      frontier.push(c);
    }
    for (let step = 1; step <= reach && frontier.length > 0; step++) {
      const next: number[] = [];
      for (const c of frontier) {
        neighbors8(n, c, nb);
        for (let k = 0; k < 8; k++) {
          const m = nb[k]!;
          if (m < 0 || dist[m]! <= step) continue;
          dist[m] = step;
          near[m] = near[c]!;
          next.push(m);
        }
      }
      frontier = next;
    }
    const best = new Map<number, { d: number; to: number }>();
    for (let c = 0; c < count; c++) {
      if (zone[c]! < 0) continue;
      const root = find(zone[c]!);
      if (size[root]! >= minCells || near[c]! < 0) continue;
      const b = best.get(root);
      if (!b || dist[c]! < b.d || (dist[c] === b.d && near[c]! < b.to))
        best.set(root, { d: dist[c]!, to: near[c]! });
    }
    for (const [root, b] of [...best].sort((x, y) => x[0] - y[0])) {
      const to = find(b.to);
      if (to === root) continue;
      parent[root] = to;
      size[to]! += size[root]!;
    }
  }
  // Compact ids in order of first cell.
  const remap = new Int32Array(zones).fill(-1);
  let ids = 0;
  const out = new Uint16Array(count).fill(NO_ZONE);
  for (let c = 0; c < count; c++) {
    if (zone[c]! < 0) continue;
    const root = find(zone[c]!);
    if (remap[root]! < 0) remap[root] = ids++;
    out[c] = remap[root]!;
  }
  if (ids >= NO_ZONE) throw new RangeError(`segmentZones: ${ids} zones exceed the id range`);

  // 5. Distance to the nearest boundary, in cells, by breadth-first search.
  const edge = new Uint8Array(count).fill(T.edgeCells);
  const queue: number[] = [];
  for (let c = 0; c < count; c++) {
    if (out[c] === NO_ZONE) continue;
    neighbors8(n, c, nb);
    for (let k = 0; k < 4; k++) {
      const m = nb[k]!;
      if (m >= 0 && out[m] !== NO_ZONE && out[m] !== out[c]) {
        edge[c] = 0;
        queue.push(c);
        break;
      }
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    const d = edge[c]! + 1;
    if (d >= T.edgeCells) continue;
    neighbors8(n, c, nb);
    for (let k = 0; k < 4; k++) {
      const m = nb[k]!;
      if (m < 0 || out[m] === NO_ZONE || edge[m]! <= d) continue;
      edge[m] = d;
      queue.push(m);
    }
  }

  // Records: area, anchor, dominant classes, name, recipe.
  const cells = new Int32Array(ids);
  const sx = new Float64Array(ids);
  const sy = new Float64Array(ids);
  const sz = new Float64Array(ids);
  const biomeCount = new Int32Array(ids * 32);
  const provCount = new Int32Array(ids * 16);
  const d = cellCenterDirection(n, 0);
  for (let c = 0; c < count; c++) {
    const z = out[c]!;
    if (z === NO_ZONE) continue;
    cells[z]!++;
    cellCenterDirection(n, c, d);
    sx[z]! += d.x;
    sy[z]! += d.y;
    sz[z]! += d.z;
    biomeCount[z * 32 + (biome[c]! & 31)]!++;
    provCount[z * 16 + (province[c]! & 15)]!++;
  }
  const argmax = (a: Int32Array, off: number, len: number) => {
    let best = 0;
    for (let i = 1; i < len; i++) if (a[off + i]! > a[off + best]!) best = i;
    return best;
  };
  const topo = new Toponymy(rng(seed, 'names').fork('zones'));
  const records: ZoneRecord[] = [];
  for (let z = 0; z < ids; z++) {
    const l = Math.hypot(sx[z]!, sy[z]!, sz[z]!) || 1;
    const b = argmax(biomeCount, z * 32, 32);
    const p = argmax(provCount, z * 16, 16);
    const anchor: [number, number, number] = [sx[z]! / l, sy[z]! / l, sz[z]! / l];
    // Naming flavor by region of the globe: neighboring zones share it, distant ones differ.
    const lon = Math.atan2(anchor[0], anchor[2]);
    const flavor = LAND_FLAVORS[Math.floor(((lon + Math.PI) / (2 * Math.PI)) * 4) % 4]!;
    const area = cells[z]! * cellArea;
    records.push({
      id: z,
      name: `the ${topo.proper(flavor)} ${zoneTerm(topo, b, p)}`,
      cells: cells[z]!,
      area,
      diameter: 2 * Math.sqrt(area / Math.PI),
      anchor,
      biome: b,
      province: p,
      recipe: zoneRecipe(b, p, zr.fork(`recipe-${z}`)),
    });
  }
  return { zone: out, edge, records };
}
