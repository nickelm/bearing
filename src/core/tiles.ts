/**
 * Tile keys: a quadtree on each cube face (decision 13).
 *
 * A tile (face, level, x, y) covers face coordinates
 * u ∈ [x / 2^level, (x+1) / 2^level] and v ∈ [y / 2^level, (y+1) / 2^level].
 * Level 0 is a whole face. Every tile holds TILE_TEXELS² texels plus a border
 * of TILE_BORDER texels on each side, so that filtering and normals near a
 * tile edge never need the neighbor tile.
 *
 * Texel coordinates (tx, ty) run from −TILE_BORDER to TILE_TEXELS + TILE_BORDER − 1.
 * Texel (tx, ty) is centered at ((tx + 0.5) / TILE_TEXELS) across the tile.
 * Border texels may lie on a neighboring face; their direction is still
 * well defined, because the equi-angular warp extends past the face edge.
 *
 * At R = 1,000 km, level 4 gives about 380 m per texel and level 7 about 48 m.
 */
import { CUBE_FACE_COUNT, cubeFaceUvToDirection, directionToCubeFace } from './coords';
import type { CubeFace, CubeFaceUv } from './coords';
import type { Meters } from './units';
import { Vec3d } from './vec3d';

export const TILE_TEXELS = 256;
export const TILE_BORDER = 2;
/** Deepest supported level (about 6 m texels at R = 1,000 km). */
export const MAX_TILE_LEVEL = 10;

export interface TileKey {
  readonly face: CubeFace;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

export function tileKey(face: CubeFace, level: number, x: number, y: number): TileKey {
  const size = 1 << level;
  if (face < 0 || face >= CUBE_FACE_COUNT || !Number.isInteger(face)) {
    throw new RangeError(`Bad face ${face}`);
  }
  if (!Number.isInteger(level) || level < 0 || level > MAX_TILE_LEVEL) {
    throw new RangeError(`Bad level ${level}`);
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
    throw new RangeError(`Tile (${x}, ${y}) outside level ${level}`);
  }
  return { face, level, x, y };
}

/** Canonical string form "face/level/x/y", used for cache keys and RNG stream paths. */
export function tileKeyString(k: TileKey): string {
  return `${k.face}/${k.level}/${k.x}/${k.y}`;
}

export function parseTileKey(s: string): TileKey {
  const parts = s.split('/').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) {
    throw new RangeError(`Bad tile key "${s}"`);
  }
  return tileKey(parts[0] as CubeFace, parts[1]!, parts[2]!, parts[3]!);
}

export function tileEquals(a: TileKey, b: TileKey): boolean {
  return a.face === b.face && a.level === b.level && a.x === b.x && a.y === b.y;
}

export function parentTile(k: TileKey): TileKey | null {
  if (k.level === 0) return null;
  return { face: k.face, level: k.level - 1, x: k.x >> 1, y: k.y >> 1 };
}

/** The four children in order (0,0), (1,0), (0,1), (1,1). */
export function childTiles(k: TileKey): TileKey[] {
  const l = k.level + 1;
  if (l > MAX_TILE_LEVEL) return [];
  const x = k.x * 2;
  const y = k.y * 2;
  return [
    { face: k.face, level: l, x, y },
    { face: k.face, level: l, x: x + 1, y },
    { face: k.face, level: l, x, y: y + 1 },
    { face: k.face, level: l, x: x + 1, y: y + 1 },
  ];
}

/** Face-coordinate bounds of a tile: [u0, v0, u1, v1]. */
export function tileUvBounds(k: TileKey): [number, number, number, number] {
  const s = 1 / (1 << k.level);
  return [k.x * s, k.y * s, (k.x + 1) * s, (k.y + 1) * s];
}

/** Face (u, v) of a texel center. tx and ty may be in the border range. */
export function tileTexelUv(k: TileKey, tx: number, ty: number): [number, number] {
  const s = 1 / (1 << k.level);
  return [(k.x + (tx + 0.5) / TILE_TEXELS) * s, (k.y + (ty + 0.5) / TILE_TEXELS) * s];
}

/** Unit direction of a texel center, including border texels that lie on a neighboring face. */
export function tileTexelDirection(k: TileKey, tx: number, ty: number, out = new Vec3d()): Vec3d {
  const [u, v] = tileTexelUv(k, tx, ty);
  return cubeFaceUvToDirection(k.face, u, v, out);
}

const uvScratch: CubeFaceUv = { face: 0, u: 0, v: 0 };
const dirScratch = new Vec3d();

/** The tile at `level` containing a direction. */
export function tileForDirection(d: Readonly<Vec3d>, level: number): TileKey {
  const uv = directionToCubeFace(d, uvScratch);
  const size = 1 << level;
  const x = Math.min(size - 1, Math.max(0, Math.floor(uv.u * size)));
  const y = Math.min(size - 1, Math.max(0, Math.floor(uv.v * size)));
  return { face: uv.face, level, x, y };
}

/**
 * The same-level tile adjacent across one edge: dx, dy ∈ {−1, 0, 1}, not both 0.
 * Crosses face seams. Diagonal steps past a cube corner return one of the
 * edge-adjacent tiles, since no true diagonal exists there.
 */
export function neighborTile(k: TileKey, dx: number, dy: number): TileKey {
  const size = 1 << k.level;
  const x = k.x + dx;
  const y = k.y + dy;
  if (x >= 0 && y >= 0 && x < size && y < size) return { face: k.face, level: k.level, x, y };
  cubeFaceUvToDirection(k.face, (x + 0.5) / size, (y + 0.5) / size, dirScratch);
  return tileForDirection(dirScratch, k.level);
}

/** Approximate texel size at the center of a face, at the given level and planet radius. */
export function texelSizeAtLevel(level: number, radius: Meters): Meters {
  // A face spans π/2 of arc; equi-angular texels are nearly uniform.
  return ((Math.PI / 2) * radius) / (TILE_TEXELS * (1 << level));
}
