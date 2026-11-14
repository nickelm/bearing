import { describe, expect, it } from 'vitest';
import { RenderScaleController } from '../src/render/common/renderScale';

/** Runs frames whose time is `cost(scale)` ms; returns the scale after `seconds`. */
function run(c: RenderScaleController, cost: (scale: number) => number, seconds: number): number {
  let now = 0;
  while (now < seconds * 1000) {
    const ms = cost(c.scale);
    now += ms;
    c.record(ms, now);
  }
  return c.scale;
}

describe('RenderScaleController', () => {
  it('lowers the scale until a pixel-bound frame meets the target', () => {
    const c = new RenderScaleController(1000 / 30);
    // 120 ms at full scale, shading cost ∝ pixels (scale²).
    const scale = run(c, (s) => 120 * s * s + 2, 20);
    const frame = 120 * scale * scale + 2;
    expect(frame).toBeLessThan((1000 / 30) * 1.1);
    expect(scale).toBeGreaterThan(0.4);
  });

  it('stays at full scale when frames are fast, and climbs back after a slow spell', () => {
    const c = new RenderScaleController(1000 / 30);
    expect(run(c, () => 16.7, 5)).toBe(1);
    run(c, () => 80, 5);
    expect(c.scale).toBeLessThan(1);
    expect(run(c, () => 16.7, 30)).toBe(1);
  });

  it('settles instead of oscillating near the target', () => {
    const c = new RenderScaleController(1000 / 30);
    run(c, (s) => 60 * s * s, 20);
    const changes: number[] = [];
    let now = 0;
    for (let i = 0; i < 2000; i++) {
      const ms = 60 * c.scale * c.scale;
      now += ms;
      const s = c.record(ms, now);
      if (s !== null) changes.push(s);
    }
    expect(changes.length).toBeLessThanOrEqual(4);
  });

  it('keeps its scale through the one long frame after a hidden tab', () => {
    const c = new RenderScaleController(1000 / 30);
    expect(run(c, () => 16.7, 5)).toBe(1);
    // A minute away: the next frame's time is the minute.
    let now = 5000 + 60_000;
    expect(c.record(60_000, now)).toBeNull();
    for (let i = 0; i < 300; i++) {
      now += 16.7;
      expect(c.record(16.7, now)).toBeNull();
    }
    expect(c.scale).toBe(1);
    // The same in the middle of a struggle: the scale it had found stays.
    const d = new RenderScaleController(1000 / 30);
    const found = run(d, (s) => 120 * s * s + 2, 20);
    now = 20_000 + 60_000;
    d.record(60_000, now);
    for (let i = 0; i < 120; i++) {
      const ms = 120 * d.scale * d.scale + 2;
      now += ms;
      d.record(ms, now);
    }
    expect(Math.abs(d.scale - found)).toBeLessThanOrEqual(0.051);
  });

  it('never leaves its range', () => {
    const c = new RenderScaleController(1000 / 30, 0.35, 1);
    expect(run(c, () => 1000, 30)).toBe(0.35);
  });
});
