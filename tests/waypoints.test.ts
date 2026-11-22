/**
 * The flight plan (decision 305): waypoints read from a route's phases, sequenced by the
 * phase and by passing within 2 nm; the snapshot's route and fronts; the moving map's
 * projection, the route's symbols and the fronts in the elevation modes.
 */
import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { arcDistance, destination } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { DEG, NAUTICAL_MILE } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { AIRCRAFT_TYPES } from '../src/sim/air/aircraft';
import { MISSION_PROFILES } from '../src/sim/air/mission';
import { FENCE_IN, planMissionRoute } from '../src/sim/air/missionRoute';
import {
  nextWaypoint,
  routeWaypoints,
  SEQUENCE_RADIUS,
  sequenceWaypoints,
} from '../src/sim/air/waypoints';
import { applyCommand, initialAvionics } from '../src/sim/avionics/avionics';
import { AVIONICS_PROFILES } from '../src/sim/avionics/profiles';
import {
  displayModel,
  MAP_DEPRESSED_Y,
  MAP_FOV_Y,
  mapAhead,
  mapPictureScale,
  mapPlace,
  mapRange,
  steerpointStep,
} from '../src/ui/displays/formats';
import { newPhase } from '../src/follow/follow';
import type { ScreenItem } from '../src/ui/displays/model';
import { applyUi, initialDisplayState } from '../src/ui/displays/presets';
import {
  flightSnapshot,
  FRONT_REACH,
  frontsSnapshot,
  mapBearing,
  ROUTE_STEP,
  routeSnapshot,
} from '../src/ui/displays/routeSnapshot';
import type { AircraftSnapshot, SnapshotTerrain } from '../src/ui/displays/snapshot';

const R = 1_000_000;
const dir = (lat: number, lon: number): Dir => {
  const v = latLonToDirection(lat * DEG, lon * DEG);
  return [v.x, v.y, v.z];
};

const fighter = AIRCRAFT_TYPES.find((t) => t.role === 'multirole' && t.side === 'alliance')!;
const base = dir(40, 10);
const target = dir(43, 14);

function plan(profile: keyof typeof MISSION_PROFILES) {
  return planMissionRoute({
    type: fighter,
    loadout: fighter.loadouts[0]!,
    profile: MISSION_PROFILES[profile],
    radius: R,
    rangeFactor: 1,
    basePoint: () => base,
    carrierBased: false,
    target,
    launch: 0,
  })!;
}

describe('waypoints from the route (decision 305)', () => {
  it('reads the base, the IP, the target and home from a pass', () => {
    const wps = routeWaypoints(plan('interdiction'));
    expect(wps.map((w) => w.label)).toEqual(['BASE', 'IP', 'TGT', 'HOME']);
    expect(arcDistance(wps[0]!.point, base, R)).toBeLessThan(1);
    expect(arcDistance(wps[2]!.point, target, R)).toBeLessThan(1);
    expect(arcDistance(wps[3]!.point, base, R)).toBeLessThan(1);
    // The IP is the fence-in's start, ahead of the target (more for a low profile).
    expect(arcDistance(wps[1]!.point, target, R)).toBeGreaterThanOrEqual(FENCE_IN - 1);
    // Planned times in order.
    for (let i = 1; i < wps.length; i++) expect(wps[i]!.time).toBeGreaterThan(wps[i - 1]!.time);
  });

  it("reads a station at the racetrack's center", () => {
    const wps = routeWaypoints(plan('cap'));
    expect(wps.map((w) => w.kind)).toEqual(['base', 'ip', 'station', 'home']);
    expect(arcDistance(wps[2]!.point, target, R)).toBeLessThan(1);
  });

  it('sequences by the phase and by passing within 2 nm of the next', () => {
    const wps = routeWaypoints(plan('interdiction'));
    const passed = new Set<number>();
    expect(nextWaypoint(wps, 'departure', passed)).toBe(1);
    expect(nextWaypoint(wps, 'ingress', passed)).toBe(1);
    expect(nextWaypoint(wps, 'fence-in', passed)).toBe(2);
    expect(nextWaypoint(wps, 'on-target', passed)).toBe(2);
    expect(nextWaypoint(wps, 'egress', passed)).toBe(3);
    expect(nextWaypoint(wps, 'complete', passed)).toBe(-1);
    // Within 2 nm of the IP during the ingress: passed, steer on to the target.
    const near = destination(wps[1]!.point, 0.4, SEQUENCE_RADIUS * 0.9, R);
    expect(sequenceWaypoints(wps, 1, near, R, passed)).toBe(true);
    expect(nextWaypoint(wps, 'ingress', passed)).toBe(2);
    // Farther off it is not; home is never passed by proximity.
    const far = destination(wps[2]!.point, 0.4, SEQUENCE_RADIUS * 1.2, R);
    expect(sequenceWaypoints(wps, 2, far, R, passed)).toBe(false);
    expect(sequenceWaypoints(wps, 3, base, R, passed)).toBe(false);
    // Over the target itself it stays the steerpoint until the egress (decision 310).
    expect(sequenceWaypoints(wps, 2, wps[2]!.point, R, passed)).toBe(false);
    expect(nextWaypoint(wps, 'on-target', passed)).toBe(2);
  });
});

describe("the snapshot's route and fronts (decision 305)", () => {
  const wps = routeWaypoints(plan('interdiction'));
  const from = dir(41, 11);

  it('numbers the waypoints from 1 and samples the legs at most ROUTE_STEP apart', () => {
    const r = routeSnapshot(wps, 1, from, R);
    expect(r.waypoints.map((w) => `${w.number} ${w.label}`)).toEqual([
      '1 BASE',
      '2 IP',
      '3 TGT',
      '4 HOME',
    ]);
    expect(r.legs).toHaveLength(3);
    r.legs.forEach((leg, i) => {
      expect(leg[0]![1]).toBeCloseTo(r.waypoints[i]!.at[1], 0);
      expect(leg[leg.length - 1]![1]).toBeCloseTo(r.waypoints[i + 1]!.at[1], 0);
      expect(leg.length).toBeGreaterThanOrEqual(
        Math.ceil(arcDistance(wps[i]!.point, wps[i + 1]!.point, R) / ROUTE_STEP),
      );
    });
    // A bearing and distance that point back at the waypoint.
    const [b, d] = r.waypoints[2]!.at;
    expect(arcDistance(destination(from, b, d, R), target, R)).toBeLessThan(5);
  });

  it('keeps the fronts within reach, thinned, split where they leave it', () => {
    // A line along a meridian from 30° to 60° north at 11° east, densely sampled.
    const pts: number[] = [];
    for (let lat = 30; lat <= 60; lat += 0.05) pts.push(...dir(lat, 11));
    const [f] = frontsSnapshot([{ points: pts, teeth: -1, color: 0xd0532b }], from, R);
    expect(f!.color).toBe('#d0532b');
    expect(f!.teeth).toBe(-1);
    expect(Math.max(...f!.points.map((p) => p[1]))).toBeLessThanOrEqual(FRONT_REACH);
    expect(f!.points.length).toBeLessThan(pts.length / 3 / 3);
    expect(f!.points.length).toBeGreaterThan(50);
  });
});

function snap(over: Partial<AircraftSnapshot> = {}): AircraftSnapshot {
  return {
    time: 30,
    kind: 'jet',
    name: 'F-21 Kestrel',
    profile: AVIONICS_PROFILES['alliance-fighter']!,
    avionics: { ...initialAvionics(false) },
    position: { lat: 0.8, lon: 0.3, radius: R },
    destination: null,
    sensors: null,
    track: 0,
    heading: 0,
    onGround: false,
    cas: 220,
    groundSpeed: 220,
    radarAltitude: 3000,
    fuel: { mass: 2600, capacity: 2630, unlimited: false, joker: 920, bingo: 526, low: 263 },
    engine: { lever: 0.6, power: 0.7, afterburner: 0 },
    gear: { position: 0, down: false, fixed: false, overspeed: false },
    speedbrake: 0,
    brakes: false,
    parkingBrake: false,
    rotor: null,
    holds: [],
    control: 'mouse aim',
    mouseFree: false,
    messages: [],
    ...over,
  };
}

const texts = (items: ScreenItem[]) => items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));

describe('the moving map (decision 305)', () => {
  it("projects as the picture's camera: straight down at the height that shows √2 × the range", () => {
    const half = 40 * NAUTICAL_MILE;
    const H = (half * Math.SQRT2) / Math.tan(MAP_FOV_Y / 2);
    for (const d of [0, 10_000, 60_000, 120_000]) {
      const [x, y] = mapPlace([Math.PI / 2, d], R, half, 0);
      // The camera's own projection of a point d along the ground to the east.
      const th = d / R;
      const east = R * Math.sin(th);
      const depth = R + H - R * Math.cos(th);
      const ndc = ((east / depth) * Math.SQRT2) / Math.tan(MAP_FOV_Y / 2);
      expect(x).toBeCloseTo(0.5 + ndc / 2, 6);
      expect(y).toBeCloseTo(0.5, 6);
    }
    // North is up on a north-up map, and the track is up on a track-up one.
    expect(mapPlace([0, 20_000], R, half, 0)[1]).toBeLessThan(0.5);
    const [x, y] = mapPlace([1, 20_000], R, half, 1);
    expect(x).toBeCloseTo(0.5, 9);
    expect(y).toBeLessThan(0.5);
    // Beyond the camera's horizon a place stays off the screen, along its bearing.
    const [fx] = mapPlace([Math.PI / 2, 900_000], R, 5 * NAUTICAL_MILE, 0);
    expect(fx).toBeGreaterThan(1);
  });

  const wps = routeWaypoints(plan('interdiction'));
  const at = dir(0.8 / DEG, 0.3 / DEG);

  it('draws the legs, the waypoints with their numbers and the next one, a caret beyond the range', () => {
    const s = snap({ route: routeSnapshot(wps, 1, at, R) });
    let d = initialDisplayState(s);
    for (let i = 0; i < 9; i++) d = applyUi(d, s, { type: 'map-range', slot: 'leftMfd', delta: 1 });
    const far = displayModel(s, d, 'leftMfd')!.items;
    const t = texts(far);
    for (const l of ['2 IP', '3 TGT']) expect(t).toContain(l);
    // Each leg as a line from its waypoint, sampled; the one to the next waypoint wider.
    const r = s.route!;
    const half = mapRange('alliance', d.map.range);
    r.legs.forEach((leg, i) => {
      const [x0, y0] = mapPlace(r.waypoints[i]!.at, R, half, 0);
      const line = far.find(
        (it) =>
          it.kind === 'line' &&
          it.points.length === leg.length &&
          Math.hypot(it.points[0]![0] - x0, it.points[0]![1] - y0) < 1e-3,
      );
      expect(line).toMatchObject({ width: i === 0 ? 2 : 1.5 });
    });
    // At 5 nm the IP is beyond the edge: a caret with its distance.
    for (let i = 0; i < 9; i++)
      d = applyUi(d, s, { type: 'map-range', slot: 'leftMfd', delta: -1 });
    const near = texts(displayModel(s, d, 'leftMfd')!.items);
    expect(near.some((x) => /^2 IP \d+ NM$/.test(x))).toBe(true);
  });

  it('draws the fronts in the elevation modes only, with teeth in their color', () => {
    const pts: number[] = [];
    for (let lon = 15; lon <= 20; lon += 0.02) pts.push(...dir(0.8 / DEG + 0.2, lon));
    const fronts = frontsSnapshot([{ points: pts, teeth: 1, color: 0x2f6fb5 }], at, R);
    let s = snap({ fronts });
    let d = initialDisplayState(s);
    const inChart = displayModel(s, d, 'leftMfd')!.items;
    expect(inChart.some((i) => i.kind === 'line' && i.color === '#2a2a2a')).toBe(false);
    // The elevation mode, with heights sampled for this range.
    d = applyUi(d, s, { type: 'map-mode', slot: 'leftMfd' });
    const half = mapRange('alliance', d.map.range);
    const terrain: SnapshotTerrain = {
      n: 4,
      halfExtent: half,
      rotation: 0,
      heights: new Array(16).fill(100),
      water: new Array(16).fill(0),
      altitude: 3000,
    };
    s = snap({ fronts, terrain });
    const items = displayModel(s, d, 'leftMfd')!.items;
    const line = items.find((i) => i.kind === 'line' && i.color === '#2a2a2a');
    expect(line).toBeTruthy();
    const teeth = items.filter((i) => i.kind === 'line' && i.fill && i.color === '#2f6fb5');
    expect(teeth.length).toBeGreaterThan(3);
  });

  it('places a bearing and distance where mapBearing reads it', () => {
    const p = destination(at, 0.7, 50_000, R);
    const [b, dd] = mapBearing(at, p, R);
    expect(b).toBeCloseTo(0.7, 6);
    expect(dd).toBeCloseTo(50_000, 0);
  });
});

describe('the own flight by the intraflight datalink (decision 308)', () => {
  // The aircraft at (45.84°, 17.19°) heading north at 3,000 m; its wingman a mile abeam right.
  const at = dir(0.8 / DEG, 0.3 / DEG);
  const up = new Vec3d(...at);
  const east = new Vec3d(0, 1, 0).cross(up).normalize();
  const north = up.clone().cross(east);
  const pos = up.clone().scale(R + 3000);
  const mate = pos.clone().addScaled(east, NAUTICAL_MILE).addScaled(up, 150);
  const flight = flightSnapshot(
    { pos, forward: north, up },
    [{ number: 2, pos: mate, vel: north.clone().scale(200) }],
    R,
  );

  it('places a wingman off the nose and on the map', () => {
    const [f] = flight;
    expect(f!.number).toBe(2);
    expect(f!.range).toBeCloseTo(Math.hypot(NAUTICAL_MILE, 150), 0);
    expect(f!.azimuth / DEG).toBeCloseTo(90, 0);
    expect(f!.elevation).toBeGreaterThan(0);
    expect(f!.altitude).toBeGreaterThan(3000);
    expect(f!.heading).toBeCloseTo(0, 2);
    expect(f!.at[0] / DEG).toBeCloseTo(90, 0);
    expect(f!.at[1]).toBeCloseTo((NAUTICAL_MILE * R) / (R + 3000), -1);
  });

  it('draws it on the moving map with its number, and on the radar within its scan', () => {
    const s = snap({ flight });
    let d = initialDisplayState(s);
    // At 20 nm the ring sits by the own ship, too close for its number; at 5 nm it clears.
    const map = () => displayModel(s, d, 'leftMfd')!.items;
    expect(map().filter((i) => i.kind === 'arc' && i.r === 0.011)).toHaveLength(1);
    expect(texts(map())).not.toContain('2');
    for (let i = 0; i < 2; i++)
      d = applyUi(d, s, { type: 'map-range', slot: 'leftMfd', delta: -1 });
    expect(texts(map())).toContain('2');
    const ahead = flightSnapshot(
      { pos, forward: north, up },
      [{ number: 3, pos: pos.clone().addScaled(north, 8000), vel: north.clone().scale(200) }],
      R,
    );
    const withRadar = snap({
      flight: ahead,
      sensors: {
        radar: {
          on: true,
          mode: 'rws',
          range: 20 * NAUTICAL_MILE,
          lock: null,
          azimuth: 1,
          elevation: 0.5,
        },
        contacts: [],
        threats: [],
      },
    });
    const dr = applyUi(initialDisplayState(withRadar), withRadar, {
      type: 'select-format',
      slot: 'rightMfd',
      format: 'radar-aa',
    });
    const radar = displayModel(withRadar, dr, 'rightMfd')!;
    expect(radar.format).toBe('radar-aa');
    expect(texts(radar.items)).toContain('3');
  });
});

describe('the steerpoint by hand and the depressed map (decision 310)', () => {
  const wps = routeWaypoints(plan('interdiction'));
  const at = dir(0.8 / DEG, 0.3 / DEG);

  it('steps up and down the plan, wrapping, and goes back to auto', () => {
    const r = routeSnapshot(wps, 2, at, R);
    expect(steerpointStep(r, 1)).toBe(3);
    expect(steerpointStep({ ...r, next: 3 }, 1)).toBe(0);
    expect(steerpointStep({ ...r, next: 0 }, -1)).toBe(3);
    // All passed: up starts from the first.
    expect(steerpointStep({ ...r, next: -1 }, 1)).toBe(0);
    let av = initialAvionics(false);
    av = applyCommand(av, { type: 'steerpoint', index: 2 });
    expect(av.steerpoint).toBe(2);
    expect(applyCommand(av, { type: 'steerpoint', index: null }).steerpoint).toBeNull();
    // The map's buttons: STPT up and down, and AUTO (MAN while chosen by hand).
    const s = snap({ route: r });
    const m = displayModel(s, initialDisplayState(s), 'leftMfd')!;
    expect(m.buttons[16]).toMatchObject({
      label: 'STPT▲',
      command: { to: 'avionics', command: { type: 'steerpoint', index: 3 } },
    });
    expect(m.buttons[15]?.command).toMatchObject({ command: { index: 1 } });
    expect(m.buttons[17]).toMatchObject({ label: 'AUTO', active: false });
    const hand = snap({ route: routeSnapshot(wps, 1, at, R, true) });
    const mm = displayModel(hand, initialDisplayState(hand), 'leftMfd')!;
    expect(mm.buttons[17]).toMatchObject({
      label: 'MAN',
      active: true,
      command: { to: 'avionics', command: { type: 'steerpoint', index: null } },
    });
  });

  it('puts the own ship low with more ahead, its picture larger so a turn still fills it', () => {
    const half = 20 * NAUTICAL_MILE;
    expect(mapPlace([0, 0], R, half, 0, true)).toEqual([0.5, MAP_DEPRESSED_Y]);
    // A place straight ahead at the range sits half a screen above the own ship.
    const [, y] = mapPlace([0, half], R, half, 0, true);
    expect(MAP_DEPRESSED_Y - y).toBeGreaterThan(0.45);
    expect(MAP_DEPRESSED_Y - y).toBeLessThan(0.5);
    expect(mapPictureScale({ depressed: true })).toBeGreaterThan(Math.hypot(1, 1.5));
    expect(mapAhead({ depressed: true }, half)).toBeCloseTo(half / 2, 6);
    expect(mapAhead({}, half)).toBe(0);
    const s = snap({ route: routeSnapshot(wps, 1, at, R) });
    let d = initialDisplayState(s);
    d = applyUi(d, s, { type: 'map-depress', slot: 'leftMfd' });
    const m = displayModel(s, d, 'leftMfd')!;
    expect(m.buttons[8]).toMatchObject({ label: 'DEP', active: true });
    expect(m.items.find((i) => i.kind === 'map')).toMatchObject({ centerY: MAP_DEPRESSED_Y });
    expect(m.items.find((i) => i.kind === 'arc' && i.dashed && i.r === 0.25)).toMatchObject({
      y: MAP_DEPRESSED_Y,
    });
    // A caret for a far steerpoint stays inside the screen.
    for (const it of m.items)
      if (it.kind === 'text') {
        expect(it.x).toBeGreaterThanOrEqual(0);
        expect(it.x).toBeLessThanOrEqual(1);
      }
  });

  it('drops the clock to 1× on a new phase, once (newPhase)', () => {
    expect(newPhase(null, 7, 'ingress')).toBeNull();
    expect(newPhase({ mission: 7, phase: 'ingress' }, 7, 'ingress')).toBeNull();
    expect(newPhase({ mission: 7, phase: 'ingress' }, 7, 'fence-in')).toBe('fence-in');
    expect(newPhase({ mission: 6, phase: 'ingress' }, 7, 'fence-in')).toBeNull();
    expect(newPhase({ mission: 7, phase: 'recovery' }, 7, 'complete')).toBeNull();
  });
});
