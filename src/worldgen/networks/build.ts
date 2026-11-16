/**
 * The alignment stage (decision 184): every link of the network tier aligned
 * once, when the world is built, behind a progress bar, and stored with it.
 *
 * The caller supplies the ground (`synthesize`: level-6 tile heights from the
 * terrain's synthesizer on the GPU) and the workers (`run`: a pool in the app,
 * the same code inline in tools and tests). Tasks go out in curve order with
 * a few in flight per worker; their tiles are synthesized just before, kept
 * in a small cache that consecutive tasks share, and copied to the worker
 * with the task. Results are packed in task order, so the record does not
 * depend on which worker finished first.
 */
import { tileKeyString } from '../../core/tiles';
import type { TileKey } from '../../core/tiles';
import type { Alignments } from './alignments';
import { packAlignments } from './alignments';
import type { AlignedLink, LinkTask } from './link';
import type { TaskRivers } from './riverCrossings';
import { taskTiles } from './tileHeights';
import type { TileGround } from './tileHeights';

export class AlignmentCancelled extends Error {
  constructor() {
    super('alignment cancelled');
  }
}

export interface AlignmentBuildOptions {
  tasks: readonly LinkTask[];
  radius: number;
  /** The ground of these tiles, in order (TILE_STRIDE² samples each). */
  synthesize: (keys: TileKey[]) => Promise<TileGround[]>;
  /** The rivers near these tiles (decision 190); none by default. */
  rivers?: (keys: TileKey[]) => TaskRivers;
  /** Workers available, and how to run one task on one. */
  workers: number;
  run: (
    task: LinkTask,
    tiles: [string, TileGround][],
    rivers: TaskRivers | null,
  ) => Promise<AlignedLink>;
  /** Fraction done (by anchor-chord length) and links done. */
  onProgress?: (fraction: number, done: number, total: number) => void;
  cancelled?: () => boolean;
  /** Tiles kept between tasks (272 KB each). */
  cacheTiles?: number;
  /** Tiles per synthesizer call. */
  batch?: number;
}

function taskLength(t: LinkTask): number {
  let L = 0;
  const a = t.anchors;
  for (let i = 3; i < a.length; i += 3)
    L += Math.hypot(a[i]! - a[i - 3]!, a[i + 1]! - a[i - 2]!, a[i + 2]! - a[i - 1]!);
  return L;
}

export async function buildAlignments(o: AlignmentBuildOptions): Promise<Alignments> {
  const t0 = performance.now();
  const cache = new Map<string, TileGround>();
  const capacity = o.cacheTiles ?? 192;
  const batch = o.batch ?? 8;
  let synthesized = 0;
  // One synthesizer call at a time.
  let gpu: Promise<unknown> = Promise.resolve();
  // Tiles a lane is waiting for or about to hand out are pinned: another lane's
  // eviction must not drop them in between (it did, with 16 lanes: decision 186).
  const pinned = new Map<string, number>();
  const queued = new Set<string>();
  const ensure = async (keys: TileKey[]): Promise<[string, TileGround][]> => {
    const want = keys.map((k) => tileKeyString(k));
    for (const s of want) pinned.set(s, (pinned.get(s) ?? 0) + 1);
    try {
      const missing = keys.filter((_, i) => !cache.has(want[i]!) && !queued.has(want[i]!));
      for (const k of missing) queued.add(tileKeyString(k));
      if (missing.length) {
        const job = gpu.then(async () => {
          try {
            for (let i = 0; i < missing.length; i += batch) {
              const part = missing.slice(i, i + batch);
              const heights = await o.synthesize(part);
              part.forEach((k, j) => cache.set(tileKeyString(k), heights[j]!));
              synthesized += part.length;
            }
          } finally {
            for (const k of missing) queued.delete(tileKeyString(k));
          }
        });
        gpu = job.catch(() => undefined);
      }
      // Calls run in order: once the chain is done, so are this lane's tiles and any another lane queued.
      await gpu;
      return want.map((s) => {
        const h = cache.get(s);
        if (!h) throw new Error(`alignment: tile ${s} was not synthesized`);
        // Most recently used last.
        cache.delete(s);
        cache.set(s, h);
        return [s, h];
      });
    } finally {
      for (const s of want) {
        const n = pinned.get(s)! - 1;
        if (n > 0) pinned.set(s, n);
        else pinned.delete(s);
      }
      for (const s of cache.keys()) {
        if (cache.size <= capacity) break;
        if (!pinned.has(s)) cache.delete(s);
      }
    }
  };

  const lengths = o.tasks.map(taskLength);
  const totalLength = lengths.reduce((a, b) => a + b, 0) || 1;
  const results: AlignedLink[] = [];
  let doneLength = 0;
  let next = 0;
  let failure: unknown = null;
  const inFlight = Math.max(1, o.workers) * 2;
  const lane = async () => {
    while (next < o.tasks.length && failure === null) {
      if (o.cancelled?.()) throw new AlignmentCancelled();
      const i = next++;
      const task = o.tasks[i]!;
      const keys = taskTiles(task, o.radius);
      const tiles = await ensure(keys);
      if (o.cancelled?.()) throw new AlignmentCancelled();
      results.push(await o.run(task, tiles, o.rivers ? o.rivers(keys) : null));
      doneLength += lengths[i]!;
      o.onProgress?.(doneLength / totalLength, results.length, o.tasks.length);
    }
  };
  await Promise.all(
    Array.from({ length: inFlight }, () =>
      lane().catch((e: unknown) => {
        failure ??= e;
      }),
    ),
  );
  if (failure !== null) throw failure;
  return packAlignments(results, o.radius, { ms: performance.now() - t0, tiles: synthesized });
}
