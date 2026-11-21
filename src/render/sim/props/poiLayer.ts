/**
 * Points of interest in the simulation view (Proposal 0010, decision 302): the
 * structures of `worldgen/poi/poi.ts` and the pylons of their power lines, drawn by the
 * landform props' instancing (`PropLayer` with this placer). Each stands on the lowest
 * ground under its footprint in its level-7 data tile, turned to face its view, the sea
 * or across its river; large ones collide.
 */
import { cubeFaceUvToDirection, directionToCubeFace } from '../../../core/coords';
import type { CubeFace, CubeFaceUv } from '../../../core/coords';
import {
  tileForDirection,
  tileKeyString,
  TILE_BORDER,
  TILE_STRIDE,
  TILE_TEXELS,
} from '../../../core/tiles';
import { Vec3d } from '../../../core/vec3d';
import { MAX_BAKED_LEVEL } from '../../../worldgen/gpu/tileSynth';
import type { TileData } from '../../../worldgen/gpu/tileSynth';
import type { PoiKind, PointOfInterest } from '../../../worldgen/poi/poi';
import type { PlacedTile, TileLayerOptions } from './propLayer';

/** The model of each type (power lines draw pylons). */
export const POI_MODEL: Readonly<Record<PoiKind, string>> = {
  'radar-station': 'poi-radar-station',
  'early-warning-radar': 'poi-early-warning-radar',
  'relay-tower': 'poi-relay-tower',
  'bunker-complex': 'poi-bunker-complex',
  'coastal-battery': 'poi-coastal-battery',
  'observation-post': 'poi-observation-post',
  dam: 'poi-dam',
  lighthouse: 'poi-lighthouse',
  observatory: 'poi-observatory',
  quarry: 'poi-quarry',
  'oil-field': 'poi-oil-field',
  'power-line': 'poi-pylon',
};
export const POI_MODELS = [...new Set(Object.values(POI_MODEL))];

/** Height (m) and footprint radius (m) of each model at scale 1. */
const SIZE: Readonly<Record<string, [number, number]>> = {
  'poi-radar-station': [24, 12],
  'poi-early-warning-radar': [25, 20],
  'poi-relay-tower': [61, 6],
  'poi-bunker-complex': [5, 20],
  'poi-coastal-battery': [4, 18],
  'poi-observation-post': [14, 6],
  'poi-dam': [64, 52],
  'poi-lighthouse': [34, 6],
  'poi-observatory': [16, 10],
  'poi-quarry': [8, 32],
  'poi-oil-field': [23, 16],
  'poi-pylon': [35, 8],
};
/** Level-7 samples per obstacle cell (as the props'). */
const STRIDE = 4;

/** The instance frame's first tangent at `up`, as the props' shader builds it. */
function frameYaw(up: Readonly<Vec3d>, forward: Readonly<Vec3d>): number {
  const t0 = up
    .clone()
    .cross(new Vec3d(0.0001, 1, 0.0002))
    .normalize();
  const t1 = up.clone().cross(t0);
  return Math.atan2(forward.dot(t1), forward.dot(t0));
}

export interface PoiItem {
  model: string;
  dir: Vec3d;
  /** Model +x along this tangent direction. */
  forward: Vec3d;
  scale: number;
}

/** Items by level-7 tile: each structure, and every pylon of the power lines. */
export function poiItems(pois: readonly PointOfInterest[]): Map<string, PoiItem[]> {
  const byTile = new Map<string, PoiItem[]>();
  const add = (it: PoiItem) => {
    const k = tileKeyString(tileForDirection(it.dir, MAX_BAKED_LEVEL));
    let l = byTile.get(k);
    if (!l) byTile.set(k, (l = []));
    l.push(it);
  };
  for (const p of pois) {
    const dir = new Vec3d(...p.dir);
    const east = new Vec3d(0, 1, 0).cross(dir).normalize();
    const north = dir.clone().cross(east);
    // Facing: a compass heading → a tangent direction.
    const face = north.clone().scale(Math.cos(p.facing)).addScaled(east, Math.sin(p.facing));
    if (p.kind === 'power-line' && p.path) {
      for (let i = 0; i < p.path.length; i++) {
        const a = new Vec3d(...p.path[Math.max(0, i - 1)]!);
        const b = new Vec3d(...p.path[Math.min(p.path.length - 1, i + 1)]!);
        const d = new Vec3d(...p.path[i]!);
        const along = b.sub(a);
        along.addScaled(d, -along.dot(d)).normalize();
        add({ model: 'poi-pylon', dir: d, forward: along, scale: 1 });
      }
      continue;
    }
    // A dam's wall (model +x) spans across the flow: the facing is downstream.
    const forward = p.kind === 'dam' ? face.clone().cross(dir).normalize() : face;
    add({ model: POI_MODEL[p.kind], dir, forward, scale: p.kind === 'dam' ? 1.5 : 1 });
  }
  return byTile;
}

/** Places the items in a level-7 data tile: on its lowest ground under each footprint. */
export function placePoiTile(
  data: TileData,
  items: readonly PoiItem[],
  radius: number,
): PlacedTile {
  const t = data.key;
  const size = TILE_TEXELS * (1 << t.level);
  const sampleM = ((Math.PI / 2) * radius) / size;
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  const clampS = (s: number) =>
    Math.min(TILE_TEXELS + TILE_BORDER - 1, Math.max(-TILE_BORDER, Math.round(s)));
  const hAt = (sx: number, sy: number) =>
    data.height[(clampS(sy) + TILE_BORDER) * TILE_STRIDE + clampS(sx) + TILE_BORDER]!;
  // The tile's center as the origin.
  const origin = cubeFaceUvToDirection(
    t.face as CubeFace,
    (t.x * TILE_TEXELS + TILE_TEXELS / 2) / size,
    (t.y * TILE_TEXELS + TILE_TEXELS / 2) / size,
    new Vec3d(),
  ).scale(radius);
  const lists = new Map<string, number[]>();
  const cells = TILE_TEXELS / STRIDE;
  const cellIndex = new Int32Array(cells * cells).fill(-1);
  const obstacles: number[] = [];
  for (const it of items) {
    directionToCubeFace(it.dir, uv);
    const sx = uv.u * size - t.x * TILE_TEXELS;
    const sy = uv.v * size - t.y * TILE_TEXELS;
    const [height, foot] = SIZE[it.model] ?? [20, 10];
    const r = Math.max(1, Math.round((foot * it.scale) / sampleM));
    let low = Infinity;
    for (const [ox, oy] of [
      [0, 0],
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ])
      low = Math.min(low, hAt(sx + ox!, sy + oy!));
    // Lighthouses on rocks at the shore stand at least at the sea's level.
    const ground = Math.max(low, 0) - 1;
    let l = lists.get(it.model);
    if (!l) lists.set(it.model, (l = []));
    const d = it.dir;
    const base = d.clone().scale(radius).sub(origin);
    l.push(base.x, base.y, base.z, d.x * ground, d.y * ground, d.z * ground, d.x, d.y, d.z);
    l.push(it.scale, frameYaw(d, it.forward), 1);
    const cx = Math.min(cells - 1, Math.max(0, Math.floor(sx / STRIDE)));
    const cy = Math.min(cells - 1, Math.max(0, Math.floor(sy / STRIDE)));
    cellIndex[cy * cells + cx] = obstacles.length / 6;
    obstacles.push(d.x, d.y, d.z, ground, ground + height * it.scale, foot * it.scale);
  }
  const out = new Map<string, Float32Array>();
  for (const [k, v] of lists) out.set(k, Float32Array.from(v));
  return {
    origin,
    lists: out,
    obstacles: { cells: cellIndex, items: Float64Array.from(obstacles) },
  };
}

/** The layer's options over a list the scene sets (`items()`). */
export function poiLayer(items: () => Map<string, PoiItem[]>): TileLayerOptions {
  return {
    kinds: POI_MODELS,
    near: 3000,
    far: 16_000,
    ceiling: 20_000,
    stride: STRIDE,
    seedOf: () => 0,
    place: (data, _maps, _seed, radius) =>
      placePoiTile(data, items().get(tileKeyString(data.key)) ?? [], radius),
  };
}
