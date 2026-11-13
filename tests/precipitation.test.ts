import { describe, expect, it } from 'vitest';
import { float } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../src/core/coords';
import { DEG, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import {
  belowCloud,
  dustAtHeight,
  FALL_PERIOD,
  LAYER_SIDES,
  layerReach,
  MAX_DENSITY,
  PARTICLE_CAPS,
  PARTICLE_KINDS,
  particleCount,
  particleLight,
  particleLook,
  Precipitation,
  SPEED_STEPS,
  wrap,
  wrapParticle,
  WRAP_PERIOD,
} from '../src/render/sim/weather/precipitation';
import { WeatherState } from '../src/render/sim/weather/weatherState';
import type { WeatherReport } from '../src/sim/weather/frame';

/** Uniform numbers in [0, 1), repeatable. */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('particle wrapping', () => {
  const next = sequence(7);
  const speeds = [6, 7, 8, 9, 10].map((k) => k / SPEED_STEPS);

  it('keeps every particle in the cube around the center', () => {
    for (let k = 0; k < 2000; k++) {
      const side = LAYER_SIDES[k % 3]!;
      const center = (next() - 0.5) * side;
      const p = wrapParticle(
        next(),
        side,
        next() * WRAP_PERIOD,
        next() * FALL_PERIOD,
        speeds[k % 5]!,
        center,
      );
      expect(p).toBeGreaterThanOrEqual(center - side / 2 - 1e-9);
      expect(p).toBeLessThan(center + side / 2 + 1e-9);
    }
  });

  it('does not jump when the offsets wrap', () => {
    // The lattice's period suits every layer, the fall's every speed factor.
    for (const side of LAYER_SIDES) expect(WRAP_PERIOD % side).toBe(0);
    for (const speed of speeds) expect((FALL_PERIOD * speed) % WRAP_PERIOD).toBeCloseTo(0, 9);
    for (let k = 0; k < 2000; k++) {
      const side = LAYER_SIDES[k % 3]!;
      const speed = speeds[k % 5]!;
      const h = next();
      const drift = next() * WRAP_PERIOD;
      const fall = next() * FALL_PERIOD;
      const center = (next() - 0.5) * side;
      const p = wrapParticle(h, side, drift, fall, speed, center);
      // One step before the wrap and the wrapped value after it are the same place.
      expect(wrapParticle(h, side, drift + WRAP_PERIOD, fall, speed, center)).toBeCloseTo(p, 6);
      expect(wrapParticle(h, side, drift, fall + FALL_PERIOD, speed, center)).toBeCloseTo(p, 6);
      expect(wrap(drift + WRAP_PERIOD, WRAP_PERIOD)).toBeCloseTo(drift, 9);
      expect(wrap(-0.25, WRAP_PERIOD)).toBeCloseTo(WRAP_PERIOD - 0.25, 12);
    }
  });

  it('fixes particles in the world: the camera moves past them, and turning it moves none', () => {
    for (let k = 0; k < 2000; k++) {
      const side = LAYER_SIDES[k % 3]!;
      const speed = speeds[k % 5]!;
      const h = next();
      const drift = next() * WRAP_PERIOD;
      const fall = next() * FALL_PERIOD;
      const center = (next() - 0.5) * side;
      const p = wrapParticle(h, side, drift, fall, speed, center);
      // The camera moves by `step`: the lattice's offset from the eye shrinks by as much, and
      // the particle is seen `step` further back, or another copy of it one period on.
      const step = (next() - 0.5) * 3;
      const moved = wrapParticle(h, side, wrap(drift - step, WRAP_PERIOD), fall, speed, center);
      const shift = (moved - (p - step)) / side;
      expect(Math.abs(shift - Math.round(shift))).toBeLessThan(1e-9);
      expect(Math.abs(Math.round(shift))).toBeLessThanOrEqual(1);
      // The view turns (another center): the same lattice, so a copy a whole number of periods off.
      const turned = wrapParticle(h, side, drift, fall, speed, center + (next() - 0.5) * side);
      const periods = (turned - p) / side;
      expect(Math.abs(periods - Math.round(periods))).toBeLessThan(1e-9);
      // Falling for a while moves it by its own speed.
      const fallen = wrapParticle(h, side, drift, fall + 0.5, speed, center);
      const down = (fallen - (p + 0.5 * speed)) / side;
      expect(Math.abs(down - Math.round(down))).toBeLessThan(1e-9);
    }
  });

  it('draws as far as the view fits into the cube ahead', () => {
    for (const [fov, aspect] of [
      [45, 16 / 9],
      [60, 16 / 9],
      [35, 4 / 3],
      [50, 21 / 9],
    ] as const) {
      const reach = layerReach(fov * DEG, aspect);
      expect(reach).toBeGreaterThan(0.35);
      expect(reach).toBeLessThanOrEqual(1);
      // The corners of the view at that distance lie within the cube centered half a side ahead.
      const ty = Math.tan((fov * DEG) / 2);
      const tx = ty * aspect;
      const l = Math.hypot(1, tx, ty);
      const corner = [(tx / l) * reach, (ty / l) * reach, reach / l];
      expect(Math.abs(corner[0]!)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(corner[1]!)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(corner[2]).toBeGreaterThanOrEqual(0);
      expect(reach).toBeLessThanOrEqual(1);
    }
    expect(layerReach(45 * DEG, 16 / 9)).toBeCloseTo(0.76, 2);
  });
});

describe('particle counts and looks', () => {
  it('draws nothing at zero and more with intensity, up to the cap', () => {
    for (const kind of PARTICLE_KINDS) {
      expect(particleCount(kind, 0)).toBe(0);
      expect(particleCount(kind, -1)).toBe(0);
      expect(particleCount(kind, Number.NaN)).toBe(0);
      expect(particleCount(kind, 0.5, 0)).toBe(0);
      let last = 0;
      for (let level = 0.02; level <= 1; level += 0.02) {
        const n = particleCount(kind, level);
        expect(n).toBeGreaterThanOrEqual(last);
        expect(n).toBeLessThanOrEqual(PARTICLE_CAPS[kind]);
        last = n;
      }
      expect(particleCount(kind, 1)).toBe(PARTICLE_CAPS[kind]);
      expect(particleCount(kind, 7)).toBe(PARTICLE_CAPS[kind]);
      // The quality factor scales the count, up to its limit.
      expect(particleCount(kind, 1, 0.5)).toBe(PARTICLE_CAPS[kind] / 2);
      expect(particleCount(kind, 1, 99)).toBe(PARTICLE_CAPS[kind] * MAX_DENSITY);
    }
    // Drizzle, rain and a skyfall are far apart.
    const drizzle = particleCount('rain', 0.2);
    const rain = particleCount('rain', 0.56);
    const skyfall = particleCount('rain', 1);
    expect(drizzle).toBeGreaterThan(3000);
    expect(rain).toBeGreaterThan(2.5 * drizzle);
    expect(skyfall).toBeGreaterThan(1.8 * rain);
    expect(skyfall).toBe(60_000);
    // Steady snow (1.2 mm/h) and a blizzard (3 mm/h) are well up their scale.
    expect(particleCount('snow', 0.33)).toBeGreaterThan(15_000);
    expect(particleCount('snow', 0.51)).toBeGreaterThan(particleCount('snow', 0.33) * 1.5);
  });

  it('makes drizzle fine, slow and short, and a skyfall heavy, fast and long', () => {
    const drizzle = particleLook('rain', 0.2);
    const rain = particleLook('rain', 0.56);
    const skyfall = particleLook('rain', 1);
    const length = (l: typeof rain) => l.fallSpeed * l.exposure;
    expect(drizzle.fallSpeed).toBeLessThan(3);
    expect(rain.fallSpeed).toBeGreaterThan(5);
    expect(skyfall.fallSpeed).toBeGreaterThan(9);
    expect(length(drizzle)).toBeLessThan(0.1);
    expect(length(rain)).toBeGreaterThan(2 * length(drizzle));
    expect(length(skyfall)).toBeGreaterThan(1.8 * length(rain));
    expect(drizzle.sizeMax).toBeLessThan(rain.sizeMax);
    expect(rain.sizeMax).toBeLessThan(skyfall.sizeMax);
    expect(drizzle.opacity).toBeLessThan(rain.opacity);
    expect(rain.opacity).toBeLessThan(skyfall.opacity);
    // Snow falls at 1 to 2 m/s whatever the intensity (speed factors 0.75 to 1.25), in flakes
    // of varied size, and sways more in a gale.
    const snow = particleLook('snow', 0.33, 2);
    expect(snow.fallSpeed * 0.75).toBeGreaterThanOrEqual(1);
    expect(snow.fallSpeed * 1.25).toBeLessThanOrEqual(2);
    expect(snow.sizeMax).toBeGreaterThan(2 * snow.sizeMin);
    expect(particleLook('snow', 0.5, 24).sway).toBeGreaterThan(snow.sway);
    // Dust does not fall: the wind carries it.
    expect(particleLook('dust', 0.9).fallSpeed).toBe(0);
    expect(particleLook('dust', 0.9).carried).toBeLessThan(1);
  });

  it('fades rain out through the cloud base and dust with height', () => {
    expect(belowCloud(0, 600)).toBe(1);
    expect(belowCloud(500, 600)).toBe(1);
    expect(belowCloud(700, 600)).toBeGreaterThan(0.2);
    expect(belowCloud(700, 600)).toBeLessThan(0.8);
    expect(belowCloud(900, 600)).toBe(0);
    expect(belowCloud(8000, 600)).toBe(0);
    expect(belowCloud(8000, Number.NaN)).toBe(1);
    expect(dustAtHeight(0)).toBe(1);
    expect(dustAtHeight(900)).toBeGreaterThan(0);
    expect(dustAtHeight(900)).toBeLessThan(1);
    expect(dustAtHeight(1500)).toBe(0);
  });
});

describe('Precipitation', () => {
  const up = latLonToDirection(20 * DEG, 40 * DEG);
  const eye = up.clone().scale(PLANET_RADIUS + 50);
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const sceneDistance = float(1e9) as unknown as Node<'float'>;

  function setup(sunElevation = 30 * DEG) {
    const lighting = new PlanetLighting(PLANET_RADIUS);
    const north = up.clone().cross(east);
    const sun = up.clone().scale(Math.sin(sunElevation)).addScaled(north, Math.cos(sunElevation));
    lighting.update(eye, sun, up.clone().scale(-1));
    const state = new WeatherState();
    state.local = { cloudCover: 1, cloudBase: 600 } as WeatherReport;
    const precipitation = new Precipitation(state, lighting, sceneDistance);
    const frame = (at: Readonly<Vec3d>, dt: number, aboveGround = 50) =>
      precipitation.update({
        eye: at,
        forward: east,
        dt,
        fovY: 45 * DEG,
        aspect: 16 / 9,
        viewportHeight: 1080,
        aboveGround,
      });
    return { lighting, state, precipitation, frame };
  }

  it('draws nothing in clear air and each kind by its intensity', () => {
    const { state, precipitation, frame } = setup();
    frame(eye, 0.016);
    expect(precipitation.counts).toEqual({ rain: 0, snow: 0, dust: 0 });
    expect(precipitation.group.children.every((m) => !m.visible)).toBe(true);

    state.rain.value = 0.56;
    frame(eye, 0.016);
    expect(precipitation.counts.rain).toBe(particleCount('rain', 0.56));
    expect(precipitation.counts.snow).toBe(0);
    const visible = precipitation.group.children.filter((m) => m.visible);
    expect(visible.map((m) => m.name)).toEqual(['rain']);

    // The quality factor and the switch.
    precipitation.density = 0.5;
    frame(eye, 0.016);
    expect(precipitation.counts.rain).toBe(particleCount('rain', 0.56, 0.5));
    precipitation.enabled = false;
    frame(eye, 0.016);
    expect(precipitation.counts.rain).toBe(0);
    expect(precipitation.group.children.every((m) => !m.visible)).toBe(true);
    precipitation.enabled = true;
    precipitation.density = 1;

    // Above the cloud that rains there is none, though the weather still reports the rate.
    frame(eye, 0.016, 2500);
    expect(precipitation.levels.rain).toBe(0);
    expect(precipitation.counts.rain).toBe(0);
    // Without weather at the camera there is none either.
    state.local = null;
    frame(eye, 0.016);
    expect(precipitation.counts.rain).toBe(0);

    state.local = { cloudCover: 0.1, cloudBase: 3000 } as WeatherReport;
    state.rain.value = 0;
    state.dust.value = 0.9;
    frame(eye, 0.016);
    expect(precipitation.counts.dust).toBe(particleCount('dust', 0.9));
    frame(eye, 0.016, 5000);
    expect(precipitation.counts.dust).toBe(0);
    precipitation.dispose();
  });

  it('estimates the camera velocity and ignores jumps', () => {
    const { state, precipitation, frame } = setup();
    state.rain.value = 1;
    const at = eye.clone();
    frame(at, 1 / 60);
    for (let i = 0; i < 120; i++) {
      at.addScaled(east, 250 / 60);
      frame(at, 1 / 60);
    }
    expect(precipitation.cameraVelocity.dot(east)).toBeCloseTo(250, 0);
    expect(precipitation.cameraVelocity.length()).toBeCloseTo(250, 0);
    // A cut to a camera 40 km away is not a velocity of 2,400 km/s.
    at.addScaled(east, 40_000);
    frame(at, 1 / 60);
    expect(precipitation.cameraVelocity.length()).toBeCloseTo(250, 0);
    // A frame without time changes nothing.
    frame(at, 0);
    expect(precipitation.cameraVelocity.length()).toBeCloseTo(250, 0);
    precipitation.reset();
    expect(precipitation.cameraVelocity.length()).toBe(0);
    precipitation.dispose();
  });

  it('lights particles by the sky and the sun, the night and the flash', () => {
    const day = setup(40 * DEG);
    const clear = particleLight(day.lighting, 0);
    const overcast = particleLight(day.lighting, 1);
    for (const c of [0, 1, 2]) {
      expect(clear.ambient[c]).toBeGreaterThan(0.05);
      expect(clear.sun[c]).toBeGreaterThan(0.5);
      // Cloud hides the sun.
      expect(overcast.sun[c]).toBeLessThan(0.1 * clear.sun[c]!);
    }
    // The clear sky's light is blue; under cloud it is nearly gray.
    expect(clear.ambient[2]).toBeGreaterThan(1.3 * clear.ambient[0]!);
    expect(overcast.ambient[2]).toBeLessThan(1.3 * overcast.ambient[0]!);

    const night = setup(-40 * DEG);
    const dark = particleLight(night.lighting, 1);
    expect(dark.sun).toEqual([0, 0, 0]);
    expect(dark.ambient[1]).toBeGreaterThan(0);
    expect(dark.ambient[1]).toBeLessThan(0.25 * overcast.ambient[1]!);
    // A flash nearby lights them far above the night's level.
    night.lighting.flashLight.value.set(2.5, 2.7, 3.2);
    night.lighting.flashPosition.value.set(eye.x, eye.y, eye.z);
    const lit = particleLight(night.lighting, 1);
    expect(lit.ambient[2]).toBeGreaterThan(dark.ambient[2]! + 0.5);
    // Far away it adds little.
    night.lighting.flashPosition.value.set(eye.x + 60_000, eye.y, eye.z);
    expect(particleLight(night.lighting, 1).ambient[2]).toBeLessThan(dark.ambient[2]! + 0.02);
  });
});
