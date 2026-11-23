/**
 * Helicopter input for Free Flight (Proposal 0004, Fly-by-Mouse; track H1):
 * the mouse, under pointer lock, and the keys into a `HeloCommand` for the
 * control layer (sim/flight/rotor/heloLaws.ts). Every key is in one remappable
 * table, `HELO_BINDINGS`; the help overlay lists it.
 *
 * - **Mouse.** Forward and back move the pitch attitude (forward: nose down);
 *   left and right turn: the nose in the hover, a coordinated bank in cruise.
 *   Tab or a click on the view captures the mouse and Tab frees it, as in the
 *   jet (one `MouseCapture`, decision 193); Escape gives it back and pauses.
 * - **Keys.** W/S collective (climb and descend; let go to hold the altitude),
 *   A/D sideways in the hover and bank at speed, Q/E the pedals, H hover hold.
 * - **Free look.** Hold the right mouse button (or C) and move the mouse; the
 *   view stays where it is left. V or a middle click recenters it, and the
 *   mouse wheel moves the camera closer or farther (decision 160).
 * - **Gamepad** (Proposal 0014, decision 366), through the input layer: the right
 *   stick is the cyclic (fore and aft an attitude command that springs back with
 *   the stick, left and right as A/D), the left stick the collective's climb rate
 *   (centered holds the altitude) and the pedals (centered holds the heading).
 */
import { neutralCommand } from '../../sim/flight/rotor/heloLaws';
import type { HeloCommand } from '../../sim/flight/rotor/heloLaws';
import type { MouseCapture } from './mouseCapture';
import { inputLayer } from '../input/layer';
import type { InputLayer } from '../input/layer';
import { profiles } from '../input/profiles';
import { menuActive } from '../input/menuNav';
import { DEG } from '../../core/units';

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
  | 'mouseCapture'
  | 'invertMouse'
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
  mouseCapture: ['Tab'],
  invertMouse: ['KeyI'],
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
  mouseCapture: 'Capture the mouse to fly with it, or free it (or click the view to capture)',
  invertMouse: "Invert the mouse's up and down (also in the pause menu)",
  help: 'This help',
  debug: 'Flight-model debug panel',
  pause: 'Pause menu',
};

const PRESS_ACTIONS = new Set<HeloAction>([
  'hoverHold',
  'parkingBrake',
  'recenterView',
  'mouseCapture',
  'invertMouse',
  'help',
  'debug',
  'pause',
]);

/** Mouse sensitivity (rad of command per pixel). */
export const MOUSE_RATE = 0.0018;
/** A gamepad's cyclic at full deflection fore or aft: this pitch attitude from trim (decision 366). */
export const PAD_CYCLIC_PITCH = 18 * DEG;
/** A gamepad's free look at full deflection, in mouse pixels per second. */
const PAD_LOOK_RATE = 1500;

export class HeloInput {
  readonly command: HeloCommand = neutralCommand();
  /** Free look held, and the mouse movement since the last frame (px). */
  lookHeld = false;
  readonly lookDelta = { x: 0, y: 0 };
  /** Mouse wheel notches since the last frame (positive: farther). */
  zoomSteps = 0;
  onAction: ((a: HeloAction) => void) | null = null;
  private on = false;

  /** Whether the keys, mouse and gamepad fly; enabling makes the layer resolve the rotary profile. */
  get enabled(): boolean {
    return this.on;
  }

  set enabled(v: boolean) {
    this.on = v;
    if (v && this.layer) this.layer.aircraftClass = 'rotary';
  }
  /** Mouse forward pitches the nose up instead of down. */
  invertPitch = false;
  sensitivity = MOUSE_RATE;
  private readonly el: HTMLElement;
  private readonly held = new Set<string>();
  private readonly keyAction = new Map<string, HeloAction>();
  private rightDown = false;
  private readonly mouse = { x: 0, y: 0 };
  private hoverToggle = false;
  /** The pitch attitude the gamepad's cyclic commanded last frame (rad), so it springs back. */
  private padPitch = 0;
  private readonly detach: () => void;

  constructor(
    el: HTMLElement,
    private readonly capture: MouseCapture | null = null,
    private readonly layer: InputLayer | null = inputLayer(),
  ) {
    this.el = el;
    const store = this.layer?.store ?? profiles();
    store.registerKeys('rotary', HELO_BINDINGS);
    const rebuild = () => {
      this.keyAction.clear();
      for (const [a, codes] of Object.entries(HELO_BINDINGS) as [HeloAction, string[]][])
        for (const c of codes) this.keyAction.set(c, a);
    };
    rebuild();
    const unStore = store.onChange(rebuild);
    const unPad =
      this.layer?.onAction((a, isDown) => {
        if (!isDown || this.layer?.aircraftClass !== 'rotary' || !(a in HELO_BINDINGS)) return;
        const ha = a as HeloAction;
        if (!this.enabled && ha !== 'pause') return;
        if (ha !== 'pause' && menuActive()) return;
        if (ha === 'hoverHold') this.hoverToggle = true;
        if (ha === 'parkingBrake') this.command.parkingBrake = !this.command.parkingBrake;
        if (PRESS_ACTIONS.has(ha)) this.onAction?.(ha);
      }) ?? (() => {});
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
      } else if (e.button === 0 && this.capture && !this.capture.captured) {
        this.capture.grab();
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
    const menu = (e: Event) => {
      if (this.enabled) e.preventDefault();
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    document.addEventListener('mousemove', move);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    el.addEventListener('contextmenu', menu);
    el.addEventListener('wheel', wheel, { passive: false });
    this.detach = () => {
      unStore();
      unPad();
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
      document.removeEventListener('mousemove', move);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('contextmenu', menu);
      el.removeEventListener('wheel', wheel);
    };
  }

  private isHeld(a: HeloAction): boolean {
    for (const c of HELO_BINDINGS[a]) if (this.held.has(c)) return true;
    return this.layer?.aircraftClass === 'rotary' && this.layer.held(a);
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

  /** Whether the mouse is captured, so its motion flies the helicopter. */
  get locked(): boolean {
    return this.capture?.captured ?? false;
  }

  /** Gives the mouse back (a menu opens). */
  release(): void {
    this.capture?.release();
  }

  /**
   * The command for the next step, from the keys held, the mouse since the last call and the
   * gamepad; `dt` (real seconds since the last call) paces the gamepad's free look.
   */
  update(dt = 1 / 60): void {
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
    this.gamepad(dt);
  }

  /**
   * The gamepad's sticks (decision 366): a deflected axis wins over its keys. Fore and aft
   * the cyclic commands a pitch attitude from trim, sent as the change since the last frame,
   * so letting go brings the nose back where it was; with the look modifier held the right
   * stick looks around instead.
   */
  private gamepad(dt: number): void {
    const L = this.layer;
    const c = this.command;
    if (!L || L.aircraftClass !== 'rotary' || !L.connected || !this.enabled) {
      this.padPitch = 0;
      return;
    }
    let pitch = 0;
    if (this.lookHeld) {
      this.lookDelta.x += L.axis('lookX') * PAD_LOOK_RATE * dt;
      this.lookDelta.y += L.axis('lookY') * PAD_LOOK_RATE * dt;
    } else {
      // Stick back (+) raises the nose (+ in the command), as the mouse drawn back does.
      pitch = L.axis('cyclicPitch') * PAD_CYCLIC_PITCH * (this.invertPitch ? -1 : 1);
      const roll = L.axis('cyclicRoll');
      if (roll !== 0) c.lateral = roll;
    }
    c.mousePitch += pitch - this.padPitch;
    this.padPitch = pitch;
    const pedals = L.axis('pedals');
    if (pedals !== 0) c.pedals = pedals;
    const coll = L.axis('collective');
    if (coll !== 0) c.collective = coll;
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
