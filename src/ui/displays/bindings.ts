/**
 * The displays' hot keys (decisions 193, 199): single keys for what a pilot
 * needs without looking; the bezel buttons work by mouse. Kept apart from the
 * view so the help card can list them. The flight inputs' tables use none of
 * these keys (tests/displays.test.ts).
 */
export type DisplayHotAction =
  | 'slotLeft'
  | 'slotRight'
  | 'slotMessages'
  | 'slotThreat'
  | 'masterMode'
  | 'dogfight'
  | 'masterCaution'
  | 'radarLock'
  | 'radarBreak';

/** Key codes per hot action (KeyboardEvent.code). */
export const DISPLAY_BINDINGS: Record<DisplayHotAction, string[]> = {
  slotLeft: ['Digit1'],
  slotRight: ['Digit2'],
  slotMessages: ['Digit3'],
  slotThreat: ['Digit4'],
  masterMode: ['KeyM'],
  dogfight: ['KeyF'],
  masterCaution: ['KeyK'],
  radarLock: ['KeyL'],
  radarBreak: ['KeyU'],
};

export const DISPLAY_LABELS: Record<DisplayHotAction, string> = {
  slotLeft: 'Left display: expand / collapse',
  slotRight: 'Right display: expand / collapse',
  slotMessages: 'Messages: expand / collapse',
  slotThreat: 'Threat display: expand / collapse',
  masterMode: 'Master mode by hand (steps through, then back to automatic)',
  dogfight: 'Dogfight override on / off',
  masterCaution: 'Acknowledge the master caution',
  radarLock: 'Radar: lock the nearest contact, again for the next (decision 218)',
  radarBreak: 'Radar: break the lock',
};
