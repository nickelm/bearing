import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG } from '../src/core/units';
import { ObserverCamera } from '../src/render/sim/camera/observerCamera';
import { localFrame } from '../src/render/sim/infra/infraScene';
import { sliderValue, STICK_DEAD_ZONE, stickValue } from '../src/ui/touchControls';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const R = DEFAULT_PLANET_PARAMS.radius;

describe('touch stick and slider', () => {
  it('maps a push up to forward and right to right, within the unit disk', () => {
    const up = stickValue(0, -40, 40);
    expect(up.forward).toBeCloseTo(1, 9);
    expect(up.right).toBeCloseTo(0, 9);
    const r = stickValue(20, 0, 40);
    expect(r.right).toBeGreaterThan(0);
    expect(r.right).toBeLessThan(1);
    expect(r.forward).toBeCloseTo(0, 9);
    const far = stickValue(300, 400, 40);
    expect(Math.hypot(far.forward, far.right)).toBeCloseTo(1, 9);
    expect(far.forward).toBeLessThan(0); // pushed down: backward
  });

  it('ignores a resting thumb in the dead zone and starts from zero beyond it', () => {
    expect(stickValue(3, 2, 40)).toEqual({ forward: 0, right: 0 });
    const just = stickValue(0, -(STICK_DEAD_ZONE * 40 + 0.4), 40);
    expect(just.forward).toBeGreaterThan(0);
    expect(just.forward).toBeLessThan(0.02);
  });

  it('climbs when pushed up, sinks when pushed down, and saturates', () => {
    expect(sliderValue(-50, 50)).toBeCloseTo(1, 9);
    expect(sliderValue(80, 50)).toBeCloseTo(-1, 9);
    expect(sliderValue(2, 50)).toBe(0);
    expect(sliderValue(-25, 50)).toBeGreaterThan(0);
  });
});

describe('observer on touch', () => {
  const station = {
    key: 's',
    label: 'S',
    kind: 'airbase' as const,
    side: 'alliance' as const,
    point: latLonToDirection(40 * DEG, 10 * DEG),
    facing: 0,
    height: 20,
    pitch: 0,
  };

  it('looks with a finger as with the mouse, and ignores a twist', () => {
    const c = new ObserverCamera(R);
    c.setStation(station);
    expect((c as { touchDrag?: unknown }).touchDrag).toBeUndefined();
    c.drag(100, 50, 0.001);
    expect(c.heading).toBeCloseTo(0.1, 9); // finger right: turn right
    expect(c.pitch).toBeCloseTo(-0.05, 9); // finger down: look down
    c.rotateAt();
    expect(c.heading).toBeCloseTo(0.1, 9); // a twist does not turn
  });

  it('walks and climbs from the on-screen controls, faster with ×5', () => {
    const c = new ObserverCamera(R);
    c.setStation(station);
    const { north } = localFrame(station.point);
    c.stick.forward = 1;
    c.update(1);
    const slow = c.spot.clone().sub(station.point).dot(north) * R;
    expect(slow).toBeCloseTo(80, 0);
    c.setStation(station);
    c.stick.boost = 1;
    c.update(1);
    expect(c.spot.clone().sub(station.point).dot(north) * R).toBeCloseTo(400, 0);
    c.stick.forward = 0;
    c.stick.climb = 1;
    const h = c.height;
    c.update(1);
    expect(c.height).toBeGreaterThan(h);
  });
});
