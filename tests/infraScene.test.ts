import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { tileForDirection } from '../src/core/tiles';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { InfraScene, localFrame, offsetPoint, urbanRadius } from '../src/render/infra/infraScene';
import { LIGHT_LEVEL, LightTables } from '../src/render/infra/roadShading';
import { RiverTables } from '../src/render/water/riverTables';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const R = DEFAULT_PLANET_PARAMS.radius;

describe('airfield geometry helpers', () => {
  it('offsets along the heading and to its right', () => {
    const p = latLonToDirection(10 * DEG, 20 * DEG);
    const { east, north } = localFrame(p);
    const ahead = offsetPoint(p, 0, 1000, 0, R).sub(p);
    expect(ahead.dot(north) * R).toBeCloseTo(1000, 0);
    expect(Math.abs(ahead.dot(east) * R)).toBeLessThan(1);
    // Heading north, the right is east.
    const right = offsetPoint(p, 0, 0, 500, R).sub(p);
    expect(right.dot(east) * R).toBeCloseTo(500, 0);
    // Heading east, forward is east and the right is south.
    const e = offsetPoint(p, Math.PI / 2, 1000, 500, R).sub(p);
    expect(e.dot(east) * R).toBeCloseTo(1000, 0);
    expect(e.dot(north) * R).toBeCloseTo(-500, 0);
  });

  it('grows urban areas with population', () => {
    expect(urbanRadius(1e6)).toBeGreaterThan(urbanRadius(1e5));
    expect(urbanRadius(100)).toBe(500);
  });
});

describe('InfraScene from a generated world', () => {
  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const scene = new InfraScene(w.graph, w.infrastructure, R);
  const bases = w.infrastructure.airbases;

  it('draws roads as asphalt and five concrete strips per airbase', () => {
    let concrete = 0;
    let asphalt = 0;
    for (let s = 0; s < scene.segments.count; s++) {
      if (scene.segments.data[s * 8 + 6]! < 0) concrete++;
      else asphalt++;
    }
    expect(concrete).toBe(5 * bases.length);
    expect(asphalt).toBeGreaterThan(w.graph.roads.count);
  });

  it('clears trees on runways and in towns, buildings only off pavement', () => {
    const base = new Vec3d(...bases[0]!.point);
    expect(scene.isClear(base)).toBe(true);
    expect(scene.isClear(base, true)).toBe(true);
    const s = w.graph.settlements;
    const town = new Vec3d(s.points[0]!, s.points[1]!, s.points[2]!);
    expect(scene.isClear(town)).toBe(true);
    // Far out at sea nothing is cleared.
    expect(scene.isClear(latLonToDirection(-89 * DEG, 0))).toBe(false);
  });

  it('lists every light where it shines, coarse and fine', () => {
    const lights = new LightTables(scene.lights, R);
    const count = scene.lights.length / 8;
    expect(count).toBe(
      bases.length +
        w.graph.settlements.cells.length +
        scene.sites.filter((x) => x.kind === 'industry').length,
    );
    for (let i = 0; i < count; i += 7) {
      const p = new Vec3d(scene.lights[i * 8]!, scene.lights[i * 8 + 1]!, scene.lights[i * 8 + 2]!);
      for (const level of [0, LIGHT_LEVEL, 9]) {
        const range = lights.rangeFor(tileForDirection(p, level));
        const ids = Array.from(lights.lists.subarray(range.start, range.start + range.count));
        expect(ids).toContain(i);
      }
    }
  });

  it('keeps runways out of coarse road lists', () => {
    const tables = new RiverTables(scene, R, { coarseMinWidth: 12 });
    const p = new Vec3d(...bases[0]!.point);
    const fine = tables.rangeFor(tileForDirection(p, 8));
    expect(fine.count).toBeGreaterThan(0);
    const coarse = tables.rangeFor(tileForDirection(p, 5));
    const ids = Array.from(tables.lists.subarray(coarse.start, coarse.start + coarse.count));
    for (const id of ids) expect(tables.segments[id * 8 + 3]!).toBeGreaterThan(0);
  });
});
