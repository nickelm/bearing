import { describe, expect, it } from 'vitest';
import {
  MIN_DWELL,
  PATIENCE,
  QualityGovernor,
  UP_DWELL,
  UP_DWELL_MOST,
} from '../src/render/common/qualityGovernor';
import { RenderScaleController } from '../src/render/common/renderScale';

const TARGET = 1000 / 30;

/**
 * A machine: frames cost `cost(scale, level)` ms, the render scale adapts as in
 * the app (unless `fixed`), and the governor sees every frame. With `refresh`
 * (Hz) the display shows whole refresh periods, as a real one does: a frame is
 * measured as the next multiple of the period. Returns the times and levels of
 * the governor's changes.
 */
function run(
  g: QualityGovernor,
  scale: RenderScaleController,
  cost: (scale: number, level: number, now: number) => number,
  seconds: number,
  options: { fixed?: boolean; from?: number; refresh?: number } = {},
): { at: number; level: number }[] {
  const changes: { at: number; level: number }[] = [];
  let now = options.from ?? 0;
  const end = now + seconds * 1000;
  const period = options.refresh ? 1000 / options.refresh : 0;
  while (now < end) {
    const work = cost(scale.scale, g.level, now);
    const ms = period > 0 ? Math.max(1, Math.ceil(work / period - 1e-9)) * period : work;
    now += ms;
    if (!options.fixed) scale.record(ms, now);
    const level = g.record({
      frameMs: ms,
      nowMs: now,
      targetMs: TARGET,
      scale: scale.scale,
      minScale: scale.minScale,
      maxScale: scale.maxScale,
      adaptive: !options.fixed,
    });
    if (level !== null) {
      changes.push({ at: now, level });
      // As the app does: the change's own slow frames do not count for the render scale,
      // which finds its place anew under the changed load.
      scale.reset(now);
    }
  }
  return changes;
}

/** Terrain and effects both cost by the pixel; the effects' cost falls with each step down. */
const pixelBound =
  (terrain: number, effects: readonly [number, number, number]) => (s: number, level: number) =>
    (terrain + effects[level]!) * s * s + 2;

describe('QualityGovernor', () => {
  it('leaves a fast machine at full quality', () => {
    const g = new QualityGovernor();
    const changes = run(g, new RenderScaleController(TARGET), () => 16.7, 120);
    expect(changes).toEqual([]);
    expect(g.level).toBe(0);
  });

  it('steps down while the render scale stays reduced, one step per dwell', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    // 110 ms at full scale and full quality: the scale falls to about a half.
    const changes = run(g, scale, pixelBound(70, [40, 34, 32]), 60);
    expect(changes.map((c) => c.level)).toEqual([1, 2]);
    expect(changes[0]!.at).toBeGreaterThanOrEqual(4000);
    expect(changes[1]!.at - changes[0]!.at).toBeGreaterThanOrEqual(MIN_DWELL);
    expect(g.level).toBe(2);
  });

  it('does not react to a short slow spell or to single hitches', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    // Two seconds of slow frames (tiles building), then fast again; a hitch every second.
    const changes = run(
      g,
      scale,
      (_s, _l, now) =>
        now < 2000 ? 90 : Math.floor(now / 1000) % 2 === 0 && now % 1000 < 17 ? 400 : 16.7,
      60,
    );
    expect(changes).toEqual([]);
  });

  it('steps back up when there is headroom at full scale, after the up-dwell', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    run(g, scale, pixelBound(70, [40, 34, 32]), 60);
    expect(g.level).toBe(2);
    // The weather clears: everything is cheap again.
    const changes = run(g, scale, () => 12, 60, { from: 60_000 });
    expect(changes.map((c) => c.level)).toEqual([1, 0]);
    // The scale must first climb back to its ceiling, then the headroom must last.
    expect(changes[0]!.at - 60_000).toBeGreaterThanOrEqual(UP_DWELL);
    expect(changes[1]!.at - changes[0]!.at).toBeGreaterThanOrEqual(UP_DWELL);
  });

  it('tries the step up from a level it holds without headroom, rarely, and takes it back', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    // Full quality needs a scale of 0.7; one step down runs at full scale near the target. The
    // frame time shows no headroom there, and on a display that shows whole refresh periods it
    // never would: so the step up is tried, after a long dwell, and given up when the
    // resolution gives way.
    const cost = pixelBound(20, [46, 9, 9]);
    const changes = run(g, scale, cost, 3600);
    expect(changes[0]!.level).toBe(1);
    const ups = changes.filter((c) => c.level === 0);
    expect(ups[0]!.at - changes[0]!.at).toBeGreaterThanOrEqual(PATIENCE * UP_DWELL);
    // Each one is taken back within seconds, and the next comes twice as late.
    for (const up of ups) {
      const back = changes.find((c) => c.at > up.at)!;
      expect(back.level).toBe(1);
      expect(back.at - up.at).toBeLessThan(MIN_DWELL + 3000);
    }
    const gaps = ups.slice(1).map((c, i) => c.at - ups[i]!.at);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]! * 1.5);
    expect(ups.length).toBeLessThanOrEqual(6);
    expect(g.level).toBe(1);
    expect(scale.scale).toBeGreaterThanOrEqual(0.9);
  });

  it('tries a step up ever more rarely when it never holds', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    // One step down leaves ample headroom, full quality drags the scale to 0.6: the worst case.
    const cost = pixelBound(10, [80, 4, 4]);
    const changes = run(g, scale, cost, 3600);
    const ups = changes.filter((c) => c.level === 0);
    const gaps = ups.slice(1).map((c, i) => c.at - ups[i]!.at);
    // Each failed step up doubles the wait, up to the most.
    for (let i = 1; i < gaps.length; i++)
      expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]! * 0.95);
    expect(gaps[0]!).toBeGreaterThanOrEqual(2 * UP_DWELL);
    expect(gaps[gaps.length - 1]!).toBeGreaterThanOrEqual(UP_DWELL_MOST);
    expect(g.level).toBe(1);
    expect(g.upDwell).toBe(UP_DWELL_MOST);
    // The second step down is never needed: the first one is enough.
    expect(changes.every((c) => c.level <= 1)).toBe(true);
    // In the end one attempt in five minutes: an hour holds some fifteen. Any two changes lie a
    // dwell apart.
    expect(ups.length).toBeLessThanOrEqual(16);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i]!.at - changes[i - 1]!.at).toBeGreaterThanOrEqual(MIN_DWELL - 100);
    }
    // Never more than one step at a time.
    let level = 0;
    for (const c of changes) {
      expect(Math.abs(c.level - level)).toBe(1);
      level = c.level;
    }
  });

  it('forgets the back-off once a step up has lasted', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    run(g, scale, pixelBound(10, [80, 4, 4]), 200);
    expect(g.level).toBe(1);
    expect(g.upDwell).toBeGreaterThan(UP_DWELL);
    // Now full quality is affordable: the next step up holds.
    run(g, scale, () => 12, 400, { from: 200_000 });
    expect(g.level).toBe(0);
    // A later struggle starts from the first up-dwell again.
    run(g, scale, pixelBound(70, [40, 34, 32]), 10, { from: 600_000 });
    expect(g.level).toBe(1);
    expect(g.upDwell).toBe(UP_DWELL);
  });

  it('goes by the frame time alone where the render scale is fixed', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    const down = run(g, scale, (_s, level) => [60, 45, 30][level]!, 30, { fixed: true });
    expect(down.map((c) => c.level)).toEqual([1, 2]);
    expect(scale.scale).toBe(1);
    // 30 ms is on the target but leaves no headroom: the level stays for the long dwell.
    expect(run(g, scale, () => 30, 35, { fixed: true, from: 30_000 })).toEqual([]);
    const up = run(g, scale, () => 15, 60, { fixed: true, from: 65_000 });
    expect(up.map((c) => c.level)).toEqual([1, 0]);
  });

  it('at a fixed scale, takes back a step up that leaves the frame time off the target', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    // On target two steps down, 40 ms one step down (over the target, not yet "over budget").
    const cost = (_s: number, level: number) => [60, 40, 30][level]!;
    const changes = run(g, scale, cost, 400, { fixed: true });
    expect(changes.slice(0, 2).map((c) => c.level)).toEqual([1, 2]);
    const ups = changes.filter((c, i) => i >= 2 && c.level === 1);
    expect(ups.length).toBeGreaterThanOrEqual(2);
    expect(ups[0]!.at - changes[1]!.at).toBeGreaterThanOrEqual(PATIENCE * UP_DWELL);
    for (const up of ups) {
      const back = changes.find((c) => c.at > up.at);
      if (back) {
        expect(back.level).toBe(2);
        expect(back.at - up.at).toBeLessThan(MIN_DWELL + 1000);
      }
    }
    expect(ups[1]!.at - ups[0]!.at).toBeGreaterThanOrEqual(2 * PATIENCE * UP_DWELL);
  });

  it('steps down at the floor of the render scale only while over budget', () => {
    const g = new QualityGovernor(1);
    const scale = new RenderScaleController(TARGET, 0.8, 1);
    // At the floor (0.8, above the struggle scale) and still slow.
    const changes = run(g, scale, (s) => 80 * s * s, 30);
    expect(scale.scale).toBe(0.8);
    expect(changes.map((c) => c.level)).toEqual([1]);
    // It has no further step.
    expect(run(g, scale, (s) => 80 * s * s, 30, { from: 30_000 })).toEqual([]);
  });

  it('does not flap when the frame time hovers at the threshold', () => {
    // A fixed scale, frames wandering ±12% around the over-budget line whatever the level
    // (a load the steps do not relieve): the governor may give way, and never comes back up.
    const wander = (now: number) => 1 + 0.12 * Math.sin(now / 370) * Math.cos(now / 1130);
    const g = new QualityGovernor();
    const fixed = run(
      g,
      new RenderScaleController(TARGET),
      (_s, _l, now) => TARGET * 1.15 * wander(now),
      600,
      { fixed: true },
    );
    expect(fixed.length).toBeLessThanOrEqual(2);
    for (let i = 0; i < fixed.length; i++) expect(fixed[i]!.level).toBe(i + 1);

    // The adaptive scale resting at the struggle scale, the frame time wandering around the
    // line under which the scale would climb. The first step relieves a tenth of the cost.
    const h = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    const full = (TARGET * 0.7) / (0.75 * 0.75);
    const adaptive = run(
      h,
      scale,
      (s, level, now) => full * (level > 0 ? 0.9 : 1) * s * s * wander(now),
      600,
    );
    expect(adaptive.length).toBeLessThanOrEqual(2);
    for (let i = 0; i < adaptive.length; i++) expect(adaptive[i]!.level).toBe(i + 1);
  });

  it('follows a load that comes and goes: down while it lasts, back up after it', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    // 10 ms frames, 50 ms from 20 s to 60 s whatever the resolution and the level, 10 ms again.
    const cost = (_s: number, _l: number, now: number) => (now >= 20_000 && now < 60_000 ? 50 : 10);
    const changes = run(g, scale, cost, 180);
    expect(changes.map((c) => c.level)).toEqual([1, 2, 1, 0]);
    // Down: after the dwell, one step at a time, and not before the load.
    expect(changes[0]!.at).toBeGreaterThanOrEqual(20_000 + 4000);
    expect(changes[0]!.at).toBeLessThan(20_000 + 12_000);
    expect(changes[1]!.at - changes[0]!.at).toBeGreaterThanOrEqual(MIN_DWELL);
    expect(changes[1]!.at).toBeLessThan(60_000);
    // Up: only once the render scale is back at its ceiling and the headroom has lasted.
    expect(changes[2]!.at).toBeGreaterThanOrEqual(60_000 + UP_DWELL);
    expect(changes[3]!.at - changes[2]!.at).toBeGreaterThanOrEqual(UP_DWELL);
    expect(changes[3]!.at).toBeLessThan(60_000 + 90_000);
    expect(scale.scale).toBe(1);
    expect(g.level).toBe(0);
  });

  it('ignores a load shorter than the dwell and a single long frame', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    // Three seconds at 50 ms; later one frame of three seconds (a shader compile).
    const cost = (_s: number, _l: number, now: number) =>
      now >= 20_000 && now < 23_000 ? 50 : now >= 40_000 && now < 40_010 ? 3000 : 10;
    expect(run(g, scale, cost, 120)).toEqual([]);
    // The same single frame on a machine near its limit, at a fixed scale.
    const h = new QualityGovernor();
    const near = (_s: number, _l: number, now: number) =>
      now >= 40_000 && now < 40_030 ? 3000 : TARGET * 1.1;
    expect(run(h, new RenderScaleController(TARGET), near, 120, { fixed: true })).toEqual([]);
  });

  describe('on a display that shows whole refresh periods', () => {
    // 60% of the frame is terrain and 40% effects, by the pixel; the steps take 30% and 40% of
    // the effects away. A slow spell (tiles building) from 20 s to 26 s costs four times as much.
    const machine = (full: number) => (s: number, level: number, now: number) =>
      ((full - 2) * (0.6 + 0.4 * [1, 0.7, 0.6][level]!) * s * s + 2) *
      (now >= 20_000 && now < 26_000 ? 4 : 1);

    it('comes back to full quality and resolution after a slow spell, at 60 and 120 Hz', () => {
      for (const refresh of [60, 120]) {
        // 12 ms: headroom to see. 20 and 28 ms: shown as 33 ms, the margin cannot be seen.
        for (const full of [12, 20, 28]) {
          const g = new QualityGovernor();
          const scale = new RenderScaleController(TARGET);
          const changes = run(g, scale, machine(full), 300, { refresh });
          expect(g.level, `${refresh} Hz, ${full} ms`).toBe(0);
          expect(scale.scale, `${refresh} Hz, ${full} ms`).toBe(1);
          // No flapping on the way: a few steps down in the spell, as many back up.
          expect(changes.length, `${refresh} Hz, ${full} ms`).toBeLessThanOrEqual(4);
        }
      }
    });

    it('does so where the browser caps the page at the target rate', () => {
      for (const full of [12, 20, 28]) {
        const g = new QualityGovernor();
        const scale = new RenderScaleController(TARGET);
        run(g, scale, machine(full), 300, { refresh: 30 });
        expect(g.level, `${full} ms`).toBe(0);
        expect(scale.scale, `${full} ms`).toBe(1);
      }
    });

    it('settles a machine that cannot hold full quality, with rare attempts', () => {
      // 40 ms at full scale and quality is shown as 50 ms at 60 Hz: something must give.
      const g = new QualityGovernor();
      const scale = new RenderScaleController(TARGET);
      const changes = run(g, scale, machine(40), 3600, { refresh: 60 });
      // After the first minutes the frame time holds the target.
      const late = changes.filter((c) => c.at > 600_000);
      expect(late.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < changes.length; i++) {
        expect(changes[i]!.at - changes[i - 1]!.at).toBeGreaterThanOrEqual(MIN_DWELL - 100);
        expect(Math.abs(changes[i]!.level - changes[i - 1]!.level)).toBe(1);
      }
      expect(scale.scale).toBeGreaterThanOrEqual(0.8);
    });
  });

  it('does not count the time away toward a dwell when the app holds it on return', () => {
    const g = new QualityGovernor();
    let now = 0;
    const frame = (ms: number) => {
      now += ms;
      return g.record({
        frameMs: ms,
        nowMs: now,
        targetMs: TARGET,
        scale: 1,
        minScale: 0.35,
        maxScale: 1,
        adaptive: false,
      });
    };
    // Two seconds of struggle, a minute in a hidden tab, then the app's hold (main.ts does it
    // on visibilitychange) and the minute-long frame: no step, and the dwell starts anew.
    for (let i = 0; i < 34; i++) expect(frame(60)).toBeNull();
    g.hold(now + 60_000);
    expect(frame(60_000)).toBeNull();
    const back = now;
    let stepped = -1;
    for (let i = 0; i < 200 && stepped < 0; i++) if (frame(60) !== null) stepped = now;
    expect(stepped - back).toBeGreaterThanOrEqual(4000);
  });

  it('starts over on hold and on reset', () => {
    const g = new QualityGovernor();
    const scale = new RenderScaleController(TARGET);
    let now = 0;
    const frame = (ms: number) => {
      now += ms;
      return g.record({
        frameMs: ms,
        nowMs: now,
        targetMs: TARGET,
        scale: scale.scale,
        minScale: scale.minScale,
        maxScale: scale.maxScale,
        adaptive: false,
      });
    };
    // Three seconds of struggle, a hold (the map was shown), three more: no step yet.
    for (let i = 0; i < 50; i++) expect(frame(60)).toBeNull();
    g.hold(now);
    for (let i = 0; i < 60; i++) expect(frame(60)).toBeNull();
    // Without the hold it comes within the dwell.
    let stepped = false;
    for (let i = 0; i < 40 && !stepped; i++) stepped = frame(60) !== null;
    expect(stepped).toBe(true);
    g.reset(now);
    expect(g.level).toBe(0);
    expect(g.average).toBe(0);
  });
});
