/**
 * The settlement generator's data model (proposal 0009, decision 260). Everything is
 * plain data in a settlement's local frame (meters east and north of its center, the
 * gnomonic frame of `frame.ts`), so a plan crosses a worker boundary as it is.
 *
 * The generator is part of the world, not the game: it knows cultural regions and
 * terrain, never sides, territory or casting (constraint 5; the lint rule in
 * eslint.config.js enforces the imports).
 */
import type { Poly } from './geom';

export const Tier = { City: 0, Town: 1, Village: 2, Farmstead: 3 } as const;
export type Tier = (typeof Tier)[keyof typeof Tier];
export const TIER_NAMES = ['city', 'town', 'village', 'farmstead'] as const;

export const Style = {
  Western: 0,
  Eastern: 1,
  Mediterranean: 2,
  Nordic: 3,
  Arid: 4,
  /** Decision 292. */
  American: 5,
  SoutheastAsian: 6,
} as const;
export type Style = (typeof Style)[keyof typeof Style];
export const STYLE_NAMES = [
  'western',
  'eastern bloc',
  'mediterranean',
  'nordic',
  'arid',
  'american',
  'southeast asian',
] as const;

/** Street classes, widest first. Paths and stairs carry no vehicles. */
export const StreetKind = {
  Arterial: 0,
  Major: 1,
  Minor: 2,
  Lane: 3,
  Path: 4,
  Stairs: 5,
} as const;
export type StreetKind = (typeof StreetKind)[keyof typeof StreetKind];
export const STREET_NAMES = ['arterial', 'major', 'minor', 'lane', 'path', 'stairs'] as const;
/** Paved half-width (m) by street class. */
export const STREET_HALF_WIDTH: readonly number[] = [7, 6, 4, 3, 1.5, 1.5];

export const District = {
  OldCore: 0,
  InnerGrid: 1,
  Detached: 2,
  Terraced: 3,
  Microdistrict: 4,
  Industrial: 5,
  RailYard: 6,
  Port: 7,
  Civic: 8,
  Utilities: 9,
  /** Towers: a downtown at the center or a business district off it (decision 292). */
  Business: 10,
} as const;
export type District = (typeof District)[keyof typeof District];
export const DISTRICT_NAMES = [
  'old core',
  'inner grid',
  'residential, detached',
  'residential, terraced',
  'microdistrict',
  'industrial',
  'rail yard',
  'port',
  'civic and parks',
  'power and utilities',
  'business',
] as const;

/** What covers a block's ground between buildings (the urban ground's classes). */
export const Ground = {
  Courtyard: 0,
  Garden: 1,
  Park: 2,
  Square: 3,
  Parking: 4,
  Concrete: 5,
  Gravel: 6,
  Ballast: 7,
  Sports: 8,
  Cemetery: 9,
} as const;
export type Ground = (typeof Ground)[keyof typeof Ground];

export const Roof = { Gable: 0, Hip: 1, Flat: 2, Shed: 3 } as const;
export type Roof = (typeof Roof)[keyof typeof Roof];

/** Building kinds: what the renderer builds and the damage model counts. */
export const BuildingKind = {
  House: 0,
  Terrace: 1,
  Perimeter: 2,
  Slab: 3,
  Shed: 4,
  Warehouse: 5,
  Civic: 6,
  Landmark: 7,
  Farm: 8,
  Barn: 9,
  /** Office and apartment towers (decision 292). */
  Tower: 10,
} as const;
export type BuildingKind = (typeof BuildingKind)[keyof typeof BuildingKind];

/** Extras, as bits. */
export const Extra = { Chimney: 1, Dormer: 2, Balcony: 4, WaterTank: 8, Courtyard: 16 } as const;

export const LandmarkKind = {
  Church: 0,
  Cathedral: 1,
  TownHall: 2,
  TvTower: 3,
  WaterTower: 4,
  Stadium: 5,
  Monument: 6,
  Smokestack: 7,
  CoolingTower: 8,
  Crane: 9,
  Market: 10,
  Tank: 11,
} as const;
export type LandmarkKind = (typeof LandmarkKind)[keyof typeof LandmarkKind];
export const LANDMARK_NAMES = [
  'church',
  'cathedral',
  'town hall',
  'tv tower',
  'water tower',
  'stadium',
  'monument',
  'smokestack',
  'cooling tower',
  'crane',
  'market',
  'tank',
] as const;

/** Candidate targets a game layer may read (proposal 0009, *Data for a Game Layer*). */
export const TargetKind = {
  RailYard: 0,
  PowerStation: 1,
  Factory: 2,
  Depot: 3,
  Port: 4,
  Bridge: 5,
  Refinery: 6,
  FuelDepot: 7,
} as const;
export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];
export const TARGET_NAMES = [
  'rail yard',
  'power station',
  'factory',
  'depot',
  'port',
  'bridge',
  'refinery',
  'fuel depot',
] as const;

/** A polyline in the local frame. */
export interface Polyline {
  points: number[];
}

/** What the generator needs to know about the ground, in the local frame. */
export interface SettlementGround {
  /** Height (m) at local (x, y). */
  height(x: number, y: number): number;
  /** True on the sea, lakes and rivers' channels at local (x, y). */
  water(x: number, y: number): boolean;
}

/** One settlement's input: everything the generator reads (game-agnostic). */
export interface SettlementInput {
  /** Stable key for its random streams, e.g. "s-123". */
  key: string;
  name: string;
  /** Unit direction of the center. */
  center: [number, number, number];
  population: number;
  tier: Tier;
  style: Style;
  /** Naming flavor of its cultural region (worldgen/names). */
  flavor: number;
  /** Built-up radius (m) at URBAN_VERTICES bearings counterclockwise from east. */
  outline: Float32Array | number[];
  /** Regional roads through it, with their class (0 motorway … 2 secondary). */
  arterials: { points: number[]; roadClass: number }[];
  rails: Polyline[];
  /** Rivers with their half-widths (m), and coasts as polylines. */
  rivers: { points: number[]; halfWidth: number }[];
  coasts: Polyline[];
  port: boolean;
  /** Sites to realize as specific complexes (decision 279); none by default. */
  anchors?: SiteAnchor[];
  ground: SettlementGround;
}

export interface Street {
  kind: StreetKind;
  points: number[];
  /** Grade (rise over run) of its steepest piece. */
  grade: number;
}

export interface Block {
  polygon: Poly;
  district: District;
  ground: Ground;
  area: number;
  /** Mean building height (m) over its buildings, for the far prism. */
  height: number;
  /** Steepest slope under it. */
  slope: number;
}

export interface Parcel {
  polygon: Poly;
  block: number;
  /** The street-facing edge: [ax, ay, bx, by]. */
  frontage: [number, number, number, number];
}

export interface Building {
  kind: BuildingKind;
  /** Center, the angle of its length axis (rad, counterclockwise from east), half sizes. */
  x: number;
  y: number;
  angle: number;
  halfLength: number;
  halfWidth: number;
  /** Wall height (m) above the highest ground under it. */
  height: number;
  floors: number;
  roof: Roof;
  /** Roof rise (m) above the walls. */
  roofHeight: number;
  /** Wall and roof colors (sRGB hex). */
  wall: number;
  roofColor: number;
  extras: number;
  parcel: number;
  block: number;
  /** The landmark it is, or −1. */
  landmark: number;
}

export interface Landmark {
  kind: LandmarkKind;
  x: number;
  y: number;
  /** Footprint radius or half-size (m) and height (m). */
  size: number;
  height: number;
  name: string;
  /** The building that stands for it, or −1 (towers, stacks and cranes stand alone). */
  building: number;
}

export interface CandidateTarget {
  kind: TargetKind;
  x: number;
  y: number;
  /** Footprint polygon in the local frame. */
  footprint: Poly;
  name: string;
  /** The caller's site this target realizes (`SiteAnchor.id`), if any (decision 279). */
  anchor?: number;
  /** The buildings that make it up (damage states apply to these). */
  buildings?: number[];
}

/**
 * A site a caller asks the plan to realize (decision 279): a works, power station,
 * refinery, rail yard, depot or fuel depot that some other layer already knows of (a game's
 * strike target). The generator only places it; the id is the caller's.
 */
export interface SiteAnchor {
  id: number;
  kind: 'works' | 'power' | 'refinery' | 'rail-yard' | 'depot' | 'fuel-depot';
  name: string;
}

/** A level platform under a large structure: an oriented box and its height (m). */
export interface Pad {
  x: number;
  y: number;
  angle: number;
  halfLength: number;
  halfWidth: number;
  height: number;
  building: number;
}

/** Counts and measures the checks read (decision 260). */
export interface PlanMetrics {
  /** Street length by class (m). */
  streetLength: number[];
  /** Minor street length on slopes above 10%, and the part within 30° of the contour. */
  slopedMinor: number;
  slopedMinorAlong: number;
  /** Vehicle street pieces steeper than the grade limit (should be 0). */
  steepVehicle: number;
  /** Buildings with a corner outside their parcel (should be 0). */
  outsideParcel: number;
  /** Parcels without frontage (should be 0). */
  noFrontage: number;
  /** Buildings or streets over water (should be 0). */
  inWater: number;
  /** Blocks dropped as degenerate. */
  droppedBlocks: number;
  ms: number;
}

export interface SettlementPlan {
  key: string;
  name: string;
  tier: Tier;
  style: Style;
  center: [number, number, number];
  /** The core's radius (m), 0 without an old core. */
  coreRadius: number;
  streets: Street[];
  blocks: Block[];
  parcels: Parcel[];
  buildings: Building[];
  landmarks: Landmark[];
  targets: CandidateTarget[];
  /** Industrial stacks and cooling towers that carry plumes: index into `landmarks`. */
  plumes: number[];
  /**
   * Pads for large structures on sloping ground (decision 264): level platforms in the
   * edit framework's terms, not yet applied (they wait for the sim's height service).
   */
  pads: Pad[];
  metrics: PlanMetrics;
}
