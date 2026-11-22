/**
 * The status strip's rules (Proposal 0006, decision 199): the dark cockpit.
 * Items appear only when relevant and warn when a state conflicts with the
 * situation; green for normal states that matter now, amber for cautions, red
 * for warnings, each with a label and a shape. The master caution is lit while
 * any caution or warning is unacknowledged; acknowledging it stops the glow
 * and the flashing, not the items.
 */
import { DEG, KNOT } from '../../core/units';
import type { DisplayCommand, StripGauge, StripItem, StripLevel, StripModel } from './model';
import type { AircraftSnapshot } from './snapshot';

/** Slow and low with the gear up: below this speed and height (Free Flight's figures). */
const SLOW = 160 * KNOT;
const LOW = 300;

const MODE_NAMES: Record<string, string> = {
  ground: 'GND',
  navigation: 'NAV',
  'air-to-air': 'A-A',
  dogfight: 'DGFT',
  'air-to-ground': 'A-G',
  approach: 'APPR',
  hover: 'HOVER',
};

export function stripModel(s: AircraftSnapshot): StripModel {
  const items: StripItem[] = [];
  const acked = new Set(s.avionics.acknowledged);
  const add = (
    id: string,
    label: string,
    level: StripLevel,
    command: DisplayCommand | null = null,
  ) => items.push({ id, label, level, fresh: level !== 'normal' && !acked.has(id), command });
  const gearCmd: DisplayCommand = { to: 'controls', action: 'gear' };
  const g = s.gear;
  const airborne = !s.onGround;
  const mode = s.avionics.masterMode;

  // Warnings and cautions first.
  if (
    !g.fixed &&
    g.position <= 0.001 &&
    airborne &&
    s.cas < SLOW &&
    s.radarAltitude < LOW &&
    s.kind === 'jet'
  )
    add('gear-up-low', 'GEAR UP', 'warning', gearCmd);
  if (g.overspeed) add('gear-speed', 'GEAR SPEED', 'warning', gearCmd);
  // Doors failed in an overspeed: the gear stays down whatever the handle (decision 207).
  if (g.damaged) add('gear-doors', 'GEAR DOORS', 'caution');
  if (!s.fuel.unlimited) {
    // All the fuel aboard against the three (decision 307): below the reserve LOW FUEL.
    const fuel = s.fuel.total ?? s.fuel.mass;
    if (fuel < s.fuel.low) add('low-fuel', 'LOW FUEL', 'warning');
    else if (fuel < s.fuel.bingo) add('bingo', 'BINGO', 'warning');
    else if (fuel < s.fuel.joker) add('joker', 'JOKER', 'caution');
  }
  if (s.parkingBrake && s.onGround && s.kind === 'jet' && s.engine.lever > 0.5)
    add('park-thr', 'PARK BRK', 'caution', { to: 'controls', action: 'parkingBrake' });
  if (s.speedbrake > 0.02 && s.engine.afterburner > 0)
    add('sb-ab', 'SPD BRK + AB', 'caution', { to: 'controls', action: 'speedbrake' });

  // States that matter now, in green.
  if (!g.fixed) {
    if (g.position > 0.001 && g.position < 0.999) add('gear', 'GEAR TRANSIT', 'caution', gearCmd);
    else if (g.position >= 0.999 && (airborne || mode === 'ground'))
      add('gear', 'GEAR DN', 'normal', gearCmd);
  }
  if (s.parkingBrake && !items.some((i) => i.id === 'park-thr'))
    add('park', 'PARK BRK', 'normal', { to: 'controls', action: 'parkingBrake' });
  else if (s.brakes) add('brakes', 'BRAKES', 'normal');
  // The speedbrake with its position: 60° out, 43° with the gear down (decision 207).
  if (s.speedbrake > 0.02 && !items.some((i) => i.id === 'sb-ab'))
    add(
      'sb',
      s.speedbrakeAngle === undefined
        ? 'SPD BRK'
        : `SPD BRK ${Math.round(s.speedbrakeAngle / DEG)}°`,
      'normal',
      { to: 'controls', action: 'speedbrake' },
    );
  if (s.engine.afterburner > 0) add('ab', `AB ${s.engine.afterburner}`, 'normal');
  for (const h of s.holds)
    add(
      h,
      h.toUpperCase(),
      'normal',
      h === 'hover hold' ? { to: 'controls', action: 'hoverHold' } : null,
    );
  if (s.avionics.masterArm) add('arm', 'MASTER ARM', 'normal');
  // A free mouse is cursor mode: a state the player chose, so green; a click captures it.
  if (s.mouseFree) add('mouse', 'MOUSE FREE', 'normal', { to: 'controls', action: 'mouseCapture' });

  const gauges: StripGauge[] = [];
  if (s.rotor && s.profile.rotorGauges) {
    const r = s.rotor;
    gauges.push(
      {
        id: 'torque',
        label: 'TQ',
        fill: Math.min(1, r.torque / 1.2),
        text: `${Math.round(r.torque * 100)}%`,
        level: r.torque > 1 ? 'warning' : r.torque > 0.95 ? 'caution' : 'normal',
      },
      {
        id: 'rotor',
        label: 'NR',
        fill: Math.max(0, Math.min(1, (r.rpm - 0.85) / 0.3)),
        text: `${Math.round(r.rpm * 100)}%`,
        level: r.rpm < 0.95 || r.rpm > 1.07 ? 'warning' : 'normal',
      },
      {
        id: 'margin',
        label: 'MARGIN',
        fill: Math.max(0, Math.min(1, r.margin)),
        text: `${Math.round(r.margin * 100)}%`,
        level: r.margin < 0.05 ? 'caution' : 'normal',
      },
    );
  }
  return {
    items,
    masterCaution: items.some((i) => i.fresh),
    gauges,
    mode: (MODE_NAMES[mode] ?? mode.toUpperCase()) + (s.avionics.manual ? ' MAN' : ''),
  };
}

/** The ids the master caution acknowledges: every caution and warning showing now. */
export function cautionIds(m: StripModel): string[] {
  return m.items.filter((i) => i.level !== 'normal').map((i) => i.id);
}
