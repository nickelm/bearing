/**
 * The moving map's elevation modes (decision 227): Part I's tints, the relative classes,
 * contours, the mode button and the fallback to the chart.
 */
import { describe, expect, it } from 'vitest';
import { relativeClass, tint, elevationItems } from '../src/ui/displays/elevation';
import type { SnapshotTerrain } from '../src/ui/displays/snapshot';
import { applyUi, initialDisplayState } from '../src/ui/displays/presets';
import { displayModel } from '../src/ui/displays/formats';
import { initialAvionics } from '../src/sim/avionics/avionics';
import { AVIONICS_PROFILES } from '../src/sim/avionics/profiles';
import type { AircraftSnapshot } from '../src/ui/displays/snapshot';

/** A slope rising from the sea at the left to 1,200 m at the right, at 600 m in the middle. */
function slope(n = 20, half = 20 * 1852, altitude = 600): SnapshotTerrain {
  const heights: number[] = [];
  const water: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const h = i < 2 ? 0 : (i / (n - 1)) * 1200;
      heights.push(h);
      water.push(i < 2 ? 1 : 0);
    }
  return { n, halfExtent: half, rotation: 0, heights, water, altitude };
}
const cell = (items: ReturnType<typeof elevationItems>, n: number, i: number, j: number) => {
  const r = items[0]!;
  if (r.kind !== 'raster' || !r.colors) throw new Error('no raster');
  return r.colors[(n - 1 - j) * n + i]!;
};

describe('elevation tints and classes (decision 227)', () => {
  it("follow Part I's stops", () => {
    expect(tint(0)).toBe(0x5e7f5a);
    expect(tint(500)).toBe(0x8a9a62);
    expect(tint(4000)).toBe(0xd8d4cc);
    expect(tint(9000)).toBe(0xd8d4cc);
    const mid = tint(750);
    expect(mid).not.toBe(0x8a9a62);
    expect(mid).not.toBe(0xb5a46e);
  });

  it('class terrain against the aircraft: above, within 500 ft below, clear', () => {
    expect(relativeClass(1000, 900)).toBe('above');
    expect(relativeClass(800, 900)).toBe('near');
    expect(relativeClass(700, 900)).toBe('clear');
  });

  it('paint water, the hatch above the aircraft and amber just below it', () => {
    const t = slope();
    const rel = elevationItems(t, 'relative', false);
    expect(cell(rel, 20, 0, 5)).toBe(0x3d5a73);
    // Right edge, 1,200 m against 600 m: red, hatched (two shades along a row).
    const reds = new Set([cell(rel, 20, 18, 5), cell(rel, 20, 19, 5), cell(rel, 20, 18, 6)]);
    expect(reds.size).toBe(2);
    expect(reds.has(0xd9483b)).toBe(true);
    // Elevation mode marks the top with a spot height.
    const el = elevationItems(t, 'elevation', false);
    expect(el.some((i) => i.kind === 'text' && i.text === '3940')).toBe(true);
    expect(JSON.parse(JSON.stringify(el))).toEqual(el);
  });
});

describe('the map mode (decision 227)', () => {
  const snap = (terrain: SnapshotTerrain | null): AircraftSnapshot =>
    ({
      time: 0,
      kind: 'jet',
      name: 'x',
      profile: AVIONICS_PROFILES['alliance-fighter']!,
      avionics: initialAvionics(false),
      onGround: false,
      position: { lat: 0.8, lon: 0.3, radius: 1e6 },
      destination: null,
      track: 0,
      heading: 0,
      cas: 200,
      groundSpeed: 200,
      radarAltitude: 1000,
      fuel: { mass: 1, capacity: 1, unlimited: true, joker: 0, bingo: 0 },
      engine: { lever: 0.5, power: 0.5, afterburner: 0 },
      gear: { position: 0, down: false, fixed: false, overspeed: false },
      speedbrake: 0,
      brakes: false,
      parkingBrake: false,
      rotor: null,
      holds: [],
      control: 'mouse aim',
      mouseFree: false,
      messages: [],
      sensors: null,
      terrain,
    }) as AircraftSnapshot;

  it('steps chart, elevation, relative on its button, and draws the chart until heights come', () => {
    const s = snap(null);
    let d = initialDisplayState(s);
    expect(displayModel(s, d, 'leftMfd')!.buttons[7]).toMatchObject({ label: 'CHRT' });
    d = applyUi(d, s, { type: 'map-mode', slot: 'leftMfd' });
    const waiting = displayModel(s, d, 'leftMfd')!;
    expect(waiting.buttons[7]).toMatchObject({ label: 'ELEV', active: true });
    expect(waiting.items.some((i) => i.kind === 'map')).toBe(true);
    const ready = displayModel(snap(slope()), d, 'leftMfd')!;
    expect(ready.items.some((i) => i.kind === 'raster')).toBe(true);
    expect(ready.items.some((i) => i.kind === 'map')).toBe(false);
    d = applyUi(applyUi(d, s, { type: 'map-mode', slot: 'leftMfd' }), s, {
      type: 'map-mode',
      slot: 'leftMfd',
    });
    expect(d.map.mode).toBe('chart');
  });
});

describe('moving map ranges by skin (decision 227)', () => {
  it('steps in nautical miles for the Alliance and round kilometers for the Pact', async () => {
    const { mapRange } = await import('../src/ui/displays/formats');
    expect([0, 1, 2, 3, 4, 5].map((i) => mapRange('alliance', i) / 1852)).toEqual([
      5, 10, 20, 40, 80, 160,
    ]);
    expect([0, 1, 2, 3, 4, 5].map((i) => mapRange('pact', i) / 1000)).toEqual([
      10, 20, 40, 80, 150, 300,
    ]);
  });
});
