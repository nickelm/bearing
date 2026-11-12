/**
 * S4 data (decision 103): the gravity-model road hierarchy, routes, railways,
 * urban extents and capitals, on the infrastructure test's synthetic continent and
 * on generated worlds.
 */
import { describe, expect, it } from 'vitest';
import { readWorld } from '../src/campaign';
import { CubeGrid } from '../src/core/cubeGrid';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { buildStrategicGraphWithContext } from '../src/worldgen/strategic/builder';
import {
  RoadClass,
  RouteKind,
  settlementPoint,
  surfaceDistance,
  URBAN_VERTICES,
  urbanPolygon,
} from '../src/worldgen/strategic/graph';
import type { RoadNetwork } from '../src/worldgen/strategic/graph';
import { placeInfrastructure } from '../src/worldgen/strategic/infrastructure';
import { RAIL_CITY_POPULATION } from '../src/worldgen/strategic/railways';
import { MOTORWAY_SHARE, TRUNK_SHARE } from '../src/worldgen/strategic/roads';
import { routeLabel } from '../src/worldgen/strategic/routes';
import { builtUpRadius } from '../src/worldgen/strategic/urban';
import { boxWorld, RADIUS } from './helpers/syntheticWorld';

function continent(seed: number) {
  const input = boxWorld(
    96,
    [
      { lat: [-20, 20], lon: [-80, 20] },
      { lat: [-12, 12], lon: [105, 140] },
    ],
    (_lat, lon) => 2000 * (RADIUS / 6_371_000) * Math.exp(-(((lon + 30) / 1.5) ** 2)),
  );
  input.seed = seed;
  return buildStrategicGraphWithContext(input);
}

function polylineLength(r: RoadNetwork, k: number, radius: number): number {
  let len = 0;
  for (let p = r.offsets[k]! + 1; p < r.offsets[k + 1]!; p++) {
    len += surfaceDistance(
      [r.points[p * 3 - 3]!, r.points[p * 3 - 2]!, r.points[p * 3 - 1]!],
      [r.points[p * 3]!, r.points[p * 3 + 1]!, r.points[p * 3 + 2]!],
      radius,
    );
  }
  return len;
}

describe('road hierarchy, routes, railways and urban extents', () => {
  const build = continent(1983);
  const { graph: g, ctx } = build;
  const r = g.roads;

  it('classes roads by gravity-model traffic: motorways carry the most', () => {
    const len = [0, 0, 0];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [0, 0, 0];
    for (let k = 0; k < r.count; k++) {
      const c = r.roadClass[k]!;
      len[c] += polylineLength(r, k, g.radius);
      lo[c] = Math.min(lo[c]!, r.traffic[k]!);
      hi[c] = Math.max(hi[c]!, r.traffic[k]!);
    }
    const total = len[0]! + len[1]! + len[2]!;
    expect(len[RoadClass.Motorway]! / total).toBeGreaterThan(0.02);
    expect(len[RoadClass.Motorway]! / total).toBeLessThan(MOTORWAY_SHARE + 0.05);
    expect((len[0]! + len[1]!) / total).toBeLessThan(MOTORWAY_SHARE + TRUNK_SHARE + 0.07);
    expect(lo[RoadClass.Motorway]!).toBeGreaterThanOrEqual(hi[RoadClass.Trunk]! * 0.999);
    expect(lo[RoadClass.Trunk]!).toBeGreaterThanOrEqual(hi[RoadClass.Secondary]! * 0.999);
  });

  it('chains routes end to end in one class, with unique numbers', () => {
    const rt = g.routes;
    expect(rt.count).toBeGreaterThan(0);
    const numbers = rt.numbers.filter(Boolean);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.some((x) => x.startsWith('M'))).toBe(true);
    const ends = (k: number) => [r.cells[r.offsets[k]!]!, r.cells[r.offsets[k + 1]! - 1]!];
    for (let i = 0; i < rt.count; i++) {
      const roads = Array.from(rt.roads.subarray(rt.offsets[i]!, rt.offsets[i + 1]!));
      for (const k of roads) {
        expect(r.roadClass[k]).toBe(rt.roadClass[i]);
        expect(r.route[k]).toBe(i);
      }
      for (let j = 1; j < roads.length; j++) {
        const a = ends(roads[j - 1]!);
        const b = ends(roads[j]!);
        expect(a.some((c) => b.includes(c))).toBe(true);
      }
      if (rt.numbers[i]) {
        expect(rt.numbers[i]![0]).toBe(rt.roadClass[i] === RoadClass.Motorway ? 'M' : 'R');
      }
      if (rt.kind[i] !== RouteKind.Numbered) expect(rt.names[i]).toMatch(/(Pass|Coast) Road$/);
      expect(routeLabel(rt, i).length).toBeGreaterThan(1);
    }
  });

  it('links cities by rail over land, with yards at stations', () => {
    const rw = g.railways;
    const s = g.settlements;
    expect(rw.lines.count).toBeGreaterThan(0);
    for (const c of rw.lines.cells) expect(ctx.labels.label[c]).toBeGreaterThanOrEqual(0);
    const stations = new Set(rw.stations);
    for (let i = 0; i < s.cells.length; i++) {
      // Every city on the main continent has a station (an islet city may have no partner).
      if (s.population[i]! >= RAIL_CITY_POPULATION && s.node[i] === s.node[0])
        expect(stations.has(i)).toBe(true);
    }
    for (const y of rw.yardSettlement) expect(stations.has(y)).toBe(true);
  });

  it('grows urban extents with about the built-up disk area, around each town', () => {
    const s = g.settlements;
    expect(g.urban.points.length).toBe(s.cells.length * URBAN_VERTICES * 3);
    for (let i = 0; i < s.cells.length; i++) {
      const r0 = builtUpRadius(s.population[i]!);
      expect(g.urban.area[i]!).toBeLessThanOrEqual(Math.PI * r0 * r0 * 1.02);
      expect(g.urban.area[i]!).toBeGreaterThan(0.05 * Math.PI * r0 * r0);
      const poly = urbanPolygon(g.urban, i);
      const c = settlementPoint(s, i);
      for (let k = 0; k < URBAN_VERTICES; k++) {
        const d = surfaceDistance(c, [poly[k * 3]!, poly[k * 3 + 1]!, poly[k * 3 + 2]!], g.radius);
        expect(d).toBeLessThan(4 * r0);
      }
    }
  });

  it("makes each side's largest settlement its capital", () => {
    const { cast } = readWorld(g, 1983);
    const infra = placeInfrastructure(build, cast, 1983);
    for (const side of ['alliance', 'pact'] as const) {
      const cap = infra.capitals[side];
      expect(cap).toBeGreaterThanOrEqual(0);
      expect(infra.settlementSide[cap]).toBe(side);
      for (let i = 0; i < g.settlements.cells.length; i++) {
        if (infra.settlementSide[i] === side)
          expect(g.settlements.population[i]!).toBeLessThanOrEqual(g.settlements.population[cap]!);
      }
    }
  });
});

describe('S4 data on a generated world', () => {
  it('numbers motorways, names pass or coast roads, and builds railways (seed 1983)', () => {
    const w = generateCampaignWorld(
      { ...DEFAULT_PLANET_PARAMS, seed: 1983 },
      { grid: new CubeGrid(128) },
    );
    const rt = w.graph.routes;
    expect(rt.numbers.some((x) => x.startsWith('M'))).toBe(true);
    expect(rt.numbers.some((x) => x.startsWith('R'))).toBe(true);
    expect(rt.names.some(Boolean)).toBe(true);
    expect(w.graph.railways.lines.count).toBeGreaterThan(3);
    expect(w.graph.railways.yards.cells.length).toBeGreaterThan(0);
  });
});
