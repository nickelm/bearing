import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { DEMO_SEEDS } from '../src/campaign/demoSeeds';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { COARSE_RESOLUTION } from '../src/worldgen/coarsePass';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { GENERATOR_VERSION } from '../src/worldgen/worldStore';

// The demo's worlds as the app builds them (decision 232). A change to generation
// that bumps GENERATOR_VERSION must re-check them: run `npm run seeds`, choose the
// seeds again if one lost its front, and update DEMO_SEEDS and this version.
const CHECKED_ON_VERSION = 34;

describe('demo seeds', () => {
  const grid = new CubeGrid(COARSE_RESOLUTION);

  it('were checked on the current generator version', () => {
    expect(GENERATOR_VERSION).toBe(CHECKED_ON_VERSION);
  });

  for (const seed of DEMO_SEEDS) {
    it(`seed ${seed} is valid and has a continental front`, () => {
      const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { grid });
      expect(w.campaign.validity.valid).toBe(true);
      const front = w.campaign.cast.theaters.find((t) => t.kind === 'continental-front');
      expect(
        front,
        `seed ${seed}: ${w.campaign.cast.theaters.map((t) => t.kind).join(', ')}`,
      ).toBeDefined();
      expect(front!.fit).toBeGreaterThanOrEqual(0.9);
      expect(w.graph.fronts.length).toBeGreaterThan(0);
    });
  }
});
