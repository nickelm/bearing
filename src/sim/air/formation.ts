/**
 * Formations (owner feedback on R2.4, decision 253): where a flight's wingmen fly
 * relative to the lead, by formation, and how a flight changes formation as its
 * mission moves from phase to phase. Each mission plug-in names its formation per
 * phase (`MissionPlugin.formations`, rule 16); R2.5's formation keeping flies the
 * same slots on the flight director.
 *
 * Slots are offsets in the lead's level frame (behind, to the right, above), in
 * wingspans, so a flight of transports spreads in proportion to a flight of
 * fighters. A four-ship's slots are: 1, the lead's wingman (#2); 2, the second
 * element's lead (#3); 3, its wingman (#4). Larger flights repeat the pattern
 * further back.
 *
 * - **close**: fingertip, about a span apart (departure, climb-out, approach).
 * - **route**: the loose cruise formation, 5 spans back and 8 aside.
 * - **spread**: combat spread, line abreast a nautical mile apart (SPREAD_ABEAM; owner,
 *   decision 258): mutual support by eye and radar sets it, not the wingspan, so its
 *   slots are in meters; the second element's wingman flies two miles out.
 * - **trail**: in trail 80 spans apart, offset aside out of the wake (attack runs).
 * - **stream**: transports and bombers in trail 30 spans apart.
 *
 * A change of formation takes FORMATION_CHANGE seconds from the phase's start, eased.
 * Pure and deterministic, like the analytic pose.
 */
import type { Dir } from '../../core/greatCircle';
import type { GameTime, Meters } from '../../core/units';
import { GRAVITY } from './analyticPose';
import type { AnalyticPose } from './analyticPose';
import type { MissionPhase } from './mission';

export type Formation = 'close' | 'route' | 'spread' | 'trail' | 'stream';

/** A slot: behind, right and above the lead (spans, or meters in METER_SLOTS' formations). */
type Slot = readonly [back: number, right: number, up: number];

/** Combat spread's distance abeam (m): a nautical mile. */
export const SPREAD_ABEAM = 1852;

/** Formations whose slots are in meters rather than wingspans. */
const METER_SLOTS: ReadonlySet<Formation> = new Set(['spread']);

const SLOTS: Record<Formation, readonly Slot[]> = {
  close: [
    [1.2, -1.5, 0],
    [1.2, 1.5, 0],
    [2.4, 3.0, 0],
  ],
  route: [
    [5, -8, 0],
    [5, 8, 0],
    [10, 16, 0],
  ],
  spread: [
    [30, SPREAD_ABEAM, 0],
    [30, -SPREAD_ABEAM, 0],
    [60, 2 * SPREAD_ABEAM, 0],
  ],
  trail: [
    [80, 6, 2],
    [160, 0, 4],
    [240, 6, 6],
  ],
  stream: [
    [30, 3, 1],
    [60, 0, 2],
    [90, 3, 3],
  ],
};

/** Seconds a flight takes to move from one formation to the next. */
export const FORMATION_CHANGE = 45;

/**
 * A slot's offset in formation `f` (spans, or meters where the formation's slots are in
 * meters: `slotMeters` gives meters for either); slots past the first three repeat further back.
 */
export function slotOffset(f: Formation, k: number): [number, number, number] {
  if (k <= 0) return [0, 0, 0];
  const s = SLOTS[f];
  const i = (k - 1) % s.length;
  const repeat = Math.floor((k - 1) / s.length);
  const base = s[i]!;
  // A repeated group of three flies behind the first, by the formation's own depth.
  const depth = Math.max(4, s[s.length - 1]![0] + s[0]![0]);
  return [base[0] + repeat * depth, base[1], base[2]];
}

/** A slot's offset (m) in formation `f` for aircraft of wingspan `span` (m). */
export function slotMeters(f: Formation, k: number, span: Meters): [number, number, number] {
  const o = slotOffset(f, k);
  const scale = METER_SLOTS.has(f) ? 1 : span;
  return [o[0] * scale, o[1] * scale, o[2] * scale];
}

/** What a flight flies in at game time t: the formation it leaves, the one it takes up, and how far it is (0..1). */
export interface FormationState {
  from: Formation;
  to: Formation;
  blend: number;
}

/**
 * The formation at t from the mission's phase timeline and its plug-in's formations
 * per phase (`fallback` where a phase names none).
 */
export function formationAt(
  timeline: readonly { phase: MissionPhase; time: GameTime }[],
  formations: Partial<Record<MissionPhase, Formation>>,
  t: GameTime,
  fallback: Formation = 'route',
): FormationState {
  let i = -1;
  for (let k = 0; k < timeline.length; k++) {
    if (timeline[k]!.time <= t) i = k;
    else break;
  }
  const of = (k: number) =>
    k < 0 ? (formations.departure ?? fallback) : (formations[timeline[k]!.phase] ?? fallback);
  const to = of(i);
  if (i < 0) return { from: to, to, blend: 1 };
  const from = of(i - 1);
  const x = Math.max(0, Math.min(1, (t - timeline[i]!.time) / FORMATION_CHANGE));
  return { from, to, blend: x * x * (3 - 2 * x) };
}

/**
 * Formation slot k of a flight (0: the lead) in formation state `f`, for aircraft of
 * wingspan `span` (m): behind, beside and above the lead in its level frame (the
 * heading and the local vertical, so a banked lead does not tip its wingmen up or
 * down); the wingmen keep the lead's attitude.
 */
export function slotPose(
  lead: AnalyticPose,
  k: number,
  f: FormationState = { from: 'route', to: 'route', blend: 1 },
  span: Meters = 10,
): AnalyticPose {
  if (k === 0) return lead;
  const a = slotMeters(f.from, k, span);
  const b = slotMeters(f.to, k, span);
  const w = f.blend;
  const back = a[0] + (b[0] - a[0]) * w;
  const side = a[1] + (b[1] - a[1]) * w;
  const above = a[2] + (b[2] - a[2]) * w;
  const r = Math.hypot(...lead.pos);
  const up: Dir = [lead.pos[0] / r, lead.pos[1] / r, lead.pos[2] / r];
  const fw = lead.forward;
  // Level forward: the nose with its climb taken out.
  const d = fw[0] * up[0] + fw[1] * up[1] + fw[2] * up[2];
  let lf: Dir = [fw[0] - d * up[0], fw[1] - d * up[1], fw[2] - d * up[2]];
  const n = Math.hypot(...lf) || 1;
  lf = [lf[0] / n, lf[1] / n, lf[2] / n];
  const right: Dir = [
    lf[1] * up[2] - lf[2] * up[1],
    lf[2] * up[0] - lf[0] * up[2],
    lf[0] * up[1] - lf[1] * up[0],
  ];
  // In a turn the formation turns about the vertical at the lead's turn rate, g·tan(bank)/v
  // (a right bank turns clockwise seen from above): a wingman outside the turn flies faster
  // than the lead, one inside slower (owner, decision 255).
  const off: Dir = [
    -lf[0] * back + right[0] * side,
    -lf[1] * back + right[1] * side,
    -lf[2] * back + right[2] * side,
  ];
  const rate = lead.speed > 1 ? (GRAVITY * Math.tan(lead.bank)) / lead.speed : 0;
  // ω = −rate · up; ω × off.
  const om: Dir = [-rate * up[0], -rate * up[1], -rate * up[2]];
  const velocity: [number, number, number] = [
    lead.velocity[0] + (om[1] * off[2] - om[2] * off[1]),
    lead.velocity[1] + (om[2] * off[0] - om[0] * off[2]),
    lead.velocity[2] + (om[0] * off[1] - om[1] * off[0]),
  ];
  const vh = Math.hypot(...velocity);
  const vertical = velocity[0] * up[0] + velocity[1] * up[1] + velocity[2] * up[2];
  return {
    ...lead,
    pos: [
      lead.pos[0] + off[0] + up[0] * above,
      lead.pos[1] + off[1] + up[1] * above,
      lead.pos[2] + off[2] + up[2] * above,
    ],
    altitude: lead.altitude + above,
    velocity,
    speed: lead.airborne ? Math.sqrt(Math.max(0, vh * vh - vertical * vertical)) : lead.speed,
  };
}
