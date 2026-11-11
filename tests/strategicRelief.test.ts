/**
 * Tile budget of the strategic relief mesh (decision 77): the quadtree selection the
 * map runs, with every tile ready, at the ceiling, in each band and at the floor.
 */
import { describe, expect, it } from 'vitest';
import { DEG, KM } from '../src/core/units';
import { DEFAULT_LOD, selectTiles } from '../src/render/sim/terrain/quadtree';
import {
  StrategicCamera,
  STRATEGIC_CEILING,
  STRATEGIC_FLOOR,
} from '../src/render/strategic/strategicCamera';
import {
  STRATEGIC_EXAGGERATION,
  STRATEGIC_MAX_LEVEL,
} from '../src/render/strategic/strategicRelief';

const R = 1000 * KM;

function select(altitude: number, viewportHeight: number, lat = 20 * DEG) {
  const o = new StrategicCamera(R);
  o.lat = lat;
  o.altitude = o.targetAltitude = altitude;
  o.update(0);
  const view = {
    eye: o.eye,
    forward: o.forward,
    up: o.up,
    fovY: 45 * DEG,
    aspect: 16 / 9,
    viewportHeight,
    radius: R,
    exaggeration: STRATEGIC_EXAGGERATION,
    // Peaks about 1.4 km, at 4×.
    maxHeight: 1400 * STRATEGIC_EXAGGERATION,
  };
  const sel = selectTiles(
    view,
    () => true,
    { ...DEFAULT_LOD, maxLevel: STRATEGIC_MAX_LEVEL },
    () => [0, 1400 * STRATEGIC_EXAGGERATION],
  );
  const deepest = Math.max(...sel.draw.map((d) => d.tile.level));
  return { drawn: sel.draw.length, deepest };
}

describe('strategic relief tile budget', () => {
  it('draws few tiles from the ceiling to the floor at 1080p', () => {
    for (const h of [STRATEGIC_CEILING, 1500 * KM, 800 * KM, 400 * KM, 200 * KM, STRATEGIC_FLOOR]) {
      const { drawn } = select(h, 1080);
      // Part II: under 300 draw calls for the whole map; the relief takes a third at most.
      expect(drawn).toBeGreaterThan(0);
      expect(drawn).toBeLessThan(100);
    }
    expect(select(STRATEGIC_CEILING, 1080).deepest).toBeLessThanOrEqual(2);
  });

  it('reaches the cap at the floor on 1080p and never passes it at 2160 CSS pixels', () => {
    // LOD counts CSS pixels: a 4K laptop at a pixel ratio of 2 is 1080 tall here, so
    // 2160 is a 4K monitor at ratio 1, the worst case (about 150 tiles).
    expect(select(STRATEGIC_FLOOR, 1080).deepest).toBe(STRATEGIC_MAX_LEVEL);
    const uhd = select(STRATEGIC_FLOOR, 2160);
    expect(uhd.deepest).toBe(STRATEGIC_MAX_LEVEL);
    expect(uhd.drawn).toBeLessThan(200);
  });
});
