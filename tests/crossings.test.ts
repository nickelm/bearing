/**
 * Crossing sites on the coarse rivers (decision 175): where they are, what
 * they score, and how they pull settlements and discount bridges.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { buildStrategicGraphWithContext } from '../src/worldgen/strategic/builder';
import { CROSSING_TUNING, crossingScores } from '../src/worldgen/strategic/crossings';
import { BridgeKind, DETOUR_NONE, graphBuffers } from '../src/worldgen/strategic/graph';
import { CubeGrid } from '../src/core/cubeGrid';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RIVER_TUNING } from '../src/worldgen/rivers';
import { BRIDGE_MIN_DISCHARGE, RiverGeometry } from '../src/worldgen/strategic/movement';
import { habitability } from '../src/worldgen/strategic/settlements';
import { boxWorld, graphFingerprint, RADIUS } from './helpers/syntheticWorld';

const RIVER_LON = -50;

/** A continent with a river flowing south along lon −50° in a gentle valley, bending once. */
function valleyWorld(seed: number) {
  const input = boxWorld(
    96,
    [{ lat: [-20, 20], lon: [-80, 20] }],
    (_lat, lon) => (RADIUS / 6_371_000) * (300 + 120 * Math.abs(lon - RIVER_LON)),
  );
  const g = input.grid;
  const receiver = new Int32Array(g.cellCount).fill(-1);
  const discharge = new Float32Array(g.cellCount);
  const river: number[] = [];
  let c = g.cellOfDirection(latLonToDirection(18 * DEG, RIVER_LON * DEG));
  const target = latLonToDirection(-40 * DEG, RIVER_LON * DEG);
  const seen = new Set<number>();
  for (let guard = 0; guard < 1000 && input.height[c]! > 0; guard++) {
    river.push(c);
    seen.add(c);
    discharge[c] = 4 * BRIDGE_MIN_DISCHARGE;
    let next = -1;
    let best = -Infinity;
    for (let k = 0; k < 8; k++) {
      const nb = g.neighbors8[c * 8 + k]!;
      if (nb < 0 || seen.has(nb)) continue;
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

describe('crossing sites (decision 175)', () => {
  const { build, river } = valleyWorld(1983);
  const { graph, ctx } = build;
  const onRiver = new Set(river);
  const index = new Map(river.map((c, i) => [c, i]));

  it('lie on the river, one per reach, with scores above the threshold', () => {
    const cr = graph.crossings;
    expect(cr.cells.length).toBeGreaterThan(3);
    const at = [...cr.cells].map((c) => index.get(c)!).sort((a, b) => a - b);
    for (const [i, c] of [...cr.cells].entries()) {
      expect(onRiver.has(c)).toBe(true);
      expect(cr.score[i]).toBeGreaterThanOrEqual(CROSSING_TUNING.minScore);
      expect(cr.score[i]).toBeLessThanOrEqual(1);
      expect(cr.riverWidth[i]).toBeGreaterThan(0);
    }
    for (let i = 1; i < at.length; i++)
      expect(at[i]! - at[i - 1]!).toBeGreaterThan(CROSSING_TUNING.spacing);
  });

  it('score nothing off the river, at the mouth or on flat, soft banks', () => {
    const rivers = new RiverGeometry(ctx);
    const scores = crossingScores(ctx, rivers);
    for (let c = 0; c < ctx.grid.cellCount; c++) if (!onRiver.has(c)) expect(scores[c]).toBe(0);
    expect(scores[river[river.length - 1]!]).toBe(0);
    // The same river on a flat plain: soft banks everywhere, no crossing scores.
    const flatCtx = { ...ctx, slope: new Float32Array(ctx.grid.cellCount) };
    const flat = crossingScores(flatCtx, new RiverGeometry(flatCtx));
    expect(Math.max(...flat)).toBe(0);
  });

  it('pull settlements toward the crossings', () => {
    const ports = new Set<number>();
    const pulled = habitability(ctx, ports);
    const plain = habitability({ ...ctx, crossingNear: undefined }, ports);
    for (const c of graph.crossings.cells) expect(pulled[c]!).toBeGreaterThan(plain[c]!);
    let differs = 0;
    for (let c = 0; c < ctx.grid.cellCount; c++) if (pulled[c] !== plain[c]) differs++;
    // Only the sites and their neighbors change.
    expect(differs).toBeLessThanOrEqual(graph.crossings.cells.length * 9);
  });

  it('travel with the graph and are deterministic', () => {
    const buffers = graphBuffers(graph);
    expect(buffers).toContain(graph.crossings.cells.buffer);
    expect(buffers).toContain(graph.crossings.score.buffer);
    expect(graphFingerprint(valleyWorld(1983).build.graph)).toBe(graphFingerprint(graph));
    expect([...valleyWorld(1983).build.graph.crossings.cells]).toEqual([...graph.crossings.cells]);
  });
});

describe('bridges (decision 179)', () => {
  const { build } = valleyWorld(1983);
  const { graph } = build;
  const all = [
    { b: graph.bridges, rail: false },
    { b: graph.railways.bridges, rail: true },
  ];

  it('each has a kind, a span over its river, traffic, a detour and a unique name', () => {
    const names = new Set<string>();
    let total = 0;
    for (const { b, rail } of all) {
      for (let i = 0; i < b.cells.length; i++) {
        total++;
        expect(Object.values(BridgeKind)).toContain(b.kind[i]);
        expect(b.span[i]).toBeGreaterThanOrEqual(b.riverWidth[i]!);
        expect(b.traffic[i]).toBeGreaterThanOrEqual(0);
        expect(b.detour[i] === DETOUR_NONE || b.detour[i]! >= 0).toBe(true);
        expect(b.names[i]).toMatch(
          rail ? /(Rail Bridge|Viaduct)( [IVX]+| \d+)?$/ : /(Bridge|Viaduct)( [IVX]+| \d+)?$/,
        );
        expect(names.has(b.names[i]!)).toBe(false);
        names.add(b.names[i]!);
      }
    }
    expect(total).toBeGreaterThan(0);
    // A river with several bridges: some can be bypassed over another.
    expect([...graph.bridges.detour].some((d) => d > 0)).toBe(true);
  });

  it('cross every river that needs one, down to the rivers the world draws', () => {
    expect(BRIDGE_MIN_DISCHARGE).toBe(RIVER_TUNING.minDischarge);
  });
});

describe('bridges as targets (decision 179)', () => {
  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const infra = w.infrastructure;
  const bridgeTargets = infra.targets.filter((t) => t.kind === 'bridge');

  it('makes every bridge in held territory a target, named after it', () => {
    const lists = [w.graph.bridges, w.graph.railways.bridges, infra.spurBridges];
    let held = 0;
    const names = new Set<string>();
    for (const b of lists)
      for (let i = 0; i < b.cells.length; i++) {
        const owner = infra.territory[b.cells[i]!]!;
        if (owner === 1 || owner === 2) {
          held++;
          names.add(b.names[i]!);
        }
      }
    expect(bridgeTargets.length).toBe(held);
    for (const t of bridgeTargets) {
      expect(names.has(t.name)).toBe(true);
      expect(t.value).toBeGreaterThan(0);
      expect(t.value).toBeLessThanOrEqual(1);
      expect(infra.territory[t.cell]).toBe(t.side === 'alliance' ? 1 : 2);
    }
    // Target ids stay their index.
    infra.targets.forEach((t, i) => expect(t.id).toBe(i));
  });
});
