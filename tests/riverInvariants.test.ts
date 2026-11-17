/**
 * River invariants over ten seeds (decision 161, N2; proposal 0005): the
 * vector rivers of real networks, extracted on the CPU from each seed's
 * tectonic heights, profiled and meandered by the same `RiverIndex` the tiles
 * carve from. Guards decisions 146 and 147 while the planform changes; the
 * eroded worlds are measured by `tools/riverInvariants.preview.ts`.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { CubeGrid } from '../src/core/cubeGrid';
import { median, riverInvariants } from '../src/worldgen/channels/invariants';
import type { RiverInvariants } from '../src/worldgen/channels/invariants';
import { computeDrainage } from '../src/worldgen/drainage';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { RiverIndex, smoothPlanform, wander, WANDER_TUNING } from '../src/worldgen/riverIndex';
import { extractRivers } from '../src/worldgen/rivers';

const N = Number(process.env.RIVER_N ?? 96);
const SEEDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '1983'];
const R = DEFAULT_PLANET_PARAMS.radius;
const CELL = ((Math.PI / 2) * R) / N;
const grid = new CubeGrid(N);

function measure(seed: string): RiverInvariants {
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const world = generateWorld(params, { resolution: N, grid });
  const m = world.maps;
  // With the climate, as the coarse pass and the global finish run it: closed basins
  // end their rivers at their lakes (decision 207), which must keep every invariant.
  const drainage = computeDrainage(N, m.height, m.runoff, R, {
    temperature: m.temperature,
    precipitation: m.precipitation,
  });
  const rivers = extractRivers(N, m.height, drainage.receiver, drainage.discharge);
  const sigma = process.env.SIGMA === undefined ? {} : { sigma: Number(process.env.SIGMA) };
  const index = new RiverIndex(rivers, {
    height: m.height,
    radius: R,
    lakeDepth: drainage.lakeDepth,
    planform: sigma,
  });
  return riverInvariants(index, rivers.downstream, { radius: R, cellSize: CELL });
}

describe('river invariants over ten seeds', () => {
  const results = SEEDS.map((s) => [s, measure(s)] as const);

  it('keeps every water surface from rising downstream, within polylines and at junctions', () => {
    for (const [, r] of results) {
      expect(r.segments).toBeGreaterThan(1000);
      expect(r.surfaceRises).toBe(0);
      expect(r.junctionRises).toBe(0);
      expect(r.junctionGaps).toBe(0);
    }
  });

  it('leaves no humps in the beds', () => {
    for (const [, r] of results) expect(r.bedMaxima).toBe(0);
  });

  it('keeps grid headings and stair-steps down (decision 165)', () => {
    // On these 16 km cells of uneroded heights long D8 runs follow the axes, so the
    // share stays well above an even spread (11%); before the planform smoothing it
    // was 31-58% per seed, after it 26-45%. The eroded seed 1983 at 1,024²: 51% → 21%.
    let sum = 0;
    for (const [, r] of results) {
      expect(r.gridAligned).toBeLessThan(0.5);
      expect(r.stairStepsPer1000Km).toBeLessThan(45);
      sum += r.gridAligned;
    }
    expect(sum / results.length).toBeLessThan(0.42);
  });

  it('reports sinuosity for the long polylines', () => {
    for (const [, r] of results) {
      for (const x of r.sinuosity) expect(x).toBeGreaterThanOrEqual(1);
      if (r.sinuosity.length > 0) expect(median(r.sinuosity)).toBeGreaterThan(1);
    }
  });
});

describe('planform smoothing (decision 165)', () => {
  // A D8 staircase at 22.5°: alternating east and north-east steps of one cell.
  const cell = 1500;
  const stairs = (steps: number): number[][] => {
    const pts: number[][] = [];
    let e = 0;
    let n = 0;
    for (let i = 0; i <= steps; i++) {
      const d = latLonToDirection(n / R, e / R);
      pts.push([d.x, d.y, d.z, 30, 100 - i]);
      e += cell;
      if (i % 2 === 0) n += cell;
    }
    return pts;
  };
  const heading = (a: number[], b: number[]) => {
    const da = Math.asin(b[1]!) - Math.asin(a[1]!);
    const de = Math.atan2(b[0]!, b[2]!) - Math.atan2(a[0]!, a[2]!);
    return Math.atan2(da, de);
  };

  it('turns a staircase into the line it approximates, ends in place', () => {
    const raw = stairs(40);
    const sm = smoothPlanform(raw, cell, R);
    expect(sm[0]).toEqual(raw[0]);
    expect(sm[sm.length - 1]).toEqual(raw[raw.length - 1]);
    // Attributes are untouched.
    for (let i = 0; i < raw.length; i++) expect(sm[i]!.slice(3)).toEqual(raw[i]!.slice(3));
    const target = Math.atan(0.5);
    let worstRaw = 0;
    let worst = 0;
    for (let i = 8; i + 9 < raw.length; i++) {
      worstRaw = Math.max(worstRaw, Math.abs(heading(raw[i]!, raw[i + 1]!) - target));
      worst = Math.max(worst, Math.abs(heading(sm[i]!, sm[i + 1]!) - target));
    }
    expect(worstRaw).toBeGreaterThan(0.4);
    expect(worst).toBeLessThan(0.06);
  });

  it('leaves straight lines and short polylines alone', () => {
    const two = stairs(1);
    expect(smoothPlanform(two, cell, R)).toBe(two);
    expect(smoothPlanform(stairs(10), 0, R)).toEqual(stairs(10));
  });
});

describe('wander (decision 167)', () => {
  const cell = 1500;
  // A straight river 40 cells long along the equator, 30 m wide, at 4 points per cell.
  const straight = (): number[][] => {
    const pts: number[][] = [];
    for (let i = 0; i <= 160; i++) {
      const d = latLonToDirection(0, (i * cell) / 4 / R);
      pts.push([d.x, d.y, d.z, 30, 200 - i]);
    }
    return pts;
  };
  const offsets = (pts: number[][]) => pts.map((p) => Math.asin(p[1]!) * R);

  it('bends a straight river within its cap and keeps its ends', () => {
    const raw = straight();
    const w = wander(raw, 5, R, cell, 0);
    expect(w[0]).toEqual(raw[0]);
    expect(w[w.length - 1]).toEqual(raw[raw.length - 1]);
    const y = offsets(w);
    const cap = WANDER_TUNING.maxShift * cell;
    for (const v of y) expect(Math.abs(v)).toBeLessThanOrEqual(cap + 1e-6);
    expect(Math.max(...y.map(Math.abs))).toBeGreaterThan(0.1 * cell);
    // Attributes untouched.
    for (let i = 0; i < raw.length; i++) expect(w[i]!.slice(3)).toEqual(raw[i]!.slice(3));
    // Deterministic per river, different between rivers.
    expect(wander(straight(), 5, R, cell, 0)).toEqual(w);
    expect(offsets(wander(straight(), 6, R, cell, 0))).not.toEqual(y);
  });

  it('lets steep rivers wander less', () => {
    const flat = offsets(wander(straight(), 5, R, cell, 0));
    const steep = offsets(wander(straight(), 5, R, cell, 0.05));
    for (let i = 0; i < flat.length; i++)
      expect(steep[i]!).toBeCloseTo(flat[i]! * WANDER_TUNING.steepShare, 3);
  });

  it('bends short polylines too', () => {
    const two = [straight()[0]!, straight()[12]!];
    const w = wander(two, 9, R, cell, 0);
    expect(w.length).toBeGreaterThan(2);
    expect(w[0]).toEqual(two[0]);
    expect(w[w.length - 1]).toEqual(two[1]);
    expect(Math.max(...offsets(w).map(Math.abs))).toBeGreaterThan(1);
  });
});
