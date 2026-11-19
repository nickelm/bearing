/**
 * The sensor model (src/sim/sensors/sensors.ts, decision 218): radar range by the
 * radar equation and aspect, scan limits, clutter and the notch, terrain masking, the
 * marginal band's deterministic chance, scan periods and coasting, single-target
 * track, the RWR, visual range and the datalink's delay.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import {
  detectionRange,
  radarSees,
  rwrHears,
  SensorModel,
  visualRange,
} from '../src/sim/sensors/sensors';
import type { OwnShip, RadarSpec, SensorEnv, SensorTarget } from '../src/sim/sensors/sensors';
import { applyCommand, initialAvionics } from '../src/sim/avionics/avionics';
import { relativePicture } from '../src/ui/displays/aircraftSnapshot';
import { lineOfSight } from '../src/sim/sensors/lineOfSight';
import { buildTraffic, trafficState, trafficTargets } from '../src/freeflight/traffic';

const R = 1_000_000;
// At latitude 0, longitude 0: up is +z, east +x, north +y.
const at = (north: number, east: number, alt: number) => new Vec3d(east, north, R + alt);
const PD: RadarSpec = { kind: 'pulse-doppler', range: 70_000, azimuth: 1, elevation: 1, notch: 40 };
const PULSE: RadarSpec = { ...PD, kind: 'pulse' };
const env = (over: Partial<SensorEnv> = {}): SensorEnv => ({
  time: 0,
  visibility: 40_000,
  daylight: 1,
  lineOfSight: () => true,
  ...over,
});
const own = (over: Partial<OwnShip> = {}): OwnShip => ({
  id: 'own',
  side: 'alliance',
  pos: at(0, 0, 5000),
  vel: new Vec3d(0, 250, 0),
  forward: new Vec3d(0, 1, 0),
  up: new Vec3d(0, 0, 1),
  radar: PD,
  radarOn: true,
  radarMode: 'rws',
  lock: null,
  rwr: true,
  datalink: false,
  ...over,
});
const target = (over: Partial<SensorTarget> = {}): SensorTarget => ({
  id: 'bandit',
  side: 'pact',
  pos: at(40_000, 0, 5000),
  vel: new Vec3d(0, -250, 0),
  rcs: 5,
  size: 15,
  airborne: true,
  emitter: null,
  ...over,
});
const sees = (o: OwnShip, t: SensorTarget, e = env(), scan = 0) =>
  radarSees(o.radar!, o.pos, o.forward, o.up, t, e, scan);

describe('radar', () => {
  it('scales with the fourth root of the cross-section, and loses range on a receding target', () => {
    expect(detectionRange(PD, 80)).toBeCloseTo(140_000, -2);
    expect(detectionRange(PD, 5, 0)).toBeCloseTo(49_000, -2);
    expect(detectionRange(PULSE, 5, 0)).toBe(70_000);
  });

  it('sees ahead within range and its scan, not behind or beyond', () => {
    expect(sees(own(), target())).toBe(true);
    expect(sees(own(), target({ pos: at(-40_000, 0, 5000) }))).toBe(false);
    expect(sees(own(), target({ pos: at(80_000, 0, 5000) }))).toBe(false);
  });

  it('loses a low target in clutter without look-down, and in the notch when it beams', () => {
    const low = target({ pos: at(30_000, 0, 300) });
    expect(sees(own({ radar: PULSE }), low)).toBe(false);
    expect(sees(own(), low)).toBe(true);
    const beaming = target({ pos: at(30_000, 0, 300), vel: new Vec3d(250, 0, 0) });
    expect(sees(own(), beaming)).toBe(false);
  });

  it('is masked by terrain', () => {
    expect(sees(own(), target(), env({ lineOfSight: () => false }))).toBe(false);
  });

  it('decides a marginal detection the same way every time', () => {
    const edge = target({ pos: at(66_000, 0, 5000) });
    const a = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => sees(own(), edge, env(), s));
    const b = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => sees(own(), edge, env(), s));
    expect(a).toEqual(b);
    expect(a.some((x) => x)).toBe(true);
    expect(a.some((x) => !x)).toBe(true);
  });
});

describe('the sensor model over time', () => {
  it('scans range-while-search every 2 s and keeps a contact 6 s after it is lost', () => {
    const m = new SensorModel();
    const t = target();
    m.update(own(), [t], env({ time: 0 }), null);
    expect(m.picture.contacts.map((c) => [c.id, c.source])).toEqual([['bandit', 'radar']]);
    const masked = (time: number) => env({ time, lineOfSight: () => false });
    m.update(own(), [t], masked(5), null);
    expect(m.picture.contacts).toHaveLength(1);
    m.update(own(), [t], masked(7), null);
    expect(m.picture.contacts).toHaveLength(0);
  });

  it('follows only the locked contact in single-target track', () => {
    const m = new SensorModel();
    const other = target({ id: 'other', pos: at(30_000, 5000, 5000) });
    m.update(
      own({ radarMode: 'stt', lock: 'bandit' }),
      [target(), other],
      env({ visibility: 1000 }),
      null,
    );
    expect(m.picture.contacts.map((c) => c.id)).toEqual(['bandit']);
  });

  it('hears an emitter by bearing and kind, and knows when it is tracked', () => {
    const sam: SensorTarget = target({
      id: 'sam',
      pos: at(0, 30_000, 0),
      vel: new Vec3d(0, 0, 0),
      airborne: false,
      emitter: {
        radar: { ...PD, azimuth: Math.PI },
        kind: 'SA6',
        ground: true,
        state: 'track',
        tracking: 'own',
      },
    });
    const h = rwrHears(own(), sam, env())!;
    expect(h.kind).toBe('SA6');
    expect(h.state).toBe('track');
    expect(h.bearing).toBeCloseTo(Math.PI / 2, 2);
    expect(rwrHears(own(), { ...sam, pos: at(0, 200_000, 0) }, env())).toBeNull();
  });

  it('sees visually by size, light and visibility', () => {
    const t = target();
    expect(visualRange(t, env())).toBe(22_500);
    expect(visualRange(t, env({ daylight: 0 }))).toBe(5625);
    expect(visualRange(t, env({ visibility: 800 }))).toBe(800);
  });

  it('reports datalink tracks a delay ago, with their side', () => {
    const m = new SensorModel();
    const far = target({ pos: at(150_000, 0, 5000) });
    m.update(own({ datalink: true }), [far], env({ time: 100 }), {
      delay: 6,
      error: 0,
      targets: [far],
    });
    const c = m.picture.contacts[0]!;
    expect(c.source).toBe('datalink');
    expect(c.side).toBe('pact');
    expect(c.pos[1]).toBeCloseTo(150_000 + 6 * 250, 3);
  });

  it('leaves ground targets to the air-to-ground radar', () => {
    expect(sees(own(), target({ airborne: false, pos: at(30_000, 0, 0) }))).toBe(false);
  });

  it('keeps a radar contact radar between scans, with the side from the datalink', () => {
    const m = new SensorModel();
    const t = target({ pos: at(30_000, 0, 5000) });
    const feed = { delay: 5, error: 400, targets: [t] };
    // Range-while-search scans every 2 s; between scans the contact coasts as radar.
    for (let time = 100; time < 104; time += 0.1) {
      m.update(own({ datalink: true }), [t], env({ time }), feed);
      const c = m.picture.contacts[0]!;
      expect(c.source, `at ${time.toFixed(1)} s`).toBe('radar');
      expect(c.side).toBe('pact');
    }
  });
});

describe('the picture relative to the aircraft (decision 218)', () => {
  it('turns world contacts into range, angles off the nose, altitude and closing speed', () => {
    const own = {
      pos: at(0, 0, 5000),
      vel: new Vec3d(0, 250, 0),
      forward: new Vec3d(0, 1, 0),
      up: new Vec3d(0, 0, 1),
    };
    const pic = {
      time: 0,
      contacts: [
        {
          id: 'b',
          source: 'radar' as const,
          pos: [10_000, 10_000, R + 5000] as [number, number, number],
          vel: [0, -250, 0] as [number, number, number],
          seen: 0,
          side: null,
        },
      ],
      threats: [
        { id: 's', kind: 'SA6', bearing: Math.PI / 2, state: 'track' as const, ground: true },
      ],
    };
    const av = applyCommand(initialAvionics(false), { type: 'radar-lock', id: 'b' });
    const s = relativePicture(pic, own, R, PD, av);
    const c = s.contacts[0]!;
    expect(c.azimuth).toBeCloseTo(Math.PI / 4, 1);
    expect(c.range).toBeCloseTo(Math.hypot(10_000, 10_000), -2);
    expect(c.altitude).toBeCloseTo(Math.hypot(10_000, 10_000, R + 5000) - R, 3);
    expect(c.heading).toBeCloseTo(Math.PI, 2);
    expect(c.closing).toBeCloseTo(500 * Math.SQRT1_2, -1);
    expect(c.locked).toBe(true);
    // East of a north-flying aircraft: 90° right of the nose.
    expect(s.threats[0]!.azimuth).toBeCloseTo(Math.PI / 2, 3);
    expect(s.radar).toMatchObject({ on: true, mode: 'stt', lock: 'b', azimuth: 1 });
  });
});

describe('line of sight over the ground (decision 218)', () => {
  const flat = { height: () => 0 };
  it('sees over flat ground nearby, not through a ridge or past the horizon', () => {
    expect(lineOfSight(at(0, 0, 1000), at(20_000, 0, 1000), R, flat)).toBe(true);
    const ridge = { height: (d: Readonly<Vec3d>) => (Math.abs(d.y * R - 10_000) < 600 ? 3000 : 0) };
    expect(lineOfSight(at(0, 0, 1000), at(20_000, 0, 1000), R, ridge)).toBe(false);
    // Two aircraft low over the sea far apart: the curve of the planet hides them.
    expect(
      lineOfSight(
        new Vec3d(0, 0, R + 100),
        new Vec3d(0, Math.sin(0.2), Math.cos(0.2)).scale(R + 100),
        R,
        flat,
      ),
    ).toBe(false);
  });
});

describe('Free Flight traffic (decision 218)', () => {
  it('is the same for a base every time and circles at its speed', () => {
    const base = new Vec3d(0.3, 0.5, 0.8).normalize();
    const a = buildTraffic(base, 'base-3', R);
    const b = buildTraffic(base, 'base-3', R);
    expect(a).toEqual(b);
    expect(a.aircraft).toHaveLength(4);
    expect(a.sites).toHaveLength(2);
    const t = a.aircraft[0]!;
    const s0 = trafficState(t, 0, R);
    const s1 = trafficState(t, 1, R);
    expect(s1.pos.clone().sub(s0.pos).length()).toBeCloseTo(t.speed, -1);
    expect(s0.pos.length() - R).toBeCloseTo(t.altitude, 0);
  });

  it('points its radars at the player when close, and searches otherwise', () => {
    const base = new Vec3d(0, 0, 1);
    const traffic = buildTraffic(base, 'base-1', R);
    const site = traffic.sites[0]!;
    const near = site.dir.clone().scale(R + 3000);
    const far = base
      .clone()
      .scale(R + 3000)
      .addScaled(site.dir.clone().sub(base).normalize(), -200_000);
    const states = (pos: Vec3d) =>
      trafficTargets(traffic, 0, R, () => 0, { id: 'me', pos }).find((x) => x.id === site.id)!
        .emitter!;
    expect(states(near)).toMatchObject({ state: 'track', tracking: 'me' });
    expect(states(far)).toMatchObject({ state: 'search', tracking: null });
  });
});
