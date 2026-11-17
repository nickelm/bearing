/**
 * Natural wonder candidates (proposal 0007, decision 214): detectors over the
 * coarse world for twelve kinds, each a heightened version of an Earth feature.
 * Every candidate becomes a point feature of kind `Wonder` whose `measure` is
 * its `WonderKind`; casting selects 5–15 of them for the war (campaign/wonders.ts),
 * and only those are labeled. Deterministic and free of randomness.
 */
import { Biome, DESERT_BIOMES } from '../biomes';
import { BasinCell } from '../drainage';
import { isLayered, Rock, rockOf } from '../lithology';
import { Province } from '../provinces';
import { FeatureKind, WonderKind } from '../strategic/graph';
import type { Point } from '../strategic/graph';
import type { FeatureBuilder } from './builder';
import type { GeographyInput } from './context';

/** Best candidates kept per kind, and their least spacing (m). */
export const WONDER_PER_KIND = 3;
export const WONDER_SPACING = 150e3;

const TROPICAL: ReadonlySet<number> = new Set([
  Biome.TropicalRainforest,
  Biome.TropicalSeasonalForest,
  Biome.CloudForest,
  Biome.Mangrove,
  Biome.Savanna,
]);
const FOREST: ReadonlySet<number> = new Set([
  Biome.TemperateForest,
  Biome.TemperateRainforest,
  Biome.TropicalRainforest,
  Biome.TropicalSeasonalForest,
  Biome.CloudForest,
]);

export function extractWonders(
  input: GeographyInput,
  fb: FeatureBuilder,
  region: Int32Array,
): void {
  const { grid, height, biome, slope, discharge, lakeDepth, reliefScale, radius } = input.ctx;
  const province = input.ctx.province;
  const lith = input.ctx.lithology;
  const basin = input.ctx.basinCell;
  const receiver = input.ctx.receiver;
  if (!province || !lith) return;
  const n = grid.cellCount;
  const cand: { kind: WonderKind; cell: number; score: number }[] = [];
  const near = (c: number, pred: (x: number) => boolean) => {
    for (let k = 0; k < 8; k++) {
      const m = grid.neighbors8[c * 8 + k]!;
      if (m >= 0 && pred(m)) return true;
    }
    return false;
  };
  const relief = (c: number) => {
    let lo = height[c]!;
    let hi = height[c]!;
    for (let k = 0; k < 8; k++) {
      const m = grid.neighbors8[c * 8 + k]!;
      if (m < 0) continue;
      lo = Math.min(lo, height[m]!);
      hi = Math.max(hi, height[m]!);
    }
    return (hi - lo) / reliefScale;
  };
  const sat = (x: number, k: number) => x / (x + k);
  for (let c = 0; c < n; c++) {
    const h = height[c]!;
    const b = biome[c]!;
    const p = province[c]!;
    const rock = rockOf(lith[c]!);
    const coastal = h > 0 && near(c, (m) => height[m]! <= 0);
    if (h <= 0) {
      // A blue hole: a drowned hotspot edifice in warm, shallow water.
      const lat = Math.abs(Math.asin(grid.centers[3 * c + 1]!));
      if (p === Province.Hotspot && h / reliefScale > -150 && lat < 0.4) {
        cand.push({
          kind: WonderKind.BlueHole,
          cell: c,
          score: 0.6 + 0.4 * (1 + h / reliefScale / 150),
        });
      }
      continue;
    }
    const r = relief(c);
    if (rock === Rock.Sandstone && TROPICAL.has(b) && r > 250)
      cand.push({ kind: WonderKind.Tepui, cell: c, score: sat(r, 600) });
    const down = receiver[c]!;
    if (down >= 0 && discharge[c]! >= 300) {
      const drop = (h - Math.max(0, height[down]!)) / reliefScale;
      if (drop > 120)
        cand.push({ kind: WonderKind.GiantFalls, cell: c, score: sat(drop * discharge[c]!, 3e5) });
    }
    if (p === Province.KarstPlatform && coastal && TROPICAL.has(b))
      cand.push({ kind: WonderKind.KarstBay, cell: c, score: 0.7 });
    if (rock === Rock.Sandstone && FOREST.has(b) && slope[c]! > 0.04)
      cand.push({ kind: WonderKind.PillarForest, cell: c, score: sat(r, 500) });
    if (basin?.[c] === BasinCell.SaltLake && near(c, (m) => DESERT_BIOMES.has(biome[m]!)))
      cand.push({ kind: WonderKind.SaltLake, cell: c, score: 0.75 });
    if (
      rock === Rock.Limestone &&
      near(
        c,
        (m) =>
          province[m] === Province.Rift ||
          province[m] === Province.VolcanicArc ||
          province[m] === Province.Hotspot,
      )
    )
      cand.push({ kind: WonderKind.Travertine, cell: c, score: 0.6 });
    if ((p === Province.VolcanicArc || p === Province.Hotspot) && lakeDepth[c]! > 0)
      cand.push({ kind: WonderKind.CraterLake, cell: c, score: sat(lakeDepth[c]!, 30) });
    if (
      coastal &&
      (b === Biome.IceSheet || b === Biome.Alpine || b === Biome.Tundra) &&
      (p === Province.YoungCollision || p === Province.GlaciatedLowland) &&
      r > 300
    )
      cand.push({ kind: WonderKind.CalvingGlacier, cell: c, score: sat(r, 800) });
    if (
      DESERT_BIOMES.has(b) &&
      (rock === Rock.Ash || rock === Rock.Shale || rock === Rock.Loess) &&
      slope[c]! > 0.02
    )
      cand.push({ kind: WonderKind.MineralHills, cell: c, score: sat(slope[c]!, 0.05) });
    if ((DESERT_BIOMES.has(b) || b === Biome.Savanna) && r > 200) {
      // Alone on a plain: its neighbors' neighbors are flat.
      let flat = true;
      for (let k = 0; k < 8 && flat; k++) {
        const m = grid.neighbors8[c * 8 + k]!;
        if (m >= 0 && slope[m]! > 0.03 && height[m]! > h * 0.9) flat = false;
      }
      if (flat) cand.push({ kind: WonderKind.Monolith, cell: c, score: sat(r, 400) });
    }
    if (coastal && rock === Rock.Basalt && !isLayered(lith[c]!))
      cand.push({ kind: WonderKind.BasaltCauseway, cell: c, score: 0.4 + 0.4 * sat(r, 200) });
  }
  // The best few of each kind, spaced apart, then features in kind and cell order.
  cand.sort((a, b) => a.kind - b.kind || b.score - a.score || a.cell - b.cell);
  const keep: typeof cand = [];
  const minDot = Math.cos(WONDER_SPACING / radius);
  for (const k of cand) {
    const same = keep.filter((x) => x.kind === k.kind);
    if (same.length >= WONDER_PER_KIND) continue;
    const c3 = (c: number) => [
      grid.centers[3 * c]!,
      grid.centers[3 * c + 1]!,
      grid.centers[3 * c + 2]!,
    ];
    const [x, y, z] = c3(k.cell);
    if (
      same.some((s) => {
        const [a, b, d] = c3(s.cell);
        return a * x! + b * y! + d * z! > minDot;
      })
    )
      continue;
    keep.push(k);
  }
  for (const k of keep) {
    const anchor: Point = [
      grid.centers[3 * k.cell]!,
      grid.centers[3 * k.cell + 1]!,
      grid.centers[3 * k.cell + 2]!,
    ];
    fb.add({
      kind: FeatureKind.Wonder,
      anchor,
      extent: 0,
      size: 0,
      height: Math.max(0, height[k.cell]!),
      measure: k.kind,
      magnitude: Math.max(0.05, Math.min(1, k.score)),
      region: region[k.cell]!,
    });
  }
}
