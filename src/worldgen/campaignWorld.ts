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
import { infrastructureBuffers, placeInfrastructure } from './strategic/infrastructure';
import type { Infrastructure } from './strategic/infrastructure';

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
  /** Ports, airbases, spur roads and targets placed from the cast (pipeline step 10). */
  infrastructure: Infrastructure;
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
  let first: Omit<CampaignWorld, 'infrastructure'> | null = null;
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
    const result = {
      ...coarse,
      campaign,
      seed,
      retries: n,
      rejected: [...rejected],
    };
    if (campaign.validity.valid) return withInfrastructure(result);
    first ??= result;
    rejected.push(campaign.validity.reasons);
  }
  return withInfrastructure({ ...first!, rejected });
}

/** Pipeline step 10 on the accepted world: settlements and roads are in the graph already. */
function withInfrastructure(w: Omit<CampaignWorld, 'infrastructure'>): CampaignWorld {
  const t0 = performance.now();
  const infrastructure = placeInfrastructure(w.build, w.campaign.cast, w.seed);
  w.timings.push(
    ...infrastructure.timings.map((t) => ({ stage: `infrastructure: ${t.stage}`, ms: t.ms })),
    { stage: 'infrastructure', ms: performance.now() - t0 },
  );
  return { ...w, infrastructure };
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
  infrastructure: Infrastructure;
  timings: StageTiming[];
}

export function strategicWorld(w: CampaignWorld): StrategicWorld {
  return {
    seed: w.seed,
    retries: w.retries,
    rejected: w.rejected,
    graph: w.graph,
    campaign: w.campaign,
    infrastructure: w.infrastructure,
    timings: w.timings,
  };
}

/** Typed arrays of a StrategicWorld, for a transfer list. */
export function strategicBuffers(s: StrategicWorld): ArrayBuffer[] {
  return [
    ...new Set([...graphBuffers(s.graph), ...infrastructureBuffers(s.infrastructure)]),
  ] as ArrayBuffer[];
}

/** One seed browser row (milestone 4): what a seed produces. */
export interface SeedSummary {
  seed: string;
  /** The seed actually generated, after retries. */
  seedUsed: string;
  retries: number;
  valid: boolean;
  landFraction: number;
  theaters: { kind: string; name: string; fit: number }[];
  rangeFactor: number;
  /** Candidate airbase sites per side (validity), and airbases placed. */
  airbases: { alliance: number; pact: number };
  placed: { alliance: number; pact: number };
  settlements: number;
  roadKm: number;
  bridges: number;
  ms: number;
}

export function summarizeSeed(seed: string, w: CampaignWorld, ms: number): SeedSummary {
  const cast = w.campaign.cast;
  return {
    seed,
    seedUsed: String(w.seed),
    retries: w.retries,
    valid: w.campaign.validity.valid,
    landFraction: w.world.info.landFraction,
    theaters: cast.theaters.map((t) => ({ kind: t.kind, name: t.name, fit: t.fit })),
    rangeFactor: cast.rangeFactor,
    airbases: { ...cast.airbases },
    placed: {
      alliance: w.infrastructure.airbases.filter((a) => a.side === 'alliance').length,
      pact: w.infrastructure.airbases.filter((a) => a.side === 'pact').length,
    },
    settlements: w.graph.settlements.cells.length,
    roadKm: roadLength(w.graph.roads, w.graph.radius) / 1000,
    bridges: w.graph.bridges.cells.length,
    ms,
  };
}

function roadLength(r: StrategicGraph['roads'], radius: number): number {
  let total = 0;
  for (let k = 0; k < r.count; k++) {
    for (let p = r.offsets[k]! + 1; p < r.offsets[k + 1]!; p++) {
      const a = r.points.subarray((p - 1) * 3, p * 3);
      const b = r.points.subarray(p * 3, p * 3 + 3);
      total += radius * Math.acos(Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!));
    }
  }
  return total;
}
