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

  describe('probes', () => {
    const TARGET = 1000 / 30;
    /**
     * A machine on a display: frames cost `cost(scale, now, i)` ms and are shown for whole
     * refresh periods (`refresh` Hz; 0 = as they come). Returns the times and scales of the
     * controller's changes and the share of frames slower than 1.15 targets.
     */
    function watch(
      c: RenderScaleController,
      cost: (scale: number, now: number, i: number) => number,
      seconds: number,
      refresh = 0,
    ): { changes: { at: number; scale: number }[]; slow: number } {
      const period = refresh > 0 ? 1000 / refresh : 0;
      const changes: { at: number; scale: number }[] = [];
      let now = 0;
      let frames = 0;
      let slow = 0;
      while (now < seconds * 1000) {
        const work = cost(c.scale, now, frames);
        const ms = period > 0 ? Math.max(1, Math.ceil(work / period - 1e-9)) * period : work;
        now += ms;
        frames++;
        if (ms > TARGET * 1.15) slow++;
        const scale = c.record(ms, now);
        if (scale !== null) {
          // As the app does with a new scale (main.ts, applyRenderScale).
          c.set(scale, now);
          changes.push({ at: now, scale });
        }
      }
      return { changes, slow: slow / frames };
    }
    /** Noise in −1..1, the same on every run. */
    const noise = (i: number) => {
      const x = Math.sin(i * 12.9898) * 43758.5453;
      return (x - Math.floor(x)) * 2 - 1;
    };
    /** Holds the target at a scale of 0.6 and not at 0.65 (39 ms there). */
    const holdsAt06 = (s: number) => 90.6 * s * s + 0.7;

    it('climbs back after a slow spell where the display hides the headroom', () => {
      // 20 ms at full scale is shown as 33 ms at 60 Hz and under a 30 FPS cap: never under
      // 70% of the target. Tiles build from 20 s to 26 s at four times the cost.
      const spell = (s: number, now: number) =>
        (18 * s * s + 2) * (now >= 20_000 && now < 26_000 ? 4 : 1);
      for (const refresh of [60, 30]) {
        const c = new RenderScaleController(TARGET);
        const { changes } = watch(c, spell, 120, refresh);
        expect(Math.min(...changes.map((x) => x.scale)), `${refresh} Hz`).toBeLessThan(0.75);
        expect(c.scale, `${refresh} Hz`).toBe(1);
        // Back at full scale within half a minute of the spell's end: its steps down, the
        // first of them small, did not count against the scales they left.
        expect(changes[changes.length - 1]!.at, `${refresh} Hz`).toBeLessThan(56_000);
      }
    });

    it('tries a scale it cannot hold ever more rarely: the worst case of a steady machine', () => {
      for (const refresh of [0, 60, 30]) {
        const c = new RenderScaleController(TARGET);
        const { changes, slow } = watch(c, holdsAt06, 3600, refresh);
        expect(c.scale, `${refresh} Hz`).toBe(0.6);
        // Every probe to 0.65 fails and is taken back within a second and a half.
        const probes = changes.filter((x) => x.scale === 0.65);
        for (const probe of probes) {
          const back = changes.find((x) => x.at > probe.at)!;
          expect(back.scale).toBe(0.6);
          expect(back.at - probe.at).toBeLessThan(1500);
        }
        // After 2 s, then 1, 2, 4 and 8 minutes later, then every ten minutes.
        expect(probes.length, `${refresh} Hz`).toBeLessThanOrEqual(10);
        expect(probes.filter((x) => x.at < 60_000).length, `${refresh} Hz`).toBe(1);
        expect(probes.filter((x) => x.at < 600_000).length, `${refresh} Hz`).toBeLessThanOrEqual(4);
        const late = probes.filter((x) => x.at > 900_000).map((x) => x.at);
        for (let i = 1; i < late.length; i++) {
          expect(late[i]! - late[i - 1]!).toBeGreaterThanOrEqual(599_000);
        }
        // Under half a percent of all frames are slow, and nothing else ever changes.
        expect(slow, `${refresh} Hz`).toBeLessThan(0.005);
        expect(changes.every((x) => x.scale === 0.6 || x.scale === 0.65)).toBe(true);
      }
    });

    it('does not chase a load that wanders or frames that are noisy', () => {
      const loads: ((s: number, now: number, i: number) => number)[] = [
        // The view's cost goes up and down by 6% every 5 s, with 4% of noise.
        (s, now, i) =>
          (84 * s * s + 0.8) * (1 + 0.06 * Math.sin((now / 5000) * 2 * Math.PI) + 0.04 * noise(i)),
        // By 10% every 8 s and every 40 s.
        (s, now) => (84 * s * s + 0.8) * (1 + 0.1 * Math.sin((now / 8000) * 2 * Math.PI)),
        (s, now) => (84 * s * s + 0.8) * (1 + 0.1 * Math.sin((now / 40_000) * 2 * Math.PI)),
        // Steady, with 15% of noise.
        (s, _now, i) => holdsAt06(s) * (1 + 0.15 * noise(i)),
      ];
      for (const [k, load] of loads.entries()) {
        for (const refresh of [0, 60, 144, 30]) {
          const c = new RenderScaleController(TARGET);
          const { changes, slow } = watch(c, load, 1800, refresh);
          const label = `load ${k} at ${refresh} Hz`;
          // The scale changed every 2.5 s here before a small step down counted as a failure.
          expect(changes.length, label).toBeLessThanOrEqual(20);
          expect(changes.filter((x) => x.at > 600_000).length, label).toBeLessThanOrEqual(6);
          expect(slow, label).toBeLessThan(0.005);
          expect(c.scale, label).toBeGreaterThanOrEqual(0.5);
        }
      }
    });

    it('follows a load that comes and goes by a quarter no more often than without probes', () => {
      // ±25% over a minute: under 70% of the target in the trough, over 110% at the crest. The
      // scale goes up a step or two and down again each minute; probes must not add to that.
      const wave = (s: number, now: number) =>
        (84 * s * s + 0.8) * (1 + 0.25 * Math.sin((now / 60_000) * 2 * Math.PI));
      const c = new RenderScaleController(TARGET);
      const { changes, slow } = watch(c, wave, 1800);
      expect(changes.length).toBeLessThanOrEqual(30 * 4 + 6);
      expect(slow).toBeLessThan(0.002);
    });

    it('forgets a failed scale once the load has gone, and starts anew on reset', () => {
      // Too much for 0.65 during the first five minutes, then light enough for full scale, on
      // a display that hides the difference.
      const c = new RenderScaleController(TARGET);
      const eases = (s: number, now: number) => (now < 300_000 ? holdsAt06(s) : 20 * s * s + 2);
      const { changes } = watch(c, eases, 900, 60);
      expect(c.scale).toBe(1);
      expect(changes.every((x, i) => i === 0 || x.at - changes[i - 1]!.at >= 400)).toBe(true);
      // The app resets the controller when the load changes: no waiting then.
      const d = new RenderScaleController(TARGET);
      watch(d, holdsAt06, 200, 60);
      expect(d.scale).toBe(0.6);
      d.reset(0);
      const after = watch(d, (s) => 20 * s * s + 2, 40, 60);
      expect(d.scale).toBe(1);
      expect(after.changes.length).toBeLessThanOrEqual(8);
    });
  });

  it('never leaves its range', () => {
    const c = new RenderScaleController(1000 / 30, 0.35, 1);
    expect(run(c, () => 1000, 30)).toBe(0.35);
  });
});
