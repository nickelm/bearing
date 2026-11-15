/**
 * When the coverage bake runs, with the key the app gives it (`CloudLayer.bake`), without a
 * GPU: a stand-in renderer counts the compute passes of each frame. At the real-time rate no
 * frame may carry more than one cube face after the first bake (decision 144), although the
 * weather texture blends its fields anew every 28 game seconds.
 */
import { describe, expect, it } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import { HOUR, PLANET_RADIUS } from '../src/core/units';
import { CloudLayer } from '../src/render/sim/clouds/cloudLayer';
import { WeatherTexture } from '../src/render/sim/clouds/weatherTexture';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import { newFrameData, WeatherView } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';

function setup() {
  const grid = new WeatherGrid();
  const view = new WeatherView(grid);
  view.add({ hour: 5, data: newFrameData(grid) });
  view.add({ hour: 6, data: newFrameData(grid) });
  const weather = new WeatherTexture();
  weather.setFrames(view);
  const clouds = new CloudLayer(PLANET_RADIUS, new PlanetLighting(), weather, 16);
  let passes = 0;
  const renderer = { compute: () => void passes++ } as unknown as WebGPURenderer;
  let now = 0;
  /** One frame at game time `t`; returns the cube faces it baked. */
  const frame = (t: number): number => {
    passes = 0;
    weather.update(view, t);
    clouds.time.value = t;
    clouds.bake(renderer, (now += 1000 / 60));
    return passes;
  };
  return { view, weather, clouds, frame };
}

describe('coverage bake cadence', () => {
  it('bakes one face per frame at the real-time rate, through the re-blends of the fields', () => {
    const { weather, clouds, frame } = setup();
    let t = 5 * HOUR + 10;
    expect(frame(t)).toBe(6);
    const fields = weather.fieldVersion;
    const perFrame = new Map<number, number>();
    // Three minutes at 60 frames per second.
    for (let i = 0; i < 180 * 60; i++) {
      const faces = frame((t += 1 / 60));
      perFrame.set(faces, (perFrame.get(faces) ?? 0) + 1);
    }
    // The fields were blended again six times (every 28.1 s), and each time the bake came.
    expect(weather.fieldVersion - fields).toBe(6);
    expect([...perFrame.keys()].sort()).toEqual([0, 1]);
    // Eighteen bakes by age (every 10 s) and up to six more for the fields, six frames each.
    expect(perFrame.get(1)! % 6).toBe(0);
    expect(perFrame.get(1)! / 6).toBeGreaterThanOrEqual(18);
    expect(perFrame.get(1)! / 6).toBeLessThanOrEqual(24);
    expect(clouds.baked.bakes).toBe(1 + perFrame.get(1)! / 6);
  });

  it('follows a re-blend within a frame, before the field has aged', () => {
    const { weather, frame } = setup();
    let t = 5 * HOUR + 10;
    frame(t);
    const fields = weather.fieldVersion;
    let waited = 0;
    while (weather.fieldVersion === fields) {
      // A frame that only finds the fields changed bakes one face, and never six.
      const before = weather.fieldVersion;
      const faces = frame((t += 1 / 60));
      if (weather.fieldVersion !== before) expect(faces).toBe(1);
      else expect(faces).toBeLessThanOrEqual(1);
      expect(++waited).toBeLessThan(60 * 60);
    }
  });

  it('still bakes all six at once for new frames, new settings and a fast clock', () => {
    const { view, weather, clouds, frame } = setup();
    let t = 5 * HOUR + 10;
    expect(frame(t)).toBe(6);
    for (let i = 0; i < 30; i++) expect(frame((t += 1 / 60))).toBe(0);
    // New frames from the sim.
    weather.setFrames(view);
    expect(frame((t += 1 / 60))).toBe(6);
    for (let i = 0; i < 30; i++) expect(frame((t += 1 / 60))).toBe(0);
    // A setting of the cloud field.
    clouds.coverageBias.value += 0.1;
    expect(frame((t += 1 / 60))).toBe(6);
    for (let i = 0; i < 30; i++) expect(frame((t += 1 / 60))).toBe(0);
    // The clock at 600×: ten game seconds a frame, where a spread bake would not fit together.
    let whole = 0;
    for (let i = 0; i < 60; i++) {
      const faces = frame((t += 10));
      expect([0, 6]).toContain(faces);
      if (faces === 6) whole++;
    }
    expect(whole).toBeGreaterThanOrEqual(8);
  });
});
