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
import { taskTiles } from './tileHeights';

export class AlignmentCancelled extends Error {
  constructor() {
    super('alignment cancelled');
  }
}

export interface AlignmentBuildOptions {
  tasks: readonly LinkTask[];
  radius: number;
  /** Heights of these tiles, in order (TILE_STRIDE² samples each). */
  synthesize: (keys: TileKey[]) => Promise<Float32Array[]>;
  /** Workers available, and how to run one task on one. */
  workers: number;
  run: (task: LinkTask, tiles: [string, Float32Array][]) => Promise<AlignedLink>;
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
  const cache = new Map<string, Float32Array>();
  const capacity = o.cacheTiles ?? 192;
  const batch = o.batch ?? 8;
  let synthesized = 0;
  // One synthesizer call at a time.
  let gpu: Promise<unknown> = Promise.resolve();
  const ensure = async (keys: TileKey[]): Promise<[string, Float32Array][]> => {
    const want = keys.map((k) => tileKeyString(k));
    const missing = keys.filter((_, i) => !cache.has(want[i]!));
    if (missing.length) {
      const job = gpu.then(async () => {
        for (let i = 0; i < missing.length; i += batch) {
          const part = missing.slice(i, i + batch);
          const heights = await o.synthesize(part);
          part.forEach((k, j) => cache.set(tileKeyString(k), heights[j]!));
          synthesized += part.length;
        }
      });
      gpu = job.catch(() => undefined);
      await job;
    }
    const out: [string, Float32Array][] = want.map((s) => {
      const h = cache.get(s)!;
      // Most recently used last.
      cache.delete(s);
      cache.set(s, h);
      return [s, h];
    });
    while (cache.size > Math.max(capacity, want.length)) cache.delete(cache.keys().next().value!);
    return out;
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
      const tiles = await ensure(taskTiles(task, o.radius));
      if (o.cancelled?.()) throw new AlignmentCancelled();
      results.push(await o.run(task, tiles));
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
