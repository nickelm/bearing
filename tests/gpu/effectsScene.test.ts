/**
 * The effects system inside the app's GlobeScene on Dawn (decision 326): its puffs, debris,
 * marks and ribbons compile and draw with the scene's full lighting (cloud and terrain
 * shadow hooks, the flash lights on every surface) without GPU errors, and a cut clears them.
 */
import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../../src/core/cubeGrid';
import { Vec3d } from '../../src/core/vec3d';
import { GlobeScene } from '../../src/render/sim/globeScene';
import { DEFAULT_PLANET_PARAMS } from '../../src/worldgen/params';
import { expectNoGpuErrors, testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

describe.skipIf(!gpu)('effects in the GlobeScene', () => {
  it('draws explosions, columns, trails and ribbons without GPU errors', async () => {
    const head = await headlessRenderer(gpu!.device, 256, 128);
    const R = DEFAULT_PLANET_PARAMS.radius;
    const scene = new GlobeScene(head.renderer, {
      radius: R,
      grid: new CubeGrid(16),
      input: false,
    });
    scene.resize(head.width, head.height);
    scene.render(0);
    await gpu!.finish();
    const fx = scene.effects;
    const at = new Vec3d(0, R, 0);
    await expectNoGpuErrors(gpu!, async () => {
      fx.explode(at, 87, 'ground');
      fx.explode(at.clone().scale((R + 300) / R), 10, 'air');
      fx.handle({
        type: 'fire-started',
        time: 0,
        key: 'depot',
        at: [0, R, 50],
        kind: 'fuel',
        intensity: 1,
      });
      for (let i = 0; i < 6; i++) {
        const p = new Vec3d(i * 50, R + 1000, 0);
        fx.trackMissile('m', 'solid', true, p, new Vec3d(600, 0, 0));
        fx.ribbons.trail('c', 'contrail', p, true, fx.time);
        scene.render(1 / 30);
        await gpu!.finish();
      }
    });
    expect(fx.stats.live).toBeGreaterThan(20);
    expect(fx.stats.debris).toBeGreaterThan(0);
    expect(fx.stats.marks).toBeGreaterThan(0);
    expect(fx.stats.ribbons).toBeGreaterThan(0);
    // A cut: the puffs go, the columns (state) stay.
    scene.resetAtmosphere();
    scene.render(1 / 30);
    await gpu!.finish();
    expect(fx.stats.live).toBe(0);
    expect(fx.stats.columns).toBe(1);
    scene.dispose();
    head.dispose();
  });
});
