/**
 * Avionics state (Proposal 0006, decisions 189 and 199): what changes what the
 * aircraft does, senses, emits or releases, changed only by avionics commands,
 * which the player's displays and keys, the AI crew and AI pilots all issue.
 * Headless and pure: `applyCommand` and `autoMode` return new states.
 *
 * Master modes follow the proposal's triggers unless the player chose one: on
 * the ground, approach with the gear down below 3,000 ft, hover below about
 * 20 kt in a helicopter, navigation otherwise. Air-to-air and air-to-ground
 * follow a selected weapon (P4); until then they come by command only. Leaving
 * dogfight returns to the mode before it. Thresholds have hysteresis, so a
 * touch-and-go or a hover at 20 kt does not flicker between modes.
 */
import { FOOT, KNOT } from '../../core/units';

export type MasterMode =
  'ground' | 'navigation' | 'air-to-air' | 'dogfight' | 'air-to-ground' | 'approach' | 'hover';

export const MASTER_MODES: readonly MasterMode[] = [
  'ground',
  'navigation',
  'air-to-air',
  'dogfight',
  'air-to-ground',
  'approach',
  'hover',
];

export interface AvionicsState {
  masterMode: MasterMode;
  /** The player chose the mode (automatic triggers do not change it until `auto`). */
  manual: boolean;
  /** The mode dogfight returns to. */
  beforeDogfight: MasterMode;
  masterArm: boolean;
  /** Cautions the pilot has acknowledged with the master caution (strip item ids). */
  acknowledged: readonly string[];
}

export type AvionicsCommand =
  | { type: 'master-mode'; mode: MasterMode }
  | { type: 'dogfight' }
  | { type: 'auto-mode' }
  | { type: 'master-arm'; on: boolean }
  | { type: 'acknowledge'; ids: readonly string[] };

export function initialAvionics(onGround: boolean): AvionicsState {
  return {
    masterMode: onGround ? 'ground' : 'navigation',
    manual: false,
    beforeDogfight: 'navigation',
    masterArm: false,
    acknowledged: [],
  };
}

export function applyCommand(s: AvionicsState, c: AvionicsCommand): AvionicsState {
  switch (c.type) {
    case 'master-mode':
      if (c.mode === 'dogfight') return applyCommand(s, { type: 'dogfight' });
      return { ...s, masterMode: c.mode, manual: true };
    case 'dogfight':
      // The override key: in, and out again to the mode before it.
      return s.masterMode === 'dogfight'
        ? { ...s, masterMode: s.beforeDogfight, manual: s.beforeDogfight !== 'navigation' }
        : { ...s, masterMode: 'dogfight', manual: true, beforeDogfight: s.masterMode };
    case 'auto-mode':
      return { ...s, manual: false };
    case 'master-arm':
      return { ...s, masterArm: c.on };
    case 'acknowledge':
      return { ...s, acknowledged: [...new Set([...s.acknowledged, ...c.ids])] };
  }
}

/** What the automatic triggers read. */
export interface ModeInputs {
  onGround: boolean;
  gearDown: boolean;
  /** Height above the ground (m). */
  radarAltitude: number;
  groundSpeed: number;
  helicopter: boolean;
}

/** The approach trigger's height, and the margin before it lets go. */
export const APPROACH_HEIGHT = 3000 * FOOT;
const APPROACH_EXIT = 3300 * FOOT;
/** The hover trigger's ground speed, and the speed at which it lets go. */
export const HOVER_SPEED = 20 * KNOT;
const HOVER_EXIT = 25 * KNOT;

/** The mode the triggers select, from the current one (for hysteresis). */
export function triggeredMode(current: MasterMode, i: ModeInputs): MasterMode {
  if (i.onGround) return 'ground';
  if (i.helicopter) {
    const limit = current === 'hover' ? HOVER_EXIT : HOVER_SPEED;
    if (i.groundSpeed < limit) return 'hover';
  }
  if (i.gearDown) {
    const limit = current === 'approach' ? APPROACH_EXIT : APPROACH_HEIGHT;
    if (i.radarAltitude < limit) return 'approach';
  }
  return 'navigation';
}

/** Applies the triggers unless the player chose a mode; ground always wins. */
export function autoMode(s: AvionicsState, i: ModeInputs): AvionicsState {
  if (s.manual && !i.onGround) return s;
  const mode = triggeredMode(s.masterMode, i);
  if (mode === s.masterMode && !(s.manual && i.onGround)) return s;
  return { ...s, masterMode: mode, manual: false };
}
