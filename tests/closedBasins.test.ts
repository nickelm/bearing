import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { BasinCell, computeDrainage } from '../src/worldgen/drainage';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { FeatureKind } from '../src/worldgen/strategic/graph';

const R = 1_000_000;
const n = 48;
const grid = new CubeGrid(n);
const d = new Vec3d();

/** A broad island with a bowl in its middle: a depression 400 m deep. */
function bowlIsland() {
  const center = latLonToDirection(20 * DEG, 30 * DEG);
  const h = new Float32Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    grid.center(c, d);
    const a = Math.acos(Math.min(1, d.dot(center)));
    if (a > 30 * DEG) h[c] = -200;
    else if (a > 22 * DEG) h[c] = 600 * ((30 * DEG - a) / (8 * DEG)) + 1;
    else h[c] = 200 + 400 * (a / (22 * DEG)) + 1;
  }
  return h;
}

const climate = (t: number, p: number) => ({
  temperature: new Float32Array(grid.cellCount).fill(t),
  precipitation: new Float32Array(grid.cellCount).fill(p),
});

describe('closed basins (decision 207)', () => {
  const h = bowlIsland();

  it('keeps a wet bowl open: its lake fills and spills to the sea', () => {
    const runoff = new Float32Array(grid.cellCount).fill(800);
    const dr = computeDrainage(n, h, runoff, R, climate(10, 1200));
    expect(dr.basins).toHaveLength(0);
    expect(dr.basinCell!.every((v) => v === BasinCell.None)).toBe(true);
  });

  it('closes a dry bowl: a lake below its spill level, and nothing leaves it', () => {
    const runoff = new Float32Array(grid.cellCount).fill(15);
    const open = computeDrainage(n, h, runoff, R);
    const dr = computeDrainage(n, h, runoff, R, climate(25, 150));
    expect(dr.basins!.length).toBe(1);
    const b = dr.basins![0]!;
    expect(b.level).toBeLessThan(b.spill);
    // Water in the bowl's floor, none on the dry slopes between the lake and the rim.
    let wet = 0;
    for (let c = 0; c < grid.cellCount; c++) {
      if (dr.basinCell![c] === BasinCell.SaltLake) {
        wet++;
        expect(dr.lakeDepth[c]).toBeGreaterThan(0);
      } else if (h[c]! > 0 && h[c]! < b.spill - 1 && open.lakeDepth[c]! > 0) {
        expect(dr.lakeDepth[c]).toBe(0);
      }
    }
    expect(wet).toBeGreaterThan(0);
    // The sea receives less than with the bowl open: the basin's water evaporates.
    let toSeaOpen = 0;
    let toSeaClosed = 0;
    for (let c = 0; c < grid.cellCount; c++) {
      if (h[c]! <= 0) continue;
      if (h[open.receiver[c]!]! <= 0) toSeaOpen += open.discharge[c]!;
      if (h[dr.receiver[c]!]! <= 0) toSeaClosed += dr.discharge[c]!;
    }
    expect(toSeaClosed).toBeLessThan(toSeaOpen * 0.9);
    // Every land cell has a receiver, except the lake's sinks, where rivers end.
    for (let c = 0; c < grid.cellCount; c++) {
      if (h[c]! <= 0) continue;
      if (dr.basinCell![c] === BasinCell.None) expect(dr.receiver[c]).toBeGreaterThanOrEqual(0);
      else expect(dr.receiver[c]).toBe(-1);
    }
  });

  it('dries a very dry bowl to a playa', () => {
    const runoff = new Float32Array(grid.cellCount).fill(0.5);
    const dr = computeDrainage(n, h, runoff, R, climate(30, 50));
    expect(dr.basins!.length).toBe(1);
    expect(dr.basins![0]!.playa).toBe(true);
    let playa = 0;
    for (let c = 0; c < grid.cellCount; c++) {
      if (dr.basinCell![c] === BasinCell.Playa) {
        playa++;
        expect(dr.lakeDepth[c]).toBe(0);
      }
    }
    expect(playa).toBeGreaterThan(0);
  });

  it('records salt flats and airstrip sites in the strategic graph', () => {
    let flats = 0;
    let strips = 0;
    let basins = 0;
    const g = new CubeGrid(128);
    for (const seed of [1, 2, 3]) {
      const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { grid: g });
      basins += w.world.maps.lakeDepth.length > 0 ? 1 : 0;
      const sites = w.graph.saltFlats ?? [];
      flats += sites.length;
      strips += sites.filter((s) => s.airstrip).length;
      for (const s of sites) {
        expect(w.graph.features.kind[s.feature]).toBe(FeatureKind.SaltFlat);
        expect(w.graph.features.names[s.feature]).toMatch(/Salt Flat|Pan/);
      }
    }
    expect(basins).toBe(3);
    expect(flats).toBeGreaterThan(0);
    expect(strips).toBeGreaterThan(0);
  }, 120_000);
});
