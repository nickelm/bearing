/**
 * Wind and gusts on the flight model (sim/flight/wind.ts): airspeed relative to
 * the moving air, the air's velocity from the weather, and the scripted test
 * pilot's circuit in the windiest weather.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, HOUR, KNOT } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { neutralControls } from '../src/sim/flight/controlLaws';
import { FlightDirector } from '../src/sim/flight/flightDirector';
import { FLIGHT_STEP } from '../src/sim/flight/flightModel';
import type { FlightModel } from '../src/sim/flight/flightModel';
import { FlightMonitor } from '../src/sim/flight/outcomes';
import type { Touchdown } from '../src/sim/flight/outcomes';
import { headingVector, runwayEnds, runwayFrame, toRunway } from '../src/sim/flight/runway';
import { spawnInAir, spawnOnRunway } from '../src/sim/flight/spawn';
import { TestPilot } from '../src/sim/flight/testPilot';
import {
  airVelocity,
  GROUND_WIND_LIMIT,
  GUST_CLOUD,
  GUST_PER_WIND,
  GUST_STORM,
  gustStrength,
  SHELTER_HEIGHT,
} from '../src/sim/flight/wind';
import type { WeatherReport } from '../src/sim/weather/frame';
import { GALE } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { StandaloneWeather } from '../src/sim/weather/standalone';
import { flatGround, kestrel, RADIUS, testRunway } from './helpers/flight';
import { syntheticConfig } from './helpers/weatherWorld';

/** A wind of `speed` m/s blowing from compass direction `from` (rad) at unit direction `up`. */
function windFrom(up: Readonly<Vec3d>, from: number, speed: number): Vec3d {
  return headingVector(up, from + Math.PI).scale(speed);
}

/** Runs a takeoff roll at full afterburner and returns the distance rolled at liftoff (m). */
function takeoffRoll(wind: (m: FlightModel) => void): number {
  const runway = testRunway();
  const ground = flatGround(runway);
  const m = kestrel();
  const end = runwayEnds(runway)[0];
  spawnOnRunway(m, runway, end);
  const frame = runwayFrame(runway);
  const start = toRunway(runway, frame, m.pos, RADIUS).along;
  const ctl = neutralControls();
  const pilot = new TestPilot(runway, end, RADIUS);
  const monitor = new FlightMonitor([runway], RADIUS);
  for (let i = 0; i < 60 / FLIGHT_STEP && !m.crashed; i++) {
    wind(m);
    pilot.fly(m, ctl, FLIGHT_STEP);
    m.step(ctl, ground);
    if (monitor.update(m, FLIGHT_STEP).some((e) => e.kind === 'liftoff')) {
      return Math.abs(toRunway(runway, frame, m.pos, RADIUS).along - start);
    }
  }
  throw new Error(`no liftoff: ${m.crashed ?? 'still rolling'}`);
}

describe('wind on the flight model', () => {
  it('flies exactly as before in still air', () => {
    const fly = (setWind: boolean) => {
      const runway = testRunway();
      const m = kestrel();
      spawnInAir(m, runway, runwayEnds(runway)[0]);
      const ctl = neutralControls();
      ctl.gearDown = false;
      ctl.throttle = 0.5;
      for (let i = 0; i < 10 / FLIGHT_STEP; i++) {
        ctl.roll = Math.sin(i * 0.01) * 0.3;
        ctl.pitch = Math.cos(i * 0.013) * 0.2;
        if (setWind) m.wind.set(0, 0, 0);
        m.step(ctl, flatGround(runway));
      }
      return [m.pos.x, m.pos.y, m.pos.z, m.vel.x, m.vel.y, m.vel.z, m.q.w, m.q.x, m.q.y, m.q.z];
    };
    expect(fly(true)).toEqual(fly(false));
  });

  it('comes out of a tail slide in still air within seconds', () => {
    // Straight up at 120 m/s with the engine at idle and the stick let go: the aircraft stops,
    // slides back on its tail, and the angle-of-attack limiter turns the nose into the flow.
    // The limiter needs the real angle of attack there (near 180°). With the probes blanked
    // in reversed flow in the air as well, it flew tail first for 40 s, up to 125 m/s.
    const runway = testRunway();
    const ground = flatGround(runway);
    const end = runwayEnds(runway)[0];
    const m = kestrel();
    spawnInAir(m, runway, end, 6000, 250 * KNOT);
    const up = m.pos.clone().normalize();
    const pitch = 88 * DEG;
    const nose = headingVector(up, end.heading)
      .scale(Math.cos(pitch))
      .addScaled(up, Math.sin(pitch));
    m.place(m.pos.clone(), nose.scale(120), end.heading, pitch);
    m.lawState.airborne = 30;
    m.gear = 0;
    const ctl = neutralControls();
    ctl.gearDown = false;
    ctl.throttle = 0;
    const vb = new Vec3d();
    let backward = 0;
    let fastest = 0;
    let sawReversed = false;
    for (let i = 0; i < 40 / FLIGHT_STEP; i++) {
      m.step(ctl, ground);
      m.q.unrotate(m.vel, vb);
      if (vb.x < 0) {
        backward += FLIGHT_STEP;
        fastest = Math.max(fastest, -vb.x);
        // In the air the laws and the HUD keep the real angle of attack.
        if (vb.x < -10) sawReversed ||= Math.abs(m.telemetry.alpha) > 90 * DEG;
      }
    }
    expect(m.crashed).toBeNull();
    expect(backward).toBeGreaterThan(2);
    expect(backward).toBeLessThan(12);
    expect(fastest).toBeLessThan(60);
    expect(sawReversed).toBe(true);
    // Nose first again, and flying.
    expect(vb.x).toBeGreaterThan(100);
  });

  it('takes airspeed, angle of attack and sideslip from the moving air', () => {
    const runway = testRunway();
    const end = runwayEnds(runway)[0];
    const m = kestrel();
    spawnInAir(m, runway, end);
    const up = m.pos.clone().normalize();
    const ground = flatGround(runway);
    const ctl = neutralControls();
    ctl.gearDown = false;
    m.step(ctl, ground);
    const still = m.telemetry.tas;
    // A 20 m/s headwind adds 20 m/s of airspeed; a tailwind takes them away.
    m.wind.copy(windFrom(up, end.heading, 20));
    m.step(ctl, ground);
    expect(m.telemetry.tas - still).toBeCloseTo(20, 0);
    m.wind.copy(windFrom(up, end.heading + Math.PI, 20));
    m.step(ctl, ground);
    expect(m.telemetry.tas - still).toBeCloseTo(-20, 0);
    // Wind from the right blows on the right side: positive sideslip of atan(20 / tas).
    m.wind.copy(windFrom(up, end.heading + Math.PI / 2, 20));
    m.step(ctl, ground);
    expect(m.telemetry.beta).toBeCloseTo(Math.atan2(20, still), 1);
    // Rising air raises the angle of attack.
    const alpha = m.telemetry.alpha;
    m.wind.copy(up).scale(8);
    m.step(ctl, ground);
    expect(m.telemetry.alpha - alpha).toBeGreaterThan(1.5 * DEG);
    // The ground speed is the inertial one, whatever the air does.
    expect(m.telemetry.groundSpeed).toBeCloseTo(300 * KNOT, -1);
  });

  it('stands still in a gale with the parking brake set, and senses air only from ahead', () => {
    const runway = testRunway();
    const end = runwayEnds(runway)[0];
    const up = runway.center.clone().normalize();
    const ground = flatGround(runway);
    const stand = (from: number, speed: number) => {
      const m = kestrel();
      spawnOnRunway(m, runway, end);
      const ctl = neutralControls();
      ctl.parkingBrake = true;
      for (let i = 0; i < 2 / FLIGHT_STEP; i++) m.step(ctl, ground);
      const start = m.pos.clone();
      for (let i = 0; i < 30 / FLIGHT_STEP; i++) {
        m.wind.copy(windFrom(up, from, speed));
        m.step(ctl, ground);
      }
      expect(m.crashed).toBeNull();
      return { m, moved: m.pos.distanceTo(start) };
    };
    // A headwind shows on the airspeed indicator; the aircraft does not move.
    const head = stand(end.heading, 20);
    expect(head.moved).toBeLessThan(0.05);
    expect(head.m.telemetry.cas).toBeCloseTo(20, 0);
    expect(head.m.telemetry.groundSpeed).toBeLessThan(0.01);
    expect(Math.abs(head.m.telemetry.alpha)).toBeLessThan(8 * DEG);
    // A tailwind blows into the nozzle, not the probes: no airspeed, no angles, 1 g.
    const tail = stand(end.heading + Math.PI, 20);
    expect(tail.moved).toBeLessThan(0.05);
    expect(tail.m.telemetry.tas).toBeCloseTo(20, 0);
    expect(tail.m.telemetry.cas).toBe(0);
    expect(tail.m.telemetry.alpha).toBe(0);
    expect(tail.m.telemetry.beta).toBe(0);
    expect(tail.m.telemetry.load).toBe(1);
    // Across: it stays put and feels the wind on its side.
    const cross = stand(end.heading + Math.PI / 2, 20);
    expect(cross.moved).toBeLessThan(0.05);
    expect(Math.abs(cross.m.telemetry.bank)).toBeLessThan(2 * DEG);
  });

  it('shortens the takeoff roll in a headwind and lengthens it in a tailwind', () => {
    const runway = testRunway();
    const up = runway.center.clone().normalize();
    const heading = runwayEnds(runway)[0].heading;
    const calm = takeoffRoll(() => {});
    const head = takeoffRoll((m) => m.wind.copy(windFrom(up, heading, 10)));
    const tail = takeoffRoll((m) => m.wind.copy(windFrom(up, heading + Math.PI, 10)));
    expect(calm).toBeGreaterThan(500);
    expect(calm).toBeLessThan(1000);
    expect(head).toBeLessThan(calm - 80);
    expect(tail).toBeGreaterThan(calm + 80);
  });

  it('crabs into a crosswind to hold a course', () => {
    const runway = testRunway();
    const end = runwayEnds(runway)[0];
    const m = kestrel();
    spawnInAir(m, runway, end);
    const ground = flatGround(runway);
    const ctl = neutralControls();
    ctl.gearDown = false;
    const director = new FlightDirector();
    const target = {
      course: end.heading,
      gamma: 0,
      speed: 300 * KNOT,
      maxBank: 45 * DEG,
      maxTurnRate: 6 * DEG,
      maxLoadDelta: 2,
    };
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const track = () => {
      const up = m.pos.clone().normalize();
      const east = new Vec3d(up.z, 0, -up.x).normalize();
      const north = up.clone().cross(east);
      return Math.atan2(m.vel.dot(east), m.vel.dot(north));
    };
    for (let i = 0; i < 60 / FLIGHT_STEP; i++) {
      // 25 m/s from the left of the course.
      m.wind.copy(windFrom(m.pos.clone().normalize(), end.heading - Math.PI / 2, 25));
      director.fly(m, target, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
    }
    expect(m.crashed).toBeNull();
    // The track holds the course; the nose points into the wind by asin(25 / tas); no sideslip.
    expect(Math.abs(wrap(track() - end.heading))).toBeLessThan(1 * DEG);
    const crab = wrap(m.telemetry.heading - track());
    expect(crab).toBeLessThan(0);
    expect(crab).toBeCloseTo(-Math.asin(25 / m.telemetry.tas), 1);
    expect(Math.abs(m.telemetry.beta)).toBeLessThan(1 * DEG);
  });
});

describe('the air from the weather', () => {
  const config = syntheticConfig();
  const here = latLonToDirection(20 * DEG, 30 * DEG, new Vec3d());
  const t = 30.2 * HOUR;
  const at = (altitude: number) => here.clone().scale(RADIUS + altitude);
  const calm: WeatherReport = {
    cloudCover: 0,
    cloudBase: 1500,
    ceiling: Infinity,
    visibility: 40_000,
    precipitation: 0,
    snow: 0,
    temperature: 15,
    pressure: 101_325,
    dust: 0,
    storm: 0,
  };

  it('is still without weather', () => {
    const out = new Vec3d(1, 2, 3);
    expect(airVelocity(null, at(1000), RADIUS, t, 1000, out)).toBe(out);
    expect(out.length()).toBe(0);
  });

  it("gives the weather's wind at altitude in the world frame", () => {
    const view = new StandaloneWeather(config, 'storm').view(t);
    const pos = at(3000);
    const wind = view.wind(pos, 3000, t);
    const air = airVelocity(view, pos, RADIUS, t, 2900, new Vec3d(), 0);
    const east = new Vec3d(here.z, 0, -here.x).normalize();
    const north = here.clone().cross(east);
    expect(air.dot(east)).toBeCloseTo(wind.east, 9);
    expect(air.dot(north)).toBeCloseTo(wind.north, 9);
    expect(air.dot(here)).toBeCloseTo(0, 9);
    expect(air.length()).toBeGreaterThan(1);
  });

  it('holds the wind down near the ground', () => {
    const view = new StandaloneWeather(config, 'storm').view(t);
    const speed = (aboveGround: number) =>
      airVelocity(view, at(100 + aboveGround), RADIUS, t, aboveGround, new Vec3d(), 0).length();
    const full = Math.hypot(view.wind(at(100), 100, t).east, view.wind(at(100), 100, t).north);
    // Near gale force: the preset's surface wind, a little turned toward the next level's.
    expect(full).toBeGreaterThan(GALE - 1);
    expect(speed(0)).toBeCloseTo(GROUND_WIND_LIMIT, 6);
    expect(speed(SHELTER_HEIGHT / 2)).toBeGreaterThan(GROUND_WIND_LIMIT + 2);
    expect(speed(SHELTER_HEIGHT / 2)).toBeLessThan(speed(SHELTER_HEIGHT));
    // A light wind is felt as it is.
    const fair = new StandaloneWeather(config, 'fair').view(t);
    const light = fair.wind(at(110), 110, t);
    expect(Math.hypot(light.east, light.north)).toBeLessThan(GROUND_WIND_LIMIT);
    expect(airVelocity(fair, at(110), RADIUS, t, 0, new Vec3d(), 0).length()).toBeCloseTo(
      Math.hypot(light.east, light.north),
      9,
    );
  });

  it('gusts by the weather: storms most, cloud, and wind near the ground', () => {
    expect(gustStrength(calm, 3000, 2900, 0)).toBe(0);
    expect(gustStrength({ ...calm, storm: 1 }, 3000, 2900, 0)).toBeCloseTo(GUST_STORM, 6);
    // Half of a storm's gusts at the ground, none above its top.
    expect(gustStrength({ ...calm, storm: 1 }, 100, 0, 0)).toBeCloseTo(GUST_STORM / 2, 6);
    expect(gustStrength({ ...calm, storm: 1 }, 13_000, 12_900, 0)).toBe(0);
    // In cloud, not under it or far above it.
    const cloudy = { ...calm, cloudCover: 1, cloudBase: 1000 };
    expect(gustStrength(cloudy, 2100, 2000, 0)).toBeCloseTo(GUST_CLOUD, 6);
    expect(gustStrength(cloudy, 600, 500, 0)).toBe(0);
    expect(gustStrength(cloudy, 8000, 7900, 0)).toBe(0);
    // Wind over the ground, fading with height.
    expect(gustStrength(calm, 100, 0, 10)).toBeCloseTo(10 * GUST_PER_WIND, 6);
    expect(gustStrength(calm, 2100, 2000, 10)).toBe(0);
  });

  it('gusts are the same for the same place and time, smooth, and as strong as the weather says', () => {
    const view = new StandaloneWeather(config, 'storm').view(t);
    const gust = (pos: Vec3d, time: number, aboveGround = 2900) =>
      airVelocity(view, pos, RADIUS, time, aboveGround, new Vec3d()).sub(
        airVelocity(view, pos, RADIUS, time, aboveGround, new Vec3d(), 0),
      );
    const p = at(3000);
    expect(gust(p, t).equals(gust(p, t))).toBe(true);
    expect(gust(p, t).length()).toBeGreaterThan(0);
    // A meter or a hundredth of a second away the gust is nearly the same.
    const next = p.clone().addScaled(new Vec3d(0.6, 0, -0.8), 1.25);
    expect(gust(next, t + FLIGHT_STEP).distanceTo(gust(p, t))).toBeLessThan(0.15);
    // Along a 60 km line the gusts average out to nothing and have the strength the weather gives.
    const report = view.report(p, t);
    const expected = gustStrength(report, 3000, 2900, 0);
    expect(expected).toBeGreaterThan(2);
    const along = new Vec3d(here.z, 0, -here.x).normalize();
    const sum = new Vec3d();
    let square = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const g = gust(p.clone().addScaled(along, i * 30), t + i * 0.2);
      sum.add(g);
      square += g.lengthSq();
    }
    // Each of the three components has the RMS the weather gives.
    expect(Math.sqrt(square / n / 3) / expected).toBeGreaterThan(0.75);
    expect(Math.sqrt(square / n / 3) / expected).toBeLessThan(1.25);
    expect(sum.length() / n).toBeLessThan(0.3 * expected);
    // On the ground the air does not move up or down.
    const low = at(100);
    expect(Math.abs(gust(low, t, 0).dot(here))).toBeLessThan(1e-9);
    expect(gust(low, t, 0).length()).toBeGreaterThan(0);
  });
});

describe('the scripted test pilot in wind (one flight model, one pilot: rule 12)', () => {
  /** Flies the circuit in a preset's wind and gusts from a runway of the given heading. */
  function circuit(preset: WeatherPreset, heading: number) {
    const runway = { ...testRunway(), heading };
    const ground = flatGround(runway);
    const m = kestrel();
    const end = runwayEnds(runway)[0];
    spawnOnRunway(m, runway, end);
    const ctl = neutralControls();
    const pilot = new TestPilot(runway, end, RADIUS);
    const monitor = new FlightMonitor([runway], RADIUS);
    const weather = new StandaloneWeather(syntheticConfig(), preset);
    const frame = runwayFrame(runway);
    let t = 30 * HOUR;
    let touchdown: Touchdown | null = null;
    let offCenterline = 0;
    let windOnGround = 0;
    for (let i = 0; i < 900 / FLIGHT_STEP && !m.crashed && pilot.phase !== 'stopped'; i++) {
      const height = Math.max(0, m.telemetry.radarAltitude);
      airVelocity(weather.view(t), m.pos, RADIUS, t, height, m.wind);
      pilot.fly(m, ctl, FLIGHT_STEP);
      m.step(ctl, ground);
      t += FLIGHT_STEP;
      for (const e of monitor.update(m, FLIGHT_STEP)) {
        if (e.kind === 'touchdown') touchdown = e.touchdown;
      }
      if (m.onGround) {
        offCenterline = Math.max(
          offCenterline,
          Math.abs(toRunway(runway, frame, m.pos, RADIUS).across),
        );
        windOnGround = Math.max(windOnGround, m.wind.length());
      }
    }
    return { m, pilot, touchdown, offCenterline, windOnGround };
  }

  it('takes off, flies the circuit and lands in a thunderstorm, across the wind and along it', () => {
    for (const heading of [20 * DEG, 110 * DEG]) {
      const c = circuit('storm', heading);
      expect(c.m.crashed, `runway ${heading / DEG}°`).toBeNull();
      expect(c.pilot.phase).toBe('stopped');
      expect(c.touchdown).not.toBeNull();
      expect(c.touchdown!.grade).not.toBe('hard');
      expect(c.touchdown!.inZone).toBe(true);
      // It drifts, but stays on the 45 m of pavement.
      expect(c.offCenterline).toBeLessThan(15);
      // The gale is felt on the ground as the limit plus its gusts.
      expect(c.windOnGround).toBeGreaterThan(GROUND_WIND_LIMIT * 0.8);
      expect(c.windOnGround).toBeLessThan(GROUND_WIND_LIMIT + 3 * GUST_STORM);
    }
  }, 60_000);

  it('does so in a blizzard and a dust storm', () => {
    for (const preset of ['blizzard', 'duststorm'] as const) {
      const c = circuit(preset, 20 * DEG);
      expect(c.m.crashed, preset).toBeNull();
      expect(c.pilot.phase, preset).toBe('stopped');
      expect(c.touchdown?.inZone, preset).toBe(true);
    }
  }, 60_000);
});
