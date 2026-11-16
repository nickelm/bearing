/**
 * A pool of alignment workers (decision 184): one per core but one, at most
 * eight. `run` hands a task to the least busy worker; `dispose` ends them all.
 */
import type { WorldSeed } from '../core/rng';
import type { AlignedLink, LinkTask } from '../worldgen/networks/link';
import type { TaskRivers } from '../worldgen/networks/riverCrossings';
import type { TileGround } from '../worldgen/networks/tileHeights';
import type { AlignRequest, AlignResponse } from './alignment.worker';

interface Slot {
  worker: Worker;
  busy: number;
}

export class AlignmentPool {
  readonly size: number;
  private readonly slots: Slot[] = [];
  private readonly waiting = new Map<
    number,
    { resolve: (l: AlignedLink) => void; reject: (e: Error) => void; slot: Slot }
  >();
  private nextId = 1;
  /** Height lookups that fell outside the tiles sent (should stay 0). */
  missing = 0;

  constructor(
    readonly radius: number,
    readonly seed: WorldSeed,
    size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
  ) {
    this.size = size;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./alignment.worker.ts', import.meta.url), {
        type: 'module',
      });
      const slot: Slot = { worker, busy: 0 };
      worker.onmessage = (e: MessageEvent<AlignResponse>) => {
        const w = this.waiting.get(e.data.id);
        if (!w) return;
        this.waiting.delete(e.data.id);
        w.slot.busy--;
        if ('error' in e.data) w.reject(new Error(e.data.error));
        else {
          this.missing += e.data.missing;
          w.resolve(e.data.link);
        }
      };
      worker.onerror = (e) => {
        for (const [id, w] of this.waiting)
          if (w.slot === slot) {
            this.waiting.delete(id);
            w.reject(new Error(`alignment worker failed: ${e.message}`));
          }
      };
      this.slots.push(slot);
    }
  }

  run(
    task: LinkTask,
    tiles: [string, TileGround][],
    rivers: TaskRivers | null,
  ): Promise<AlignedLink> {
    const slot = this.slots.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = this.nextId++;
    slot.busy++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, slot });
      const msg: AlignRequest = { id, task, radius: this.radius, seed: this.seed, tiles, rivers };
      // Tiles stay in the stage's cache: copied, not transferred.
      slot.worker.postMessage(msg);
    });
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error('alignment pool disposed'));
    this.waiting.clear();
  }
}
