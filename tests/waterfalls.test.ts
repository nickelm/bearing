/**
 * Waterfalls and rapids (Proposal 0010, decision 301) on a coarse world's rivers:
 * found deterministically, each a real drop with a lip above its foot, tall ones named.
 */
import { describe, expect, it } from 'vitest';
import { computeDrainage } from '../src/worldgen/drainage';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { extractRivers } from '../src/worldgen/rivers';
import { findWaterfalls, WATERFALL_TUNING } from '../src/worldgen/waterfalls';

const N = 96;
const R = DEFAULT_PLANET_PARAMS.radius;

function indexFor(seed: string): RiverIndex {
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const m = generateWorld(params, { resolution: N }).maps;
  const drainage = computeDrainage(N, m.height, m.runoff, R, {
    temperature: m.temperature,
    precipitation: m.precipitation,
  });
  const rivers = extractRivers(N, m.height, drainage.receiver, drainage.discharge);
  return new RiverIndex(rivers, { height: m.height, radius: R, lakeDepth: drainage.lakeDepth });
}

describe('waterfalls', () => {
  const index = indexFor('3');
  const a = findWaterfalls(index, R, '3');

  it('finds falls and rapids, deterministically', () => {
    expect(a.falls.length + a.rapids.length).toBeGreaterThan(0);
    expect(findWaterfalls(index, R, '3')).toEqual(a);
  });

  it('drops each fall from its lip to its foot and names the tall ones', () => {
    for (const f of a.falls) {
      expect(f.top - f.bottom).toBeGreaterThanOrEqual(WATERFALL_TUNING.minDrop);
      expect(f.width).toBeGreaterThanOrEqual(WATERFALL_TUNING.minWidth);
      expect(Math.hypot(...f.lip)).toBeCloseTo(1, 6);
      expect(f.name !== null).toBe(f.top - f.bottom >= WATERFALL_TUNING.namedDrop);
      if (f.name) expect(f.name).toMatch(/Falls$/);
    }
    for (const r of a.rapids) {
      expect(r.to).toBeGreaterThan(r.from);
      expect(r.gradient).toBeGreaterThanOrEqual(WATERFALL_TUNING.rapidsGradient);
    }
  });
});
