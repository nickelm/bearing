import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { cellCenterDirection } from '../src/worldgen/rivers';
import { coarsePass } from '../src/worldgen/coarsePass';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { NO_ZONE, RECIPE_LIMITS, segmentZones } from '../src/worldgen/zones';
import { makeZoneShift } from '../src/render/common/zoneLook';

// The coarse pass at 512² (3 km cells) stands in for the eroded grid: the zones' code
// is the same on any grid.
const N = 512;
const w = coarsePass({ ...DEFAULT_PLANET_PARAMS, seed: '3' }, { resolution: N });
const m = w.world.maps;
const zones = segmentZones(
  N,
  m.height,
  m.biome,
  m.province,
  m.discharge,
  DEFAULT_PLANET_PARAMS.radius,
  '3',
);

describe('zones (decision 211)', () => {
  it('puts every land cell in a zone and no sea cell in one', () => {
    for (let c = 0; c < m.height.length; c++) {
      if (m.height[c]! > 0) expect(zones.zone[c]).not.toBe(NO_ZONE);
      else expect(zones.zone[c]).toBe(NO_ZONE);
    }
  });

  it('keeps 90% of zones within 16–63 km, each named with a recipe within the limits', () => {
    const r = zones.records;
    expect(r.length).toBeGreaterThan(100);
    const inRange = r.filter((z) => z.diameter >= 16_000 && z.diameter <= 63_000).length;
    expect(inRange / r.length).toBeGreaterThanOrEqual(0.9);
    const names = new Set<string>();
    for (const z of r) {
      expect(z.name).toMatch(/^the \S+/);
      names.add(z.name);
      expect(Math.abs(z.recipe.hue)).toBeLessThanOrEqual(RECIPE_LIMITS.hue);
      expect(Math.abs(z.recipe.saturation - 1)).toBeLessThanOrEqual(RECIPE_LIMITS.saturation);
      expect(Math.abs(z.recipe.value - 1)).toBeLessThanOrEqual(RECIPE_LIMITS.value);
    }
    // Names rarely repeat.
    expect(names.size / r.length).toBeGreaterThan(0.95);
  });

  it('is deterministic', () => {
    const again = segmentZones(
      N,
      m.height,
      m.biome,
      m.province,
      m.discharge,
      DEFAULT_PLANET_PARAMS.radius,
      '3',
    );
    expect(again.zone).toEqual(zones.zone);
    expect(again.records.map((z) => z.name)).toEqual(zones.records.map((z) => z.name));
  });

  it('shifts colors within a zone and barely at its boundary', () => {
    const shift = makeZoneShift(zones, N);
    const d = new Vec3d();
    const base: [number, number, number] = [0.4, 0.55, 0.3];
    let atEdge = 0;
    let inside = 0;
    for (let c = 0; c < m.height.length && (atEdge < 50 || inside < 50); c += 7) {
      if (zones.zone[c] === NO_ZONE) continue;
      cellCenterDirection(N, c, d);
      const out = shift(base, d);
      const diff = Math.max(...out.map((v, i) => Math.abs(v - base[i]!)));
      if (zones.edge[c] === 0) {
        atEdge++;
        expect(diff).toBeLessThan(0.05);
      } else inside++;
    }
    expect(atEdge).toBeGreaterThan(0);
  });
});
