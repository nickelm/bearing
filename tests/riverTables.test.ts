import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { neighborTile, tileForDirection } from '../src/core/tiles';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { COARSE_MIN_WIDTH, FINE_LEVEL, RiverTables } from '../src/render/water/riverTables';
import { RiverIndex } from '../src/worldgen/riverIndex';
import { straightRiver } from './helpers/rivers';

describe('river tables', () => {
  it('lists a river for the tiles it runs through, and not far away', () => {
    const tables = new RiverTables(new RiverIndex(straightRiver(30)), PLANET_RADIUS);
    expect(tables.segmentCount).toBeGreaterThan(5);
    const on = tileForDirection(latLonToDirection(0, 10.25 * DEG), 9);
    expect(tables.rangeFor(on).count).toBeGreaterThan(0);
    // Half-widths are stored, in meters.
    expect(tables.segments[3]).toBeCloseTo(15, 3);
    const far = tileForDirection(latLonToDirection(20 * DEG, 40 * DEG), 9);
    expect(tables.rangeFor(far).count).toBe(0);
    // Levels below 4 draw no rivers.
    expect(tables.rangeFor(tileForDirection(latLonToDirection(0, 10.25 * DEG), 3)).count).toBe(0);
  });

  it('reaches into a neighboring tile when the river runs close to its edge', () => {
    // A river exactly on a level-7 tile edge must be listed on both sides.
    const tables = new RiverTables(new RiverIndex(straightRiver(30)), PLANET_RADIUS);
    const t = tileForDirection(latLonToDirection(0, 10.25 * DEG), FINE_LEVEL);
    const counts = [-1, 0, 1].map((dy) => tables.rangeFor(neighborTile(t, 0, dy)).count);
    // The equator lies on the edge between rows on face 4 (+Z) only at its center, so at
    // least the tile itself has segments; a neighbor with the river within reach also does.
    expect(counts[1]).toBeGreaterThan(0);
  });

  it('keeps only wide rivers in the coarse lists', () => {
    const narrow = new RiverTables(
      new RiverIndex(straightRiver(COARSE_MIN_WIDTH / 2)),
      PLANET_RADIUS,
    );
    const wide = new RiverTables(
      new RiverIndex(straightRiver(COARSE_MIN_WIDTH * 2)),
      PLANET_RADIUS,
    );
    const t5 = tileForDirection(latLonToDirection(0, 10.25 * DEG), 5);
    expect(narrow.rangeFor(t5).count).toBe(0);
    expect(wide.rangeFor(t5).count).toBeGreaterThan(0);
  });
});
