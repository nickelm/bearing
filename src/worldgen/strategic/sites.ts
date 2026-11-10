/**
 * Candidate airbase and port sites per landmass, on the coarse grid.
 *
 * - **Airbases:** flat, low land (reference slope under AIRBASE_MAX_SLOPE,
 *   reference height under AIRBASE_MAX_HEIGHT), not lake, ice or alpine.
 *   Sites are picked greedily, best first, at least AIRBASE_SPACING apart, so
 *   the count is the landmass's airbase capacity.
 * - **Ports:** coastal land cells scored by shelter (land around about
 *   two-thirds of a 30 km circle, a bay), deep water close inshore, a river
 *   mouth and flat ground; picked greedily at least PORT_SPACING apart.
 *
 * Milestone 5 places the actual airbases and ports from these candidates.
 */
import { Biome } from '../biomes';
import { AIRBASE_SPACING, PORT_SPACING } from './graph';
import type { SiteList } from './graph';
import { CapWalker, smoothstep } from './input';
import type { StrategicContext } from './input';

export const AIRBASE_MAX_SLOPE = 0.03;
export const AIRBASE_MAX_HEIGHT = 1200;
const PORT_SHELTER_RADIUS = 30e3;
const PORT_DEPTH_RADIUS = 15e3;
const PORT_MIN_SCORE = 0.3;
const PORTS_PER_LANDMASS = 16;

export interface PortSites {
  list: SiteList;
  /** The deepest sea cell next to each port: where ships berth. */
  sea: Int32Array;
}

interface Candidate {
  cell: number;
  score: number;
  sea: number;
}

function toSiteList(ctx: StrategicContext, picked: Candidate[]): SiteList {
  const cells = new Int32Array(picked.length);
  const points = new Float64Array(picked.length * 3);
  const scores = new Float32Array(picked.length);
  picked.forEach((p, i) => {
    cells[i] = p.cell;
    points[i * 3] = ctx.grid.centers[p.cell * 3]!;
    points[i * 3 + 1] = ctx.grid.centers[p.cell * 3 + 1]!;
    points[i * 3 + 2] = ctx.grid.centers[p.cell * 3 + 2]!;
    scores[i] = p.score;
  });
  return { cells, points, scores };
}

/** Greedy pick, best score first (ties by cell index), at least `spacing` apart within a landmass. */
function pickSpaced(
  ctx: StrategicContext,
  walker: CapWalker,
  candidates: Candidate[],
  spacing: number,
  limit = Infinity,
): Map<number, Candidate[]> {
  const label = ctx.labels.label;
  candidates.sort((a, b) => b.score - a.score || a.cell - b.cell);
  const blocked = new Uint8Array(ctx.grid.cellCount);
  const out = new Map<number, Candidate[]>();
  const angle = spacing / ctx.radius;
  for (const cand of candidates) {
    if (blocked[cand.cell]) continue;
    const id = label[cand.cell]!;
    let list = out.get(id);
    if (!list) out.set(id, (list = []));
    if (list.length >= limit) continue;
    list.push(cand);
    walker.walk(
      cand.cell,
      angle,
      (c) => (blocked[c] = 1),
      (c) => label[c] === id,
    );
  }
  return out;
}

export function airbaseSites(ctx: StrategicContext, walker: CapWalker): SiteList[] {
  const { height, slope, biome, lakeDepth, reliefScale } = ctx;
  const label = ctx.labels.label;
  const candidates: Candidate[] = [];
  for (let c = 0; c < ctx.grid.cellCount; c++) {
    if (label[c]! < 0 || lakeDepth[c]! > 0) continue;
    const b = biome[c]!;
    if (b === Biome.IceSheet || b === Biome.Alpine) continue;
    const ref = height[c]! / reliefScale;
    const s = slope[c]!;
    if (s >= AIRBASE_MAX_SLOPE || ref >= AIRBASE_MAX_HEIGHT) continue;
    const score = (1 - s / AIRBASE_MAX_SLOPE) * Math.sqrt(1 - ref / AIRBASE_MAX_HEIGHT);
    candidates.push({ cell: c, score, sea: -1 });
  }
  const picked = pickSpaced(ctx, walker, candidates, AIRBASE_SPACING);
  return ctx.labels.landmasses.map((m) => toSiteList(ctx, picked.get(m.id) ?? []));
}

export function portSites(ctx: StrategicContext, walker: CapWalker): PortSites[] {
  const { grid, height, slope, discharge, reliefScale } = ctx;
  const label = ctx.labels.label;
  const shelterAngle = Math.max(PORT_SHELTER_RADIUS, 1.5 * ctx.cellSize) / ctx.radius;
  const depthAngle = Math.max(PORT_DEPTH_RADIUS, 1.2 * ctx.cellSize) / ctx.radius;
  const candidates: Candidate[] = [];
  const bestFallback = new Map<number, Candidate>();
  for (let c = 0; c < grid.cellCount; c++) {
    if (label[c]! < 0) continue;
    let sea = -1;
    for (let k = 0; k < 4; k++) {
      const nb = grid.neighbors4[c * 4 + k]!;
      if (label[nb]! < 0 && (sea < 0 || height[nb]! < height[sea]!)) sea = nb;
    }
    if (sea < 0) continue;
    let land = 0;
    let total = 0;
    walker.walk(c, shelterAngle, (x) => {
      total += grid.areas[x]!;
      if (label[x]! >= 0) land += grid.areas[x]!;
    });
    let deepest = 0;
    walker.walk(sea, depthAngle, (x) => {
      if (label[x]! < 0) deepest = Math.max(deepest, -height[x]! / reliefScale);
    });
    let q = discharge[c]!;
    for (let k = 0; k < 4; k++) q = Math.max(q, discharge[grid.neighbors4[c * 4 + k]!]!);
    const f = land / total;
    const shelter = 1 - Math.min(1, Math.abs(f - 0.65) / 0.4);
    const depth = smoothstep(20, 200, deepest);
    const river = smoothstep(50, 1000, q);
    const flat = 1 - smoothstep(0.03, 0.12, slope[c]!);
    const score = flat * (0.5 * shelter + 0.3 * depth + 0.2 * river);
    const cand = { cell: c, score, sea };
    if (score >= PORT_MIN_SCORE) candidates.push(cand);
    const id = label[c]!;
    const fb = bestFallback.get(id);
    if (!fb || score > fb.score || (score === fb.score && c < fb.cell)) bestFallback.set(id, cand);
  }
  const picked = pickSpaced(ctx, walker, candidates, PORT_SPACING, PORTS_PER_LANDMASS);
  return ctx.labels.landmasses.map((m) => {
    let list = picked.get(m.id) ?? [];
    // Every landmass with a coast gets at least its best harbor, however poor.
    if (list.length === 0 && bestFallback.has(m.id)) list = [bestFallback.get(m.id)!];
    return { list: toSiteList(ctx, list), sea: Int32Array.from(list, (p) => p.sea) };
  });
}

/** Concatenates site lists, keeping each list's order (best-first within each). */
export function mergeSites(lists: SiteList[]): SiteList {
  const n = lists.reduce((s, l) => s + l.cells.length, 0);
  const out: SiteList = {
    cells: new Int32Array(n),
    points: new Float64Array(n * 3),
    scores: new Float32Array(n),
  };
  let o = 0;
  for (const l of lists) {
    out.cells.set(l.cells, o);
    out.points.set(l.points, o * 3);
    out.scores.set(l.scores, o);
    o += l.cells.length;
  }
  return out;
}
