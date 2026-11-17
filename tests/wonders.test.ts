import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { Vec3d } from '../src/core/vec3d';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { Province } from '../src/worldgen/provinces';
import { FeatureKind, WonderKind } from '../src/worldgen/strategic/graph';

describe('natural wonders (decision 214)', () => {
  const grid = new CubeGrid(128);
  const worlds = [1, 2, 3].map((seed) =>
    generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed }, { grid }),
  );

  it('selects 5 to 15 named wonders per world, at most two of a kind', () => {
    for (const w of worlds) {
      const f = w.graph.features;
      const sel = w.campaign.cast.wonders ?? [];
      let candidates = 0;
      for (let i = 0; i < f.count; i++) if (f.kind[i] === FeatureKind.Wonder) candidates++;
      expect(sel.length).toBeGreaterThanOrEqual(Math.min(5, candidates));
      expect(sel.length).toBeLessThanOrEqual(15);
      const perKind = new Map<number, number>();
      for (const i of sel) {
        expect(f.kind[i]).toBe(FeatureKind.Wonder);
        expect(f.names[i]!.length).toBeGreaterThan(3);
        perKind.set(f.measure[i]!, (perKind.get(f.measure[i]!) ?? 0) + 1);
      }
      for (const v of perKind.values()) expect(v).toBeLessThanOrEqual(2);
      if (sel.length > 0) expect(w.campaign.cast.briefing).toMatch(/landmarks/);
    }
  }, 120_000);

  it('places each wonder where its conditions hold', () => {
    for (const w of worlds) {
      const f = w.graph.features;
      const prov = w.world.maps.province;
      const v = new Vec3d();
      for (let i = 0; i < f.count; i++) {
        if (f.kind[i] !== FeatureKind.Wonder) continue;
        const c = grid.cellOfDirection(
          v.set(f.anchor[3 * i]!, f.anchor[3 * i + 1]!, f.anchor[3 * i + 2]!),
        );
        if (f.measure[i] === WonderKind.KarstBay) expect(prov[c]).toBe(Province.KarstPlatform);
        if (f.measure[i] === WonderKind.CraterLake)
          expect([Province.VolcanicArc, Province.Hotspot]).toContain(prov[c]);
        if (f.measure[i] === WonderKind.BlueHole)
          expect(w.world.maps.height[c]).toBeLessThanOrEqual(0);
      }
    }
  });
});
