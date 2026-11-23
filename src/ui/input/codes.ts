/**
 * The input layer's vocabulary (Proposal 0014, decision 361): every input of every device is
 * a string code, so one binding table, `Record<Action, string[]>`, serves the keyboard, the
 * mouse and gamepads alike.
 *
 * - Keyboard: `KeyboardEvent.code` (`KeyW`, `ShiftLeft`, `Escape`).
 * - Mouse: `Mouse3`, `Mouse4` (the side buttons; left, middle and right keep their roles).
 * - Gamepad buttons: `Pad0`…`Pad17`, indices of the W3C standard mapping.
 * - Half axes as buttons: `Axis2+`, `Axis2-` (past HALF_AXIS_PRESS).
 * - Chords: `Pad4&Pad12`, hold the first and press the second.
 */

/** Standard-mapping button indices (https://w3c.github.io/gamepad/#remapping). */
export const PAD = {
  south: 0,
  east: 1,
  west: 2,
  north: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  select: 8,
  start: 9,
  l3: 10,
  r3: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
  home: 16,
  touchpad: 17,
} as const;

/** Standard-mapping axes: left stick x, y; right stick x, y (y down is positive). */
export const AXIS = { lx: 0, ly: 1, rx: 2, ry: 3 } as const;

/** A half axis counts as a pressed button past this deflection, and released below the lower. */
export const HALF_AXIS_PRESS = 0.5;
export const HALF_AXIS_RELEASE = 0.35;

/** A button counts as pressed past this value (analog triggers). */
export const BUTTON_PRESS = 0.5;

export const padCode = (i: number): string => `Pad${i}`;
export const axisCode = (i: number, dir: 1 | -1): string => `Axis${i}${dir > 0 ? '+' : '-'}`;
export const chord = (modifier: string, code: string): string => `${modifier}&${code}`;

export type CodeKind = 'key' | 'mouse' | 'pad' | 'axis';

/** Which device a single (non-chord) code belongs to. */
export function codeKind(code: string): CodeKind {
  if (/^Pad\d+$/.test(code)) return 'pad';
  if (/^Axis\d+[+-]$/.test(code)) return 'axis';
  if (/^Mouse\d+$/.test(code)) return 'mouse';
  return 'key';
}

/** A binding split into its modifier (or null) and the code that triggers it. */
export function parseBinding(b: string): { modifier: string | null; code: string } {
  const i = b.indexOf('&');
  return i < 0 ? { modifier: null, code: b } : { modifier: b.slice(0, i), code: b.slice(i + 1) };
}

/** Whether a binding is a gamepad's or a joystick's (any part of it). */
export function isDeviceBinding(b: string): boolean {
  const { modifier, code } = parseBinding(b);
  const k = codeKind(code);
  return k === 'pad' || k === 'axis' || (modifier !== null && codeKind(modifier) === 'pad');
}

/** Controller families, for button names. */
export type PadFamily = 'playstation' | 'xbox' | 'generic';

/** The family from a Gamepad's id (Chrome: "Wireless Controller (STANDARD GAMEPAD Vendor: 054c …)"). */
export function padFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  if (/054c|dualshock|dualsense|wireless controller|playstation|ps4|ps5/.test(s))
    return 'playstation';
  if (/045e|xbox|xinput/.test(s)) return 'xbox';
  return 'generic';
}

const NAMES: Record<PadFamily, string[]> = {
  playstation: [
    '✕',
    '○',
    '□',
    '△',
    'L1',
    'R1',
    'L2',
    'R2',
    'Share',
    'Options',
    'L3',
    'R3',
    'D-pad ↑',
    'D-pad ↓',
    'D-pad ←',
    'D-pad →',
    'PS',
    'Touchpad',
  ],
  xbox: [
    'A',
    'B',
    'X',
    'Y',
    'LB',
    'RB',
    'LT',
    'RT',
    'View',
    'Menu',
    'LS',
    'RS',
    'D-pad ↑',
    'D-pad ↓',
    'D-pad ←',
    'D-pad →',
    'Guide',
    'Share',
  ],
  generic: [
    'South',
    'East',
    'West',
    'North',
    'LB',
    'RB',
    'LT',
    'RT',
    'Select',
    'Start',
    'LS',
    'RS',
    'D-pad ↑',
    'D-pad ↓',
    'D-pad ←',
    'D-pad →',
    'Home',
    'Extra',
  ],
};

const AXIS_NAMES = ['left stick ↔', 'left stick ↕', 'right stick ↔', 'right stick ↕'];

/** A readable name for a key code (KeyW → W, ShiftLeft → Shift). */
export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow'))
    return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[code.slice(5)] ?? code;
  if (code.startsWith('Shift')) return 'Shift';
  if (code.startsWith('Control')) return 'Ctrl';
  if (code.startsWith('Alt')) return 'Alt';
  const named: Record<string, string> = {
    Escape: 'Esc',
    Equal: '=',
    Minus: '−',
    NumpadAdd: 'Num +',
    NumpadSubtract: 'Num −',
    BracketLeft: '[',
    BracketRight: ']',
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
  };
  return named[code] ?? code;
}

/** A readable name for any single code. */
export function codeName(code: string, family: PadFamily = 'generic'): string {
  switch (codeKind(code)) {
    case 'pad': {
      const i = Number(code.slice(3));
      return NAMES[family][i] ?? `Button ${i}`;
    }
    case 'axis': {
      const i = Number(code.slice(4, -1));
      const dir = code.endsWith('+') ? '+' : '−';
      return `${AXIS_NAMES[i] ?? `Axis ${i}`} ${dir}`;
    }
    case 'mouse': {
      const i = Number(code.slice(5));
      return (
        ['Left click', 'Middle click', 'Right click', 'Mouse back', 'Mouse forward'][i] ??
        `Mouse ${i}`
      );
    }
    default:
      return keyName(code);
  }
}

/** A readable name for a binding, chords as "L1 + D-pad ↑". */
export function bindingName(b: string, family: PadFamily = 'generic'): string {
  const { modifier, code } = parseBinding(b);
  return modifier
    ? `${codeName(modifier, family)} + ${codeName(code, family)}`
    : codeName(code, family);
}

/** A readable name for an axis index. */
export function axisName(i: number): string {
  return i < 0 ? 'none' : (AXIS_NAMES[i] ?? `Axis ${i}`);
}
