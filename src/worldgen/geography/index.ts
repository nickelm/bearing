/**
 * Feature extraction (design pipeline step 7; decision 95): the coarse maps become
 * named-feature records with geometry, extent and importance. Runs inside the
 * strategic graph builder, after the land nodes and sea lanes, so archipelagos and
 * straits come from the same facts as the graph; names come after (names/).
 *
 *   region field → land (continents, islands, archipelagos) → water (oceans,
 *   seas, bays, straits, lakes) → relief (ranges, peaks, hills, plains,
 *   plateaus) → cover (deserts, forests, wetlands) → river main stems
 *
 * Deterministic and free of randomness: ties break by cell index.
 */
import type { FeatureList } from '../strategic/graph';
import { FeatureBuilder } from './builder';
import { regionField } from './context';
import type { GeographyInput } from './context';
import { extractCover } from './cover';
import { extractLand } from './land';
import { extractRelief } from './relief';
import { extractRivers } from './riverStems';
import { extractWater } from './water';

export type { GeographyInput } from './context';

export function extractFeatures(input: GeographyInput): FeatureList {
  const fb = new FeatureBuilder(input.ctx.grid.cellCount);
  const lap = timer(input.timings);
  const region = regionField(input);
  lap('regions');
  extractLand(input, fb, region);
  lap('land');
  extractWater(input, fb, region);
  lap('water');
  extractRelief(input, fb, region);
  lap('relief');
  extractCover(input, fb, region);
  lap('cover');
  extractRivers(input, fb, region);
  lap('rivers');
  return fb.pack();
}

function timer(out?: { stage: string; ms: number }[]): (stage: string) => void {
  let t0 = performance.now();
  return (stage) => {
    const now = performance.now();
    out?.push({ stage: `features: ${stage}`, ms: now - t0 });
    t0 = now;
  };
}
