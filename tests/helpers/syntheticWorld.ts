/** Hand-built coarse worlds for strategic-graph tests: land from latitude/longitude boxes. */
import { CubeGrid } from '../../src/core/cubeGrid';
import { latLonToDirection } from '../../src/core/coords';
import { buildStrategicGraphWithContext } from '../../src/worldgen/strategic/builder';
import type { StrategicBuild } from '../../src/worldgen/strategic/builder';
import { BRIDGE_MIN_DISCHARGE } from '../../src/worldgen/strategic/movement';
import { DEG } from '../../src/core/units';
import { Biome } from '../../src/worldgen/biomes';
import { frontTrace } from '../../src/worldgen/strategic/fronts';
import type { StrategicGraph } from '../../src/worldgen/strategic/graph';
import type { StrategicInput } from '../../src/worldgen/strategic/input';

export interface Box {
  lat: [number, number];
  lon: [number, number];
}

export const RADIUS = 1_000_000;
export const RELIEF = RADIUS / 6_371_000;

/**
 * Flat grassland at 100 m inside the boxes (degrees), ocean 300 m deep
 * elsewhere. `bump(lat, lon)` adds physical height on land.
 */
export function boxWorld(
  n: number,
  boxes: Box[],
  bump: (latDeg: number, lonDeg: number) => number = () => 0,
): StrategicInput {
  const grid = new CubeGrid(n);
  const height = new Float32Array(grid.cellCount);
  const biome = new Uint8Array(grid.cellCount);
  for (let c = 0; c < grid.cellCount; c++) {
    const x = grid.centers[c * 3]!;
    const y = grid.centers[c * 3 + 1]!;
    const z = grid.centers[c * 3 + 2]!;
    const lat = Math.asin(y) / DEG;
    const lon = Math.atan2(x, z) / DEG;
    const land = boxes.some(
      (b) => lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1],
    );
    height[c] = land ? 100 + bump(lat, lon) : -300;
    biome[c] = land ? Biome.TemperateGrassland : Biome.Ocean;
  }
  return {
    grid,
    height,
    biome,
    discharge: new Float32Array(grid.cellCount),
    lakeDepth: new Float32Array(grid.cellCount),
    reliefScale: RELIEF,
    radius: RADIUS,
  };
}

/** A stable text fingerprint of a graph (typed arrays included, timings excluded). */
export function graphFingerprint(g: StrategicGraph): string {
  return JSON.stringify({ ...g, timings: [] }, (_k, v: unknown) =>
    ArrayBuffer.isView(v)
      ? Array.from(v as unknown as ArrayLike<number>)
      : v === Infinity
        ? 'inf'
        : v,
  );
}

/**
 * Path and values of the first difference between two values, or null if they
 * match. Typed arrays compare as arrays; `timings` keys are skipped. Determinism
 * tests use it so a failure names the first quantity that diverged, not a long
 * fingerprint (a CI flake, TODO.md Known issues).
 */
export function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  const norm = (v: unknown): unknown =>
    ArrayBuffer.isView(v) && !(v instanceof DataView)
      ? Array.from(v as unknown as ArrayLike<number>)
      : v;
  const x = norm(a);
  const y = norm(b);
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) return `${path}: length ${x.length} vs ${y.length}`;
    for (let i = 0; i < x.length; i++) {
      const d = firstDifference(x[i], y[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) {
      if (k === 'timings') continue;
      const d = firstDifference(
        (x as Record<string, unknown>)[k],
        (y as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d) return d;
    }
    return null;
  }
  return Object.is(x, y) ? null : `${path}: ${String(x)} vs ${String(y)}`;
}

/**
 * Runs `build` with the front generator's trace on (decision 234) and returns
 * its result with the trace, so a determinism test can name the first step of
 * the front generator at which two builds part.
 */
export function traced<T>(build: () => T): { value: T; trace: string[] } {
  const trace: string[] = [];
  const outer = frontTrace.sink;
  frontTrace.sink = trace;
  try {
    return { value: build(), trace };
  } finally {
    frontTrace.sink = outer;
  }
}

/** The first line at which two front traces differ, both versions, or null. */
export function firstTraceDifference(a: readonly string[], b: readonly string[]): string | null {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i])
      return `front trace line ${i}:\n  ${a[i] ?? '(none)'}\n  ${b[i] ?? '(none)'}`;
  return null;
}

/** Longitude (deg) of the river in `riverWorld`. */
export const RIVER_LON = -50;

/**
 * The campaign test's continent (a ridge at lon −30°) and rear base, plus a
 * wide river flowing south along lon −50° from 18° N to the coast: the
 * infrastructure test's world, also built repeatedly by tools/determinism.preview.ts.
 */
export function riverWorld(seed: number): { build: StrategicBuild; river: Set<number> } {
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
