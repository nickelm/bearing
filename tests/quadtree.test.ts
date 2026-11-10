import { describe, expect, it } from 'vitest';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { tileSampleDirection, TILE_TEXELS } from '../src/core/tiles';
import { OrbitCamera } from '../src/render/orbitCamera';
import {
  capBeyondHorizon,
  DEFAULT_LOD,
  geometricError,
  selectTiles,
} from '../src/render/terrain/quadtree';
import type { LodView } from '../src/render/terrain/quadtree';

const R = PLANET_RADIUS;

function viewAt(altitude: number, tilt = 0): LodView {
  const cam = new OrbitCamera(
    R,
    { minAltitude: 100, maxAltitude: 10_000 * KM, maxTilt: 89 * DEG, maxLatitude: 89 * DEG },
    altitude,
  );
  cam.lat = 40 * DEG;
  cam.lon = 20 * DEG;
  cam.tilt = tilt;
  cam.update(0);
  return {
    eye: cam.eye.clone(),
    forward: cam.forward.clone(),
    up: cam.up.clone(),
    fovY: 45 * DEG,
    aspect: 16 / 9,
    viewportHeight: 1080,
    radius: R,
    exaggeration: 1,
    maxHeight: 1500,
  };
}

const always = () => true;

describe('selectTiles', () => {
  it('draws coarse tiles from orbit and deep tiles near the ground', () => {
    const far = selectTiles(viewAt(5000 * KM), always);
    const near = selectTiles(viewAt(500), always);
    const maxLevel = (s: typeof far) => Math.max(...s.draw.map((d) => d.tile.level));
    expect(maxLevel(far)).toBeLessThanOrEqual(3);
    expect(maxLevel(near)).toBe(DEFAULT_LOD.maxLevel);
    // Bounded work at 500 m, even looking toward the horizon.
    const tilted = selectTiles(viewAt(500, 80 * DEG), always);
    expect(near.draw.length).toBeLessThan(400);
    expect(tilted.draw.length).toBeLessThan(800);
  });

  it('refines monotonically as the camera descends', () => {
    let prev = 0;
    for (const alt of [5000 * KM, 1000 * KM, 200 * KM, 50 * KM, 10 * KM, 2 * KM, 500]) {
      const s = selectTiles(viewAt(alt), always);
      const deepest = Math.max(...s.draw.map((d) => d.tile.level));
      expect(deepest).toBeGreaterThanOrEqual(prev);
      prev = deepest;
    }
  });

  it('culls the far side of the planet', () => {
    const v = viewAt(2000 * KM);
    const s = selectTiles(v, always);
    const d = new Vec3d();
    const horizon = Math.acos(R / v.eye.length()) + Math.acos(R / (R + v.maxHeight));
    const nadir = v.eye.clone().normalize();
    for (const { tile } of s.draw) {
      tileSampleDirection(tile, TILE_TEXELS / 2, TILE_TEXELS / 2, d);
      // A drawn tile's center lies within the horizon plus the tile's own size.
      const size = Math.PI / 2 / (1 << tile.level);
      expect(Math.acos(d.dot(nadir))).toBeLessThan(horizon + size);
    }
    const all = selectTiles(v, always, { ...DEFAULT_LOD, cull: false });
    expect(s.draw.length).toBeLessThan(all.draw.length);
  });

  it('falls back to the parent when children are not ready, and asks for them', () => {
    const v = viewAt(50 * KM);
    const ready = (t: { level: number }) => t.level <= 2;
    const s = selectTiles(v, ready);
    expect(Math.max(...s.draw.map((d) => d.tile.level))).toBe(2);
    expect(s.wanted.length).toBeGreaterThan(0);
    expect(s.wanted.every((w) => w.tile.level === 3)).toBe(true);
  });

  it('morphs from parent-like to full detail', () => {
    const s = selectTiles(viewAt(20 * KM), always);
    for (const d of s.draw) {
      expect(d.morph).toBeGreaterThanOrEqual(0);
      expect(d.morph).toBeLessThanOrEqual(1);
    }
    expect(s.draw.some((d) => d.morph > 0 && d.morph < 1)).toBe(true);
  });

  it('includes the sphere sagitta in the geometric error at coarse levels', () => {
    const v = viewAt(1000 * KM);
    expect(geometricError(0, v, DEFAULT_LOD)).toBeGreaterThan(50);
  });
});

describe('capBeyondHorizon', () => {
  it('culls the antipode, keeps the nadir and peaks just past the horizon', () => {
    const eye = new Vec3d(0, 0, 2 * R);
    expect(capBeyondHorizon(eye, new Vec3d(0, 0, -1), 0.1, R, 0)).toBe(true);
    expect(capBeyondHorizon(eye, new Vec3d(0, 0, 1), 0.1, R, 0)).toBe(false);
    // The horizon is 60° away; a cap centered at 62° with radius 3° is still visible.
    const c = new Vec3d(Math.sin(62 * DEG), 0, Math.cos(62 * DEG));
    expect(capBeyondHorizon(eye, c, 3 * DEG, R, 0)).toBe(false);
    // A camera standing on a huge tile never culls it.
    const low = new Vec3d(0, 0, R + 2000);
    expect(capBeyondHorizon(low, new Vec3d(0.5, 0, 0.866), 45 * DEG, R, 1500)).toBe(false);
  });
});
