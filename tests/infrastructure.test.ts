import { describe, expect, it } from 'vitest';
import { readWorld } from '../src/campaign';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { buildStrategicGraphWithContext } from '../src/worldgen/strategic/builder';
import type { StrategicBuild } from '../src/worldgen/strategic/builder';
import {
  RoadClass,
  settlementKind,
  settlementPoint,
  surfaceDistance,
} from '../src/worldgen/strategic/graph';
import type { RoadNetwork } from '../src/worldgen/strategic/graph';
import {
  AIRBASE_MIN_SPACING,
  MIN_AIRBASES,
  placeInfrastructure,
} from '../src/worldgen/strategic/infrastructure';
import { BRIDGE_MIN_DISCHARGE } from '../src/worldgen/strategic/movement';
import { LOCAL_LINK, localLinks } from '../src/worldgen/strategic/roads';
import { buildTerritory, territoryCode } from '../src/worldgen/strategic/territory';
import { boxWorld, firstDifference, graphFingerprint, RADIUS } from './helpers/syntheticWorld';

const RIVER_LON = -50;

/**
 * The campaign test's continent (a ridge at lon −30°) and rear base, plus a
 * wide river flowing south along lon −50° from 18° N to the coast.
 */
function riverWorld(seed: number): { build: StrategicBuild; river: Set<number> } {
  const input = boxWorld(
    96,
    [
      { lat: [-20, 20], lon: [-80, 20] },
      { lat: [-12, 12], lon: [105, 140] },
    ],
    (_lat, lon) => 2000 * (RADIUS / 6_371_000) * Math.exp(-(((lon + 30) / 1.5) ** 2)),
  );
  const g = input.grid;
  const receiver = new Int32Array(g.cellCount).fill(-1);
  const discharge = new Float32Array(g.cellCount);
  const river = new Set<number>();
  let c = g.cellOfDirection(latLonToDirection(18 * DEG, RIVER_LON * DEG));
  const target = latLonToDirection(-40 * DEG, RIVER_LON * DEG);
  for (let guard = 0; guard < 1000 && input.height[c]! > 0; guard++) {
    river.add(c);
    discharge[c] = 4 * BRIDGE_MIN_DISCHARGE;
    let next = -1;
    let best = -Infinity;
    for (let k = 0; k < 8; k++) {
      const nb = g.neighbors8[c * 8 + k]!;
      if (nb < 0 || river.has(nb)) continue;
      // Head south, staying on the meridian.
      const p = g.center(nb);
      const lon = Math.atan2(p.x, p.z) / DEG;
      const score = p.dot(target) - Math.abs(lon - RIVER_LON) * 0.01;
      if (score > best) {
        best = score;
        next = nb;
      }
    }
    receiver[c] = next;
    c = next;
  }
  input.discharge = discharge;
  input.receiver = receiver;
  input.seed = seed;
  return { build: buildStrategicGraphWithContext(input), river };
}

function connectedOver(roads: RoadNetwork, cells: number[]): boolean {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const union = (a: number, b: number) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (let k = 0; k < roads.count; k++) {
    for (let p = roads.offsets[k]! + 1; p < roads.offsets[k + 1]!; p++)
      union(roads.cells[p - 1]!, roads.cells[p]!);
  }
  const root = find(cells[0]!);
  return cells.every((c) => parent.has(c) && find(c) === root);
}

describe('settlements, roads and bridges in the strategic graph', () => {
  const { build, river } = riverWorld(1983);
  const { graph, ctx } = build;
  const s = graph.settlements;

  it('places settlements on dry land with populations and names', () => {
    expect(s.cells.length).toBeGreaterThan(30);
    for (let i = 0; i < s.cells.length; i++) {
      expect(ctx.height[s.cells[i]!]).toBeGreaterThan(0);
      expect(s.population[i]).toBeGreaterThan(0);
      expect(s.names[i]!.length).toBeGreaterThan(1);
    }
    const kinds = new Set(Array.from(s.population, (p) => settlementKind(p)));
    expect(kinds.has('city')).toBe(true);
    expect(new Set(s.names).size).toBe(s.names.length);
  });

  it('connects every settlement on the continent by road, over land only', () => {
    const label = ctx.labels.label;
    const main = label[s.cells[0]!]!;
    const onMain = Array.from(s.cells).filter((c) => label[c] === main);
    expect(connectedOver(graph.roads, onMain)).toBe(true);
    for (const c of graph.roads.cells) expect(label[c]).toBeGreaterThanOrEqual(0);
    expect(Array.from(graph.roads.roadClass)).toContain(RoadClass.Highway);
  });

  it('links neighboring settlements along a Gabriel graph, so roads pass through villages', () => {
    const links = localLinks(ctx, s);
    expect(links.length).toBeGreaterThan(s.cells.length * 0.8);
    const P = s.points;
    const dist = (i: number, j: number) =>
      surfaceDistance(
        [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!],
        [P[j * 3]!, P[j * 3 + 1]!, P[j * 3 + 2]!],
        ctx.radius,
      );
    let tooLong = 0;
    let witnessed = 0;
    for (const { a, b, d } of links) {
      if (d > LOCAL_LINK) tooLong++;
      for (let k = 0; k < s.cells.length; k++) {
        if (k !== a && k !== b && dist(a, k) ** 2 + dist(b, k) ** 2 < d * d * (1 - 1e-9))
          witnessed++;
      }
    }
    expect(tooLong).toBe(0);
    expect(witnessed).toBe(0);
    // Most settlements sit on a road that continues past them.
    const degree = new Map<number, Set<number>>();
    const r = graph.roads;
    for (let k = 0; k < r.count; k++)
      for (let p = r.offsets[k]! + 1; p < r.offsets[k + 1]!; p++) {
        const x = r.cells[p - 1]!;
        const y = r.cells[p]!;
        if (!degree.has(x)) degree.set(x, new Set());
        if (!degree.has(y)) degree.set(y, new Set());
        degree.get(x)!.add(y);
        degree.get(y)!.add(x);
      }
    const through = Array.from(s.cells).filter((c) => (degree.get(c)?.size ?? 0) >= 2).length;
    expect(through / s.cells.length).toBeGreaterThan(0.5);
  });

  it('bridges the river where roads cross it, and only there', () => {
    expect(graph.bridges.cells.length).toBeGreaterThan(0);
    for (const c of graph.bridges.cells) expect(river.has(c)).toBe(true);
    // No road step jumps the river without touching it.
    const g = ctx.grid;
    const westOf = (c: number) => {
      const p = g.center(c);
      return Math.atan2(p.x, p.z) / DEG < RIVER_LON;
    };
    const lat = (c: number) => Math.asin(g.center(c).y) / DEG;
    const r = graph.roads;
    for (let k = 0; k < r.count; k++) {
      for (let p = r.offsets[k]! + 1; p < r.offsets[k + 1]!; p++) {
        const a = r.cells[p - 1]!;
        const b = r.cells[p]!;
        if (river.has(a) || river.has(b) || lat(a) > 17 || lat(b) > 17) continue;
        expect(westOf(a)).toBe(westOf(b));
      }
    }
  });

  it('records road crossings on corridors and settlement offsets on lines', () => {
    expect(graph.fronts.length).toBeGreaterThan(0);
    for (const f of graph.fronts) {
      for (const k of f.corridors) {
        expect(k.roads).toBeGreaterThanOrEqual(0);
        expect(k.roadScore).toBeLessThanOrEqual(k.roads);
      }
    }
    const crossed = graph.fronts.flatMap((f) => f.corridors).some((k) => k.roads > 0);
    expect(crossed).toBe(true);
    for (const line of graph.barrierLines)
      expect(line.settlementOffset.length).toBe(s.cells.length);
  });

  it('is deterministic; the settlement seed changes towns, not landmasses', () => {
    const again = riverWorld(1983).build.graph;
    // Names the first differing quantity if this ever diverges (TODO.md Known issues).
    expect(firstDifference(again, graph, 'graph')).toBeNull();
    expect(graphFingerprint(again)).toBe(graphFingerprint(graph));
    const other = riverWorld(7).build.graph;
    expect(other.nodes.map((n) => n.area)).toEqual(graph.nodes.map((n) => n.area));
    expect(Array.from(other.settlements.cells)).not.toEqual(Array.from(s.cells));
  });
});

describe('infrastructure placed from the cast', () => {
  const { build } = riverWorld(1983);
  const { graph } = build;
  const { cast } = readWorld(graph, 1983);
  const territory = buildTerritory(build, cast);
  const infra = placeInfrastructure(build, cast, 1983);

  it("puts industry regions on each side's settlements", () => {
    for (const reg of cast.regions.filter((x) => x.kind === 'industry')) {
      const near = Array.from(graph.settlements.cells.keys()).some(
        (i) =>
          infra.settlementSide[i] === reg.side &&
          surfaceDistance(reg.point, settlementPoint(graph.settlements, i), RADIUS) < 1e3,
      );
      expect(near).toBe(true);
    }
  });

  it('gives each side enough airbases on its own land, spaced apart', () => {
    for (const side of ['alliance', 'pact'] as const) {
      const bases = infra.airbases.filter((a) => a.side === side);
      expect(bases.length).toBeGreaterThanOrEqual(MIN_AIRBASES);
      for (const a of bases) expect(territory.owner[a.cell]).toBe(territoryCode(side));
      for (const a of bases) {
        for (const b of bases) {
          if (a.id < b.id)
            expect(surfaceDistance(a.point, b.point, RADIUS)).toBeGreaterThan(
              AIRBASE_MIN_SPACING / 2 - 1,
            );
        }
      }
    }
    expect(infra.airbases.filter((a) => a.kind === 'bomber').length).toBe(4);
  });

  it('packs front bases 100–400 km behind the line and keeps bombers deep', () => {
    const front = infra.airbases.filter((a) => a.depth >= 0 && a.kind !== 'bomber');
    const band = front.filter((a) => a.depth >= 100e3 && a.depth <= 400e3).length;
    const close = front.filter((a) => a.depth < 50e3).length;
    expect(band).toBeGreaterThan(front.length / 3);
    expect(close).toBeLessThan(band / 2);
    const bombers = infra.airbases.filter((a) => a.kind === 'bomber' && a.depth >= 0);
    const meanFront = front.reduce((m, a) => m + a.depth, 0) / front.length;
    for (const b of bombers) expect(b.depth).toBeGreaterThan(meanFront);
  });

  it("places ports at the cast's port regions and links bases to the roads", () => {
    for (const reg of cast.regions.filter((x) => x.kind === 'port')) {
      expect(
        infra.ports.some(
          (p) => p.kind === 'military' && surfaceDistance(p.point, reg.point, RADIUS) <= reg.radius,
        ),
      ).toBe(true);
    }
    const onRoad = new Set([
      ...graph.roads.cells,
      ...infra.spurs.cells,
      ...graph.settlements.cells,
    ]);
    const linked = infra.airbases.filter((a) => onRoad.has(a.cell)).length;
    expect(linked).toBeGreaterThan(0.9 * infra.airbases.length);
  });

  it('marks industry and logistics targets for both sides', () => {
    for (const side of ['alliance', 'pact'] as const) {
      const kinds = new Set(infra.targets.filter((t) => t.side === side).map((t) => t.kind));
      expect(kinds.has('factory')).toBe(true);
      expect(kinds.has('power-plant')).toBe(true);
      expect(kinds.has('supply-depot') || kinds.has('rail-yard')).toBe(true);
    }
    for (const t of infra.targets) {
      expect(t.value).toBeGreaterThan(0);
      expect(t.value).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic and leaves the graph and the cast unchanged', () => {
    const before = graphFingerprint(graph);
    const castBefore = JSON.stringify(cast);
    const again = placeInfrastructure(riverWorld(1983).build, cast, 1983);
    const strip = (x: typeof infra) => graphFingerprint({ ...x, timings: [] } as never);
    expect(strip(again)).toBe(strip(infra));
    expect(graphFingerprint(graph)).toBe(before);
    expect(JSON.stringify(cast)).toBe(castBefore);
  });
});

describe('infrastructure on a generated world', () => {
  it('runs as pipeline step 10 of the campaign world', () => {
    const w = generateCampaignWorld(
      { ...DEFAULT_PLANET_PARAMS, seed: 7 },
      { grid: new CubeGrid(64) },
    );
    expect(w.graph.settlements.cells.length).toBeGreaterThan(10);
    expect(w.graph.roads.count).toBeGreaterThan(0);
    expect(w.infrastructure.airbases.length).toBeGreaterThan(0);
    expect(w.infrastructure.settlementSide.length).toBe(w.graph.settlements.cells.length);
  });
});
