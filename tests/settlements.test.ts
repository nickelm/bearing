import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Biome } from '../src/worldgen/biomes';
import { blocksFromFaces } from '../src/worldgen/settlements/blocks';
import { SettlementFrame } from '../src/worldgen/settlements/frame';
import { boxCorners, pointInPoly, polyArea, polyCentroid } from '../src/worldgen/settlements/geom';
import { buildGraph, faces } from '../src/worldgen/settlements/graph';
import { subdivideBlock } from '../src/worldgen/settlements/parcels';
import { planSettlement } from '../src/worldgen/settlements/plan';
import { climateAllows, styleFor, styleRegions } from '../src/worldgen/settlements/styles';
import { tierOf } from '../src/worldgen/settlements/tiers';
import { District, Style, Tier } from '../src/worldgen/settlements/types';
import type { SettlementInput, SettlementPlan } from '../src/worldgen/settlements/types';
import { rng } from '../src/core/rng';

const RADIUS = 1e6;

function input(over: Partial<SettlementInput> = {}, slope = 0): SettlementInput {
  const r = over.population ? Math.min(9000, 10 * Math.sqrt(over.population)) : 1500;
  return {
    key: 's1',
    name: 'Testby',
    center: [0, 0, 1],
    population: 22_000,
    tier: Tier.Town,
    style: Style.Western,
    flavor: 0,
    outline: Array.from({ length: 32 }, () => r),
    arterials: [{ points: [-3000, 40, 3000, -40], roadClass: 1 }],
    rails: [],
    rivers: [{ points: [-3000, -900, 3000, -700], halfWidth: 20 }],
    coasts: [],
    port: false,
    ground: { height: (x) => 100 + slope * x, water: () => false },
    ...over,
  };
}

function strip(p: SettlementPlan): string {
  return JSON.stringify({ ...p, metrics: { ...p.metrics, ms: 0 } });
}

describe('settlement generator (proposal 0009)', () => {
  it('extracts the blocks of a street grid, a short street snapped to its neighbor', () => {
    const lines = [];
    for (let i = 0; i <= 4; i++) {
      lines.push({ kind: 2, points: [i * 100, -5, i * 100, 395], extend: true });
      lines.push({ kind: 2, points: [-5, i * 100, 395, i * 100], extend: true });
    }
    lines.push({ kind: 2, points: [50, 0, 50, 90], extend: true });
    const b = blocksFromFaces(faces(buildGraph(lines, 20)));
    expect(b.polygons.length).toBe(17);
    expect(b.dropped).toBe(0);
  });

  it('subdivides a block into parcels that all front a street', () => {
    const block = [0, 0, 120, 0, 120, 80, 0, 80];
    const ps = subdivideBlock(block, 400, 6, rng(1, 'test'));
    expect(ps.length).toBeGreaterThan(12);
    const total = ps.reduce((a, p) => a + polyArea(p.polygon), 0);
    expect(total).toBeCloseTo(polyArea(block), 0);
    for (const p of ps)
      expect(
        Math.hypot(p.frontage[2] - p.frontage[0], p.frontage[3] - p.frontage[1]),
      ).toBeGreaterThan(5);
  });

  it('plans a town: buildings inside parcels, parcels on streets, nothing in the river', () => {
    const plan = planSettlement(input(), 7, { radius: RADIUS });
    const m = plan.metrics;
    expect(plan.buildings.length).toBeGreaterThan(300);
    expect(plan.blocks.length).toBeGreaterThan(30);
    expect(m.outsideParcel).toBe(0);
    expect(m.noFrontage).toBe(0);
    expect(m.inWater).toBe(0);
    expect(m.steepVehicle).toBe(0);
    expect(plan.coreRadius).toBeGreaterThan(0);
    expect(plan.landmarks.some((l) => l.name.length > 0)).toBe(true);
  });

  it('is deterministic and independent of other plans', () => {
    const a = strip(planSettlement(input(), 7, { radius: RADIUS }));
    planSettlement(input({ key: 's2', population: 9000, tier: Tier.Village }), 7, {
      radius: RADIUS,
    });
    const b = strip(planSettlement(input(), 7, { radius: RADIUS }));
    expect(b).toBe(a);
    const c = strip(planSettlement(input(), 8, { radius: RADIUS }));
    expect(c).not.toBe(a);
  });

  it('keeps minor streets along the contours on a 15% slope, and steep links off the vehicle network', () => {
    const plan = planSettlement(input({ arterials: [], rivers: [] }, 0.15), 3, { radius: RADIUS });
    const m = plan.metrics;
    expect(m.slopedMinor).toBeGreaterThan(1000);
    expect(m.slopedMinorAlong / m.slopedMinor).toBeGreaterThan(0.5);
    expect(m.steepVehicle).toBe(0);
    for (const s of plan.streets)
      if (s.kind > 0 && s.kind <= 3) expect(s.grade).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('exports a bridge where an arterial crosses a river', () => {
    const plan = planSettlement(
      input({ rivers: [{ points: [600, -3000, 700, 3000], halfWidth: 15 }] }),
      7,
      { radius: RADIUS },
    );
    const bridge = plan.targets.find((t) => t.kind === 5);
    expect(bridge).toBeDefined();
    expect(Math.abs(bridge!.x - 650)).toBeLessThan(10);
    expect(plan.metrics.inWater).toBe(0);
  });

  it('plans a village of strip parcels along its road', () => {
    const plan = planSettlement(input({ population: 6000, tier: Tier.Village }), 5, {
      radius: RADIUS,
    });
    expect(plan.parcels.length).toBeGreaterThan(20);
    expect(plan.metrics.outsideParcel).toBe(0);
    for (const b of plan.buildings) {
      if (b.parcel < 0) continue;
      const c = boxCorners(b.x, b.y, b.angle, b.halfLength * 0.99, b.halfWidth * 0.99);
      for (let i = 0; i < 4; i++)
        expect(pointInPoly(c[i * 2]!, c[i * 2 + 1]!, plan.parcels[b.parcel]!.polygon)).toBe(true);
    }
  });

  it('gives an eastern-bloc city microdistricts and a western one an old core', () => {
    const big = { population: 300_000, tier: Tier.City };
    const east = planSettlement(input({ ...big, style: Style.Eastern }), 2, { radius: RADIUS });
    expect(east.blocks.some((b) => b.district === District.Microdistrict)).toBe(true);
    const west = planSettlement(input({ ...big, style: Style.Western }), 2, { radius: RADIUS });
    expect(west.blocks.some((b) => b.district === District.OldCore)).toBe(true);
    expect(west.blocks.some((b) => b.district === District.Microdistrict)).toBe(false);
  }, 60_000);

  it('picks styles by region and climate, and splits large regions', () => {
    expect(climateAllows(Style.Arid, Biome.TemperateForest)).toBe(false);
    expect(climateAllows(Style.Arid, Biome.HotDesert)).toBe(true);
    expect(styleFor(3, 0, Biome.HotDesert)).toBe(Style.Arid);
    // Steppe flavor in a wet forest falls through to Eastern bloc.
    expect(styleFor(3, 0, Biome.TemperateRainforest)).toBe(Style.Eastern);
    const n = 300;
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 0.5;
      pts.push(Math.sin(a), 0, Math.cos(a));
    }
    const regions = styleRegions(
      new Array(n).fill(0),
      Array.from({ length: n }, (_, i) => n - i),
      pts,
    );
    expect(new Set(regions).size).toBe(3);
    expect(tierOf(250_000)).toBe(Tier.City);
    expect(tierOf(20_000)).toBe(Tier.Town);
    expect(tierOf(5_000)).toBe(Tier.Village);
  });

  it('round-trips the local frame', () => {
    const f = new SettlementFrame([0.3, 0.5, 0.8], RADIUS);
    const d = f.toSphere(1234, -567);
    const [x, y] = f.toPlane(...d);
    expect(x).toBeCloseTo(1234, 6);
    expect(y).toBeCloseTo(-567, 6);
  });

  it('imports nothing of the game (constraint 5)', () => {
    const dir = join(__dirname, '../src/worldgen/settlements');
    const banned =
      /from '(\.\.\/)+(campaign|sim|render|ui|freeflight|follow)\b|strategic\/(fronts|territory|infrastructure|sites)|faction|casting/;
    for (const f of readdirSync(dir)) {
      const imports = readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => /^import|^} from|^export .* from/.test(l));
      for (const l of imports) expect(banned.test(l), `${f}: ${l}`).toBe(false);
    }
  });
});

describe('sites and the built mask (decisions 278, 279)', () => {
  it("realizes a caller's sites as complexes with their buildings, in place of its own targets", () => {
    const anchors = [
      { id: 41, kind: 'works' as const, name: 'Testby Works' },
      { id: 42, kind: 'fuel-depot' as const, name: 'Testby Fuel Depot' },
      { id: 43, kind: 'power' as const, name: 'Testby Power Plant' },
    ];
    const plan = planSettlement(input({ anchors }), 7, { radius: RADIUS });
    for (const a of anchors) {
      const t = plan.targets.find((x) => x.anchor === a.id);
      expect(t, a.kind).toBeDefined();
      expect(t!.name).toBe(a.name);
      for (const b of t!.buildings ?? []) expect(plan.buildings[b]).toBeDefined();
    }
    expect(plan.landmarks.some((l) => l.kind === 11)).toBe(true);
    expect(plan.metrics.outsideParcel).toBe(0);
    // Landmarks still point at their own buildings after the compaction.
    for (const l of plan.landmarks)
      if (l.building >= 0)
        expect(plan.buildings[l.building]!.landmark).toBe(plan.landmarks.indexOf(l));
  });

  it('marks blocks and streets built and leaves parks and open ground natural', async () => {
    const { packPlan, maskBuilt } = await import('../src/worldgen/settlements/pack');
    const plan = planSettlement(input(), 7, { radius: RADIUS });
    const packed = packPlan(plan);
    const b = plan.buildings.find((x) => x.landmark < 0)!;
    expect(maskBuilt(packed, b.x, b.y)).toBe(true);
    expect(maskBuilt(packed, 20_000, 20_000)).toBe(false);
    const parks = plan.blocks.filter((x) => x.ground === 2);
    expect(parks.length).toBeGreaterThan(0);
    for (const park of parks) {
      const [cx, cy] = polyCentroid(park.polygon);
      const onBuilding = plan.buildings.some(
        (x) => Math.hypot(x.x - cx, x.y - cy) < Math.max(x.halfLength, x.halfWidth) + 60,
      );
      if (!onBuilding) expect(maskBuilt(packed, cx, cy)).toBe(false);
    }
  });
});

describe('downtowns and business districts (decision 292)', () => {
  it('raises towers at the center of an American city and off the center of a Western one', () => {
    const big = { population: 300_000, tier: Tier.City };
    const us = planSettlement(input({ ...big, style: Style.American }), 2, { radius: RADIUS });
    const towers = us.buildings.filter((b) => b.kind === 10);
    expect(towers.length).toBeGreaterThan(5);
    const meanDist = towers.reduce((a, b) => a + Math.hypot(b.x, b.y), 0) / towers.length;
    expect(meanDist).toBeLessThan(700);
    expect(Math.max(...towers.map((b) => b.height))).toBeGreaterThan(80);
    const eu = planSettlement(input({ ...big, style: Style.Western }), 2, { radius: RADIUS });
    const euTowers = eu.buildings.filter((b) => b.kind === 10);
    expect(euTowers.length).toBeGreaterThan(5);
    const euDist = euTowers.reduce((a, b) => a + Math.hypot(b.x, b.y), 0) / euTowers.length;
    expect(euDist).toBeGreaterThan(1000);
    expect(eu.metrics.outsideParcel).toBe(0);
  }, 60_000);

  it('gives Southeast Asian style only where the climate is tropical', () => {
    expect(styleFor(4, 0, Biome.TropicalRainforest)).toBe(Style.SoutheastAsian);
    expect(styleFor(4, 0, Biome.TemperateForest)).toBe(Style.Western);
    expect(styleFor(0, 2, Biome.TemperateForest)).toBe(Style.American);
  });
});
