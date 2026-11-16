/**
 * Alignment worker (decision 184): aligns one link of the network tier at a
 * time over the level-6 tile heights sent with it, and transfers the result.
 */
import { alignLink } from '../worldgen/networks/link';
import type { AlignedLink, LinkTask } from '../worldgen/networks/link';
import { tileHeightSampler } from '../worldgen/networks/tileHeights';

export interface AlignRequest {
  id: number;
  task: LinkTask;
  radius: number;
  tiles: [string, Float32Array][];
}
export type AlignResponse =
  { id: number; link: AlignedLink; missing: number } | { id: number; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AlignRequest>) => void) | null;
  postMessage(message: AlignResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, task, radius, tiles } = e.data;
  try {
    const ground = tileHeightSampler(new Map(tiles));
    const link = alignLink(task, ground.height, radius);
    ctx.postMessage({ id, link, missing: ground.missing() }, [
      link.points.buffer,
      link.design.buffer,
      link.ground.buffer,
      link.structure.buffer,
      link.cls.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
};
