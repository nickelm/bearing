/**
 * The weather model without the war: Free Flight runs no simulation worker
 * (decision 134), so it runs the same `WeatherModel` on the main thread and
 * reads it through the same `WeatherView`.
 *
 * `StandaloneWeather` steps the model hour by hour exactly as the sim's tick
 * does, so `view(t)` holds the same two frames the full sim's weather has at
 * game time t (the hours ⌊t / HOUR⌋ and the next), optionally turned into a
 * weather preset (presets.ts).
 *
 * The main thread must not stall, and the first fields a page computes are
 * slow (unoptimized code: some 40 ms per hour of fields, against 7 ms once
 * warm), so the work is split into units of a few milliseconds: building the
 * model (its spin-up), a batch of hourly ticks, a part of one hour's fields
 * (the model computes them a few hundred samples at a time), and a preset's
 * frame. `prepare(t, budgetMs)` does units until the frames around t exist or
 * the budget is spent, and says whether they exist; call it once per frame
 * and keep the previous view until it returns true. In the second half of an
 * hour it also computes the next hour's fields ahead of time, so crossing the
 * hour costs nothing. Going back in time (a new flight at an earlier time of
 * day) rebuilds the model, as a seek does in the sim. The budget's clock is
 * real time and decides only when work happens, never its result.
 */
import type { GameTime } from '../../core/units';
import { HOUR } from '../../core/units';
import { WeatherView } from './frame';
import type { WeatherFrame } from './frame';
import { WeatherGrid } from './grid';
import { WeatherModel } from './model';
import type { WeatherConfig } from './model';
import { presetFrame } from './presets';
import type { WeatherPreset } from './presets';

/** Hourly ticks done between two looks at the clock. */
const TICK_BATCH = 16;

export class StandaloneWeather {
  readonly grid: WeatherGrid;
  /** Counts changes of the view's frames (a new hour, a new preset): upload the weather texture when it moves. */
  version = 0;
  private model: WeatherModel | null = null;
  /** Live frames by hour: the two around the last prepared time, and the next once computed. */
  private readonly live = new Map<number, WeatherFrame>();
  /** The same hours as the current preset shows them. */
  private readonly shown = new Map<number, WeatherFrame>();
  private readonly viewState: WeatherView;
  private viewHour = Number.NaN;
  private currentPreset: WeatherPreset;

  constructor(
    private readonly config: WeatherConfig,
    preset: WeatherPreset = 'live',
  ) {
    this.grid = new WeatherGrid(config.climate.n);
    this.viewState = new WeatherView(this.grid);
    this.currentPreset = preset;
  }

  get preset(): WeatherPreset {
    return this.currentPreset;
  }

  /** Changes the preset; the next `view` or `prepare` shows it. */
  set preset(preset: WeatherPreset) {
    if (preset === this.currentPreset) return;
    this.currentPreset = preset;
    this.shown.clear();
    this.viewHour = Number.NaN;
  }

  /** True if the frames around game time t exist, so `view(t)` returns at once. */
  ready(t: GameTime): boolean {
    const h = hourOf(t);
    return this.shown.has(h) && this.shown.has(h + 1);
  }

  /**
   * Works toward the frames around game time t for about `budgetMs` of real
   * time (at least one unit of work per call) and returns whether they exist.
   */
  prepare(t: GameTime, budgetMs = Infinity): boolean {
    const h = hourOf(t);
    const start = performance.now();
    const spent = () => performance.now() - start >= budgetMs;
    if (!this.work(h, spent)) return false;
    // Ahead of the hour change: the next hour's fields, when there is time left.
    if (t / HOUR - h > 0.5 && !this.shown.has(h + 2) && !spent()) {
      if (this.produce(h + 2, spent) && !spent()) {
        this.shown.set(h + 2, presetFrame(this.currentPreset, this.live.get(h + 2)!, this.grid));
      }
    }
    return true;
  }

  /**
   * The weather around game time t: frames for the hours ⌊t / HOUR⌋ and the
   * next, as the preset shows them. Finishes any preparation first, so call
   * `prepare` beforehand where a stall of some tens of milliseconds matters.
   * The view is reused: it changes when `version` does.
   */
  view(t: GameTime): WeatherView {
    const h = hourOf(t);
    this.work(h, () => false);
    if (h !== this.viewHour) {
      this.viewState.clear();
      this.viewState.add(this.shown.get(h)!);
      this.viewState.add(this.shown.get(h + 1)!);
      this.viewHour = h;
      this.version++;
    }
    return this.viewState;
  }

  /**
   * Units of work until the frames of the hours h and h + 1 exist, live and as
   * the preset shows them; false if `spent` cut it short.
   */
  private work(h: number, spent: () => boolean): boolean {
    for (const hour of this.live.keys()) if (hour < h || hour > h + 2) this.live.delete(hour);
    for (const hour of this.shown.keys()) if (hour < h || hour > h + 2) this.shown.delete(hour);
    for (const hour of [h, h + 1]) {
      if (this.shown.has(hour)) continue;
      if (!this.live.has(hour) && (!this.produce(hour, spent) || spent())) return false;
      this.shown.set(hour, presetFrame(this.currentPreset, this.live.get(hour)!, this.grid));
      if (hour === h && spent()) return false;
    }
    return true;
  }

  /** Brings the model to an hour and computes its fields; false if `spent` cut it short. */
  private produce(hour: number, spent: () => boolean): boolean {
    if (this.live.has(hour)) return true;
    // The model knows the fields of its latest hour only: one that is past it starts over.
    if (!this.model || this.model.hour > hour) {
      this.model = new WeatherModel(this.config);
      if (spent()) return false;
    }
    const model = this.model;
    while (model.hour < hour) {
      const until = Math.min(hour, model.hour + TICK_BATCH);
      while (model.hour < until) model.advance();
      if (spent()) return false;
    }
    const data = model.frameDataWithin(hour, spent);
    if (!data) return false;
    this.live.set(hour, { hour, data });
    return true;
  }
}

/** The earlier of the two hours around a game time (the campaign's first hour before it starts). */
function hourOf(t: GameTime): number {
  return Math.max(0, Math.floor(t / HOUR));
}
