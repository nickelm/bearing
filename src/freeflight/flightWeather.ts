/**
 * Free Flight's weather (decisions 134, 137): the mode runs no simulation
 * worker, so the weather model runs here on the main thread
 * (sim/weather/standalone.ts), a few milliseconds per frame, and is shown as
 * the preset the player chose on the start screen.
 *
 * `update` works toward the frames around a game time and feeds the scene's
 * weather texture, as the app does from the sim's frames; it returns the view
 * the scene reads the weather at the camera from, or null while there is
 * none. `finish` completes the work at once (a flight starts now). On the
 * start screen `prepare` does the work ahead of the flight without showing
 * it, and `hide` clears the texture: the map there is for choosing a base and
 * shows no weather.
 *
 * A preset holds the air's temperature within its range (a snowfall below
 * −3 °C), while snow on the ground follows the climate and the season. So
 * that snow lies where it snows, `temperatureShift` gives how far the preset
 * moved the temperature at a place: the app adds it to the land's.
 */
import type { GameTime } from '../core/units';
import type { Vec3d } from '../core/vec3d';
import type { WeatherTexture } from '../render/sim/clouds/weatherTexture';
import type { WeatherView } from '../sim/weather/frame';
import type { WeatherConfig } from '../sim/weather/model';
import type { WeatherPreset } from '../sim/weather/presets';
import { StandaloneWeather } from '../sim/weather/standalone';

/** Real time a frame may spend on the weather model (ms). */
export const WEATHER_BUDGET_MS = 3;

export class FlightWeather {
  private alone: StandaloneWeather | null = null;
  private current: WeatherView | null = null;
  /** The model's version the texture holds. */
  private uploaded = -1;
  private chosen: WeatherPreset;

  constructor(
    /** The scene's weather texture (`GlobeScene.weather`). */
    private readonly texture: WeatherTexture,
    preset: WeatherPreset = 'fair',
  ) {
    this.chosen = preset;
  }

  /** The world's weather model, or null while there is no world. */
  setWorld(config: WeatherConfig | null): void {
    this.alone = config ? new StandaloneWeather(config, this.chosen) : null;
    this.current = null;
    this.uploaded = -1;
  }

  get preset(): WeatherPreset {
    return this.chosen;
  }

  /** The weather shown; `live` is the model's own. Applies with the next `update`. */
  set preset(preset: WeatherPreset) {
    this.chosen = preset;
    if (this.alone) this.alone.preset = preset;
  }

  /** The view last shown, or null before the first frames exist. */
  get view(): WeatherView | null {
    return this.current;
  }

  /** True if the frames around game time t exist. */
  ready(t: GameTime): boolean {
    return this.alone?.ready(t) ?? false;
  }

  /**
   * Works toward the weather at game time t for about `budgetMs` without
   * showing it (the start screen, ahead of a flight); true once it exists.
   */
  prepare(t: GameTime, budgetMs = WEATHER_BUDGET_MS): boolean {
    return this.alone?.prepare(t, budgetMs) ?? false;
  }

  /** Shows no weather: clears the texture and forgets the view (back on the start screen). */
  hide(): void {
    if (this.current || this.uploaded !== -1) this.texture.fill(0);
    this.current = null;
    this.uploaded = -1;
  }

  /**
   * Works toward the weather at game time t for about `budgetMs`, shows it
   * once it exists and sets the texture's blend. Call once per frame in flight.
   */
  update(t: GameTime, budgetMs = WEATHER_BUDGET_MS): WeatherView | null {
    const alone = this.alone;
    if (!alone) return null;
    if (alone.prepare(t, budgetMs)) this.show(alone, t);
    if (this.current) this.texture.update(this.current, t);
    return this.current;
  }

  /** Completes the weather at game time t now, whatever it takes, and shows it. */
  finish(t: GameTime): WeatherView | null {
    const alone = this.alone;
    if (!alone) return null;
    this.show(alone, t);
    this.texture.update(this.current!, t);
    return this.current;
  }

  /**
   * How far the preset moved the air temperature near the ground (°C) at a
   * direction from the planet center and a game time; 0 for the live weather.
   * Computes the frames around t if they do not exist yet.
   */
  temperatureShift(dir: Readonly<Vec3d>, t: GameTime): number {
    const alone = this.alone;
    if (!alone || this.chosen === 'live') return 0;
    const shown = alone.view(t).report(dir, t).temperature;
    // The model's own temperature: the same frames, shown live for a moment.
    alone.preset = 'live';
    const live = alone.view(t).report(dir, t).temperature;
    alone.preset = this.chosen;
    this.show(alone, t);
    return shown - live;
  }

  private show(alone: StandaloneWeather, t: GameTime): void {
    const view = alone.view(t);
    if (alone.version !== this.uploaded) {
      this.texture.setFrames(view);
      this.uploaded = alone.version;
    }
    this.current = view;
  }
}
