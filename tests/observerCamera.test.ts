import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  OBSERVER_LEASH,
  OBSERVER_MAX_FOV,
  OBSERVER_MAX_HEIGHT,
  OBSERVER_MIN_FOV,
  OBSERVER_MIN_HEIGHT,
  ObserverCamera,
} from '../src/render/sim/camera/observerCamera';
import {
  bearingTo,
  observerStations,
  TOWER_ALONG,
  TOWER_AIM_ACROSS,
  TOWER_EYE_HEIGHT,
} from '../src/render/sim/camera/observerStations';
import type { ObserverStation } from '../src/render/sim/camera/observerStations';
import { APRON_OFFSET, localFrame, offsetPoint } from '../src/render/sim/infra/infraScene';
import { generateCampaignWorld } from '../src/worldgen/campaignWorld';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

const R = DEFAULT_PLANET_PARAMS.radius;

function station(over: Partial<ObserverStation> = {}): ObserverStation {
  return {
    key: 's',
    label: 'S',
    kind: 'airbase',
    side: 'alliance',
    point: latLonToDirection(40 * DEG, 10 * DEG),
    facing: 0,
    height: 20,
    pitch: 0,
    ...over,
  };
}

describe('ObserverCamera', () => {
  it('stands at the station, its eye height above the ground', () => {
    const c = new ObserverCamera(R);
    const s = station();
    c.setStation(s);
    c.groundHeight = 150;
    c.update(0);
    expect(c.eye.length()).toBeCloseTo(R + 170, 6);
    expect(c.eye.clone().normalize().dot(s.point)).toBeCloseTo(1, 12);
    expect(c.lat).toBeCloseTo(40 * DEG, 9);
    expect(c.lon).toBeCloseTo(10 * DEG, 9);
    expect(c.altitude).toBe(170);
  });

  it('looks along its heading and pitch, with an orthonormal frame', () => {
    const c = new ObserverCamera(R);
    const s = station({ facing: 90 * DEG, pitch: -10 * DEG });
    c.setStation(s);
    const { east, north } = localFrame(s.point);
    expect(c.forward.dot(east)).toBeCloseTo(Math.cos(10 * DEG), 9);
    expect(c.forward.dot(north)).toBeCloseTo(0, 9);
    expect(c.forward.dot(s.point)).toBeCloseTo(-Math.sin(10 * DEG), 9);
    expect(c.forward.length()).toBeCloseTo(1, 12);
    expect(c.up.length()).toBeCloseTo(1, 12);
    expect(c.forward.dot(c.up)).toBeCloseTo(0, 12);
    // Up leans toward the radial direction, never past it.
    expect(c.up.dot(s.point)).toBeCloseTo(Math.cos(10 * DEG), 9);
    expect(c.tilt).toBeCloseTo(80 * DEG, 9);
  });

  it('turns the head as mouse-look and clamps the pitch', () => {
    const c = new ObserverCamera(R);
    c.setStation(station());
    c.drag(100, 0, 0.001); // drag right: turn right
    expect(c.heading).toBeCloseTo(0.1, 9);
    c.drag(0, 50, 0.001); // drag down: look down
    expect(c.pitch).toBeCloseTo(-0.05, 9);
    c.drag(0, -1e6, 0.001);
    expect(c.pitch).toBeLessThan(Math.PI / 2);
    c.tiltBy(1e6);
    expect(c.pitch).toBeGreaterThan(-Math.PI / 2);
  });

  it('zooms the field of view within binocular and wide limits', () => {
    const c = new ObserverCamera(R);
    c.setStation(station());
    c.zoom(-10);
    expect(c.fov).toBe(OBSERVER_MIN_FOV);
    c.zoomAt(100);
    expect(c.fov).toBe(OBSERVER_MAX_FOV);
    // A new station resets the zoom.
    c.setStation(station());
    expect(c.fov).toBeGreaterThan(OBSERVER_MIN_FOV);
    expect(c.fov).toBeLessThan(OBSERVER_MAX_FOV);
  });

  it('climbs from standing to the simulation ceiling, and no further', () => {
    const c = new ObserverCamera(R);
    c.setStation(station());
    c.input.climb = 1;
    for (let i = 0; i < 200; i++) c.update(0.1);
    expect(c.height).toBe(OBSERVER_MAX_HEIGHT);
    c.input.climb = -1;
    for (let i = 0; i < 200; i++) c.update(0.1);
    expect(c.height).toBe(OBSERVER_MIN_HEIGHT);
    expect(c.near).toBeGreaterThanOrEqual(0.1);
    expect(c.near).toBeLessThanOrEqual(1);
    // The far plane reaches the horizon even from the ceiling.
    c.height = 20 * KM;
    c.update(0);
    expect(c.far).toBeGreaterThan(Math.sqrt(2 * R * 20 * KM));
  });

  it('walks along its heading and stays on the leash', () => {
    const c = new ObserverCamera(R);
    const s = station({ facing: 0 });
    c.setStation(s);
    c.walk(1000, 0);
    const { north } = localFrame(s.point);
    expect(c.spot.clone().sub(s.point).dot(north) * R).toBeCloseTo(1000, 0);
    c.walk(50 * KM, 0);
    const d = Math.acos(Math.min(1, c.spot.dot(s.point))) * R;
    expect(d).toBeLessThanOrEqual(OBSERVER_LEASH);
    expect(d).toBeGreaterThan(OBSERVER_LEASH - 10);
  });
});

describe('observer stations', () => {
  const w = generateCampaignWorld(
    { ...DEFAULT_PLANET_PARAMS, seed: 7 },
    { grid: new CubeGrid(64) },
  );
  const infra = w.infrastructure;

  it('has one station per airbase and port, Alliance main bases first', () => {
    const s = observerStations(infra, R);
    expect(s.length).toBe(infra.airbases.length + infra.ports.length);
    expect(new Set(s.map((x) => x.key)).size).toBe(s.length);
    expect(new Set(s.map((x) => x.label)).size).toBe(s.length);
    expect(s[0]!.kind).toBe('airbase');
    expect(s[0]!.side).toBe('alliance');
    expect(s[0]!.label).toMatch(/main airbase/);
    const firstPort = s.findIndex((x) => x.kind === 'port');
    if (firstPort >= 0) expect(s.slice(firstPort).every((x) => x.kind === 'port')).toBe(true);
  });

  it('puts airbase observers beside the tower cab, facing the hangars', () => {
    for (const st of observerStations(infra, R).filter((x) => x.kind === 'airbase')) {
      const base = infra.airbases.find((b) => `airbase-${b.id}` === st.key)!;
      const p = new Vec3d(...base.point);
      const tower = offsetPoint(p, base.heading, TOWER_ALONG, APRON_OFFSET, R);
      const d = st.point.distanceTo(tower) * R;
      expect(d).toBeGreaterThan(10);
      expect(d).toBeLessThan(20);
      expect(st.height).toBe(TOWER_EYE_HEIGHT);
      const aim = offsetPoint(p, base.heading, 0, TOWER_AIM_ACROSS, R);
      expect(Math.abs(st.facing - bearingTo(st.point, aim))).toBeLessThan(1e-9);
    }
  });

  it('turns port observers toward the low ground', () => {
    const port = infra.ports[0];
    if (!port) return;
    const p = new Vec3d(...port.point);
    const { east } = localFrame(p);
    // Sea to the east: height falls with the eastward offset.
    const heightAt = (d: Readonly<Vec3d>) => -d.clone().sub(p).dot(east) * R;
    const st = observerStations(infra, R, heightAt).find((x) => x.key === `port-${port.id}`)!;
    expect(st.facing).toBeCloseTo(90 * DEG, 6);
  });
});
