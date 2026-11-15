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
    ): { changes: { at: number; scale: number }[]; slow: number; mean: number } {
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
      return { changes, slow: slow / frames, mean: now / frames };
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
        const { changes } = watch(c, spell, 240, refresh);
        expect(Math.min(...changes.map((x) => x.scale)), `${refresh} Hz`).toBeLessThan(0.75);
        expect(c.scale, `${refresh} Hz`).toBe(1);
        // Back at full scale within half a minute of the spell's end: its steps down did not
        // count against the scales they left. Under the 30 FPS cap a probe falls into the
        // spell and fails: the scale it tried waits its minute and must then hold for another.
        expect(changes[changes.length - 1]!.at, `${refresh} Hz`).toBeLessThan(
          refresh === 60 ? 56_000 : 26_000 + 150_000,
        );
      }
    });

    it('keeps its scale through single long frames, however the display paces them', () => {
      // A machine with time to spare whose display holds every frame on the target: Target
      // FPS 60 at 60 Hz, and a page capped at 30 frames per second. One frame of 2 to 4 targets
      // (a tile build, a shader compile, a collected heap) every 20 to 90 s. Each one used to
      // cost a step that came back only a minute later, down to the floor within minutes.
      const cases = [
        { fps: 60, refresh: 60, full: 6 },
        { fps: 60, refresh: 60, full: 14 },
        { fps: 30, refresh: 30, full: 12 },
        { fps: 30, refresh: 30, full: 25 },
        { fps: 30, refresh: 60, full: 28 },
      ];
      for (const { fps, refresh, full } of cases) {
        const target = 1000 / fps;
        for (const targets of [2, 2.5, 3, 3.5, 4, 12]) {
          for (const every of [20, 45, 90]) {
            const c = new RenderScaleController(target);
            let last = 0;
            const cost = (s: number, now: number) => {
              if (now - last < every * 1000) return (full - 2) * s * s + 2;
              last = now;
              return targets * target - 1;
            };
            const { changes } = watch(c, cost, 1800, refresh);
            const label = `${fps} FPS at ${refresh} Hz, ${full} ms, ${targets} targets / ${every} s`;
            expect(changes, label).toEqual([]);
            expect(c.scale, label).toBe(1);
          }
        }
      }
    });

    it('keeps its scale through two long frames in a row, and gives way to a burst', () => {
      const target = 1000 / 60;
      const burst = (n: number) => {
        const c = new RenderScaleController(target);
        // Every 30 s, n frames of 40 ms in a row on a 60 Hz display (shown as 50 ms).
        let since = 0;
        let left = 0;
        const cost = (_s: number, now: number) => {
          if (now - since >= 30_000) {
            since = now;
            left = n;
          }
          return left-- > 0 ? 40 : 6;
        };
        return watch(c, cost, 600, 60).changes;
      };
      expect(burst(2)).toEqual([]);
      // Six in a row are a tenth of a second of real load: the scale answers, and comes back.
      const six = burst(6);
      expect(six.length).toBeGreaterThan(0);
      expect(Math.min(...six.map((x) => x.scale))).toBeGreaterThanOrEqual(0.6);
    });

    it('climbs back through long frames that fall into its probes', () => {
      // After loading, the scale is low and climbs a step every two seconds while tiles still
      // stream in, on a page capped at 30 frames per second: here two frames of two targets
      // fall into every probe. Judged by the mean, such a probe failed, and the scale waited
      // a minute, then two, a step at a time, while the governor took the low scale for a
      // struggling machine.
      const streaming = (regular: (s: number) => number) => {
        let scale = Number.NaN;
        let changed = 0;
        return (s: number, _now: number, i: number) => {
          if (s !== scale) {
            scale = s;
            changed = i;
          }
          // The 13th and the 21st frame after a change: the 3rd and 11th a probe counts.
          const k = i - changed;
          return k === 12 || k === 20 ? 60 : regular(s);
        };
      };
      const c = new RenderScaleController(TARGET);
      c.set(0.5, 0);
      const { changes } = watch(
        c,
        streaming((s) => 10 * s * s + 2),
        40,
        30,
      );
      expect(c.scale).toBe(1);
      expect(changes.length).toBe(10);
      expect(changes.every((x, i) => x.scale > (changes[i - 1]?.scale ?? 0.5))).toBe(true);
      // A scale that the machine cannot hold still fails its probe, long frames or not.
      const d = new RenderScaleController(TARGET);
      const held = watch(d, streaming(holdsAt06), 300, 30);
      expect(d.scale).toBe(0.6);
      expect(held.changes.filter((x) => x.scale === 0.65).length).toBeGreaterThan(0);
      expect(held.changes.every((x) => x.scale >= 0.6 || x.at < 10_000)).toBe(true);
      expect(Math.max(...held.changes.filter((x) => x.at > 10_000).map((x) => x.scale))).toBe(0.65);
    });

    it('answers long frames that keep coming, though never three of twelve are slow', () => {
      // A load that comes as one long frame in six or in twelve (a job spread over frames, a
      // pass that runs every few frames) never has three slow frames among twelve, and yet the
      // frames are a fifth to a third too long on average: 21 to 25 frames per second for good
      // when only the count of slow frames let the scale step down.
      const cases = [
        { every: 6, long: 100, short: 28 },
        { every: 6, long: 130, short: 30 },
        { every: 12, long: 133, short: 32 },
      ];
      for (const { every, long, short } of cases) {
        // Where among the frames the long one falls decides whether a probe happens to pass
        // between two of them: every phase must come to rest.
        for (let phase = 0; phase < every; phase++) {
          for (const refresh of [0, 144]) {
            const c = new RenderScaleController(TARGET);
            // All of it in the pixels: every frame gets shorter with the scale.
            const cost = (s: number, _now: number, i: number) =>
              (((i + phase) % every === 0 ? long : short) - 2) * s * s + 2;
            const label = `${long} ms every ${every}th frame (phase ${phase}), else ${short} ms, ${refresh} Hz`;
            const start = watch(c, cost, 30, refresh);
            expect(c.scale, label).toBeLessThan(1);
            expect(start.changes[0]!.at, label).toBeLessThan(8000);
            // From then on the frames hold the target on average, within the tenth over it
            // that the controller lets pass everywhere, and the scale rests.
            const rest = watch(c, cost, 600, refresh);
            expect(rest.mean, label).toBeLessThanOrEqual(TARGET * 1.1);
            expect(rest.changes.length, label).toBeLessThanOrEqual(12);
            expect(c.scale, label).toBeGreaterThanOrEqual(0.7);
          }
        }
      }
    });

    it('takes such a step back where the long frames are not in the pixels', () => {
      // A page capped at 30 frames per second with time to spare, and a long frame every
      // twelfth whatever the scale (a heap collected over and over, tiles building): fewer
      // pixels shorten nothing. The step is taken back and tried again ever more rarely, so
      // the scale does not sink to its floor as it did when the smoothed frame time alone
      // decided. Also where the long frames come 14 to 26 frames apart, by chance: a window
      // with many of them sets the trial off, the next has fewer, and that is no gain.
      const spacing = [() => 12, (n: number) => 20 + Math.round(6 * noise(n))];
      for (const [k, gap] of spacing.entries()) {
        const c = new RenderScaleController(TARGET);
        let next = gap(0);
        let count = 0;
        const cost = (s: number, _now: number, i: number) => {
          if (i < next) return 10 * s * s + 2;
          next = i + gap(++count);
          return 133;
        };
        const { changes } = watch(c, cost, 1800, 30);
        const label = `spacing ${k}`;
        expect(changes.length, label).toBeGreaterThan(0);
        expect(c.scale, label).toBe(1);
        expect(Math.min(...changes.map((x) => x.scale)), label).toBeGreaterThanOrEqual(0.85);
        // After a few seconds, then 1, 2, 4 and 8 minutes later, then every ten: down and back.
        expect(changes.length, label).toBeLessThanOrEqual(12);
        expect(changes.filter((x) => x.at < 60_000).length, label).toBeLessThanOrEqual(2);
        for (let i = 0; i + 1 < changes.length; i += 2) {
          expect(changes[i]!.scale, label).toBeLessThan(1);
          expect(changes[i + 1]!.scale, label).toBe(1);
          expect(changes[i + 1]!.at - changes[i]!.at, label).toBeLessThan(6000);
        }
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
