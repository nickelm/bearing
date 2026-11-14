/**
 * Free Flight's options outside the browser: the URL (weather, wind, time of
 * day), the day a flight starts on (a moon that is up all night), and the
 * weather the mode runs itself.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultCampaignStart,
  EARTH_ORBIT,
  localSolarTime,
  sunDirection,
} from '../src/core/calendar';
import { latLonToDirection } from '../src/core/coords';
import {
  moonAge,
  moonDirection,
  moonIlluminatedFraction,
  SYNODIC_MONTH_DAYS,
} from '../src/core/moon';
import { DEG, HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { flightStartTime, freeFlightDay } from '../src/freeflight/clock';
import { FlightWeather } from '../src/freeflight/flightWeather';
import { parseFreeFlightUrl, writeFreeFlightParams } from '../src/freeflight/url';
import { WeatherTexture } from '../src/render/sim/clouds/weatherTexture';
import { PRESET_TABLE, WEATHER_PRESETS } from '../src/sim/weather/presets';
import { StandaloneWeather } from '../src/sim/weather/standalone';
import { DEFAULT_OPTIONS } from '../src/ui/flight/freeFlightMenu';
import { syntheticConfig } from './helpers/weatherWorld';

const parse = (query: string) => parseFreeFlightUrl(new URLSearchParams(query), '7');

describe('Free Flight URL', () => {
  it('reads the weather preset, and ignores one it does not know', () => {
    for (const preset of WEATHER_PRESETS) {
      expect(parse(`mode=freeflight&weather=${preset}`).options.weather).toBe(preset);
    }
    expect(parse('mode=freeflight&weather=STORM').options.weather).toBe('storm');
    expect(parse('mode=freeflight&weather=hail').options).not.toHaveProperty('weather');
    expect(parse('mode=freeflight&weather=').options).not.toHaveProperty('weather');
    expect(parse('mode=freeflight').options).not.toHaveProperty('weather');
    // Fair weather unless the URL says otherwise.
    expect({ ...DEFAULT_OPTIONS, ...parse('mode=freeflight').options }.weather).toBe('fair');
  });

  it('reads wind, time of day, spawn, fuel, base and the autopilot', () => {
    const u = parse(
      'mode=freeflight&base=12&tod=18.5&weather=storm&wind=off&spawn=air&fuel=limited&autopilot',
    );
    expect(u).toEqual({
      seed: '7',
      base: 12,
      options: {
        timeOfDay: 18.5,
        weather: 'storm',
        wind: false,
        spawn: 'air',
        unlimitedFuel: false,
      },
      autopilot: true,
    });
    expect(parse('tod=31').options.timeOfDay).toBe(24);
    expect(parse('tod=dusk').options).not.toHaveProperty('timeOfDay');
    expect(parse('wind=on').options.wind).toBe(true);
    expect(parse('wind=sideways').options).not.toHaveProperty('wind');
    expect(parse('base=1.5').base).toBeNull();
  });

  it('writes what it reads, and keeps the parameters of others', () => {
    const q = new URLSearchParams('seed=42&dev');
    const options = {
      ...DEFAULT_OPTIONS,
      timeOfDay: 5.25,
      weather: 'blizzard' as const,
      wind: false,
    };
    writeFreeFlightParams(q, options, 3);
    expect(q.get('seed')).toBe('42');
    expect(q.has('dev')).toBe(true);
    expect(q.get('mode')).toBe('freeflight');
    const back = parseFreeFlightUrl(q, '42');
    expect(back.base).toBe(3);
    expect({ ...DEFAULT_OPTIONS, ...back.options }).toEqual(options);
    // Wind is named only when it is off; switching it on again removes it.
    writeFreeFlightParams(q, { ...options, wind: true }, null);
    expect(q.has('wind')).toBe(false);
    expect(q.get('base')).toBe('3');
    expect({ ...DEFAULT_OPTIONS, ...parseFreeFlightUrl(q, '42').options }.wind).toBe(true);
  });
});

describe("Free Flight's clock", () => {
  const orbit = EARTH_ORBIT;
  const worlds = [
    { name: 'northern', main: latLonToDirection(45 * DEG, 30 * DEG, new Vec3d()) },
    { name: 'southern', main: latLonToDirection(-40 * DEG, -110 * DEG, new Vec3d()) },
    { name: 'tropical', main: latLonToDirection(8 * DEG, 170 * DEG, new Vec3d()) },
  ];

  it('flies on the day nearest full moon within the first month', () => {
    for (const w of worlds) {
      const calendar = defaultCampaignStart(w.main, orbit);
      const day = freeFlightDay(orbit, calendar);
      expect(day, w.name).toBeGreaterThanOrEqual(1);
      expect(day, w.name).toBeLessThanOrEqual(30);
      const age = moonAge(day * orbit.solarDay, orbit, calendar);
      expect(Math.abs(age - SYNODIC_MONTH_DAYS / 2), w.name).toBeLessThanOrEqual(0.5);
    }
  });

  it('starts at the chosen local time, with the moon up and nearly full all night', () => {
    for (const w of worlds) {
      const calendar = defaultCampaignStart(w.main, orbit);
      const lon = Math.atan2(w.main.x, w.main.z);
      const day = freeFlightDay(orbit, calendar);
      for (const hours of [0, 5.5, 12, 17, 21, 23.75]) {
        const t = flightStartTime(lon, hours, orbit, calendar);
        expect(t).toBeGreaterThan(0);
        expect(Math.abs(t - day * orbit.solarDay)).toBeLessThanOrEqual(orbit.solarDay / 2);
        const local = localSolarTime(t, lon, orbit, calendar) / HOUR;
        expect(Math.min(Math.abs(local - hours), 24 - Math.abs(local - hours))).toBeLessThan(1e-6);
      }
      for (const hours of [21, 0, 3]) {
        const t = flightStartTime(lon, hours, orbit, calendar);
        const sun = sunDirection(t, orbit, calendar, new Vec3d());
        const moon = moonDirection(t, orbit, calendar, new Vec3d());
        expect(sun.dot(w.main), `${w.name} sun at ${hours} h`).toBeLessThan(0);
        expect(moon.dot(w.main), `${w.name} moon at ${hours} h`).toBeGreaterThan(Math.sin(5 * DEG));
        expect(moonIlluminatedFraction(sun, moon), w.name).toBeGreaterThan(0.9);
      }
    }
  });
});

describe("Free Flight's weather", () => {
  const config = syntheticConfig();
  const here = latLonToDirection(20 * DEG, 30 * DEG, new Vec3d());
  const t = 100.3 * HOUR;

  it('shows nothing without a world, and the preset once the frames exist', () => {
    const texture = new WeatherTexture();
    const weather = new FlightWeather(texture, 'storm');
    expect(weather.update(t)).toBeNull();
    expect(weather.finish(t)).toBeNull();
    expect(weather.temperatureShift(here, t)).toBe(0);
    weather.setWorld(config);
    expect(weather.view).toBeNull();
    // A few milliseconds per frame until the frames exist; until then there is no view.
    const uploads = texture.version;
    let frames = 0;
    while (weather.update(t, 0) === null) expect(++frames).toBeLessThan(200);
    expect(frames).toBeGreaterThan(3);
    expect(weather.ready(t)).toBe(true);
    expect(texture.version).toBe(uploads + 1);
    const view = weather.view!;
    const report = view.report(here, t);
    expect(report.storm).toBeGreaterThan(0.5);
    expect(report.cloudCover).toBe(1);
    expect(texture.blend.value).toBeCloseTo(0.3, 5);
    // The same frames the standalone model gives for this preset.
    const alone = new StandaloneWeather(config, 'storm').view(t);
    expect(view.frames[0]!.data).toEqual(alone.frames[0]!.data);
    expect(view.frames[1]!.data).toEqual(alone.frames[1]!.data);
    // Later frames do not upload again within the hour.
    weather.update(t + 60);
    expect(texture.version).toBe(uploads + 1);
    expect(texture.blend.value).toBeCloseTo(0.3 + 60 / HOUR, 5);
  });

  it('prepares ahead without showing, and hides the weather again', () => {
    const texture = new WeatherTexture();
    const weather = new FlightWeather(texture, 'overcast');
    expect(weather.prepare(t)).toBe(false);
    weather.setWorld(config);
    const uploads = texture.version;
    let frames = 0;
    while (!weather.prepare(t, 0)) expect(++frames).toBeLessThan(200);
    // Nothing was shown: the start screen's map has no weather.
    expect(weather.view).toBeNull();
    expect(texture.version).toBe(uploads);
    // The flight starts without further work.
    expect(weather.ready(t)).toBe(true);
    expect(weather.finish(t)!.report(here, t).cloudCover).toBeGreaterThan(0.8);
    expect(texture.version).toBe(uploads + 1);
    // Back on the start screen the texture is clear again, and a new flight uploads again.
    weather.hide();
    expect(weather.view).toBeNull();
    expect(texture.version).toBe(uploads + 2);
    expect(texture.extent(here, 0.1).cover).toBe(0);
    weather.hide();
    expect(texture.version).toBe(uploads + 2);
    expect(weather.finish(t)).not.toBeNull();
    expect(texture.version).toBe(uploads + 3);
    expect(texture.extent(here, 0.1).cover).toBeGreaterThan(0.8);
  });

  it('changes the preset at once and uploads it', () => {
    const texture = new WeatherTexture();
    const weather = new FlightWeather(texture, 'fair');
    weather.setWorld(config);
    expect(weather.finish(t)!.report(here, t).precipitation).toBe(0);
    const uploads = texture.version;
    weather.preset = 'rain';
    expect(weather.preset).toBe('rain');
    const rain = weather.finish(t)!.report(here, t);
    expect(rain.precipitation).toBeGreaterThan(0);
    expect(texture.version).toBeGreaterThan(uploads);
    weather.preset = 'live';
    const live = new StandaloneWeather(config).view(t).report(here, t);
    expect(weather.finish(t)!.report(here, t)).toEqual(live);
  });

  it('gives the shift of the air temperature a preset makes, and leaves the view as it was', () => {
    const texture = new WeatherTexture();
    const weather = new FlightWeather(texture, 'snow');
    weather.setWorld(config);
    const live = new StandaloneWeather(config).view(t).report(here, t).temperature;
    expect(live).toBeGreaterThan(10);
    const shown = weather.finish(t)!.report(here, t);
    expect(shown.temperature).toBe(PRESET_TABLE.snow.temperature[1]);
    expect(weather.temperatureShift(here, t)).toBeCloseTo(
      PRESET_TABLE.snow.temperature[1] - live,
      4,
    );
    // The view still shows the snow, and so does the texture's next upload.
    expect(weather.view!.report(here, t)).toEqual(shown);
    expect(weather.update(t)!.report(here, t).snow).toBe(1);
    // The live weather and a preset without a temperature range move nothing.
    weather.preset = 'live';
    expect(weather.temperatureShift(here, t)).toBe(0);
    weather.preset = 'overcast';
    expect(weather.temperatureShift(here, t)).toBe(0);
    // Hot dust warms the air where the weather is cool.
    weather.preset = 'duststorm';
    expect(weather.temperatureShift(here, t)).toBeCloseTo(
      Math.max(0, PRESET_TABLE.duststorm.temperature[0] - live),
      4,
    );
  });
});
