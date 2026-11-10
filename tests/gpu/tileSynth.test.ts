import { describe, expect, it } from 'vitest';
import { cubeFaceUvToDirection, projectToCubeFace } from '../../src/core/coords';
import type { CubeFace } from '../../src/core/coords';
import {
  neighborTile,
  tileForDirection,
  tileKey,
  tileSampleDirection,
  tileSampleIndex,
  TILE_BORDER,
  TILE_TEXELS,
} from '../../src/core/tiles';
import type { TileKey } from '../../src/core/tiles';
import { Vec3d } from '../../src/core/vec3d';
import { finishWorld } from '../../src/worldgen/finishWorld';
import { buildGlobalWorld } from '../../src/worldgen/globalPipeline';
import { NO_LAKE, TileSynthesizer } from '../../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { generateWorld } from '../../src/worldgen/pipeline';
import { RiverIndex } from '../../src/worldgen/riverIndex';
import { testGpu } from './device';

const gpu = await testGpu();

describe.skipIf(!gpu)('tile synthesis (GPU)', async () => {
  const params = { ...DEFAULT_PLANET_PARAMS, erosionStrength: 0.3 };
  const world = generateWorld(params, { resolution: 64 });
  const g = gpu
    ? await buildGlobalWorld(gpu, params, world, {
        n: 256,
        finish: async (input) => finishWorld(input),
      })
    : null;
  const synth = g
    ? new TileSynthesizer(g.grid, {
        seed: params.seed,
        reliefScale: params.reliefScale,
        radius: params.radius,
        biome: g.finish.biome,
        lakeDepth: g.finish.drainage.lakeDepth,
        height: g.height,
        index: new RiverIndex(g.finish.rivers),
      })
    : null;
  // A tile on the main continent.
  const main = new Vec3d(...world.info.mainContinent);

  it('adds octaves with level, none at the global grid resolution', () => {
    expect(synth!.octavesAt(0)).toBe(0);
    expect(synth!.octavesAt(5)).toBeGreaterThan(synth!.octavesAt(3));
    expect(synth!.octavesAt(7)).toBeGreaterThanOrEqual(synth!.octavesAt(6));
  });

  it('is deterministic and independent of batch order', async () => {
    const a = tileForDirection(main, 6);
    const b = neighborTile(a, 1, 0);
    const [a1] = await synth!.generate([a]);
    const [b2, a2] = await synth!.generate([b, a]);
    expect(gpu!.errors).toEqual([]);
    // On a mismatch, report how many samples differ and where, not just "false".
    const diff = (x: ArrayLike<number>, y: ArrayLike<number>) => {
      let count = 0;
      let first = -1;
      let worst = 0;
      for (let i = 0; i < x.length; i++) {
        if (!Object.is(x[i], y[i])) {
          count++;
          if (first < 0) first = i;
          worst = Math.max(worst, Math.abs(x[i]! - y[i]!));
        }
      }
      return count === 0 ? 'identical' : `${count} differ, first at ${first}, worst ${worst}`;
    };
    expect(diff(a1!.height, a2!.height)).toBe('identical');
    expect(diff(a1!.material, a2!.material)).toBe('identical');
    // Shared samples (the edge column and the borders around it) agree bit for bit.
    for (let sy = -TILE_BORDER; sy <= TILE_TEXELS + TILE_BORDER; sy++) {
      for (let s = -TILE_BORDER; s <= TILE_BORDER; s++) {
        expect(a1!.height[tileSampleIndex(TILE_TEXELS + s, sy)]).toBe(
          b2!.height[tileSampleIndex(s, sy)],
        );
      }
    }
    expect(a1!.maxHeight).toBeGreaterThan(a1!.minHeight);
  });

  it('agrees across a cube-face seam to within a few centimeters', async () => {
    // Tiles straddling the +u edge of face 4 at level 5, at several rows.
    let worst = 0;
    for (const y of [3, 11, 20, 28]) {
      const a: TileKey = tileKey(4, 5, 31, y);
      const b = neighborTile(a, 1, 0);
      expect(b.face).not.toBe(4);
      const [ta, tb] = await synth!.generate([a, b]);
      const d = new Vec3d();
      for (let sy = 0; sy <= TILE_TEXELS; sy += 4) {
        tileSampleDirection(a, TILE_TEXELS, sy, d);
        const uv = projectToCubeFace(d, b.face);
        const scale = TILE_TEXELS * (1 << b.level);
        const sx = Math.round(uv.u * scale - b.x * TILE_TEXELS);
        const sy2 = Math.round(uv.v * scale - b.y * TILE_TEXELS);
        if (sy2 < 0 || sy2 > TILE_TEXELS) continue; // the edge runs into another tile of b's face
        const ha = ta!.height[tileSampleIndex(TILE_TEXELS, sy)]!;
        const hb = tb!.height[tileSampleIndex(sx, sy2)]!;
        worst = Math.max(worst, Math.abs(ha - hb));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('cuts channels along rivers', async () => {
    const rivers = g!.finish.rivers;
    // A tile at level 6 under the middle of the longest river.
    let best = 0;
    let len = 0;
    for (let k = 0; k < rivers.count; k++) {
      const n = rivers.offsets[k + 1]! - rivers.offsets[k]!;
      if (n > len) {
        len = n;
        best = k;
      }
    }
    const p = rivers.offsets[best]! + Math.floor(len / 2);
    const dir = new Vec3d(
      rivers.points[p * 3]!,
      rivers.points[p * 3 + 1]!,
      rivers.points[p * 3 + 2]!,
    );
    const [t] = await synth!.generate([tileForDirection(dir, 6)]);
    let inRiver = 0;
    let riverSum = 0;
    let landSum = 0;
    let land = 0;
    for (let i = 0; i < t!.height.length; i++) {
      const cover = (t!.material[i]! >> 8) & 0xff;
      if (t!.height[i]! <= 0) continue;
      land++;
      landSum += t!.height[i]!;
      if (cover > 128) {
        inRiver++;
        riverSum += t!.height[i]!;
      }
    }
    expect(inRiver).toBeGreaterThan(0);
    expect(riverSum / inRiver).toBeLessThan(landSum / land);
  });

  it('floods lakes to their level with a shoreline from the fine terrain', async () => {
    // The deepest lake cell of the global grid.
    const n = g!.n;
    const depth = g!.finish.drainage.lakeDepth;
    let best = -1;
    for (let c = 0; c < depth.length; c++) if (depth[c]! > (best < 0 ? 0 : depth[best]!)) best = c;
    expect(best).toBeGreaterThanOrEqual(0);
    const dir = cubeFaceUvToDirection(
      Math.floor(best / (n * n)) as CubeFace,
      ((best % n) + 0.5) / n,
      ((Math.floor(best / n) % n) + 0.5) / n,
    );
    const [tile] = await synth!.generate([tileForDirection(dir, 6)]);
    let wet = 0;
    let dryNear = 0;
    let level = NO_LAKE;
    for (let i = 0; i < tile!.lake.length; i++) {
      const l = tile!.lake[i]!;
      if (l <= NO_LAKE / 2) continue;
      level = Math.max(level, l);
      if (l > tile!.height[i]!) wet++;
      else dryNear++;
    }
    // Water where the terrain lies below the level, and a dry margin with the level
    // defined, so the shoreline is a zero crossing.
    expect(wet).toBeGreaterThan(10);
    expect(dryNear).toBeGreaterThan(0);
    expect(level).toBeCloseTo(g!.height[best]! + depth[best]!, 3);
  });
});
