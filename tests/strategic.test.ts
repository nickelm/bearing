import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { labelLandmasses, landmassStats, referenceSlope } from '../src/worldgen/landmasses';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { buildStrategicGraph } from '../src/worldgen/strategic/builder';
import { coarsePass } from '../src/worldgen/coarsePass';
import {
  AIRBASE_SPACING,
  FRONT_MIN_SIDE,
  graphBuffers,
  nodeDistance,
  pointLatLon,
  polylinePoint,
  sitePoint,
  STRAIT_MAX_WIDTH,
  surfaceDistance,
} from '../src/worldgen/strategic/graph';
import { DEG } from '../src/core/units';
import { boxWorld, graphFingerprint, RADIUS } from './helpers/syntheticWorld';

const RES = 64;
const grid = new CubeGrid(RES);

describe('landmass statistics', () => {
  const world = coarsePass({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid }).world;
  const m = world.maps;
  const labels = labelLandmasses(grid, m.height, DEFAULT_PLANET_PARAMS.radius);
  const slope = referenceSlope(
    grid,
    m.height,
    DEFAULT_PLANET_PARAMS.reliefScale,
    DEFAULT_PLANET_PARAMS.radius,
  );
  const stats = landmassStats(
    grid,
    labels,
    m.height,
    m.biome,
    slope,
    DEFAULT_PLANET_PARAMS.reliefScale,
    DEFAULT_PLANET_PARAMS.radius,
  );

  it('gives every landmass a unit centroid on its own land, a coast and a terrain mix', () => {
    expect(stats.length).toBe(labels.landmasses.length);
    const big = stats[0]!;
    expect(Math.hypot(...big.centroid)).toBeCloseTo(1, 9);
    expect(big.coastlineLength).toBeGreaterThan(0);
    expect(big.latMax).toBeGreaterThanOrEqual(big.latMin);
    for (const s of stats) {
      const t = s.terrain;
      expect(t.plains + t.hills + t.mountains).toBeCloseTo(1, 6);
      for (const v of Object.values(t)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('strategic graph on a synthetic strait', () => {
  // Continents A (west) and B (east); walls C1 and C2 leave a 6° (105 km) channel between them.
  const input = boxWorld(96, [
    { lat: [-10, 10], lon: [-45, -25] },
    { lat: [-10, 10], lon: [25, 45] },
    { lat: [3, 25], lon: [-15, 15] },
    { lat: [-25, -3], lon: [-15, 15] },
  ]);
  const g = buildStrategicGraph(input);

  it('has four landmass nodes with ports and airbase sites', () => {
    expect(g.nodes.length).toBe(4);
    for (const n of g.nodes) {
      expect(n.kind).toBe('landmass');
      expect(n.ports.cells.length).toBeGreaterThan(0);
      expect(n.airbases.cells.length).toBeGreaterThan(0);
    }
  });

  it('spaces airbase sites at least AIRBASE_SPACING apart', () => {
    for (const n of g.nodes) {
      const k = n.airbases.cells.length;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          expect(
            surfaceDistance(sitePoint(n.airbases, i), sitePoint(n.airbases, j), RADIUS),
          ).toBeGreaterThanOrEqual(AIRBASE_SPACING * 0.999);
        }
      }
    }
  });

  it('routes the lane between the continents through the channel and finds the strait', () => {
    const west = g.nodes.findIndex((n) => pointLatLon(n.centroid).lon < -20 * DEG);
    const east = g.nodes.findIndex((n) => pointLatLon(n.centroid).lon > 20 * DEG);
    const lane = g.lanes.find((l) => l.a === Math.min(west, east) && l.b === Math.max(west, east))!;
    expect(lane).toBeDefined();
    // Through the channel, not around the walls.
    expect(lane.length).toBeLessThan(1400e3);
    expect(lane.minWidth).toBeGreaterThan(80e3);
    expect(lane.minWidth).toBeLessThan(STRAIT_MAX_WIDTH);
    const strait = g.chokepoints.find((c) => c.kind === 'strait' && c.lanes.includes(lane.id))!;
    expect(strait).toBeDefined();
    expect(Math.abs(pointLatLon(strait.point).lat)).toBeLessThan(3 * DEG);
    expect(Math.abs(pointLatLon(strait.point).lon)).toBeLessThan(16 * DEG);
  });

  it('measures symmetric coast-to-coast node distances', () => {
    const N = g.nodes.length;
    for (let a = 0; a < N; a++) {
      expect(nodeDistance(g, a, a)).toBe(0);
      for (let b = 0; b < N; b++) expect(nodeDistance(g, a, b)).toBe(nodeDistance(g, b, a));
    }
  });
});

describe('front generator on a synthetic continent', () => {
  // A 40° × 120° continent with a north–south ridge at 10° E.
  const input = boxWorld(
    96,
    [{ lat: [-20, 20], lon: [-60, 60] }],
    (_lat, lon) => 2000 * (RADIUS / 6_371_000) * Math.exp(-(((lon - 10) / 1.5) ** 2)),
  );
  const g = buildStrategicGraph(input);
  const f = g.fronts[0]!;

  it('finds parallel lines across the long axis, the strongest along the ridge', () => {
    expect(g.fronts.length).toBe(1);
    expect(f.lines.length).toBeGreaterThanOrEqual(2);
    const strongest = g.barrierLines[f.strongest]!;
    let lon = 0;
    const count = strongest.points.length / 3;
    for (let i = 0; i < count; i++) lon += pointLatLon(polylinePoint(strongest.points, i)).lon;
    expect(Math.abs(lon / count / DEG - 10)).toBeLessThan(4);
    // Lines are ordered along the axis.
    const fractions = f.lines.map((id) => g.barrierLines[id]!.sides[0].fraction);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
  });

  it('puts the start line one line forward of the strongest, with both sides above the minimum', () => {
    expect(f.start).toBeGreaterThanOrEqual(0);
    const start = g.barrierLines[f.start]!;
    expect(Math.min(start.sides[0].fraction, start.sides[1].fraction)).toBeGreaterThanOrEqual(
      FRONT_MIN_SIDE,
    );
    const i = f.lines.indexOf(f.start);
    const s = f.lines.indexOf(f.strongest);
    if (i !== s) {
      expect(Math.abs(i - s)).toBe(1);
      // The attacker's side is away from the strongest line.
      expect(f.forwardSide).toBe(i > s ? 1 : 0);
    }
    expect(start.sides[0].fraction + start.sides[1].fraction).toBeLessThanOrEqual(1);
    expect(start.sides[0].fraction + start.sides[1].fraction).toBeGreaterThan(0.9);
  });

  it('signs site offsets by side and finds corridors on weak segments', () => {
    const start = g.barrierLines[f.start]!;
    const neg = [...start.airbaseOffset].filter((x) => x < 0).length;
    const pos = [...start.airbaseOffset].filter((x) => x > 0).length;
    expect(neg).toBeGreaterThan(0);
    expect(pos).toBeGreaterThan(0);
    for (const c of f.corridors) {
      expect(c.strength).toBeLessThanOrEqual(g.barrierLines[c.line]!.meanStrength + 1e-6);
      expect(surfaceDistance(c.from, c.to, RADIUS)).toBeGreaterThan(150e3);
    }
  });
});

describe('strategic graph on generated worlds', () => {
  const g = coarsePass({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid }).graph;

  it('is deterministic', () => {
    const again = coarsePass({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid }).graph;
    expect(graphFingerprint(again)).toBe(graphFingerprint(g));
  });

  it('keeps node, lane and chokepoint references consistent', () => {
    expect(g.nodes.length).toBeGreaterThan(0);
    g.nodes.forEach((n, i) => {
      expect(n.id).toBe(i);
      if (n.front >= 0) expect(g.fronts[n.front]!.node).toBe(i);
    });
    // Landmasses first, then archipelagos.
    const firstArch = g.nodes.findIndex((n) => n.kind === 'archipelago');
    if (firstArch >= 0)
      expect(g.nodes.slice(firstArch).every((n) => n.kind === 'archipelago')).toBe(true);
    for (const l of g.lanes) {
      expect(l.a).toBeLessThan(l.b);
      expect(l.portA).toBeLessThan(g.nodes[l.a]!.ports.cells.length);
      expect(l.portB).toBeLessThan(g.nodes[l.b]!.ports.cells.length);
      expect(l.length).toBeGreaterThan(0);
    }
    for (const c of g.chokepoints) {
      expect(c.lanes.length).toBeGreaterThan(0);
      for (const id of c.lanes) expect(g.lanes[id]).toBeDefined();
    }
    expect(g.airbaseCapacity).toBe(g.nodes.reduce((s, n) => s + n.airbases.cells.length, 0));
  });

  it('lists each typed array once for transfer', () => {
    const bufs = graphBuffers(g);
    expect(new Set(bufs).size).toBe(bufs.length);
    expect(bufs).toContain(g.nodeDistance.buffer);
  });
});
