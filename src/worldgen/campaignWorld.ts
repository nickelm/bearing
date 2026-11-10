/**
 * Pipeline steps 1–9 with the validity check (design, "World Generation
 * Pipeline"; decision 46): the coarse pass, the strategic graph, theater
 * detection and casting. A world that fails the validity check regenerates
 * from a sub-seed of `rng(seed, "validity").fork("retry-n")`, so the retry
 * sequence, and with it the world, is a function of the seed alone.
 */
import { rng } from '../core/rng';
import type { WorldSeed } from '../core/rng';
import { readWorld } from '../campaign';
import type { Campaign } from '../campaign';
import { coarsePass } from './coarsePass';
import type { CoarseOptions, CoarseWorld } from './coarsePass';
import type { PlanetParams } from './params';
import type { StageTiming } from './pipeline';
import type { StrategicGraph } from './strategic/graph';
import { graphBuffers } from './strategic/graph';

/** Retries before giving up and keeping the seed's own world, marked invalid. */
export const MAX_RETRIES = 8;

export interface CampaignWorld extends CoarseWorld {
  campaign: Campaign;
  /** The seed actually generated: the input seed, or a retry sub-seed as a decimal string. */
  seed: WorldSeed;
  /** Rejected worlds before this one. */
  retries: number;
  /** Why each rejected world failed. */
  rejected: string[][];
}

/** The seed for retry n ≥ 1, as a decimal string (digit strings are numeric seeds). */
export function retrySeed(seed: WorldSeed, n: number): string {
  const r = rng(seed, 'validity').fork(`retry-${n}`);
  const hi = BigInt(r.nextUint32());
  const lo = BigInt(r.nextUint32());
  return String((hi << 32n) | lo);
}

export function generateCampaignWorld(
  params: PlanetParams,
  options: CoarseOptions = {},
): CampaignWorld {
  const rejected: string[][] = [];
  let first: CampaignWorld | null = null;
  for (let n = 0; n <= MAX_RETRIES; n++) {
    const seed = n === 0 ? params.seed : retrySeed(params.seed, n);
    const coarse = coarsePass(
      { ...params, seed },
      {
        ...options,
        onProgress: (stage, f) => options.onProgress?.(n === 0 ? stage : `retry ${n}: ${stage}`, f),
      },
    );
    const t0 = performance.now();
    const campaign = readWorld(coarse.graph, seed);
    coarse.timings.push({ stage: 'theaters and casting', ms: performance.now() - t0 });
    const result: CampaignWorld = {
      ...coarse,
      campaign,
      seed,
      retries: n,
      rejected: [...rejected],
    };
    if (campaign.validity.valid) return result;
    first ??= result;
    rejected.push(campaign.validity.reasons);
  }
  return { ...first!, rejected };
}

/**
 * What the app keeps of a campaign world besides its maps: the seed actually
 * generated, the graph and the campaign. Stored with the world (worldStore.ts).
 */
export interface StrategicWorld {
  /** The seed actually generated (see CampaignWorld.seed). */
  seed: WorldSeed;
  retries: number;
  rejected: string[][];
  graph: StrategicGraph;
  campaign: Campaign;
  timings: StageTiming[];
}

export function strategicWorld(w: CampaignWorld): StrategicWorld {
  return {
    seed: w.seed,
    retries: w.retries,
    rejected: w.rejected,
    graph: w.graph,
    campaign: w.campaign,
    timings: w.timings,
  };
}

/** Typed arrays of a StrategicWorld, for a transfer list. */
export function strategicBuffers(s: StrategicWorld): ArrayBuffer[] {
  return graphBuffers(s.graph);
}
