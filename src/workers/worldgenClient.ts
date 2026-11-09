/**
 * Main-thread side of the world-generation worker. Only one generation runs
 * at a time. Starting a new one, or calling cancel(), terminates the worker
 * and rejects the pending promise with a GenerationCancelled error.
 */
import type { PlanetParams } from '../worldgen/params';
import type { ProgressCallback, World } from '../worldgen/pipeline';
import type { FromWorldgenWorker, ToWorldgenWorker } from './worldgenProtocol';

export class GenerationCancelled extends Error {
  constructor() {
    super('World generation cancelled');
    this.name = 'GenerationCancelled';
  }
}

interface Pending {
  id: number;
  resolve: (w: World) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressCallback;
}

export class WorldgenClient {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextId = 1;

  get busy(): boolean {
    return this.pending !== null;
  }

  generate(
    params: PlanetParams,
    resolution: number,
    onProgress?: ProgressCallback,
  ): Promise<World> {
    this.cancel();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<World>((resolve, reject) => {
      this.pending = { id, resolve, reject, onProgress };
      worker.postMessage({ type: 'generate', id, params, resolution } satisfies ToWorldgenWorker);
    });
  }

  cancel(): void {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    p.reject(new GenerationCancelled());
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./worldgen.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<FromWorldgenWorker>) => this.onMessage(e.data);
    w.onerror = (e) => {
      const p = this.pending;
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
      p?.reject(new Error(`Worldgen worker error: ${e.message}`));
    };
    this.worker = w;
    return w;
  }

  private onMessage(msg: FromWorldgenWorker): void {
    const p = this.pending;
    if (!p || msg.id !== p.id) return; // stale message from a cancelled run
    switch (msg.type) {
      case 'progress':
        p.onProgress?.(msg.stage, msg.fraction);
        break;
      case 'result':
        this.pending = null;
        p.resolve({ maps: msg.maps, info: msg.info });
        break;
      case 'error':
        this.pending = null;
        p.reject(new Error(msg.message));
        break;
    }
  }
}
