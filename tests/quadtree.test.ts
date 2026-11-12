import { describe, expect, it } from 'vitest';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { tileKey, tileSampleDirection, TILE_TEXELS } from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { rng } from '../src/core/rng';
import { randomUnitVector } from '../src/core/coords';
import { OrbitCamera } from '../src/render/common/orbitCamera';
import { ObserverCamera } from '../src/render/sim/camera/observerCamera';
import {
  capBeyondHorizon,
  DEFAULT_LOD,
  geometricError,
  horizonRange,
  selectionRange,
  selectTiles,
  tileAngularDistance,
  tileQuad,
} from '../src/render/common/terrain/quadtree';
import type { LodView } from '../src/render/common/terrain/quadtree';

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

  it('splits a tile only when its unseen children are ready too, and keeps them cached', () => {
    // Low and looking at the horizon: many split tiles have children outside the view.
    const v = viewAt(500, 80 * DEG);
    const key = (t: { face: number; level: number; x: number; y: number }) =>
      `${t.face}/${t.level}/${t.x}/${t.y}`;
    const all = selectTiles(v, always);
    const drawn = new Set(all.draw.map((d) => key(d.tile)));
    const unseen = all.keep.filter((t) => !drawn.has(key(t)) && t.level >= 2);
    expect(unseen.length).toBeGreaterThan(0);
    // The parent of an unseen child is itself kept (a split tile), never drawn.
    const child = unseen[unseen.length - 1]!;
    const parentKey = `${child.face}/${child.level - 1}/${child.x >> 1}/${child.y >> 1}`;
    expect(all.keep.map(key)).toContain(parentKey);
    expect(drawn.has(parentKey)).toBe(false);
    // Without that child's mesh, its parent draws instead of splitting, and the child is wanted:
    // a later turn toward it then finds it ready, rather than the parent standing in.
    const s2 = selectTiles(v, (t) => key(t) !== key(child));
    expect(s2.draw.map((d) => key(d.tile))).toContain(parentKey);
    expect(s2.wanted.map((w) => key(w.tile))).toContain(key(child));
  });

  it('morphs from parent-like to full detail', () => {
    const s = selectTiles(viewAt(20 * KM), always);
    for (const d of s.draw) {
      expect(d.morph).toBeGreaterThanOrEqual(0);
      expect(d.morph).toBeLessThanOrEqual(1);
    }
    expect(s.draw.some((d) => d.morph > 0 && d.morph < 1)).toBe(true);
  });

  it('bounds built tiles by their own heights, so a camera below the tallest peak does not over-refine', () => {
    // Exaggerated relief: peaks 40 km tall somewhere on the planet, a camera at 30 km.
    const v = { ...viewAt(30 * KM, 60 * DEG), exaggeration: 10, maxHeight: 40 * KM };
    const loose = selectTiles(v, always);
    // The same view where every tile's mesh says it is low land (0–2 km displayed).
    const tight = selectTiles(v, always, DEFAULT_LOD, () => [0, 2 * KM]);
    const deepest = (s: typeof loose) => Math.max(...s.draw.map((d) => d.tile.level));
    expect(deepest(loose)).toBe(DEFAULT_LOD.maxLevel);
    expect(deepest(tight)).toBeLessThan(DEFAULT_LOD.maxLevel);
    expect(tight.draw.length * 4).toBeLessThan(loose.draw.length);
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

/** Brute force: the smallest angle from d to a dense grid of points on the tile, edges included. */
function sampledDistance(t: TileKey, d: Vec3d, n = 64): number {
  const p = new Vec3d();
  let best = Math.PI;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      tileSampleDirection(t, (i / n) * TILE_TEXELS, (j / n) * TILE_TEXELS, p);
      best = Math.min(best, Math.acos(Math.min(1, Math.max(-1, p.dot(d)))));
    }
  }
  return best;
}

describe('tileAngularDistance', () => {
  it('is 0 inside a tile and matches a dense sampling outside it', () => {
    const r = rng(7, 'quadtree-test');
    const d = new Vec3d();
    const tiles = [
      tileKey(0, 0, 0, 0),
      tileKey(2, 3, 5, 1),
      tileKey(4, 6, 40, 22),
      tileKey(5, 9, 300, 511),
    ];
    for (const t of tiles) {
      const q = tileQuad(t);
      expect(tileAngularDistance(q, tileSampleDirection(t, TILE_TEXELS / 2, TILE_TEXELS / 2))).toBe(
        0,
      );
      expect(tileAngularDistance(q, tileSampleDirection(t, 1, TILE_TEXELS - 1))).toBe(0);
      // Points near the tile (edge and corner regions) and anywhere on the sphere.
      const size = Math.PI / 2 / (1 << t.level);
      for (let i = 0; i < 60; i++) {
        if (i < 40) {
          tileSampleDirection(
            t,
            r.range(-TILE_TEXELS, 2 * TILE_TEXELS),
            r.range(-TILE_TEXELS, 2 * TILE_TEXELS),
            d,
          );
        } else {
          randomUnitVector(r, d);
        }
        const exact = tileAngularDistance(q, d);
        const sampled = sampledDistance(t, d);
        // Sampling only overestimates, by at most about half a sample spacing.
        expect(exact).toBeLessThanOrEqual(sampled + 1e-12);
        expect(sampled - exact).toBeLessThan(size / 64);
      }
    }
  });
});

describe('horizon range', () => {
  /** An observer's view over the sphere at 40° N, 20° E (eye height above sea level). */
  function observerView(
    height: number,
    heading: number,
    pitch: number,
    maxHeight: number,
  ): LodView {
    const cam = new ObserverCamera(R);
    cam.spot.set(
      Math.sin(20 * DEG) * Math.cos(40 * DEG),
      Math.sin(40 * DEG),
      Math.cos(20 * DEG) * Math.cos(40 * DEG),
    );
    cam.groundHeight = 0;
    cam.height = height;
    cam.heading = heading;
    cam.pitch = pitch;
    cam.update(0);
    return {
      eye: cam.eye.clone(),
      forward: cam.forward.clone(),
      up: cam.up.clone(),
      fovY: 70 * DEG,
      aspect: 16 / 9,
      viewportHeight: 1080,
      radius: R,
      exaggeration: 1,
      maxHeight,
    };
  }

  it('is √(2Rh) over flat land plus the horizon of the tallest terrain', () => {
    const flat = (h: number) => horizonRange(observerView(h, 0, 0, 0));
    // About 200 km at the simulation view's 20 km ceiling, 32 km at 500 m (Proposal 0001).
    expect(flat(20 * KM) / KM).toBeCloseTo(198.7, 0);
    expect(flat(20 * KM)).toBeLessThan(Math.sqrt(2 * R * 20 * KM));
    expect(flat(500) / KM).toBeCloseTo(31.6, 0);
    expect(flat(2) / KM).toBeCloseTo(2.0, 1);
    // A 4 km peak shows up to about 89 km past the horizon.
    const peaks = horizonRange(observerView(20 * KM, 0, 0, 4 * KM));
    expect((peaks - flat(20 * KM)) / KM).toBeCloseTo(89.3, 0);
  });

  it('never draws a tile wholly beyond the range, nor asks for one beyond its margin', () => {
    const nadir = new Vec3d();
    let drawn = 0;
    let wanted = 0;
    for (const maxHeight of [0, 4 * KM]) {
      for (const height of [2, 50, 500, 5 * KM, 20 * KM]) {
        for (const heading of [0, 100 * DEG, 230 * DEG]) {
          for (const pitch of [0, -30 * DEG, -85 * DEG]) {
            const v = observerView(height, heading, pitch, maxHeight);
            const range = horizonRange(v);
            const outer = selectionRange(v);
            expect(outer).toBeGreaterThan(range);
            nadir.copy(v.eye).normalize();
            const dist = (t: TileKey) => tileAngularDistance(tileQuad(t), nadir) * R;
            // Every tile at its tallest; every mesh ready, then only coarse ones (so tiles are wanted).
            for (const ready of [always, (t: TileKey) => t.level <= 6]) {
              const s = selectTiles(v, ready, DEFAULT_LOD, () => [0, maxHeight]);
              for (const d of s.draw) expect(dist(d.tile)).toBeLessThanOrEqual(range);
              for (const w of s.wanted) expect(dist(w.tile)).toBeLessThanOrEqual(outer);
              for (const k of s.keep) expect(dist(k)).toBeLessThanOrEqual(outer);
              drawn += s.draw.length;
              wanted += s.wanted.length;
            }
          }
        }
      }
    }
    expect(drawn).toBeGreaterThan(1000);
    expect(wanted).toBeGreaterThan(100);
  });

  it('splits a tile without its children past the horizon and the margin', () => {
    // Standing 2 m above flat land, the horizon is 2 km away: many level-9 and
    // level-10 tiles near it have children that no turn of the camera can show.
    const v = observerView(2, 0, 0, 0);
    const nadir = v.eye.clone().normalize();
    const s = selectTiles(v, always, DEFAULT_LOD, () => [0, 0]);
    expect(Math.max(...s.draw.map((d) => d.tile.level))).toBe(DEFAULT_LOD.maxLevel);
    // Without meshes beyond the margin, the same tiles split all the same.
    const outer = selectionRange(v);
    const near = (t: TileKey) => tileAngularDistance(tileQuad(t), nadir) * R <= outer;
    const s2 = selectTiles(v, near, DEFAULT_LOD, () => [0, 0]);
    expect(s2.draw.length).toBe(s.draw.length);
    expect(s2.wanted.length).toBe(0);
  });

  it('drops a tile whose bounding cap reaches the horizon but whose nearest point does not', () => {
    // 500 m over flat land: the horizon is 32 km away. The old cap test kept tiles 157 km out.
    const v = observerView(500, 0, 0, 0);
    const nadir = v.eye.clone().normalize();
    const s = selectTiles(v, always, DEFAULT_LOD, () => [0, 0]);
    const nearest = s.draw.map((d) => tileAngularDistance(tileQuad(d.tile), nadir) * R);
    expect(Math.max(...nearest)).toBeLessThanOrEqual(horizonRange(v));
    expect(s.draw.length).toBeGreaterThan(0);
  });
});
