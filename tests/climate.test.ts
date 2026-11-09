import { describe, expect, it } from 'vitest';
import { CubeGrid } from '../src/core/cubeGrid';
import { latLonToDirection } from '../src/core/coords';
import { rng } from '../src/core/rng';
import { DEG, KM } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import {
  climateResolution,
  computeClimate,
  dailyInsolation,
  insolationYear,
  prevailingWind,
} from '../src/worldgen/climate';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';

describe('insolation', () => {
  it('matches known values', () => {
    // Equinox at the equator: S0/π.
    expect(dailyInsolation(0, 0)).toBeCloseTo(1361 / Math.PI, 6);
    // Polar night.
    expect(dailyInsolation(80 * DEG, -20 * DEG)).toBe(0);
    // Earth-like annual means: about 417 at the equator, 173 at the pole.
    expect(insolationYear(0, 23.44 * DEG).mean).toBeCloseTo(417, -1);
    expect(insolationYear(89.9 * DEG, 23.44 * DEG).mean).toBeCloseTo(173, -1);
  });

  it('has no seasons without tilt', () => {
    for (const lat of [0, 30, 60, 85]) expect(insolationYear(lat * DEG, 0).swing).toBeCloseTo(0, 6);
    expect(insolationYear(45 * DEG, 23.44 * DEG).swing).toBeGreaterThan(100);
  });
});

describe('prevailing wind', () => {
  it('has trades, westerlies and polar easterlies', () => {
    expect(prevailingWind(10 * DEG)[0]).toBeLessThan(0);
    expect(prevailingWind(45 * DEG)[0]).toBeGreaterThan(0);
    expect(prevailingWind(-45 * DEG)[0]).toBeGreaterThan(0);
    expect(prevailingWind(75 * DEG)[0]).toBeLessThan(0);
    // Trades blow toward the equator in both hemispheres.
    expect(prevailingWind(15 * DEG)[1]).toBeLessThan(0);
    expect(prevailingWind(-15 * DEG)[1]).toBeGreaterThan(0);
  });
});

describe('computeClimate', () => {
  const n = 48;
  const grid = new CubeGrid(n);
  const R = DEFAULT_PLANET_PARAMS.radius;
  const relief = DEFAULT_PLANET_PARAMS.reliefScale;
  // Ocean west of 40° W; land from 40° W eastward to 120° E; a 3 km (reference)
  // north–south range at longitude 0 in the westerlies.
  const height = new Float32Array(grid.cellCount);
  const d = new Vec3d();
  for (let c = 0; c < grid.cellCount; c++) {
    grid.center(c, d);
    const lat = Math.asin(d.y);
    const lon = Math.atan2(d.x, d.z);
    const isLand = lon > -40 * DEG && lon < 120 * DEG && Math.abs(lat) < 75 * DEG;
    const ridgeKm = (Math.abs(lon) * Math.cos(lat) * R) / KM;
    const ridge = 3000 * Math.exp(-((ridgeKm / 120) ** 2));
    height[c] = isLand ? (200 + ridge) * relief : -3000 * relief;
  }
  const at = (latDeg: number, lonDeg: number) =>
    grid.cellOfDirection(latLonToDirection(latDeg * DEG, lonDeg * DEG));

  it('puts a rain shadow behind a range in the westerlies', () => {
    const cl = computeClimate(grid, DEFAULT_PLANET_PARAMS, height, rng(1, 'climate'));
    let windward = 0;
    let leeward = 0;
    for (const lat of [40, 45, 50, -40, -45, -50]) {
      windward += cl.precipitation[at(lat, -6)]!;
      leeward += cl.precipitation[at(lat, 10)]!;
    }
    expect(windward).toBeGreaterThan(1.5 * leeward);
  });

  it('has seasons from tilt, none without', () => {
    const tilted = computeClimate(grid, DEFAULT_PLANET_PARAMS, height, rng(1, 'climate'));
    const flat = computeClimate(
      grid,
      { ...DEFAULT_PLANET_PARAMS, axialTilt: 0 },
      height,
      rng(1, 'climate'),
    );
    expect(Math.max(...flat.temperatureRange)).toBeCloseTo(0, 6);
    // Continental mid-latitudes swing more than the ocean at the same latitude.
    expect(tilted.temperatureRange[at(50, 60)]!).toBeGreaterThan(10);
    expect(tilted.temperatureRange[at(50, -90)]!).toBeLessThan(6);
  });

  it('normalizes precipitation to an Earth-like global mean and scales with moistureScale', () => {
    const base = computeClimate(grid, DEFAULT_PLANET_PARAMS, height, rng(1, 'climate'));
    const wet = computeClimate(
      grid,
      { ...DEFAULT_PLANET_PARAMS, moistureScale: 2 },
      height,
      rng(1, 'climate'),
    );
    let sum = 0;
    let area = 0;
    for (let c = 0; c < grid.cellCount; c++) {
      sum += base.precipitation[c]! * grid.areas[c]!;
      area += grid.areas[c]!;
      expect(wet.precipitation[c]!).toBeCloseTo(2 * base.precipitation[c]!, 2);
    }
    expect(sum / area).toBeGreaterThan(800);
    expect(sum / area).toBeLessThan(1300);
  });

  it('picks a power-of-two climate resolution', () => {
    expect(climateResolution(512)).toBe(128);
    expect(climateResolution(256)).toBe(128);
    expect(climateResolution(64)).toBe(64);
    expect(climateResolution(24)).toBe(24);
  });
});
