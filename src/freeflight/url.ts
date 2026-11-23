/**
 * Free Flight's state in the URL (decision 134), so a reload or a shared link
 * returns to the same flight:
 *
 *   ?mode=freeflight&seed=…&base=…&tod=…&weather=<preset>&spawn=runway|air
 *     &fuel=unlimited|limited&wind=off&aircraft=kestrel|vo31|vo35|scout|utility&control=aim|direct
 *     &invert=aim,stick,helo&autopilot
 *
 * `weather` is a preset of sim/weather/presets.ts (`fair` by default, `live`
 * for the world's own weather at that hour); `wind=off` flies in still air;
 * `control` is the jet's mouse mode, and `invert` lists the ways of flying whose mouse up and
 * down is inverted (decisions 196, 198; the first version's `jet` reads as `aim`).
 * Values the mode does not know are ignored, and the defaults apply.
 */
import { WEATHER_PRESETS } from '../sim/weather/presets';
import type { WeatherPreset } from '../sim/weather/presets';
import { AIRCRAFT_CHOICES } from '../ui/flight/freeFlightMenu';
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
  const micro = q.get('micro');
  if (micro === 'on') options.microFacets = true;
  if (micro === 'off') options.microFacets = false;
  if (q.get('fps') === 'off') options.showFps = false;
  if (q.get('fps') === 'on') options.showFps = true;
  if (q.get('traffic') === 'on') options.traffic = true;
  if (q.get('traffic') === 'off') options.traffic = false;
  const ui = Number(q.get('ui'));
  if (q.has('ui') && Number.isFinite(ui)) options.uiScale = Math.min(1.5, Math.max(0.75, ui));
  const aircraft = q.get('aircraft');
  const choice = AIRCRAFT_CHOICES.find((c) => c.id === aircraft);
  if (choice) options.aircraft = choice.id;
  if (q.has('invert')) {
    const kinds = (q.get('invert') ?? '').split(',');
    options.invertAim = kinds.includes('aim') || kinds.includes('jet');
    options.invertStick = kinds.includes('stick');
    options.invertHelo = kinds.includes('helo');
  }
  const loadout = q.get('loadout');
  if (loadout) options.loadout = loadout === 'standard' ? null : loadout;
  const control = q.get('control');
  if (control === 'aim' || control === 'direct') options.control = control;
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
  // Micro-facets are off by default: the URL names them only when on (decision 197).
  if (options.microFacets) q.set('micro', 'on');
  else q.delete('micro');
  // The displays' scale: named only when not 1 (decision 200).
  if (options.uiScale !== 1) q.set('ui', String(options.uiScale));
  else q.delete('ui');
  // The frame-rate gauge is on by default (decision 217).
  if (options.showFps) q.delete('fps');
  else q.set('fps', 'off');
  // Traffic is off by default (decision 218).
  if (options.traffic) q.set('traffic', 'on');
  else q.delete('traffic');
  q.set('spawn', options.spawn);
  q.set('fuel', options.unlimitedFuel ? 'unlimited' : 'limited');
  q.set('aircraft', options.aircraft);
  q.set('control', options.control);
  // The jet's loadout: named only when not the standard one (decision 300).
  if (options.loadout) q.set('loadout', options.loadout);
  else q.delete('loadout');
  const inverted = [
    options.invertAim && 'aim',
    options.invertStick && 'stick',
    options.invertHelo && 'helo',
  ].filter(Boolean);
  if (inverted.length) q.set('invert', inverted.join(','));
  else q.delete('invert');
}
