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
 * - **Mouse capture** (decision 193). With a `MouseCapture`, the mouse flies
 *   under pointer lock: its relative motion moves a cursor that the mouse stick
 *   and mouse aim read (half the view's width or height is full travel, as the
 *   free cursor was). Tab or a click on the view captures it; Tab frees it for
 *   the displays, and the stick and the aim point hold where they were.
 */
import { AB_GATE, MIL_DETENT, neutralControls } from '../../sim/flight/controlLaws';
import type { FlightControls } from '../../sim/flight/controlLaws';
import type { MouseCapture } from './mouseCapture';

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
  | 'fire'
  | 'jettison'
  | 'mouseAim'
  | 'freeLook'
  | 'recenterView'
  | 'mouseCapture'
  | 'invertMouse'
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
  fire: ['Enter'],
  jettison: ['KeyJ'],
  mouseAim: ['KeyN'],
  freeLook: ['KeyC'],
  recenterView: ['KeyV'],
  mouseCapture: ['Tab'],
  invertMouse: ['KeyI'],
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
  fire: 'Fire the gun (hold; or hold the left mouse button while the mouse flies), with master arm on',
  jettison: 'Jettison the drop tanks (a campaign aircraft that carries them)',
  mouseAim: 'Mouse aim (fly toward the ring) or direct (the mouse is the stick)',
  freeLook: 'Free look (hold; or hold the right mouse button); the view stays where you leave it',
  recenterView:
    'Recenter the view (or click the middle mouse button); the wheel zooms while you look',
  mouseCapture: 'Capture the mouse to fly with it, or free it (or click the view to capture)',
  invertMouse: "Invert the mouse's up and down (also in the pause menu)",
  help: 'This help',
  debug: 'Flight-model debug panel',
  pause: 'Pause menu',
};

/** Which actions toggle on a press rather than act while held. */
const PRESS_ACTIONS = new Set<FlightAction>([
  'gear',
  'speedbrake',
  'parkingBrake',
  'jettison',
  'mouseAim',
  'recenterView',
  'mouseCapture',
  'invertMouse',
  'help',
  'debug',
  'pause',
]);

/**
 * The jet's control modes (decision 198): `direct`, the keys fly the stick and a captured
 * mouse's offset from the screen's center is the stick (a held stick key wins on its
 * axis); `mouse-aim`, the flight director flies toward the ring (the keys on the wheels).
 */
export type ControlMode = 'direct' | 'mouse-aim';

/** The direct stick: full deflection at this offset from the center (NDC), and the dead zone. */
export const STICK_FULL = 0.7;
export const STICK_DEADZONE = 0.04;

/** The direct stick's deflection (−1..1) for a cursor offset `v` in NDC. */
export function stickFromCursor(v: number): number {
  const a = Math.abs(v / STICK_FULL);
  if (a < STICK_DEADZONE) return 0;
  return Math.sign(v) * Math.min(1, (a - STICK_DEADZONE) / (1 - STICK_DEADZONE));
}

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
/** Mouse aim: seconds over which a released stick key hands its axis back to the director (decision 219). */
const KEY_HANDBACK = 0.3;
const WHEEL_STEP = 0.04;
/** Throttle stops (lever positions). */
const DETENTS = [0, MIL_DETENT, AB_GATE];

export class FlightInput {
  readonly controls: FlightControls = neutralControls();
  mode: ControlMode = 'direct';
  /** Mouse wheel notches while looking around (positive: farther); otherwise the wheel is the throttle. */
  zoomSteps = 0;
  /**
   * Cursor position in normalized device coordinates (−1..1, y up). Under mouse
   * capture it moves by the mouse's relative motion and holds while the mouse is free.
   */
  readonly cursor = { x: 0, y: 0 };
  /** Free look held, and the mouse movement since the last frame (px). */
  lookHeld = false;
  readonly lookDelta = { x: 0, y: 0 };
  /**
   * The mouse's up and down inverted (decision 196): mouse forward lowers the aim
   * ring and pulls the stick back, instead of raising the ring and pushing it.
   */
  invertAim = false;
  invertStick = false;
  /** Called on a press of a toggle action (gear, help, pause...). */
  onAction: ((a: FlightAction) => void) | null = null;
  enabled = false;
  /**
   * On the wheels with mouse aim engaged and the mouse captured, the ring's height above the
   * screen's center pulls the stick (decision 217): raising the ring rotates the jet, and in
   * the air the flight director flies toward it. Set by the app each frame.
   */
  aimRotates = false;
  /** On the wheels mouse aim hands the stick to the keys (set by the app each frame). */
  directOnGround = false;
  /**
   * Mouse aim in the air (decision 219): the stick keys' own axes, and how much each holds
   * its axis from the flight director (1 while a key is held, back to 0 over KEY_HANDBACK
   * after release). The app blends them over the director's stick (`overrideStick`).
   */
  readonly keyStick = { pitch: 0, roll: 0, pitchWeight: 0, rollWeight: 0 };

  private readonly held = new Set<string>();
  private readonly keyAction = new Map<string, FlightAction>();
  /** The detent the lever stopped at during the current throttle press, if any. */
  private stoppedAt: number | null = null;
  private rightDown = false;
  private leftDown = false;
  private readonly detach: () => void;

  constructor(
    el: HTMLElement,
    private readonly capture: MouseCapture | null = null,
  ) {
    this.rebuild();
    const onKey = (e: KeyboardEvent, down: boolean) => {
      const a = this.keyAction.get(e.code);
      if (!a) return;
      // The browser's own shortcuts (Ctrl+W closes the tab) cannot all be blocked;
      // the page asks before unloading while flying.
      if (this.enabled) e.preventDefault();
      if (!down) {
        // A release counts even while a menu has the controls: the key that opened the pause
        // menu is let go while it shows, and would otherwise stay held and swallow its next press.
        this.held.delete(e.code);
        return;
      }
      // While a menu or a card has the controls, only the pause key acts: it closes the menu
      // it opened.
      if (!this.enabled && a !== 'pause') return;
      if (this.held.has(e.code)) return;
      this.held.add(e.code);
      if (PRESS_ACTIONS.has(a)) this.onAction?.(a);
    };
    const kd = (e: KeyboardEvent) => onKey(e, true);
    const ku = (e: KeyboardEvent) => onKey(e, false);
    const blur = () => {
      this.held.clear();
      this.leftDown = false;
    };
    // On the document, as the helicopter's input listens (decision 195): under pointer lock
    // the motion arrives as `mousemove` with `movementX/Y` in every browser.
    const moveTarget: EventTarget = typeof document === 'undefined' ? el : document;
    const move = (e: MouseEvent) => {
      if (this.lookHeld) {
        this.lookDelta.x += e.movementX;
        this.lookDelta.y += e.movementY;
        if (this.capture) return;
      }
      const r = el.getBoundingClientRect();
      if (!this.capture) {
        this.cursor.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        this.cursor.y = 1 - ((e.clientY - r.top) / r.height) * 2;
      } else if (this.capture.captured && this.enabled) {
        this.moveCursor(e.movementX, e.movementY, r.width, r.height);
      }
    };
    const down = (e: PointerEvent) => {
      if (!this.enabled) return;
      if (e.button === 2) {
        this.rightDown = true;
        // Pointer capture keeps a drag outside the window; under pointer lock it is not
        // allowed (and not needed).
        if (!this.capture?.captured)
          try {
            el.setPointerCapture?.(e.pointerId);
          } catch {
            /* a lock arrived meanwhile */
          }
      } else if (e.button === 1) {
        e.preventDefault();
        this.onAction?.('recenterView');
      } else if (e.button === 0 && this.capture && !this.capture.captured) {
        this.capture.grab();
      } else if (e.button === 0) {
        // With the mouse captured, the left button is the trigger (decision 295).
        this.leftDown = true;
      }
    };
    const up = (e: PointerEvent) => {
      if (e.button === 2) this.rightDown = false;
      if (e.button === 0) this.leftDown = false;
    };
    const wheel = (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      if (this.lookHeld) {
        // While looking around the wheel zooms, as in the helicopters (decision 198).
        const px =
          e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
        this.zoomSteps += Math.max(-3, Math.min(3, px / 100));
      } else this.wheelThrottle(e.deltaY < 0 ? 1 : -1);
    };
    const menu = (e: Event) => {
      if (this.enabled) e.preventDefault();
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    moveTarget.addEventListener('mousemove', move as EventListener);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', menu);
    this.detach = () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      moveTarget.removeEventListener('mousemove', move as EventListener);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
    };
  }

  /**
   * Moves the captured cursor by a relative mouse motion (px) in a view of
   * `width` × `height` px: half the view is full travel. Tools and tests call it
   * as if the mouse moved under pointer lock.
   */
  moveCursor(dx: number, dy: number, width: number, height: number): void {
    this.cursor.x = clamp(this.cursor.x + (2 * dx) / Math.max(1, width), -1, 1);
    const inverted = this.mode === 'mouse-aim' ? this.invertAim : this.invertStick;
    const up = inverted ? dy : -dy;
    this.cursor.y = clamp(this.cursor.y + (2 * up) / Math.max(1, height), -1, 1);
  }

  /** Puts the cursor back at the center: the mouse stick at neutral, the aim straight ahead. */
  centerCursor(): void {
    this.cursor.x = 0;
    this.cursor.y = 0;
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

  /** The gun's trigger: the fire key, or the left button while the mouse flies (decision 295). */
  get trigger(): boolean {
    return this.enabled && (this.isHeld('fire') || (this.leftDown && !!this.capture?.captured));
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
    this.centerCursor();
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
    if (this.mode === 'direct' || this.directOnGround) {
      // The captured mouse is the stick in direct mode; a held key wins on its axis.
      const captured = this.capture?.captured === true;
      const mouse = this.mode === 'direct' && captured;
      const rotate = this.mode === 'mouse-aim' && this.aimRotates && captured;
      const keysPitch = this.isHeld('pitchDown') || this.isHeld('pitchUp');
      const keysRoll = this.isHeld('rollLeft') || this.isHeld('rollRight');
      c.pitch =
        mouse && !keysPitch
          ? stickFromCursor(-this.cursor.y)
          : rotate && !keysPitch
            ? stickFromCursor(this.cursor.y)
            : axis(c.pitch, 'pitchDown', 'pitchUp');
      c.roll =
        mouse && !keysRoll ? stickFromCursor(this.cursor.x) : axis(c.roll, 'rollLeft', 'rollRight');
      this.keyStick.pitchWeight = this.keyStick.rollWeight = 0;
    } else {
      // Mouse aim in the air: a held stick key takes its axis from the director, starting
      // from the director's last command (in `c`), and hands it back when released.
      const k = this.keyStick;
      const keysPitch = this.isHeld('pitchDown') || this.isHeld('pitchUp');
      const keysRoll = this.isHeld('rollLeft') || this.isHeld('rollRight');
      if (keysPitch && k.pitchWeight === 0) k.pitch = c.pitch;
      if (keysRoll && k.rollWeight === 0) k.roll = c.roll;
      k.pitch = axis(k.pitch, 'pitchDown', 'pitchUp');
      k.roll = axis(k.roll, 'rollLeft', 'rollRight');
      k.pitchWeight = keysPitch ? 1 : Math.max(0, k.pitchWeight - dt / KEY_HANDBACK);
      k.rollWeight = keysRoll ? 1 : Math.max(0, k.rollWeight - dt / KEY_HANDBACK);
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

  /**
   * Mouse aim (decision 219): blends the held stick keys over the stick the director wrote
   * into `ctl`, axis by axis.
   */
  overrideStick(ctl: FlightControls): void {
    const k = this.keyStick;
    if (k.pitchWeight > 0) ctl.pitch += (k.pitch - ctl.pitch) * k.pitchWeight;
    if (k.rollWeight > 0) ctl.roll += (k.roll - ctl.roll) * k.rollWeight;
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
