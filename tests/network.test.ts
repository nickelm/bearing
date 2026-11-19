import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { Vec3d } from '../src/core/vec3d';
import { campaignInput, ROAD_BRIDGE_LISTS } from '../src/sim/command/campaignInput';
import { BRIDGE_CUT, DamageState } from '../src/sim/ground/damage';
import { buildNetworkInput, NetworkGraph, pointAngle } from '../src/sim/ground/network';
import { createSimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { BRIDGE_TUNING } from '../src/worldgen/strategic/bridges';
import { DETOUR_NONE } from '../src/worldgen/strategic/graph';
import { riverWorld } from './helpers/syntheticWorld';
import { syntheticConfig } from './helpers/weatherWorld';

describe('network graphs', () => {
  const { build } = riverWorld(1983);
  const { graph, ctx } = build;
  const R = graph.radius;
  const roads = buildNetworkInput('road', R, [graph.roads], [graph.bridges]);
  const net = new NetworkGraph(roads);

  it('measure angles as CubeGrid.angleBetween does, to the bit', () => {
    const g = ctx.grid;
    for (let c = 0; c < g.cellCount; c += 97) {
      for (let k = 0; k < 8; k++) {
        const nb = g.neighbors8[c * 8 + k]!;
        if (nb < 0) continue;
        const p = [
          ...g.centers.subarray(c * 3, c * 3 + 3),
          ...g.centers.subarray(nb * 3, nb * 3 + 3),
        ];
        expect(pointAngle(p, 0, 1)).toBe(g.angleBetween(c, nb));
      }
    }
  });

  it('cover every road cell and keep the network length', () => {
    expect(net.nodeCount).toBeGreaterThan(10);
    expect(net.edgeCount).toBeGreaterThan(10);
    const r = graph.roads;
    let polylines = 0;
    const cells = new Set<number>();
    for (let k = 0; k < r.count; k++) {
      for (let p = r.offsets[k]! + 1; p < r.offsets[k + 1]!; p++) {
        polylines += ctx.grid.angleBetween(r.cells[p - 1]!, r.cells[p]!) * R;
      }
      for (let p = r.offsets[k]!; p < r.offsets[k + 1]!; p++) cells.add(r.cells[p]!);
    }
    const edges = roads.edgeLength.reduce((a, b) => a + b, 0);
    expect(edges).toBeCloseTo(polylines, 0);
    // Every polyline cell is an edge point.
    const onEdges = new Set<number>();
    for (let i = 0; i < roads.points.length / 3; i++) {
      onEdges.add(
        ctx.grid.cellOfDirection(
          new Vec3d(roads.points[i * 3]!, roads.points[i * 3 + 1]!, roads.points[i * 3 + 2]!),
        ),
      );
    }
    for (const c of cells) expect(onEdges.has(c)).toBe(true);
    // Each edge runs from its A node's cell to its B node's cell.
    for (let e = 0; e < net.edgeCount; e++) {
      const o = roads.pointOffsets[e]!;
      const last = roads.pointOffsets[e + 1]! - 1;
      expect(roads.points[o * 3]).toBe(roads.nodePoint[roads.edgeA[e]! * 3]);
      expect(roads.points[last * 3]).toBe(roads.nodePoint[roads.edgeB[e]! * 3]);
    }
  });

  it('find each bridge’s recorded detour when the bridge is cut', () => {
    const rivers = build.roads.rivers;
    const nodeOf = new Map(Array.from(roads.nodeCell, (c, i) => [c, i]));
    let compared = 0;
    let none = 0;
    for (let b = 0; b < net.bridgeCount; b++) {
      const i = roads.bridgeIndex[b]!;
      const c = graph.bridges.cells[i]!;
      // The two banks as bridges.ts chooses them: its neighbors on the network.
      const near = net
        .neighbors(roads.bridgeNode[b]!)
        .map((x) => roads.nodeCell[x.node]!)
        .sort((p, q) => p - q);
      const left = near.filter((y) => rivers.side(c, y) > 0);
      const right = near.filter((y) => rivers.side(c, y) < 0);
      if (left.length === 0 || right.length === 0) continue;
      const from = nodeOf.get(left[0]!)!;
      const to = nodeOf.get(right[0]!)!;
      const across =
        ctx.grid.angleBetween(left[0]!, c) * R + ctx.grid.angleBetween(c, right[0]!) * R;
      const d = net.distance(from, to, new Set([b]), BRIDGE_TUNING.detourReach + across);
      const recorded = graph.bridges.detour[i]!;
      if (recorded === DETOUR_NONE) {
        expect(d).toBe(Infinity);
        none++;
      } else {
        // Float32 storage of the recorded detour; summation order along chains.
        expect(Math.abs(Math.max(0, d - across) - recorded)).toBeLessThan(1 + 1e-6 * recorded);
        compared++;
      }
      // Uncut, the bridge is the way across.
      expect(net.distance(from, to)).toBeCloseTo(across, 3);
    }
    expect(compared).toBeGreaterThan(0);
    expect(compared + none).toBeGreaterThan(0);
  });
});

describe('networks in the campaign', () => {
  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const input = campaignInput(w.graph, w.campaign.cast, w.infrastructure);

  it('carry the roads with their spurs, and the railways', () => {
    expect(input.roads.edgeA.length).toBeGreaterThan(0);
    expect(input.rail.edgeA.length).toBeGreaterThan(0);
    // Spur bridges join the road graph after the civilian ones.
    expect(Array.from(input.roads.bridgeSource)).toEqual(
      [...Array.from(input.roads.bridgeSource)].sort((a, b) => a - b),
    );
    expect(structuredClone(input.roads)).toEqual(input.roads);
  });

  it('cut a bridge once its target is damaged enough, and save the damage with the state', () => {
    const sim = createSimWorld({ ...syntheticConfig(7), campaign: input });
    const damage = sim.damage!;
    const road = sim.networks!.road;
    const targets = input.targets.filter((t) => t.bridge && t.bridge.list === 'road');
    expect(targets.length).toBeGreaterThan(0);
    const t = targets[0]!;
    damage.hit(t.id, 0.3);
    expect(damage.cutBridges(input.roads, ROAD_BRIDGE_LISTS).size).toBe(0);
    damage.hit(t.id, 0.3);
    expect(damage.damage(t.id)).toBeCloseTo(1 - 0.7 * 0.7, 12);
    expect(damage.damage(t.id)).toBeGreaterThanOrEqual(BRIDGE_CUT);
    const cut = damage.cutBridges(input.roads, ROAD_BRIDGE_LISTS);
    expect(cut.size).toBe(1);
    const b = [...cut][0]!;
    expect(road.input.bridgeIndex[b]).toBe(t.bridge!.index);
    // The bridge's own edge is closed: going round costs at least as much.
    const [x, y] = road.neighbors(road.input.bridgeNode[b]!).map((n) => n.node);
    if (x !== undefined && y !== undefined) {
      expect(road.distance(x, y, cut)).toBeGreaterThanOrEqual(road.distance(x, y));
    }
    // Saved and restored with the campaign.
    const saved = sim.sim.save();
    const other = createSimWorld({ ...syntheticConfig(7), campaign: input });
    other.sim.load(saved);
    expect(other.damage!.damaged()).toEqual(damage.damaged());
    expect(other.sim.hash()).toBe(sim.sim.hash());
    const fresh = new DamageState(input.targets);
    expect(() => fresh.hit(input.targets.length, 0.5)).toThrow();
  });
});
