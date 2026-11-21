/**
 * Rock dressing in the simulation view (Proposal 0010, decision 299): the pieces of
 * `worldgen/rockDressing.ts`, placed per level-7 data tile and drawn by the landform
 * props' instancing (`PropLayer` with the dressing's kinds, ranges and placer).
 *
 * - **Sites.** Height, slope, the slope a cell uphill and the fine curvature from the
 *   tile's samples (the exaggerated surface, decision 297); rock, province and biome
 *   from the global grid; water, towns, roads and airfields keep pieces off.
 * - **Pose.** Slabs, ledges and scree lie on the ground, their up the surface's normal;
 *   towers, teeth and boulders stand up the vertical. Every piece sinks below the
 *   lowest ground under its footprint by `DRESSING_TUNING.sink` of its size.
 * - **Collision.** Pieces larger than 20 m are columns in the tile's obstacles
 *   (`obstacleAt`), as the props are.
 * - **Cost.** The quality tier sets the density (placement) and the two ranges
 *   (TerrainArtSettings.rocks); quality `off` hides the layer.
 */
import { cubeFaceUvToDirection, directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import { TILE_BORDER, TILE_STRIDE, TILE_TEXELS } from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import type { TileData } from '../../../worldgen/gpu/tileSynth';
import { NO_LAKE } from '../../../worldgen/gpu/tileSynth';
import {
  DRESSING_KINDS,
  DRESSING_SIZE,
  DRESSING_STRIDE,
  DRESSING_TUNING,
  dressingCollider,
  dressingInCell,
  dressingSeed,
} from '../../../worldgen/rockDressing';
import type { DressingSite } from '../../../worldgen/rockDressing';
import type { PlacedTile, PropWorldMaps, TileLayerOptions } from './propLayer';

/** Floats per obstacle: axis (3), foot, top, radius (as PropLayer's). */
const OBSTACLE_FLOATS = 6;

/** Places the dressing of a level-7 data tile at `density` (1 = the tuning's). Pure: no GPU. */
export function placeDressingTile(
  data: TileData,
  maps: PropWorldMaps,
  seed: number,
  radius: number,
  clear: ((d: Readonly<Vec3d>, extra?: number) => boolean) | undefined,
  density = 1,
): PlacedTile {
  const t = data.key;
  const size = TILE_TEXELS * (1 << t.level);
  const sampleM = ((Math.PI / 2) * radius) / size;
  const n = maps.n;
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const cellOf = (d: Readonly<Vec3d>) => {
    directionToCubeFace(d, uv);
    const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
    return (uv.face * n + j) * n + i;
  };
  const clampS = (s: number) => Math.min(TILE_TEXELS + TILE_BORDER - 1, Math.max(-TILE_BORDER, s));
  const idx = (sx: number, sy: number) =>
    (clampS(sy) + TILE_BORDER) * TILE_STRIDE + clampS(sx) + TILE_BORDER;
  const hAt = (sx: number, sy: number) => data.height[idx(Math.round(sx), Math.round(sy))]!;
  const dirAt = (sx: number, sy: number, out: Vec3d) =>
    cubeFaceUvToDirection(
      t.face,
      (t.x * TILE_TEXELS + sx) / size,
      (t.y * TILE_TEXELS + sy) / size,
      out,
    );
  const origin = dirAt(TILE_TEXELS / 2, TILE_TEXELS / 2, new Vec3d()).scale(radius);
  const S = DRESSING_STRIDE;
  const cells = TILE_TEXELS / S;
  const gx0 = (t.x * TILE_TEXELS) / S;
  const gy0 = (t.y * TILE_TEXELS) / S;
  const lists = new Map<string, number[]>();
  const cellIndex = new Int32Array(cells * cells).fill(-1);
  const obstacles: number[] = [];
  const d = new Vec3d();
  const a = new Vec3d();
  const b = new Vec3d();
  const tu = new Vec3d();
  const tv = new Vec3d();
  const nrm = new Vec3d();
  const slopeAt = (sx: number, sy: number) => {
    const dx = (hAt(sx + 1, sy) - hAt(sx - 1, sy)) / (2 * sampleM);
    const dy = (hAt(sx, sy + 1) - hAt(sx, sy - 1)) / (2 * sampleM);
    return [dx, dy] as const;
  };
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const sx = cx * S + S / 2;
      const sy = cy * S + S / 2;
      const o = idx(sx, sy);
      const h = data.height[o]!;
      if (h <= 0) continue;
      const lake = data.lake[o]!;
      const mat = data.material[o]!;
      const [dx, dy] = slopeAt(sx, sy);
      const slope = Math.hypot(dx, dy);
      // The drop from the mean of the ground two samples around, per meter: negative on crests.
      const mean = (hAt(sx + 2, sy) + hAt(sx - 2, sy) + hAt(sx, sy + 2) + hAt(sx, sy - 2)) / 4;
      const curvature = (mean - h) / (2 * sampleM);
      // The steepest ground a cell uphill: feet of cliffs gather scree.
      let upslope = 0;
      if (slope > 1e-3) {
        const [ux, uy] = slopeAt(
          sx + Math.round((S * dx) / slope),
          sy + Math.round((S * dy) / slope),
        );
        upslope = Math.hypot(ux, uy);
      }
      dirAt(sx, sy, d);
      const c = cellOf(d);
      const site: DressingSite = {
        height: h,
        slope,
        upslope,
        curvature,
        lithology: maps.lithology[c]!,
        province: maps.province[c]!,
        biome: maps.biome[c]!,
        blocked: (lake > NO_LAKE / 2 && h < lake + 2) || ((mat >>> 8) & 0xff) > 0,
      };
      const item = dressingInCell(
        seed,
        t.face,
        gx0 + cx,
        gy0 + cy,
        site,
        density * DRESSING_TUNING.density,
      );
      if (!item) continue;
      const spec = DRESSING_SIZE[item.kind];
      const extent = spec.size * item.scale;
      const px = cx * S + item.fx * S;
      const py = cy * S + item.fy * S;
      dirAt(px, py, d);
      if (clear && clear(d, extent / 2)) continue;
      // Upright pieces stand on the lowest ground under their footprint, sunk below it;
      // pieces laid on the face sit on the ground at their spot (bilinear), sunk a little:
      // on a steep wall the footprint's lowest point would bury them.
      let ground: number;
      if (spec.pose === 'upright') {
        const r = Math.max(1, Math.round(extent / 3 / sampleM));
        let low = Infinity;
        for (const [ox, oy] of [
          [0, 0],
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
        ])
          low = Math.min(low, hAt(px + ox!, py + oy!));
        ground = low - DRESSING_TUNING.sink * extent;
      } else {
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const tx = px - x0;
        const ty = py - y0;
        const at = (x: number, y: number) => data.height[idx(x, y)]!;
        const h0 = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty);
        const h1 = (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
        ground = h0 + h1 - 0.04 * extent;
      }
      // Up: the vertical, or the surface's normal for pieces that lie on the ground.
      if (spec.pose === 'face') {
        dirAt(px + 1, py, a);
        dirAt(px - 1, py, b);
        tu.copy(a).sub(b).normalize();
        dirAt(px, py + 1, a);
        dirAt(px, py - 1, b);
        tv.copy(a).sub(b).normalize();
        const [gx, gy] = slopeAt(Math.round(px), Math.round(py));
        nrm.copy(d).addScaled(tu, -gx).addScaled(tv, -gy).normalize();
      } else {
        nrm.copy(d);
      }
      let l = lists.get(item.kind);
      if (!l) lists.set(item.kind, (l = []));
      const base = d.clone().scale(radius).sub(origin);
      l.push(base.x, base.y, base.z, d.x * ground, d.y * ground, d.z * ground);
      l.push(nrm.x, nrm.y, nrm.z, item.scale, item.yaw, item.shade);
      const collide = dressingCollider(item);
      if (collide !== null) {
        cellIndex[cy * cells + cx] = obstacles.length / OBSTACLE_FLOATS;
        obstacles.push(d.x, d.y, d.z, ground, ground + extent, collide);
      }
    }
  }
  const out = new Map<string, Float32Array>();
  for (const [k, v] of lists) out.set(k, Float32Array.from(v));
  return {
    origin,
    lists: out,
    obstacles: { cells: cellIndex, items: Float64Array.from(obstacles) },
  };
}

/** The dressing layer's options; `density()` is read at each placement (the quality tier's). */
export function rockDressingLayer(density: () => number): TileLayerOptions {
  return {
    kinds: DRESSING_KINDS,
    near: 1500,
    far: 5000,
    ceiling: 6000,
    stride: DRESSING_STRIDE,
    seedOf: dressingSeed,
    place: (data, maps, seed, radius, clear) =>
      placeDressingTile(data, maps, seed, radius, clear, density()),
  };
}
