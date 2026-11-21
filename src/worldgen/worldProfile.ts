/**
 * World profiles (Proposal 0010, owner's addendum; decision 296): the world-side
 * options a game sets, bundled for a genre. The render side has its own settings
 * (TerrainArtSettings: a quality tier and a style); a profile says what the world holds.
 *
 * - `bearing`: the Cold War air war's world (the defaults).
 * - `natural`: the same world without structures, at Earth-like relief, for a game that
 *   wants untouched land (a survival or exploration game).
 * - `heroic`: taller relief, denser rock and only the structures that suit a fantasy or
 *   adventure world (lighthouses, observatories, dams, quarries), for spectacle.
 *
 * Every profile keeps the same faceted, retro, cartoony look; only what is in the world
 * and how tall it stands change. Plain data: a game may also build its own.
 */
import type { PoiKind } from './poi/poi';
import { POI_KINDS } from './poi/poi';

export interface WorldProfile {
  name: string;
  /** PlanetParams.reliefExaggeration (decision 297). */
  reliefExaggeration: number;
  /** Rock dressing's density factor over the art tier's (decision 299). */
  dressingDensity: number;
  /** The points-of-interest kit and its density (decision 302); an empty kit places none. */
  poiKinds: readonly PoiKind[];
  poiDensity: number;
}

export const WORLD_PROFILES: Readonly<Record<string, WorldProfile>> = {
  bearing: {
    name: 'bearing',
    reliefExaggeration: 1.3,
    dressingDensity: 1,
    poiKinds: POI_KINDS,
    poiDensity: 1,
  },
  natural: {
    name: 'natural',
    reliefExaggeration: 1,
    dressingDensity: 1,
    poiKinds: [],
    poiDensity: 0,
  },
  heroic: {
    name: 'heroic',
    reliefExaggeration: 1.5,
    dressingDensity: 1.5,
    poiKinds: ['lighthouse', 'observatory', 'dam', 'quarry'],
    poiDensity: 1.5,
  },
};

/** The profile named `name`, or Bearing's. */
export function worldProfile(name: string | null | undefined): WorldProfile {
  return WORLD_PROFILES[name ?? ''] ?? WORLD_PROFILES.bearing!;
}
