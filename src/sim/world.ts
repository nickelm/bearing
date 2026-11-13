/**
 * The simulated world: the simulation core with every process registered.
 * C1 has the weather and player alarms; C2 adds the air war (the order of
 * battle, carrier groups and missions in air/, planned by the command
 * layer's tasker) when the campaign is given. Ground and naval aggregates
 * (C3) register here too.
 */
import type { GameTime } from '../core/units';
import { AirOps } from './air/airOps';
import type { CampaignInput } from './command/campaignInput';
import { InterimTasker } from './command/tasker';
import { Simulation } from './simulation';
import { WeatherModel } from './weather/model';
import type { WeatherConfig } from './weather/model';

/** Event kind of a player alarm: a flagged event with no effect but auto-slowdown. */
export const ALARM_EVENT = 'alarm';

export interface SimConfig extends WeatherConfig {
  /** The campaign's bases, targets, carriers and fronts; without it there is no air war. */
  campaign?: CampaignInput | null;
}

export interface SimWorld {
  readonly sim: Simulation;
  readonly weather: WeatherModel;
  readonly air: AirOps | null;
}

export function createSimWorld(config: SimConfig): SimWorld {
  const sim = new Simulation(0);
  const weather = new WeatherModel(config);
  sim.addProcess(weather);
  sim.on(ALARM_EVENT, () => {});
  let air: AirOps | null = null;
  if (config.campaign) {
    air = new AirOps(config.campaign, config.seed);
    air.register(sim);
    sim.addProcess(new InterimTasker(air, config.campaign, config.seed));
  }
  return { sim, weather, air };
}

/** Schedules a player alarm (flagged, so it triggers auto-slowdown). */
export function scheduleAlarm(world: SimWorld, at: GameTime, label: string): number {
  return world.sim.schedule(Math.max(at, world.sim.time), ALARM_EVENT, null, { flag: label });
}
