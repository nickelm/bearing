/**
 * Terrain shadows (decision 139) baked by compute on Dawn, over a synthetic
 * world: a wall of known height on the sphere and a known sun. The shadow's
 * length matches h / tan(elevation) to the grid's resolution, lit ground stays
 * lit, the planet's limb shades the far side, the kernels agree with the CPU
 * reference, and the per-frame schedule bakes only what is stale.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { Fn, instanceIndex, instancedArray, uniform, vec4 } from 'three/tsl';
import { CubeFace, cubeFaceUvToDirection } from '../../src/core/coords';
import { TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../../src/core/tiles';
import type { TileKey } from '../../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import {
  bakeAngle,
  bakeReference,
  buildHeightAtlas,
  latticeSize,
  PASSES_PER_GRID,
  sampleHeightAtlas,
  SHADOW_SIZE,
  SHADOW_SNAP,
  SHADOW_TILE_LEVELS,
  TerrainShadow,
} from '../../src/render/sim/lighting/terrainShadow';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();
const R = PLANET_RADIUS;
const FACE = CubeFace.PosZ;
/** Cells per face edge of the synthetic global grid (3 km cells). */
const N = 512;

const center = cubeFaceUvToDirection(FACE, 0.5, 0.5);
const tangent = (() => {
  const ahead = cubeFaceUvToDirection(FACE, 0.5 + 1e-4, 0.5);
  return ahead.addScaled(center, -ahead.dot(center)).normalize();
})();
const side = center.clone().cross(tangent).normalize();
/** Meters toward the sun's azimuth from the center. */
const along = (d: Readonly<Vec3d>) => Math.asin(d.dot(tangent)) * R;
/** The sun at an elevation (rad) over the center, toward `tangent`. */
const sunAt = (elevation: number) =>
  center.clone().scale(Math.sin(elevation)).addScaled(tangent, Math.cos(elevation));
/** A wall 800 m high from 3 to 9 km sunward of the center, across the sun's direction. */
const WALL = 800;
const ground = (d: Readonly<Vec3d>) => (along(d) >= 3000 && along(d) <= 9000 ? WALL : 0);
/** The point `s` meters toward the sun and `t` meters to the side of the center, at height h. */
const point = (s: number, t: number, h: number) =>
  center
    .clone()
    .addScaled(tangent, Math.tan(s / R))
    .addScaled(side, Math.tan(t / R))
    .normalize()
    .scale(R + h);

function globalHeights(): Float32Array {
  const height = new Float32Array(6 * N * N);
  const d = new Vec3d();
  // Only the anchor face has land.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      cubeFaceUvToDirection(FACE, (i + 0.5) / N, (j + 0.5) / N, d);
      height[FACE * N * N + j * N + i] = ground(d);
    }
  }
  return height;
}

/** Tiles of the synthetic world on demand: the exact wall, sampled as the synthesizer would. */
function tileSource() {
  const cache = new Map<string, { height: Float32Array } | undefined>();
  const d = new Vec3d();
  let served = 0;
  return {
    get served() {
      return served;
    },
    dataTile(key: TileKey) {
      const id = `${key.face}/${key.level}/${key.x}/${key.y}`;
      if (!cache.has(id)) {
        // Level 7 and 5 exist (the finest level each tile-fed grid reads), on the anchor face.
        if (key.face !== FACE || (key.level !== 7 && key.level !== 5)) {
          cache.set(id, undefined);
        } else {
          const height = new Float32Array(TILE_STRIDE * TILE_STRIDE);
          const size = TILE_TEXELS << key.level;
          for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
            for (let sx = -TILE_BORDER; sx <= TILE_TEXELS + TILE_BORDER; sx++) {
              cubeFaceUvToDirection(
                FACE,
                (key.x * TILE_TEXELS + sx) / size,
                (key.y * TILE_TEXELS + sy) / size,
                d,
              );
              height[(sy + TILE_BORDER) * TILE_STRIDE + sx + TILE_BORDER] = ground(d);
            }
          }
          cache.set(id, { height });
        }
      }
      const tile = cache.get(id);
      if (tile) served++;
      return tile;
    },
  };
}

describe.skipIf(!gpu)('terrain shadows (TSL compute on Dawn)', () => {
  it('casts a wall’s shadow of the right length, keeps lit ground lit, and matches the reference', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const sunUniform = uniform(new Vector3());
    const shadow = new TerrainShadow(sunUniform, R);
    const heights = globalHeights();
    shadow.setHeights(heights, N);
    shadow.tiles = tileSource();
    const elevation = 8 * DEG;
    const sun = sunAt(elevation);
    sunUniform.value.set(sun.x, sun.y, sun.z);
    const eye = center.clone().scale(R + 1000);
    shadow.bake(head.renderer, eye, sun);
    expect(shadow.busy).toBe(false);
    expect(shadow.stats.bakes).toBe(3);
    expect(shadow.stats.passes).toBe(3 * PASSES_PER_GRID);
    expect(shadow.anchor).toBe(FACE);
    expect(shadow.strength.value).toBe(1);

    // Query points: a line through the center along the sun's azimuth, on the ground and above it,
    // then the coarse grid's lattice points for the reference comparison.
    const points: Vec3d[] = [];
    const line: number[] = [];
    for (let s = -9000; s <= 14_000; s += 50) {
      line.push(s);
      points.push(point(s, 400, ground(point(s, 400, 0).normalize())));
    }
    const lineCount = points.length;
    // The same line 300 m above the ground.
    for (const s of line) points.push(point(s, 400, ground(point(s, 400, 0).normalize()) + 300));
    const lattice = latticeSize(SHADOW_TILE_LEVELS[2]);
    const origin = shadow.origin(2)!;
    const picks: [number, number][] = [];
    for (let y = 4; y < SHADOW_SIZE - 4; y += 13) {
      for (let x = 4; x < SHADOW_SIZE - 4; x += 11) {
        picks.push([x, y]);
        points.push(
          cubeFaceUvToDirection(FACE, (origin[0] + x) / lattice, (origin[1] + y) / lattice).scale(
            R,
          ),
        );
      }
    }
    const count = points.length;
    const data = new Float32Array(count * 4);
    points.forEach((p, i) => data.set([p.x, p.y, p.z, 0], i * 4));
    const input = instancedArray(data, 'vec4');
    const outVisibility = instancedArray(count, 'vec4');
    const outField = [0, 1, 2].map(() => instancedArray(count, 'vec4'));
    const kernel = Fn(() => {
      const p = input.element(instanceIndex).xyz;
      outVisibility.element(instanceIndex).assign(vec4(shadow.visibility(p), 0, 0, 0));
      for (let l = 0; l < 3; l++) outField[l]!.element(instanceIndex).assign(shadow.field(l, p));
    })().compute(count);
    await head.renderer.computeAsync(kernel);
    const read = async (node: (typeof outField)[number]) =>
      new Float32Array(await head.renderer.getArrayBufferAsync(node.value));
    const visibility = await read(outVisibility);
    const fields = await Promise.all(outField.map(read));
    expect(gpu!.errors).toEqual([]);

    // The wall's sunward ground and the ground beyond the shadow's tip are lit; the
    // shadow's height is exact to a near texel; its tip is where h / tan(e) puts it.
    const spacing = ((Math.PI / 2) * R) / latticeSize(SHADOW_TILE_LEVELS[0]);
    const tipExact = 3000 - WALL / Math.tan(elevation);
    let tip = Infinity;
    let halfLit = Infinity;
    let inShadow = 0;
    for (let i = 0; i < lineCount; i++) {
      const s = line[i]!;
      const d = points[i]!.clone().normalize();
      const e = Math.asin(d.dot(sun));
      const exact = ((R + WALL) * Math.cos(e + (3000 - s) / R)) / Math.cos(e) - R;
      const v = visibility[i * 4]!;
      const f = fields[0]!;
      expect(f[i * 4 + 3]).toBeCloseTo(1, 5); // inside the near grid
      if (s > 9000 + 2 * spacing) {
        expect(v).toBe(1);
        expect(f[i * 4]).toBe(0);
      } else if (s < 3000 - 2 * spacing) {
        if (exact > 40) {
          expect(Math.abs(f[i * 4]! - exact)).toBeLessThan(spacing * Math.tan(elevation) + 6);
          // The penumbra: the sun's size seen from the wall, never under a texel and a half.
          const width = Math.max(1.5 * spacing * Math.sin(e), (3000 - s) * 0.012);
          if (exact > width + 30) expect(v).toBe(0);
          // 300 m up, the point is in the shadow only while the shadow's top is higher.
          const above = visibility[(lineCount + i) * 4]!;
          if (exact > 300 + width + 30) expect(above).toBe(0);
          if (exact < 270) expect(above).toBe(1);
          // The occluder's distance: to the wall's near edge.
          expect(Math.abs(f[i * 4 + 1]! - (3000 - s) / 1000)).toBeLessThan(0.25);
          inShadow++;
        } else if (exact < -40) {
          expect(v).toBe(1);
          expect(f[i * 4]).toBe(0);
        }
        if (f[i * 4]! > 0) tip = Math.min(tip, s);
        if (v < 0.5) halfLit = Math.min(halfLit, s);
      }
    }
    expect(inShadow).toBeGreaterThan(60);
    expect(Math.abs(tip - tipExact)).toBeLessThan(2 * spacing);
    // The penumbra lies inside the shadow: half the sun's width as seen from the wall.
    const penumbra = ((3000 - tipExact) * 0.012) / Math.tan(elevation);
    expect(halfLit).toBeGreaterThan(tip);
    expect(halfLit - tip).toBeLessThan(0.5 * penumbra + 2 * spacing);
    // The edge is soft: some points along the line are partly lit.
    const partial = line.filter((_, i) => visibility[i * 4]! > 0.05 && visibility[i * 4]! < 0.95);
    expect(partial.length).toBeGreaterThan(1);

    // The coarse grid against the CPU reference over the same atlas.
    const atlas = buildHeightAtlas(heights, N);
    const reference = bakeReference({
      size: SHADOW_SIZE,
      lattice,
      face: FACE,
      origin,
      sun,
      radius: R,
      ground: (d) => sampleHeightAtlas(atlas, d),
    });
    let worst = 0;
    let shaded = 0;
    picks.forEach(([x, y], k) => {
      const i = lineCount * 2 + k;
      const want = reference[(y * SHADOW_SIZE + x) * 3]!;
      const got = fields[2]![i * 4]!;
      worst = Math.max(worst, Math.abs(got - want) - 0.01 * want);
      if (want > 10) shaded++;
      expect(fields[2]![i * 4 + 2]).toBeCloseTo(reference[(y * SHADOW_SIZE + x) * 3 + 2]!, 0);
    });
    expect(shaded).toBeGreaterThan(5);
    expect(worst).toBeLessThan(3);

    shadow.dispose();
    head.dispose();
  }, 240_000);

  it('shades the far side with the planet’s limb, and switches off at zero cost', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const sunUniform = uniform(new Vector3());
    const shadow = new TerrainShadow(sunUniform, R);
    shadow.setHeights(new Float32Array(6 * 64 * 64), 64);
    const sun = sunAt(-3 * DEG);
    sunUniform.value.set(sun.x, sun.y, sun.z);
    shadow.bake(head.renderer, center.clone().scale(R + 500), sun);

    // Sea level and 2 km up: at the center, 80 km down-sun, and 80 km up-sun (where the sun is up).
    const points = [0, -80_000, 80_000].flatMap((s) => [point(s, 0, 0), point(s, 0, 2500)]);
    const data = new Float32Array(points.length * 4);
    points.forEach((p, i) => data.set([p.x, p.y, p.z, 0], i * 4));
    const input = instancedArray(data, 'vec4');
    const output = instancedArray(points.length, 'vec4');
    const kernel = Fn(() => {
      const p = input.element(instanceIndex).xyz;
      output.element(instanceIndex).assign(vec4(shadow.visibility(p), shadow.field(1, p).x, 0, 0));
    })().compute(points.length);
    const run = async () => {
      await head.renderer.computeAsync(kernel);
      return new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    };
    let out = await run();
    expect(gpu!.errors).toEqual([]);
    const limb = (s: number) => {
      const e = Math.asin(point(s, 0, 0).normalize().dot(sun));
      return e < 0 ? R * (1 / Math.cos(e) - 1) : 0;
    };
    // The shadow's top stands R·(1/cos e − 1) over the sea: 1.37 km at the center.
    expect(limb(0)).toBeGreaterThan(1300);
    expect(Math.abs(out[1]! - limb(0))).toBeLessThan(20);
    expect(Math.abs(out[9]! - limb(-80_000))).toBeLessThan(0.02 * limb(-80_000));
    expect(out[0]).toBe(0); // the sea at the center is behind the limb
    expect(out[4]).toBe(1); // 2.5 km above it is not
    expect(out[8]).toBe(0); // 80 km down-sun the shadow is deeper
    expect(limb(-80_000)).toBeGreaterThan(2500);
    expect(out[12]).toBe(0);
    expect(out[16]).toBe(1); // up-sun the sun is above the horizon: lit
    expect(out[17]).toBe(0);
    expect(out[20]).toBe(1);

    // Switched off, every lookup returns 1 without reading the field.
    shadow.enabled = false;
    shadow.update(head.renderer, center.clone().scale(R + 500), sun, 1 / 60);
    expect(shadow.strength.value).toBe(0);
    out = await run();
    expect(out[0]).toBe(1);
    expect(out[8]).toBe(1);
    shadow.dispose();
    head.dispose();
  }, 120_000);

  it('does not swim when the window re-centers', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const sunUniform = uniform(new Vector3());
    const shadow = new TerrainShadow(sunUniform, R);
    shadow.setHeights(globalHeights(), N);
    shadow.tiles = tileSource();
    const sun = sunAt(8 * DEG);
    sunUniform.value.set(sun.x, sun.y, sun.z);
    // Points across the shadow and its edge, on the ground.
    const points: Vec3d[] = [];
    for (let s = -7000; s <= 2500; s += 37) {
      for (const t of [-900, 150, 1300]) points.push(point(s, t, 0));
    }
    const data = new Float32Array(points.length * 4);
    points.forEach((p, i) => data.set([p.x, p.y, p.z, 0], i * 4));
    const input = instancedArray(data, 'vec4');
    const output = instancedArray(points.length, 'vec4');
    const kernel = Fn(() => {
      const p = input.element(instanceIndex).xyz;
      output.element(instanceIndex).assign(vec4(shadow.field(0, p).xyz, shadow.visibility(p)));
    })().compute(points.length);
    const run = async (eye: Vec3d) => {
      shadow.bake(head.renderer, eye, sun);
      await head.renderer.computeAsync(kernel);
      return new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    };
    const spacing = ((Math.PI / 2) * R) / latticeSize(SHADOW_TILE_LEVELS[0]);
    const before = await run(point(0, 0, 1000));
    const origin = shadow.origin(0)!;
    // Three snaps along and two across: the window moves, the lattice points stay.
    const after = await run(point(3.1 * SHADOW_SNAP * spacing, -2.2 * SHADOW_SNAP * spacing, 1000));
    expect(shadow.origin(0)![0] - origin[0]).toBe(3 * SHADOW_SNAP);
    expect(Math.abs(shadow.origin(0)![1] - origin[1])).toBe(2 * SHADOW_SNAP);
    expect(gpu!.errors).toEqual([]);
    let shaded = 0;
    let edge = 0;
    for (let i = 0; i < points.length; i++) {
      // The same shadow height (to the lookup's rounding), ground and visibility.
      expect(Math.abs(after[i * 4]! - before[i * 4]!)).toBeLessThan(0.5);
      expect(after[i * 4 + 2]).toBeCloseTo(before[i * 4 + 2]!, 1);
      expect(Math.abs(after[i * 4 + 3]! - before[i * 4 + 3]!)).toBeLessThan(0.02);
      if (before[i * 4]! > 0) shaded++;
      if (before[i * 4 + 3]! > 0.05 && before[i * 4 + 3]! < 0.95) edge++;
    }
    expect(shaded).toBeGreaterThan(300);
    expect(edge).toBeGreaterThan(5);
    shadow.dispose();
    head.dispose();
  }, 240_000);

  it('bakes a pass per frame, and only what the camera and the sun made stale', async () => {
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const sunUniform = uniform(new Vector3());
    const shadow = new TerrainShadow(sunUniform, R);
    shadow.setHeights(globalHeights(), N);
    const tiles = tileSource();
    shadow.tiles = tiles;
    shadow.sourceBudgetMs = 1000;
    const elevation = 6 * DEG;
    const sun = sunAt(elevation);
    const eye = center.clone().scale(R + 1000);
    const frame = (e: Readonly<Vec3d>, s: Readonly<Vec3d>) => {
      shadow.update(head.renderer, e, s, 1 / 60);
      return shadow.stats.framePasses;
    };
    /** Frames until idle, checking the pace. */
    const settle = (e: Readonly<Vec3d>, s: Readonly<Vec3d>) => {
      let frames = 0;
      do {
        expect(frame(e, s)).toBeLessThanOrEqual(1);
        frames++;
      } while (shadow.busy && frames < 200);
      return frames;
    };

    // The first bake: three grids, coarse first, one compute pass per frame.
    const first = settle(eye, sun);
    expect(shadow.stats.bakes).toBe(3);
    expect(shadow.stats.passes).toBe(3 * PASSES_PER_GRID);
    expect(first).toBeGreaterThanOrEqual(3 * PASSES_PER_GRID);
    expect(first).toBeLessThan(3 * PASSES_PER_GRID + 5);
    expect(tiles.served).toBeGreaterThan(0);
    // The two finer grids read their tile heights; the coarse one has the atlas alone.
    expect(shadow.stats.sourceRows).toBe(2 * SHADOW_SIZE);

    // Nothing moves: nothing is baked.
    for (let f = 0; f < 30; f++) expect(frame(eye, sun)).toBe(0);
    expect(shadow.stats.bakes).toBe(3);

    // The camera moves by less than three quarters of a snap: still nothing.
    const spacing = ((Math.PI / 2) * R) / latticeSize(SHADOW_TILE_LEVELS[0]);
    const nudge = point(0.6 * SHADOW_SNAP * spacing, 0, 1000);
    for (let f = 0; f < 5; f++) expect(frame(nudge, sun)).toBe(0);

    // One snap further on, the near grid alone is baked again, its window a snap along.
    const before = shadow.origin(0)!;
    const moved = point(1.2 * SHADOW_SNAP * spacing, 0, 1000);
    settle(moved, sun);
    expect(shadow.stats.bakes).toBe(4);
    expect(shadow.origin(0)![0] - before[0]).toBe(SHADOW_SNAP);
    expect(shadow.origin(0)![1]).toBe(before[1]);
    expect(shadow.stats.passes).toBe(4 * PASSES_PER_GRID);
    expect(shadow.stats.sourceRows).toBe(3 * SHADOW_SIZE);

    // The sun sets at the real rate (15° per hour): nothing is baked until it has moved by
    // the threshold, then all three grids are, still one pass per frame.
    const rate = (15 * DEG) / 3600 / 60;
    let frames = 0;
    let quiet = 0;
    while (shadow.stats.bakes < 7 && frames < 3000) {
      const passes = frame(moved, sunAt(elevation - rate * ++frames));
      expect(passes).toBeLessThanOrEqual(1);
      if (shadow.stats.bakes === 4 && passes === 0) quiet++;
    }
    expect(shadow.stats.bakes).toBe(7);
    // A new sun over the same windows and tiles: compute passes alone, no heights read.
    expect(shadow.stats.sourceRows).toBe(3 * SHADOW_SIZE);
    // About fifteen seconds at 6° of elevation (0.063° at 15° per hour).
    expect(quiet).toBeGreaterThan(0.9 * (bakeAngle(elevation) / rate));
    expect(frames).toBeLessThan(2.5 * (bakeAngle(elevation) / rate));

    // A high sun: no passes, no shadow.
    const noon = sunAt(60 * DEG);
    for (let f = 0; f < 5; f++) expect(frame(moved, noon)).toBe(0);
    expect(shadow.strength.value).toBe(0);
    expect(shadow.busy).toBe(false);
    expect(gpu!.errors).toEqual([]);

    // A fast clock (the sun at 2° per second): several passes per frame, and still a pass budget.
    let s = 0;
    let most = 0;
    for (let f = 0; f < 60; f++) {
      s += (2 * DEG) / 60;
      const n = frame(moved, sunAt(elevation - s + 0.5 * DEG));
      most = Math.max(most, n);
      expect(n).toBeLessThanOrEqual(4);
    }
    expect(most).toBeGreaterThan(1);
    expect(shadow.strength.value).toBe(1);

    // A clock the bake cannot follow (the sun at 60° per second): the shadows go, and the bake stops.
    for (let f = 0; f < 90; f++) frame(moved, sunAt(elevation + 0.5 * DEG - (f % 3) * DEG));
    expect(shadow.strength.value).toBe(0);
    expect(shadow.busy).toBe(false);
    expect(frame(moved, sunAt(elevation - 0.5 * DEG))).toBe(0);
    // From orbit there is nothing to see of them either.
    shadow.reset();
    for (let f = 0; f < 5; f++) expect(frame(center.clone().scale(R + 400_000), sun)).toBe(0);
    expect(shadow.strength.value).toBe(0);
    expect(gpu!.errors).toEqual([]);
    shadow.dispose();
    head.dispose();
  }, 240_000);
});
