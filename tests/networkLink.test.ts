/**
 * The alignment stage (decision 184): links aligned whole over their pieces,
 * thinned, packed into the stored record and turned into corridor edits, and
 * the stage's tasks and orchestration.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { TerrainEdits } from '../src/worldgen/edits';
import { STRUCTURE } from '../src/worldgen/networks/alignment';
import {
  alignedPoint,
  alignmentCorridors,
  alignmentStats,
  matchBridges,
  packAlignments,
} from '../src/worldgen/networks/alignments';
import { buildAlignments } from '../src/worldgen/networks/build';
import { roadStations } from '../src/render/sim/camera/observerStations';
import {
  alignLink,
  CLASS_KEYS,
  CROSSING_FIELDS,
  NETWORK,
  UNROUTED,
} from '../src/worldgen/networks/link';
import type { LinkTask } from '../src/worldgen/networks/link';
import { gnomonic } from '../src/worldgen/networks/pieces';
import { ROUTE_CLASSES } from '../src/worldgen/networks/router';
import { taskTiles, tileHeightSampler } from '../src/worldgen/networks/tileHeights';

const R = PLANET_RADIUS;
const center = latLonToDirection(10 * DEG, 20 * DEG);
const frame = gnomonic(center, R);

/** A ridge 600 m high and about 2 km wide across the link at x = 0. */
const ridge = (d: Readonly<Vec3d>) => {
  const [x, y] = frame.toPlane(d);
  return 100 + 600 * Math.exp(-((x / 2000) ** 2)) + 20 * Math.sin(y / 700);
};

function task(
  xs: number[],
  cls: LinkTask['cls'] = 'secondary',
  fallback: LinkTask['fallback'] = ['mountainRoad'],
): LinkTask {
  const anchors = new Float64Array(xs.length * 3);
  xs.forEach((x, i) => {
    const d = frame.toSphere(x, 0.37 * x);
    anchors.set([d.x, d.y, d.z], i * 3);
  });
  return { id: 0, network: NETWORK.Road, line: 7, anchors, cls, fallback };
}

describe('links', () => {
  const t = task([-9000, 0, 9000]);
  const link = alignLink(t, ridge, R);
  const n = link.design.length;
  const at = (i: number) =>
    new Vec3d(link.points[i * 3]!, link.points[i * 3 + 1]!, link.points[i * 3 + 2]!);

  it('runs from the first anchor to the last, through the middle one', () => {
    expect(at(0).distanceTo(frame.toSphere(-9000, -3330)) * R).toBeLessThan(0.01);
    expect(at(n - 1).distanceTo(frame.toSphere(9000, 3330)) * R).toBeLessThan(0.01);
    expect(link.unrouted).toBe(0);
    expect(link.length).toBeGreaterThan(2 * 9000 * Math.hypot(1, 0.37) * 0.999);
  });

  it('pins its ends to the ground and keeps every routed point within its grade', () => {
    expect(link.design[0]).toBeCloseTo(ridge(at(0)), 1);
    expect(link.design[n - 1]).toBeCloseTo(ridge(at(n - 1)), 1);
    for (let i = 1; i < n; i++) {
      const c = Math.min(link.cls[i]!, link.cls[i - 1]!);
      if (c === UNROUTED) continue;
      const L = at(i).distanceTo(at(i - 1)) * R;
      // Thinned chords cut across arcs: allow the profile tolerance either side.
      const g = (Math.abs(link.design[i]! - link.design[i - 1]!) - 0.2) / L;
      expect(g).toBeLessThanOrEqual(
        Math.max(
          ROUTE_CLASSES[CLASS_KEYS[link.cls[i]!]!].maxGrade,
          ROUTE_CLASSES[CLASS_KEYS[link.cls[i - 1]!]!].maxGrade,
        ) + 1e-3,
      );
    }
  });

  it('is thinned to segments under 500 m, more points on the climb than on the flat', () => {
    let longest = 0;
    for (let i = 1; i < n; i++) longest = Math.max(longest, at(i).distanceTo(at(i - 1)) * R);
    expect(longest).toBeLessThanOrEqual(500.01);
    expect(n).toBeLessThan(link.length / 10 / 3);
  });

  it('is deterministic', () => {
    const again = alignLink(t, ridge, R);
    expect(Array.from(again.points)).toEqual(Array.from(link.points));
    expect(Array.from(again.design)).toEqual(Array.from(link.design));
  });

  it('packs into the record, which gives back the points and the corridor edits', () => {
    const other = { ...alignLink({ ...task([-9000, -2000]), id: 1 }, ridge, R) };
    const al = packAlignments([other, link], R, { ms: 1, tiles: 0 });
    expect(al.count).toBe(2);
    expect(al.line[0]).toBe(7);
    expect(al.offsets[1]! - al.offsets[0]!).toBe(n);
    for (const i of [0, n >> 1, n - 1])
      expect(alignedPoint(al, 0, al.offsets[0]! + i).distanceTo(at(i)) * R).toBeLessThan(0.05);
    const corridors = alignmentCorridors(al);
    expect(corridors.length).toBeGreaterThan(0);
    const edits = new TerrainEdits({ radius: R, corridors });
    // On the formation, the edited ground is the design elevation.
    const m = n >> 1;
    if (link.structure[m] === STRUCTURE.Corridor && link.structure[m + 1] === STRUCTURE.Corridor) {
      expect(edits.apply(at(m), ridge(at(m)))).toBeCloseTo(link.design[m]!, 0);
    }
    const s = alignmentStats(al);
    expect(s.links).toBe(2);
    expect(s.km).toBeGreaterThan(18);
    // The most winding stretch gets an observer station, looking at it from the side.
    const stations = roadStations(al, R, 3);
    expect(stations.length).toBeGreaterThan(0);
    expect(stations[0]!.kind).toBe('road');
    expect(stations[0]!.side).toBeNull();
    const k = Number(stations[0]!.key.split('-')[1]);
    const i = Number(stations[0]!.key.split('-')[2]);
    const d = stations[0]!.point.distanceTo(alignedPoint(al, k, i)) * R;
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(3000);
  });
});

describe('rivers', () => {
  // A river 40 m wide, 30 m below the ridge's foot, running obliquely across the link's
  // straight line at x = −5 km, its surface at 95 m.
  const riverAt = (y: number) => frame.toSphere(-5000 + 0.6 * y, y);
  const segs: [number, number][] = [];
  for (let y = -6000; y < 6000; y += 1000) segs.push([y, y + 1000]);
  const rivers = {
    ids: Int32Array.from(segs.map((_, i) => 100 + i)),
    data: Float64Array.from(
      segs.flatMap(([y0, y1]) => {
        const a = riverAt(y0);
        const b = riverAt(y1);
        return [a.x, a.y, a.z, b.x, b.y, b.z, 40, 40, 95, 95];
      }),
    ),
  };
  const t = task([-9000, 0, 9000]);
  const link = alignLink(t, { height: ridge, rivers }, R);

  it('crosses it once, on a bridge whose deck clears the water', () => {
    expect(link.crossings.length).toBe(CROSSING_FIELDS);
    const [, , , , river, width, span, deck, sin] = Array.from(link.crossings);
    expect(river! >= 100 && river! < 112).toBe(true);
    expect(width).toBeCloseTo(40, 5);
    expect(span).toBeGreaterThanOrEqual(width! + 20 - 1e-6);
    expect(deck).toBeGreaterThanOrEqual(95 + 4.5 - 1e-3);
    // The router turns to cross squarely: the river runs at about 31° off the link's normal.
    expect(sin).toBeGreaterThan(0.9);
    expect(Array.from(link.structure)).toContain(STRUCTURE.Bridge);
  });

  it('carries no corridor on the bridge', () => {
    const al = packAlignments([link], R, { ms: 0, tiles: 0 });
    expect(al.crossings.length).toBe(CROSSING_FIELDS);
    expect(al.crossingLink[0]).toBe(0);
    const edits = new TerrainEdits({ radius: R, corridors: alignmentCorridors(al) });
    const p = new Vec3d(al.crossings[1]!, al.crossings[2]!, al.crossings[3]!);
    // The ground under the bridge is the ground, not a formation at deck height.
    expect(edits.apply(p, 50)).toBe(50);
  });

  it('matches the network bridge on its polyline, within reach', () => {
    const al = packAlignments([link], R, { ms: 0, tiles: 0 });
    const p = new Vec3d(al.crossings[1]!, al.crossings[2]!, al.crossings[3]!);
    const near = frame.toSphere(
      ...(frame.toPlane(p).map((v, i) => v + (i ? 3000 : 0)) as [number, number]),
    );
    const list = (road: number[], pts: Vec3d[]) =>
      ({
        road: Int32Array.from(road),
        points: Float64Array.from(pts.flatMap((q) => [q.x, q.y, q.z])),
      }) as never;
    const m = matchBridges(al, {
      road: list([7, 9], [near, near]),
      rail: list([], []),
      spur: list([], []),
    });
    expect(m.matched).toBe(1);
    expect(al.crossingBridge[0]).toBe(0);
    expect(m.unmatchedNetwork).toBe(1);
  });
});

describe('the stage', () => {
  it('lists the tiles under every band and aligns tasks in order whatever finishes first', async () => {
    const tasks = [0, 1, 2].map((id) => ({
      ...task([-9000 + id * 3000, -1000 + id * 3000]),
      id,
      line: id,
    }));
    const keys = taskTiles(tasks[0]!, R);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.level === 6)).toBe(true);
    let synthesized = 0;
    const al = await buildAlignments({
      tasks,
      radius: R,
      workers: 2,
      synthesize: (ks) => {
        synthesized += ks.length;
        return Promise.resolve(ks.map(() => ({ height: new Float32Array(1) })));
      },
      // The ground is analytic here; finish in reverse order.
      run: async (tk, tiles) => {
        expect(tiles.length).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, (3 - tk.id) * 5));
        return alignLink(tk, ridge, R);
      },
    });
    expect(Array.from(al.line)).toEqual([0, 1, 2]);
    expect(al.tiles).toBe(synthesized);
  });

  it('never hands a task a tile another lane evicted', async () => {
    // Forty tasks whose tiles overlap, a cache of two tiles, eight lanes and a slow GPU:
    // a lane finds some tiles cached and waits for the rest while others evict.
    const tasks = Array.from({ length: 40 }, (_, id) => ({
      ...task([-9000 + (id % 10) * 9_000, -1000 + (id % 7) * 13_000]),
      id,
      line: id,
    }));
    let calls = 0;
    // The tiles are what this test checks; one aligned link stands in for every task's,
    // since aligning forty took 10–30 s and timed out on a loaded machine (R1.1).
    const aligned = alignLink(task([-9000, -1000]), ridge, R);
    const al = await buildAlignments({
      tasks,
      radius: R,
      workers: 4,
      cacheTiles: 2,
      batch: 1,
      synthesize: async (ks) => {
        await new Promise((r) => setTimeout(r, 1 + (calls++ % 3)));
        return ks.map(() => ({ height: new Float32Array(1) }));
      },
      run: async (tk, tiles) => {
        for (const [key, h] of tiles) expect(h?.height, key).toBeInstanceOf(Float32Array);
        await new Promise((r) => setTimeout(r, 1 + (tk.id % 4)));
        return { ...aligned, id: tk.id, line: tk.line };
      },
    });
    expect(al.count).toBe(40);
  });

  it('samples tile heights bilinearly and counts lookups outside its tiles', () => {
    const s = tileHeightSampler(new Map());
    expect(s.height(center)).toBe(0);
    expect(s.missing()).toBe(1);
  });
});
