/**
 * The displays and the status strip over the stand-in scene (decision 200), for
 * Part I's acceptance checks 12 and 13: `composite.html?hover=<case>&displays=<mode>`
 * draws the real `DisplaySystem` with a made-up snapshot in master mode `mode`, for
 * `aircraft` (`kestrel`, `utility`) in `skin` (`alliance`, `pact`). The HUD under it is
 * the helicopter's (the stand-in scene is a hover); for the Kestrel it is left out.
 * The Kestrel's radar and threat warning show a made-up picture (decision 218);
 * `&sensors=0` leaves it out.
 */
import type { MasterMode } from '../../src/sim/avionics/avionics';
import { initialAvionics, radarDisplayRange } from '../../src/sim/avionics/avionics';
import { AVIONICS_PROFILES } from '../../src/sim/avionics/profiles';
import { AIRCRAFT_BUNDLES } from '../../src/sim/air/bundles';
import { stationLoads } from '../../src/sim/air/stores';
import { loadedStations } from '../../src/sim/flight/storesRack';
import { storesSnapshot } from '../../src/ui/displays/aircraftSnapshot';
import type {
  AircraftSnapshot,
  SnapshotContact,
  SnapshotSensors,
} from '../../src/ui/displays/snapshot';
import { DisplaySystem } from '../../src/ui/displays/system';
import { destination } from '../../src/core/greatCircle';
import type { Dir } from '../../src/core/greatCircle';
import { latLonToDirection } from '../../src/core/coords';
import { WAYPOINT_LABELS } from '../../src/sim/air/waypoints';
import type { Waypoint, WaypointKind } from '../../src/sim/air/waypoints';
import { flightSnapshot, frontsSnapshot, routeSnapshot } from '../../src/ui/displays/routeSnapshot';
import { Vec3d } from '../../src/core/vec3d';

export async function drawDisplays(q: URLSearchParams): Promise<void> {
  const mode = (q.get('displays') ?? 'navigation') as MasterMode;
  const helo = q.get('aircraft') === 'utility';
  const base = AVIONICS_PROFILES[helo ? 'alliance-utility-helo' : 'alliance-fighter']!;
  const profile = {
    ...base,
    skin: q.get('skin') === 'pact' ? ('pact' as const) : ('alliance' as const),
  };
  const ground = mode === 'ground';
  const approach = mode === 'approach';
  // `&alerts=1`: a caution and a warning in the strip, for the color-vision views (check 13).
  const alerts = q.get('alerts') === '1';
  const snap: AircraftSnapshot = {
    time: 412,
    kind: helo ? 'helicopter' : 'jet',
    name: helo ? 'UH-68 Heron' : 'F-21 Kestrel',
    profile,
    avionics: initialAvionics(ground),
    position: { lat: 0.8, lon: 0.3, radius: 1_000_000 },
    destination: { label: 'RWY 07', bearing: 1.2, distance: 30_000 },
    sensors: helo || q.get('sensors') === '0' ? null : picture(ground, profile.skin),
    track: 0.6,
    heading: 0.6,
    onGround: ground,
    cas: ground ? 0 : approach ? 75 : 210,
    groundSpeed: ground ? 0 : 210,
    radarAltitude: ground ? 0 : approach ? 400 : 3000,
    fuel: {
      mass: alerts ? 400 : 1600,
      capacity: 2630,
      unlimited: false,
      joker: 920,
      bingo: 526,
      low: 263,
    },
    engine: {
      lever: alerts ? 0.9 : ground ? 0 : 0.72,
      power: ground ? 0.1 : 0.8,
      afterburner: mode === 'dogfight' ? 3 : 0,
    },
    gear: {
      position: ground || approach || helo ? 1 : 0,
      down: ground || approach || helo,
      fixed: helo,
      overspeed: false,
    },
    speedbrake: approach && !helo ? 1 : 0,
    brakes: false,
    parkingBrake: ground,
    rotor: helo ? { torque: 0.82, rpm: 1, margin: 0.18 } : null,
    holds: helo && mode === 'hover' ? ['hover hold'] : [],
    control: helo ? 'fly-by-mouse' : 'mouse aim',
    mouseFree: false,
    messages: [
      { at: 380, text: ['Airborne'], warn: false },
      { at: 395, text: ['Climbing through 3,000 ft, heading 095'], warn: false },
      { at: 405, text: ['Joker fuel in 6 minutes at this setting'], warn: true },
    ],
  };
  // `&gmr=<file in tools/out>`: a ground map from tools/groundMap.preview.ts (decision 226),
  // shown on the right display.
  const gmr = q.get('gmr');
  if (gmr && snap.sensors) {
    snap.sensors.groundMap = { ...(await (await fetch(`../out/${gmr}`)).json()), age: 0 };
    snap.destination = { label: 'TGT', bearing: snap.heading + 0.25, distance: 22_000 };
  }
  // `&terrain=<file in tools/out>&mapmode=elevation|relative`: the moving map's elevation
  // samples from tools/groundMap.preview.ts (decision 227).
  const terrain = q.get('terrain');
  if (terrain === 'flat') snap.terrain = flatTerrain(Number(q.get('mapnm') ?? 20) * 1852);
  else if (terrain) snap.terrain = (await (await fetch(`../out/${terrain}`)).json()) as never;
  // `&route=1`: a made-up flight plan and a front around the aircraft (decision 305), the
  // IP passed and the target next.
  if (q.get('route') === '1') {
    const v = latLonToDirection(snap.position.lat, snap.position.lon);
    const here: Dir = [v.x, v.y, v.z];
    const R = snap.position.radius;
    const at = (b: number, d: number) => destination(here, snap.track + b, d, R);
    const wp = (kind: WaypointKind, point: Dir): Waypoint => ({
      kind,
      label: WAYPOINT_LABELS[kind],
      point,
      time: 0,
      passedFrom: 'egress',
    });
    const wps = [
      wp('base', at(Math.PI + 0.3, 90_000)),
      wp('ip', at(Math.PI - 0.2, 12_000)),
      wp('target', at(0.15, 24_000)),
      wp('home', at(Math.PI + 0.5, 80_000)),
    ];
    snap.route = routeSnapshot(wps, 2, here, R);
    const line: number[] = [];
    for (let k = -60; k <= 60; k += 2)
      line.push(...destination(at(0, 30_000), snap.track + Math.PI / 2, k * 1000, R));
    // The wingman a mile abeam right, the second element two miles out (decision 308).
    const h = new Vec3d(...here);
    const east = new Vec3d(0, 1, 0).cross(h).normalize();
    const north = h.clone().cross(east);
    const nose = north.clone().scale(Math.cos(snap.track)).addScaled(east, Math.sin(snap.track));
    const right = nose.clone().cross(h);
    const own = h.clone().scale(R + 3000);
    snap.flight = flightSnapshot(
      { pos: own, forward: nose, up: h },
      [1852, 3704, 5556].map((d, k) => ({
        number: k + 2,
        pos: own
          .clone()
          .addScaled(right, d)
          .addScaled(nose, -30 * (k + 1)),
        vel: nose.clone().scale(220),
      })),
      R,
    );
    snap.fronts = frontsSnapshot([{ points: line, teeth: 1, color: 0x2f6fb5 }], here, R);
  }
  // The jet's strike load with one bomb gone, and the bombs selected in air-to-ground (decision 289).
  if (!helo) {
    const b = AIRCRAFT_BUNDLES['alliance-fighter']!;
    const loads = stationLoads(
      b.airWar!.loadouts.find((l) => l.id === 'strike')!.stations!,
      b.pylons!,
    );
    snap.stores = storesSnapshot(loads, loadedStations(loads, { 'bomb-900': 1 }), 1400);
  }
  const sys = new DisplaySystem();
  sys.edits = {};
  sys.uiScale = Number(q.get('scale') ?? 1);
  sys.avionics = {
    ...sys.avionics,
    masterMode: mode,
    manual: !ground,
    weapon: mode === 'air-to-ground' ? 'bomb-900' : mode === 'air-to-air' ? 'srm' : null,
    masterArm: mode === 'air-to-ground' || mode === 'air-to-air' || mode === 'dogfight',
  };
  sys.visible = true;
  // `&mapimg=<file in tools/out>&mapnm=<range it was drawn for>`: a moving-map picture from the
  // strategic render preview (MAP=1) as the map's picture, centered on the aircraft (decision 201).
  const img = q.get('mapimg');
  if (img) {
    const el = new Image();
    el.src = `../out/${img}`;
    await el.decode();
    const c = document.createElement('canvas');
    c.width = el.width;
    c.height = el.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    sys.view.setMapPicture({
      width: el.width,
      height: el.height,
      pixels: ctx.getImageData(0, 0, el.width, el.height).data,
      lat: snap.position.lat,
      lon: snap.position.lon,
      halfExtent: Number(q.get('mapnm') ?? 40) * 1852 * Math.SQRT2,
    });
  }
  sys.update(snap);
  // `&readonly=1`: a spectator's displays; avionics and controls presses flash red (decision 311).
  if (q.get('readonly') === '1') sys.readOnly = true;
  // `&dep=1`: the own ship low on the map (decision 310).
  if (q.get('dep') === '1')
    sys.command({ to: 'ui', command: { type: 'map-depress', slot: 'leftMfd' } });
  // `&mapsteps=<n>`: the map's range stepped n times (+ wider) from 20 nm.
  const steps = Number(q.get('mapsteps') ?? 0);
  for (let k = 0; k < Math.abs(steps); k++)
    sys.command({
      to: 'ui',
      command: { type: 'map-range', slot: 'leftMfd', delta: steps > 0 ? 1 : -1 },
    });
  if (steps) sys.update({ ...snap, time: snap.time + 0.5 });
  const mapMode = q.get('mapmode');
  for (let k = 0; k < (mapMode === 'relative' ? 2 : mapMode === 'elevation' ? 1 : 0); k++)
    sys.command({ to: 'ui', command: { type: 'map-mode', slot: 'leftMfd' } });
  if (mapMode) {
    // Redraws with the new mode (the samples are 20 nm, the default range step).
    sys.update({ ...snap, time: snap.time + 1 });
  }
}

/** A made-up sensor picture: every kind of contact on the radar, one locked, and three emitters. */
function picture(ground: boolean, skin: 'alliance' | 'pact'): SnapshotSensors {
  const c = (id: string, over: Partial<SnapshotContact>): SnapshotContact => ({
    id,
    source: 'radar',
    range: 40_000,
    azimuth: 0,
    elevation: 0,
    altitude: 6000,
    heading: 3.4,
    speed: 240,
    closing: 400,
    side: null,
    locked: false,
    ...over,
  });
  const lock = ground ? null : 'bandit-1';
  return {
    radar: {
      on: !ground,
      mode: ground ? 'rws' : 'stt',
      range: radarDisplayRange(skin, 2),
      lock,
      azimuth: Math.PI / 3,
      elevation: Math.PI / 3,
    },
    contacts: [
      c('bandit-1', { range: 33_000, azimuth: -0.2, side: 'pact', locked: !ground }),
      c('bandit-2', { range: 52_000, azimuth: 0.45, altitude: 8200, heading: 2.1, side: 'pact' }),
      c('unknown', { range: 61_000, azimuth: -0.7, altitude: 3100, heading: 1.3 }),
      c('strike-1', {
        source: 'datalink',
        range: 45_000,
        azimuth: 0.85,
        altitude: 1500,
        heading: 4.4,
        side: 'pact',
      }),
      c('friend-1', {
        source: 'datalink',
        range: 22_000,
        azimuth: 0.3,
        altitude: 4500,
        heading: 0.6,
        side: 'alliance',
      }),
      c('visual', { source: 'visual', range: 6_000, azimuth: -0.9, altitude: 3500, heading: 5.2 }),
    ],
    threats: [
      { id: 'sam-1', kind: 'SA6', azimuth: 1.9, state: 'track', ground: true },
      { id: 'sam-2', kind: 'SA6', azimuth: -2.4, state: 'search', ground: true },
      { id: 'bandit-1', kind: '29', azimuth: -0.2, state: 'track', ground: false },
      { id: 'bandit-2', kind: '29', azimuth: 0.45, state: 'launch', ground: false },
    ],
  };
}

/** Gently rolling made-up heights for the elevation modes (`&terrain=flat`). */
function flatTerrain(halfExtent: number): NonNullable<AircraftSnapshot['terrain']> {
  const n = 64;
  const heights: number[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) heights.push(300 + 250 * Math.sin(c / 7) * Math.cos(r / 9));
  return { n, halfExtent, rotation: 0, heights, water: new Array(n * n).fill(0), altitude: 3000 };
}
