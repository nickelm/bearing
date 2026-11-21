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
import { weaponMode } from '../air/stores';
import { FOOT, KNOT } from '../../core/units';
import type { RadarMode } from '../sensors/sensors';

/** The air-to-air radar's display ranges, nose to the scope's top (nautical miles; decision 218). */
export const RADAR_RANGES_NM = [10, 20, 40, 80] as const;
/** The same steps in round kilometers for Pact skins (decision 223). */
export const RADAR_RANGES_KM = [20, 40, 80, 150] as const;

/** The ground map's range steps (decision 226): nautical miles, and kilometers for the Pact. */
export const GROUND_RANGES_NM = [5, 10, 20, 40] as const;
export const GROUND_RANGES_KM = [10, 20, 40, 80] as const;

/** The ground map's range (m) at step `i` in a skin. */
export function groundRadarRange(skin: 'alliance' | 'pact', i: number): number {
  return skin === 'pact' ? (GROUND_RANGES_KM[i] ?? 40) * 1000 : (GROUND_RANGES_NM[i] ?? 20) * 1852;
}

/** The radar's display range (m) at step `i` in a skin; air combat mode shows its 10 nm. */
export function radarDisplayRange(skin: 'alliance' | 'pact', i: number, mode?: RadarMode): number {
  if (mode === 'acm') return skin === 'pact' ? 20_000 : 10 * 1852;
  return skin === 'pact' ? (RADAR_RANGES_KM[i] ?? 80) * 1000 : (RADAR_RANGES_NM[i] ?? 40) * 1852;
}

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
  /** The air-to-air radar (decision 218): on, its mode, its range (an index), the contact locked. */
  radar: { on: boolean; mode: RadarMode; range: number; lock: string | null };
  /** The air-to-ground radar's ground map (decision 226): its range step. */
  groundRadar: { range: number };
  /** The weapon selected (a store id; decision 289), or null. */
  weapon: string | null;
}

export type AvionicsCommand =
  | { type: 'master-mode'; mode: MasterMode }
  | { type: 'dogfight' }
  | { type: 'auto-mode' }
  | { type: 'master-arm'; on: boolean }
  | { type: 'acknowledge'; ids: readonly string[] }
  | { type: 'radar-power'; on: boolean }
  | { type: 'radar-mode'; mode: 'rws' | 'tws' }
  | { type: 'radar-range'; delta: 1 | -1 }
  /** Locks a contact (single-target track), or breaks the lock with null. */
  | { type: 'radar-lock'; id: string | null }
  | { type: 'ground-radar-range'; delta: 1 | -1 }
  /** Selects a weapon (a store id, null for none); a weapon brings its master mode (decision 289). */
  | { type: 'select-weapon'; weapon: string | null };

export function initialAvionics(onGround: boolean): AvionicsState {
  return {
    masterMode: onGround ? 'ground' : 'navigation',
    manual: false,
    beforeDogfight: 'navigation',
    masterArm: false,
    acknowledged: [],
    radar: { on: true, mode: 'rws', range: 2, lock: null },
    groundRadar: { range: 2 },
    weapon: null,
  };
}

/** Air combat mode belongs to dogfight: any other master mode searches again. */
function leaveAcm(r: AvionicsState['radar']): AvionicsState['radar'] {
  return r.mode === 'acm' ? { ...r, mode: 'rws' } : r;
}

export function applyCommand(s: AvionicsState, c: AvionicsCommand): AvionicsState {
  switch (c.type) {
    case 'master-mode': {
      if (c.mode === 'dogfight') return applyCommand(s, { type: 'dogfight' });
      // A weapon of the other mode is deselected (decision 289).
      const w = s.weapon ? weaponMode(s.weapon) : null;
      const weapon =
        w && (c.mode === 'air-to-air' || c.mode === 'air-to-ground') && w !== c.mode
          ? null
          : s.weapon;
      return { ...s, masterMode: c.mode, manual: true, radar: leaveAcm(s.radar), weapon };
    }
    case 'select-weapon': {
      const mode = c.weapon ? weaponMode(c.weapon) : null;
      if (!mode) return { ...s, weapon: c.weapon };
      // An air-to-air weapon keeps a dogfight; otherwise the weapon's mode comes up.
      if (mode === 'air-to-air' && s.masterMode === 'dogfight') return { ...s, weapon: c.weapon };
      return {
        ...s,
        weapon: c.weapon,
        masterMode: mode,
        manual: true,
        radar: leaveAcm(s.radar),
      };
    }
    case 'dogfight':
      // The override key: in, and out again to the mode before it. The radar goes to air
      // combat mode and back to range-while-search, keeping a lock it holds (decision 223).
      return s.masterMode === 'dogfight'
        ? {
            ...s,
            masterMode: s.beforeDogfight,
            manual: s.beforeDogfight !== 'navigation',
            radar: { ...s.radar, mode: s.radar.lock ? 'stt' : 'rws' },
          }
        : {
            ...s,
            masterMode: 'dogfight',
            manual: true,
            beforeDogfight: s.masterMode,
            radar: { ...s.radar, mode: s.radar.lock ? 'stt' : 'acm' },
          };
    case 'auto-mode':
      return { ...s, manual: false };
    case 'master-arm':
      return { ...s, masterArm: c.on };
    case 'acknowledge':
      return { ...s, acknowledged: [...new Set([...s.acknowledged, ...c.ids])] };
    case 'radar-power':
      return { ...s, radar: { ...s.radar, on: c.on, lock: c.on ? s.radar.lock : null } };
    case 'radar-mode':
      return { ...s, radar: { ...s.radar, mode: c.mode, lock: null } };
    case 'radar-range': {
      const range = Math.max(0, Math.min(RADAR_RANGES_NM.length - 1, s.radar.range + c.delta));
      return { ...s, radar: { ...s.radar, range } };
    }
    case 'ground-radar-range': {
      const range = Math.max(
        0,
        Math.min(GROUND_RANGES_NM.length - 1, s.groundRadar.range + c.delta),
      );
      return { ...s, groundRadar: { range } };
    }
    case 'radar-lock':
      if (!s.radar.on) return s;
      return {
        ...s,
        radar: {
          ...s.radar,
          lock: c.id,
          // A lock is single-target track; breaking it returns to the search it came from,
          // air combat mode in a dogfight (decision 223).
          mode: c.id
            ? 'stt'
            : s.masterMode === 'dogfight'
              ? 'acm'
              : s.radar.mode === 'stt'
                ? 'tws'
                : s.radar.mode,
        },
      };
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
  return { ...s, masterMode: mode, manual: false, radar: leaveAcm(s.radar) };
}
