/**
 * Mission types as plug-ins (rule 16, decision 230, Proposal 0008; roadmap
 * R2.1). A mission type is complete only when all eight parts exist:
 *
 * | Part | Here |
 * | --- | --- |
 * | Planner rule | `planner`: the needs this type answers, with their scores |
 * | Package template | `package`: the flights a need gets (escort, SEAD) |
 * | Aggregate resolver | `resolver`: outcomes when no one watches (R2.2) |
 * | Full-fidelity behavior | `behavior`: how AI pilots fly it on the director (R2.5) |
 * | Jump-in windows | `jumpIn`: the phases that accept the player |
 * | Success and consequences | `success`: what counts as success, and what changes |
 * | Briefing template | `briefing`: text with named places (src/campaign/missionBriefings.ts) |
 * | Interface defaults | `interface`: master mode, formats and HUD cues per phase |
 *
 * A part that a later milestone builds is a `Pending` marker naming that
 * milestone; the registry's test lists every marker and pins the list, so it
 * only shrinks. The planner and the UI never special-case a type outside its
 * plug-in: the air tasking order asks every plug-in for its needs and builds
 * packages from its template, and minimums are the plug-in's data.
 */
import type { Side } from '../../../campaign/cast';
import type { Dir } from '../../../core/greatCircle';
import type { Rng } from '../../../core/rng';
import type { GameTime } from '../../../core/units';
import type { AircraftRole } from '../../air/aircraft';
import type { AirOps } from '../../air/airOps';
import type {
  BaseRef,
  JumpInWindow,
  Mission,
  MissionPhase,
  MissionTarget,
  MissionType,
  Places,
} from '../../air/mission';
export type { Places } from '../../air/mission';
import type { BaseStocks } from '../../air/orbat';
import type { AggregateResolver, Engagement, MissionOutcome, WorldEffect } from '../../air/outcome';
export type {
  AggregateResolver,
  Engagement,
  MissionOutcome,
  ResolveContext,
  WorldEffect,
} from '../../air/outcome';
import type { MasterMode } from '../../avionics/avionics';
import type { FormatId, SlotId } from '../../avionics/profiles';
import type { CampaignInput } from '../campaignInput';
import type { Category, Timing } from '../doctrine';
import type { Minimums, PlanningEnvironment } from '../environment';
import type { FrontSegment } from '../front';
import type { SupplyLines } from '../supply';

/** A part a later milestone builds. */
export interface Pending {
  pending: string;
}

export type Part<T> = T | Pending;

export function isPending<T>(p: Part<T>): p is Pending {
  return typeof p === 'object' && p !== null && 'pending' in p;
}

/**
 * Something a side wants done (design, "Air Tasking", step 1): either a
 * standing station kept covered to the order's horizon, or one sortie per
 * wanted time on target.
 */
export interface Need {
  /** Stable over a day's revisions: the same need has the same key. */
  key: string;
  type: MissionType;
  /** The need in words, for the mission panel ("CAS at the Kessar Gap"). */
  label: string;
  theater: number;
  /** Priority score (theater weight × value × urgency, design step 2). */
  score: number;
  target: MissionTarget;
  places: Places;
  /** Roles that may fly it, in order of preference (the profile's when absent). */
  roles?: readonly AircraftRole[];
  /** Only this base's squadrons (a carrier's own CAP). */
  base?: BaseRef;
  /** Not from this base (an airlift's destination). */
  notFrom?: BaseRef;
  orbitHeading?: number;
  stationTime?: number;
  /** A standing station, refilled as patrols leave. */
  standing?: boolean;
  /** Otherwise: one sortie per time on target. */
  tots?: GameTime[];
  /** The target area is defended: package templates add escort and SEAD (design, step 3). */
  defended?: boolean;
  /** How much later than wanted a time on target may come (s); waves keep theirs. */
  slip?: number;
}

/** What a planner rule may read (built by the ATO for one side and one revision). */
export interface PlanContext {
  readonly side: Side;
  readonly enemy: Side;
  readonly input: CampaignInput;
  /** Read only: squadrons, bases, carrier groups, stocks. Planner rules never launch. */
  readonly air: AirOps;
  readonly now: GameTime;
  readonly day: number;
  readonly dayStart: GameTime;
  readonly dayLength: number;
  readonly env: PlanningEnvironment;
  /** Every front's segments with their pressure. */
  readonly segments: readonly FrontSegment[];
  /** The enemy's supply lines: what this side interdicts. */
  readonly enemySupply: SupplyLines;
  /**
   * A point on a front's start line at fraction `frac` of its length, `setback`
   * (m) into this side's ground, and the line's heading there; null off fronts.
   */
  frontPoint(
    theater: number,
    frac: number,
    setback: number,
  ): { point: Dir; heading: number } | null;
  /** Damage of a target site, 0..1. */
  damage(target: number): number;
  /** When this side last struck a target (`kind:id`), or −Infinity. */
  lastStruck(key: string): number;
  /** The draw stream of a need: per side, per day and per key. */
  rng(key: string): Rng;
  /** Times on target by the side's doctrine, in `window`. */
  schedule(
    timing: Timing,
    count: number,
    window: readonly [GameTime, GameTime],
    key: string,
  ): GameTime[];
  /** The order's day at `d`: its daylight, its night, or all of it; null if there is none. */
  window(d: Readonly<Dir>, light: 'day' | 'night' | 'any'): [GameTime, GameTime] | null;
  theaterName(theater: number): string;
  theaterWeight(theater: number): number;
  /** The nearest named place within `within` (m), or undefined. */
  town(d: Readonly<Dir>, within?: number): string | undefined;
  /** Whether the side has a squadron of a role. */
  hasRole(role: AircraftRole): boolean;
  /** A base's stocks at the outbreak. */
  initialStocks(ref: BaseRef): BaseStocks;
}

export type PlannerRule = (ctx: PlanContext) => Need[];

/** One flight of a package. */
export interface PackageMember {
  role: 'lead' | 'escort' | 'sead';
  type: MissionType;
  /** Time on target relative to the lead's (s). */
  offset: number;
}

/** A need's flights: the lead first (design, "Air Tasking", step 3). */
export type PackageTemplate = (need: Need, ctx: PlanContext) => PackageMember[];

export interface SuccessCriteria {
  /** What counts as success, in words. */
  text: string;
  success(m: Mission, o: MissionOutcome): boolean;
  consequences(m: Mission, o: MissionOutcome): WorldEffect[];
}

/** R2.5: the AI pilots' behavior on the director, phase by phase. Defined there. */
export interface FullFidelityBehavior {
  phases: Partial<Record<MissionPhase, string>>;
}

/** What a briefing template reads: the mission and its named places. */
export interface BriefingInput {
  type: MissionType;
  callsign: string;
  unit: string;
  aircraftName: string;
  aircraft: number;
  base: string;
  places: Places;
  need: string;
  /** Local time on target or on station ("14:05"), when known. */
  when?: string;
  /** Planned time on station or over the target (s). */
  stationTime?: number;
  stores?: string;
}

export type BriefingTemplate = (b: BriefingInput) => string;

/** HUD cues a phase shows (R2.6 draws them). */
export type HudCue =
  'steering' | 'station' | 'target' | 'ccip' | 'aa-reticle' | 'glidepath' | 'landing-zone';

export interface PhaseInterface {
  masterMode: MasterMode;
  /** Formats per slot, in order of preference (presets.ts's rule). */
  formats: Partial<Record<SlotId, FormatId[]>>;
  hud: HudCue[];
}

/** Interface defaults per phase (R2.6 applies them through presets.ts). */
export type InterfaceDefaults = Partial<Record<MissionPhase, PhaseInterface>>;

export interface MissionPlugin {
  type: MissionType;
  /** One of the tech demo's four types, or a type the interim tasker flew, ported until R4.2. */
  status: 'demo' | 'provisional';
  planner: Part<PlannerRule>;
  package: Part<PackageTemplate>;
  resolver: Part<AggregateResolver>;
  behavior: Part<FullFidelityBehavior>;
  jumpIn: Part<JumpInWindow>;
  success: Part<SuccessCriteria>;
  briefing: Part<BriefingTemplate>;
  interface: Part<InterfaceDefaults>;
  /** Weather and daylight the type needs (design, "Air Tasking"). */
  minimums: Minimums;
  /** The apportionment category its flights count in (doctrine.ts). */
  category: Category;
  /**
   * How its flights take part in air-to-air engagements (R2.2): a target enemy
   * CAP intercepts, an escort that fights for its package, a CAP that
   * intercepts, or none.
   */
  engagement: Engagement;
}

/** The eight parts, in the table's order. */
export const PLUGIN_PARTS = [
  'planner',
  'package',
  'resolver',
  'behavior',
  'jumpIn',
  'success',
  'briefing',
  'interface',
] as const satisfies readonly (keyof MissionPlugin)[];
