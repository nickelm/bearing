import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  DEFAULT_HILLSHADE,
  hillshade,
  hillshadeLight,
  HILLSHADE_MAX,
} from '../src/render/strategic/hillshade';
import { StrategicCamera, STRATEGIC_FLOOR } from '../src/render/strategic/strategicCamera';

/** A camera and its screen right and up. */
function camera(altitude: number, heading = 0) {
  const o = new StrategicCamera(1000 * KM);
  o.lat = 10 * DEG;
  o.lon = 20 * DEG;
  o.heading = heading;
  o.altitude = o.targetAltitude = altitude;
  o.update(0);
  const right = o.forward.clone().cross(o.up).normalize();
  return { o, right, up: o.up };
}

/** Normal of a slope tilted by `slope` toward the horizontal direction `toward`. */
function tilted(radial: Vec3d, toward: Vec3d, slope: number): Vec3d {
  const t = toward.clone().addScaled(radial, -toward.dot(radial)).normalize();
  return radial.clone().scale(Math.cos(slope)).addScaled(t, Math.sin(slope));
}

describe('cartographic hillshade', () => {
  it('leaves flat ground at 1 everywhere on the globe, at any zoom and heading', () => {
    for (const [alt, heading] of [
      [3000 * KM, 0],
      [STRATEGIC_FLOOR, 0],
      [STRATEGIC_FLOOR, 2],
    ] as const) {
      const { right, up } = camera(alt, heading);
      for (const [lat, lon] of [
        [10, 20],
        [60, 20],
        [-30, 70],
        [10, 95],
      ]) {
        const r = latLonToDirection(lat * DEG, lon * DEG, new Vec3d());
        expect(hillshade(r, r, right, up)).toBeCloseTo(1, 12);
      }
    }
  });

  it('puts the light at its elevation above the ground, toward the screen upper left', () => {
    const { o, right, up } = camera(3000 * KM);
    const r = latLonToDirection(o.lat, o.lon, new Vec3d());
    const L = hillshadeLight(r, right, up, DEFAULT_HILLSHADE.elevation);
    expect(L.length()).toBeCloseTo(1, 12);
    expect(L.dot(r)).toBeCloseTo(Math.sin(DEFAULT_HILLSHADE.elevation), 12);
    // Its horizontal part points up the screen and to the left.
    expect(L.dot(up)).toBeGreaterThan(0);
    expect(L.dot(right)).toBeLessThan(0);
  });

  it('brightens slopes facing the light and darkens those facing away, within bounds', () => {
    const { o, right, up } = camera(STRATEGIC_FLOOR, 0.7);
    const r = latLonToDirection(o.lat, o.lon, new Vec3d());
    // Directions on the ground: toward the light, away from it, and across it.
    const L = hillshadeLight(r, right, up, DEFAULT_HILLSHADE.elevation);
    const toward = L.clone().addScaled(r, -L.dot(r));
    const away = toward.clone().scale(-1);
    const across = r.clone().cross(toward);
    const lit = hillshade(tilted(r, toward, 30 * DEG), r, right, up);
    const shadow = hillshade(tilted(r, away, 30 * DEG), r, right, up);
    const side = hillshade(tilted(r, across, 30 * DEG), r, right, up);
    expect(lit).toBeGreaterThan(1.2);
    expect(lit).toBeLessThanOrEqual(HILLSHADE_MAX);
    expect(shadow).toBeLessThan(0.6);
    expect(shadow).toBeGreaterThanOrEqual(DEFAULT_HILLSHADE.ambient);
    // The light still comes from the screen's upper left.
    expect(toward.dot(up)).toBeGreaterThan(0);
    expect(toward.dot(right)).toBeLessThan(0);
    // A slope across the light is a little darker than flat (it faces away from the zenith).
    expect(side).toBeLessThan(1);
    expect(side).toBeGreaterThan(shadow);
    // A cliff facing away never goes below the shadow floor.
    expect(hillshade(tilted(r, away, 85 * DEG), r, right, up)).toBe(DEFAULT_HILLSHADE.ambient);
  });

  it('scales with strength: 0 is flat everywhere', () => {
    const { o, right, up } = camera(STRATEGIC_FLOOR);
    const r = latLonToDirection(o.lat, o.lon, new Vec3d());
    const n = tilted(r, up.clone().sub(right), 25 * DEG);
    expect(hillshade(n, r, right, up, { ...DEFAULT_HILLSHADE, strength: 0 })).toBe(1);
    const one = hillshade(n, r, right, up);
    const two = hillshade(n, r, right, up, { ...DEFAULT_HILLSHADE, strength: 2 });
    expect(two).toBeGreaterThanOrEqual(one);
  });
});
