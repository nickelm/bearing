/**
 * Aerial perspective on Dawn (decision 140): the clear-air haze in front of
 * near ground against the full in-scattered light at the horizon, where
 * terrain must meet the sky; and the moonlit air by night.
 */
import { describe, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, vec4 } from 'three/tsl';
import { DEG, KM, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { aerialHazeGain, CLEAR_AIR_HAZE } from '../../src/render/sim/atmosphere/model';
import { PlanetLighting } from '../../src/render/sim/lighting/planetLighting';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';

const gpu = await testGpu();

const ALTITUDE = 5 * KM;
const R = PLANET_RADIUS;
/** Distance from the camera to the sea-level horizon. */
const HORIZON = Math.sqrt((R + ALTITUDE) ** 2 - R * R);

/**
 * Camera-relative position of the point of the sea-level sphere at distance
 * `d` from a camera on the +Y axis, at azimuth `az` (degrees) from +X.
 */
function seaLevelTarget(d: number, az: number): [number, number, number] {
  const r = R + ALTITUDE;
  // Law of cosines for the angle at the camera between the nadir and the target.
  const cosNadir = (r * r + d * d - R * R) / (2 * r * d);
  const sinNadir = Math.sqrt(Math.max(0, 1 - cosNadir * cosNadir));
  return [d * sinNadir * Math.cos(az * DEG), -d * cosNadir, d * sinNadir * Math.sin(az * DEG)];
}

const local = (elevation: number, azimuth: number): [number, number, number] => [
  Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
  Math.sin(elevation * DEG),
  Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
];

/** Distances along the ground, as shares of the distance to the horizon, by azimuth from the sun. */
const TARGETS: [number, number][] = [
  [0.05, 0],
  [0.1, 90],
  [0.2, 0],
  [0.2, 180],
  [0.4, 90],
  [0.6, 0],
  [0.6, 180],
  [0.9, 30],
  [0.9, 90],
  [0.9, 180],
];

describe.skipIf(!gpu)('aerial perspective (TSL on Dawn)', () => {
  it('shows the clear-air haze over near ground and meets the sky at the horizon', async () => {
    const lighting = new PlanetLighting();
    const air = lighting.atmosphere;
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const count = TARGETS.length;
    const points = new Float32Array(count * 4);
    TARGETS.forEach(([share, az], i) =>
      points.set([...seaLevelTarget(share * HORIZON, az), 0], i * 4),
    );
    const input = instancedArray(points, 'vec4');
    const scattered = instancedArray(count, 'vec4');
    const through = instancedArray(count, 'vec4');
    const sky = instancedArray(count, 'vec4');
    const kernel = Fn(() => {
      const relative = input.element(instanceIndex).xyz;
      const ap = air.aerialPerspective(relative);
      scattered.element(instanceIndex).assign(vec4(ap.inscatter.mul(air.u.sunIlluminance), 1));
      through.element(instanceIndex).assign(vec4(ap.transmittance, 1));
      // The sky-view LUT along the same ray: below the horizon it ends on the same ground.
      sky.element(instanceIndex).assign(vec4(air.skyRadiance(relative.normalize()), 1));
    })().compute(count);
    const run = async (haze: number) => {
      air.haze.value = haze;
      lighting.update(new Vec3d(0, R + ALTITUDE, 0), new Vec3d(...local(40, 0)));
      air.bakeSky(head.renderer);
      await head.renderer.computeAsync(kernel);
      const read = async (a: typeof scattered) =>
        new Float32Array(await head.renderer.getArrayBufferAsync(a.value));
      return {
        scattered: await read(scattered),
        through: await read(through),
        sky: await read(sky),
      };
    };
    const full = await run(1);
    const clear = await run(CLEAR_AIR_HAZE);
    head.dispose();
    expect(gpu!.errors).toEqual([]);

    TARGETS.forEach(([share, az], i) => {
      const blue = clear.through[i * 4 + 2]!;
      const gain = aerialHazeGain(blue);
      for (let c = 0; c < 3; c++) {
        const whole = full.scattered[i * 4 + c]!;
        expect(whole).toBeGreaterThan(0);
        // The haze is a factor on the consistent in-scattered light, set by the path's opacity.
        expect(clear.scattered[i * 4 + c]! / whole).toBeCloseTo(gain, 3);
        // The air's transmittance is not touched.
        expect(clear.through[i * 4 + c]).toBeCloseTo(full.through[i * 4 + c]!, 6);
      }
      if (share <= 0.1) {
        // A few kilometers of air: the clear-air share, a third of the light.
        expect(gain).toBeCloseTo(CLEAR_AIR_HAZE, 6);
      }
      if (share >= 0.9) {
        // Toward the horizon the air is opaque in blue: all of the light, which is the
        // sky's own along the same ray (the per-vertex march has 10 steps to the LUT's 48;
        // they agree within 0.5%).
        expect(gain).toBeGreaterThan(0.97);
        for (let c = 0; c < 3; c++) {
          const ratio = clear.scattered[i * 4 + c]! / clear.sky[i * 4 + c]!;
          expect(ratio, `target ${share} of the horizon at ${az}°, channel ${c}`).toBeGreaterThan(
            0.95,
          );
          expect(ratio).toBeLessThan(1.05);
        }
      }
    });
    // The share grows with distance and never steps.
    for (let d = 0.05; d < 1; d += 0.05) {
      expect(aerialHazeGain(Math.exp(-3 * (d + 0.05)))).toBeGreaterThanOrEqual(
        aerialHazeGain(Math.exp(-3 * d)),
      );
    }
  }, 240_000);

  it('adds the moonlit air by night and nothing by day', async () => {
    const lighting = new PlanetLighting();
    const air = lighting.atmosphere;
    air.haze.value = 1;
    const head = await headlessRenderer(gpu!.device, 64, 64);
    const targets: [number, number][] = [
      [0.3, 0],
      [0.6, 90],
      [0.9, 180],
    ];
    const count = targets.length;
    const points = new Float32Array(count * 4);
    targets.forEach(([share, az], i) =>
      points.set([...seaLevelTarget(share * HORIZON, az), 0], i * 4),
    );
    const input = instancedArray(points, 'vec4');
    const scattered = instancedArray(count, 'vec4');
    const sky = instancedArray(count, 'vec4');
    const kernel = Fn(() => {
      const relative = input.element(instanceIndex).xyz;
      const ap = air.aerialPerspective(relative);
      scattered.element(instanceIndex).assign(vec4(ap.inscatter.mul(air.u.sunIlluminance), 1));
      sky.element(instanceIndex).assign(vec4(air.skyRadiance(relative.normalize()), 1));
    })().compute(count);
    const run = async (sunElevation: number, moon: [number, number, number]) => {
      lighting.update(
        new Vec3d(0, R + ALTITUDE, 0),
        new Vec3d(...local(sunElevation, 0)),
        new Vec3d(...moon),
      );
      // No glow of the night sky's own in the LUT: the comparison is of the moonlit air.
      air.sky.setCelestial(lighting.sunElevation, 0, 1, 0, 0);
      air.bakeSky(head.renderer);
      await head.renderer.computeAsync(kernel);
      return {
        scattered: new Float32Array(await head.renderer.getArrayBufferAsync(scattered.value)),
        sky: new Float32Array(await head.renderer.getArrayBufferAsync(sky.value)),
      };
    };
    // By day the moon's place changes nothing.
    const dayA = await run(40, local(50, 180));
    const dayB = await run(40, local(20, 60));
    expect(lighting.moonIlluminance.value).toBe(0);
    for (let i = 0; i < count * 4; i++) expect(dayB.scattered[i]).toBe(dayA.scattered[i]);
    // By night under a full moon the air in front of the ground is lit, blue, and as bright
    // as the moonlit sky along the same ray; with the moon down it is dark.
    const night = await run(-50, local(50, 180));
    expect(lighting.moonIlluminance.value).toBeGreaterThan(0);
    const dark = await run(-50, local(-50, 180));
    head.dispose();
    expect(gpu!.errors).toEqual([]);
    targets.forEach((_, i) => {
      const [r, g, b] = [0, 1, 2].map((c) => night.scattered[i * 4 + c]!);
      expect(b!).toBeGreaterThan(g!);
      expect(g!).toBeGreaterThan(r!);
      expect(dark.scattered[i * 4 + 1]).toBeLessThan(0.02 * g!);
      for (let c = 0; c < 3; c++) {
        const ratio = night.scattered[i * 4 + c]! / night.sky[i * 4 + c]!;
        expect(ratio, `target ${i}, channel ${c}`).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
      }
    });
  }, 240_000);
});
