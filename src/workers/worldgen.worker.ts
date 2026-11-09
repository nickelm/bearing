/**
 * World-generation worker: runs the worldgen pipeline off the main thread
 * and transfers the resulting typed arrays without copying. To cancel a
 * run, the main thread terminates the worker.
 */
import { generateWorld, worldBuffers } from '../worldgen/pipeline';
import type { FromWorldgenWorker, ToWorldgenWorker } from './worldgenProtocol';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorldgenWorker>) => void) | null;
  postMessage(message: FromWorldgenWorker, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'generate') return;
  try {
    const world = generateWorld(msg.params, {
      resolution: msg.resolution,
      onProgress: (stage, fraction) =>
        ctx.postMessage({ type: 'progress', id: msg.id, stage, fraction }),
    });
    ctx.postMessage(
      { type: 'result', id: msg.id, maps: world.maps, info: world.info },
      worldBuffers(world.maps),
    );
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: String(err) });
  }
};
