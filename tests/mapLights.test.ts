import { describe, expect, it } from 'vitest';
import { lightRadiusPx, mapLightList } from '../src/render/strategic/mapLights';
import type { StrategicGraph } from '../src/worldgen/strategic/graph';
import type { Infrastructure } from '../src/worldgen/strategic/infrastructure';

describe('night lights', () => {
  it('sizes settlement lights by population, from villages to the largest cities', () => {
    expect(lightRadiusPx(200)).toBe(0.9);
    expect(lightRadiusPx(2000)).toBeCloseTo(0.9, 12);
    expect(lightRadiusPx(8000)).toBeCloseTo(2.3, 12);
    expect(lightRadiusPx(5e6)).toBe(3.5);
    let prev = 0;
    for (let p = 100; p < 1e7; p *= 1.7) {
      expect(lightRadiusPx(p)).toBeGreaterThanOrEqual(prev);
      prev = lightRadiusPx(p);
    }
  });

  it('lists settlements, airbases and target sites on the terrain, never below sea level', () => {
    const graph = {
      settlements: {
        cells: Int32Array.from([0, 1]),
        points: Float64Array.from([0, 0, 1, 1, 0, 0]),
        population: Float32Array.from([1000, 64000]),
      },
    } as unknown as StrategicGraph;
    const infra = {
      airbases: [{ point: [0, 1, 0] }],
      targets: [{ point: [0, -1, 0] }, { point: [-1, 0, 0] }],
    } as unknown as Infrastructure;
    const heights = (x: number, y: number) => (y < 0 ? -50 : 300 + x);
    const list = mapLightList(graph, infra, heights);
    expect(list.count).toBe(5);
    expect(list.data.length).toBe(25);
    // Second settlement: direction, radius by population, height at its point.
    expect(Array.from(list.data.subarray(5, 10))).toEqual([1, 0, 0, lightRadiusPx(64000), 301]);
    // A target below sea level sits at sea level.
    expect(list.data[3 * 5 + 4]).toBe(0);
    expect(mapLightList(graph, null, heights).count).toBe(2);
  });
});
