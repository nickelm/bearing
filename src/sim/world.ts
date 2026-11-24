/**
 * The simulated world: the simulation core with every process registered.
 * C1 has the weather and player alarms; C2 adds the air war (the order of
 * battle, carrier groups and missions in air/, planned by the command
 * layer's air tasking orders, R2.1) when the campaign is given. Ground and naval aggregates
 * (C3) register here too.
 */
import type { GameTime } from '../core/units';
import type { CampaignInputEvent } from './eventLog';
import { AirOps, SURVIVOR_EVENT } from './air/airOps';
import type { GroundSource } from './air/terrainFloor';
import { Vec3d } from '../core/vec3d';
import { globalMapSampler, globalMaxSampler } from '../worldgen/edits/airfields';
import type { HeightService } from '../worldgen/edits/heightService';
import { DamageState } from './ground/damage';
import { NetworkGraph } from './ground/network';
import type { CampaignInput } from './command/campaignInput';
import { AirTaskingOrders } from './command/ato';
import { isPending } from './command/missions/plugin';
import { missionPlugin } from './command/missions/registry';
import { MissionResolution } from './air/resolution';
import { SurvivorWatch } from './air/survivors';
import type { BattalionSource } from './air/survivors';
import { GroundWar } from './ground/war';
import type { Side } from '../campaign/cast';
import type { Dir } from '../core/greatCircle';
import { Simulation } from './simulation';
import { WeatherModel } from './weather/model';
import type { WeatherConfig } from './weather/model';

/** Event kind of a player alarm: a flagged event with no effect but auto-slowdown. */
export const ALARM_EVENT = 'alarm';

export interface SimConfig extends WeatherConfig {
  /** The campaign's bases, targets, carriers and fronts; without it there is no air war. */
  campaign?: CampaignInput | null;
  /**
   * The coarse world's height map (physical m above the sea, n × n per face),
   * the ground under analytic routes (R1.6). Execution data: the command layer
   * never reads it (rule 9).
   */
  ground?: { height: Float32Array; n: number } | null;
  /**
   * A side that flies no strikes and no ground support (R2.3's comparison of a
   * war with and without one side's air support). Tools only; the app never sets it.
   */
  suppressAirSupport?: Side | null;
}

export interface SimWorld {
  readonly sim: Simulation;
  readonly weather: WeatherModel;
  readonly air: AirOps | null;
  /** Each side's air tasking order (R2.1); null without a campaign. */
  readonly ato: AirTaskingOrders | null;
  /** Engagements and mission outcomes (R2.2); null without a campaign. */
  readonly resolution: MissionResolution | null;
  /** The ground war in aggregate (R2.3); null without a campaign. */
  readonly ground: GroundWar | null;
  /** Survivors' capture and death (R2.9); null without a campaign. */
  readonly survivors: SurvivorWatch | null;
  /** The road and rail graphs (R1.8); null without a campaign. */
  readonly networks: { road: NetworkGraph; rail: NetworkGraph } | null;
  /** Damage to target sites and bridges (R1.8); null without a campaign. */
  readonly damage: DamageState | null;
  /**
   * The ground from the global grid plus edits, with the sited airfields (R1.6):
   * set when the main thread sends the global world, null before.
   */
  terrain: HeightService | null;
}

export function createSimWorld(config: SimConfig): SimWorld {
  const sim = new Simulation(0);
  const weather = new WeatherModel(config);
  sim.addProcess(weather);
  sim.on(ALARM_EVENT, () => {});
  let air: AirOps | null = null;
  let networks: SimWorld['networks'] = null;
  let damage: DamageState | null = null;
  let ato: AirTaskingOrders | null = null;
  let resolution: MissionResolution | null = null;
  let ground: GroundWar | null = null;
  let survivors: SurvivorWatch | null = null;
  if (config.campaign) {
    air = new AirOps(
      config.campaign,
      config.seed,
      config.ground ? groundSource(config.ground) : null,
      config.ground ? waterSource(config.ground) : null,
    );
    air.register(sim);
    networks = {
      road: new NetworkGraph(config.campaign.roads),
      rail: new NetworkGraph(config.campaign.rail),
    };
    damage = new DamageState(config.campaign.targets);
    sim.addState('damage', damage);
    ground = new GroundWar(config.campaign, config.seed, networks, damage);
    sim.addProcess(ground);
    // Survivors (R2.9): checked against the battalions' anchors, computed once per game time.
    survivors = new SurvivorWatch(air, config.campaign, config.seed, battalionSource(ground, sim));
    sim.addProcess(survivors);
    const watch = survivors;
    air.survivorThreat = (side, p) => watch.hazardAt(side, p);
    ato = new AirTaskingOrders({
      ground,
      suppressAirSupport: config.suppressAirSupport ?? null,
      air,
      input: config.campaign,
      seed: config.seed,
      weather,
      orbit: config.orbit,
      calendar: config.calendar,
      networks,
      damage,
    });
    sim.addProcess(ato);
    const order = ato;
    sim.on(SURVIVOR_EVENT, (e, s) => order.survivorDown((e.data as { side: Side }).side, s));
    // Engagements and outcomes at phase events (R2.2), from each type's plug-in.
    resolution = new MissionResolution(air, damage, config.campaign, config.seed, (type) => {
      const p = missionPlugin(type);
      const success = p.success;
      return {
        engagement: p.engagement,
        resolver: isPending(p.resolver) ? null : p.resolver,
        judge: isPending(success)
          ? null
          : (m, o) => ({ success: success.success(m, o), effects: success.consequences(m, o) }),
      };
    });
    air.resolution = resolution;
    sim.addState('resolution', resolution);
  }
  return {
    sim,
    weather,
    air,
    ato,
    resolution,
    ground,
    survivors,
    networks,
    damage,
    terrain: null,
  };
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
    case 'side':
      // The choice is the log entry itself; the sim's state does not depend on it.
      break;
    case 'subscribe':
      world.air?.subscriptions.add(input.subscription);
      break;
    case 'unsubscribe':
      world.air?.subscriptions.remove(input.id);
      break;
    case 'take-over': {
      const m = world.air?.missions.get(input.mission);
      if (m) world.air!.hold(m, input.slot, world.sim);
      break;
    }
    case 'shot-down': {
      const m = world.air?.missions.get(input.mission);
      if (m) world.resolution?.fullFidelityLoss(m, input.point, input.cause, input.by, world.sim);
      break;
    }
    case 'target-hit':
      world.resolution?.fullFidelityHit(input.target, input.id, input.amount, input.by);
      break;
    case 'vehicle-destroyed':
      world.ground?.destroyVehicle(
        input.battalion,
        input.vehicle,
        input.point,
        input.heading,
        world.sim.time,
      );
      break;
    case 'hand-back': {
      const m = world.air?.missions.get(input.mission);
      if (m) world.air!.release(m, input.fix, input.lost, world.sim, input.stores);
      break;
    }
  }
}

/** Water from a coarse height map: below the sea (R2.9: a survivor in a dinghy). */
export function waterSource(g: { height: Float32Array; n: number }): (d: Readonly<Dir>) => boolean {
  const sample = globalMapSampler(g.height, g.n);
  const v = new Vec3d();
  return (d) => sample(v.set(d[0], d[1], d[2])) < 0;
}

/** The battalions with strength left and their anchors, for the survivors; cached per game time. */
function battalionSource(ground: GroundWar, sim: Simulation): BattalionSource {
  let at = NaN;
  let rev = -1;
  let list: { side: Side; point: Dir }[] = [];
  return {
    battalions() {
      if (at !== sim.time || rev !== ground.revision) {
        at = sim.time;
        rev = ground.revision;
        list = [];
        for (const b of ground.orbat.battalions) {
          if (!(b.strength > 0)) continue;
          const a = ground.battalionAnchor(b.id);
          if (a) list.push({ side: b.side, point: a.point });
        }
      }
      return list;
    },
  };
}

/** A route ground from a coarse height map: the highest cell around each point, never below the sea. */
export function groundSource(g: { height: Float32Array; n: number }): GroundSource {
  const sample = globalMaxSampler(g.height, g.n);
  const v = new Vec3d();
  return (d) => Math.max(0, sample(v.set(d[0], d[1], d[2])));
}
