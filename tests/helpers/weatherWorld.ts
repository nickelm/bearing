/** A synthetic climate for weather and sim tests: no world generation needed. */
import { EARTH_ORBIT } from '../../src/core/calendar';
import { CubeGrid } from '../../src/core/cubeGrid';
import { DEG } from '../../src/core/units';
import { buildWeatherClimate } from '../../src/sim/weather/climate';
import type { ClimateSource } from '../../src/sim/weather/climate';
import { WeatherGrid } from '../../src/sim/weather/grid';
import type { SimConfig } from '../../src/sim/world';

export const RADIUS = 1_000_000;

/**
 * Two continents (a band of longitudes in each hemisphere's mid-latitudes and
 * one across the tropics), a mountain ridge, Earth-like zonal winds and
 * temperatures, wet tropics and storm tracks.
 */
export function syntheticSource(n = 48): ClimateSource {
  const grid = new CubeGrid(n);
  const count = grid.cellCount;
  const src = {
    resolution: n,
    height: new Float32Array(count),
    temperature: new Float32Array(count),
    temperatureRange: new Float32Array(count),
    precipitation: new Float32Array(count),
    windEast: new Float32Array(count),
    windNorth: new Float32Array(count),
    reliefScale: RADIUS / 6_371_000,
  };
  for (let c = 0; c < count; c++) {
    const lat = Math.asin(grid.centers[c * 3 + 1]!) / DEG;
    const lon = Math.atan2(grid.centers[c * 3]!, grid.centers[c * 3 + 2]!) / DEG;
    const a = Math.abs(lat);
    const land =
      (lon > -60 && lon < 40 && a < 60) || (lon > 90 && lon < 150 && lat > 10 && lat < 55);
    const ridge = land && Math.abs(lon + 20) < 4 ? 500 : 0;
    src.height[c] = land ? 100 + ridge : -2000;
    src.temperature[c] = 28 - 0.5 * a - (land ? ridge * 0.04 : 0);
    src.temperatureRange[c] = (land ? 0.35 : 0.15) * a;
    src.precipitation[c] =
      300 + 2200 * Math.exp(-((a / 10) ** 2)) + 1200 * Math.exp(-(((a - 50) / 10) ** 2));
    src.windEast[c] = -6 * Math.exp(-((a / 15) ** 2)) + 8 * Math.exp(-(((a - 45) / 12) ** 2));
  }
  return src;
}

export function syntheticConfig(seed: number | string = 7): SimConfig {
  return {
    seed,
    radius: RADIUS,
    orbit: EARTH_ORBIT,
    calendar: { startDay: 226, startTimeOfDay: 6 * 3600 },
    climate: buildWeatherClimate(syntheticSource(), new WeatherGrid(), RADIUS),
  };
}
