/**
 * Landmarks (proposal 0009, decision 264): churches and cathedrals, town halls, TV and
 * water towers, stadiums, monuments, smokestacks, cooling towers and cranes, placed by
 * district and style and named in the settlement's naming flavor (worldgen/names).
 * Draws from rng(seed, "settlements/landmarks").fork(key).
 */
import type { Rng } from '../../core/rng';
import { Toponymy } from '../names/toponymy';
import { LandmarkKind, Style } from './types';

export function landmarkName(
  kind: LandmarkKind,
  settlement: string,
  flavor: number,
  style: Style,
  r: Rng,
): string {
  const t = new Toponymy(r);
  switch (kind) {
    case LandmarkKind.Cathedral:
      return `${t.proper(flavor, 2)} Cathedral`;
    case LandmarkKind.Church:
      return style === Style.Arid ? `${t.proper(flavor)} Hall` : `Church of ${t.proper(flavor, 2)}`;
    case LandmarkKind.TownHall:
      return `${settlement} Town Hall`;
    case LandmarkKind.TvTower:
      return `${settlement} TV Tower`;
    case LandmarkKind.WaterTower:
      return `${settlement} Water Tower`;
    case LandmarkKind.Stadium:
      return `${t.proper(flavor, 2)} Stadium`;
    case LandmarkKind.Monument:
      return `${t.proper(flavor, 2)} Monument`;
    case LandmarkKind.Smokestack:
      return `${t.proper(flavor)} Works`;
    case LandmarkKind.CoolingTower:
      return `${settlement} Power Station`;
    case LandmarkKind.Crane:
      return `${settlement} Docks`;
    case LandmarkKind.Market:
      return `${settlement} Market`;
    case LandmarkKind.Tank:
      return `${settlement} Tank Farm`;
  }
}
