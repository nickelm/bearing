/**
 * Free Flight input (decision 134): keyboard, mouse and (basic) gamepad into
 * the flight model's `FlightControls`. Every key is in one remappable table,
 * `FLIGHT_BINDINGS`; the help overlay lists it.
 *
 * - **Stick.** W/S and A/D move the stick toward full deflection while held and
 *   let it return to center when released; Q/E are the pedals. With
 *   mouse-as-stick (M) the cursor's offset from the screen center is the stick.
 * - **Mouse aim** (N) hands the stick to the flight director, which flies toward
 *   the point under the cursor (Proposal 0002); direct control stays the default,
 *   since takeoff and landing need direct inputs.
 * - **Throttle.** Shift and Ctrl (and = / −, the wheel) move the lever. It stops
 *   at the idle and military detents and at the afterburner gate; a new press
 *   (or wheel step) passes a detent.
 * - **Free look.** Hold the right mouse button (or C) and move the mouse.
 */
import { AB_GATE, MIL_DETENT, neutralControls } from '../../sim/flight/controlLaws';
import type { FlightControls } from '../../sim/flight/controlLaws';

export type FlightAction =
  | 'pitchDown'
  | 'pitchUp'
  | 'rollLeft'
  | 'rollRight'
  | 'yawLeft'
  | 'yawRight'
  | 'throttleUp'
  | 'throttleDown'
  | 'gear'
  | 'speedbrake'
  | 'brakes'
  | 'parkingBrake'
  | 'mouseStick'
  | 'mouseAim'
  | 'freeLook'
  | 'help'
  | 'debug'
  | 'pause';

/** Key codes (KeyboardEvent.code) per action. Remap here or with `rebind`. */
export const FLIGHT_BINDINGS: Record<FlightAction, string[]> = {
  pitchDown: ['KeyW', 'ArrowUp'],
  pitchUp: ['KeyS', 'ArrowDown'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['ShiftLeft', 'ShiftRight', 'Equal', 'NumpadAdd'],
  throttleDown: ['ControlLeft', 'ControlRight', 'Minus', 'NumpadSubtract'],
  gear: ['KeyG'],
  speedbrake: ['KeyB'],
  brakes: ['Space'],
  parkingBrake: ['KeyP'],
  mouseStick: ['KeyM'],
  mouseAim: ['KeyN'],
  freeLook: ['KeyC'],
  help: ['KeyH'],
  debug: ['F3'],
  pause: ['Escape'],
};

/** What each action does, for the help overlay. */
export const ACTION_LABELS: Record<FlightAction, string> = {
  pitchDown: 'Stick forward (nose down)',
  pitchUp: 'Stick back (nose up)',
  rollLeft: 'Roll left',
  rollRight: 'Roll right',
  yawLeft: 'Rudder left (nosewheel steering on the ground)',
  yawRight: 'Rudder right',
  throttleUp: 'Throttle up (stops at military; press again for afterburner)',
  throttleDown: 'Throttle down (stops at military and idle)',
  gear: 'Landing gear up / down',
  speedbrake: 'Speedbrake out / in',
  brakes: 'Wheel brakes (hold)',
  parkingBrake: 'Parking brake on / off',
  mouseStick: 'Mouse as stick on / off',
  mouseAim: 'Mouse aim (flight director) on / off',
  freeLook: 'Free look (hold; or hold the right mouse button)',
  help: 'This help',
  debug: 'Flight-model debug panel',
  pause: 'Pause menu',
};

/** Which actions toggle on a press rather than act while held. */
const PRESS_ACTIONS = new Set<FlightAction>([
  'gear',
  'speedbrake',
  'parkingBrake',
  'mouseStick',
  'mouseAim',
  'help',
  'debug',
  'pause',
]);

export type ControlMode = 'keyboard' | 'mouse-stick' | 'mouse-aim';

/**
 * The throttle lever moved by up to `step` toward `dir`, stopping at a detent
 * it reaches (idle, military, the afterburner gate) and staying there while
 * `stoppedAt` names that detent, i.e. until the press ends. There is no lever
 * position between the military detent and the afterburner gate.
 */
export function throttleStep(
  lever: number,
  dir: 1 | -1,
  step: number,
  stoppedAt: number | null,
): { lever: number; stoppedAt: number | null } {
  for (const d of DETENTS)
    if (stoppedAt === d && Math.abs(lever - d) < 1e-9) return { lever, stoppedAt };
  let next = clamp(lever + dir * step, 0, 1);
  if (next > MIL_DETENT && next < AB_GATE) next = dir > 0 ? AB_GATE : MIL_DETENT;
  for (const d of dir > 0 ? DETENTS : [...DETENTS].reverse()) {
    const crossing = dir > 0 ? lever < d && next >= d : lever > d && next <= d;
    if (crossing) return { lever: d, stoppedAt: d };
  }
  return { lever: next, stoppedAt };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Stick rates (per second): toward a held key's side, and back to center. */
const STICK_RATE = 2.5;
const CENTER_RATE = 4;
const THROTTLE_RATE = 0.45;
const WHEEL_STEP = 0.04;
/** Throttle stops (lever positions). */
const DETENTS = [0, MIL_DETENT, AB_GATE];

export class FlightInput {
  readonly controls: FlightControls = neutralControls();
  mode: ControlMode = 'keyboard';
  /** Cursor position in normalized device coordinates (−1..1, y up). */
  readonly cursor = { x: 0, y: 0 };
  /** Free look held, and the mouse movement since the last frame (px). */
  lookHeld = false;
  readonly lookDelta = { x: 0, y: 0 };
  /** Called on a press of a toggle action (gear, help, pause...). */
  onAction: ((a: FlightAction) => void) | null = null;
  enabled = false;
  /** On the wheels mouse aim hands the stick to the keys (set by the app each frame). */
  directOnGround = false;

  private readonly held = new Set<string>();
  private readonly keyAction = new Map<string, FlightAction>();
  /** The detent the lever stopped at during the current throttle press, if any. */
  private stoppedAt: number | null = null;
  private rightDown = false;
  private readonly detach: () => void;

  constructor(el: HTMLElement) {
    this.rebuild();
    const onKey = (e: KeyboardEvent, down: boolean) => {
      if (!this.enabled) return;
      const a = this.keyAction.get(e.code);
      if (!a) return;
      // The browser's own shortcuts (Ctrl+W closes the tab) cannot all be blocked;
      // the page asks before unloading while flying.
      e.preventDefault();
      if (down) {
        if (this.held.has(e.code)) return;
        this.held.add(e.code);
        if (PRESS_ACTIONS.has(a)) this.onAction?.(a);
      } else {
        this.held.delete(e.code);
      }
    };
    const kd = (e: KeyboardEvent) => onKey(e, true);
    const ku = (e: KeyboardEvent) => onKey(e, false);
    const blur = () => this.held.clear();
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      this.cursor.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.cursor.y = 1 - ((e.clientY - r.top) / r.height) * 2;
      if (this.lookHeld) {
        this.lookDelta.x += e.movementX;
        this.lookDelta.y += e.movementY;
      }
    };
    const down = (e: PointerEvent) => {
      if (!this.enabled) return;
      if (e.button === 2) {
        this.rightDown = true;
        el.setPointerCapture?.(e.pointerId);
      }
    };
    const up = (e: PointerEvent) => {
      if (e.button === 2) this.rightDown = false;
    };
    const wheel = (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.wheelThrottle(e.deltaY < 0 ? 1 : -1);
    };
    const menu = (e: Event) => {
      if (this.enabled) e.preventDefault();
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', menu);
    this.detach = () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
    };
  }

  /** Rebinds `action` to `codes`, e.g. from a settings page. */
  rebind(action: FlightAction, codes: string[]): void {
    FLIGHT_BINDINGS[action] = codes;
    this.rebuild();
  }

  private rebuild(): void {
    this.keyAction.clear();
    for (const [a, codes] of Object.entries(FLIGHT_BINDINGS) as [FlightAction, string[]][])
      for (const c of codes) this.keyAction.set(c, a);
  }

  private isHeld(a: FlightAction): boolean {
    for (const c of FLIGHT_BINDINGS[a]) if (this.held.has(c)) return true;
    return false;
  }

  /** Moves the throttle one wheel step; each step stops at a detent it reaches. */
  wheelThrottle(dir: 1 | -1): void {
    this.stoppedAt = null;
    this.controls.throttle = this.moveThrottle(this.controls.throttle, dir, WHEEL_STEP);
    this.stoppedAt = null;
  }

  private moveThrottle(lever: number, dir: 1 | -1, step: number): number {
    const r = throttleStep(lever, dir, step, this.stoppedAt);
    this.stoppedAt = r.stoppedAt;
    return r.lever;
  }

  /** Resets the controls for a new sortie on the runway (idle, parking brake) or in the air. */
  reset(onRunway: boolean, throttle = 0): void {
    Object.assign(this.controls, neutralControls());
    this.controls.parkingBrake = onRunway;
    this.controls.gearDown = onRunway;
    this.controls.throttle = throttle;
    this.held.clear();
  }

  /** Advances the held keys, mouse and gamepad by `dt` real seconds. */
  update(dt: number): void {
    const c = this.controls;
    this.lookHeld = this.enabled && (this.rightDown || this.isHeld('freeLook'));
    if (!this.lookHeld) {
      this.lookDelta.x = 0;
      this.lookDelta.y = 0;
    }
    const axis = (current: number, neg: FlightAction, pos: FlightAction) => {
      const target = (this.isHeld(pos) ? 1 : 0) - (this.isHeld(neg) ? 1 : 0);
      const rate = target === 0 ? CENTER_RATE : STICK_RATE;
      const d = target - current;
      return current + clamp(d, -rate * dt, rate * dt);
    };
    if (this.mode === 'mouse-stick') {
      const dz = (v: number) => (Math.abs(v) < 0.04 ? 0 : (v - Math.sign(v) * 0.04) / 0.96);
      c.pitch = clamp(dz(-this.cursor.y / 0.7), -1, 1);
      c.roll = clamp(dz(this.cursor.x / 0.7), -1, 1);
    } else if (this.mode === 'keyboard' || (this.mode === 'mouse-aim' && this.directOnGround)) {
      c.pitch = axis(c.pitch, 'pitchDown', 'pitchUp');
      c.roll = axis(c.roll, 'rollLeft', 'rollRight');
    }
    c.yaw = axis(c.yaw, 'yawLeft', 'yawRight');
    // Throttle with detents: a press stops at the next detent; a new press passes it.
    const up = this.isHeld('throttleUp');
    const down = this.isHeld('throttleDown');
    if (up !== down) c.throttle = this.moveThrottle(c.throttle, up ? 1 : -1, THROTTLE_RATE * dt);
    else this.stoppedAt = null;
    const brake = this.isHeld('brakes') ? 1 : 0;
    c.brakeLeft = brake;
    c.brakeRight = brake;
    this.gamepad(dt);
  }

  /** Basic gamepad or flight stick: axes 0/1 stick, 2 or 5 pedals or twist, 3 throttle (stretch goal). */
  private gamepad(_dt: number): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads?.();
    if (!pads) return;
    const pad = [...pads].find((p) => p && p.connected);
    if (!pad || pad.axes.length < 2) return;
    const dz = (v: number | undefined) => (v === undefined || Math.abs(v) < 0.08 ? 0 : v);
    const x = dz(pad.axes[0]);
    const y = dz(pad.axes[1]);
    if (x !== 0 || y !== 0) {
      this.controls.roll = clamp(x, -1, 1);
      this.controls.pitch = clamp(y, -1, 1);
    }
    const twist = dz(pad.axes[2]);
    if (twist !== 0) this.controls.yaw = clamp(twist, -1, 1);
    // A throttle axis (3 on most sticks) runs from +1 (back) to −1 (forward).
    const t = pad.axes[3];
    if (
      t !== undefined &&
      pad.axes.length >= 4 &&
      Math.abs(t) > 0.001 &&
      pad.mapping !== 'standard'
    )
      this.controls.throttle = clamp((1 - t) / 2, 0, 1);
    // Standard gamepads: right trigger (7) brakes.
    const rt = pad.buttons[7];
    if (rt && rt.value > 0.1) {
      this.controls.brakeLeft = rt.value;
      this.controls.brakeRight = rt.value;
    }
  }

  dispose(): void {
    this.detach();
  }
}
