/**
 * The sky-view LUT on Dawn (decision 140): baked by its compute pass and read
 * through `AtmosphereNodes.skyRadiance`, against the CPU reference
 * (model.ts, `skyRadiance`) at several sun elevations, camera heights and
 * view directions; and the LUT against the march it hands over to above the
 * simulation view's envelope.
 */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import { DEG, KM, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { IN_SCATTER_SCALE } from '../../src/render/sim/atmosphere/atmosphere';
import { gradeSky, skyRadiance } from '../../src/render/sim/atmosphere/model';
import { MARCH_FROM, MARCH_FULL } from '../../src/render/sim/atmosphere/skyView';
import { PlanetLighting, SUNSET_VIBRANCE } from '../../src/render/sim/lighting/planetLighting';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

/** View directions as (elevation, azimuth from the sun), degrees. */
const VIEWS: [number, number][] = [
  [90, 0],
  [60, 0],
  [60, 180],
  [30, 0],
  [30, 90],
  [30, 180],
  [12, 0],
  [12, 45],
  [12, 180],
  [5, 0],
  [5, 20],
  [5, 135],
  [2, 0],
  [2, 180],
  [0.7, 0],
  [0.7, 90],
];

const local = (elevation: number, azimuth: number): [number, number, number] => [
  Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
  Math.sin(elevation * DEG),
  Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
];

describe.skipIf(!gpu)('sky-view LUT (TSL on Dawn)', () => {
  it('matches the CPU reference at several sun elevations, heights and directions', async () => {
    const lighting = new PlanetLighting();
    // The reference is per unit illuminance: keep the light fixed through twilight.
    lighting.twilightAdaptation = false;
    const air = lighting.atmosphere;
    const head = await headlessRenderer(gpu!.device, 64, 64);

    // The camera stands on the +Y axis and the sun in the x–y plane, as in the reference's frame.
    const dirs = new Float32Array(VIEWS.length * 4);
    VIEWS.forEach(([e, az], i) => dirs.set([...local(e, az), 0], i * 4));
    const input = instancedArray(dirs, 'vec4');
    const output = instancedArray(VIEWS.length, 'vec4');
    const kernel = Fn(() => {
      output
        .element(instanceIndex)
        .assign(vec4(air.skyRadiance(input.element(instanceIndex).xyz), 1));
    })().compute(VIEWS.length);

    const worst = new Map<number, { relative: number; where: string }>();
    for (const altitude of [2, 1500, 9000, 20_000]) {
      for (const sunElevation of [60, 20, 5, 0, -3, -6, -12]) {
        const w = worst.get(sunElevation) ?? { relative: 0, where: '' };
        worst.set(sunElevation, w);
        const r = PLANET_RADIUS + altitude;
        const sun = local(sunElevation, 0);
        lighting.update(new Vec3d(0, r, 0), new Vec3d(...sun));
        expect(air.bakeSky(head.renderer)).toBe(true);
        await head.renderer.computeAsync(kernel);
        const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
        const scale = lighting.sunIlluminance.value * IN_SCATTER_SCALE;
        // The brightest reference value of this sky: errors count relative to the larger of
        // the pixel's own value and 2% of it, so black corners of a twilight sky do not
        // dominate with differences nobody can see.
        // The lighting grades the sky at low sun (`vibrance`); the reference takes the same grade.
        const reference = VIEWS.map(([e, az]) =>
          gradeSky(
            skyRadiance(air.params, air.tables, r, local(e, az), sun, 400),
            air.vibrance.value,
          ).map((x) => x * scale),
        );
        const peak = Math.max(...reference.flat());
        VIEWS.forEach(([e, az], i) => {
          for (let c = 0; c < 3; c++) {
            const want = reference[i]![c]!;
            const got = out[i * 4 + c]!;
            const error = Math.abs(got - want) / Math.max(want, 0.02 * peak);
            if (error > w.relative) {
              w.relative = error;
              w.where = `altitude ${altitude} m, view ${e}°/${az}°, channel ${c}: ${got} vs ${want}`;
            }
          }
        });
      }
    }
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    for (const [sunElevation, w] of worst) {
      console.log(
        `sky-view LUT, sun ${sunElevation}°: worst ${(w.relative * 100).toFixed(2)}% at ${w.where}`,
      );
      // By day 2%: the LUT's interpolation, half floats, and 48 samples against 400. With
      // the sun below the horizon 8%: the edge of the planet's shadow opposite the sun is
      // sharper than the LUT's rows there (0.65°), which soften it.
      expect(w.relative).toBeLessThan(sunElevation >= 0 ? 0.02 : 0.08);
    }
  }, 240_000);

  it('is smooth at the horizon and around the sun: no texel structure', async () => {
    const lighting = new PlanetLighting();
    lighting.twilightAdaptation = false;
    const air = lighting.atmosphere;
    const head = await headlessRenderer(gpu!.device, 64, 64);
    // Sweeps in steps of 0.05° (a third of a pixel of a 1080-line, 50° view): up from the
    // horizon at four azimuths, and across the sun at its own elevation.
    const step = 0.05;
    const sweeps: [number, number][][] = [];
    for (const azimuth of [0, 6, 90, 180]) {
      const sweep: [number, number][] = [];
      for (let e = 0.1; e < 25; e += step) sweep.push([e, azimuth]);
      sweeps.push(sweep);
    }
    const across: [number, number][] = [];
    for (let az = -15; az <= 15; az += step) across.push([Number.NaN, az]);
    sweeps.push(across);
    const count = sweeps.reduce((n, sweep) => n + sweep.length, 0);
    const dirs = new Float32Array(count * 4);
    const input = instancedArray(dirs, 'vec4');
    const output = instancedArray(count, 'vec4');
    const kernel = Fn(() => {
      output
        .element(instanceIndex)
        .assign(vec4(air.skyRadiance(input.element(instanceIndex).xyz), 1));
    })().compute(count);

    const worst: {
      sunElevation: number;
      graded: boolean;
      jump: number;
      kink: number;
      where: string;
    }[] = [];
    // Each low sun twice: as computed, which shows the LUT's own structure, and graded as
    // the lighting grades it (`vibrance`), which is what reaches the screen.
    const cases: [number, boolean][] = [
      [35, false],
      [4, false],
      [-5, false],
      [4, true],
      [-5, true],
    ];
    for (const [sunElevation, graded] of cases) {
      lighting.sunsetVibrance = graded ? SUNSET_VIBRANCE : 1;
      let k = 0;
      for (const sweep of sweeps) {
        for (const [e, az] of sweep) {
          dirs.set([...local(Number.isNaN(e) ? Math.max(sunElevation, 1.5) : e, az), 0], k * 4);
          k++;
        }
      }
      input.value.needsUpdate = true;
      lighting.update(new Vec3d(0, PLANET_RADIUS + 300, 0), new Vec3d(...local(sunElevation, 0)));
      air.bakeSky(head.renderer);
      await head.renderer.computeAsync(kernel);
      const out = new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
      expect(air.vibrance.value > 1).toBe(graded);
      const w = { sunElevation, graded, jump: 0, kink: 0, where: '' };
      let offset = 0;
      sweeps.forEach((sweep, index) => {
        for (let i = 1; i < sweep.length - 1; i++) {
          const at = (j: number, c: number) => out[(offset + j) * 4 + c]!;
          // Against the pixel's brightness, as the eye judges it: a channel that is
          // nearly absent (red inside the planet's shadow) may change by any ratio.
          const level = (at(i, 0) + at(i, 1) + at(i, 2)) / 3;
          for (let c = 0; c < 3; c++) {
            const jump = Math.abs(at(i + 1, c) - at(i, c)) / level;
            const kink = Math.abs(at(i - 1, c) - 2 * at(i, c) + at(i + 1, c)) / level;
            if (kink > w.kink) w.where = `sweep ${index}, sample ${i}, channel ${c}`;
            w.jump = Math.max(w.jump, jump);
            w.kink = Math.max(w.kink, kink);
          }
        }
        offset += sweep.length;
      });
      worst.push(w);
    }
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    for (const w of worst) {
      console.log(
        `sky smoothness per 0.05°, sun ${w.sunElevation}°${w.graded ? ', graded' : ''}: largest change ${(w.jump * 100).toFixed(2)}%, largest bend ${(w.kink * 100).toFixed(3)}% (${w.where})`,
      );
      // By day a third of a pixel never changes the sky by more than 3% (the glow low
      // toward a low sun is that steep), and where the slope changes from one texel to
      // the next the bend is under 0.3% of the brightness: less than one 8-bit step,
      // which the pipeline's dither covers. In twilight the edge of the planet's shadow
      // opposite the sun is steeper than the LUT's rows resolve (0.65° apart there):
      // it is drawn as a few straight ramps, with bends of up to 2%. The grade takes the
      // blue out of the orange next to a low sun: where that channel reaches zero its
      // slope ends, a bend of under 1% of the brightness in a channel that is gone.
      expect(w.jump).toBeLessThan(w.sunElevation >= 0 ? 0.03 : w.graded ? 0.07 : 0.05);
      expect(w.kink).toBeLessThan(w.sunElevation < 0 ? 0.02 : w.graded ? 0.01 : 0.003);
    }
  }, 240_000);

  it('hands over to the march without a step', async () => {
    const lighting = new PlanetLighting();
    lighting.twilightAdaptation = false;
    const air = lighting.atmosphere;
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const views: [number, number][] = [
      [80, 0],
      [40, 0],
      [40, 180],
      [15, 0],
      [15, 90],
      [5, 0],
      [5, 180],
      [0, 0],
      [0, 120],
      [-3, 0],
      [-3, 180],
    ];
    const dirs = new Float32Array(views.length * 4);
    views.forEach(([e, az], i) => dirs.set([...local(e, az), 0], i * 4));
    const input = instancedArray(dirs, 'vec4');
    const output = instancedArray(views.length, 'vec4');
    const kernel = Fn(() => {
      output
        .element(instanceIndex)
        .assign(vec4(air.skyRadiance(input.element(instanceIndex).xyz), 1));
    })().compute(views.length);
    const sky = async (altitude: number, blend: number, sunElevation: number) => {
      lighting.update(
        new Vec3d(0, PLANET_RADIUS + altitude, 0),
        new Vec3d(...local(sunElevation, 0)),
      );
      air.bakeSky(head.renderer);
      // Force the LUT (0) or the march (1) at this altitude.
      air.sky.marchBlend.value = blend;
      await head.renderer.computeAsync(kernel);
      return new Float32Array(await head.renderer.getArrayBufferAsync(output.value));
    };
    let worst = 0;
    let where = '';
    for (const sunElevation of [50, 8, -4]) {
      for (const altitude of [MARCH_FROM, 0.5 * (MARCH_FROM + MARCH_FULL), MARCH_FULL - 1]) {
        const lut = await sky(altitude, 0, sunElevation);
        const march = await sky(altitude, 1, sunElevation);
        let peak = 0;
        for (let i = 0; i < views.length * 4; i++) if (i % 4 < 3) peak = Math.max(peak, lut[i]!);
        views.forEach(([e, az], i) => {
          for (let c = 0; c < 3; c++) {
            const a = lut[i * 4 + c]!;
            const b = march[i * 4 + c]!;
            const error = Math.abs(a - b) / Math.max(a, b, 0.05 * peak);
            if (error > worst) {
              worst = error;
              where = `altitude ${altitude / KM} km, sun ${sunElevation}°, view ${e}°/${az}°, channel ${c}: LUT ${a} vs march ${b}`;
            }
          }
        });
      }
    }
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    console.log(`LUT against march: worst ${(worst * 100).toFixed(2)}% at ${where}`);
    // The cross-fade spreads this difference over 20 km of climb.
    expect(worst).toBeLessThan(0.08);
  }, 240_000);
});
