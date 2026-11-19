import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { rng } from '../src/core/rng';
import { Vec3d } from '../src/core/vec3d';
import { airfieldGrading } from '../src/render/sim/infra/airfieldGrading';
import { InfraScene } from '../src/render/sim/infra/infraScene';
import { lineOfSight } from '../src/sim/sensors/lineOfSight';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import {
  globalMapSampler,
  HeightService,
  offsetPoint,
  terrainEditsFor,
} from '../src/worldgen/edits';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

describe('the height service', () => {
  const R = DEFAULT_PLANET_PARAMS.radius;
  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  // The coarse world's heights stand in for the global grid.
  const height = w.world.maps.height;
  const n = w.world.info.resolution;
  const fields = w.infrastructure.airbases;
  // The main thread's function: the renderer's edits over the same grid.
  const scene = new InfraScene(w.graph, w.infrastructure, R);
  const mainEdits = airfieldGrading(scene, height, n);
  const sample = globalMapSampler(height, n);
  const main = (d: Readonly<Vec3d>) => mainEdits.apply(d, sample(d));
  // The worker's: the same assembly from the airbases alone.
  const service = new HeightService(
    R,
    height,
    n,
    terrainEditsFor({ radius: R, fields, height, n }),
    fields,
  );

  it('agrees with the main thread’s function bit for bit, on the airfields and off them', () => {
    expect(fields.length).toBeGreaterThan(5);
    const points: Vec3d[] = [];
    for (const f of fields) {
      const p = new Vec3d(...f.point);
      for (const along of [-f.runwayLength / 2 - 300, -f.runwayLength / 2, 0, f.runwayLength / 2])
        for (const across of [-200, 0, 400, 900, 1500])
          points.push(offsetPoint(p, f.heading, along, across, R));
    }
    const r = rng(1, 'test/height-service');
    for (let i = 0; i < 2000; i++) {
      points.push(new Vec3d(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize());
    }
    for (const d of points) expect(service.height(d)).toBe(main(d));
  });

  it('stands each field on its pad', () => {
    let graded = 0;
    for (const f of fields) {
      const p = new Vec3d(...f.point);
      const h = service.height(p);
      if (sample(p) <= 0) continue;
      graded++;
      // The runway is flat: its ends stand at its middle's height.
      for (const along of [-f.runwayLength / 2, f.runwayLength / 2]) {
        expect(service.height(offsetPoint(p, f.heading, along, 0, R))).toBeCloseTo(h, 6);
      }
    }
    expect(graded).toBeGreaterThan(0);
  });

  it('serves line of sight', () => {
    const f = fields[0]!;
    const p = new Vec3d(...f.point);
    const up = (d: Vec3d, h: number) => d.clone().scale(R + h);
    // Straight up from the field: nothing in the way.
    expect(lineOfSight(up(p, service.height(p) + 10), up(p, 10_000), R, service)).toBe(true);
    // Far along the surface at 10 m: the planet's curve hides it.
    const far = offsetPoint(p, 0, 200_000, 0, R);
    expect(
      lineOfSight(up(p, service.height(p) + 10), up(far, service.height(far) + 10), R, service),
    ).toBe(false);
  });
});
