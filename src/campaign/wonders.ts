/**
 * Natural wonders for the war (proposal 0007, decision 214): from the graph's
 * candidates, 5 to 15 per world, favoring those near the fronts and the sea
 * lanes in play, where pilots will see them. Reads the strategic graph and the
 * cast only (rule 9); draws from `rng(seed, "wonders")`, so casting's own stream
 * is unchanged.
 */
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { FeatureKind } from '../worldgen/strategic/graph';
import type { StrategicGraph } from '../worldgen/strategic/graph';
import type { Cast } from './cast';

export const WONDER_COUNT: readonly [number, number] = [5, 15];
/** Distance (m) at which a front's or lane's pull on a wonder falls to 1/e. */
const PULL = 300e3;
/** Selected wonders stand at least this far apart (m). */
const SPACING = 120e3;
/** At most this many wonders of one kind. */
const PER_KIND = 2;

export function selectWonders(graph: StrategicGraph, cast: Cast, seed: WorldSeed): number[] {
  const f = graph.features;
  const ids: number[] = [];
  for (let i = 0; i < f.count; i++) if (f.kind[i] === FeatureKind.Wonder) ids.push(i);
  if (ids.length === 0) return [];
  // Points of the fronts and lanes in play.
  const pts: number[] = [];
  for (const t of cast.theaters) {
    if (t.front !== undefined) {
      const fr = graph.fronts[t.front];
      const line = fr && fr.start >= 0 ? graph.barrierLines[fr.lines[fr.start]!] : undefined;
      if (line)
        for (let k = 0; k < line.points.length; k += 3 * 4)
          pts.push(line.points[k]!, line.points[k + 1]!, line.points[k + 2]!);
    }
    if (t.lane !== undefined) {
      const lane = graph.lanes[t.lane];
      if (lane)
        for (let k = 0; k < lane.points.length; k += 3 * 4)
          pts.push(lane.points[k]!, lane.points[k + 1]!, lane.points[k + 2]!);
    }
  }
  const R = graph.radius;
  const weight = ids.map((i) => {
    const [x, y, z] = [f.anchor[3 * i]!, f.anchor[3 * i + 1]!, f.anchor[3 * i + 2]!];
    let best = Infinity;
    for (let k = 0; k < pts.length; k += 3) {
      const dot = Math.min(1, x * pts[k]! + y * pts[k + 1]! + z * pts[k + 2]!);
      best = Math.min(best, Math.acos(dot) * R);
    }
    const pull = Number.isFinite(best) ? Math.exp(-best / PULL) : 0;
    return f.importance[i]! * (1 + 2 * pull);
  });
  const r = rng(seed, 'wonders');
  const target = Math.min(
    ids.length,
    WONDER_COUNT[0] + r.int(WONDER_COUNT[1] - WONDER_COUNT[0] + 1),
  );
  const chosen: number[] = [];
  const perKind = new Map<number, number>();
  const minDot = Math.cos(SPACING / R);
  const left = ids.map((_, k) => k);
  while (chosen.length < target && left.length > 0) {
    const sum = left.reduce((s, k) => s + weight[k]!, 0);
    let x = r.nextFloat() * sum;
    let pick = left.length - 1;
    for (let j = 0; j < left.length; j++) {
      x -= weight[left[j]!]!;
      if (x < 0) {
        pick = j;
        break;
      }
    }
    const k = left.splice(pick, 1)[0]!;
    const i = ids[k]!;
    const kind = f.measure[i]!;
    if ((perKind.get(kind) ?? 0) >= PER_KIND) continue;
    const close = chosen.some(
      (j) =>
        f.anchor[3 * i]! * f.anchor[3 * j]! +
          f.anchor[3 * i + 1]! * f.anchor[3 * j + 1]! +
          f.anchor[3 * i + 2]! * f.anchor[3 * j + 2]! >
        minDot,
    );
    if (close) continue;
    chosen.push(i);
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
  }
  return chosen.sort((a, b) => a - b);
}
