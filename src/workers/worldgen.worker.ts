/**
 * World-generation worker: runs the worldgen pipeline off the main thread
 * and transfers the resulting typed arrays without copying. To cancel a
 * run, the main thread terminates the worker.
 */
import { generateCampaignWorld, strategicBuffers, strategicWorld } from '../worldgen/campaignWorld';
import { COARSE_RESOLUTION } from '../worldgen/coarsePass';
import { finishWorld } from '../worldgen/finishWorld';
import type { FinishResult } from '../worldgen/finishWorld';
import { generateWorld, worldBuffers } from '../worldgen/pipeline';
import { riverBuffers } from '../worldgen/rivers';
import type { FromWorldgenWorker, ToWorldgenWorker } from './worldgenProtocol';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ToWorldgenWorker>) => void) | null;
  postMessage(message: FromWorldgenWorker, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'finish') {
    try {
      const result = finishWorld(msg.input);
      ctx.postMessage({ type: 'finished', id: msg.id, result }, finishBuffers(result));
    } catch (err) {
      ctx.postMessage({ type: 'error', id: msg.id, message: String(err) });
    }
    return;
  }
  if (msg.type !== 'generate') return;
  try {
    const progress = (stage: string, fraction: number) =>
      ctx.postMessage({ type: 'progress', id: msg.id, stage, fraction });
    // Pipeline steps 1–9 on the coarse grid, with the validity check and retries.
    const t0 = performance.now();
    const cw = generateCampaignWorld(msg.params, {
      resolution: COARSE_RESOLUTION,
      onProgress: progress,
    });
    const strategic = strategicWorld(cw);
    strategic.timings.push({ stage: 'coarse pass total', ms: performance.now() - t0 });
    // The displayed tectonic world at the requested resolution, from the seed that passed.
    const world =
      msg.resolution === COARSE_RESOLUTION
        ? cw.world
        : generateWorld(
            { ...msg.params, seed: cw.seed },
            { resolution: msg.resolution, onProgress: progress },
          );
    ctx.postMessage({ type: 'result', id: msg.id, maps: world.maps, info: world.info, strategic }, [
      ...worldBuffers(world.maps),
      ...strategicBuffers(strategic),
    ]);
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: String(err) });
  }
};

function finishBuffers(r: FinishResult): ArrayBuffer[] {
  const d = r.drainage;
  return [
    d.receiver.buffer,
    d.discharge.buffer,
    d.lakeDepth.buffer,
    r.biome.buffer,
    r.forest.buffer,
    r.treeline.buffer,
    ...Object.values(r.display).map((a: ArrayBufferView) => a.buffer),
    ...riverBuffers(r.rivers),
  ] as ArrayBuffer[];
}
