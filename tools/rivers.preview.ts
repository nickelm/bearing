/**
 * River beds along their channels (decision 146): synthesizes level-7 tiles under
 * a set of rivers and walks each channel's centerline downstream, reading the
 * terrain under it. Water that has to climb shows as a hump: the bed rising above
 * the lowest point upstream of it. Prints, per river and in total, the share of
 * the channel that lies more than 2 m above that running minimum and the largest
 * hump, so a change to river carving can be compared before and after.
 *
 *   npx vitest run --config vitest.tools.config.ts tools/rivers.preview.ts
 *
 * Env: GRES (global grid, default 1024), COUNT (rivers, default 24), KM (length of
 * each river walked, default 12), MIN_DROP (m over the polyline, default 80).
 */
import { it } from 'vitest';
import { directionToCubeFace } from '../src/core/coords';
import {
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
  tileForDirection,
  tileKeyString,
} from '../src/core/tiles';
import type { TileKey } from '../src/core/tiles';
import { Vec3d } from '../src/core/vec3d';
import type { TileData } from '../src/worldgen/gpu/tileSynth';
import { TileSynthesizer } from '../src/worldgen/gpu/tileSynth';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { testGpu } from '../tests/gpu/device';
import { previewWorld } from './previewWorld';

const env = process.env;
const LEVEL = 7;

it('walks river beds', async () => {
  const gpu = await testGpu();
  if (!gpu) throw new Error('No WebGPU adapter (Dawn) available');
  const params = DEFAULT_PLANET_PARAMS;
  const R = params.radius;
  const { global } = await previewWorld(gpu, params, 256, Number(env.GRES ?? 1024));
  const rivers = global.finish.rivers;
  const index = new RiverIndex(rivers, {
    height: global.height,
    radius: R,
    lakeDepth: global.finish.drainage.lakeDepth,
  });
  const synth = new TileSynthesizer(global.grid, {
    seed: params.seed,
    reliefScale: params.reliefScale,
    radius: R,
    biome: global.finish.biome,
    lakeDepth: global.finish.drainage.lakeDepth,
    height: global.height,
    forest: global.finish.forest,
    treeline: global.finish.treeline,
    index,
  });

  // Rivers with relief: the largest drops over their polylines, 20 m wide or more.
  const lake = global.finish.drainage.lakeDepth;
  const cands: { k: number; drop: number }[] = [];
  for (let k = 0; k < rivers.count; k++) {
    const a = rivers.offsets[k]!;
    const b = rivers.offsets[k + 1]! - 1;
    if (b - a < 6 || rivers.width[a]! < 20) continue;
    let wet = false;
    for (let p = a; p <= b; p++) if (lake[rivers.cells[p]!]! > 0) wet = true;
    if (wet) continue;
    const drop = global.height[rivers.cells[a]!]! - global.height[rivers.cells[b]!]!;
    if (drop > Number(env.MIN_DROP ?? 80)) cands.push({ k, drop });
  }
  cands.sort((x, y) => y.drop - x.drop);
  // Spread the picks over the list: steep canyons and gentler hill rivers.
  const count = Math.min(Number(env.COUNT ?? 24), cands.length);
  const picks = Array.from(
    { length: count },
    (_, i) => cands[Math.floor((i * cands.length) / count)]!,
  );

  // Centerline points every 25 m along the original cell path, smoothed like the index
  // would not matter here: the channel follows the index's segments, so walk those.
  const seg = index.segments.data;
  const F = (index.segments as { fields?: number }).fields ?? 8;
  // Map each pick to its run of index segments by matching the polyline's first point.
  const paths: Vec3d[][] = [];
  const maxLen = Number(env.KM ?? 12) * 1000;
  for (const { k } of picks) {
    const o = rivers.offsets[k]! * 3;
    const first = new Vec3d(rivers.points[o]!, rivers.points[o + 1]!, rivers.points[o + 2]!);
    let s0 = -1;
    for (let s = 0; s < index.segments.count; s++) {
      const dx = seg[s * F]! - first.x;
      const dy = seg[s * F + 1]! - first.y;
      const dz = seg[s * F + 2]! - first.z;
      if (dx * dx + dy * dy + dz * dz < 1e-20) {
        s0 = s;
        break;
      }
    }
    const pts: Vec3d[] = [];
    let len = 0;
    for (let s = s0; s >= 0 && s < index.segments.count && len < maxLen; s++) {
      const a = new Vec3d(seg[s * F]!, seg[s * F + 1]!, seg[s * F + 2]!);
      const b = new Vec3d(seg[s * F + 3]!, seg[s * F + 4]!, seg[s * F + 5]!);
      if (s > s0) {
        const prevB = new Vec3d(
          seg[(s - 1) * F + 3]!,
          seg[(s - 1) * F + 4]!,
          seg[(s - 1) * F + 5]!,
        );
        if (prevB.distanceTo(a) > 1e-9) break;
      }
      const L = Math.acos(Math.min(1, a.dot(b))) * R;
      const steps = Math.max(1, Math.ceil(L / 25));
      for (let i = 0; i < steps; i++) {
        const f = i / steps;
        pts.push(
          new Vec3d(
            a.x + (b.x - a.x) * f,
            a.y + (b.y - a.y) * f,
            a.z + (b.z - a.z) * f,
          ).normalize(),
        );
      }
      len += L;
    }
    paths.push(pts);
  }

  // Tiles under every path.
  const keys = new Map<string, TileKey>();
  for (const p of paths)
    for (const d of p) {
      const t = tileForDirection(d, LEVEL);
      keys.set(tileKeyString(t), t);
    }
  const tiles = new Map<string, TileData>();
  const list = [...keys.values()];
  console.log(`${picks.length} rivers, ${list.length} tiles`);
  for (let i = 0; i < list.length; i += 16) {
    for (const t of await synth.generate(list.slice(i, i + 16))) tiles.set(tileKeyString(t.key), t);
  }
  const heightAt = (d: Readonly<Vec3d>): number => {
    const key = tileForDirection(d, LEVEL);
    const t = tiles.get(tileKeyString(key))!;
    const uv = directionToCubeFace(d);
    const size = TILE_TEXELS * (1 << LEVEL);
    const fx = uv.u * size - key.x * TILE_TEXELS + TILE_BORDER;
    const fy = uv.v * size - key.y * TILE_TEXELS + TILE_BORDER;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (x: number, y: number) => t.height[y * TILE_STRIDE + x]!;
    return (
      (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
      (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
    );
  };

  let totalHumped = 0;
  let total = 0;
  let worst = 0;
  let totalRise = 0;
  let totalDrop = 0;
  for (let r = 0; r < paths.length; r++) {
    const bed = paths[r]!.map(heightAt);
    let low = Infinity;
    let humped = 0;
    let hump = 0;
    let rise = 0;
    for (let i = 0; i < bed.length; i++) {
      const h = bed[i]!;
      if (i > 0 && h > bed[i - 1]!) rise += h - bed[i - 1]!;
      low = Math.min(low, h);
      if (h - low > 2) humped++;
      hump = Math.max(hump, h - low);
    }
    const drop = bed[0]! - bed[bed.length - 1]!;
    total += bed.length;
    totalHumped += humped;
    totalRise += rise;
    totalDrop += Math.max(drop, 0);
    worst = Math.max(worst, hump);
    const p = paths[r]![0]!;
    const lat = (Math.asin(p.y) * 180) / Math.PI;
    const lon = (Math.atan2(p.x, p.z) * 180) / Math.PI;
    console.log(
      `river ${picks[r]!.k} at ${lat.toFixed(3)}, ${lon.toFixed(3)}: ${((bed.length * 25) / 1000).toFixed(1)} km, ` +
        `bed ${bed[0]!.toFixed(0)} → ${bed[bed.length - 1]!.toFixed(0)} m, climbs ${rise.toFixed(0)} m, ` +
        `${((100 * humped) / bed.length).toFixed(1)}% humped, largest hump ${hump.toFixed(1)} m`,
    );
  }
  console.log(
    `total: ${((100 * totalHumped) / total).toFixed(2)}% of ${((total * 25) / 1000).toFixed(0)} km humped (>2 m above the lowest bed upstream), ` +
      `largest hump ${worst.toFixed(1)} m, climbs ${totalRise.toFixed(0)} m against ${totalDrop.toFixed(0)} m of drop`,
  );
}, 3_600_000);
