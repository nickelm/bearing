/**
 * Terrain shadows (decision 139), the parts that need no GPU: window snapping,
 * the anchor face, re-bake thresholds, the height atlas, tile heights, and
 * the bake's CPU reference against the geometry (a ridge's shadow, the
 * planet's limb, a fine grid continued by a coarse one).
 */
import { describe, expect, it } from 'vitest';
import { CubeFace, cubeFaceUvToDirection, projectToCubeFace } from '../src/core/coords';
import { TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../src/core/tiles';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  LOW_SUN_EXPOSURE,
  PlanetLighting,
  surfaceExposure,
} from '../src/render/sim/lighting/planetLighting';
import {
  anchorFace,
  bakeAngle,
  bakeReference,
  buildHeightAtlas,
  latticeSize,
  PASSES_PER_GRID,
  sampleHeightAtlas,
  SHADOW_SIZE,
  SHADOW_SNAP,
  SHADOW_STEP_TEXELS,
  shadowFollow,
  shadowStrength,
  shadowVisibility,
  tileHeightAt,
  windowOrigin,
} from '../src/render/sim/lighting/terrainShadow';
import type { ShadowSample } from '../src/render/sim/lighting/terrainShadow';

const R = PLANET_RADIUS;

/** A local frame at a face point: up, and a tangent toward increasing u. */
function frame(face: CubeFace, u: number, v: number) {
  const up = cubeFaceUvToDirection(face, u, v);
  const ahead = cubeFaceUvToDirection(face, u + 1e-4, v);
  const tangent = ahead.addScaled(up, -ahead.dot(up)).normalize();
  return { up, tangent };
}

/** Bilinear read of a reference field at a direction; null outside the window. */
function fieldSampler(
  field: Float32Array,
  size: number,
  lattice: number,
  face: CubeFace,
  origin: readonly [number, number],
) {
  return (dir: Readonly<Vec3d>): ShadowSample | null => {
    const uv = projectToCubeFace(dir, face);
    const tx = uv.u * lattice - origin[0];
    const ty = uv.v * lattice - origin[1];
    if (!(tx > 0 && ty > 0 && tx < size - 1 && ty < size - 1)) return null;
    const x0 = Math.floor(tx);
    const y0 = Math.floor(ty);
    const fx = tx - x0;
    const fy = ty - y0;
    const at = (c: number) => {
      const i = (y0 * size + x0) * 3 + c;
      return (
        (field[i]! * (1 - fx) + field[i + 3]! * fx) * (1 - fy) +
        (field[i + size * 3]! * (1 - fx) + field[i + size * 3 + 3]! * fx) * fy
      );
    };
    return { shadow: at(0), distance: at(1), ground: at(2) };
  };
}

describe('shadow windows', () => {
  it('centers the window on the camera in steps of the snap', () => {
    expect(windowOrigin(1000)).toBe(992 - SHADOW_SIZE / 2);
    expect(windowOrigin(1016)).toBe(1024 - SHADOW_SIZE / 2);
    expect(windowOrigin(1000) % SHADOW_SNAP).toBe(0);
    // Lattice points keep their place: origins differ by whole snaps only.
    for (let c = 0; c < 4000; c += 37) {
      expect(Math.abs(windowOrigin(c) % SHADOW_SNAP)).toBe(0);
      expect(Math.abs(c - (windowOrigin(c) + SHADOW_SIZE / 2))).toBeLessThanOrEqual(
        SHADOW_SNAP / 2,
      );
    }
  });

  it('keeps a window while the camera stays near its center', () => {
    const origin = windowOrigin(1024);
    // Hovering around the snap boundary at 1040 does not move it.
    for (const c of [1036, 1042, 1039, 1047, 1024, 1001]) {
      expect(windowOrigin(c, origin)).toBe(origin);
    }
    // 24 texels (three quarters of a snap) is the limit.
    expect(windowOrigin(1049, origin)).toBe(1056 - SHADOW_SIZE / 2);
    expect(windowOrigin(990, origin)).toBe(992 - SHADOW_SIZE / 2);
  });

  it('keeps the anchor face a little past its edge', () => {
    const center = new Vec3d(0, 0, 1);
    expect(anchorFace(center, null)).toBe(CubeFace.PosZ);
    // 47° from +Z toward +X: over the +X face, but within the hysteresis of +Z.
    const past = new Vec3d(Math.sin(47 * DEG), 0, Math.cos(47 * DEG));
    expect(anchorFace(past, null)).toBe(CubeFace.PosX);
    expect(anchorFace(past, CubeFace.PosZ)).toBe(CubeFace.PosZ);
    const far = new Vec3d(Math.sin(52 * DEG), 0, Math.cos(52 * DEG));
    expect(anchorFace(far, CubeFace.PosZ)).toBe(CubeFace.PosX);
    // And coming back, +X holds until 49° from its own center.
    const back = new Vec3d(Math.sin(43 * DEG), 0, Math.cos(43 * DEG));
    expect(anchorFace(back, CubeFace.PosX)).toBe(CubeFace.PosX);
  });
});

describe('re-bake thresholds', () => {
  it('bakes again after a smaller sun angle at low sun', () => {
    expect(bakeAngle(5 * DEG)).toBeCloseTo(0.1 * Math.sin(5 * DEG) ** 2, 12);
    expect(bakeAngle(5 * DEG) / DEG).toBeGreaterThan(0.03);
    expect(bakeAngle(5 * DEG) / DEG).toBeLessThan(0.06);
    expect(bakeAngle(1 * DEG)).toBeLessThan(bakeAngle(5 * DEG));
    expect(bakeAngle(-3 * DEG)).toBeCloseTo(0.005 * DEG, 12);
    expect(bakeAngle(40 * DEG)).toBeCloseTo(0.5 * DEG, 12);
    // A 1 km ridge's shadow tip moves h·Δ / sin² e: about one near texel per bake.
    const tip = (1000 * bakeAngle(5 * DEG)) / Math.sin(5 * DEG) ** 2;
    expect(tip).toBeCloseTo(100, 6);
  });

  it('applies shadows from below the horizon to a high sun only', () => {
    expect(shadowStrength(5 * DEG)).toBe(1);
    expect(shadowStrength(-5 * DEG)).toBe(1);
    expect(shadowStrength(39 * DEG)).toBe(1);
    expect(shadowStrength(49 * DEG)).toBe(0);
    expect(shadowStrength(-10 * DEG)).toBe(0);
    expect(shadowStrength(44 * DEG)).toBeGreaterThan(0);
    expect(shadowStrength(44 * DEG)).toBeLessThan(1);
  });

  it('fades the shadows out when the clock outruns the bake', () => {
    // A full bake at four passes a frame, 60 frames per second.
    const bake = (3 * PASSES_PER_GRID) / 4 / 60;
    const sunSpeed = (x: number) => ((15 * DEG) / 3600) * x;
    expect(shadowFollow(sunSpeed(1), bake)).toBe(1);
    expect(shadowFollow(sunSpeed(256), bake)).toBe(1);
    expect(shadowFollow(sunSpeed(2000), bake)).toBe(1);
    expect(shadowFollow(sunSpeed(5000), bake)).toBeGreaterThan(0);
    expect(shadowFollow(sunSpeed(5000), bake)).toBeLessThan(1);
    expect(shadowFollow(sunSpeed(10000), bake)).toBe(0);
    // At 20 frames per second a bake takes three times as long.
    expect(shadowFollow(sunSpeed(2000), 3 * bake)).toBeLessThan(1);
  });
});

describe('height atlas', () => {
  const n = 8;
  const height = new Float32Array(6 * n * n);
  for (let c = 0; c < height.length; c++) {
    const face = Math.floor(c / (n * n)) as CubeFace;
    const d = cubeFaceUvToDirection(face, ((c % n) + 0.5) / n, ((Math.floor(c / n) % n) + 0.5) / n);
    // A smooth field with sea on one side.
    height[c] = 2000 * d.x + 1000 * d.y * d.z;
  }

  it('holds displayed heights, continuous across face seams', () => {
    const atlas = buildHeightAtlas(height, n);
    expect(atlas.n).toBe(n);
    expect(atlas.width).toBe(3 * (n + 2));
    expect(atlas.height).toBe(2 * (n + 2));
    // At cell centers the atlas returns the cell, with the sea at 0.
    for (let c = 0; c < height.length; c += 7) {
      const face = Math.floor(c / (n * n)) as CubeFace;
      const d = cubeFaceUvToDirection(
        face,
        ((c % n) + 0.5) / n,
        ((Math.floor(c / n) % n) + 0.5) / n,
      );
      // Half floats: a part in 2,048.
      expect(Math.abs(sampleHeightAtlas(atlas, d) - Math.max(0, height[c]!))).toBeLessThan(1.5);
    }
    // Either side of a seam (x = z, between +X and +Z) agrees to within the field's slope.
    for (const y of [-0.4, 0, 0.3]) {
      const a = sampleHeightAtlas(atlas, new Vec3d(1.001, y, 1).normalize());
      const b = sampleHeightAtlas(atlas, new Vec3d(1, y, 1.001).normalize());
      expect(Math.abs(a - b)).toBeLessThan(15);
      expect(a).toBeGreaterThan(900);
    }
  });

  it('averages a fine grid down to the limit', () => {
    const atlas = buildHeightAtlas(height, n, 4);
    expect(atlas.n).toBe(4);
    // The first interior texel of face 0 is the mean of its four cells (sea as 0).
    const mean =
      [0, 1, n, n + 1].map((c) => Math.max(0, height[c]!)).reduce((a, b) => a + b, 0) / 4;
    const d = cubeFaceUvToDirection(0, 0.125, 0.125);
    expect(Math.abs(sampleHeightAtlas(atlas, d) - mean)).toBeLessThan(1.5);
  });
});

describe('tile heights', () => {
  /** A tile whose samples are a plane in face coordinates: h = 1000·u + 500·v + offset. */
  const tile = (level: number, x: number, y: number, offset: number) => {
    const h = new Float32Array(TILE_STRIDE * TILE_STRIDE);
    const size = TILE_TEXELS << level;
    for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
      for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
        const u = (x * TILE_TEXELS + sx) / size;
        const v = (y * TILE_TEXELS + sy) / size;
        h[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER] = 1000 * u + 500 * v + offset;
      }
    }
    return h;
  };

  it('reads the finest cached tile, bilinear, and reports none', () => {
    const cache = new Map<string, Float32Array>([
      ['4/7/40/41', tile(7, 40, 41, 7)],
      ['4/5/10/10', tile(5, 10, 10, 5)],
    ]);
    const lookup = (face: number, level: number, x: number, y: number) =>
      cache.get(`${face}/${level}/${x}/${y}`) ?? null;
    // Inside the level-7 tile: its plane.
    const u = 40.3 / 128;
    const v = 41.6 / 128;
    expect(tileHeightAt(lookup, 4, u, v, 7, 4)).toBeCloseTo(1000 * u + 500 * v + 7, 2);
    // Next to it, only the level-5 ancestor is cached.
    const u2 = 42.5 / 128;
    expect(tileHeightAt(lookup, 4, u2, v, 7, 4)).toBeCloseTo(1000 * u2 + 500 * v + 5, 2);
    // The level-5 tile is not looked at when the search stops at level 6.
    expect(tileHeightAt(lookup, 4, u2, v, 7, 6)).toBeNull();
    // Another face: nothing.
    expect(tileHeightAt(lookup, 2, u, v, 7, 0)).toBeNull();
  });
});

describe('the bake (CPU reference)', () => {
  const face = CubeFace.PosZ;

  it("gives a ridge's shadow its length, and leaves lit ground lit", () => {
    const lattice = latticeSize(6);
    const size = 128;
    const origin: [number, number] = [lattice / 2 - size / 2, lattice / 2 - size / 2];
    const { up, tangent } = frame(face, 0.5, 0.5);
    const elevation = 10 * DEG;
    const sun = up.clone().scale(Math.sin(elevation)).addScaled(tangent, Math.cos(elevation));
    // A wall 600 m high and 300 m thick across the sun's direction, 1 km sunward of the center.
    const h = 600;
    const along = (d: Readonly<Vec3d>) => Math.asin(d.dot(tangent)) * R;
    const ground = (d: Readonly<Vec3d>) => (along(d) >= 1000 && along(d) <= 1300 ? h : 0);
    const field = bakeReference({ size, lattice, face, origin, sun, radius: R, ground });
    const spacing = ((Math.PI / 2) * R) / lattice;

    let checked = 0;
    let tip = Infinity;
    for (let x = 2; x < size - 2; x++) {
      const y = size / 2;
      const d = cubeFaceUvToDirection(face, (origin[0] + x) / lattice, (origin[1] + y) / lattice);
      const s = along(d);
      const shadow = field[(y * size + x) * 3]!;
      // The exact shadow height: the wall's near edge seen from here, on the sphere.
      const e = Math.asin(d.dot(sun));
      const phi = (1000 - s) / R;
      const exact = ((R + h) * Math.cos(e + phi)) / Math.cos(e) - R;
      if (s > 1400) {
        // Sunward of the wall: lit.
        expect(shadow).toBe(0);
      } else if (s < 1000 - spacing) {
        if (exact > 25) {
          // The wall's edge is known to a texel or two.
          expect(Math.abs(shadow - exact)).toBeLessThan(spacing * Math.tan(elevation) + 6);
          checked++;
        } else if (exact < -25) {
          expect(shadow).toBe(0);
        }
        if (shadow > 0) tip = Math.min(tip, s);
      }
    }
    expect(checked).toBeGreaterThan(20);
    // The shadow ends h / tan(e) behind the wall, to within the grid's resolution.
    const length = 1000 - tip;
    expect(Math.abs(length - h / Math.tan(elevation))).toBeLessThan(2 * spacing);

    // A point in the shadow is dark on the ground and lit above the shadow's top.
    const mid = Math.round(size / 2 - 1500 / spacing);
    const i = ((size / 2) * size + mid) * 3;
    const sample = { shadow: field[i]!, distance: field[i + 1]!, ground: field[i + 2]! };
    expect(sample.shadow).toBeGreaterThan(100);
    // The occluder is where it is: about 2.5 km sunward.
    expect(Math.abs(sample.distance - 2.5)).toBeLessThan(0.3);
    expect(shadowVisibility(sample, 0, spacing, Math.sin(elevation))).toBe(0);
    expect(shadowVisibility(sample, sample.shadow + 1, spacing, Math.sin(elevation))).toBe(1);
    const half = shadowVisibility(sample, sample.shadow - 15, spacing, Math.sin(elevation));
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });

  it('widens the penumbra with the distance to the occluder', () => {
    const near: ShadowSample = { shadow: 20, distance: 0.5, ground: 100 };
    const far: ShadowSample = { shadow: 20, distance: 20, ground: 100 };
    const sinE = Math.sin(5 * DEG);
    // 20 m under the shadow's top: dark behind a near occluder, half lit behind a far one.
    expect(shadowVisibility(near, 100, 96, sinE)).toBe(0);
    expect(shadowVisibility(far, 100, 96, sinE)).toBeGreaterThan(0.9);
    // Ground below the bake's ground counts as on it: lit ground never darkens.
    expect(shadowVisibility({ shadow: 0, distance: 0, ground: 100 }, 60, 96, sinE)).toBe(1);
  });

  it("shades the far side with the planet's limb", () => {
    // The coarse grid, flat sea-level ground, the sun 3° under the horizon at the center.
    const lattice = latticeSize(2);
    const size = 128;
    const origin: [number, number] = [lattice / 2 - size / 2, lattice / 2 - size / 2];
    const { up, tangent } = frame(face, 0.5, 0.5);
    const sun = up
      .clone()
      .scale(Math.sin(-3 * DEG))
      .addScaled(tangent, Math.cos(-3 * DEG));
    const field = bakeReference({ size, lattice, face, origin, sun, radius: R, ground: () => 0 });
    let dark = 0;
    let lit = 0;
    for (let y = 8; y < size - 8; y += 9) {
      for (let x = 8; x < size - 8; x += 5) {
        const d = cubeFaceUvToDirection(face, (origin[0] + x) / lattice, (origin[1] + y) / lattice);
        const e = Math.asin(d.dot(sun));
        const shadow = field[(y * size + x) * 3]!;
        // Whatever stands below R·(1/cos e − 1) is behind the limb; where the sun is up, nothing.
        const exact = e < 0 ? R * (1 / Math.cos(e) - 1) : 0;
        // Near the sunward edge the march leaves the window before it reaches the horizon.
        const reach = (size - 1 - x) * (Math.PI / 2 / lattice) * 0.7;
        if (e < 0 && reach < -e) continue;
        expect(Math.abs(shadow - exact)).toBeLessThan(2 + 0.01 * exact);
        if (exact > 100) dark++;
        if (e > 0.2 * DEG) lit++;
      }
    }
    expect(dark).toBeGreaterThan(50);
    expect(lit).toBeGreaterThan(20);
    // At the center the shadow's top is about 1.37 km up: a 2 km summit is lit, the sea is not.
    const i = ((size / 2) * size + size / 2) * 3;
    const center = { shadow: field[i]!, distance: field[i + 1]!, ground: 0 };
    expect(center.shadow).toBeGreaterThan(1300);
    expect(center.shadow).toBeLessThan(1450);
    expect(shadowVisibility(center, 2000, 1534, 0)).toBe(1);
    expect(shadowVisibility(center, 0, 1534, 0)).toBe(0);
  });

  it('continues a fine grid with the coarse one', () => {
    const { up, tangent } = frame(face, 0.5, 0.5);
    const elevation = 5 * DEG;
    const sun = up.clone().scale(Math.sin(elevation)).addScaled(tangent, Math.cos(elevation));
    // A 2 km wall 15 km sunward of the center: beyond the fine grid's window and reach.
    const h = 2000;
    const along = (d: Readonly<Vec3d>) => Math.asin(d.dot(tangent)) * R;
    const ground = (d: Readonly<Vec3d>) => (along(d) >= 15_000 && along(d) <= 16_500 ? h : 0);
    const coarseLattice = latticeSize(4);
    const coarseSize = 128;
    const coarseOrigin: [number, number] = [
      coarseLattice / 2 - coarseSize / 2,
      coarseLattice / 2 - coarseSize / 2,
    ];
    const coarse = bakeReference({
      size: coarseSize,
      lattice: coarseLattice,
      face,
      origin: coarseOrigin,
      sun,
      radius: R,
      ground,
    });
    const lattice = latticeSize(6);
    const size = 64;
    const origin: [number, number] = [lattice / 2 - size / 2, lattice / 2 - size / 2];
    // The fine window is 6 km across and reaches 2^4 texels = 1.5 km.
    expect((size * (Math.PI / 2) * R) / lattice).toBeLessThan(7000);
    const fine = bakeReference({
      size,
      lattice,
      face,
      origin,
      sun,
      radius: R,
      ground,
      steps: 4,
      stepTexels: SHADOW_STEP_TEXELS,
      coarse: fieldSampler(coarse, coarseSize, coarseLattice, face, coarseOrigin),
    });
    const coarseSpacing = ((Math.PI / 2) * R) / coarseLattice;
    let checked = 0;
    for (let y = 3; y < size - 3; y += 6) {
      for (let x = 3; x < size - 3; x += 4) {
        const d = cubeFaceUvToDirection(face, (origin[0] + x) / lattice, (origin[1] + y) / lattice);
        const e = Math.asin(d.dot(sun));
        const phi = (15_000 - along(d)) / R;
        const exact = ((R + h) * Math.cos(e + phi)) / Math.cos(e) - R;
        expect(exact).toBeGreaterThan(200);
        // The wall's edge is known to a coarse texel.
        expect(Math.abs(fine[(y * size + x) * 3]! - exact)).toBeLessThan(
          coarseSpacing * Math.tan(elevation) + 15,
        );
        // And the occluder's distance comes through both grids.
        expect(Math.abs(fine[(y * size + x) * 3 + 1]! - (15 - along(d) / 1000))).toBeLessThan(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('the ground under a low sun', () => {
  it('exposes surfaces over the sky around sunset, without a step, and only there', () => {
    for (const e of [90, 45, 20, 16]) expect(surfaceExposure(e * DEG)).toBe(1);
    for (const e of [4, 2, 0, -4])
      expect(surfaceExposure(e * DEG)).toBeCloseTo(LOW_SUN_EXPOSURE, 9);
    for (const e of [-12, -18, -60]) expect(surfaceExposure(e * DEG)).toBe(1);
    // Between half a stop and a stop: the ground reads, and golden hour keeps its mood.
    expect(LOW_SUN_EXPOSURE).toBeGreaterThan(1.4);
    expect(LOW_SUN_EXPOSURE).toBeLessThanOrEqual(2);
    let last = 1;
    for (let e = 16; e >= -12; e -= 0.25) {
      const gain = surfaceExposure(e * DEG);
      expect(gain).toBeGreaterThanOrEqual(1);
      expect(gain).toBeLessThanOrEqual(LOW_SUN_EXPOSURE);
      // No step: under 4% per quarter of a degree (a minute of real time).
      expect(Math.abs(gain / last - 1)).toBeLessThan(0.04);
      last = gain;
    }
    // Halfway down the afternoon it is halfway up.
    expect(surfaceExposure(10 * DEG)).toBeCloseTo(1 + (LOW_SUN_EXPOSURE - 1) / 2, 9);
    // The knob, and none from orbit.
    expect(surfaceExposure(2 * DEG, 1)).toBe(1);
    expect(surfaceExposure(2 * DEG, 3)).toBeCloseTo(3, 9);
    expect(surfaceExposure(2 * DEG, 2, 300 * KM)).toBe(1);
    expect(surfaceExposure(2 * DEG, 2, 20 * KM)).toBeCloseTo(2, 9);
  });

  it('is set by the lighting from the sun at the camera', () => {
    const lighting = new PlanetLighting(R);
    const eye = new Vec3d(0, R + 500, 0);
    const sunAt = (e: number) => new Vec3d(Math.cos(e * DEG), Math.sin(e * DEG), 0);
    lighting.update(eye, sunAt(50));
    expect(lighting.surfaceGain.value).toBe(1);
    lighting.update(eye, sunAt(3));
    expect(lighting.surfaceGain.value).toBeCloseTo(LOW_SUN_EXPOSURE, 9);
    lighting.lowSunExposure = 1;
    lighting.update(eye, sunAt(3));
    expect(lighting.surfaceGain.value).toBe(1);
    // A camera that is not at the planet (the model viewer) gets plain daylight.
    lighting.lowSunExposure = LOW_SUN_EXPOSURE;
    lighting.update(new Vec3d(0, 0, 0), sunAt(3));
    expect(lighting.surfaceGain.value).toBe(1);
    lighting.atmosphere.dispose();
  });
});
