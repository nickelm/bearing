import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { Vec3d } from '../src/core/vec3d';
import { DEMO_SEEDS } from '../src/campaign/demoSeeds';
import { HOUR, MINUTE } from '../src/core/units';
import type { Mission } from '../src/sim/air/mission';
import { routeState } from '../src/sim/air/route';
import { campaignInput } from '../src/sim/command/campaignInput';
import { createSimWorld } from '../src/sim/world';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { COARSE_RESOLUTION } from '../src/worldgen/coarsePass';
import { globalMapSampler } from '../src/worldgen/edits/airfields';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { GENERATOR_VERSION } from '../src/worldgen/worldStore';
import { syntheticConfig } from './helpers/weatherWorld';

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
    it(`seed ${seed} is valid, has a continental front, flies the demo types above its ground`, () => {
      const w = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { grid });
      expect(w.campaign.validity.valid).toBe(true);
      const front = w.campaign.cast.theaters.find((t) => t.kind === 'continental-front');
      expect(
        front,
        `seed ${seed}: ${w.campaign.cast.theaters.map((t) => t.kind).join(', ')}`,
      ).toBeDefined();
      expect(front!.fit).toBeGreaterThanOrEqual(0.9);
      expect(w.graph.fronts.length).toBeGreaterThan(0);

      // R1.6: no analytic route passes below the coarse ground (the bilinear surface),
      // sampled every 20 s of flight over 26 game hours of the air war.
      const ground = { height: w.world.maps.height, n: w.world.info.resolution };
      const sim = createSimWorld({
        ...syntheticConfig(seed),
        radius: DEFAULT_PLANET_PARAMS.radius,
        campaign: campaignInput(w.graph, w.campaign.cast, w.infrastructure),
        ground,
      });
      const seen = new Map<number, Mission>();
      for (let t = 10 * MINUTE; t <= 26 * HOUR; t += 10 * MINUTE) {
        sim.sim.advanceTo(t);
        for (const m of sim.air!.liveMissions()) seen.set(m.id, m);
      }
      expect(seen.size).toBeGreaterThan(100);
      // R2.1's exit: both sides issue and revise orders and fly all four demo types.
      for (const side of ['alliance', 'pact'] as const) {
        const st = sim.ato!.stats[side];
        expect(st.orders, side).toBe(2);
        expect(st.revisions, side).toBeGreaterThan(st.orders);
        for (const type of ['cap', 'interdiction', 'cas', 'airlift']) {
          expect(
            [...seen.values()].some((m) => m.side === side && m.type === type),
            `seed ${seed}: ${side} ${type}`,
          ).toBe(true);
        }
      }
      const surface = globalMapSampler(ground.height, ground.n);
      const v = new Vec3d();
      const R = DEFAULT_PLANET_PARAMS.radius;
      let below = 0;
      let worst = Infinity;
      for (const m of seen.values()) {
        const segs = m.route.segments;
        for (let t = segs[0]!.t0; t <= segs[segs.length - 1]!.t1; t += 20) {
          const s = routeState(m.route, t, R);
          if (!s.airborne) continue;
          const clear = s.altitude - Math.max(0, surface(v.set(...s.point)));
          worst = Math.min(worst, clear);
          if (clear < -0.5) below++;
        }
      }
      expect(below, `seed ${seed}: worst clearance ${worst.toFixed(1)} m`).toBe(0);
    });
  }
});
