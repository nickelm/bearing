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

  const lost = { alliance: 0, pact: 0 };
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
      // R2.2's exit: both sides lose aircraft, targets and bridges are damaged, airlift delivers.
      // Losses per side are few on some seeds (a defender flying little CAS), so each
      // side's are checked over the three seeds (the last test).
      for (const side of ['alliance', 'pact'] as const) lost[side] += sim.air!.lost[side];
      expect(sim.air!.lost.alliance + sim.air!.lost.pact, `seed ${seed}: losses`).toBeGreaterThan(
        0,
      );
      const damaged = sim.damage!.damaged();
      const targets = sim.air!.input.targets;
      expect(damaged.length, `seed ${seed}: damaged sites`).toBeGreaterThan(0);
      expect(
        damaged.some((x) => targets[x.id]!.bridge),
        `seed ${seed}: a damaged bridge`,
      ).toBe(true);
      const res = sim.resolution!.stats;
      expect(
        res.alliance.deliveries + res.pact.deliveries,
        `seed ${seed}: airlift`,
      ).toBeGreaterThan(0);

      // R2.3's exit: the front moves measurably (the suppressed run: tools/airSupport.preview.ts).
      const moved = Math.max(
        ...sim.air!.input.fronts.flatMap((f) => sim.ground!.frontOffsets(f.theater).map(Math.abs)),
      );
      expect(moved, `seed ${seed}: the front's largest move`).toBeGreaterThan(1000);

      // R2.9's exit: every ejection in the day makes a survivor, and every survivor down
      // before the day's end gets a CSAR mission (decisions 351, 352).
      const log = sim.sim.log.entries;
      const ejected = log.reduce(
        (n, e) => n + (e.source === 'decision' && e.kind === 'aircraft-lost' ? e.ejected : 0),
        0,
      );
      const survivors = sim.air!.survivors;
      expect(survivors.length, `seed ${seed}: survivors`).toBe(ejected);
      expect(ejected, `seed ${seed}: ejections`).toBeGreaterThan(0);
      const rescues = [...seen.values()].filter((m) => m.type === 'csar');
      for (const s of survivors) {
        if (s.time > 24 * HOUR) continue;
        expect(
          rescues.some((m) => m.survivors?.includes(s.id)),
          `seed ${seed}: survivor #${s.id} (${s.state}) has a CSAR mission`,
        ).toBe(true);
      }
      expect(
        survivors.some((s) => s.state === 'rescued'),
        `seed ${seed}: a rescue`,
      ).toBe(true);

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

  it('loses aircraft on both sides over the demo seeds', () => {
    expect(lost.alliance).toBeGreaterThan(0);
    expect(lost.pact).toBeGreaterThan(0);
  });
});
