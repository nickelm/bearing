import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  bandsFor,
  ZONE_SPACING,
  zoneBands,
  zoneImportance,
} from '../src/render/strategic/labels/labelModel';
import type { ZoneRecord } from '../src/worldgen/zones';

const R = 1e6;

function zone(id: number, diameter: number, latDeg: number, lonDeg: number): ZoneRecord {
  const d = latLonToDirection(latDeg * DEG, lonDeg * DEG, new Vec3d());
  return {
    id,
    name: `Zone ${id}`,
    cells: 1,
    area: (Math.PI * diameter * diameter) / 4,
    diameter,
    anchor: [d.x, d.y, d.z],
    biome: 0,
    province: 0,
    recipe: { hue: 0, saturation: 1, value: 1 } as ZoneRecord['recipe'],
  };
}

describe('zone labels (decision 220)', () => {
  it('ranks zones below cities, peaks and ranges of the same size class', () => {
    expect(zoneImportance(10_000)).toBeCloseTo(0.25);
    expect(zoneImportance(100_000)).toBeCloseTo(0.65);
    // Theater from about 50 km, Region from about 25 km.
    expect(bandsFor('zone', zoneImportance(45_000))).toEqual(['region']);
    expect(bandsFor('zone', zoneImportance(55_000))).toEqual(['theater', 'region']);
    expect(bandsFor('zone', zoneImportance(20_000))).toEqual([]);
  });

  it('keeps the larger of two zones closer than the band spacing', () => {
    // 1° of arc is 17.5 km on the 1,000 km planet.
    const zones = [zone(0, 40_000, 0, 0), zone(1, 50_000, 0, 2), zone(2, 30_000, 0, 7)];
    const bands = zoneBands(zones, R);
    expect(bands[1]).toContain('region');
    expect(bands[0]).not.toContain('region'); // 35 km from the larger zone 1
    expect(bands[2]).toContain('region'); // 87 km from zone 1
  });

  it('spaces kept labels at least the band spacing apart', () => {
    const zones: ZoneRecord[] = [];
    let id = 0;
    for (let lat = -30; lat <= 30; lat += 1.5)
      for (let lon = -30; lon <= 30; lon += 1.5) {
        zones.push(zone(id, 25_000 + ((id * 7919) % 40_000), lat, lon));
        id++;
      }
    const bands = zoneBands(zones, R);
    for (const band of ['theater', 'region'] as const) {
      const kept = zones.filter((_, i) => bands[i]!.includes(band));
      expect(kept.length).toBeGreaterThan(0);
      const minDot = Math.cos(ZONE_SPACING[band]! / R);
      for (let a = 0; a < kept.length; a++)
        for (let b = a + 1; b < kept.length; b++) {
          const p = kept[a]!.anchor;
          const q = kept[b]!.anchor;
          expect(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]).toBeLessThanOrEqual(minDot);
        }
    }
  });
});
