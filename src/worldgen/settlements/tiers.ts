/**
 * Settlement tiers (proposal 0009, decision 260) from the existing population model
 * (worldgen/strategic/settlements.ts): cities at 200,000 people and up, as the graph's
 * own `settlementKind` (about two dozen per world), towns from 15,000, villages below.
 * Farmsteads are not settlements of the graph: villages and towns scatter them on the
 * farmland round them (`village.ts`).
 */
import { Tier } from './types';

export const CITY_POPULATION = 200_000;
export const TOWN_POPULATION = 15_000;

export function tierOf(population: number): Tier {
  return population >= CITY_POPULATION
    ? Tier.City
    : population >= TOWN_POPULATION
      ? Tier.Town
      : Tier.Village;
}
