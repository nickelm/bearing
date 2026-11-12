import { describe, expect, it } from 'vitest';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { tileKey, tileKeyString } from '../src/core/tiles';
import type { CubeFace } from '../src/core/coords';
import {
  DEFAULT_LOD,
  selectionRange,
  selectTiles,
  tileAngularDistance,
  tileQuad,
} from '../src/render/common/terrain/quadtree';
import type { LodView } from '../src/render/common/terrain/quadtree';
import {
  aheadView,
  bubblePriority,
  BUBBLE_LEVEL,
  lookAheadPriority,
  MotionEstimate,
  PROMOTION_BUBBLE,
  tilesWithin,
} from '../src/render/common/terrain/prefetch';
import {
  DATA_SHARE,
  DATA_TILE_BYTES,
  DEFAULT_TILE_MEMORY_MIB,
  MESH_TILE_BYTES,
  workingSet,
} from '../src/render/common/terrain/terrainBudget';

const R = PLANET_RADIUS;

/** Every tile at a level whose nearest point lies within `distance` of `center`. */
function bruteForce(center: Vec3d, distance: number, level: number): Set<string> {
  const out = new Set<string>();
  const n = 1 << level;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const t = tileKey(f as CubeFace, level, x, y);
        if (tileAngularDistance(tileQuad(t), center) * R <= distance) out.add(tileKeyString(t));
      }
    }
  }
  return out;
}

/** A view from `height` above the sphere at a fixed spot, looking along `heading` and `pitch`. */
function view(height: number, heading: number, pitch: number, maxHeight: number): LodView {
  const n = new Vec3d(0.3, 0.6, 0.74).normalize();
  const east = new Vec3d(0, 1, 0).cross(n).normalize();
  const north = n.clone().cross(east);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward = new Vec3d()
    .addScaled(east, cp * Math.sin(heading))
    .addScaled(north, cp * Math.cos(heading))
    .addScaled(n, sp);
  const up = new Vec3d()
    .addScaled(east, -sp * Math.sin(heading))
    .addScaled(north, -sp * Math.cos(heading))
    .addScaled(n, cp);
  return {
    eye: n.clone().scale(R + height),
    forward,
    up,
    fovY: 45 * DEG,
    aspect: 16 / 9,
    viewportHeight: 2160,
    radius: R,
    exaggeration: 1,
    maxHeight,
  };
}

describe('tilesWithin', () => {
  it('finds exactly the tiles within the bubble, nearest first, across face seams', () => {
    const centers = [
      new Vec3d(0.3, 0.6, 0.74).normalize(),
      // A cube corner, where three faces meet.
      new Vec3d(1, 1, 1).normalize(),
      // On a face edge.
      new Vec3d(1, 0.2, 1).normalize(),
    ];
    for (const c of centers) {
      const near = tilesWithin(c, PROMOTION_BUBBLE, R, BUBBLE_LEVEL);
      const keys = new Set(near.map((n) => tileKeyString(n.tile)));
      expect(keys).toEqual(bruteForce(c, PROMOTION_BUBBLE, BUBBLE_LEVEL));
      expect(near[0]!.distance).toBe(0);
      for (let i = 1; i < near.length; i++) {
        expect(near[i]!.distance).toBeGreaterThanOrEqual(near[i - 1]!.distance);
      }
      // Level-7 tiles are about 12 km across: a 20 km bubble holds a dozen to a few dozen.
      expect(near.length).toBeGreaterThan(8);
      expect(near.length).toBeLessThan(40);
    }
    expect(new Set(tilesWithin(centers[1]!, 20 * KM, R, 7).map((n) => n.tile.face)).size).toBe(3);
  });
});

describe('MotionEstimate', () => {
  it('converges on a steady velocity and resets on a jump', () => {
    const m = new MotionEstimate();
    const eye = new Vec3d(0, 0, R + 100);
    const v = new Vec3d(80, 0, 0);
    m.update(eye, 1 / 60);
    for (let i = 0; i < 180; i++) {
      eye.addScaled(v, 1 / 60);
      m.update(eye, 1 / 60);
    }
    expect(m.velocity.distanceTo(v)).toBeLessThan(0.1);
    // A paused frame changes nothing.
    m.update(eye, 0);
    expect(m.velocity.x).toBeCloseTo(80, 0);
    // Jumping 300 km to another station is not motion.
    eye.x += 300 * KM;
    m.update(eye, 1 / 60);
    expect(m.velocity.length()).toBe(0);
  });
});

describe('look-ahead', () => {
  it('moves the eye along the velocity and keeps it above the ground', () => {
    const v = view(500, 0, 0, 4 * KM);
    const north = v.forward.clone();
    const a = aheadView(v, north.clone().scale(400), 3);
    expect(a.eye.distanceTo(v.eye)).toBeCloseTo(1200, 3);
    expect(a.forward).toBe(v.forward);
    const down = aheadView(v, v.eye.clone().normalize().scale(-1000), 3);
    expect(down.eye.length() - R).toBeCloseTo(2, 6);
  });

  it('ranks below the view and the layers on it, and above the bubble', () => {
    for (const sse of [2.0001, 3, 10, 1e3, 1e6]) {
      expect(lookAheadPriority(sse)).toBeLessThan(1);
      expect(lookAheadPriority(sse)).toBeGreaterThan(bubblePriority(0, PROMOTION_BUBBLE));
    }
    expect(lookAheadPriority(10)).toBeGreaterThan(lookAheadPriority(3));
    expect(bubblePriority(0, PROMOTION_BUBBLE)).toBeGreaterThan(
      bubblePriority(PROMOTION_BUBBLE, PROMOTION_BUBBLE),
    );
    expect(bubblePriority(PROMOTION_BUBBLE, PROMOTION_BUBBLE)).toBeGreaterThan(0);
  });
});

describe('tile memory budget', () => {
  it('holds the working set anywhere in the 0–20 km envelope with room to spare', () => {
    // True scale, 4K, every tile up to 5 km tall (mountains everywhere), the bubble prefetched.
    const dataBudget = DATA_SHARE * DEFAULT_TILE_MEMORY_MIB * 2 ** 20;
    const meshBudget = (1 - DATA_SHARE) * DEFAULT_TILE_MEMORY_MIB * 2 ** 20;
    let most = { meshes: 0, data: 0 };
    for (const h of [2, 20, 200, 1000, 3000, 8000, 20 * KM]) {
      for (const pitch of [0, -10 * DEG, -45 * DEG, -89 * DEG]) {
        const v = view(h, 30 * DEG, pitch, 5 * KM);
        const sel = selectTiles(
          v,
          () => true,
          DEFAULT_LOD,
          () => [0, 5 * KM],
        );
        const bubble = tilesWithin(v.eye.clone().normalize(), PROMOTION_BUBBLE, R, BUBBLE_LEVEL);
        const ws = workingSet(
          sel,
          bubble.map((b) => b.tile),
        );
        expect(ws.bytes).toBe(ws.meshes * MESH_TILE_BYTES + ws.data * DATA_TILE_BYTES);
        most = { meshes: Math.max(most.meshes, ws.meshes), data: Math.max(most.data, ws.data) };
        // Nothing the selection holds lies beyond its bounded radius (decision 116).
        const nadir = v.eye.clone().normalize();
        for (const d of sel.draw) {
          expect(tileAngularDistance(tileQuad(d.tile), nadir) * R).toBeLessThanOrEqual(
            selectionRange(v),
          );
        }
      }
    }
    // Half of each share leaves the other half for the look-ahead and for turning back.
    expect(most.meshes * MESH_TILE_BYTES).toBeLessThan(0.5 * meshBudget);
    expect(most.data * DATA_TILE_BYTES).toBeLessThan(0.5 * dataBudget);
  });
});
