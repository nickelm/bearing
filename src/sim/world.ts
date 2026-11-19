/**
 * The simulated world: the simulation core with every process registered.
 * C1 has the weather and player alarms; C2 adds the air war (the order of
 * battle, carrier groups and missions in air/, planned by the command
 * layer's tasker) when the campaign is given. Ground and naval aggregates
 * (C3) register here too.
 */
import type { GameTime } from '../core/units';
import type { CampaignInputEvent } from './eventLog';
import { AirOps } from './air/airOps';
import { DamageState } from './ground/damage';
import { NetworkGraph } from './ground/network';
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
  /** The road and rail graphs (R1.8); null without a campaign. */
  readonly networks: { road: NetworkGraph; rail: NetworkGraph } | null;
  /** Damage to target sites and bridges (R1.8); null without a campaign. */
  readonly damage: DamageState | null;
}

export function createSimWorld(config: SimConfig): SimWorld {
  const sim = new Simulation(0);
  const weather = new WeatherModel(config);
  sim.addProcess(weather);
  sim.on(ALARM_EVENT, () => {});
  let air: AirOps | null = null;
  let networks: SimWorld['networks'] = null;
  let damage: DamageState | null = null;
  if (config.campaign) {
    air = new AirOps(config.campaign, config.seed);
    air.register(sim);
    sim.addProcess(new InterimTasker(air, config.campaign, config.seed));
    networks = {
      road: new NetworkGraph(config.campaign.roads),
      rail: new NetworkGraph(config.campaign.rail),
    };
    damage = new DamageState(config.campaign.targets);
    sim.addState('damage', damage);
  }
  return { sim, weather, air, networks, damage };
}

/** Schedules a player alarm (flagged, so it triggers auto-slowdown). */
export function scheduleAlarm(world: SimWorld, at: GameTime, label: string): number {
  return world.sim.schedule(Math.max(at, world.sim.time), ALARM_EVENT, null, { flag: label });
}

/** Carries out a player input to the campaign (SimHost's input handler, R1.2). */
export function applyInput(world: SimWorld, input: CampaignInputEvent): void {
  switch (input.kind) {
    case 'alarm':
      scheduleAlarm(world, input.at, input.label);
      break;
  }
}
