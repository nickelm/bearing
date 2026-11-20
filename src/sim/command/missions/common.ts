/**
 * Helpers the mission plug-ins share: station targets, interface defaults for
 * the phases every fixed-wing mission has, front segments' share of a day's
 * sorties, and target eligibility.
 */
import type { Dir } from '../../../core/greatCircle';
import { HOUR } from '../../../core/units';
import type { Formation } from '../../air/formation';
import type { MissionPhase, MissionTarget } from '../../air/mission';
import { BRIDGE_CUT } from '../../ground/damage';
import type { FrontSegment } from '../front';
import type { InterfaceDefaults, PhaseInterface, PlanContext } from './plugin';

/** A station target (no site behind it). */
export function station(name: string, point: Dir): MissionTarget {
  return { kind: 'station', id: -1, name, point };
}

/** A site is out of use from this damage on (a bridge from BRIDGE_CUT). */
export const DESTROYED = 0.8;

/** Whether target site `id` is still worth striking. */
export function standing(ctx: PlanContext, id: number): boolean {
  const x = ctx.input.targets[id]!;
  return ctx.damage(id) < (x.bridge ? BRIDGE_CUT : DESTROYED);
}

/** A site struck within this time scores less (s). */
export const RESTRIKE_TIME = 12 * HOUR;
export const RESTRIKE_FACTOR = 0.3;

export function restrike(ctx: PlanContext, key: string): number {
  return ctx.now - ctx.lastStruck(key) < RESTRIKE_TIME ? RESTRIKE_FACTOR : 1;
}

/** "the Lynvania front" from a theater name ("Lynvania front"). */
export function the(name: string): string {
  return /^the /i.test(name) ? name : `the ${name}`;
}

/** Splits `total` sorties over segments in proportion to pressure (largest remainder, ties by index). */
export function bySegment(segments: readonly FrontSegment[], total: number): number[] {
  const sum = segments.reduce((s, x) => s + x.pressure, 0);
  if (sum <= 0 || total <= 0) return segments.map(() => 0);
  const exact = segments.map((x) => (total * x.pressure) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ r: e - Math.floor(e), i }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    out[i]!++;
  }
  return out;
}

const NAV: PhaseInterface = {
  masterMode: 'navigation',
  formats: { leftMfd: ['moving-map'] },
  hud: ['steering'],
};
const GROUND: PhaseInterface = {
  masterMode: 'ground',
  formats: { leftMfd: ['moving-map'] },
  hud: [],
};
const APPROACH: PhaseInterface = {
  masterMode: 'approach',
  formats: { leftMfd: ['moving-map'] },
  hud: ['glidepath'],
};

/** Interface defaults with navigation everywhere but the ground, the approach and the given phases. */
export function phases(work: Partial<Record<MissionPhase, PhaseInterface>>): InterfaceDefaults {
  return {
    departure: GROUND,
    'climb-out': NAV,
    ingress: NAV,
    'fence-in': NAV,
    'on-target': NAV,
    egress: NAV,
    approach: APPROACH,
    recovery: GROUND,
    ...work,
  };
}

/** Planned time on station or over the target of a mission (s). */
export function plannedStation(m: { timeline: { phase: MissionPhase; time: number }[] }): number {
  const i = m.timeline.findIndex((e) => e.phase === 'on-target');
  if (i < 0 || i + 1 >= m.timeline.length) return 0;
  return m.timeline[i + 1]!.time - m.timeline[i]!.time;
}

/**
 * Formations by phase for fighters and strike aircraft (decision 253): close on the
 * ground and near the field, route in cruise, combat spread from the fence-in.
 */
export const TACTICAL_FORMATIONS: Partial<Record<MissionPhase, Formation>> = {
  departure: 'close',
  'climb-out': 'close',
  ingress: 'route',
  'fence-in': 'spread',
  'on-target': 'spread',
  egress: 'spread',
  approach: 'close',
  recovery: 'close',
};

/** Transports, tankers and bombers: in a stream from the climb to the approach. */
export const STREAM_FORMATIONS: Partial<Record<MissionPhase, Formation>> = {
  departure: 'close',
  'climb-out': 'stream',
  ingress: 'stream',
  'fence-in': 'stream',
  'on-target': 'stream',
  egress: 'stream',
  approach: 'stream',
  recovery: 'close',
};
