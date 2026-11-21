/**
 * The game's side of the points of interest (Proposal 0010, decisions 302 and 303):
 * Bearing hands the game-agnostic framework its places (the strategic graph's
 * settlements), its routes (the graph's roads) and its viewpoints (each airfield's
 * approaches, 300 m up 6 km out along the runway both ways), then composes landmarks
 * into the airfields' views. Another game would pass its own.
 */
import { Vec3d } from '../../../core/vec3d';
import type { StrategicGraph } from '../../../worldgen/strategic/graph';
import {
  composeLandmarks,
  LANDMARK_HEIGHT,
  placePointsOfInterest,
} from '../../../worldgen/poi/poi';
import type { PoiKind, PoiWorld, PointOfInterest } from '../../../worldgen/poi/poi';
import { landmarkCoverage, viewshedScore } from '../../../worldgen/viewshed';
import type { Viewpoint } from '../../../worldgen/viewshed';
import type { WorldSeed } from '../../../core/rng';

/** An airfield as the viewpoints read it: its point and runway heading (rad from north). */
export interface AirfieldView {
  point: readonly [number, number, number];
  heading: number;
}

/** Viewpoints on each airfield's two approaches: 300 m up, 6 km out. */
export function approachViewpoints(fields: readonly AirfieldView[], radius: number): Viewpoint[] {
  const out: Viewpoint[] = [];
  for (const f of fields) {
    const p = new Vec3d(...f.point).normalize();
    const east = new Vec3d(0, 1, 0).cross(p).normalize();
    const north = p.clone().cross(east);
    for (const s of [1, -1]) {
      const d = p
        .clone()
        .addScaled(north, (s * 6000 * Math.cos(f.heading)) / radius)
        .addScaled(east, (s * 6000 * Math.sin(f.heading)) / radius)
        .normalize();
      out.push({ dir: [d.x, d.y, d.z], above: 300 });
    }
  }
  return out;
}

export interface WorldPois {
  pois: PointOfInterest[];
  viewpoints: Viewpoint[];
  /** Share of airfields with a landmark in view from an approach (the proposal's check). */
  coverage: number;
  ms: number;
}

/** Points of interest for Bearing's world, composed into the airfields' views. */
export function bearingPois(
  world: PoiWorld,
  graph: StrategicGraph,
  airfields: readonly AirfieldView[],
  seed: WorldSeed,
  others: readonly { dir: readonly [number, number, number]; height: number }[] = [],
  kinds?: readonly PoiKind[],
  density = 1,
): WorldPois {
  const t0 = performance.now();
  const s = graph.settlements;
  const places = Array.from({ length: s.cells.length }, (_, i) => ({
    dir: [s.points[i * 3]!, s.points[i * 3 + 1]!, s.points[i * 3 + 2]!] as [number, number, number],
    size: s.population[i]!,
  }));
  const r = graph.roads;
  const routes: [number, number, number][][] = [];
  for (let k = 0; k < r.count; k++) {
    if (r.roadClass[k] === 0) continue;
    const line: [number, number, number][] = [];
    for (let p = r.offsets[k]!; p < r.offsets[k + 1]!; p++)
      line.push([r.points[p * 3]!, r.points[p * 3 + 1]!, r.points[p * 3 + 2]!]);
    routes.push(line);
  }
  const viewpoints = approachViewpoints(airfields, world.radius);
  const viewshed = viewshedScore(world, viewpoints);
  const placed = placePointsOfInterest(world, seed, {
    places,
    routes,
    viewshed,
    density,
    ...(kinds ? { kinds } : {}),
  });
  const added = composeLandmarks(world, placed, viewpoints, seed, {
    others,
    ...(kinds ? { kinds } : {}),
  });
  const pois = [...placed, ...added];
  // Coverage per airfield: either approach sees a landmark.
  const marks = [
    ...others,
    ...pois
      .filter((p) => LANDMARK_HEIGHT[p.kind] !== undefined)
      .map((p) => ({ dir: p.dir, height: LANDMARK_HEIGHT[p.kind]! })),
  ];
  const { seen } = landmarkCoverage(world, viewpoints, marks);
  let covered = 0;
  for (let i = 0; i < airfields.length; i++) if (seen[2 * i] || seen[2 * i + 1]) covered++;
  return {
    pois,
    viewpoints,
    coverage: airfields.length ? covered / airfields.length : 1,
    ms: performance.now() - t0,
  };
}
