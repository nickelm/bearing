/**
 * Settlements (milestone 5): towns and cities placed where people settle,
 * before any war is cast.
 *
 * - **Habitability** per land cell: biome fertility × lowland × flatness ×
 *   (1 + water access), where water access rewards river cells, confluences,
 *   coasts, lake shores and port sites.
 * - **Count:** one settlement per SETTLEMENT_AREA of habitability-weighted
 *   land, capped at MAX_SETTLEMENTS.
 * - **Placement:** weighted sampling without replacement (Efraimidis–
 *   Spirakis keys u^(1/w), one draw per land cell in cell order), then a
 *   greedy pass that keeps settlements at least SETTLEMENT_SPACING apart.
 *   Every port site then gets a port town if none lies within reach.
 * - **Population:** rank-size (Zipf, exponent 0.9) over a ranking key of
 *   habitability × lognormal noise, scaled to POPULATION_DENSITY people per
 *   km² of weighted land. Kinds follow from population (`settlementKind`).
 *
 * Draws from rng(seed, "settlements") and its fork "names" only.
 */
import { rng } from '../../core/rng';
import type { WorldSeed } from '../../core/rng';
import { NameGenerator } from '../../core/names';
import { Biome } from '../biomes';
import { SETTLEMENT_COAST, SETTLEMENT_PORT, SETTLEMENT_RIVER } from './graph';
import type { LandNode, SettlementList } from './graph';
import { CapWalker, smoothstep } from './input';
import type { StrategicContext } from './input';

/** Habitability-weighted land per settlement (m²). */
export const SETTLEMENT_AREA = 350e6;
export const MAX_SETTLEMENTS = 3000;
/** Minimum distance between settlements (m). */
export const SETTLEMENT_SPACING = 7e3;
/** A port site with no settlement this close gets a port town (m). */
const PORT_TOWN_REACH = 15e3;
/** People per km² of habitability-weighted land. */
const POPULATION_DENSITY = 70;
const ZIPF_EXPONENT = 0.9;
/** Rivers with at least this discharge (m³/s) count as water access. */
const RIVER_DISCHARGE = 20;

const FERTILITY: Partial<Record<number, number>> = {
  [Biome.TemperateGrassland]: 1,
  [Biome.TemperateForest]: 0.9,
  [Biome.TropicalSeasonalForest]: 0.8,
  [Biome.Savanna]: 0.7,
  [Biome.TemperateRainforest]: 0.6,
  [Biome.Shrubland]: 0.5,
  [Biome.TropicalRainforest]: 0.4,
  [Biome.Taiga]: 0.35,
  [Biome.ColdDesert]: 0.15,
  [Biome.HotDesert]: 0.12,
  [Biome.Tundra]: 0.08,
  [Biome.Alpine]: 0.03,
};

/** Habitability 0..1 per cell (0 at sea, on lakes and ice). */
export function habitability(ctx: StrategicContext, portCells: ReadonlySet<number>): Float32Array {
  const { grid, height, biome, slope, discharge, lakeDepth, reliefScale } = ctx;
  const label = ctx.labels.label;
  const out = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    if (label[c]! < 0 || lakeDepth[c]! > 0) continue;
    const fertility = FERTILITY[biome[c]!] ?? 0;
    if (fertility <= 0) continue;
    const ref = height[c]! / reliefScale;
    const lowland = 1 - 0.8 * smoothstep(300, 2500, ref);
    const flat = 1 - 0.7 * smoothstep(0.02, 0.12, slope[c]!);
    let water = 0;
    const q = discharge[c]!;
    if (q >= RIVER_DISCHARGE) water += 0.3 + 0.3 * smoothstep(20, 2000, q);
    let donors = 0;
    let coast = false;
    let lake = false;
    for (let k = 0; k < 8; k++) {
      const nb = grid.neighbors8[c * 8 + k]!;
      if (nb < 0) continue;
      if (ctx.receiver[nb] === c && discharge[nb]! >= RIVER_DISCHARGE) donors++;
      if (label[nb]! < 0) coast = true;
      else if (lakeDepth[nb]! > 0) lake = true;
    }
    if (donors >= 2) water += 0.4;
    if (coast) water += 0.35;
    if (lake) water += 0.2;
    if (portCells.has(c)) water += 0.5;
    out[c] = Math.min(1, (fertility * lowland * flat * (1 + water)) / 2);
  }
  return out;
}

export function placeSettlements(
  ctx: StrategicContext,
  nodes: readonly LandNode[],
  nodeOfLandmass: Int32Array,
  walker: CapWalker,
  seed: WorldSeed,
): { settlements: SettlementList; habitability: Uint8Array } {
  const { grid, radius, discharge } = ctx;
  const label = ctx.labels.label;
  const portCells = new Set<number>();
  for (const n of nodes) for (const c of n.ports.cells) portCells.add(c);
  // Port sites of islands outside any node still count as harbors.
  const hab = habitability(ctx, portCells);
  const r = rng(seed, 'settlements');

  // Count from the weighted land area.
  let weighted = 0;
  for (let c = 0; c < grid.cellCount; c++) weighted += hab[c]! * grid.areas[c]!;
  weighted *= radius * radius;
  const target = Math.min(MAX_SETTLEMENTS, Math.max(1, Math.round(weighted / SETTLEMENT_AREA)));

  // Weighted sampling keys: one draw per land cell, in cell order.
  const keyed: { cell: number; key: number }[] = [];
  for (let c = 0; c < grid.cellCount; c++) {
    if (label[c]! < 0) continue;
    const u = r.nextFloat();
    const w = hab[c]!;
    if (w < 0.02) continue;
    keyed.push({ cell: c, key: Math.log(Math.max(u, 1e-300)) / w });
  }
  keyed.sort((a, b) => b.key - a.key || a.cell - b.cell);
  const blocked = new Uint8Array(grid.cellCount);
  const spacing = Math.max(SETTLEMENT_SPACING, 1.1 * ctx.cellSize) / radius;
  const chosen: number[] = [];
  const block = (c: number) => walker.walk(c, spacing, (x) => (blocked[x] = 1));
  for (const k of keyed) {
    if (chosen.length >= target) break;
    if (blocked[k.cell]) continue;
    chosen.push(k.cell);
    block(k.cell);
  }
  const placed = chosen.length;
  // Port towns: every port site gets a settlement within reach.
  const reach = Math.max(PORT_TOWN_REACH, 1.5 * ctx.cellSize) / radius;
  const near = new Uint8Array(grid.cellCount);
  for (const c of chosen) walker.walk(c, reach, (x) => (near[x] = 1));
  for (const c of [...portCells].sort((a, b) => a - b)) {
    if (near[c]) continue;
    chosen.push(c);
    walker.walk(c, reach, (x) => (near[x] = 1));
  }

  // Ranking key: habitability × lognormal noise (drawn per settlement, in placement order).
  const rank = chosen.map((c, i) => {
    const u1 = Math.max(r.nextFloat(), 1e-12);
    const u2 = r.nextFloat();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return { i, key: (hab[c]! + 0.05) * Math.exp(0.8 * z) * (i >= placed ? 0.7 : 1) };
  });
  rank.sort((a, b) => b.key - a.key || a.i - b.i);
  const total = (weighted / 1e6) * POPULATION_DENSITY;
  let zipf = 0;
  for (let k = 1; k <= chosen.length; k++) zipf += k ** -ZIPF_EXPONENT;
  const population = new Float32Array(chosen.length);
  rank.forEach((x, k) => {
    population[x.i] = Math.round((total * (k + 1) ** -ZIPF_EXPONENT) / zipf / 100) * 100;
  });

  const names = new NameGenerator(r.fork('names'));
  const n = chosen.length;
  const out: SettlementList = {
    cells: Int32Array.from(chosen),
    points: new Float64Array(n * 3),
    population,
    node: new Int32Array(n),
    flags: new Uint8Array(n),
    names: chosen.map(() => names.short()),
  };
  chosen.forEach((c, i) => {
    out.points.set(
      [grid.centers[c * 3]!, grid.centers[c * 3 + 1]!, grid.centers[c * 3 + 2]!],
      i * 3,
    );
    out.node[i] = nodeOfLandmass[label[c]!] ?? -1;
    let flags = 0;
    if (portCells.has(c)) flags |= SETTLEMENT_PORT;
    if (discharge[c]! >= RIVER_DISCHARGE) flags |= SETTLEMENT_RIVER;
    for (let k = 0; k < 4; k++)
      if (label[grid.neighbors4[c * 4 + k]!]! < 0) flags |= SETTLEMENT_COAST;
    out.flags[i] = flags;
  });
  return { settlements: out, habitability: Uint8Array.from(hab, (h) => Math.round(h * 255)) };
}
