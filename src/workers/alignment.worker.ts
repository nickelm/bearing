/**
 * Alignment worker (decision 184): aligns one link of the network tier at a
 * time over the level-6 tile heights sent with it, and transfers the result.
 */
import type { WorldSeed } from '../core/rng';
import { alignLink, groundField } from '../worldgen/networks/link';
import type { AlignedLink, LinkTask } from '../worldgen/networks/link';
import type { TaskRivers } from '../worldgen/networks/riverCrossings';
import { tileHeightSampler } from '../worldgen/networks/tileHeights';
import type { TileGround } from '../worldgen/networks/tileHeights';

export interface AlignRequest {
  id: number;
  task: LinkTask;
  radius: number;
  seed: WorldSeed;
  tiles: [string, TileGround][];
  rivers: TaskRivers | null;
}
export type AlignResponse =
  { id: number; link: AlignedLink; missing: number } | { id: number; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AlignRequest>) => void) | null;
  postMessage(message: AlignResponse, transfer?: Transferable[]): void;
};

let field: { seed: WorldSeed; radius: number; at: ReturnType<typeof groundField> } | null = null;

ctx.onmessage = (e) => {
  const { id, task, radius, seed, tiles, rivers } = e.data;
  try {
    if (!field || field.seed !== seed || field.radius !== radius)
      field = { seed, radius, at: groundField(seed, radius) };
    const ground = tileHeightSampler(new Map(tiles));
    const link = alignLink(
      task,
      {
        height: ground.height,
        cover: ground.cover,
        rivers: rivers ?? undefined,
        field: field.at,
        seed,
      },
      radius,
    );
    ctx.postMessage({ id, link, missing: ground.missing() }, [
      link.points.buffer,
      link.design.buffer,
      link.ground.buffer,
      link.structure.buffer,
      link.cls.buffer,
      link.crossings.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
};
