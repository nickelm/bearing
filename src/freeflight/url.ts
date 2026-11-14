/**
 * Free Flight's state in the URL (decision 134), so a reload or a shared link
 * returns to the same flight:
 *
 *   ?mode=freeflight&seed=…&base=…&tod=…&weather=<preset>&spawn=runway|air
 *     &fuel=unlimited|limited&wind=off&autopilot
 *
 * `weather` is a preset of sim/weather/presets.ts (`fair` by default, `live`
 * for the world's own weather at that hour); `wind=off` flies in still air.
 * Values the mode does not know are ignored, and the defaults apply.
 */
import { WEATHER_PRESETS } from '../sim/weather/presets';
import type { WeatherPreset } from '../sim/weather/presets';
import type { FreeFlightOptions } from '../ui/flight/freeFlightMenu';

/** What the URL asks for. */
export interface FreeFlightUrl {
  seed: string;
  base: number | null;
  options: Partial<FreeFlightOptions>;
  autopilot: boolean;
}

/** Reads the mode's options from the URL's query; `seed` is the app's world seed. */
export function parseFreeFlightUrl(q: URLSearchParams, seed: string): FreeFlightUrl {
  const options: Partial<FreeFlightOptions> = {};
  const tod = Number(q.get('tod'));
  if (q.has('tod') && Number.isFinite(tod)) options.timeOfDay = Math.min(24, Math.max(0, tod));
  const spawn = q.get('spawn');
  if (spawn === 'air' || spawn === 'runway') options.spawn = spawn;
  const fuel = q.get('fuel');
  if (fuel === 'limited') options.unlimitedFuel = false;
  if (fuel === 'unlimited') options.unlimitedFuel = true;
  const weather = q.get('weather')?.toLowerCase();
  if (weather !== undefined && (WEATHER_PRESETS as readonly string[]).includes(weather))
    options.weather = weather as WeatherPreset;
  const wind = q.get('wind');
  if (wind === 'off') options.wind = false;
  if (wind === 'on') options.wind = true;
  const base = q.has('base') ? Number(q.get('base')) : NaN;
  return {
    seed,
    base: Number.isInteger(base) ? base : null,
    options,
    autopilot: q.has('autopilot'),
  };
}

/** Writes the mode's state into a URL's query (other parameters stay as they are). */
export function writeFreeFlightParams(
  q: URLSearchParams,
  options: Readonly<FreeFlightOptions>,
  base: number | null,
): void {
  q.set('mode', 'freeflight');
  if (base !== null) q.set('base', String(base));
  q.set('tod', String(options.timeOfDay));
  q.set('weather', options.weather);
  // Wind is on by default: the URL names it only when it is off.
  if (options.wind) q.delete('wind');
  else q.set('wind', 'off');
  q.set('spawn', options.spawn);
  q.set('fuel', options.unlimitedFuel ? 'unlimited' : 'limited');
}
