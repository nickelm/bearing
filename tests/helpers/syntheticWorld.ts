/** Hand-built coarse worlds for strategic-graph tests: land from latitude/longitude boxes. */
import { CubeGrid } from '../../src/core/cubeGrid';
import { DEG } from '../../src/core/units';
import { Biome } from '../../src/worldgen/biomes';
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
