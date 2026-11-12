/**
 * Tile memory for the simulation view's terrain (decision 119): sizes of a
 * cached data tile and mesh, the default budget, and the working set of a
 * selection. Pure TypeScript, so tests can check the budget against the
 * bounded radius (decision 116).
 */
import { parentTile, tileKeyString, TILE_STRIDE } from '../../../core/tiles';
import type { TileKey } from '../../../core/tiles';
import { MAX_BAKED_LEVEL } from '../../../worldgen/gpu/tileSynth';
import { dataTileFor, TILE_VERTEX_COUNT } from './tileMesh';
import type { LodSelection } from './quadtree';

/** CPU tile data: heights and materials, eight bytes per sample. */
export const DATA_TILE_BYTES = TILE_STRIDE * TILE_STRIDE * 8;
/** base, up, parentBase, parentDisp, slope, color, landform (vec3) + surface (vec4), float32. */
export const MESH_TILE_BYTES = TILE_VERTEX_COUNT * (7 * 3 + 4) * 4;
/**
 * Share of the tile memory budget for CPU tile data; the rest holds meshes.
 * Low views draw about 400 meshes plus their fallback parents, against about
 * 200 data tiles (deeper meshes share a level-7 data tile).
 */
export const DATA_SHARE = 0.45;
/** Default tile memory (MiB; GUI → View → Terrain tiles → Tile memory). */
export const DEFAULT_TILE_MEMORY_MIB = 600;

export interface WorkingSet {
  meshes: number;
  data: number;
  bytes: number;
}

/**
 * Meshes and data tiles a selection holds: the drawn and kept meshes, the data
 * each reads (itself or its level-7 ancestor) and the parent data its morph
 * target needs, plus any `extraData` (the prefetched bubble).
 */
export function workingSet(sel: LodSelection, extraData: readonly TileKey[] = []): WorkingSet {
  const meshes = new Set<string>();
  const data = new Set<string>();
  const add = (t: TileKey) => {
    meshes.add(tileKeyString(t));
    data.add(tileKeyString(dataTileFor(t)));
    if (t.level > 0 && t.level <= MAX_BAKED_LEVEL) data.add(tileKeyString(parentTile(t)!));
  };
  for (const d of sel.draw) add(d.tile);
  for (const k of sel.keep) add(k);
  for (const t of extraData) data.add(tileKeyString(t));
  return {
    meshes: meshes.size,
    data: data.size,
    bytes: meshes.size * MESH_TILE_BYTES + data.size * DATA_TILE_BYTES,
  };
}
