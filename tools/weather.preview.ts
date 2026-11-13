/**
 * Offline weather preview (milestone 6): runs the sim's weather model on a
 * coarse world and writes equirectangular maps of cloud cover, precipitation,
 * storms, dust and isobars, plus statistics on the console.
 *
 *   npm run weather   (or npx vitest run --config vitest.tools.config.ts tools/weather.preview.ts)
 *   env: SEED (1983), RES tectonic resolution (128), HOURS comma list of game
 *        hours to draw (0,6,12,24,48), DAYS of statistics (14), PRESET a weather
 *        preset to draw instead of the live weather (sim/weather/presets.ts)
 *
 * The maps: land and sea under white cloud; rain blue and snow violet, darker
 * with the rate; thunderstorms red (cores at full strength); dust ochre;
 * isobars every 4 hPa; wind arrows at 850 hPa. The statistics include the
 * distribution of precipitation rates, how storms relate to rain, and where
 * and how often dust rises.
 *
 * Output: tools/out/weather-<seed>-h<hour>[-<preset>].png (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { defaultCampaignStart } from '../src/core/calendar';
import { latLonToDirection } from '../src/core/coords';
import { HOUR, DEG } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { buildWeatherClimate } from '../src/sim/weather/climate';
import { Channel, CEILING_COVER, MM_PER_HOUR, WeatherView } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';
import { dustSource, STORM_CORE_RATE, SystemKind } from '../src/sim/weather/model';
import { presetFrame, WEATHER_PRESETS } from '../src/sim/weather/presets';
import type { WeatherPreset } from '../src/sim/weather/presets';
import { StandaloneWeather } from '../src/sim/weather/standalone';
import { createSimWorld } from '../src/sim/world';
import { DEFAULT_PLANET_PARAMS } from '../src/worldgen/params';
import { generateWorld } from '../src/worldgen/pipeline';
import { encodePng } from './png';

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

it('weather preview', () => {
  const seed = Number(process.env.SEED ?? 1983);
  const res = Number(process.env.RES ?? 128);
  const hours = (process.env.HOURS ?? '0,6,12,24,48').split(',').map(Number);
  const days = Number(process.env.DAYS ?? 14);
  const preset = (process.env.PRESET ?? 'live') as WeatherPreset;
  if (!WEATHER_PRESETS.includes(preset)) throw new RangeError(`Unknown preset ${preset}`);
  const params = { ...DEFAULT_PLANET_PARAMS, seed };
  const world = generateWorld(params, { resolution: res });
  const grid = new WeatherGrid();
  const climate = buildWeatherClimate(
    { ...world.maps, resolution: res, reliefScale: world.info.reliefScale },
    grid,
    params.radius,
  );
  const calendar = defaultCampaignStart(new Vec3d(...world.info.mainContinent), params);
  const t0 = performance.now();
  const w = createSimWorld({ seed, radius: params.radius, orbit: params, calendar, climate });
  console.info(
    `spin-up ${(performance.now() - t0).toFixed(0)} ms, ${w.weather.systems.length} systems`,
  );
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  const W = 720;
  const H = 360;
  const draw = (hour: number) => {
    w.sim.advanceTo(hour * HOUR);
    const t = hour * HOUR;
    const view = new WeatherView(grid);
    for (const f of w.weather.view().frames) if (f) view.add(presetFrame(preset, f, grid));
    const rgb = new Uint8Array(W * H * 3);
    const d = new Vec3d();
    const pressure = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        latLonToDirection(
          (90 - (y + 0.5) * (180 / H)) * DEG,
          ((x + 0.5) * (360 / W) - 180) * DEG,
          d,
        );
        pressure[y * W + x] = view.sample(Channel.Pressure, d, t);
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        latLonToDirection(
          (90 - (y + 0.5) * (180 / H)) * DEG,
          ((x + 0.5) * (360 / W) - 180) * DEG,
          d,
        );
        const land = climate.land[grid.nearest(d)]!;
        let r = 20 + 50 * land;
        let g = 40 + 70 * land;
        let b = 90 - 50 * land;
        const cover = view.sample(Channel.Cover, d, t);
        const precip = view.sample(Channel.Precipitation, d, t) * HOUR * 1000; // mm/h
        const snow = view.sample(Channel.Snow, d, t);
        r += (235 - r) * cover;
        g += (235 - g) * cover;
        b += (240 - b) * cover;
        const p = Math.min(1, precip / 3);
        // Rain darkens toward navy from 3 to 30 mm/h.
        const heavy = Math.min(1, Math.max(0, Math.log10(Math.max(precip, 3) / 3)));
        r += ((snow > 0.5 ? 200 : 40 - 30 * heavy) - r) * p;
        g += ((snow > 0.5 ? 120 : 90 - 60 * heavy) - g) * p;
        b += ((snow > 0.5 ? 230 : 220 - 90 * heavy) - b) * p;
        const storm = view.sample(Channel.Storm, d, t);
        r += (230 - r) * storm;
        g += (40 - g) * storm;
        b += (60 - b) * storm;
        const dust = Math.min(1, 1.5 * view.sample(Channel.Dust, d, t));
        r += (214 - r) * dust;
        g += (160 - g) * dust;
        b += (70 - b) * dust;
        const band = Math.floor(pressure[y * W + x]! / 400);
        const edge =
          (x + 1 < W && Math.floor(pressure[y * W + x + 1]! / 400) !== band) ||
          (y + 1 < H && Math.floor(pressure[(y + 1) * W + x]! / 400) !== band);
        if (edge) r = g = b = 30;
        rgb.set([r, g, b], (y * W + x) * 3);
      }
    }
    // Wind arrows at 850 hPa every 30 px.
    for (let y = 15; y < H; y += 30) {
      for (let x = 15; x < W; x += 30) {
        latLonToDirection(
          (90 - (y + 0.5) * (180 / H)) * DEG,
          ((x + 0.5) * (360 / W) - 180) * DEG,
          d,
        );
        const wind = view.wind(d, 1500, t);
        const speed = Math.hypot(wind.east, wind.north) || 1;
        const len = Math.min(28, speed * 1.2);
        for (let s = 0; s < len; s++) {
          const px = Math.round(x + (wind.east / speed) * s);
          const py = Math.round(y - (wind.north / speed) * s);
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          rgb.set(s < 2 ? [255, 60, 60] : [255, 220, 80], (py * W + px) * 3);
        }
      }
    }
    const suffix = preset === 'live' ? '' : `-${preset}`;
    const file = join(outDir, `weather-${seed}-h${hour}${suffix}.png`);
    writeFileSync(file, encodePng(W, H, rgb));
    console.info(`wrote ${file}`);
  };
  for (const h of hours.sort((a, b) => a - b)) draw(h);

  // The standalone weather's cold start (Free Flight): the cost of each unit of work, and in all.
  const config = { seed, radius: params.radius, orbit: params, calendar, climate };
  for (const at of [0.5, 20.5]) {
    const alone = new StandaloneWeather(config);
    const units: number[] = [];
    let done = false;
    while (!done) {
      const u0 = performance.now();
      done = alone.prepare(at * HOUR, 0);
      units.push(performance.now() - u0);
    }
    const p0 = performance.now();
    presetFrame('storm', alone.view(at * HOUR).frames[0]!, grid);
    const presetMs = performance.now() - p0;
    console.info(
      `standalone cold start at hour ${at}: units ${units.map((u) => u.toFixed(1)).join(', ')} ms ` +
        `(longest ${Math.max(...units).toFixed(1)}, total ${units.reduce((a, b) => a + b, 0).toFixed(1)}); ` +
        `a preset frame ${presetMs.toFixed(2)} ms`,
    );
  }

  // Statistics over `days` of hourly frames from the last drawn hour.
  const start = w.weather.hour;
  const n = grid.count;
  const clear = new Float64Array(n);
  let cover = 0;
  let precip = 0;
  let ifr = 0;
  let systems = 0;
  let maxJet = 0;
  let maxSurface = 0;
  const kinds = [0, 0, 0];
  const steps = days * 24;
  // Precipitation rates (mm/h): share of the samples with measurable precipitation per class.
  const RATE_EDGES = [0.2, 1, 4, 10, 30];
  const RATE_NAMES = ['< 0.2', '0.2–1', '1–4', '4–10', '10–30', '≥ 30'];
  const rates = new Float64Array(RATE_EDGES.length + 1);
  let wet = 0;
  let rateSum = 0;
  let coreSum = 0;
  let maxRate = 0;
  // Storms against rain: samples raining at 0.2 mm/h or more, with and without a storm.
  let raining = 0;
  let stormy = 0;
  let stormRate = 0;
  let plainRate = 0;
  let stormSnow = 0;
  let stormTropics = 0;
  let stormLand = 0;
  let maxStorm = 0;
  // Dust per class of ground: arid land (dust source above 0.5), its fringe (some source), elsewhere.
  const source = Float64Array.from({ length: n }, (_, s) => dustSource(climate, s));
  const groundClass = (s: number) => (source[s]! > 0.5 ? 0 : source[s]! > 0 ? 1 : 2);
  const classHours = [0, 0, 0];
  const dustAbove = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const DUST_LEVELS = [0.1, 0.5, 0.9];
  const sawStorm = new Uint8Array(n);
  let dustMinVisibility = Infinity;
  const t1 = performance.now();
  for (let k = 0; k < steps; k++) {
    w.sim.advanceTo((start + k) * HOUR);
    const data = w.weather.frameData(w.weather.hour);
    for (let s = 0; s < n; s++) {
      const c = data[Channel.Cover * n + s]!;
      cover += c / (n * steps);
      if (c < 0.3) clear[s]! += 1 / steps;
      precip += data[Channel.Precipitation * n + s]! > 0.2 / 3.6e6 ? 1 / (n * steps) : 0;
      const ceiling = c >= CEILING_COVER ? data[Channel.CloudBase * n + s]! : Infinity;
      if (ceiling < 300 || data[Channel.Visibility * n + s]! < 1600) ifr += 1 / (n * steps);
      maxJet = Math.max(
        maxJet,
        Math.hypot(data[(Channel.WindEast0 + 6) * n + s]!, data[(Channel.WindEast0 + 7) * n + s]!),
      );
      maxSurface = Math.max(
        maxSurface,
        Math.hypot(data[Channel.WindEast0 * n + s]!, data[(Channel.WindEast0 + 1) * n + s]!),
      );
      const mmh = data[Channel.Precipitation * n + s]! * HOUR * 1000;
      const storm = data[Channel.Storm * n + s]!;
      const dust = data[Channel.Dust * n + s]!;
      rateSum += mmh;
      coreSum += (STORM_CORE_RATE / MM_PER_HOUR) * storm * storm;
      maxRate = Math.max(maxRate, mmh);
      maxStorm = Math.max(maxStorm, storm);
      if (mmh >= 0.01) {
        wet++;
        let bin = 0;
        while (bin < RATE_EDGES.length && mmh >= RATE_EDGES[bin]!) bin++;
        rates[bin]!++;
      }
      if (mmh >= 0.2) {
        raining++;
        if (storm >= 0.2) {
          stormy++;
          stormRate += mmh;
          if (Math.abs(grid.lat[s]!) < 25 * DEG) stormTropics++;
          if (climate.land[s]! > 0.5) stormLand++;
          if (data[Channel.Snow * n + s]! > 0) stormSnow++;
        } else {
          plainRate += mmh;
        }
      }
      const cls = groundClass(s);
      classHours[cls]!++;
      for (let l = 0; l < DUST_LEVELS.length; l++)
        if (dust >= DUST_LEVELS[l]!) dustAbove[l]![cls]!++;
      if (dust >= 0.9) {
        sawStorm[s] = 1;
        dustMinVisibility = Math.min(dustMinVisibility, data[Channel.Visibility * n + s]!);
      }
    }
    systems += w.weather.systems.length / steps;
    for (const s of w.weather.systems) kinds[s.kind]! += 1 / steps;
  }
  const ms = (performance.now() - t1) / steps;
  const sorted = Array.from(clear).sort((a, b) => a - b);
  if (process.env.DEBUG) {
    const worst = Array.from(clear, (c, s) => [c, s] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 8);
    for (const [c, s] of worst) {
      console.info(
        `clear ${(c * 100).toFixed(0)}% lat ${(grid.lat[s]! / DEG).toFixed(0)} land ${climate.land[s]!.toFixed(2)} wet ${climate.wetness[s]!.toFixed(2)} slope ${(Math.hypot(climate.slopeEast[s]!, climate.slopeNorth[s]!) * 1000).toFixed(1)} m/km`,
      );
    }
  }
  console.info(
    [
      `${days} days: ${ms.toFixed(2)} ms per hour (tick + fields)`,
      `systems ${systems.toFixed(1)} (lows ${kinds[SystemKind.Low]!.toFixed(1)}, highs ${kinds[SystemKind.High]!.toFixed(1)}, tropical ${kinds[SystemKind.Tropical]!.toFixed(1)})`,
      `mean cover ${(cover * 100).toFixed(0)}%, precipitating ${(precip * 100).toFixed(0)}%, IFR ${(ifr * 100).toFixed(0)}%`,
      `clear fraction per sample: min ${(sorted[0]! * 100).toFixed(0)}%, 5th pct ${(sorted[Math.floor(n * 0.05)]! * 100).toFixed(0)}%, median ${(sorted[Math.floor(n / 2)]! * 100).toFixed(0)}%`,
      `max wind: surface ${maxSurface.toFixed(0)} m/s, 250 hPa ${maxJet.toFixed(0)} m/s`,
      `precipitation: mean ${(rateSum / (n * steps)).toFixed(3)} mm/h (${(coreSum / (n * steps)).toFixed(3)} from storm cores), max ${maxRate.toFixed(1)} mm/h`,
      `  rates (mm/h) among samples with any: ${RATE_NAMES.map((name, i) => `${name}: ${pct(rates[i]! / wet)}`).join(', ')}`,
      `storms: ${pct(stormy / raining)} of raining samples (${pct(stormy / (n * steps), 2)} of all), max intensity ${maxStorm.toFixed(2)}`,
      `  rain in storms ${(stormRate / Math.max(1, stormy)).toFixed(1)} mm/h against ${(plainRate / Math.max(1, raining - stormy)).toFixed(1)} mm/h outside; storms with snow: ${stormSnow}`,
      `  ${pct(stormTropics / Math.max(1, stormy))} of storms within 25° of the equator, ${pct(stormLand / Math.max(1, stormy))} over land`,
      ...['arid land', 'the arid fringe', 'everywhere else'].map(
        (name, cls) =>
          `dust over ${name} (${pct(classHours[cls]! / (n * steps))} of samples): ` +
          DUST_LEVELS.map(
            (level, l) =>
              `≥ ${level}: ${pct(dustAbove[l]![cls]! / Math.max(1, classHours[cls]!), 2)}`,
          ).join(', ') +
          ' of hours',
      ),
      `  arid samples with a full dust storm in ${days} days: ${pct(
        Array.from(sawStorm).filter((v, s) => v && groundClass(s) === 0).length /
          Math.max(1, Array.from(source).filter((v) => v > 0.5).length),
      )}; lowest visibility in one ${Number.isFinite(dustMinVisibility) ? dustMinVisibility.toFixed(0) + ' m' : '—'}`,
    ].join('\n'),
  );
});
