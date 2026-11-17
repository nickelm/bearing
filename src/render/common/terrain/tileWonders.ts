/**
 * The war's natural wonders as the tile kernel shapes them (decision 221): the
 * selected wonder features (`cast.wonders`), sited on the eroded ground
 * (`siteWonders`), for `TileSynthOptions.wonders` and the observer's stations.
 */
import { directionToCubeFace } from '../../../core/coords';
import type { CubeFaceUv } from '../../../core/coords';
import { Vec3d } from '../../../core/vec3d';
import type { Cast } from '../../../campaign/cast';
import { siteWonders, WONDER_MAX_UNEVEN } from '../../../worldgen/edits';
import type { SitedWonder } from '../../../worldgen/edits';
import type { TileWonder } from '../../../worldgen/gpu/tileSynth';
import { FeatureKind } from '../../../worldgen/strategic/graph';
import type { StrategicGraph } from '../../../worldgen/strategic/graph';

export function sitedWonders(
  graph: StrategicGraph,
  cast: Cast | null,
  radius: number,
  heightAt: (d: Readonly<Vec3d>) => number,
  wetAt: ((d: Readonly<Vec3d>) => boolean) | null = null,
): SitedWonder[] {
  const f = graph.features;
  const ids = (cast?.wonders ?? []).filter((i) => f.kind[i] === FeatureKind.Wonder);
  return siteWonders(
    ids,
    (i) => f.measure[i]!,
    (i) => new Vec3d(f.anchor[3 * i]!, f.anchor[3 * i + 1]!, f.anchor[3 * i + 2]!),
    radius,
    heightAt,
    wetAt,
  );
}

/** The shapes for the tiles: sited wonders on even enough ground (NaN: no site found). */
export function tileWonders(sited: readonly SitedWonder[]): TileWonder[] {
  return sited
    .filter((w) => w.uneven <= WONDER_MAX_UNEVEN)
    .map((w) => ({ dir: w.dir, kind: w.kind, base: w.base }));
}

/** Lakes, salt lakes and playas of the eroded grid, which no land wonder stands in. */
export function wonderWet(global: {
  n: number;
  finish: { drainage: { lakeDepth: Float32Array; basinCell?: Uint8Array } };
}): (d: Readonly<Vec3d>) => boolean {
  const n = global.n;
  const { lakeDepth, basinCell } = global.finish.drainage;
  const uv: CubeFaceUv = { face: 0, u: 0, v: 0 };
  return (d) => {
    directionToCubeFace(d, uv);
    const i = Math.min(n - 1, Math.max(0, Math.floor(uv.u * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(uv.v * n)));
    const c = (uv.face * n + j) * n + i;
    return lakeDepth[c]! > 0 || (basinCell?.[c] ?? 0) !== 0;
  };
}
