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
