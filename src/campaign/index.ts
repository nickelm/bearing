/**
 * campaign: theater detection, casting and the briefing (design, "Theaters"
 * and "Casting"). Reads the strategic graph only (decision 52); randomness
 * comes from rng(seed, "casting") alone.
 */
export * from './cast';
export * from './theaters';
export * from './validity';
export { castCampaign, RANGE_FACTOR_MAX, RANGE_FACTOR_MIN } from './casting';
export { compass } from './briefing';

import type { WorldSeed } from '../core/rng';
import type { StrategicGraph } from '../worldgen/strategic/graph';
import type { Cast } from './cast';
import { castCampaign } from './casting';
import { detectTheaters } from './theaters';
import type { Detection } from './theaters';
import { checkValidity } from './validity';
import type { Validity } from './validity';

export interface Campaign {
  detection: Detection;
  cast: Cast;
  validity: Validity;
}

/** Detection, casting and the validity check on one graph. */
export function readWorld(graph: StrategicGraph, seed: WorldSeed): Campaign {
  const detection = detectTheaters(graph);
  const cast = castCampaign(graph, detection, seed);
  return { detection, cast, validity: checkValidity(detection, cast) };
}
