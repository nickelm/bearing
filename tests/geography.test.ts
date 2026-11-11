import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { coarsePass } from '../src/worldgen/coarsePass';
import { extractFeatures } from '../src/worldgen/geography';
import type { GeographyInput } from '../src/worldgen/geography';
import { prominentPeaks } from '../src/worldgen/geography/relief';
import { components, regionShape, simplify, smooth } from '../src/worldgen/geography/shape';
import { assignFlavors, labelText, nameWorld, Toponymy } from '../src/worldgen/names';
import { ISLAND_FLAVOR } from '../src/worldgen/names/flavors';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { rng } from '../src/core/rng';
import { strategicContext } from '../src/worldgen/strategic/builder';
import {
  FEATURE_GEOMETRY,
  FEATURE_KIND_COUNT,
  FeatureKind,
  featurePolyline,
  featuresOfKind,
  graphBuffers,
  pointLatLon,
  surfaceDistance,
} from '../src/worldgen/strategic/graph';
import type { Point } from '../src/worldgen/strategic/graph';
import { boxWorld, firstDifference, RADIUS, RELIEF } from './helpers/syntheticWorld';

/** Geography input for a synthetic world with no nodes (regions fall back to −1). */
function geographyOf(input: ReturnType<typeof boxWorld>): GeographyInput {
  const ctx = strategicContext(input);
  return {
    ctx,
    nodes: [],
    nodeOfLandmass: new Int32Array(ctx.labels.landmasses.length).fill(-1),
    members: [],
    chokepoints: [],
  };
}

const gauss = (lat: number, lon: number, la: number, lo: number, h: number, w: number) =>
  h * Math.exp(-((lat - la) ** 2 + (lon - lo) ** 2) / (w * w));

describe('peaks by prominence', () => {
  // Two summits on one island: 2,000 m (reference) and 1,500 m, joined by a 1,000 m col.
  const ref = (lat: number, lon: number) =>
    Math.max(
      gauss(lat, lon, 0, -6, 1900, 3),
      gauss(lat, lon, 0, 6, 1400, 3),
      lat > -1 && lat < 1 && Math.abs(lon) < 6 ? 900 : 0,
    );
  const input = boxWorld(
    64,
    [{ lat: [-12, 12], lon: [-15, 15] }],
    (la, lo) => ref(la, lo) * RELIEF,
  );
  const peaks = prominentPeaks(geographyOf(input));

  it('gives the highest summit its full height and the lower one its height above the col', () => {
    const [a, b] = peaks;
    expect(a!.prominence).toBeCloseTo(input.height[a!.cell]!, 3);
    const col = 100 + 900 * RELIEF; // physical height of the col
    expect(Math.abs(b!.prominence - (input.height[b!.cell]! - col))).toBeLessThan(25);
    const lonOf = (c: number) =>
      pointLatLon([...input.grid.centers.subarray(c * 3, c * 3 + 3)] as Point).lon / DEG;
    expect(lonOf(a!.cell)).toBeLessThan(0);
    expect(lonOf(b!.cell)).toBeGreaterThan(0);
  });

  it('gives every other summit less prominence than the lower named one', () => {
    for (const p of peaks.slice(2)) expect(p.prominence).toBeLessThan(peaks[1]!.prominence);
  });
});

describe('features on a synthetic world', () => {
  // A ring continent around an inland sea that opens east through a 6° (105 km)
  // channel, with an east–west ridge on its northern wall.
  const input = boxWorld(
    96,
    [
      { lat: [25, 40], lon: [-60, 60] },
      { lat: [-40, -25], lon: [-60, 60] },
      { lat: [-25, 25], lon: [-60, -45] },
      { lat: [3, 25], lon: [45, 60] },
      { lat: [-25, -3], lon: [45, 60] },
    ],
    (lat, lon) =>
      Math.abs(lat - 32.5) < 2.5 && Math.abs(lon) < 45
        ? 3000 * RELIEF * (1 - ((lat - 32.5) / 2.5) ** 2)
        : 0,
  );
  const geo = geographyOf(input);
  const f = extractFeatures(geo);

  it('finds a continent, a range with a ridge line along it, and peaks inside it', () => {
    expect(featuresOfKind(f, FeatureKind.Continent).length).toBeGreaterThanOrEqual(1);
    const ranges = featuresOfKind(f, FeatureKind.Range);
    expect(ranges.length).toBe(1);
    const ridge = featurePolyline(f, ranges[0]!);
    const ends = [ridge.subarray(0, 3), ridge.subarray(ridge.length - 3)].map(
      (p) => pointLatLon([p[0]!, p[1]!, p[2]!]).lon / DEG,
    );
    expect(Math.abs(ends[0]! - ends[1]!)).toBeGreaterThan(40);
    for (let i = 0; i < ridge.length; i += 3) {
      const lat = pointLatLon([ridge[i]!, ridge[i + 1]!, ridge[i + 2]!]).lat / DEG;
      expect(Math.abs(lat - 32.5)).toBeLessThan(4);
    }
    const peaks = featuresOfKind(f, FeatureKind.Peak).sort((a, b) => f.height[b]! - f.height[a]!);
    expect(peaks.length).toBeGreaterThan(0);
    expect(f.parent[peaks[0]!]).toBe(ranges[0]);
  });

  it('separates the sea behind the strait and names the strait between them', () => {
    const water = featuresOfKind(f, FeatureKind.Ocean, FeatureKind.Sea, FeatureKind.Bay);
    expect(water.length).toBeGreaterThanOrEqual(2);
    const straits = featuresOfKind(f, FeatureKind.Strait);
    expect(straits.length).toBeGreaterThanOrEqual(1);
    // The channel is 6° wide (about 105 km at R = 1,000 km), at longitude 45–60° E.
    const s = straits.find((i) => {
      const { lat, lon } = pointLatLon([
        f.anchor[i * 3]!,
        f.anchor[i * 3 + 1]!,
        f.anchor[i * 3 + 2]!,
      ]);
      return Math.abs(lat) < 4 * DEG && lon > 40 * DEG && lon < 65 * DEG;
    });
    expect(s).toBeDefined();
    expect(f.measure[s!]).toBeLessThan(150e3);
  });

  it('keeps layers consistent with kinds and anchors inside their polygons', () => {
    for (let i = 0; i < f.count; i++) {
      expect(f.kind[i]).toBeLessThan(FEATURE_KIND_COUNT);
      expect(f.importance[i]).toBeGreaterThan(0);
      expect(f.importance[i]).toBeLessThanOrEqual(1);
    }
    const v = new Vec3d();
    for (const layer of ['land', 'water', 'relief', 'cover'] as const) {
      const ids = new Set(f.layers[layer]);
      ids.delete(-1);
      for (const id of ids) {
        expect(FEATURE_GEOMETRY[f.kind[id]!]).toBe('polygon');
        const a = f.anchor.subarray(id * 3, id * 3 + 3);
        expect(f.layers[layer][input.grid.cellOfDirection(v.set(a[0]!, a[1]!, a[2]!))]).toBe(id);
      }
    }
  });
});

describe('shape helpers', () => {
  it('finds components and an axis along an elongated region', () => {
    const grid = new CubeGrid(48);
    const mask = new Uint8Array(grid.cellCount);
    for (let c = 0; c < grid.cellCount; c++) {
      const { lat, lon } = pointLatLon([...grid.centers.subarray(c * 3, c * 3 + 3)] as Point);
      if (Math.abs(lat) < 5 * DEG && Math.abs(lon) < 30 * DEG) mask[c] = 1;
      if (Math.abs(lat - 40 * DEG) < 3 * DEG && Math.abs(lon) < 3 * DEG) mask[c] = 1;
    }
    const comps = components(grid, mask);
    expect(comps.length).toBe(2);
    const big = comps.reduce((a, b) => (a.length > b.length ? a : b));
    const shape = regionShape(grid, big, (c) => mask[c] === 1 && big.includes(c), RADIUS);
    const [a, , b] = shape.axis;
    expect(Math.abs(pointLatLon(a!).lat)).toBeLessThan(5 * DEG);
    expect(surfaceDistance(a!, b!, RADIUS)).toBeGreaterThan(0.8 * 60 * DEG * RADIUS);
  });

  it('simplifies and smooths without leaving the sphere', () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = (i / 20) * 0.5;
      pts.push([Math.sin(t), 0, Math.cos(t)]);
    }
    expect(simplify(pts, 1e-6).length).toBe(2);
    for (const p of smooth(pts, 2)) expect(Math.hypot(...p)).toBeCloseTo(1, 12);
  });
});

describe('naming', () => {
  const grid = new CubeGrid(64);
  const world = coarsePass({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid });
  const g = world.graph;

  it('names every feature, settlement and corridor, all different', () => {
    const all = [
      ...g.features.names,
      ...g.settlements.names,
      ...g.fronts.flatMap((f) => f.corridors.map((c) => c.name)),
    ];
    for (const n of all) expect(n).toMatch(/^[A-Za-z][A-Za-z ']+$/);
    expect(new Set(all).size).toBe(all.length);
  });

  it('uses the generic terms of the design', () => {
    const f = g.features;
    for (let i = 0; i < f.count; i++) {
      const n = f.names[i]!;
      switch (f.kind[i]) {
        case FeatureKind.Peak:
          expect(n).toMatch(/^Mount /);
          break;
        case FeatureKind.Lake:
          expect(n).toMatch(/^Lake /);
          break;
        case FeatureKind.Range:
          expect(n).toMatch(/^the .+ (Range|Mountains)$/);
          break;
        case FeatureKind.Strait:
          expect(n).toMatch(/^the .+ (Strait|Narrows)$/);
          break;
        case FeatureKind.Desert:
          expect(n).toMatch(/^the .+ (Desert|Waste)$/);
          break;
      }
    }
    for (const c of g.fronts.flatMap((x) => x.corridors)) expect(c.name).toMatch(/^the .+ Gap$/);
    expect(labelText('the Varden Range')).toBe('Varden Range');
  });

  it('gives each node a feature of its kind', () => {
    for (const n of g.nodes) {
      expect(n.feature).toBeGreaterThanOrEqual(0);
      const kind = g.features.kind[n.feature];
      if (n.kind === 'archipelago') expect(kind).toBe(FeatureKind.Archipelago);
      else expect([FeatureKind.Continent, FeatureKind.Island]).toContain(kind);
    }
  });

  it('assigns one flavor per naming region: islands their own, the largest landmasses different ones', () => {
    const flavors = assignFlavors(g, 7);
    const land = g.nodes
      .map((n, id) => ({ n, id }))
      .filter((x) => x.n.kind === 'landmass')
      .sort((a, b) => b.n.area - a.n.area);
    if (land.length >= 2) expect(flavors[land[0]!.id]).not.toBe(flavors[land[1]!.id]);
    g.nodes.forEach((n, id) => {
      if (n.kind === 'archipelago') expect(flavors[id]).toBe(ISLAND_FLAVOR);
      else expect(flavors[id]).not.toBe(ISLAND_FLAVOR);
      expect(n.flavor).toBe(flavors[id]);
    });
  });

  it('is deterministic, and renaming leaves the geometry alone', () => {
    const again = coarsePass({ ...DEFAULT_PLANET_PARAMS, seed: 7 }, { grid }).graph;
    expect(firstDifference(again.features, g.features)).toBeNull();
    const copy = structuredClone(g);
    nameWorld(copy, 'another seed');
    expect(copy.features.names).not.toEqual(g.features.names);
    expect(
      firstDifference({ ...copy.features, names: [] }, { ...g.features, names: [] }),
    ).toBeNull();
  });

  it('round-trips through structured cloning with its buffers transferable', () => {
    const buffers = graphBuffers(g);
    expect(new Set(buffers).size).toBe(buffers.length);
    for (const b of [
      g.features.kind.buffer,
      g.features.layers.water.buffer,
      g.features.points.buffer,
    ])
      expect(buffers).toContain(b);
    expect(firstDifference(structuredClone(g).features, g.features)).toBeNull();
  });

  it('makes unique names from a stream', () => {
    const t = new Toponymy(rng(1, 'names-test'));
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const s = t.proper(i % 5);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
      expect(s.length).toBeLessThanOrEqual(12);
    }
  });
});
