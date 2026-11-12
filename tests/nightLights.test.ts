import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { Noise3 } from '../src/core/noise';
import { rng } from '../src/core/rng';
import { tileForDirection, TILE_STRIDE } from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { Vec3d } from '../src/core/vec3d';
import type { MeshOptions } from '../src/render/common/terrain/tileMesh';
import { treeDataTile } from '../src/render/sim/forest/forestLayer';
import { InfraScene, localFrame, RUNWAY_WIDTH } from '../src/render/sim/infra/infraScene';
import { LIGHT_FLOATS, LIGHT_KINDS } from '../src/render/sim/infra/lightPoints';
import {
  angleForHeading,
  BUILDING_TILE_LEVEL,
  instanceAxes,
  placeBuildings,
  RUNWAY_LIGHT_SPACING,
  runwayLights,
} from '../src/render/sim/infra/structureLayer';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { NO_LAKE } from '../src/worldgen/gpu/tileSynth';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const R = DEFAULT_PLANET_PARAMS.radius;
const opts: MeshOptions = {
  radius: R,
  reliefScale: 0.157,
  mode: 'biome',
  detail: new Noise3(rng(1, 'test-detail')),
};

/** Flat level-7 data at 120 m. */
function flat(k: TileKey): TileData {
  const n = TILE_STRIDE * TILE_STRIDE;
  return {
    key: k,
    height: new Float32Array(n).fill(120),
    material: new Uint32Array(n).fill(8),
    lake: new Float32Array(n).fill(NO_LAKE),
    minHeight: 120,
    maxHeight: 120,
  };
}

describe('instance frame', () => {
  it('turns a model +x onto its compass heading, right-handed', () => {
    const up = new Vec3d(0.3, 0.8, 0.52).normalize();
    const { east, north } = localFrame(up);
    const ax = new Vec3d();
    const az = new Vec3d();
    for (const h of [0, 0.7, Math.PI / 2, 2.5]) {
      instanceAxes(up, angleForHeading(h), ax, az);
      const fwd = east.clone().scale(Math.sin(h)).addScaled(north, Math.cos(h));
      expect(ax.dot(fwd)).toBeCloseTo(1, 6);
      // Model frame: +x forward, +y up, +z starboard, and x × y = z.
      expect(ax.clone().cross(up).dot(az)).toBeCloseTo(1, 6);
    }
  });
});

describe('airbase night lights', () => {
  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const scene = new InfraScene(w.graph, w.infrastructure, R);
  const site = scene.sites.find((s) => s.kind === 'airbase')!;

  it('lines both runway edges and marks both ends', () => {
    const lights = runwayLights(site, R);
    const edges = lights.filter((l) => l.kind === 'runway');
    expect(edges.length).toBe(2 * (Math.round(site.runwayLength / RUNWAY_LIGHT_SPACING) + 1));
    expect(lights.some((l) => l.kind === 'threshold')).toBe(true);
    expect(lights.some((l) => l.kind === 'runway-end')).toBe(true);
    // Every light stands within the runway's length and just off its edges.
    for (const l of lights) {
      const dist = l.d.distanceTo(site.point) * R;
      expect(dist).toBeLessThan(Math.hypot(site.runwayLength / 2 + 5, RUNWAY_WIDTH / 2 + 2));
    }
    expect(
      runwayLights(
        scene.sites.find((s) => s.kind === 'town')!,
        R,
      ),
    ).toEqual([]);
  });

  it('places runway lights and model anchors with the tile that holds them', () => {
    // Every level-9 tile under the airfield, each placing its own share.
    const tiles = new Map<string, TileKey>();
    for (const l of runwayLights(site, R)) {
      const t = tileForDirection(l.d, BUILDING_TILE_LEVEL);
      tiles.set(`${t.face}/${t.x}/${t.y}`, t);
    }
    let runway = 0;
    let anchors = 0;
    let tower = 0;
    for (const t of tiles.values()) {
      const inst = placeBuildings(t, flat(treeDataTile(t)), opts, scene, 7);
      const l = inst.lights;
      expect(l.length % LIGHT_FLOATS).toBe(0);
      for (let o = 0; o < l.length; o += LIGHT_FLOATS) {
        const up = new Vec3d(l[o + 3]!, l[o + 4]!, l[o + 5]!);
        const off = new Vec3d(l[o + 6]!, l[o + 7]!, l[o + 8]!);
        expect(l[o + 9]).toBeCloseTo(120, 0); // plus a little render detail
        const size = l[o + 13]!;
        const lift = off.dot(up);
        if (size === Math.fround(LIGHT_KINDS.runway!.size) && lift < 1.5) runway++;
        else anchors++;
        // The tower's windows are 19.5 m up.
        if (Math.abs(lift - 19.5) < 0.01) tower++;
      }
    }
    expect(runway).toBe(runwayLights(site, R).length);
    expect(anchors).toBeGreaterThan(3);
    expect(tower).toBe(2);
  });
});
