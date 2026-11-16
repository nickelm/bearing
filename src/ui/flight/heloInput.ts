/**
 * Helicopter input for Free Flight (Proposal 0004, Fly-by-Mouse; track H1):
 * the mouse, under pointer lock, and the keys into a `HeloCommand` for the
 * control layer (sim/flight/rotor/heloLaws.ts). Every key is in one remappable
 * table, `HELO_BINDINGS`; the help overlay lists it.
 *
 * - **Mouse.** Forward and back move the pitch attitude (forward: nose down);
 *   left and right turn: the nose in the hover, a coordinated bank in cruise.
 *   A click on the view captures the mouse; Escape gives it back and pauses.
 * - **Keys.** W/S collective (climb and descend; let go to hold the altitude),
 *   A/D sideways in the hover and bank at speed, Q/E the pedals, H hover hold.
 * - **Free look.** Hold the right mouse button (or C) and move the mouse; the
 *   view stays where it is left. V or a middle click recenters it, and the
 *   mouse wheel moves the camera closer or farther (decision 160).
 */
import { neutralCommand } from '../../sim/flight/rotor/heloLaws';
import type { HeloCommand } from '../../sim/flight/rotor/heloLaws';

export type HeloAction =
  | 'collectiveUp'
  | 'collectiveDown'
  | 'left'
  | 'right'
  | 'pedalLeft'
  | 'pedalRight'
  | 'hoverHold'
  | 'brakes'
  | 'parkingBrake'
  | 'freeLook'
  | 'recenterView'
  | 'help'
  | 'debug'
  | 'pause';

/** Key codes (KeyboardEvent.code) per action. */
export const HELO_BINDINGS: Record<HeloAction, string[]> = {
  collectiveUp: ['KeyW', 'ArrowUp'],
  collectiveDown: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  pedalLeft: ['KeyQ'],
  pedalRight: ['KeyE'],
  hoverHold: ['KeyH'],
  brakes: ['Space'],
  parkingBrake: ['KeyP'],
  freeLook: ['KeyC'],
  recenterView: ['KeyV'],
  help: ['F1'],
  debug: ['F3'],
  pause: ['Escape'],
};

export const HELO_LABELS: Record<HeloAction, string> = {
  collectiveUp: 'Collective up: climb (let go to hold the altitude)',
  collectiveDown: 'Collective down: descend, land (it eases near the ground)',
  left: 'Slide left in the hover; bank left at speed',
  right: 'Slide right in the hover; bank right at speed',
  pedalLeft: 'Pedal left: turn the nose left',
  pedalRight: 'Pedal right: turn the nose right',
  hoverHold: 'Hover hold on / off',
  brakes: 'Wheel brakes (hold)',
  parkingBrake: 'Parking brake on / off',
  freeLook: 'Free look (hold; or hold the right mouse button); the view stays where you leave it',
  recenterView: 'Recenter the view (or click the middle mouse button); the wheel zooms',
  help: 'This help',
  debug: 'Flight-model debug panel',
  pause: 'Pause menu',
};

const PRESS_ACTIONS = new Set<HeloAction>([
  'hoverHold',
  'parkingBrake',
  'recenterView',
  'help',
  'debug',
  'pause',
]);

/** Mouse sensitivity (rad of command per pixel). */
export const MOUSE_RATE = 0.0018;

export class HeloInput {
  readonly command: HeloCommand = neutralCommand();
  /** Free look held, and the mouse movement since the last frame (px). */
  lookHeld = false;
  readonly lookDelta = { x: 0, y: 0 };
  /** Mouse wheel notches since the last frame (positive: farther). */
  zoomSteps = 0;
  onAction: ((a: HeloAction) => void) | null = null;
  enabled = false;
  /** Whether the mouse is captured (pointer lock), and whether it was last frame. */
  locked = false;
  /** Mouse forward pitches the nose up instead of down. */
  invertPitch = false;
  sensitivity = MOUSE_RATE;
  private readonly el: HTMLElement;
  private readonly held = new Set<string>();
  private readonly keyAction = new Map<string, HeloAction>();
  private rightDown = false;
  private readonly mouse = { x: 0, y: 0 };
  private hoverToggle = false;
  private readonly detach: () => void;

  constructor(el: HTMLElement) {
    this.el = el;
    for (const [a, codes] of Object.entries(HELO_BINDINGS) as [HeloAction, string[]][])
      for (const c of codes) this.keyAction.set(c, a);
    const onKey = (e: KeyboardEvent, down: boolean) => {
      const a = this.keyAction.get(e.code);
      if (!a) return;
      if (this.enabled) e.preventDefault();
      if (!down) {
        this.held.delete(e.code);
        return;
      }
      if (!this.enabled && a !== 'pause') return;
      if (this.held.has(e.code)) return;
      this.held.add(e.code);
      if (a === 'hoverHold') this.hoverToggle = true;
      if (a === 'parkingBrake') this.command.parkingBrake = !this.command.parkingBrake;
      if (PRESS_ACTIONS.has(a)) this.onAction?.(a);
    };
    const kd = (e: KeyboardEvent) => onKey(e, true);
    const ku = (e: KeyboardEvent) => onKey(e, false);
    const blur = () => this.held.clear();
    const move = (e: PointerEvent | MouseEvent) => {
      if (!this.enabled) return;
      if (this.lookHeld) {
        this.lookDelta.x += e.movementX;
        this.lookDelta.y += e.movementY;
      } else if (this.locked) {
        this.mouse.x += e.movementX;
        this.mouse.y += e.movementY;
      }
    };
    const down = (e: PointerEvent) => {
      if (!this.enabled) return;
      if (e.button === 2) {
        this.rightDown = true;
        el.setPointerCapture?.(e.pointerId);
      } else if (e.button === 1) {
        e.preventDefault();
        this.onAction?.('recenterView');
      } else if (e.button === 0 && !this.locked) {
        el.requestPointerLock?.();
      }
    };
    const wheel = (e: WheelEvent) => {
      if (!this.enabled) return;
      e.preventDefault();
      // One notch is about 100 px in line mode's pixels; trackpads send smaller steps.
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      this.zoomSteps += Math.max(-3, Math.min(3, px / 100));
    };
    const up = (e: PointerEvent) => {
      if (e.button === 2) this.rightDown = false;
    };
    const lockChange = () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === el;
      // Escape under pointer lock gives the mouse back without a key event: pause.
      if (was && !this.locked && this.enabled) this.onAction?.('pause');
    };
    const menu = (e: Event) => {
      if (this.enabled) e.preventDefault();
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    document.addEventListener('mousemove', move);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    document.addEventListener('pointerlockchange', lockChange);
    el.addEventListener('contextmenu', menu);
    el.addEventListener('wheel', wheel, { passive: false });
    this.detach = () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      document.removeEventListener('mousemove', move);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      document.removeEventListener('pointerlockchange', lockChange);
      el.removeEventListener('contextmenu', menu);
      el.removeEventListener('wheel', wheel);
    };
  }

  private isHeld(a: HeloAction): boolean {
    for (const c of HELO_BINDINGS[a]) if (this.held.has(c)) return true;
    return false;
  }

  /** Starts a sortie: neutral command, parking brake as given. */
  reset(parkingBrake: boolean): void {
    Object.assign(this.command, neutralCommand());
    this.command.parkingBrake = parkingBrake;
    this.held.clear();
    this.mouse.x = this.mouse.y = 0;
    this.zoomSteps = 0;
  }

  /** Adds mouse movement (px) as if the mouse moved under pointer lock (tools and tests). */
  nudge(dx: number, dy: number): void {
    this.mouse.x += dx;
    this.mouse.y += dy;
  }

  /** Gives the mouse back (a menu opens). */
  release(): void {
    if (this.locked && typeof document !== 'undefined') document.exitPointerLock?.();
  }

  /** The command for the next step, from the keys held and the mouse since the last call. */
  update(): void {
    const c = this.command;
    this.lookHeld = this.enabled && (this.rightDown || this.isHeld('freeLook'));
    if (!this.lookHeld) {
      this.lookDelta.x = 0;
      this.lookDelta.y = 0;
    }
    const axis = (neg: HeloAction, pos: HeloAction) =>
      (this.isHeld(pos) ? 1 : 0) - (this.isHeld(neg) ? 1 : 0);
    c.collective = this.enabled ? axis('collectiveDown', 'collectiveUp') : 0;
    c.lateral = this.enabled ? axis('left', 'right') : 0;
    c.pedals = this.enabled ? axis('pedalLeft', 'pedalRight') : 0;
    c.brake = this.enabled && this.isHeld('brakes') ? 1 : 0;
    const k = this.sensitivity;
    // Mouse forward (up the desk, movementY < 0) pushes the nose down, as a cyclic does. The
    // movement and the H press add up until a physics step takes them (consumed): above
    // 120 Hz some frames run no step, and overwriting lost what moved in them.
    if (this.enabled) {
      c.mousePitch += (this.invertPitch ? -1 : 1) * this.mouse.y * k;
      c.mouseTurn += this.mouse.x * k;
      c.toggleHover ||= this.hoverToggle;
    }
    this.mouse.x = this.mouse.y = 0;
    this.hoverToggle = false;
  }

  /** After the first step of a frame: the mouse and the toggle count once. */
  consumed(): void {
    this.command.mousePitch = 0;
    this.command.mouseTurn = 0;
    this.command.toggleHover = false;
  }

  get element(): HTMLElement {
    return this.el;
  }

  dispose(): void {
    this.release();
    this.detach();
  }
}
