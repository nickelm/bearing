/**
 * Main-thread side of the world-generation worker. Only one generation runs
 * at a time. Starting a new one, or calling cancel(), terminates the worker
 * and rejects the pending promise with a GenerationCancelled error.
 */
import type { StrategicWorld } from '../worldgen/campaignWorld';
import type { FinishInput, FinishResult } from '../worldgen/finishWorld';
import type { PlanetParams } from '../worldgen/params';
import type { ProgressCallback, World } from '../worldgen/pipeline';
import type { FromWorldgenWorker, ToWorldgenWorker } from './worldgenProtocol';

export class GenerationCancelled extends Error {
  constructor() {
    super('World generation cancelled');
    this.name = 'GenerationCancelled';
  }
}

/** A tectonic world plus the coarse pass's graph and campaign. */
export interface GeneratedWorld extends World {
  strategic: StrategicWorld;
}

interface Pending {
  id: number;
  resolve: (w: GeneratedWorld) => void;
  resolveFinish?: (r: FinishResult) => void;
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
  ): Promise<GeneratedWorld> {
    this.cancel();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<GeneratedWorld>((resolve, reject) => {
      this.pending = { id, resolve, reject, onProgress };
      worker.postMessage({ type: 'generate', id, params, resolution } satisfies ToWorldgenWorker);
    });
  }

  /**
   * Runs the CPU stages after GPU erosion. The input arrays are transferred
   * (and become unusable here). Cancels any pending request.
   */
  finish(input: FinishInput): Promise<FinishResult> {
    this.cancel();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<FinishResult>((resolveFinish, reject) => {
      this.pending = { id, resolve: () => {}, resolveFinish, reject };
      const transfer = [
        input.height,
        input.runoff,
        input.precipitation,
        input.seaLevelTemperature,
        input.temperatureRange,
      ].map((a) => a.buffer as ArrayBuffer);
      worker.postMessage({ type: 'finish', id, input } satisfies ToWorldgenWorker, transfer);
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
        p.resolve({ maps: msg.maps, info: msg.info, strategic: msg.strategic });
        break;
      case 'finished':
        this.pending = null;
        p.resolveFinish?.(msg.result);
        break;
      case 'error':
        this.pending = null;
        p.reject(new Error(msg.message));
        break;
    }
  }
}
