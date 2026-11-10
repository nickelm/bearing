/**
 * The simulated world: the simulation core with every process registered.
 * Milestone 6 has the weather and player alarms; air tasking (milestone 7)
 * and ground and naval aggregates (milestone 8) register here too.
 */
import type { GameTime } from '../core/units';
import { Simulation } from './simulation';
import { WeatherModel } from './weather/model';
import type { WeatherConfig } from './weather/model';

/** Event kind of a player alarm: a flagged event with no effect but auto-slowdown. */
export const ALARM_EVENT = 'alarm';

export type SimConfig = WeatherConfig;

export interface SimWorld {
  readonly sim: Simulation;
  readonly weather: WeatherModel;
}

export function createSimWorld(config: SimConfig): SimWorld {
  const sim = new Simulation(0);
  const weather = new WeatherModel(config);
  sim.addProcess(weather);
  sim.on(ALARM_EVENT, () => {});
  return { sim, weather };
}

/** Schedules a player alarm (flagged, so it triggers auto-slowdown). */
export function scheduleAlarm(world: SimWorld, at: GameTime, label: string): number {
  return world.sim.schedule(Math.max(at, world.sim.time), ALARM_EVENT, null, { flag: label });
}
