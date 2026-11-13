/**
 * The cast (design, "Casting"; decision 47): the campaign a world produces.
 * Plain data, structured-cloneable, stored with the world. Built from the
 * strategic graph alone, before the player picks a side.
 */
import type { Point } from '../worldgen/strategic/graph';
import type { TheaterKind } from './theaters';

export type Side = 'alliance' | 'pact';

export const SIDE_LABELS: Record<Side, string> = { alliance: 'Alliance', pact: 'Pact' };

/** Who holds a land node. A split node is divided by a front's start line. */
export type NodeOwner =
  | { kind: 'neutral' }
  | { kind: 'whole'; side: Side }
  | {
      kind: 'split';
      /** Barrier line that divides it (the front's start line). */
      line: number;
      /** Side of that line the Pact holds (0 or 1). */
      pactSide: 0 | 1;
    };

export interface Theater {
  /** Index in Cast.theaters. */
  id: number;
  kind: TheaterKind;
  /** Detection key, e.g. "front:0". */
  key: string;
  name: string;
  fit: number;
  /** Nodes involved (see TheaterCandidate.nodes). */
  nodes: number[];
  front?: number;
  lane?: number;
  chokepoint?: number;
  /** Who attacks; the other side defends. Strategic: both strike ('mutual'). */
  attacker: Side | 'mutual';
  /** Theater weight for the ATO (decision 50), 0..1. */
  weight: number;
}

export type LogisticsKind = 'supplies' | 'protects' | 'industry';

/** "from" sustains "to": a cut lane starves a front, a lost chokepoint exposes convoys. */
export interface LogisticsLink {
  from: number;
  to: number;
  kind: LogisticsKind;
}

export type RegionKind = 'industry' | 'port' | 'base' | 'ground';

/** A circular area on the surface where milestone 5 places sites of a kind. */
export interface Region {
  kind: RegionKind;
  side: Side;
  point: Point;
  radius: number;
  /** Theater it serves, or −1. */
  theater: number;
}

export interface RangeFactorTarget {
  /** Which target set it, e.g. "front depth" or "sea lane". */
  label: string;
  /** Required radius of action (m). */
  required: number;
  /** Reference aircraft's real combat radius (m). */
  reference: number;
}

/**
 * A carrier group (decision 56): a mobile base for its side's air wing. It
 * patrols `track`, a stretch of sea lane, back and forth (sim/naval/).
 */
export interface CarrierGroupCast {
  id: number;
  side: Side;
  /** Name of the carrier, e.g. "CVN-73 Resolute". */
  name: string;
  /** Theater it serves (index into Cast.theaters). */
  theater: number;
  /** Sea lane it patrols. */
  lane: number;
  /** Patrol track: unit directions, xyz interleaved, along the lane. */
  track: number[];
}

export interface Cast {
  theaters: Theater[];
  /** Owner of each strategic-graph node. */
  owners: NodeOwner[];
  links: LogisticsLink[];
  /** Fuel scale in [RANGE_FACTOR_MIN, 1] (decision 51). */
  rangeFactor: number;
  rangeTargets: RangeFactorTarget[];
  regions: Region[];
  /** Airbase sites in each side's territory. */
  airbases: Record<Side, number>;
  /** Carrier groups of both sides (decision 56). */
  carriers: CarrierGroupCast[];
  /** Generated names: node names by id, plus theater names. */
  nodeNames: string[];
  briefing: string;
}
