import { describe, expect, it } from 'vitest';
import { float } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { latLonToDirection } from '../src/core/coords';
import { DEG, KM, PLANET_RADIUS } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { PlanetLighting } from '../src/render/sim/lighting/planetLighting';
import {
  ACCELERATED_GAP,
  FLASH_ILLUMINANCE,
  Lightning,
  strikeAtPlace,
} from '../src/render/sim/weather/lightning';
import type { ThunderEvent } from '../src/render/sim/weather/lightning';
import {
  BOLT_MAX_SEGMENTS,
  BOLT_SEGMENT_FLOATS,
  buildBolt,
  cellDirection,
  cellsNear,
  flashRate,
  PEAK_FLASH_RATE,
  STORM_THRESHOLD,
  STRIKE_MAX_DURATION,
  STRIKE_RANGE,
  strikeCell,
  strikeIntensity,
  strikesAt,
  strikesBetween,
  strikeSeed,
} from '../src/render/sim/weather/lightningStrikes';
import type { Strike } from '../src/render/sim/weather/lightningStrikes';
import { WeatherState } from '../src/render/sim/weather/weatherState';
import { Channel, newFrameData, WeatherView } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';

const grid = new WeatherGrid();

/** A view of two hours of the same weather everywhere: a storm of an intensity under a cloud base. */
function stormView(storm: number, cloudBase = 800, cover = 1): WeatherView {
  const view = new WeatherView(grid);
  for (const hour of [0, 1]) {
    const data = newFrameData(grid);
    data.fill(storm, Channel.Storm * grid.count, (Channel.Storm + 1) * grid.count);
    data.fill(cover, Channel.Cover * grid.count, (Channel.Cover + 1) * grid.count);
    data.fill(cloudBase, Channel.CloudBase * grid.count, (Channel.CloudBase + 1) * grid.count);
    data.fill(20_000, Channel.Visibility * grid.count, (Channel.Visibility + 1) * grid.count);
    view.add({ hour, data });
  }
  return view;
}

const HERE = latLonToDirection(31 * DEG, 12 * DEG);
const SEED = strikeSeed(1983);
const key = (s: Strike) => `${s.cell}/${s.slot}`;

describe('strike cells', () => {
  it('lists every cell within range, across the edges of cube faces', () => {
    // A face center, an edge and a corner of the cube.
    for (const center of [
      new Vec3d(0, 0, 1),
      new Vec3d(1, 0, 1).normalize(),
      new Vec3d(1, 1, 1).normalize(),
      HERE,
    ]) {
      const cells = new Set(cellsNear(center, 40 * KM, PLANET_RADIUS));
      // About π · 40² km² of cells of 67 km².
      expect(cells.size).toBeGreaterThan(70);
      expect(cells.size).toBeLessThan(130);
      const east = new Vec3d(0, 1, 0).cross(center).normalize();
      const north = center.clone().cross(east);
      for (let k = 0; k < 400; k++) {
        const angle = k * 2.399963;
        const range = (39 * KM * Math.sqrt((k + 0.5) / 400)) / PLANET_RADIUS;
        const d = center
          .clone()
          .scale(Math.cos(range))
          .addScaled(east, Math.sin(range) * Math.cos(angle))
          .addScaled(north, Math.sin(range) * Math.sin(angle));
        expect(cells.has(strikeCell(d))).toBe(true);
      }
    }
  });

  it('places a cell at its own direction', () => {
    const cell = strikeCell(HERE);
    expect(strikeCell(cellDirection(cell, 0.5, 0.5))).toBe(cell);
    // A cell is about 8 km wide.
    const width =
      cellDirection(cell, 0, 0.5).distanceTo(cellDirection(cell, 1, 0.5)) * PLANET_RADIUS;
    expect(width).toBeGreaterThan(5 * KM);
    expect(width).toBeLessThan(9 * KM);
  });
});

describe('strike schedule', () => {
  const cells = cellsNear(HERE, 40 * KM, PLANET_RADIUS);

  it('is a pure function of seed, time and place', () => {
    const view = stormView(1);
    const a = strikesBetween(SEED, cells, view, 100, 400);
    const b = strikesBetween(SEED, cells, stormView(1), 100, 400);
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    // In order of time, inside the interval and inside the cells asked for.
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.time).toBeGreaterThan(100);
      expect(a[i]!.time).toBeLessThanOrEqual(400);
      if (i > 0) expect(a[i]!.time).toBeGreaterThanOrEqual(a[i - 1]!.time);
      expect(cells).toContain(a[i]!.cell);
      expect(strikeCell(a[i]!.direction)).toBe(a[i]!.cell);
    }
    // Another world has other lightning.
    const other = strikesBetween(strikeSeed(1984), cells, view, 100, 400);
    expect(other.map(key)).not.toEqual(a.map(key));
    // A seed given as a number or as its digits is the same world.
    expect(strikeSeed('1983')).toBe(SEED);
  });

  it('gives the same strikes at any frame rate and after a seek', () => {
    const view = stormView(0.9);
    const whole = strikesBetween(SEED, cells, view, 0, 120).map(key);
    for (const step of [1 / 144, 1 / 30, 0.37, 5]) {
      const found: string[] = [];
      let t = 0;
      while (t < 120) {
        const next = Math.min(120, t + step);
        found.push(...strikesBetween(SEED, cells, view, t, next).map(key));
        t = next;
      }
      expect(found).toEqual(whole);
    }
    // Starting in the middle finds the rest, and what is under way at that moment.
    const late = strikesBetween(SEED, cells, view, 60, 120).map(key);
    const all = strikesBetween(SEED, cells, view, 0, 120);
    expect(late).toEqual(all.filter((s) => s.time > 60).map(key));
    const running = all.find((s) => s.duration > 0.1)!;
    const at = running.time + 0.05;
    expect(strikesAt(SEED, cells, view, at).map(key)).toContain(key(running));
    expect(
      strikesAt(SEED, cells, view, running.time + STRIKE_MAX_DURATION + 0.01).map(key),
    ).not.toContain(key(running));
  });

  it('flashes with the storm: every few seconds in a strong one, about once a minute in a weak one', () => {
    const count = (storm: number) =>
      strikesBetween(SEED, cells, stormView(storm), 0, 1800).length / 1800;
    // A strong storm within 40 km: one flash in 2 to 4 seconds.
    const strong = count(1);
    expect(1 / strong).toBeGreaterThan(1.5);
    expect(1 / strong).toBeLessThan(4);
    expect(strong / (cells.length * PEAK_FLASH_RATE)).toBeGreaterThan(0.85);
    expect(strong / (cells.length * PEAK_FLASH_RATE)).toBeLessThan(1.15);
    // A weak one: one in 30 to 120 seconds.
    const weak = count(0.3);
    expect(1 / weak).toBeGreaterThan(30);
    expect(1 / weak).toBeLessThan(120);
    // Monotonic in between.
    expect(count(0.6)).toBeGreaterThan(weak);
    expect(count(0.6)).toBeLessThan(strong);
    // None without a storm.
    expect(count(0)).toBe(0);
    expect(count(STORM_THRESHOLD)).toBe(0);
    expect(flashRate(Number.NaN)).toBe(0);
    expect(flashRate(1)).toBe(PEAK_FLASH_RATE);
    // And none without weather.
    expect(strikesBetween(SEED, cells, new WeatherView(grid), 0, 600)).toEqual([]);
  });

  it('follows the storm in space: a cell flashes where the storm is', () => {
    // A storm over the eastern half only.
    const view = new WeatherView(grid);
    const east = new Vec3d(0, 1, 0).cross(HERE).normalize();
    for (const hour of [0, 1]) {
      const data = newFrameData(grid);
      for (let s = 0; s < grid.count; s++) {
        const d = new Vec3d(
          grid.directions[s * 3]!,
          grid.directions[s * 3 + 1]!,
          grid.directions[s * 3 + 2]!,
        );
        data[Channel.Storm * grid.count + s] = d.dot(east) > 0.1 ? 1 : 0;
      }
      view.add({ hour, data });
    }
    const wide = cellsNear(HERE, 300 * KM, PLANET_RADIUS);
    const strikes = strikesBetween(SEED, wide, view, 0, 60);
    expect(strikes.length).toBeGreaterThan(50);
    for (const s of strikes) expect(s.direction.dot(east)).toBeGreaterThan(0);
  });

  it('makes strikes of one to four strokes that flicker within a fraction of a second', () => {
    const strikes = strikesBetween(SEED, cells, stormView(1), 0, 3600);
    const strokeCounts = new Set<number>();
    let ground = 0;
    for (const s of strikes) {
      strokeCounts.add(s.strokes.length);
      if (s.ground) ground++;
      expect(s.strokes.length).toBeGreaterThanOrEqual(1);
      expect(s.strokes.length).toBeLessThanOrEqual(4);
      expect(s.duration).toBeLessThanOrEqual(STRIKE_MAX_DURATION);
      expect(s.strokes[s.strokes.length - 1]!.offset).toBeLessThanOrEqual(0.33);
      expect(s.energy).toBeGreaterThan(0.3);
      expect(s.energy).toBeLessThanOrEqual(1);
      // Full brightness at the first stroke, nothing before the strike or after its end.
      expect(strikeIntensity(s, 0)).toBeCloseTo(1, 6);
      expect(strikeIntensity(s, -0.01)).toBe(0);
      expect(strikeIntensity(s, s.duration + 0.001)).toBe(0);
      if (s.strokes.length > 1) {
        // It dims between two strokes and jumps up at the second.
        const second = s.strokes[1]!;
        expect(strikeIntensity(s, second.offset - 1e-4)).toBeLessThan(
          strikeIntensity(s, second.offset + 1e-4),
        );
      }
    }
    expect([...strokeCounts].sort()).toEqual([1, 2, 3, 4]);
    // Both kinds, about two in five to the ground.
    expect(ground / strikes.length).toBeGreaterThan(0.3);
    expect(ground / strikes.length).toBeLessThan(0.5);
  });
});

describe('bolt geometry', () => {
  it('is a connected, branching channel from the cloud to the ground, inside its bounds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const height = 400 + 130 * seed;
      const bolt = buildBolt(seed * 7919, height);
      const s = bolt.segments;
      const F = BOLT_SEGMENT_FLOATS;
      expect(bolt.mainCount).toBe(64);
      expect(bolt.count).toBeGreaterThan(bolt.mainCount + 8);
      expect(bolt.count).toBeLessThanOrEqual(BOLT_MAX_SEGMENTS);
      const start = (i: number) => [s[i * F]!, s[i * F + 1]!, s[i * F + 2]!];
      const end = (i: number) => [s[i * F + 3]!, s[i * F + 4]!, s[i * F + 5]!];
      // The main channel runs from the top to the ground point without a gap.
      expect(start(0)).toEqual(bolt.top.map(Math.fround));
      expect(bolt.top[1]).toBe(height);
      expect(end(bolt.mainCount - 1)).toEqual([0, 0, 0]);
      for (let i = 1; i < bolt.mainCount; i++) expect(start(i)).toEqual(end(i - 1));
      // Every other segment starts where an earlier one starts or ends: nothing floats.
      const joints = new Set<string>();
      for (let i = 0; i < bolt.count; i++) {
        if (i >= bolt.mainCount) expect(joints.has(start(i).join())).toBe(true);
        joints.add(start(i).join());
        joints.add(end(i).join());
      }
      let longest = 0;
      for (let i = 0; i < bolt.count; i++) {
        for (const p of [start(i), end(i)]) {
          expect(p[1]).toBeGreaterThanOrEqual(0);
          expect(p[1]).toBeLessThanOrEqual(Math.fround(height));
          expect(Math.hypot(p[0]!, p[2]!)).toBeLessThanOrEqual(height);
        }
        const a = start(i);
        const b = end(i);
        longest = Math.max(longest, Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!));
        // Brightness and width: full on the main channel, less on branches.
        const brightness = s[i * F + 6]!;
        const width = s[i * F + 7]!;
        if (i < bolt.mainCount) expect([brightness, width]).toEqual([1, 1]);
        else {
          expect(brightness).toBeGreaterThan(0);
          expect(brightness).toBeLessThanOrEqual(0.5);
          expect(width).toBeLessThan(1);
        }
      }
      // Jagged: many short segments, none a large part of the channel.
      expect(longest).toBeLessThan(0.12 * height);
      // The same seed gives the same bolt.
      expect(buildBolt(seed * 7919, height).segments).toEqual(s);
    }
    expect(buildBolt(1, 1000).segments).not.toEqual(buildBolt(2, 1000).segments);
  });
});

describe('Lightning', () => {
  const lighting = new PlanetLighting(PLANET_RADIUS);
  const eye = HERE.clone().scale(PLANET_RADIUS + 300);

  /** Plays game time from `from` to `to` in frames of `step` game seconds, `speed` game seconds per real second. */
  function play(
    storm: number,
    from: number,
    to: number,
    step: number,
    speed = 1,
  ): {
    lightning: Lightning;
    state: WeatherState;
    thunder: ThunderEvent[];
    flashes: number;
    trace: number[];
  } {
    const state = new WeatherState();
    const lightning = new Lightning(PLANET_RADIUS, state, lighting, null);
    lightning.seed = 1983;
    const thunder: ThunderEvent[] = [];
    lightning.onThunder = (e) => thunder.push(e);
    const view = stormView(storm);
    let flashes = 0;
    let lit = false;
    const trace: number[] = [];
    for (let t = from; t <= to + 1e-9; t += step) {
      lightning.update({ view, eye, gameTime: t, dt: step / speed, pixelAngle: 0.001 });
      trace.push(state.flash.value);
      const now = state.flash.value > 0.02;
      if (now && !lit) flashes++;
      lit = now;
    }
    return { lightning, state, thunder, flashes, trace };
  }

  it('shows the same flash at a game time at any frame rate and after a seek', () => {
    const fine = play(1, 0, 30, 1 / 120);
    const coarse = play(1, 0, 30, 1 / 30);
    expect(fine.thunder.length).toBeGreaterThan(5);
    // The same strikes thundered, in the same order.
    expect(coarse.thunder).toEqual(fine.thunder);
    // Every fourth fine frame is a coarse frame.
    for (let i = 0; i < coarse.trace.length; i++) {
      expect(coarse.trace[i]).toBeCloseTo(fine.trace[i * 4]!, 5);
    }
    expect(Math.max(...fine.trace)).toBeGreaterThan(0.5);
    expect(Math.max(...fine.trace)).toBeLessThanOrEqual(1);
    // A seek: starting at second 20 shows from there on what the whole run showed.
    const late = play(1, 20, 30, 1 / 30);
    const offset = coarse.trace.length - late.trace.length;
    for (let i = 1; i < late.trace.length; i++) {
      expect(late.trace[i]).toBeCloseTo(coarse.trace[i + offset]!, 5);
    }
    expect(late.thunder).toEqual(coarse.thunder.filter((e) => e.time > 20));
    for (const e of fine.thunder) {
      expect(e.distance).toBeLessThan(STRIKE_RANGE + 12 * KM);
      expect(e.energy).toBeGreaterThan(0);
    }
  });

  it('shows and thunders the same when the game clock moves in steps of its own', () => {
    // Free Flight's clock advances by whole flight-model steps (1/120 s), whatever the frame
    // rate: a frame may hold none of them, or two or three. That is not acceleration.
    const smooth = play(1, 0, 31, 1 / 120);
    for (const fps of [144, 60, 50, 37]) {
      const state = new WeatherState();
      const lightning = new Lightning(PLANET_RADIUS, state, lighting, null);
      lightning.seed = 1983;
      const thunder: ThunderEvent[] = [];
      lightning.onThunder = (e) => thunder.push(e);
      const view = stormView(1);
      let acc = 0;
      let steps = 0;
      let lit = 0;
      for (let frame = 0; steps < 30 * 120; frame++) {
        // Frame times that wander by a third, as a browser's do.
        const dt = (1 / fps) * (1 + 0.33 * Math.sin(frame * 1.7));
        acc += dt;
        while (acc >= 1 / 120) {
          acc -= 1 / 120;
          steps++;
        }
        const gameTime = steps / 120;
        lightning.update({ view, eye, gameTime, dt, pixelAngle: 0.001 });
        // What a clock that runs smoothly shows at this game time.
        const expected = smooth.trace[steps]!;
        expect(state.flash.value).toBeCloseTo(expected, 5);
        if (expected > 0.02) lit++;
      }
      expect(lit).toBeGreaterThan(20);
      expect(thunder).toEqual(smooth.thunder.filter((e) => e.time <= steps / 120));
      lightning.dispose();
    }
  });

  it('writes the flash to the weather state and the lighting', () => {
    const state = new WeatherState();
    const lightning = new Lightning(PLANET_RADIUS, state, lighting, null);
    const place = HERE.clone()
      .scale(PLANET_RADIUS)
      .addScaled(new Vec3d(0, 1, 0).cross(HERE).normalize(), 5 * KM);
    lightning.forced = { strike: strikeAtPlace(place), age: 0 };
    lightning.groundAt = () => 120;
    lightning.update({ view: stormView(1, 900), eye, gameTime: 50, dt: 0.016, pixelAngle: 0.001 });
    expect(state.flash.value).toBeCloseTo(1, 6);
    // The discharge is just inside the cloud base, above the ground point.
    const p = state.flashPosition.value;
    const height = p.length() - PLANET_RADIUS;
    expect(height).toBeGreaterThan(120 + 900);
    expect(height).toBeLessThan(120 + 900 + 400);
    expect(Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z)).toBeGreaterThan(4 * KM);
    expect(Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z)).toBeLessThan(6 * KM);
    expect(lighting.flashLight.value.z).toBeCloseTo(FLASH_ILLUMINANCE, 5);
    expect(lighting.flashPosition.value.length()).toBeLessThan(p.length());
    // Later in the strike it has dimmed; after it, and with the lightning off, it is dark.
    lightning.forced.age = 0.2;
    lightning.update({ view: null, eye, gameTime: 50, dt: 0.016, pixelAngle: 0.001 });
    expect(state.flash.value).toBeGreaterThan(0);
    expect(state.flash.value).toBeLessThan(0.5);
    lightning.forced = null;
    lightning.update({ view: null, eye, gameTime: 50, dt: 0.016, pixelAngle: 0.001 });
    expect(state.flash.value).toBe(0);
    expect(lighting.flashLight.value.length()).toBe(0);
    lightning.dispose();
  });

  it('hides the bolt under the cloud deck from a camera above it', () => {
    const state = new WeatherState();
    const sceneDistance = float(1e9) as unknown as Node<'float'>;
    const lightning = new Lightning(PLANET_RADIUS, state, lighting, sceneDistance);
    const place = HERE.clone()
      .scale(PLANET_RADIUS)
      .addScaled(new Vec3d(0, 1, 0).cross(HERE).normalize(), 5 * KM);
    const showing = (height: number, view: WeatherView | null, seed: number) => {
      lightning.forced = { strike: strikeAtPlace(place, seed), age: 0.01 };
      lightning.update({
        view,
        eye: HERE.clone().scale(PLANET_RADIUS + height),
        gameTime: 50,
        dt: 0.016,
        pixelAngle: 0.001,
      });
      expect(lightning.group.visible).toBe(true);
      return lightning.boltShowing;
    };
    const overcast = stormView(1, 800, 1);
    // Below the base (800 m, and the channel reaches 150 m into the cloud) the bolt shows in full.
    expect(showing(300, overcast, 1)).toBe(1);
    expect(showing(800, overcast, 1)).toBe(1);
    // From above the deck it is the cloud that shows, glowing; the channel under it does not.
    expect(showing(3000, overcast, 1)).toBe(0);
    expect(showing(12_000, overcast, 1)).toBe(0);
    // Broken cloud hides it in part; with no cloud, or no weather to ask, it shows.
    const broken = showing(12_000, stormView(1, 800, 0.4), 2);
    expect(broken).toBeGreaterThan(0.3);
    expect(broken).toBeLessThan(0.7);
    expect(showing(12_000, stormView(1, 800, 0), 3)).toBe(1);
    expect(showing(12_000, null, 4)).toBe(1);
    lightning.dispose();
  });

  it('stays dark and silent without a storm, without weather and when switched off', () => {
    const calm = play(0.05, 0, 120, 0.1);
    expect(Math.max(...calm.trace)).toBe(0);
    expect(calm.thunder).toEqual([]);
    const state = new WeatherState();
    const lightning = new Lightning(PLANET_RADIUS, state, lighting, null);
    let heard = 0;
    lightning.onThunder = () => heard++;
    lightning.enabled = false;
    const view = stormView(1);
    for (let t = 0; t < 60; t += 0.05) {
      lightning.update({ view, eye, gameTime: t, dt: 0.05, pixelAngle: 0.001 });
      expect(state.flash.value).toBe(0);
    }
    expect(heard).toBe(0);
  });

  it('caps the flashes in real time when game time is accelerated', () => {
    // An hour of storm in a minute: about 1,400 strikes, of which at most one in 0.9 real seconds shows.
    const realSeconds = 30;
    const speed = 60;
    const fast = play(1, 0, realSeconds * speed, speed / 60, speed);
    const most = realSeconds / ACCELERATED_GAP + 1;
    expect(fast.flashes).toBeGreaterThan(10);
    expect(fast.flashes).toBeLessThanOrEqual(most);
    expect(fast.thunder.length).toBeLessThanOrEqual(most);
    expect(fast.thunder.length).toBeGreaterThan(10);
    expect(fast.lightning.gameRate).toBeCloseTo(speed, 3);
    // At the speed of real time the same storm shows every strike.
    const real = play(1, 0, realSeconds, 1 / 60);
    expect(real.thunder.length).toBeGreaterThan(6);
    expect(real.lightning.gameRate).toBeCloseTo(1, 6);
    // A jump of the clock is not acceleration: nothing new shows on the frame after it.
    const state = new WeatherState();
    const lightning = new Lightning(PLANET_RADIUS, state, lighting, null);
    lightning.seed = 1983;
    let heard = 0;
    lightning.onThunder = () => heard++;
    const view = stormView(1);
    lightning.update({ view, eye, gameTime: 10, dt: 1 / 60, pixelAngle: 0.001 });
    lightning.update({ view, eye, gameTime: 2000, dt: 1 / 60, pixelAngle: 0.001 });
    expect(heard).toBe(0);
    // Nor does it make the clock fast: real time goes on after it as before, thunder and all.
    expect(lightning.gameRate).toBeCloseTo(1, 6);
    for (let t = 2000; t < 2030; t += 1 / 60) {
      lightning.update({ view, eye, gameTime: t, dt: 1 / 60, pixelAngle: 0.001 });
    }
    expect(heard).toBe(
      strikesBetween(
        SEED,
        cellsNear(HERE, STRIKE_RANGE + 2 * KM, PLANET_RADIUS),
        view,
        2000,
        2030 - 1 / 60 + 1e-9,
      ).length,
    );
    // A clock that is switched to sixty times real time is fast from its first frames on; back
    // at the speed of real time, every strike shows again within a few seconds.
    let t = 2030;
    for (let i = 0; i < 4; i++) {
      t += 1;
      lightning.update({ view, eye, gameTime: t, dt: 1 / 60, pixelAngle: 0.001 });
    }
    expect(lightning.gameRate).toBeGreaterThan(10);
    for (let i = 0; i < 240; i++) {
      t += 1 / 60;
      lightning.update({ view, eye, gameTime: t, dt: 1 / 60, pixelAngle: 0.001 });
    }
    expect(lightning.gameRate).toBeCloseTo(1, 2);
  });
});
