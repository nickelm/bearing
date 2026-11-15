/**
 * The helicopter's assists (Proposal 0004, Assists): independent toggles and
 * the three presets that set them together. The control layer (heloLaws.ts)
 * reads them; the flight model never does, so switching an assist off removes
 * protection and never a capability.
 */
import { DEG } from '../../../core/units';

export type AssistPreset = 'assisted' | 'standard' | 'expert';

export interface Assists {
  /** Collective: climb-rate command that holds altitude when released, or a lever position. */
  collective: 'climb-rate' | 'position';
  /** Attitude held when the cyclic is released (auto-trim). */
  autoTrim: boolean;
  /** Pedal trim: the torque's yaw is countered without pedal. */
  pedalTrim: boolean;
  /** Turn coordination at speed. */
  turnCoordination: boolean;
  /** Hover hold engages by itself when slow with the cyclic centered. */
  autoHoverHold: boolean;
  /** Bank and pitch limits (rad), or null for none. */
  maxBank: number | null;
  maxPitch: number | null;
  /** The collective stops short of the transmission's torque limit. */
  torqueLimiter: boolean;
  /** Envelope protection: 'on' limits inputs near the hazards, 'warn' only warns. */
  protection: 'on' | 'warn' | 'off';
  /** A soft touchdown: the descent rate eases near the ground (Assisted). */
  landingAid: boolean;
}

export const PRESETS: Record<AssistPreset, Assists> = {
  assisted: {
    collective: 'climb-rate',
    autoTrim: true,
    pedalTrim: true,
    turnCoordination: true,
    autoHoverHold: true,
    maxBank: 45 * DEG,
    maxPitch: 30 * DEG,
    torqueLimiter: true,
    protection: 'on',
    landingAid: true,
  },
  standard: {
    collective: 'position',
    autoTrim: true,
    pedalTrim: true,
    turnCoordination: true,
    autoHoverHold: false,
    maxBank: 75 * DEG,
    maxPitch: 60 * DEG,
    torqueLimiter: true,
    protection: 'warn',
    landingAid: false,
  },
  expert: {
    collective: 'position',
    autoTrim: false,
    pedalTrim: false,
    turnCoordination: false,
    autoHoverHold: false,
    maxBank: null,
    maxPitch: null,
    torqueLimiter: false,
    protection: 'off',
    landingAid: false,
  },
};

export function assistsFor(preset: AssistPreset): Assists {
  return { ...PRESETS[preset] };
}
