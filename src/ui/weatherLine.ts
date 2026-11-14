/**
 * The weather at a place as one line, for the time bar and the debug panel:
 * cover, ceiling, visibility, wind, temperature, then what is in the air
 * (rain or snow with its rate, a thunderstorm, dust).
 */
import { DEG, HOUR } from '../core/units';
import type { GameTime } from '../core/units';
import type { Vec3d } from '../core/vec3d';
import type { WeatherView } from '../sim/weather/frame';

/** Storm intensity from which the line says "thunderstorm". */
export const STORM_NAMED = 0.3;
/** Dust loads from which the line says "dust" and "dust storm". */
export const DUST_NAMED = 0.15;
export const DUST_STORM_NAMED = 0.6;

/** Weather at a direction from the planet center and a game time, as one line. */
export function weatherLine(view: WeatherView | null, dir: Readonly<Vec3d>, t: GameTime): string {
  if (!view || !view.ready) return 'weather —';
  const r = view.report(dir, t);
  const w = view.wind(dir, 10, t);
  const from = ((Math.atan2(-w.east, -w.north) / DEG + 360) % 360).toFixed(0).padStart(3, '0');
  const speed = Math.hypot(w.east, w.north);
  const ceiling = Number.isFinite(r.ceiling)
    ? `ceiling ${Math.round(r.ceiling / 10) * 10} m`
    : 'no ceiling';
  const mmh = r.precipitation * HOUR * 1000;
  const falling = r.snow > 0.5 ? 'snow' : 'rain';
  let air = '';
  if (r.storm >= STORM_NAMED) air += `, thunderstorm${mmh >= 0.1 ? ` ${mmh.toFixed(1)} mm/h` : ''}`;
  else if (mmh >= 0.1) air += `, ${falling} ${mmh.toFixed(1)} mm/h`;
  if (r.dust >= DUST_STORM_NAMED) air += ', dust storm';
  else if (r.dust >= DUST_NAMED) air += ', dust';
  const vis =
    r.visibility >= 10_000
      ? `${Math.round(r.visibility / 1000)} km`
      : `${(r.visibility / 1000).toFixed(1)} km`;
  return (
    `cloud ${Math.round(r.cloudCover * 100)}%, ${ceiling}, vis ${vis}, ` +
    `wind ${from}° ${speed.toFixed(0)} m/s, ${r.temperature.toFixed(0)} °C${air}`
  );
}
