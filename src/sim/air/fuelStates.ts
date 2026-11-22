/**
 * Joker, bingo and low fuel for an aircraft on a mission (roadmap R2.6, decision 307), in
 * the route's kilograms per aircraft. Pure: the route, where the aircraft is and home.
 *
 * - **Low fuel** is the planned reserve (FUEL_RESERVE of the departure load): what the
 *   plan lands with. Below it the aircraft eats into its diversion and holding fuel.
 * - **Bingo** is the fuel to fly home from here and land with the reserve: the distance
 *   over the type's cruise speed at the route's cruise flow. The descent and approach
 *   burn less than the cruise, so the figure errs on the safe side.
 * - **Joker** is bingo plus a fight: JOKER_FIGHT seconds at combat flow, the fuel at which
 *   to leave the target or the station so a last engagement still leaves bingo.
 */
import { arcDistance } from '../../core/greatCircle';
import type { Dir } from '../../core/greatCircle';
import { FLOW } from './aircraft';
import { routeCruiseFlow } from './route';
import type { Route } from './route';

/** Seconds of combat between joker and bingo. */
export const JOKER_FIGHT = 180;

export interface FuelStates {
  joker: number;
  bingo: number;
  low: number;
}

export function fuelStates(
  route: Readonly<Route>,
  pos: Readonly<Dir>,
  home: Readonly<Dir>,
  radius: number,
  cruiseSpeed: number,
): FuelStates {
  const cruise = routeCruiseFlow(route) * FLOW.cruise;
  const low = route.reserve;
  const bingo = low + (cruise * arcDistance(pos, home, radius)) / Math.max(1, cruiseSpeed);
  return { joker: bingo + JOKER_FIGHT * cruise * FLOW.combat, bingo, low };
}
